import fs from 'node:fs';
import { buildCommand } from '@stricli/core';
import { type Task } from '../../db.ts';
import type { RunLogs } from '../../shared/api.ts';
import { openRun } from '../../open.ts';
import { runLogPaths } from '../../paths.ts';
import { openTerminal } from '../../terminal.ts';
import { transcriptText } from '../../transcript.ts';
import { fmtDate, fmtDuration } from '../../util.ts';
import { cancelRun, listRunViews, requireRun, getResumeInfo, runTask, runView, sessionOf, STATUS_ICON, transcriptOf, type RunView } from '../ops.ts';
import { guard, jsonFlag, output, parseId, parsePositive, parseString, parseTask, print, printJson, type Context, type JsonFlag } from '../shared.ts';

const runArg = {
  kind: 'tuple',
  parameters: [{ brief: 'Numéro du run', placeholder: 'run', parse: parseId }],
} as const;

// ---------------------------------------------------------------- run / cancel

interface RunFlags extends JsonFlag {
  readonly foreground: boolean;
}

export const runCommand = buildCommand({
  docs: {
    brief: 'Lance une tâche maintenant',
    fullDescription: 'Via le démon s\'il tourne (retour immédiat), sinon en avant-plan (attend la fin).',
  },
  parameters: {
    positional: { kind: 'tuple', parameters: [{ brief: 'Tâche (id ou nom)', placeholder: 'task', parse: parseTask }] },
    flags: {
      foreground: { kind: 'boolean', brief: 'Exécuter dans ce processus et attendre la fin', default: false },
      ...jsonFlag,
    },
  },
  async func(this: Context, flags: RunFlags, task: Task) {
    await guard(this, flags, async () => {
      const outcome = await runTask(task, {
        foreground: flags.foreground,
        onStart: (id) => {
          if (!flags.json) this.process.stderr.write(`Run #${id} en cours (avant-plan)…\n`);
        },
      });
      if (outcome.mode === 'daemon') {
        output(this, flags, { ok: true, run: outcome.runId }, () => {
          print(this, `Run #${outcome.runId} lancé par le démon. Suivi: taskgnome logs ${outcome.runId}`);
        });
        return;
      }
      const fin = outcome.run;
      output(this, flags, runView(fin), () => {
        print(this, `${STATUS_ICON[fin.status]} ${fin.status}`);
        if (fin.error !== null) print(this, fin.error);
        if (fin.output !== null) print(this, `\n${fin.output}`);
      });
      if (fin.status !== 'success') this.process.exitCode = 1;
    });
  },
});

export const cancelCommand = buildCommand({
  docs: { brief: 'Annule un run en cours' },
  parameters: { positional: runArg, flags: { ...jsonFlag } },
  async func(this: Context, flags: JsonFlag, id: number) {
    await guard(this, flags, async () => {
      const msg = await cancelRun(id);
      output(this, flags, { ok: true }, () => {
        print(this, msg);
      });
    });
  },
});

// ---------------------------------------------------------------- history

interface HistoryFlags extends JsonFlag {
  readonly failed: boolean;
  readonly limit: number;
}

export function runLine(r: RunView): string {
  const dur = r.duration_ms === null ? 'en cours' : fmtDuration(r.duration_ms);
  const extra = r.status === 'success' || r.error === null ? '' : `  ${(r.error.split('\n')[0] ?? '').slice(0, 80)}`;
  return `${String(r.id).padStart(4)}  ${STATUS_ICON[r.status]} ${r.status.padEnd(10)} ${r.task_name.padEnd(24)} ${fmtDate(r.started_at).padEnd(18)} ${dur.padEnd(8)} ${r.trigger}${extra}`;
}

export const historyCommand = buildCommand({
  docs: { brief: 'Historique des runs (toutes tâches ou une seule)' },
  parameters: {
    positional: { kind: 'tuple', parameters: [{ brief: 'Tâche (id ou nom)', placeholder: 'task', parse: parseTask, optional: true }] },
    flags: {
      failed: { kind: 'boolean', brief: 'Seulement les échecs', default: false },
      limit: { kind: 'parsed', parse: parsePositive, brief: 'Nombre de runs', default: '20' },
      ...jsonFlag,
    },
  },
  async func(this: Context, flags: HistoryFlags, task: Task | undefined) {
    await guard(this, flags, () => {
      const runs = listRunViews({ taskId: task?.id, failed: flags.failed, limit: flags.limit });
      output(this, flags, runs, () => {
        if (runs.length === 0) print(this, 'Aucun run.');
        for (const r of runs) print(this, runLine(r));
      });
    });
  },
});

