import fs from 'node:fs';
import net from 'node:net';
import { findTask, getRun, listTasks, reapStaleRuns, setLastFire, type Task } from './db.ts';
import { Request, type Response } from './ipc.ts';
import { enableActions } from './notify.ts';
import { openRun } from './open.ts';
import { SOCKET_PATH } from './paths.ts';
import { Runner, type StartedRun } from './runner.ts';
import { assertNever, errorMessage, nextRun, sleep } from './util.ts';

const TICK_MS = 15_000;
/** A schedule missed by more than this is considered a "catch-up" (e.g. after suspend / boot). */
const LATE_MS = 2 * 60_000;

const log = (...a: unknown[]): void => {
  console.log(new Date().toISOString(), ...a);
};

class RequestError extends Error {}

function launch(runner: Runner, task: Task, trigger: 'schedule' | 'catchup' | 'manual'): StartedRun {
  const cur = runner.activeForTask(task.id);
  if (cur !== undefined) throw new RequestError(`La tâche "${task.name}" tourne déjà (run #${cur.id})`);
  return runner.start(task, trigger);
}

/**
 * Stateless scheduler: each tick, compares the next occurrence after `last_fire_at`
 * with now. Robust to suspend/resume, reboots and edits done by the CLI (re-read every tick).
 */
function tick(runner: Runner): void {
  const now = Date.now();
  for (const t of listTasks()) {
    if (!t.enabled) continue;
    const due = nextRun(t.cron, new Date(t.last_fire_at ?? t.created_at));
    if (due === null || due.getTime() > now) continue;

    const late = now - due.getTime() > LATE_MS;
    setLastFire(t.id, new Date(now).toISOString()); // collapses multiple missed slots into one
    if (late && !t.catch_up) {
      log(`skip missed slot task=${t.name} (catch_up off)`);
      continue;
    }
    try {
      launch(runner, t, late ? 'catchup' : 'schedule');
    } catch (error) {
      log(errorMessage(error));
    }
  }
  runner.pool.reapIdle((srv) => runner.busyServer(srv));
}

async function handle(runner: Runner, req: Request): Promise<Response> {
  switch (req.cmd) {
    case 'ping':
      return {
        ok: true,
        pid: process.pid,
        running: runner.activeRuns().map((r) => r.id),
        servers: runner.pool.list().map((s) => ({ dir: s.dir, url: s.url, clients: runner.pool.attachedClients(s) })),
      };
    case 'run': {
      const t = findTask(req.task);
      if (t === undefined) throw new RequestError(`Tâche introuvable: ${req.task}`);
      return { ok: true, run: launch(runner, t, 'manual').run.id };
    }
    case 'cancel':
      if (!runner.cancel(req.run)) throw new RequestError(`Run #${req.run} non actif dans le démon`);
      return { ok: true };
    case 'attach': {
      const run = getRun(req.run);
      if (run === undefined) throw new RequestError(`Run introuvable: ${req.run}`);
      return { ok: true, ...(await runner.attach(run)) };
    }
    default:
      return assertNever(req);
  }
}

async function answer(runner: Runner, line: string): Promise<object> {
  try {
    const raw: unknown = JSON.parse(line);
    return await handle(runner, Request.parse(raw));
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function runDaemon(): Promise<void> {
  const runner = new Runner();
  await enableActions((runId) => {
    openRun(runId).catch((error: unknown) => {
      log(errorMessage(error));
    });
  });
  const reaped = reapStaleRuns();
  if (reaped > 0) log(`${reaped} run(s) interrompu(s) marqué(s) en erreur`);

  fs.rmSync(SOCKET_PATH, { force: true });
  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      void answer(runner, buf.slice(0, nl)).then((res) => sock.end(`${JSON.stringify(res)}\n`));
    });
    sock.on('error', () => {
      // client went away
    });
  });
  server.listen(SOCKET_PATH, () => {
    fs.chmodSync(SOCKET_PATH, 0o600);
  });
  log(`taskgnome daemon pid=${process.pid} socket=${SOCKET_PATH}`);

  tick(runner);
  const iv = setInterval(() => {
    tick(runner);
  }, TICK_MS);

  const shutdown = async (sig: string): Promise<void> => {
    const active = runner.activeRuns();
    log(`${sig}: arrêt, annulation de ${active.length} run(s)`);
    clearInterval(iv);
    server.close();
    for (const r of active) runner.cancel(r.id);
    if (active.length > 0) await sleep(3000);
    runner.pool.stopAll();
    fs.rmSync(SOCKET_PATH, { force: true });
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
