import fs from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { DB_PATH, ensureDirs, runLogPaths } from './paths.ts';

export interface Task {
  id: number;
  name: string;
  cron: string;
  dir: string;
  prompt: string;
  model: string | null;
  agent: string | null;
  timeout_sec: number;
  enabled: number;
  catch_up: number;
  /** JSON object of extra environment variables */
  env: string;
  /** 1 = run opencode through `direnv exec <dir>` */
  direnv: number;
  last_fire_at: string | null;
  created_at: string;
  updated_at: string;
}

export type RunStatus = 'running' | 'success' | 'error' | 'auth_error' | 'timeout' | 'cancelled';
export type RunTrigger = 'schedule' | 'catchup' | 'manual' | 'interactive';

export interface Run {
  id: number;
  task_id: number;
  task_name: string;
  trigger: RunTrigger;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  session_id: string | null;
  error: string | null;
  output: string | null;
  cost: number | null;
  tokens: number | null;
  pid: number | null;
  prompt: string | null;
}

let db: DatabaseSync | undefined;

export function getDb(): DatabaseSync {
  if (db) return db;
  ensureDirs();
  db = new DatabaseSync(DB_PATH, { timeout: 10_000 }); // wait for locks held by other taskgnome processes
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
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
  const cols = db.prepare('PRAGMA table_info(runs)').all().map((c) => (c as { name: string }).name);
  const tcols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => (c as { name: string }).name);
  // tolerate a concurrent process applying the same migration
  const migrate = (sql: string) => {
    try {
      db!.exec(sql);
    } catch (e) {
      if (!/duplicate column/i.test((e as Error).message)) throw e;
    }
  };
  if (!cols.includes('prompt')) migrate('ALTER TABLE runs ADD COLUMN prompt TEXT');
  if (!tcols.includes('env')) migrate(`ALTER TABLE tasks ADD COLUMN env TEXT NOT NULL DEFAULT '{}'`);
  if (!tcols.includes('direnv')) migrate('ALTER TABLE tasks ADD COLUMN direnv INTEGER NOT NULL DEFAULT 0');
  return db;
}

const now = () => new Date().toISOString();
const rows = <T>(r: unknown[]): T[] => r.map((x) => ({ ...(x as object) }) as T);

// ---------- tasks ----------

export function listTasks(): Task[] {
  return rows<Task>(getDb().prepare('SELECT * FROM tasks ORDER BY id').all());
}

/** Find a task by numeric id or by name. */
export function findTask(ref: string | number): Task | undefined {
  const d = getDb();
  const r =
    typeof ref === 'number' || /^\d+$/.test(ref)
      ? d.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(ref))
      : d.prepare('SELECT * FROM tasks WHERE name = ?').get(ref);
  return r ? ({ ...r } as unknown as Task) : undefined;
}

export type TaskInput = Pick<Task, 'name' | 'cron' | 'dir' | 'prompt' | 'model' | 'agent' | 'timeout_sec' | 'enabled' | 'catch_up' | 'env' | 'direnv'>;

export function createTask(t: TaskInput): Task {
  const ts = now();
  const r = getDb()
    .prepare(
      `INSERT INTO tasks (name, cron, dir, prompt, model, agent, timeout_sec, enabled, catch_up, env, direnv, last_fire_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(t.name, t.cron, t.dir, t.prompt, t.model, t.agent, t.timeout_sec, t.enabled, t.catch_up, t.env, t.direnv, ts, ts, ts);
  return findTask(Number(r.lastInsertRowid))!;
}

export function updateTask(id: number, patch: Partial<TaskInput & { last_fire_at: string | null }>): Task {
  const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  if (keys.length) {
    const values = keys.map((k) => (patch as Record<string, SQLInputValue>)[k]);
    getDb()
      .prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...values, now(), id);
  }
  return findTask(id)!;
}

export function deleteTask(id: number): void {
  for (const r of getDb().prepare('SELECT id FROM runs WHERE task_id = ?').all(id)) {
    removeRunFiles(Number((r as { id: number }).id));
  }
  getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id);
}

export function setLastFire(id: number, at: string): void {
  getDb().prepare('UPDATE tasks SET last_fire_at = ? WHERE id = ?').run(at, id);
}

// ---------- runs ----------

export function setRunSession(id: number, sessionId: string): void {
  getDb().prepare('UPDATE runs SET session_id = ? WHERE id = ?').run(sessionId, id);
}

export function setRunPrompt(id: number, prompt: string): void {
  getDb().prepare('UPDATE runs SET prompt = ? WHERE id = ?').run(prompt, id);
}

/** Task owning an opencode session (through the runs that used it). */
export function taskForSession(sessionId: string): Task | undefined {
  const r = getDb().prepare('SELECT task_id FROM runs WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(sessionId) as { task_id: number } | undefined;
  return r ? findTask(r.task_id) : undefined;
}

export function createRun(task: Task, trigger: RunTrigger, prompt: string | null = task.prompt): Run {
  const r = getDb()
    .prepare(`INSERT INTO runs (task_id, task_name, trigger, status, started_at, pid, prompt) VALUES (?, ?, ?, 'running', ?, ?, ?)`)
    .run(task.id, task.name, trigger, now(), process.pid, prompt);
  return getRun(Number(r.lastInsertRowid))!;
}

export function finishRun(
  id: number,
  f: Pick<Run, 'status' | 'exit_code' | 'session_id' | 'error' | 'output' | 'cost' | 'tokens'>,
): Run {
  getDb()
    .prepare(
      `UPDATE runs SET status = ?, finished_at = ?, exit_code = ?, session_id = ?, error = ?, output = ?, cost = ?, tokens = ?
       WHERE id = ?`,
    )
    .run(f.status, now(), f.exit_code, f.session_id, f.error, f.output, f.cost, f.tokens, id);
  return getRun(id)!;
}

export function getRun(id: number): Run | undefined {
  const r = getDb().prepare('SELECT * FROM runs WHERE id = ?').get(id);
  return r ? ({ ...r } as unknown as Run) : undefined;
}

/** All runs of an opencode session, oldest first. */
export function sessionRuns(sessionId: string): Run[] {
  return rows<Run>(getDb().prepare('SELECT * FROM runs WHERE session_id = ? ORDER BY id').all(sessionId));
}

export function listRuns(opts: { taskId?: number; failed?: boolean; limit?: number } = {}): Run[] {
  const where: string[] = [];
  const args: SQLInputValue[] = [];
  if (opts.taskId !== undefined) {
    where.push('task_id = ?');
    args.push(opts.taskId);
  }
  if (opts.failed) where.push(`status NOT IN ('success', 'running')`);
  const sql = `SELECT * FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  return rows<Run>(getDb().prepare(sql).all(...args, opts.limit ?? 20));
}

export function runningRuns(): Run[] {
  return rows<Run>(getDb().prepare(`SELECT * FROM runs WHERE status = 'running' ORDER BY id`).all());
}

export function lastRun(taskId: number): Run | undefined {
  const r = getDb().prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(taskId);
  return r ? ({ ...r } as unknown as Run) : undefined;
}

/** Runs left in 'running' by a process that no longer exists. */
export function reapStaleRuns(): number {
  let n = 0;
  for (const r of runningRuns()) {
    if (r.pid && isAlive(r.pid)) continue;
    finishRun(r.id, { status: 'error', exit_code: null, session_id: r.session_id, error: 'Interrompu (processus disparu)', output: r.output, cost: null, tokens: null });
    n++;
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
