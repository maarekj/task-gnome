import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env } from './env.ts';

export const DATA_DIR = env('TASKGNOME_DATA_DIR') ?? path.join(env('XDG_DATA_HOME') ?? path.join(os.homedir(), '.local', 'share'), 'taskgnome');
export const RUNS_DIR = path.join(DATA_DIR, 'runs');
export const DB_PATH = path.join(DATA_DIR, 'taskgnome.db');
export const SOCKET_PATH = env('TASKGNOME_SOCKET') ?? path.join(env('XDG_RUNTIME_DIR') ?? os.tmpdir(), 'taskgnome.sock');

export function ensureDirs(): void {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
}

export function runLogPaths(runId: number): { stdout: string; stderr: string } {
  return {
    stdout: path.join(RUNS_DIR, `${runId}.jsonl`),
    stderr: path.join(RUNS_DIR, `${runId}.stderr.log`),
  };
}
