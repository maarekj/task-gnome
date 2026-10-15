// Scheduling decision, pure (no I/O): tested in test/schedule.test.ts.
import type { Task } from './db.ts';
import { nextRun } from './util.ts';

/** A schedule missed by more than this is considered a "catch-up" (e.g. after suspend / boot). */
export const LATE_MS = 2 * 60_000;

export type Decision =
  | { action: 'wait' }
  /** run now (`schedule` = on time, `catchup` = late); last_fire_at must be set to now */
  | { action: 'run'; trigger: 'schedule' | 'catchup' }
  /** a slot was missed and catch-up is off: only move last_fire_at to now */
  | { action: 'skip' };

/**
 * Stateless: compares the next occurrence after `last_fire_at` (or creation) with now.
 * Several missed slots collapse into a single run.
 */
export function decide(task: Pick<Task, 'enabled' | 'cron' | 'last_fire_at' | 'created_at' | 'catch_up'>, now: number): Decision {
  if (!task.enabled) return { action: 'wait' };
  const due = nextRun(task.cron, new Date(task.last_fire_at ?? task.created_at));
  if (due === null || due.getTime() > now) return { action: 'wait' };
  const late = now - due.getTime() > LATE_MS;
  if (late && !task.catch_up) return { action: 'skip' };
  return { action: 'run', trigger: late ? 'catchup' : 'schedule' };
}
