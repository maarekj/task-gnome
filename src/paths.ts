import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();

export const DATA_DIR =
  process.env.TASKGNOME_DATA_DIR ??
  path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'taskgnome');
export const RUNS_DIR = path.join(DATA_DIR, 'runs');
export const DB_PATH = path.join(DATA_DIR, 'taskgnome.db');
export const SOCKET_PATH =
  process.env.TASKGNOME_SOCKET ??
  path.join(process.env.XDG_RUNTIME_DIR ?? os.tmpdir(), 'taskgnome.sock');

export function ensureDirs(): void {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
}

export function runLogPaths(runId: number): { stdout: string; stderr: string } {
  return {
    stdout: path.join(RUNS_DIR, `${runId}.jsonl`),
    stderr: path.join(RUNS_DIR, `${runId}.stderr.log`),
  };
}
