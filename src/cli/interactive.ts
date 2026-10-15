// Interactive mode (menus), built with @clack/prompts.
import * as p from '@clack/prompts';
import { createTask, deleteTask, listTasks, updateTask, type Task, type TaskPatch } from '../db.ts';
import { daemon } from '../ipc.ts';
import { openRun } from '../open.ts';
import { openTerminal } from '../terminal.ts';
import { assertNever, errorMessage, fmtDate, fmtDuration, nextRun, parseDuration, validateCron } from '../util.ts';
import { describeRun, runLine } from './commands/runs.ts';
import { describeTask } from './commands/tasks.ts';
import {
  applyEnv, cancelRun, getResumeInfo, listRunViews, newTaskInput, parseEnvAssignment, requireRun, requireTask,
  resolveDir, runTask, STATUS_ICON, taskView, validateName, type RunView,
} from './ops.ts';

class Cancelled extends Error {}

const isAnswer = <T>(v: T): v is Exclude<T, symbol> => typeof v !== 'symbol';

/** Unwraps a clack answer; Ctrl+C / Escape (clack's cancel symbol) -> Cancelled (goes back one level). */
async function ask<T>(answer: Promise<T>): Promise<Exclude<T, symbol>> {
  const v = await answer;
  if (isAnswer(v)) return v;
  throw new Cancelled();
}

/** Runs a sub-menu / wizard: Escape inside it comes back here (one level up) instead of bubbling up. */
async function back<T>(f: () => Promise<T>): Promise<T | undefined> {
  try {
    return await f();
  } catch (error) {
    if (error instanceof Cancelled) return undefined;
    throw error;
  }
}

/** clack validator from a function that throws on invalid input. */
const check =
  (f: (v: string) => unknown) =>
  (v: string | undefined): string | undefined => {
    try {
      f(v ?? '');
      return undefined;
    } catch (error) {
      return errorMessage(error);
    }
  };

const CRON_PRESETS: readonly { value: string; label: string }[] = [
  { value: '0 9 * * 1-5', label: 'En semaine à 9h' },
  { value: '0 9 * * *', label: 'Tous les jours à 9h' },
  { value: '@hourly', label: 'Toutes les heures' },
  { value: '*/30 * * * *', label: 'Toutes les 30 minutes' },
  { value: '0 9 * * 1', label: 'Le lundi à 9h' },
];

async function askCron(initial?: string): Promise<string> {
  const options = [
    ...CRON_PRESETS.map((c) => ({ ...c, hint: c.value })),
    { value: 'custom', label: 'Autre expression cron…', hint: initial ?? 'min h jdm mois jds' },
  ];
  const choice = await ask(p.select({ message: 'Planification', options, initialValue: initial !== undefined && CRON_PRESETS.some((c) => c.value === initial) ? initial : 'custom' }));
  if (choice !== 'custom') return choice;
  return ask(p.text({ message: 'Expression cron', placeholder: '0 9 * * 1-5', ...(initial === undefined ? {} : { initialValue: initial }), validate: check(validateCron) }));
}

const askPrompt = (initial?: string): Promise<string> =>
  ask(
    p.multiline({
      message: 'Prompt envoyé à opencode (Entrée deux fois pour valider)',
      ...(initial === undefined ? {} : { initialValue: initial }),
      validate: (v) => ((v ?? '').trim() === '' ? 'Le prompt ne peut pas être vide' : undefined),
    }),
  ).then((s) => s.trim());

const askDir = (initial?: string): Promise<string> =>
  ask(p.path({ message: 'Dossier dans lequel lancer opencode', directory: true, ...(initial === undefined ? {} : { initialValue: initial }), validate: check(resolveDir) })).then((d) => resolveDir(d));

const askTimeout = (initialSec: number): Promise<number> =>
  ask(p.text({ message: 'Durée max (30m, 1h, 0 = aucune)', initialValue: initialSec === 0 ? '0' : fmtDuration(initialSec * 1000), validate: check(parseDuration) })).then((v) => parseDuration(v));

