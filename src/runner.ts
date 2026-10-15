// Runs tasks through `opencode serve` and follows their sessions.
// A "run" = one busy period of a session: the scheduled prompt, or a message sent later from an attached terminal.
import fs from 'node:fs';
import {
  createRun, findTask, finishRun, setRunPrompt, setRunSession, taskForSession,
  type Run, type RunStatus, type RunTrigger, type Task,
} from './db.ts';
import { notify } from './notify.ts';
import { runLogPaths } from './paths.ts';
import { ServerPool, type OcEvent, type OcServer } from './server.ts';
import { fmtDuration } from './util.ts';

export const TITLE_PREFIX = '[task]';
/** Sessions created by taskgnome never ask for permissions (unattended). */
const ALLOW_ALL = [{ permission: '*', pattern: '*', action: 'allow' }];

/** Patterns indicating the provider credentials (Claude token) must be refreshed by hand. */
const AUTH_PATTERNS = [
  /\b401\b/,
  /unauthori[sz]ed/i,
  /authentication[_ ]?(error|failed)/i,
  /ProviderAuthError/,
  /invalid[_ ](x-)?api[_ ]key/i,
  /(token|credentials?|oauth).{0,40}(expired|invalid|revoked)/i,
  /(expired|invalid|revoked).{0,40}(token|credentials?|oauth)/i,
  /refresh[_ ]?token/i,
  /opencode auth login/i,
  // opencode Claude auth plugin: "Claude Code credentials are unavailable or expired. Run `claude` to refresh them."
  /credentials are unavailable/i,
  /run `?claude`? to refresh/i,
  /please (re-?)?(log ?in|authenticate)/i,
];

export function looksLikeAuthError(text: string): boolean {
  return AUTH_PATTERNS.some((re) => re.test(text));
}

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

interface Active {
  run: Run;
  task: Task;
  sessionId: string | null;
  srv: OcServer | null;
  out: fs.WriteStream;
  texts: string[];
  errors: string[];
  stderr: string[];
  auth: boolean;
  cost: number;
  tokens: number;
  startedAt: number;
  notif: Promise<number>;
  killedBy: 'timeout' | 'cancel' | null;
  timer?: NodeJS.Timeout;
  resolve: (r: Run) => void;
  done: Promise<Run>;
  prompt: string[];
  sawBusy: boolean;
}

export interface StartedRun {
  run: Run;
  done: Promise<Run>;
}

interface SessionInfo {
  taskId: number;
  srv: OcServer;
  roles: Map<string, string>;
  pendingPrompt: string[];
}

export class Runner {
  readonly pool: ServerPool;
  private bySession = new Map<string, SessionInfo>();
  private active = new Map<number, Active>(); // run id -> active

