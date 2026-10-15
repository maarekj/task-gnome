import fs from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import { DB_PATH, ensureDirs, runLogPaths } from './paths.ts';
import { RunStatus, RunTrigger } from './shared/api.ts';
import { errorMessage } from './util.ts';

// ---------------------------------------------------------------- schemas

const sqlBool = z.number().int().transform((n) => n !== 0);
const envJson = z.string().transform((s, ctx): Record<string, string> => {
  const parsed = z.record(z.string(), z.string()).safeParse(safeJson(s));
  if (parsed.success) return parsed.data;
  ctx.addIssue({ code: 'custom', message: `env invalide: ${s}` });
  return z.NEVER;
});

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const TaskRow = z.object({
  id: z.number().int(),
  name: z.string(),
  cron: z.string(),
  dir: z.string(),
  prompt: z.string(),
  model: z.string().nullable(),
  agent: z.string().nullable(),
  timeout_sec: z.number().int(),
  enabled: sqlBool,
  catch_up: sqlBool,
  /** extra environment variables */
  env: envJson,
  /** run opencode through `direnv exec <dir>` */
  direnv: sqlBool,
  last_fire_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Task = z.output<typeof TaskRow>;

export { RunStatus, RunTrigger } from './shared/api.ts';

const RunRow = z.object({
  id: z.number().int(),
  task_id: z.number().int(),
  task_name: z.string(),
  trigger: RunTrigger,
  status: RunStatus,
  started_at: z.string(),
  finished_at: z.string().nullable(),
  exit_code: z.number().int().nullable(),
  session_id: z.string().nullable(),
  error: z.string().nullable(),
  output: z.string().nullable(),
  cost: z.number().nullable(),
  tokens: z.number().int().nullable(),
  pid: z.number().int().nullable(),
  prompt: z.string().nullable(),
});
export type Run = z.output<typeof RunRow>;

const ColumnRow = z.object({ name: z.string() });
const IdRow = z.object({ id: z.number().int() });
const TaskIdRow = z.object({ task_id: z.number().int() });

// ---------------------------------------------------------------- connection

let db: DatabaseSync | undefined;

function migrate(d: DatabaseSync): void {
  d.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS tasks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL UNIQUE,
      cron         TEXT NOT NULL,
      dir          TEXT NOT NULL,
      prompt       TEXT NOT NULL,
      model        TEXT,
      agent        TEXT,
      timeout_sec  INTEGER NOT NULL DEFAULT 1800,
      enabled      INTEGER NOT NULL DEFAULT 1,
      catch_up     INTEGER NOT NULL DEFAULT 1,
      last_fire_at TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      task_name   TEXT NOT NULL,
      trigger     TEXT NOT NULL,
      status      TEXT NOT NULL,
      started_at  TEXT NOT NULL,
      finished_at TEXT,
      exit_code   INTEGER,
      session_id  TEXT,
      error       TEXT,
      output      TEXT,
      cost        REAL,
      tokens      INTEGER,
      pid         INTEGER
    );
    CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id, id DESC);
  `);
  const columns = (table: string): Set<string> =>
    new Set(d.prepare(`PRAGMA table_info(${table})`).all().map((c) => ColumnRow.parse(c).name));
  // tolerate a concurrent process applying the same migration
  const alter = (sql: string): void => {
    try {
      d.exec(sql);
    } catch (error) {
      if (!/duplicate column/iu.test(errorMessage(error))) throw error;
    }
  };
  const runCols = columns('runs');
  const taskCols = columns('tasks');
  if (!runCols.has('prompt')) alter('ALTER TABLE runs ADD COLUMN prompt TEXT');
  if (!taskCols.has('env')) alter(`ALTER TABLE tasks ADD COLUMN env TEXT NOT NULL DEFAULT '{}'`);
  if (!taskCols.has('direnv')) alter('ALTER TABLE tasks ADD COLUMN direnv INTEGER NOT NULL DEFAULT 0');
}

export function getDb(): DatabaseSync {
  if (db !== undefined) return db;
  ensureDirs();
  // wait for locks held by other taskgnome processes (daemon, CLI, extension)
  const d = new DatabaseSync(DB_PATH, { timeout: 10_000 });
  migrate(d);
  db = d;
  return d;
}

const now = (): string => new Date().toISOString();
const toTask = (row: unknown): Task => TaskRow.parse(row);
const toRun = (row: unknown): Run => RunRow.parse(row);

// ---------------------------------------------------------------- tasks

export function listTasks(): Task[] {
  return getDb().prepare('SELECT * FROM tasks ORDER BY id').all().map((r) => toTask(r));
}

/** Find a task by numeric id or by name. */
export function findTask(ref: string | number): Task | undefined {
  const d = getDb();
  const row =
    typeof ref === 'number' || /^\d+$/u.test(ref)
      ? d.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(ref))
      : d.prepare('SELECT * FROM tasks WHERE name = ?').get(ref);
  return row === undefined ? undefined : toTask(row);
}

function getTask(id: number): Task {
  const t = findTask(id);
  if (t === undefined) throw new Error(`Tâche #${id} introuvable`);
  return t;
}

export interface TaskInput {
  name: string;
  cron: string;
  dir: string;
  prompt: string;
  model: string | null;
  agent: string | null;
  timeout_sec: number;
  enabled: boolean;
  catch_up: boolean;
  env: Record<string, string>;
  direnv: boolean;
}

