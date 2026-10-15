// Pool of `opencode serve` processes, one per (dir, direnv, env) combination.
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { z } from 'zod';
import type { Task } from './db.ts';
import { env } from './env.ts';
import { Health, ServerEvent } from './opencode.ts';
import { DATA_DIR } from './paths.ts';
import { errorMessage, sleep } from './util.ts';

const READY_TIMEOUT_MS = 180_000; // direnv/devenv can be slow the first time
const SSE_CONNECT_TIMEOUT_MS = 10_000;
export const IDLE_STOP_MS = Number(env('TASKGNOME_SERVER_IDLE_MS') ?? 15 * 60_000);

export interface OcServer {
  key: string;
  dir: string;
  url: string;
  password: string;
  proc: ChildProcess;
  lastActivity: number;
  logFile: string;
}

export interface PoolHooks {
  onEvent: (srv: OcServer, ev: ServerEvent) => void;
  onStderr: (srv: OcServer, line: string) => void;
  onExit: (srv: OcServer) => void;
}

const log = (...a: unknown[]): void => {
  console.log(new Date().toISOString(), ...a);
};

function serverKey(t: Pick<Task, 'dir' | 'direnv' | 'env'>): string {
  return crypto.createHash('sha1').update(JSON.stringify([t.dir, t.direnv, t.env])).digest('hex').slice(0, 12);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => {
        if (addr !== null && typeof addr === 'object') resolve(addr.port);
        else reject(new Error('port introuvable'));
      });
    });
  });
}

const authHeader = (srv: OcServer): string => `Basic ${Buffer.from(`opencode:${srv.password}`).toString('base64')}`;

export class ServerPool {
  private readonly servers = new Map<string, Promise<OcServer>>();
  private readonly live = new Map<string, OcServer>();
  private readonly hooks: PoolHooks;

  constructor(hooks: PoolHooks) {
    this.hooks = hooks;
  }

  /** Returns a ready server for this task configuration, starting it if needed. */
  get(task: Task): Promise<OcServer> {
    const key = serverKey(task);
    let p = this.servers.get(key);
    if (p === undefined) {
      p = this.start(key, task);
      this.servers.set(key, p);
      p.catch(() => {
        this.servers.delete(key);
      });
    }
    return p;
  }

  list(): OcServer[] {
    return [...this.live.values()];
  }