const askEnv = async (initial: Readonly<Record<string, string>>): Promise<Record<string, string>> => {
  const text = await ask(
    p.multiline({
      message: 'Variables d\'environnement, une par ligne CLE=valeur (stockées en clair)',
      initialValue: Object.entries(initial).map(([k, v]) => `${k}=${v}`).join('\n'),
      validate: check((v) => {
        for (const line of v.split('\n').map((l) => l.trim()).filter((l) => l !== '')) parseEnvAssignment(line);
      }),
    }),
  );
  return applyEnv({}, text.split('\n').map((l) => l.trim().replace(/^export\s+/u, '')).filter((l) => l !== '' && !l.startsWith('#')).map((l) => parseEnvAssignment(l)));
};

const nullable = (s: string): string | null => (s.trim() === '' ? null : s.trim());

// ---------------------------------------------------------------- tasks

async function createTaskWizard(): Promise<Task | null> {
  const name = await ask(p.text({ message: 'Nom de la tâche', validate: check((v) => validateName(v)) }));
  const dir = await askDir(process.cwd());
  const cron = await askCron();
  const prompt = await askPrompt();
  const input = newTaskInput({ name: validateName(name), dir, cron, prompt });
  if (await ask(p.confirm({ message: 'Configurer les options avancées (modèle, timeout, direnv, env…) ?', initialValue: false }))) {
    input.model = nullable(await ask(p.text({ message: 'Modèle provider/model (vide = défaut)', placeholder: 'anthropic/claude-sonnet-4-5' })));
    input.agent = nullable(await ask(p.text({ message: 'Agent (vide = défaut)' })));
    input.timeout_sec = await askTimeout(input.timeout_sec);
    input.catch_up = await ask(p.confirm({ message: 'Rattraper une exécution manquée (veille, PC éteint) ?', initialValue: true }));
    input.direnv = await ask(p.confirm({ message: 'Charger le .envrc du dossier avec direnv ?', initialValue: false }));
    input.env = await askEnv({});
  }
  p.note(`${cron}  ·  prochaine: ${fmtDate(nextRun(cron))}\n${dir}\n\n${prompt}`, name);
  if (!(await ask(p.confirm({ message: 'Créer la tâche ?' })))) return null;
  const t = createTask(input);
  p.log.success(`Tâche #${t.id} "${t.name}" créée.`);
  return t;
}

type Field = 'name' | 'cron' | 'dir' | 'prompt' | 'model' | 'agent' | 'timeout' | 'catch_up' | 'direnv' | 'env';

async function askName(current: Task): Promise<string> {
  const name = await ask(p.text({ message: 'Nom', initialValue: current.name, validate: check((v) => validateName(v, current)) }));
  return validateName(name, current);
}

async function editTask(task: Task): Promise<void> {
  let t = task;
  for (;;) {
    const field = await ask(
      p.select<Field | 'done'>({
        message: `Modifier « ${t.name} »`,
        options: [
          { value: 'name', label: 'Nom', hint: t.name },
          { value: 'cron', label: 'Planification', hint: t.cron },
          { value: 'dir', label: 'Dossier', hint: t.dir },
          { value: 'prompt', label: 'Prompt', hint: (t.prompt.split('\n')[0] ?? '').slice(0, 50) },
          { value: 'model', label: 'Modèle', hint: t.model ?? '(défaut)' },
          { value: 'agent', label: 'Agent', hint: t.agent ?? '(défaut)' },
          { value: 'timeout', label: 'Timeout', hint: t.timeout_sec > 0 ? fmtDuration(t.timeout_sec * 1000) : 'aucun' },
          { value: 'catch_up', label: 'Rattrapage', hint: t.catch_up ? 'oui' : 'non' },
          { value: 'direnv', label: 'direnv', hint: t.direnv ? 'oui' : 'non' },
          { value: 'env', label: 'Variables d\'environnement', hint: Object.keys(t.env).join(', ') || '(aucune)' },
          { value: 'done', label: 'Terminé' },
        ],
      }),
    );
    if (field === 'done') return;
    const current = t;
    const patch = await back(() => askPatch(current, field));
    if (patch === undefined) continue;
    t = updateTask(t.id, patch);
    p.log.success('Enregistré.');
  }
}