export type TaskPatch = Partial<TaskInput & { last_fire_at: string | null }>;

function toSql(value: TaskPatch[keyof TaskPatch]): SQLInputValue {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return value ?? null;
}

export function createTask(t: TaskInput): Task {
  const ts = now();
  const r = getDb()
    .prepare(
      `INSERT INTO tasks (name, cron, dir, prompt, model, agent, timeout_sec, enabled, catch_up, env, direnv, last_fire_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(t.name, t.cron, t.dir, t.prompt, t.model, t.agent, t.timeout_sec, toSql(t.enabled), toSql(t.catch_up), toSql(t.env), toSql(t.direnv), ts, ts, ts);
  return getTask(Number(r.lastInsertRowid));
}

export function updateTask(id: number, patch: TaskPatch): Task {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length > 0) {
    getDb()
      .prepare(`UPDATE tasks SET ${entries.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...entries.map(([, v]) => toSql(v)), now(), id);
  }
  return getTask(id);
}

export function deleteTask(id: number): void {
  for (const row of getDb().prepare('SELECT id FROM runs WHERE task_id = ?').all(id)) {
    removeRunFiles(IdRow.parse(row).id);
  }
  getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id);
}

export function setLastFire(id: number, at: string): void {
  getDb().prepare('UPDATE tasks SET last_fire_at = ? WHERE id = ?').run(at, id);
}

// ---------------------------------------------------------------- runs

export function setRunSession(id: number, sessionId: string): void {
  getDb().prepare('UPDATE runs SET session_id = ? WHERE id = ?').run(sessionId, id);
}

export function setRunPrompt(id: number, prompt: string): void {
  getDb().prepare('UPDATE runs SET prompt = ? WHERE id = ?').run(prompt, id);
}

/** Task owning an opencode session (through the runs that used it). */
export function taskForSession(sessionId: string): Task | undefined {
  const row = getDb().prepare('SELECT task_id FROM runs WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(sessionId);
  return row === undefined ? undefined : findTask(TaskIdRow.parse(row).task_id);
}

export function createRun(task: Task, trigger: RunTrigger, prompt: string | null): Run {
  const r = getDb()
    .prepare(`INSERT INTO runs (task_id, task_name, trigger, status, started_at, pid, prompt) VALUES (?, ?, ?, 'running', ?, ?, ?)`)
    .run(task.id, task.name, trigger, now(), process.pid, prompt);
  return mustGetRun(Number(r.lastInsertRowid));
}

export type RunResult = Pick<Run, 'status' | 'exit_code' | 'session_id' | 'error' | 'output' | 'cost' | 'tokens'>;

export function finishRun(id: number, f: RunResult): Run {
  getDb()
    .prepare(
      `UPDATE runs SET status = ?, finished_at = ?, exit_code = ?, session_id = ?, error = ?, output = ?, cost = ?, tokens = ?
       WHERE id = ?`,
    )
    .run(f.status, now(), f.exit_code, f.session_id, f.error, f.output, f.cost, f.tokens, id);
  return mustGetRun(id);
}

export function getRun(id: number): Run | undefined {
  const row = getDb().prepare('SELECT * FROM runs WHERE id = ?').get(id);
  return row === undefined ? undefined : toRun(row);
}

function mustGetRun(id: number): Run {
  const r = getRun(id);
  if (r === undefined) throw new Error(`Run #${id} introuvable`);
  return r;
}

/** All runs of an opencode session, oldest first. */
export function sessionRuns(sessionId: string): Run[] {
  return getDb().prepare('SELECT * FROM runs WHERE session_id = ? ORDER BY id').all(sessionId).map((r) => toRun(r));
}

export interface RunFilter {
  taskId?: number | undefined;
  failed?: boolean | undefined;
  limit?: number | undefined;
}

export function listRuns(opts: RunFilter = {}): Run[] {
  const where: string[] = [];
  const args: SQLInputValue[] = [];
  if (opts.taskId !== undefined) {
    where.push('task_id = ?');
    args.push(opts.taskId);
  }
  if (opts.failed === true) where.push(`status NOT IN ('success', 'running')`);
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return getDb()
    .prepare(`SELECT * FROM runs ${clause} ORDER BY id DESC LIMIT ?`)
    .all(...args, opts.limit ?? 20)
    .map((r) => toRun(r));
}

export function runningRuns(): Run[] {
  return getDb().prepare(`SELECT * FROM runs WHERE status = 'running' ORDER BY id`).all().map((r) => toRun(r));
}

export function lastRun(taskId: number): Run | undefined {
  const row = getDb().prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(taskId);
  return row === undefined ? undefined : toRun(row);
}

/** Runs left in 'running' by a process that no longer exists. */
export function reapStaleRuns(): number {
  let n = 0;
  for (const r of runningRuns()) {
    if (r.pid !== null && isAlive(r.pid)) continue;
    finishRun(r.id, {
      status: 'error',
      exit_code: null,
      session_id: r.session_id,
      error: 'Interrompu (processus disparu)',
      output: r.output,
      cost: null,
      tokens: null,
    });
    n += 1;
  }
  return n;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeRunFiles(runId: number): void {
  for (const p of Object.values(runLogPaths(runId))) fs.rmSync(p, { force: true });
}