  /** Calls the opencode HTTP API. With a schema, the JSON response is validated and returned. */
  async api(srv: OcServer, method: string, p: string, body?: unknown): Promise<void>;
  async api<T>(srv: OcServer, method: string, p: string, body: unknown, schema: z.ZodType<T>, timeoutMs?: number): Promise<T>;
  async api<T>(srv: OcServer, method: string, p: string, body?: unknown, schema?: z.ZodType<T>, timeoutMs = 30_000): Promise<T | undefined> {
    const url = `${srv.url}${p}${p.includes('?') ? '&' : '?'}directory=${encodeURIComponent(srv.dir)}`;
    const headers: Record<string, string> = { authorization: authHeader(srv) };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`opencode ${method} ${p}: HTTP ${res.status} ${text.slice(0, 300)}`);
    srv.lastActivity = Date.now();
    if (schema === undefined) return undefined;
    const raw: unknown = JSON.parse(text);
    return schema.parse(raw);
  }

  private async start(key: string, task: Task): Promise<OcServer> {
    const port = await freePort();
    const password = crypto.randomBytes(18).toString('base64url');
    const args = ['serve', '--port', String(port), '--hostname', '127.0.0.1', '--print-logs', '--log-level', 'ERROR'];
    const [cmd, argv] = task.direnv ? ['direnv', ['exec', task.dir, 'opencode', ...args]] : ['opencode', args];
    const logDir = path.join(DATA_DIR, 'servers');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `${key}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    logStream.write(`\n=== ${new Date().toISOString()} ${cmd} ${argv.join(' ')} (cwd ${task.dir})\n`);

    const proc = spawn(cmd, argv, {
      cwd: task.dir,
      detached: true, // own process group, killed as a whole
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...task.env, OPENCODE_SERVER_PASSWORD: password },
    });
    const srv: OcServer = { key, dir: task.dir, url: `http://127.0.0.1:${port}`, password, proc, lastActivity: Date.now(), logFile };

    let stderrTail = '';
    let buf = '';
    proc.stdout.on('data', (c: Buffer) => {
      logStream.write(c);
    });
    proc.stderr.on('data', (c: Buffer) => {
      logStream.write(c);
      const s = c.toString('utf8');
      stderrTail = (stderrTail + s).slice(-4000);
      buf += s;
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (this.live.has(key)) this.hooks.onStderr(srv, line);
        nl = buf.indexOf('\n');
      }
    });

    // mutated by the process callbacks below
    const state: { exited: boolean; spawnError: Error | null } = { exited: false, spawnError: null };
    proc.on('error', (error) => {
      state.spawnError = error;
    });
    proc.on('exit', (code, sig) => {
      state.exited = true;
      logStream.end(`=== exit code=${String(code)} signal=${String(sig)}\n`);
      this.servers.delete(key);
      if (this.live.delete(key)) {
        log(`serveur ${key} arrêté (code=${String(code)} signal=${String(sig)})`);
        this.hooks.onExit(srv);
      }
    });

    // wait until the HTTP API answers
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      if (state.spawnError !== null) throw new Error(`Impossible de lancer ${cmd}: ${state.spawnError.message}`, { cause: state.spawnError });
      if (state.exited) {
        const hint = /is blocked|direnv allow/u.test(stderrTail)
          ? `direnv: le .envrc de ${task.dir} n'est pas autorisé. Lance \`direnv allow\` dans ce dossier.\n`
          : '';
        throw new Error(`${hint}Le serveur opencode s'est arrêté au démarrage:\n${stderrTail.trim().split('\n').slice(-6).join('\n')}`);
      }
      if (Date.now() > deadline) {
        this.kill(srv);
        throw new Error(`Le serveur opencode n'a pas démarré en ${READY_TIMEOUT_MS / 1000}s`);
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- sequential polling is the point
        await this.api(srv, 'GET', '/global/health', undefined, Health, 2000);
        break;
      } catch {
        // oxlint-disable-next-line no-await-in-loop -- sequential polling is the point
        await sleep(300);
      }
    }
    this.live.set(key, srv);
    await this.subscribe(srv);
    log(`serveur ${key} prêt sur ${srv.url} (${task.dir}${task.direnv ? ', direnv' : ''})`);
    return srv;
  }

  /** Follows /event (SSE). Resolves once connected; reconnects while the server lives. */
  private async subscribe(srv: OcServer): Promise<void> {
    const { promise: ready, resolve: markConnected } = Promise.withResolvers<void>();

    const readStream = async (): Promise<void> => {
      const ctl = new AbortController();
      const connectTimer = setTimeout(() => {
        ctl.abort();
      }, SSE_CONNECT_TIMEOUT_MS);
      const res = await fetch(`${srv.url}/event?directory=${encodeURIComponent(srv.dir)}`, {
        signal: ctl.signal,
        headers: { authorization: authHeader(srv), accept: 'text/event-stream' },
      });
      if (!res.ok || res.body === null) throw new Error(`HTTP ${res.status}`);
      const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- reading a stream
        const { value, done } = await reader.read();
        clearTimeout(connectTimer); // first chunk received: no timeout anymore (long-lived stream)
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let nl = buf.indexOf('\n');
        while (nl >= 0) {
          this.onSseLine(srv, buf.slice(0, nl).trimEnd(), () => {
            markConnected();
          });
          buf = buf.slice(nl + 1);
          nl = buf.indexOf('\n');
        }
      }
    };

    const loop = async (): Promise<void> => {
      while (this.live.get(srv.key) === srv) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- reconnect loop
          await readStream();
        } catch (error) {
          log(`flux d'événements ${srv.key} interrompu: ${errorMessage(error)}`);
        }
        markConnected(); // don't block forever, events will flow after reconnect
        // oxlint-disable-next-line no-await-in-loop -- reconnect loop
        await sleep(1000);
      }
    };
    void loop();
    await ready;
  }

  private onSseLine(srv: OcServer, line: string, markConnected: () => void): void {
    if (!line.startsWith('data:')) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line.slice(5));
    } catch {
      return;
    }
    if (typeof raw === 'object' && raw !== null && 'type' in raw && raw.type === 'server.connected') markConnected();
    const ev = ServerEvent.safeParse(raw);
    if (ev.success) this.hooks.onEvent(srv, ev.data);
  }

  /** Number of `opencode attach <url>` clients currently connected to this server. */
  attachedClients(srv: OcServer): number {
    let n = 0;
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/u.test(pid)) continue;
      try {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
        if (cmd.includes('attach') && cmd.includes(srv.url)) n += 1;
      } catch {
        // process gone
      }
    }
    return n;
  }

  /** Stops servers that are idle, have no busy session and no attached terminal. */
  reapIdle(isBusy: (srv: OcServer) => boolean): void {
    for (const srv of this.live.values()) {
      if (isBusy(srv) || this.attachedClients(srv) > 0) {
        srv.lastActivity = Date.now();
        continue;
      }
      if (Date.now() - srv.lastActivity < IDLE_STOP_MS) continue;
      log(`serveur ${srv.key} inactif depuis ${Math.round(IDLE_STOP_MS / 60_000)} min, arrêt`);
      this.kill(srv);
    }
  }

  kill(srv: OcServer): void {
    const { pid } = srv.proc;
    if (pid === undefined) return;
    const signal = (sig: NodeJS.Signals): void => {
      try {
        process.kill(-pid, sig);
      } catch {
        // already gone
      }
    };
    signal('SIGTERM');
    setTimeout(() => {
      signal('SIGKILL');
    }, 5000).unref();
  }

  stopAll(): void {
    for (const srv of this.live.values()) this.kill(srv);
  }
}