async function askPatch(t: Task, field: Field): Promise<TaskPatch> {
    let patch: TaskPatch;
    switch (field) {
      case 'name':
        patch = { name: await askName(t) };
        break;
      case 'cron':
        patch = { cron: await askCron(t.cron), last_fire_at: new Date().toISOString() };
        break;
      case 'dir':
        patch = { dir: await askDir(t.dir) };
        break;
      case 'prompt':
        patch = { prompt: await askPrompt(t.prompt) };
        break;
      case 'model':
        patch = { model: nullable(await ask(p.text({ message: 'Modèle (vide = défaut)', initialValue: t.model ?? '' }))) };
        break;
      case 'agent':
        patch = { agent: nullable(await ask(p.text({ message: 'Agent (vide = défaut)', initialValue: t.agent ?? '' }))) };
        break;
      case 'timeout':
        patch = { timeout_sec: await askTimeout(t.timeout_sec) };
        break;
      case 'catch_up':
        patch = { catch_up: await ask(p.confirm({ message: 'Rattraper les exécutions manquées ?', initialValue: t.catch_up })) };
        break;
      case 'direnv':
        patch = { direnv: await ask(p.confirm({ message: 'Charger direnv ?', initialValue: t.direnv })) };
        break;
      case 'env':
        patch = { env: await askEnv(t.env) };
        break;
      default:
        return assertNever(field);
    }
    return patch;
}

async function launch(task: Task): Promise<void> {
  const s = p.spinner();
  s.start(`Lancement de « ${task.name} »`);
  try {
    const outcome = await runTask(task, {
      onStart: (id) => {
        s.message(`Run #${id} en cours (démon injoignable, exécution ici)…`);
      },
    });
    if (outcome.mode === 'daemon') {
      s.stop(`Run #${outcome.runId} lancé par le démon.`);
      return;
    }
    s.stop(`Run #${outcome.run.id} : ${STATUS_ICON[outcome.run.status]} ${outcome.run.status}`);
    p.note(describeRun(outcome.run.id), `Run #${outcome.run.id}`);
  } catch (error) {
    s.error(errorMessage(error));
  }
}

async function taskMenu(id: number): Promise<void> {
  for (;;) {
    const task = requireTask(id);
    const v = taskView(task);
    const action = await ask(
      p.select({
        message: `${task.enabled ? '●' : '○'} ${task.name} — ${task.enabled ? `prochaine: ${fmtDate(v.next_run)}` : 'désactivée'}`,
        options: [
          { value: 'run', label: 'Lancer maintenant' },
          { value: 'history', label: 'Historique', hint: v.last_run === null ? 'jamais lancée' : `dernier: ${STATUS_ICON[v.last_run.status]} ${fmtDate(v.last_run.started_at)}` },
          { value: 'show', label: 'Détail' },
          { value: 'edit', label: 'Modifier' },
          { value: 'toggle', label: task.enabled ? 'Désactiver' : 'Activer' },
          { value: 'rm', label: 'Supprimer' },
          { value: 'back', label: '← Retour' },
        ],
      }),
    );
    switch (action) {
      case 'run':
        await launch(task);
        break;
      case 'history':
        await back(() => historyMenu(task.id));
        break;
      case 'show':
        p.note(describeTask(task), task.name);
        break;
      case 'edit':
        await back(() => editTask(task));
        break;
      case 'toggle':
        updateTask(task.id, { enabled: !task.enabled, ...(task.enabled ? {} : { last_fire_at: new Date().toISOString() }) });
        p.log.success(task.enabled ? 'Tâche désactivée.' : 'Tâche activée.');
        break;
      case 'rm':
        if ((await back(() => ask(p.confirm({ message: `Supprimer « ${task.name} » et tout son historique ?`, initialValue: false })))) === true) {
          deleteTask(task.id);
          p.log.success('Tâche supprimée.');
          return;
        }
        break;
      default:
        return;
    }
  }
}

async function pickTask(): Promise<void> {
  const tasks = listTasks().map((t) => taskView(t));
  const NEW = -1;
  const id = await ask(
    p.autocomplete<number>({
      message: 'Tâche (tape pour filtrer)',
      options: [
        { value: NEW, label: '+ Nouvelle tâche' },
        ...tasks.map((t) => ({
          value: t.id,
          label: `${t.enabled ? '●' : '○'} ${t.name}`,
          hint: `${t.cron} · ${t.last_run === null ? 'jamais lancée' : `${STATUS_ICON[t.last_run.status]} ${fmtDate(t.last_run.started_at)}`}`,
        })),
      ],
    }),
  );
  if (id === NEW) {
    const t = await back(createTaskWizard);
    if (t !== null && t !== undefined) await back(() => taskMenu(t.id));
    return;
  }
  await back(() => taskMenu(id));
}

