// Business operations shared by the Stricli commands and the interactive mode.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findTask, getRun, lastRun, listRuns, reapStaleRuns, sessionRuns,
  type Run, type RunFilter, type Task, type TaskInput,
} from '../db.ts';
import { daemon } from '../ipc.ts';
import { runLogPaths } from '../paths.ts';
import { Runner } from '../runner.ts';
import { shq } from '../terminal.ts';
import type { Entry, RunView, SessionRunView, TaskView } from '../shared/api.ts';
import { readTranscript } from '../transcript.ts';
import { nextRun } from '../util.ts';

/** Error caused by user input: printed without stack trace, exit code 2. */
export class UsageError extends Error {}

export { STATUS_ICON } from '../shared/api.ts';

export const DEFAULT_TIMEOUT_SEC = 30 * 60;

// ---------------------------------------------------------------- lookups

export function requireTask(ref: string | number): Task {
  const t = findTask(ref);
  if (t === undefined) throw new UsageError(`Tâche introuvable: ${ref}`);
  return t;
}

export function requireRun(id: number): Run {
  const r = getRun(id);
  if (r === undefined) throw new UsageError(`Run introuvable: ${id}`);
  return r;
}

export function resolveDir(dir: string): string {
  const abs = path.resolve(dir.replace(/^~(?=$|\/)/u, os.homedir()));
  if (fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory() !== true) throw new UsageError(`Dossier inexistant: ${abs}`);
  return abs;
}

export function validateName(name: string, current?: Task): string {
  const n = name.trim();
  if (n === '') throw new UsageError('Le nom ne peut pas être vide');
  if (/^\d+$/u.test(n)) throw new UsageError('Le nom ne peut pas être purement numérique');
  const other = findTask(n);
  if (other !== undefined && other.id !== current?.id) throw new UsageError(`Une tâche "${n}" existe déjà`);
  return n;
}

/** "KEY=VALUE" -> [key, value]. An empty value means "remove the variable". */
export function parseEnvAssignment(kv: string): [string, string] {
  const i = kv.indexOf('=');
  const key = kv.slice(0, i).trim();
  if (i < 1 || !/^[A-Za-z_]\w*$/u.test(key)) throw new UsageError(`Variable invalide: "${kv}" (attendu CLE=VALEUR)`);
  return [key, kv.slice(i + 1)];
}

export function applyEnv(base: Readonly<Record<string, string>>, assignments: readonly (readonly [string, string])[]): Record<string, string> {
  const result: Record<string, string> = { ...base };
  for (const [k, v] of assignments) {
    if (v === '') delete result[k];
    else result[k] = v;
  }
  return result;
}

// ---------------------------------------------------------------- views (JSON output, read by the GNOME extension)

export type { RunView, TaskView };

export function runView(r: Run): RunView {
  const { output: _output, ...rest } = r;
  return { ...rest, duration_ms: r.finished_at === null ? null : Date.parse(r.finished_at) - Date.parse(r.started_at) };
}

export function taskView(t: Task): TaskView {
  const last = lastRun(t.id);
  return {
    ...t,
    next_run: t.enabled ? (nextRun(t.cron)?.toISOString() ?? null) : null,
    last_run: last === undefined ? null : runView(last),
  };
}

export function listRunViews(filter: RunFilter): RunView[] {
  return listRuns(filter).map((r) => runView(r));
}

// ---------------------------------------------------------------- logs

export function transcriptOf(r: Run): Entry[] {
  const prompt = r.prompt ?? (r.trigger === 'interactive' ? null : (findTask(r.task_id)?.prompt ?? null));
  return readTranscript(runLogPaths(r.id).stdout, prompt);
}

/** The whole conversation: every run sharing the run's opencode session. */
export function sessionOf(r: Run): SessionRunView[] {
  const runs = r.session_id === null ? [r] : sessionRuns(r.session_id);
  return runs.map((x): SessionRunView => Object.assign(runView(x), { transcript: transcriptOf(x) }));
}

// ---------------------------------------------------------------- actions

export type RunOutcome = { mode: 'daemon'; runId: number } | { mode: 'foreground'; run: Run };

/** Runs a task: through the daemon if reachable, else in this process (waits for the end). */
export async function runTask(task: Task, opts: { foreground?: boolean; onStart?: (runId: number) => void } = {}): Promise<RunOutcome> {
  if (opts.foreground !== true) {
    const r = await daemon.run(task.id);
    if (r !== null) return { mode: 'daemon', runId: r.run };
  }
  reapStaleRuns();
  const cur = lastRun(task.id);
  if (cur?.status === 'running') throw new UsageError(`La tâche tourne déjà (run #${cur.id})`);
  const runner = new Runner();
  const started = runner.start(task, 'manual');
  opts.onStart?.(started.run.id);
  const cancel = (): void => {
    runner.cancel(started.run.id);
  };
  process.on('SIGINT', cancel).on('SIGTERM', cancel);
  try {
    return { mode: 'foreground', run: await started.done };
  } finally {
    process.off('SIGINT', cancel).off('SIGTERM', cancel);
    runner.pool.stopAll();
  }
}

/** Cancels a run (daemon, or foreground process started by another CLI). */
export async function cancelRun(id: number): Promise<string> {
  try {
    const r = await daemon.cancel(id);
    if (r !== null) return `Annulation du run #${id} demandée.`;
  } catch {
    // not handled by the daemon: maybe a foreground run
  }
  const run = getRun(id);
  if (run?.status === 'running' && run.pid !== null) {
    process.kill(run.pid, 'SIGTERM');
    return `SIGTERM envoyé au processus ${run.pid}.`;
  }
  throw new UsageError(`Run #${id} introuvable ou terminé`);
}

export interface ResumeInfo {
  command: string;
  session_id: string;
  dir: string;
  url: string;
}

/**
 * Command reopening the run's session in a terminal: the daemon hosts the session on an opencode
 * server and the terminal is only a client, so work continues (and is followed) if it is closed.
 */
export async function getResumeInfo(runId: number): Promise<ResumeInfo> {
  const run = requireRun(runId);
  const a = await daemon.attach(run.id);
  if (a === null) throw new UsageError('Démon injoignable: lance-le (systemctl --user start taskgnome)');
  const command = `cd ${shq(a.dir)} && OPENCODE_SERVER_PASSWORD=${shq(a.password)} opencode attach ${a.url} --dir ${shq(a.dir)} -s ${a.session}`;
  return { command, session_id: a.session, dir: a.dir, url: a.url };
}

export function newTaskInput(fields: Partial<TaskInput> & Pick<TaskInput, 'name' | 'cron' | 'dir' | 'prompt'>): TaskInput {
  return {
    model: null,
    agent: null,
    timeout_sec: DEFAULT_TIMEOUT_SEC,
    enabled: true,
    catch_up: true,
    env: {},
    direnv: false,
    ...fields,
  };
}
