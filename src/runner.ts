// Runs tasks through `opencode serve` and follows their sessions.
// A "run" = one busy period of a session: the scheduled prompt, or a message sent later from an attached terminal.
import fs from 'node:fs';
import {
  createRun, findTask, finishRun, setRunPrompt, setRunSession, taskForSession,
  type Run, type RunStatus, type RunTrigger, type Task,
} from './db.ts';
import { notify } from './notify.ts';
import { errorText, SessionCreated, type Part, type ServerEvent } from './opencode.ts';
import { runLogPaths } from './paths.ts';
import { ServerPool, type OcServer } from './server.ts';
import { assertNever, errorMessage, fmtDuration } from './util.ts';

export const TITLE_PREFIX = '[task]';
/** Sessions created by taskgnome never ask for permissions (unattended). */
const ALLOW_ALL = [{ permission: '*', pattern: '*', action: 'allow' }];
/** If the server never reports idle after an abort. */
const ABORT_GRACE_MS = 15_000;

/** Patterns indicating the provider credentials (Claude token) must be refreshed by hand. */
const AUTH_PATTERNS = [
  /\b401\b/u,
  /unauthori[sz]ed/iu,
  /authentication[_ ]?(?:error|failed)/iu,
  /ProviderAuthError/u,
  /invalid[_ ](?:x-)?api[_ -]key/iu,
  /(?:token|credentials?|oauth).{0,40}(?:expired|invalid|revoked)/iu,
  /(?:expired|invalid|revoked).{0,40}(?:token|credentials?|oauth)/iu,
  /refresh[_ ]?token/iu,
  /opencode auth login/iu,
  // opencode Claude auth plugin: "Claude Code credentials are unavailable or expired. Run `claude` to refresh them."
  /credentials are unavailable/iu,
  /run `?claude`? to refresh/iu,
  /please (?:re-?)?(?:log ?in|authenticate)/iu,
];
/** "token refresh is rate-limited" is transient: nothing to fix by hand. */
const TRANSIENT = /rate.?limit/iu;

export function looksLikeAuthError(text: string): boolean {
  return AUTH_PATTERNS.some((re) => re.test(text));
}

export function classify(errors: readonly string[], providerAuthError: boolean): RunStatus {
  if (errors.length === 0) return 'success';
  const text = errors.join('\n');
  if (!TRANSIENT.test(text) && (providerAuthError || looksLikeAuthError(text))) return 'auth_error';
  return 'error';
}

const log = (...a: unknown[]): void => {
  console.log(new Date().toISOString(), ...a);
};

interface Active {
  run: Run;
  task: Task;
  sessionId: string | null;
  srv: OcServer | null;
  /** run log (JSON lines), written synchronously: readers always see complete events */
  logFile: string;
  texts: string[];
  errors: string[];
  stderr: string[];
  auth: boolean;
  cost: number;
  tokens: number;
  startedAt: number;
  notif: Promise<number>;
  killedBy: 'timeout' | 'cancel' | null;
  timer: NodeJS.Timeout | undefined;
  resolve: (r: Run) => void;
  done: Promise<Run>;
  prompt: string[];
  sawBusy: boolean;
}

export interface StartedRun {
  run: Run;
  done: Promise<Run>;
}

export interface AttachInfo {
  url: string;
  password: string;
  dir: string;
  session: string;
}

interface SessionInfo {
  taskId: number;
  srv: OcServer;
  roles: Map<string, string>;
  pendingPrompt: string[];
}

const newSession = (taskId: number, srv: OcServer): SessionInfo => ({ taskId, srv, roles: new Map(), pendingPrompt: [] });

