import { buildCommand } from '@stricli/core';
import { listRuns, listTasks } from '../../db.ts';
import { install } from '../../install.ts';
import { daemon, type PingResponse } from '../../ipc.ts';
import type { Overview } from '../../shared/api.ts';
import { DATA_DIR, SOCKET_PATH } from '../../paths.ts';
import { fmtDate } from '../../util.ts';
import { listRunViews, runView, taskView } from '../ops.ts';
import { guard, jsonFlag, output, parsePositive, print, printJson, type Context, type JsonFlag } from '../shared.ts';

async function ping(timeoutMs?: number): Promise<PingResponse | null> {
  try {
    return await daemon.ping(timeoutMs);
  } catch {
    return null;
  }
}

export const statusCommand = buildCommand({
  docs: { brief: 'État du démon, runs en cours, serveurs opencode, dernier échec' },
  parameters: { flags: { ...jsonFlag } },
  async func(this: Context, flags: JsonFlag) {
    await guard(this, flags, async () => {
      const pong = await ping();
      const running = listRuns({ limit: 50 }).filter((r) => r.status === 'running').map((r) => runView(r));
      const lastFail = listRuns({ failed: true, limit: 1 })[0];
      const data = {
        daemon: pong === null ? null : { pid: pong.pid, servers: pong.servers },
        running,
        last_failure: lastFail === undefined ? null : runView(lastFail),
      };
      output(this, flags, data, () => {
        print(this, pong === null ? `Démon arrêté (socket ${SOCKET_PATH} injoignable)` : `Démon actif (pid ${pong.pid})`);
        print(this, `Données: ${DATA_DIR}`);
        print(this, running.length > 0 ? `En cours: ${running.map((r) => `#${r.id} ${r.task_name}`).join(', ')}` : 'Aucun run en cours');
        for (const s of pong?.servers ?? []) print(this, `Serveur opencode: ${s.url}  ${s.dir}  (${s.clients} terminal(aux) attaché(s))`);
        if (lastFail !== undefined) print(this, `Dernier échec: #${lastFail.id} ${lastFail.task_name} ${lastFail.status} ${fmtDate(lastFail.started_at)}`);
      });
    });
  },
});

interface OverviewFlags {
  readonly limit: number;
}

export const overviewCommand = buildCommand({
  docs: { brief: 'Tout ce dont l\'extension GNOME a besoin, en JSON, en un appel' },
  parameters: {
    flags: {
      limit: { kind: 'parsed', parse: parsePositive, brief: 'Nombre de runs récents', default: '8' },
      json: { kind: 'boolean', brief: 'Sans effet (la sortie est toujours JSON)', default: true, hidden: true },
    },
  },
  async func(this: Context, flags: OverviewFlags & JsonFlag) {
    await guard(this, { json: true }, async () => {
      const pong = await ping(1000);
      printJson(this, {
        daemon: pong === null ? null : { pid: pong.pid },
        tasks: listTasks().map((t) => taskView(t)),
        runs: listRunViews({ limit: flags.limit }),
      } satisfies Overview);
    });
  },
});

export const daemonCommand = buildCommand({
  docs: { brief: 'Lance le planificateur (utilisé par le service systemd --user)' },
  parameters: {},
  async func(this: Context) {
    const { runDaemon } = await import('../../daemon.ts');
    await runDaemon();
    await new Promise<never>(() => {
      // runs until SIGTERM
    });
  },
});

export const installCommand = buildCommand({
  docs: { brief: 'Installe la CLI (~/.local/bin), l\'extension GNOME et le service systemd --user' },
  parameters: {},
  async func(this: Context) {
    await guard(this, { json: false }, async () => {
      for (const line of await install()) print(this, line);
    });
  },
});
