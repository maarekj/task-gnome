// Pool of `opencode serve` processes, one per (dir, direnv, env) combination.
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Task } from './db.ts';
import { DATA_DIR } from './paths.ts';

const READY_TIMEOUT_MS = 180_000; // direnv/devenv can be slow the first time
export const IDLE_STOP_MS = Number(process.env.TASKGNOME_SERVER_IDLE_MS ?? 15 * 60_000);

export interface OcEvent {
  type: string;
  properties: any;
}

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
  onEvent(srv: OcServer, ev: OcEvent): void;
  onStderr(srv: OcServer, line: string): void;
  onExit(srv: OcServer): void;
}

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

function serverKey(t: Pick<Task, 'dir' | 'direnv' | 'env'>): string {
  return crypto.createHash('sha1').update(JSON.stringify([t.dir, !!t.direnv, t.env || '{}'])).digest('hex').slice(0, 12);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ServerPool {
  private servers = new Map<string, Promise<OcServer>>();
  private live = new Map<string, OcServer>();
  private hooks: PoolHooks;
  constructor(hooks: PoolHooks) {
    this.hooks = hooks;
  }

  /** Returns a ready server for this task configuration, starting it if needed. */
  get(task: Task): Promise<OcServer> {
    const key = serverKey(task);
    let p = this.servers.get(key);
    if (!p) {
      p = this.start(key, task);
      this.servers.set(key, p);
      p.catch(() => this.servers.delete(key));
    }
    return p;
  }

  list(): OcServer[] {
    return [...this.live.values()];
  }

  async api<T = any>(srv: OcServer, method: string, p: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    const url = `${srv.url}${p}${p.includes('?') ? '&' : '?'}directory=${encodeURIComponent(srv.dir)}`;
    const res = await fetch(url, {
      method,
      headers: {
        authorization: 'Basic ' + Buffer.from(`opencode:${srv.password}`).toString('base64'),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`opencode ${method} ${p}: HTTP ${res.status} ${text.slice(0, 300)}`);
    srv.lastActivity = Date.now();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async start(key: string, task: Task): Promise<OcServer> {
    const port = await freePort();
    const password = crypto.randomBytes(18).toString('base64url');
    const args = ['serve', '--port', String(port), '--hostname', '127.0.0.1', '--print-logs', '--log-level', 'ERROR'];
    const [cmd, argv] = task.direnv ? ['direnv', ['exec', task.dir, 'opencode', ...args]] : ['opencode', args];
    let extraEnv: Record<string, string> = {};
    try {
      extraEnv = JSON.parse(task.env || '{}');
    } catch {
      /* ignore */
    }
    const logDir = path.join(DATA_DIR, 'servers');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `${key}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    logStream.write(`\n=== ${new Date().toISOString()} ${cmd} ${argv.join(' ')} (cwd ${task.dir})\n`);

    const proc = spawn(cmd, argv, {
      cwd: task.dir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv, OPENCODE_SERVER_PASSWORD: password },
    });
    const srv: OcServer = { key, dir: task.dir, url: `http://127.0.0.1:${port}`, password, proc, lastActivity: Date.now(), logFile };

    let stderrTail = '';
    let buf = '';
    proc.stdout!.on('data', (c: Buffer) => logStream.write(c));
    proc.stderr!.on('data', (c: Buffer) => {
      logStream.write(c);
      const s = c.toString('utf8');
      stderrTail = (stderrTail + s).slice(-4000);
      buf += s;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (this.live.has(key)) this.hooks.onStderr(srv, line);
      }
    });

    let exited = false;
    let spawnError: Error | null = null;
    proc.on('error', (e) => (spawnError = e));
    proc.on('exit', (code, sig) => {
      exited = true;
      logStream.end(`=== exit code=${code} signal=${sig}\n`);
      this.servers.delete(key);
      if (this.live.delete(key)) {
        log(`serveur ${key} arrêté (code=${code} signal=${sig})`);
        this.hooks.onExit(srv);
      }
    });

    // wait until the HTTP API answers
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      if (spawnError) throw new Error(`Impossible de lancer ${cmd}: ${(spawnError as Error).message}`);
      if (exited) {
        const hint = /is blocked|direnv allow/.test(stderrTail) ? `direnv: le .envrc de ${task.dir} n'est pas autorisé. Lance \`direnv allow\` dans ce dossier.\n` : '';
        throw new Error(`${hint}Le serveur opencode s'est arrêté au démarrage:\n${stderrTail.trim().split('\n').slice(-6).join('\n')}`);
      }
      if (Date.now() > deadline) {
        this.kill(srv);
        throw new Error(`Le serveur opencode n'a pas démarré en ${READY_TIMEOUT_MS / 1000}s`);
      }
      try {
        await this.api(srv, 'GET', '/global/health', undefined, 2000);
        break;
      } catch {
        await sleep(300);
      }
    }
    this.live.set(key, srv);
    await this.subscribe(srv);
    log(`serveur ${key} prêt sur ${srv.url} (${task.dir}${task.direnv ? ', direnv' : ''})`);
    return srv;
  }

  /** Follows /event (SSE). Resolves once connected; reconnects while the server lives. */
  private subscribe(srv: OcServer): Promise<void> {
    return new Promise((resolveConnected) => {
      let connected = false;
      const loop = async () => {
        while (this.live.get(srv.key) === srv) {
          try {
            const ctl = new AbortController();
            const connectTimer = setTimeout(() => ctl.abort(), 10_000);
            const res = await fetch(`${srv.url}/event?directory=${encodeURIComponent(srv.dir)}`, {
              signal: ctl.signal,
              headers: { authorization: 'Basic ' + Buffer.from(`opencode:${srv.password}`).toString('base64'), accept: 'text/event-stream' },
            });
            if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            for (;;) {
              const { value, done } = await reader.read();
              clearTimeout(connectTimer);
              if (done) break;
              buf += dec.decode(value, { stream: true });
              let nl: number;
              while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trimEnd();
                buf = buf.slice(nl + 1);
                if (!line.startsWith('data:')) continue;
                let ev: OcEvent;
                try {
                  ev = JSON.parse(line.slice(5));
                } catch {
                  continue;
                }
                if (ev.type === 'server.connected' && !connected) {
                  connected = true;
                  resolveConnected();
                }
                if (ev.type !== 'server.heartbeat') this.hooks.onEvent(srv, ev);
              }
            }
          } catch {
            /* reconnect below */
          }
          if (!connected) {
            connected = true; // don't block forever, events will flow after reconnect
            resolveConnected();
          }
          await sleep(1000);
        }
      };
      void loop();
    });
  }

  /** Number of `opencode attach <url>` clients currently connected to this server. */
  attachedClients(srv: OcServer): number {
    let n = 0;
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
        if (cmd.includes('attach') && cmd.includes(srv.url)) n++;
      } catch {
        /* process gone */
      }
    }
    return n;
  }

  /** Stops servers that are idle, have no busy session and no attached terminal. */
  reapIdle(isBusy: (srv: OcServer) => boolean): void {
    for (const srv of this.live.values()) {
      if (isBusy(srv)) {
        srv.lastActivity = Date.now();
        continue;
      }
      if (Date.now() - srv.lastActivity < IDLE_STOP_MS) continue;
      if (this.attachedClients(srv) > 0) {
        srv.lastActivity = Date.now();
        continue;
      }
      log(`serveur ${srv.key} inactif depuis ${Math.round(IDLE_STOP_MS / 60000)} min, arrêt`);
      this.kill(srv);
    }
  }

  kill(srv: OcServer): void {
    try {
      process.kill(-srv.proc.pid!, 'SIGTERM');
    } catch {
      /* gone */
    }
    setTimeout(() => {
      try {
        process.kill(-srv.proc.pid!, 'SIGKILL');
      } catch {
        /* gone */
      }
    }, 5000).unref();
  }

  stopAll(): void {
    for (const srv of this.live.values()) this.kill(srv);
  }
}
