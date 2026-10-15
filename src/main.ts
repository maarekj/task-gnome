// Entry point of the `taskgnome` CLI (and of the daemon: `taskgnome daemon`).
import { ExitCode, run } from '@stricli/core';
import { buildApp } from './cli/app.ts';
import { buildContext } from './cli/shared.ts';

/** Stricli does not accept an empty inline value: `--model=` -> `--model ''` (clears the value). */
const normalize = (args: readonly string[]): string[] =>
  args.flatMap((a) => (/^--[\w-]+=$/u.test(a) ? [a.slice(0, -1), ''] : [a]));

// output piped into a command that stops reading (e.g. `| head`): exit quietly, like other Unix tools
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

const args = normalize(process.argv.slice(2));
const inputs = args.length === 0 && process.stdin.isTTY && process.stdout.isTTY ? ['interactive'] : args;
const json = inputs.includes('--json');
// with --json, Stricli's own errors (written to stderr, one per line) become a single JSON line on stdout
const stricliErrors: string[] = [];
const stderr = json ? { write: (s: string): void => void stricliErrors.push(s.trim()) } : process.stderr;
await run(buildApp(json), inputs, buildContext(process, stderr));
if (stricliErrors.length > 0) process.stdout.write(`${JSON.stringify({ ok: false, error: stricliErrors.filter((s) => s !== '').join('\n') })}\n`);
// argument errors (Stricli: -4 / 252) use the same exit code as our usage errors
if (process.exitCode === ExitCode.InvalidArgument || process.exitCode === ExitCode.UnknownCommand) process.exitCode = 2;
