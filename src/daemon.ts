import fs from 'node:fs';
import net from 'node:net';
import { findTask, getRun, listTasks, reapStaleRuns, setLastFire, type Task } from './db.ts';
import type { Request } from './ipc.ts';
import { enableActions } from './notify.ts';
import { openRun } from './open.ts';
import { SOCKET_PATH } from './paths.ts';
import { Runner, type StartedRun } from './runner.ts';
import { nextRun } from './util.ts';

const TICK_MS = 15_000;
/** A schedule missed by more than this is considered a "catch-up" (e.g. after suspend / boot). */
const LATE_MS = 2 * 60_000;

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

let runner: Runner;

function launch(task: Task, trigger: 'schedule' | 'catchup' | 'manual'): StartedRun | { error: string } {
  const cur = runner.activeForTask(task.id);
  if (cur) return { error: `La tâche "${task.name}" tourne déjà (run #${cur.id})` };
  return runner.start(task, trigger);
}

/**
 * Stateless scheduler: each tick, compares the next occurrence after `last_fire_at`
 * with now. Robust to suspend/resume, reboots and edits done by the CLI (re-read every tick).
 */
function tick(): void {
  const now = Date.now();
  for (const t of listTasks()) {
    if (!t.enabled) continue;
    const ref = new Date(t.last_fire_at ?? t.created_at);
    const due = nextRun(t.cron, ref);
    if (!due || due.getTime() > now) continue;

    const late = now - due.getTime() > LATE_MS;
    setLastFire(t.id, new Date(now).toISOString()); // collapses multiple missed slots into one
    if (late && !t.catch_up) {
      log(`skip missed slot task=${t.name} (catch_up off)`);
      continue;
    }
    const r = launch(t, late ? 'catchup' : 'schedule');
    if ('error' in r) log(r.error);
  }
  runner.pool.reapIdle((srv) => runner.busyServer(srv));
}

async function handle(req: Request): Promise<unknown> {
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
      if (!t) return { ok: false, error: `Tâche introuvable: ${req.task}` };
      const r = launch(t, 'manual');
      return 'error' in r ? { ok: false, error: r.error } : { ok: true, run: r.run.id };
    }
    case 'cancel':
      return runner.cancel(req.run) ? { ok: true } : { ok: false, error: `Run #${req.run} non actif dans le démon` };
    case 'attach': {
      const run = getRun(req.run);
      if (!run) return { ok: false, error: `Run introuvable: ${req.run}` };
      return { ok: true, ...(await runner.attach(req.run, run)) };
    }
    default:
      return { ok: false, error: 'commande inconnue' };
  }
}

export async function runDaemon(): Promise<void> {
  runner = new Runner();
  await enableActions((runId) => {
    openRun(runId).catch((e) => log((e as Error).message));
  });
  const reaped = reapStaleRuns();
  if (reaped) log(`${reaped} run(s) interrompu(s) marqué(s) en erreur`);

  fs.rmSync(SOCKET_PATH, { force: true });
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', async (c) => {
      buf += c;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let res: unknown;
      try {
        res = await handle(JSON.parse(buf.slice(0, nl)));
      } catch (e) {
        res = { ok: false, error: (e as Error).message };
      }
      sock.end(JSON.stringify(res) + '\n');
    });
    sock.on('error', () => {});
  });
  server.listen(SOCKET_PATH, () => fs.chmodSync(SOCKET_PATH, 0o600));
  log(`taskgnome daemon pid=${process.pid} socket=${SOCKET_PATH}`);

  tick();
  const iv = setInterval(tick, TICK_MS);

  const shutdown = async (sig: string) => {
    const active = runner.activeRuns();
    log(`${sig}: arrêt, annulation de ${active.length} run(s)`);
    clearInterval(iv);
    server.close();
    for (const r of active) runner.cancel(r.id);
    await new Promise((r) => setTimeout(r, active.length ? 3000 : 0));
    runner.pool.stopAll();
    fs.rmSync(SOCKET_PATH, { force: true });
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
