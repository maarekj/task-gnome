import { buildCommand } from '@stricli/core';
import { createTask, deleteTask, listTasks, updateTask, type Task } from '../../db.ts';
import { fmtDate, fmtDuration, nextRun } from '../../util.ts';
import { applyEnv, DEFAULT_TIMEOUT_SEC, newTaskInput, STATUS_ICON, taskView, UsageError, validateName, type TaskView } from '../ops.ts';
import {
  guard, jsonFlag, orNull, output, parseCron, parseDir, parseEnv, parseSeconds, parseString, parseTask, parseTrimmed,
  print, readPrompt, type Context, type JsonFlag,
} from '../shared.ts';

const taskArg = {
  kind: 'tuple',
  parameters: [{ brief: 'Tâche (id ou nom)', placeholder: 'task', parse: parseTask }],
} as const;

const CRON_HELP = 'Cron : 5 champs (min h jdm mois jds), 6 avec secondes, ou @hourly / @daily / @weekly.';

// ---------------------------------------------------------------- add

interface AddFlags extends JsonFlag {
  readonly name: string;
  readonly cron: string;
  readonly dir: string;
  readonly prompt?: string;
  readonly promptFile?: string;
  readonly model?: string;
  readonly agent?: string;
  readonly timeout: number;
  readonly catchUp: boolean;
  readonly enabled: boolean;
  readonly direnv: boolean;
  readonly env?: readonly [string, string][];
}

const taskFlags = {
  prompt: { kind: 'parsed', parse: parseString, brief: 'Prompt envoyé à opencode (`-` = lire stdin)', optional: true },
  promptFile: { kind: 'parsed', parse: parseString, brief: 'Lire le prompt depuis un fichier', placeholder: 'file', optional: true },
  model: { kind: 'parsed', parse: parseTrimmed, brief: 'Modèle provider/model (vide = défaut)', optional: true, inferEmpty: true },
  agent: { kind: 'parsed', parse: parseTrimmed, brief: 'Agent opencode (vide = défaut)', optional: true, inferEmpty: true },
  env: { kind: 'parsed', parse: parseEnv, brief: 'Variable d\'environnement KEY=VAL (répétable, KEY= supprime)', placeholder: 'KEY=VAL', variadic: true, optional: true },
} as const;

export const addCommand = buildCommand({
  docs: { brief: 'Crée une tâche planifiée', fullDescription: `${CRON_HELP}\nLes sessions opencode créées sont titrées "[task] <nom>".` },
  parameters: {
    flags: {
      name: { kind: 'parsed', parse: parseString, brief: 'Nom de la tâche' },
      cron: { kind: 'parsed', parse: parseCron, brief: 'Planification cron' },
      dir: { kind: 'parsed', parse: parseDir, brief: 'Dossier dans lequel lancer opencode' },
      ...taskFlags,
      timeout: { kind: 'parsed', parse: parseSeconds, brief: 'Durée max (30m, 1h, 0 = aucune)', default: '30m' },
      catchUp: { kind: 'boolean', brief: 'Rattraper une exécution manquée (veille, PC éteint)', default: true },
      enabled: { kind: 'boolean', brief: 'Tâche active', default: true },
      direnv: { kind: 'boolean', brief: 'Charger le .envrc du dossier avec direnv', default: false },
      ...jsonFlag,
    },
  },
  async func(this: Context, flags: AddFlags) {
    await guard(this, flags, () => {
      const prompt = readPrompt(flags.prompt, flags.promptFile)?.trim();
      if (prompt === undefined || prompt === '') throw new UsageError('Prompt requis (--prompt, --prompt-file ou --prompt -)');
      const t = createTask(
        newTaskInput({
          name: validateName(flags.name),
          cron: flags.cron,
          dir: flags.dir,
          prompt,
          model: orNull(flags.model ?? ''),
          agent: orNull(flags.agent ?? ''),
          timeout_sec: flags.timeout,
          enabled: flags.enabled,
          catch_up: flags.catchUp,
          direnv: flags.direnv,
          env: applyEnv({}, flags.env ?? []),
        }),
      );
      output(this, flags, taskView(t), () => {
        print(this, `Tâche #${t.id} "${t.name}" créée. Prochaine exécution: ${fmtDate(nextRun(t.cron))}`);
      });
    });
  },
});

// ---------------------------------------------------------------- edit

interface EditFlags extends JsonFlag {
  readonly name?: string;
  readonly cron?: string;
  readonly dir?: string;
  readonly prompt?: string;
  readonly promptFile?: string;
  readonly model?: string;
  readonly agent?: string;
  readonly timeout?: number;
  readonly catchUp?: boolean;
  readonly enabled?: boolean;
  readonly direnv?: boolean;
  readonly env?: readonly [string, string][];
  readonly clearEnv: boolean;
}