// ---------------------------------------------------------------- logs

interface LogsFlags extends JsonFlag {
  readonly raw: boolean;
  readonly stderr: boolean;
  readonly transcript: boolean;
}

export function describeRun(id: number): string {
  const r = requireRun(id);
  const lines = [`Run #${r.id} — ${r.task_name} — ${STATUS_ICON[r.status]} ${r.status} — ${fmtDate(r.started_at)} (${r.trigger})`];
  if (r.session_id !== null) lines.push(`Session opencode: ${r.session_id}`);
  if (r.cost !== null) lines.push(`Coût: $${r.cost.toFixed(4)}  tokens: ${r.tokens ?? 0}`);
  if (r.error !== null) lines.push('', '--- erreur ---', r.error);
  lines.push('', '--- discussion ---', transcriptText(transcriptOf(r)));
  if (r.status === 'running') lines.push('', '⏳ en cours…');
  return lines.join('\n');
}

export const logsCommand = buildCommand({
  docs: { brief: 'Discussion d\'un run (même en cours)' },
  parameters: {
    positional: runArg,
    flags: {
      raw: { kind: 'boolean', brief: 'Événements bruts (JSON lines)', default: false },
      stderr: { kind: 'boolean', brief: 'Logs d\'erreur bruts', default: false },
      transcript: { kind: 'boolean', brief: 'Avec --json : inclure la discussion de toute la session', default: false },
      ...jsonFlag,
    },
  },
  async func(this: Context, flags: LogsFlags, id: number) {
    await guard(this, flags, () => {
      const r = requireRun(id);
      const paths = runLogPaths(r.id);
      if (flags.raw || flags.stderr) {
        const f = flags.stderr ? paths.stderr : paths.stdout;
        if (fs.existsSync(f)) this.process.stdout.write(fs.readFileSync(f, 'utf8'));
        return;
      }
      if (flags.json) {
        const base = { ...runView(r), output: r.output, logs: paths };
        printJson(this, flags.transcript ? ({ ...base, transcript: transcriptOf(r), session_runs: sessionOf(r) } satisfies RunLogs) : base);
        return;
      }
      print(this, describeRun(r.id));
    });
  },
});

// ---------------------------------------------------------------- resume / open

interface ResumeFlags extends JsonFlag {
  readonly print: boolean;
  readonly terminal?: string;
}

export const resumeCommand = buildCommand({
  docs: {
    brief: 'Rouvre la session opencode du run dans un terminal',
    fullDescription:
      'Le démon héberge la session sur un serveur opencode ; le terminal n\'en est qu\'un client. ' +
      'Les messages envoyés depuis le terminal deviennent des runs suivis (notifications), même si le terminal est fermé.',
  },
  parameters: {
    positional: runArg,
    flags: {
      print: { kind: 'boolean', brief: 'Afficher seulement la commande', default: false },
      terminal: { kind: 'parsed', parse: parseString, brief: 'Terminal à utiliser (ghostty, kgx, ptyxis…)', optional: true },
      ...jsonFlag,
    },
  },
  async func(this: Context, flags: ResumeFlags, id: number) {
    await guard(this, flags, async () => {
      const info = await getResumeInfo(id);
      if (flags.print) {
        output(this, flags, info, () => {
          print(this, info.command);
        });
        return;
      }
      const terminal = openTerminal(info.command, flags.terminal);
      output(this, flags, { ok: true, command: info.command, terminal }, () => {
        print(this, `Ouvert dans ${terminal}: ${info.command}`);
      });
    });
  },
});

export const openCommand = buildCommand({
  docs: { brief: 'Ouvre la fenêtre de l\'extension GNOME sur ce run' },
  parameters: { positional: runArg, flags: { ...jsonFlag } },
  async func(this: Context, flags: JsonFlag, id: number) {
    await guard(this, flags, async () => {
      const r = requireRun(id);
      await openRun(r.id);
      output(this, flags, { ok: true }, () => {
        print(this, `Fenêtre ouverte sur le run #${r.id}`);
      });
    });
  },
});