function modelRef(model: string): { providerID: string; modelID: string } {
  const i = model.indexOf('/');
  return { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
}

function stepTokens(p: Part): number {
  const t = p.tokens;
  if (t === undefined) return 0;
  return t.total ?? (t.input ?? 0) + (t.output ?? 0);
}

export class Runner {
  readonly pool: ServerPool;
  private readonly bySession = new Map<string, SessionInfo>();
  /** run id -> active run */
  private readonly active = new Map<number, Active>();

  constructor() {
    this.pool = new ServerPool({
      onEvent: (srv, ev) => {
        this.onEvent(srv, ev);
      },
      onStderr: (srv, line) => {
        if (!/level=ERROR/u.test(line)) return;
        for (const a of this.active.values()) if (a.srv === srv) a.stderr.push(line);
      },
      onExit: (srv) => {
        for (const a of this.active.values()) {
          if (a.srv !== srv) continue;
          a.errors.push("Le serveur opencode s'est arrêté pendant le run");
          this.finish(a);
        }
        for (const [sid, s] of this.bySession) if (s.srv === srv) this.bySession.delete(sid);
      },
    });
  }

  activeRuns(): Run[] {
    return [...this.active.values()].map((a) => a.run);
  }

  activeForTask(taskId: number): Run | undefined {
    for (const a of this.active.values()) if (a.task.id === taskId) return a.run;
    return undefined;
  }

  /** Scheduled / manual run: new session + prompt. Returns once the run row exists. */
  start(task: Task, trigger: RunTrigger): StartedRun {
    const a = this.track(task, trigger, null, task.prompt);
    this.launch(a).catch((error: unknown) => {
      a.errors.push(errorMessage(error));
      this.finish(a);
    });
    return { run: a.run, done: a.done };
  }

  private async launch(a: Active): Promise<void> {
    const { task } = a;
    const srv = await this.pool.get(task);
    a.srv = srv;
    if (a.killedBy !== null) {
      this.finish(a);
      return;
    }
    const session = await this.pool.api(srv, 'POST', '/session', { title: `${TITLE_PREFIX} ${task.name}`, permission: ALLOW_ALL }, SessionCreated);
    a.sessionId = session.id;
    setRunSession(a.run.id, session.id);
    this.bySession.set(session.id, newSession(task.id, srv));
    await this.pool.api(srv, 'POST', `/session/${session.id}/prompt_async`, {
      parts: [{ type: 'text', text: task.prompt }],
      ...(task.model === null ? {} : { model: modelRef(task.model) }),
      ...(task.agent === null ? {} : { agent: task.agent }),
    });
  }

  /** Makes sure a server hosts this run's session and that we follow it. Used by "Continuer". */
  async attach(run: Run): Promise<AttachInfo> {
    const task = findTask(run.task_id);
    if (task === undefined) throw new Error('Tâche supprimée');
    if (run.session_id === null) throw new Error(`Pas encore de session opencode pour le run #${run.id}`);
    const srv = await this.pool.get(task);
    await this.pool.api(srv, 'GET', `/session/${run.session_id}`); // the session exists for this project
    if (!this.bySession.has(run.session_id)) this.bySession.set(run.session_id, newSession(task.id, srv));
    srv.lastActivity = Date.now();
    return { url: srv.url, password: srv.password, dir: task.dir, session: run.session_id };
  }

  cancel(runId: number): boolean {
    const a = this.active.get(runId);
    if (a === undefined) return false;
    this.abort(a, 'cancel');
    return true;
  }

  busyServer(srv: OcServer): boolean {
    for (const a of this.active.values()) if (a.srv === srv) return true;
    return false;
  }

  // ------------------------------------------------------------------ internals

  private track(task: Task, trigger: RunTrigger, sessionId: string | null, prompt: string | null): Active {
    const run = createRun(task, trigger, prompt);
    if (sessionId !== null) setRunSession(run.id, sessionId);
    const { promise: done, resolve } = Promise.withResolvers<Run>();
    const what = { interactive: 'Nouveau message dans la session', catchup: 'Démarrée (rattrapage)', schedule: 'Démarrée', manual: 'Démarrée' }[trigger];
    const a: Active = {
      run, task, sessionId, srv: null,
      logFile: runLogPaths(run.id).stdout,
      texts: [], errors: [], stderr: [], auth: false, cost: 0, tokens: 0,
      startedAt: Date.now(),
      notif: notify(`▶ ${task.name}`, `${what} — ${task.dir}`, { icon: 'media-playback-start-symbolic', runId: run.id }),
      killedBy: null, timer: undefined, resolve, done, prompt: [], sawBusy: false,
    };
    if (task.timeout_sec > 0) {
      a.timer = setTimeout(() => {
        this.abort(a, 'timeout');
      }, task.timeout_sec * 1000);
    }
    this.active.set(run.id, a);
    log(`run #${run.id} start task=${task.name} trigger=${trigger}`);
    return a;
  }

  private activeForSession(sid: string): Active | undefined {
    for (const a of this.active.values()) if (a.sessionId === sid) return a;
    return undefined;
  }

  private abort(a: Active, why: 'timeout' | 'cancel'): void {
    if (a.killedBy !== null) return;
    a.killedBy = why;
    if (why === 'timeout') a.errors.push(`Timeout après ${fmtDuration(a.task.timeout_sec * 1000)}`);
    if (a.srv === null || a.sessionId === null) {
      this.finish(a); // server/session still starting
      return;
    }
    this.pool.api(a.srv, 'POST', `/session/${a.sessionId}/abort`).catch((error: unknown) => {
      log(`abort run #${a.run.id}: ${errorMessage(error)}`);
    });
    setTimeout(() => {
      this.finish(a);
    }, ABORT_GRACE_MS).unref();
  }

  private write(a: Active, ev: object): void {
    fs.appendFileSync(a.logFile, `${JSON.stringify(ev)}\n`);
  }

  private sessionOf(ev: ServerEvent): string | undefined {
    switch (ev.type) {
      case 'message.updated':
        return ev.properties.info.sessionID;
      case 'message.part.updated':
        return ev.properties.part.sessionID;
      case 'session.status':
      case 'session.idle':
      case 'session.error':
      case 'permission.asked':
      case 'permission.v2.asked':
        return ev.properties.sessionID;
      default:
        return assertNever(ev);
    }
  }

  /** Session we follow, or a taskgnome session we lost track of (e.g. daemon restarted). */
  private resolveSession(srv: OcServer, sid: string, ev: ServerEvent): SessionInfo | undefined {
    const known = this.bySession.get(sid);
    if (known !== undefined) return known;
    if (ev.type !== 'session.status' || ev.properties.status.type !== 'busy') return undefined;
    const task = taskForSession(sid);
    if (task === undefined) return undefined; // not a taskgnome session (or a sub-agent session)
    const info = newSession(task.id, srv);
    this.bySession.set(sid, info);
    return info;
  }

  private onEvent(srv: OcServer, ev: ServerEvent): void {
    const sid = this.sessionOf(ev);
    if (sid === undefined) return;
    const info = this.resolveSession(srv, sid, ev);
    if (info === undefined) return;
    srv.lastActivity = Date.now();
    const a = this.activeForSession(sid);

    switch (ev.type) {
      case 'session.status':
        if (ev.properties.status.type === 'busy') this.onBusy(srv, sid, info, a);
        else if (ev.properties.status.type === 'idle' && a?.sawBusy === true) this.finish(a);
        break;
      case 'session.idle':
        if (a?.sawBusy === true) this.finish(a);
        break;
      case 'message.updated':
        info.roles.set(ev.properties.info.id, ev.properties.info.role);
        break;
      case 'message.part.updated':
        this.onPart(sid, info, a, ev.properties.part);
        break;
      case 'session.error': {
        const e = ev.properties.error ?? {};
        if (e.name === 'MessageAbortedError' || a === undefined) break;
        if (e.name === 'ProviderAuthError') a.auth = true;
        a.errors.push(errorText(e));
        this.write(a, { type: 'error', sessionID: sid, error: e });
        break;
      }
      case 'permission.asked':
      case 'permission.v2.asked':
        // safety net: sessions are created with allow-all, but old ones may still ask
        this.pool.api(srv, 'POST', `/permission/${ev.properties.id}/reply`, { reply: 'once' }).catch((error: unknown) => {
          log(`permission ${ev.properties.id}: ${errorMessage(error)}`);
        });
        break;
    }
  }

  private onBusy(srv: OcServer, sid: string, info: SessionInfo, current: Active | undefined): void {
    let a = current;
    if (a === undefined) {
      const task = findTask(info.taskId);
      if (task === undefined) return;
      const prompt = info.pendingPrompt.join('\n\n');
      a = this.track(task, 'interactive', sid, prompt === '' ? null : prompt);
      a.srv = srv;
      info.pendingPrompt = [];
    }
    a.sawBusy = true;
  }

  private onPart(sid: string, info: SessionInfo, a: Active | undefined, part: Part): void {
    const role = part.messageID === undefined ? undefined : info.roles.get(part.messageID);
    const text = part.text ?? '';
    if (part.type === 'text' && part.synthetic !== true && role === 'user') {
      if (text === '') return;
      if (a === undefined) {
        if (!info.pendingPrompt.includes(text)) info.pendingPrompt.push(text);
      } else if (!a.prompt.includes(text)) {
        a.prompt.push(text);
        if (a.run.trigger === 'interactive') setRunPrompt(a.run.id, a.prompt.join('\n\n'));
      }
      return;
    }
    if (a === undefined) return;
    const ended = part.time?.end !== undefined;
    if (part.type === 'text' && role === 'assistant' && ended && part.synthetic !== true) {
      a.texts.push(text);
      this.write(a, { type: 'text', sessionID: sid, part });
    } else if (part.type === 'reasoning' && ended) {
      this.write(a, { type: 'reasoning', sessionID: sid, part });
    } else if (part.type === 'tool') {
      this.write(a, { type: 'tool_use', sessionID: sid, part });
    } else if (part.type === 'step-finish') {
      a.cost += part.cost ?? 0;
      a.tokens += stepTokens(part);
      this.write(a, { type: 'step_finish', sessionID: sid, part });
    }
  }

  private finish(a: Active): void {
    if (!this.active.delete(a.run.id)) return;
    clearTimeout(a.timer);

    // opencode often reports a generic error: the real cause is in the server logs
    const real = new Set(a.stderr.flatMap((l) => [...l.matchAll(/\berror="((?:[^"\\]|\\.)*)"/gu)].map((m) => m[1] ?? '')));
    for (const r of real) if (r !== '' && !a.errors.some((e) => e.includes(r))) a.errors.push(r);
    if (real.size > 0) a.errors = a.errors.filter((e) => !e.includes('Unexpected server error'));

    let status: RunStatus = classify(a.errors, a.auth);
    if (a.killedBy === 'timeout') status = 'timeout';
    else if (a.killedBy === 'cancel') status = 'cancelled';

    const final = finishRun(a.run.id, {
      status,
      exit_code: null,
      session_id: a.sessionId,
      error: a.errors.length > 0 ? a.errors.join('\n') : null,
      output: a.texts.length > 0 ? a.texts.join('\n\n') : null,
      cost: a.cost > 0 ? a.cost : null,
      tokens: a.tokens > 0 ? a.tokens : null,
    });
    log(`run #${final.id} end status=${final.status}`);
    a.notif
      .then((id) => notifyEnd(a.task, final, Date.now() - a.startedAt, id))
      .catch((error: unknown) => {
        log(`notification: ${errorMessage(error)}`);
      })
      .finally(() => {
        a.resolve(final);
      });
  }
}

function notifyEnd(task: Task, run: Run, ms: number, replaces: number): Promise<number> {
  const d = fmtDuration(ms);
  const hint = `\n→ taskgnome logs ${run.id}`;
  const base = { replaces, runId: run.id };
  switch (run.status) {
    case 'success':
      return notify(`✓ ${task.name} (${d})`, (run.output ?? '').slice(0, 300) + hint, { ...base, icon: 'emblem-ok-symbolic' });
    case 'auth_error':
      return notify(
        `🔑 ${task.name} : token expiré`,
        `Le token Claude doit être rafraîchi : lance \`claude\` dans un terminal (ou \`opencode auth login\`), puis relance : taskgnome run ${task.id}${hint}`,
        { ...base, urgency: 2, icon: 'dialog-password-symbolic' },
      );
    case 'cancelled':
      return notify(`⏹ ${task.name} annulée`, `Après ${d}${hint}`, { ...base, icon: 'process-stop-symbolic' });
    case 'error':
    case 'timeout':
    case 'running':
      return notify(`✗ ${task.name} (${run.status})`, (run.error ?? '').slice(0, 300) + hint, { ...base, urgency: 2, icon: 'dialog-error-symbolic' });
    default:
      return assertNever(run.status);
  }
}