export const editCommand = buildCommand({
  docs: { brief: 'Modifie une tâche (seules les options données changent)', fullDescription: CRON_HELP },
  parameters: {
    positional: taskArg,
    flags: {
      name: { kind: 'parsed', parse: parseString, brief: 'Nouveau nom', optional: true },
      cron: { kind: 'parsed', parse: parseCron, brief: 'Planification cron (repart de maintenant)', optional: true },
      dir: { kind: 'parsed', parse: parseDir, brief: 'Dossier', optional: true },
      ...taskFlags,
      timeout: { kind: 'parsed', parse: parseSeconds, brief: 'Durée max (30m, 1h, 0 = aucune)', optional: true },
      catchUp: { kind: 'boolean', brief: 'Rattraper une exécution manquée', optional: true },
      enabled: { kind: 'boolean', brief: 'Tâche active', optional: true },
      direnv: { kind: 'boolean', brief: 'Charger le .envrc du dossier avec direnv', optional: true },
      clearEnv: { kind: 'boolean', brief: 'Vider les variables d\'environnement (avant d\'appliquer --env)', default: false },
      ...jsonFlag,
    },
  },
  async func(this: Context, flags: EditFlags, task: Task) {
    await guard(this, flags, () => {
      const prompt = readPrompt(flags.prompt, flags.promptFile)?.trim();
      const restart = flags.cron !== undefined || flags.enabled === true;
      const envChanged = flags.clearEnv || flags.env !== undefined;
      const u = updateTask(task.id, {
        ...(flags.name === undefined ? {} : { name: validateName(flags.name, task) }),
        ...(flags.cron === undefined ? {} : { cron: flags.cron }),
        ...(flags.dir === undefined ? {} : { dir: flags.dir }),
        ...(prompt === undefined || prompt === '' ? {} : { prompt }),
        ...(flags.model === undefined ? {} : { model: orNull(flags.model) }),
        ...(flags.agent === undefined ? {} : { agent: orNull(flags.agent) }),
        ...(flags.timeout === undefined ? {} : { timeout_sec: flags.timeout }),
        ...(flags.enabled === undefined ? {} : { enabled: flags.enabled }),
        ...(flags.catchUp === undefined ? {} : { catch_up: flags.catchUp }),
        ...(flags.direnv === undefined ? {} : { direnv: flags.direnv }),
        ...(envChanged ? { env: applyEnv(flags.clearEnv ? {} : task.env, flags.env ?? []) } : {}),
        // changing the schedule restarts it from now (no surprise immediate run)
        ...(restart ? { last_fire_at: new Date().toISOString() } : {}),
      });
      output(this, flags, taskView(u), () => {
        print(this, `Tâche #${u.id} "${u.name}" mise à jour.`);
      });
    });
  },
});

// ---------------------------------------------------------------- enable / disable / rm

const toggle = (enabled: boolean): ReturnType<typeof buildCommand<JsonFlag, [Task], Context>> =>
  buildCommand({
    docs: { brief: enabled ? 'Active une tâche' : 'Désactive une tâche' },
    parameters: { positional: taskArg, flags: { ...jsonFlag } },
    async func(this: Context, flags: JsonFlag, task: Task) {
      await guard(this, flags, () => {
        const u = updateTask(task.id, { enabled, ...(enabled ? { last_fire_at: new Date().toISOString() } : {}) });
        output(this, flags, taskView(u), () => {
          print(this, `Tâche "${u.name}" ${u.enabled ? 'activée' : 'désactivée'}.`);
        });
      });
    },
  });

export const enableCommand = toggle(true);
export const disableCommand = toggle(false);

export const rmCommand = buildCommand({
  docs: { brief: 'Supprime une tâche et tout son historique' },
  parameters: { positional: taskArg, flags: { ...jsonFlag } },
  async func(this: Context, flags: JsonFlag, task: Task) {
    await guard(this, flags, () => {
      deleteTask(task.id);
      output(this, flags, { ok: true, id: task.id }, () => {
        print(this, `Tâche "${task.name}" supprimée.`);
      });
    });
  },
});

// ---------------------------------------------------------------- list / show

export function taskLine(t: TaskView): string {
  const last = t.last_run === null ? '—' : `${STATUS_ICON[t.last_run.status]} ${fmtDate(t.last_run.started_at)}`;
  const next = t.enabled ? fmtDate(t.next_run) : 'désactivée';
  return `${String(t.id).padStart(3)}  ${t.enabled ? '●' : '○'} ${t.name.padEnd(24)} ${t.cron.padEnd(16)} next: ${next.padEnd(18)} last: ${last}`;
}

export const listCommand = buildCommand({
  docs: { brief: 'Liste les tâches, leur prochaine exécution et leur dernier statut' },
  parameters: { flags: { ...jsonFlag } },
  async func(this: Context, flags: JsonFlag) {
    await guard(this, flags, () => {
      const tasks = listTasks().map((t) => taskView(t));
      output(this, flags, tasks, () => {
        if (tasks.length === 0) print(this, 'Aucune tâche. → taskgnome add --help');
        for (const t of tasks) print(this, taskLine(t));
      });
    });
  },
});

export function describeTask(t: Task): string {
  const v = taskView(t);
  const envKeys = Object.keys(t.env);
  return [
    `#${t.id} ${t.name}${t.enabled ? '' : ' (désactivée)'}`,
    `  cron:     ${t.cron}  (prochaine: ${fmtDate(v.next_run)})`,
    `  dossier:  ${t.dir}`,
    `  modèle:   ${t.model ?? '(défaut)'}   agent: ${t.agent ?? '(défaut)'}`,
    `  timeout:  ${t.timeout_sec > 0 ? fmtDuration(t.timeout_sec * 1000) : 'aucun'}   rattrapage: ${t.catch_up ? 'oui' : 'non'}`,
    `  direnv:   ${t.direnv ? 'oui' : 'non'}   env: ${envKeys.length > 0 ? envKeys.join(', ') : '(aucune)'}`,
    `  prompt:\n${t.prompt.replaceAll(/^/gmu, '    ')}`,
  ].join('\n');
}

export const showCommand = buildCommand({
  docs: { brief: 'Affiche le détail d\'une tâche' },
  parameters: { positional: taskArg, flags: { ...jsonFlag } },
  async func(this: Context, flags: JsonFlag, task: Task) {
    await guard(this, flags, () => {
      output(this, flags, taskView(task), () => {
        print(this, describeTask(task));
      });
    });
  },
});

export { DEFAULT_TIMEOUT_SEC };
