// Entry point of the `taskgnome` CLI (and of the daemon: `taskgnome daemon`).
import { run } from '@stricli/core';
import { app } from './cli/app.ts';
import { buildContext } from './cli/shared.ts';

/** Stricli does not accept an empty inline value: `--model=` -> `--model ''` (clears the value). */
const normalize = (args: readonly string[]): string[] =>
  args.flatMap((a) => (/^--[\w-]+=$/u.test(a) ? [a.slice(0, -1), ''] : [a]));

const args = normalize(process.argv.slice(2));
const inputs = args.length === 0 && process.stdin.isTTY && process.stdout.isTTY ? ['interactive'] : args;
await run(app, inputs, buildContext(process));