// ---------------------------------------------------------------- runs

async function runMenu(id: number): Promise<void> {
  for (;;) {
    const r = requireRun(id);
    const running = r.status === 'running';
    const action = await ask(
      p.select({
        message: `Run #${r.id} — ${r.task_name} — ${STATUS_ICON[r.status]} ${r.status}`,
        options: [
          { value: 'logs', label: 'Voir la discussion' },
          { value: 'gnome', label: 'Ouvrir dans la fenêtre GNOME' },
          { value: 'resume', label: 'Continuer la session dans un terminal' },
          { value: 'command', label: 'Afficher la commande pour continuer' },
          running ? { value: 'cancel', label: 'Annuler le run' } : { value: 'rerun', label: 'Relancer la tâche' },
          { value: 'back', label: '← Retour' },
        ],
      }),
    );
    try {
      switch (action) {
        case 'logs':
          p.note(describeRun(r.id), `Run #${r.id}`);
          break;
        case 'gnome':
          await openRun(r.id);
          p.log.success('Fenêtre ouverte.');
          break;
        case 'resume': {
          const info = await getResumeInfo(r.id);
          p.log.success(`Ouvert dans ${openTerminal(info.command)}.`);
          break;
        }
        case 'command':
          p.note((await getResumeInfo(r.id)).command, 'Commande');
          break;
        case 'cancel':
          p.log.success(await cancelRun(r.id));
          break;
        case 'rerun':
          await launch(requireTask(r.task_id));
          break;
        default:
          return;
      }
    } catch (error) {
      if (!(error instanceof Cancelled)) p.log.error(errorMessage(error));
    }
  }
}

async function historyMenu(taskId?: number): Promise<void> {
  const failed = await ask(
    p.select({ message: 'Runs', options: [{ value: false, label: 'Tous' }, { value: true, label: 'Échecs seulement' }] }),
  );
  const runs: RunView[] = listRunViews({ taskId, failed, limit: 30 });
  if (runs.length === 0) {
    p.log.info('Aucun run.');
    return;
  }
  for (;;) {
    const id = await ask(p.select({ message: 'Run', maxItems: 12, options: runs.map((r) => ({ value: r.id, label: runLine(r).trim() })) }));
    await back(() => runMenu(id));
  }
}

// ---------------------------------------------------------------- main loop

async function statusLine(): Promise<string> {
  let state: string;
  try {
    const pong = await daemon.ping(1000);
    state = pong === null ? 'démon arrêté' : `démon actif${pong.running.length > 0 ? ` — ${pong.running.length} run(s) en cours` : ''}`;
  } catch {
    state = 'démon injoignable';
  }
  const tasks = listTasks();
  return `${state} · ${tasks.length} tâche(s), ${tasks.filter((t) => t.enabled).length} active(s)`;
}

export async function interactive(): Promise<void> {
  p.intro('taskgnome');
  for (;;) {
    try {
      p.log.info(await statusLine());
      const action = await ask(
        p.select({
          message: 'Que veux-tu faire ?',
          options: [
            { value: 'tasks', label: 'Tâches', hint: 'lancer, modifier, historique…' },
            { value: 'new', label: 'Nouvelle tâche' },
            { value: 'history', label: 'Historique des runs' },
            { value: 'quit', label: 'Quitter' },
          ],
        }),
      );
      if (action === 'quit') break;
      if (action === 'tasks') await back(pickTask);
      else if (action === 'new') {
        const t = await back(createTaskWizard);
        if (t !== null && t !== undefined) await back(() => taskMenu(t.id));
      } else await back(() => historyMenu());
    } catch (error) {
      if (!(error instanceof Cancelled)) p.log.error(errorMessage(error));
      else if (isMainCancel()) break;
    }
  }
  p.outro('À bientôt');
}

/** Ctrl+C at the top level quits, deeper it goes back to the main menu. */
let lastCancel = 0;
function isMainCancel(): boolean {
  const now = Date.now();
  const twice = now - lastCancel < 1500;
  lastCancel = now;
  if (!twice) p.log.message('(Ctrl+C encore une fois pour quitter)');
  return twice;
}
