// JSON contract between the CLI (`taskgnome … --json`) and the GNOME Shell extension.
// Pure module (zod/mini only: tree-shakable, keeps the extension bundle small):
// imported by the Node CLI and bundled into the GJS extension.
import * as z from 'zod/mini';

export const RunStatus = z.enum(['running', 'success', 'error', 'auth_error', 'timeout', 'cancelled']);
export type RunStatus = z.output<typeof RunStatus>;
export const RunTrigger = z.enum(['schedule', 'catchup', 'manual', 'interactive']);
export type RunTrigger = z.output<typeof RunTrigger>;

export const STATUS_ICON: Readonly<Record<RunStatus, string>> = {
  running: '⏳', success: '✓', error: '✗', auth_error: '🔑', timeout: '⌛', cancelled: '⏹',
};
/** Statuses shown as failures (badge, "errors only" filter). */
export const FAILED_STATUSES: ReadonlySet<RunStatus> = new Set(['error', 'auth_error', 'timeout']);

export const Task = z.object({
  id: z.int(),
  name: z.string(),
  cron: z.string(),
  dir: z.string(),
  prompt: z.string(),
  model: z.nullable(z.string()),
  agent: z.nullable(z.string()),
  timeout_sec: z.int(),
  enabled: z.boolean(),
  catch_up: z.boolean(),
  env: z.record(z.string(), z.string()),
  direnv: z.boolean(),
  last_fire_at: z.nullable(z.string()),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Task = z.output<typeof Task>;

export const RunView = z.object({
  id: z.int(),
  task_id: z.int(),
  task_name: z.string(),
  trigger: RunTrigger,
  status: RunStatus,
  started_at: z.string(),
  finished_at: z.nullable(z.string()),
  exit_code: z.nullable(z.int()),
  session_id: z.nullable(z.string()),
  error: z.nullable(z.string()),
  cost: z.nullable(z.number()),
  tokens: z.nullable(z.int()),
  pid: z.nullable(z.int()),
  prompt: z.nullable(z.string()),
  duration_ms: z.nullable(z.number()),
});
export type RunView = z.output<typeof RunView>;

export const TaskView = z.extend(Task, {
  next_run: z.nullable(z.string()),
  last_run: z.nullable(RunView),
});
export type TaskView = z.output<typeof TaskView>;

export const Entry = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('prompt'), text: z.string() }),
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('reasoning'), text: z.string() }),
  z.object({
    kind: z.literal('tool'),
    id: z.string(),
    tool: z.string(),
    title: z.string(),
    status: z.string(),
    input: z.string(),
    output: z.string(),
  }),
  z.object({ kind: z.literal('error'), text: z.string() }),
]);
export type Entry = z.output<typeof Entry>;

export const SessionRunView = z.extend(RunView, { transcript: z.array(Entry) });
export type SessionRunView = z.output<typeof SessionRunView>;

// ---------------------------------------------------------------- command outputs

/** `taskgnome overview` */
export const Overview = z.object({
  daemon: z.nullable(z.object({ pid: z.int() })),
  tasks: z.array(TaskView),
  runs: z.array(RunView),
});
export type Overview = z.output<typeof Overview>;

/** `taskgnome history --json` */
export const History = z.array(RunView);

/** `taskgnome logs <run> --json --transcript` */
export const RunLogs = z.extend(RunView, {
  output: z.nullable(z.string()),
  logs: z.object({ stdout: z.string(), stderr: z.string() }),
  transcript: z.array(Entry),
  session_runs: z.array(SessionRunView),
});
export type RunLogs = z.output<typeof RunLogs>;

/** `taskgnome run <task> --json` (through the daemon) */
export const Launched = z.object({ ok: z.literal(true), run: z.int() });

/** `taskgnome resume <run> --json [--print]` */
export const Resumed = z.intersection(
  z.object({ command: z.string() }),
  z.union([
    z.object({ ok: z.literal(true), terminal: z.string() }),
    z.object({ session_id: z.string(), dir: z.string(), url: z.string() }),
  ]),
);

/** Any `{ok: true}` acknowledgement (cancel, open…). */
export const Ack = z.looseObject({ ok: z.literal(true) });

/** Error printed with --json. */
export const Failure = z.object({ ok: z.literal(false), error: z.string() });

/** Request written by the CLI / panel menu, read by the preferences window: open it on a run. */
export const OpenRequest = z.object({ run: z.int(), ts: z.number() });
export type OpenRequest = z.output<typeof OpenRequest>;
export const OPEN_REQUEST_FILE = 'open-request.json';
export const OPEN_REQUEST_MAX_AGE_MS = 60_000;

/** `taskgnome terminal --json` */
export const TerminalInfo = z.object({
  /** terminal used by "Continuer" (null: none found) */
  current: z.nullable(z.string()),
  source: z.enum(['option', 'env', 'config', 'auto']),
  /** configured value (null: automatic) */
  configured: z.nullable(z.string()),
  installed: z.array(z.string()),
  known: z.array(z.string()),
});
export type TerminalInfo = z.output<typeof TerminalInfo>;
