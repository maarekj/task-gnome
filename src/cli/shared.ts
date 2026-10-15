import fs from 'node:fs';
import type { CommandContext, StricliProcess } from '@stricli/core';
import { DaemonError } from '../ipc.ts';
import { errorMessage, parseDuration, validateCron } from '../util.ts';
import { parseEnvAssignment, requireTask, resolveDir, UsageError } from './ops.ts';

export interface Context extends CommandContext {
  readonly process: StricliProcess;
}

/** Adapter: Node's `process.exitCode` may be undefined, Stricli's may not. */
export const buildContext = (proc: NodeJS.Process): Context & { readonly process: StricliProcess } => ({
  process: {
    stdout: proc.stdout,
    stderr: proc.stderr,
    env: proc.env,
    get exitCode(): number | string | null {
      return proc.exitCode ?? null;
    },
    set exitCode(code: number | string | null) {
      proc.exitCode = code ?? undefined;
    },
  },
});

// ---------------------------------------------------------------- output

export interface JsonFlag {
  readonly json: boolean;
}

export const jsonFlag = {
  json: { kind: 'boolean', brief: 'Sortie JSON (pour les scripts, agents et l\'extension GNOME)', default: false },
} as const;

export function print(ctx: Context, line = ''): void {
  ctx.process.stdout.write(`${line}\n`);
}

export function printJson(ctx: Context, data: unknown): void {
  print(ctx, JSON.stringify(data, null, 2));
}

/** Prints data as JSON with --json, else calls the human renderer. */
export function output(ctx: Context, flags: JsonFlag, data: unknown, human: () => void): void {
  if (flags.json) printJson(ctx, data);
  else human();
}

/**
 * Wraps a command body: errors are printed as `{ok:false,error}` with --json (the extension relies on it),
 * else as a one-line message. Usage errors exit with 2, others with 1.
 */
export async function guard(ctx: Context, flags: JsonFlag, body: () => Promise<void> | void): Promise<void> {
  try {
    await body();
  } catch (error) {
    const msg = errorMessage(error);
    if (flags.json) print(ctx, JSON.stringify({ ok: false, error: msg }));
    else ctx.process.stderr.write(`Erreur: ${msg}\n`);
    ctx.process.exitCode = error instanceof UsageError || error instanceof DaemonError ? 2 : 1;
  }
}

// ---------------------------------------------------------------- parsers (Stricli input parsers)

export const parseTask = (input: string): ReturnType<typeof requireTask> => requireTask(input);

export function parseId(input: string): number {
  if (!/^\d+$/u.test(input)) throw new UsageError(`Identifiant invalide: ${input}`);
  return Number(input);
}

export function parsePositive(input: string): number {
  const n = parseId(input);
  if (n === 0) throw new UsageError('Doit être supérieur à 0');
  return n;
}

export function parseCron(input: string): string {
  validateCron(input);
  return input;
}

export const parseDir = (input: string): string => resolveDir(input);
export const parseSeconds = (input: string): number => parseDuration(input);
export const parseEnv = (input: string): [string, string] => parseEnvAssignment(input);
export const parseString = (input: string): string => input;
/** Trimmed string; "" is used to clear a value (e.g. `--model=`), see `orNull`. */
export const parseTrimmed = (input: string): string => input.trim();
export const orNull = (s: string): string | null => (s === '' ? null : s);

/** Prompt from --prompt (or `-` = stdin) / --prompt-file. */
export function readPrompt(prompt: string | undefined, promptFile: string | undefined): string | undefined {
  if (promptFile !== undefined) return fs.readFileSync(promptFile, 'utf8');
  if (prompt === '-') return fs.readFileSync(0, 'utf8');
  return prompt;
}