  constructor() {
    this.pool = new ServerPool({
      onEvent: (srv, ev) => this.onEvent(srv, ev),
      onStderr: (srv, line) => {
        if (!/level=ERROR/.test(line)) return;
        for (const a of this.active.values()) if (a.srv === srv) a.stderr.push(line);
      },
      onExit: (srv) => {
        for (const a of [...this.active.values()]) if (a.srv === srv) {
          a.errors.push('Le serveur opencode s\'est arrêté pendant le run');
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
    void (async () => {
      try {
        const srv = await this.pool.get(task);
        a.srv = srv;
        if (a.killedBy) return this.finish(a);
        const session = await this.pool.api<{ id: string }>(srv, 'POST', '/session', {
          title: `${TITLE_PREFIX} ${task.name}`,
          permission: ALLOW_ALL,
        });
        a.sessionId = session.id;
        setRunSession(a.run.id, session.id);
        this.bySession.set(session.id, { taskId: task.id, srv, roles: new Map(), pendingPrompt: [] });
        const body: Record<string, unknown> = { parts: [{ type: 'text', text: task.prompt }] };
        if (task.model) {
          const i = task.model.indexOf('/');
          body.model = { providerID: task.model.slice(0, i), modelID: task.model.slice(i + 1) };
        }
        if (task.agent) body.agent = task.agent;
        await this.pool.api(srv, 'POST', `/session/${session.id}/prompt_async`, body);
      } catch (e) {
        a.errors.push((e as Error).message);
        this.finish(a);
      }
    })();
    return { run: a.run, done: a.done };
  }

  /** Makes sure a server hosts this run's session and that we follow it. Used by "Continuer". */
  async attach(runId: number, run: Run): Promise<{ url: string; password: string; dir: string; session: string }> {
    const task = findTask(run.task_id);
    if (!task) throw new Error('Tâche supprimée');
    if (!run.session_id) throw new Error(`Pas encore de session opencode pour le run #${run.id}`);
    const srv = await this.pool.get(task);
    // check the session exists for this server/project
    await this.pool.api(srv, 'GET', `/session/${run.session_id}`);
    if (!this.bySession.has(run.session_id))
      this.bySession.set(run.session_id, { taskId: task.id, srv, roles: new Map(), pendingPrompt: [] });
    srv.lastActivity = Date.now();
    void runId;
    return { url: srv.url, password: srv.password, dir: task.dir, session: run.session_id };
  }

  cancel(runId: number): boolean {
    const a = this.active.get(runId);
    if (!a) return false;
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
    if (sessionId) setRunSession(run.id, sessionId);
    const logs = runLogPaths(run.id);
    let resolve!: (r: Run) => void;
    const done = new Promise<Run>((r) => (resolve = r));
    const a: Active = {
      run, task, sessionId, srv: null,
      out: fs.createWriteStream(logs.stdout),
      texts: [], errors: [], stderr: [], auth: false, cost: 0, tokens: 0,
      startedAt: Date.now(),
      notif: notify(
        `▶ ${task.name}`,
        `${trigger === 'interactive' ? 'Nouveau message dans la session' : trigger === 'catchup' ? 'Démarrée (rattrapage)' : 'Démarrée'} — ${task.dir}`,
        { icon: 'media-playback-start-symbolic', runId: run.id },
      ),
      killedBy: null, resolve, done, prompt: [], sawBusy: false,
    };
    if (task.timeout_sec > 0) a.timer = setTimeout(() => this.abort(a, 'timeout'), task.timeout_sec * 1000);
    this.active.set(run.id, a);
    log(`run #${run.id} start task=${task.name} trigger=${trigger}`);
    return a;
  }

  private activeForSession(sid: string): Active | undefined {
    for (const a of this.active.values()) if (a.sessionId === sid) return a;
    return undefined;
  }

  private abort(a: Active, why: 'timeout' | 'cancel') {
    if (a.killedBy) return;
    a.killedBy = why;
    if (why === 'timeout') a.errors.push(`Timeout après ${fmtDuration(a.task.timeout_sec * 1000)}`);
    if (!a.srv || !a.sessionId) return this.finish(a); // server/session still starting
    this.pool.api(a.srv, 'POST', `/session/${a.sessionId}/abort`).catch(() => {});
    // safety net if the server never reports idle
    setTimeout(() => this.finish(a), 15_000).unref();
  }

  private write(a: Active, ev: unknown) {
    a.out.write(JSON.stringify(ev) + '\n');
  }

  private onEvent(srv: OcServer, ev: OcEvent) {
    const p = ev.properties ?? {};
    const sid: string | undefined = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID;
    if (!sid) return;
    let info = this.bySession.get(sid);
    if (!info) {
      // a session of ours that we lost track of (e.g. daemon restarted while a terminal is attached)
      if (ev.type !== 'session.status' || p.status?.type !== 'busy') return;
      const task = taskForSession(sid);
      if (!task) return; // not a taskgnome session (or a sub-agent session)
      info = { taskId: task.id, srv, roles: new Map(), pendingPrompt: [] };
      this.bySession.set(sid, info);
    }
    srv.lastActivity = Date.now();
    let a = this.activeForSession(sid);

    switch (ev.type) {
      case 'session.status': {
        if (p.status?.type === 'busy') {
          if (!a) {
            const task = findTask(info.taskId);
            if (!task) return;
            a = this.track(task, 'interactive', sid, info.pendingPrompt.join('\n\n') || null);
            a.srv = srv;
            info.pendingPrompt = [];
          }
          a.sawBusy = true;
        } else if (p.status?.type === 'idle' && a?.sawBusy) this.finish(a);
        return;
      }
      case 'session.idle':
        if (a?.sawBusy) this.finish(a);
        return;
      case 'message.updated':
        if (p.info?.id) info.roles.set(p.info.id, p.info.role);
        return;
      case 'message.part.updated': {
        const part = p.part ?? {};
        const role = info.roles.get(part.messageID);
        if (part.type === 'text' && !part.synthetic && role === 'user') {
          if (!part.text) return;
          if (a) {
            if (!a.prompt.includes(part.text)) {
              a.prompt.push(part.text);
              if (a.run.trigger === 'interactive') setRunPrompt(a.run.id, a.prompt.join('\n\n'));
            }
          } else if (!info.pendingPrompt.includes(part.text)) info.pendingPrompt.push(part.text);
          return;
        }
        if (!a) return;
        if (part.type === 'text' && role === 'assistant' && part.time?.end && !part.synthetic) {
          a.texts.push(part.text);
          this.write(a, { type: 'text', sessionID: sid, part });
        } else if (part.type === 'reasoning' && part.time?.end) {
          this.write(a, { type: 'reasoning', sessionID: sid, part });
        } else if (part.type === 'tool') {
          this.write(a, { type: 'tool_use', sessionID: sid, part });
        } else if (part.type === 'step-finish') {
          a.cost += part.cost ?? 0;
          a.tokens += part.tokens?.total ?? (part.tokens ? (part.tokens.input ?? 0) + (part.tokens.output ?? 0) : 0);
          this.write(a, { type: 'step_finish', sessionID: sid, part });
        }
        return;
      }
      case 'session.error': {
        const e = p.error ?? {};
        if (e.name === 'MessageAbortedError') return;
        if (e.name === 'ProviderAuthError') { if (a) a.auth = true; }
        const msg = `${e.name ?? 'Error'}: ${e.data?.message ?? e.message ?? ''}`;
        if (a) {
          a.errors.push(msg);
          this.write(a, { type: 'error', sessionID: sid, error: e });
        }
        return;
      }
      case 'permission.asked':
      case 'permission.v2.asked':
        // safety net: sessions are created with allow-all, but old ones may still ask
        if (p.id) this.pool.api(srv, 'POST', `/permission/${p.id}/reply`, { reply: 'once' }).catch(() => {});
        return;
    }
  }

  private finish(a: Active) {
    if (!this.active.has(a.run.id)) return;
    this.active.delete(a.run.id);
    clearTimeout(a.timer);
    a.out.end();

    // opencode often reports a generic error: the real cause is in the server logs
    const real = a.stderr.flatMap((l) => [...l.matchAll(/\berror="((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]));
    for (const r of new Set(real)) if (!a.errors.some((e) => e.includes(r))) a.errors.push(r);
    if (real.length) {
      const generic = a.errors.findIndex((e) => /Unexpected server error/.test(e));
      if (generic >= 0) a.errors.splice(generic, 1);
    }

    let status: RunStatus;
    if (a.killedBy === 'timeout') status = 'timeout';
    else if (a.killedBy === 'cancel') status = 'cancelled';
    else if (a.errors.length === 0) status = 'success';
    else status = 'error';
    // "token refresh is rate-limited" is transient: not something to fix by hand
    const transient = /rate.?limit/i.test(a.errors.join('\n'));
    if (status === 'error' && !transient && (a.auth || looksLikeAuthError(a.errors.join('\n')))) status = 'auth_error';

    const final = finishRun(a.run.id, {
      status,
      exit_code: null,
      session_id: a.sessionId,
      error: a.errors.length ? a.errors.join('\n') : null,
      output: a.texts.join('\n\n') || null,
      cost: a.cost || null,
      tokens: a.tokens || null,
    });
    log(`run #${final.id} end status=${final.status}`);
    a.notif
      .then((id) => notifyEnd(a.task, final, Date.now() - a.startedAt, id))
      .finally(() => a.resolve(final));
  }
}

function notifyEnd(task: Task, run: Run, ms: number, replaces: number): Promise<number> {
  const d = fmtDuration(ms);
  const hint = `\n→ taskgnome logs ${run.id}`;
  switch (run.status) {
    case 'success':
      return notify(`✓ ${task.name} (${d})`, (run.output ?? '').slice(0, 300) + hint, { replaces, runId: run.id, icon: 'emblem-ok-symbolic' });
    case 'auth_error':
      return notify(
        `🔑 ${task.name} : token expiré`,
        `Le token Claude doit être rafraîchi : lance \`claude\` dans un terminal (ou \`opencode auth login\`), puis relance : taskgnome run ${task.id}` + hint,
        { replaces, runId: run.id, urgency: 2, icon: 'dialog-password-symbolic' },
      );
    case 'cancelled':
      return notify(`⏹ ${task.name} annulée`, `Après ${d}` + hint, { replaces, runId: run.id, icon: 'process-stop-symbolic' });
    default:
      return notify(`✗ ${task.name} (${run.status})`, (run.error ?? '').slice(0, 300) + hint, { replaces, runId: run.id, urgency: 2, icon: 'dialog-error-symbolic' });
  }
}
