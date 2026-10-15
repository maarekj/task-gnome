import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.ts';

/** Shell-quotes a string when needed. */
export const shq = (s: string): string => (/^[\w@%+=:,./-]+$/u.test(s) ? s : `'${s.replaceAll("'", String.raw`'\''`)}'`);

/** terminal -> argv prefix that runs the following program + args */
const TERMINALS: Readonly<Record<string, readonly string[]>> = {
  ghostty: ['ghostty', '-e'],
  kgx: ['kgx', '-e'],
  ptyxis: ['ptyxis', '--new-window', '--'],
  'gnome-terminal': ['gnome-terminal', '--'],
  kitty: ['kitty'],
  alacritty: ['alacritty', '-e'],
  wezterm: ['wezterm', 'start', '--'],
  foot: ['foot'],
  konsole: ['konsole', '-e'],
  'xdg-terminal-exec': ['xdg-terminal-exec'],
};

function inPath(bin: string): boolean {
  return (env('PATH') ?? '').split(':').some((d) => d !== '' && fs.existsSync(path.join(d, bin)));
}

/**
 * Opens a terminal running `command` in an interactive shell, then leaves the shell open.
 * Terminal: `wanted`, else $TASKGNOME_TERMINAL, else the first one found.
 */
export function openTerminal(command: string, wanted?: string): string {
  const name = wanted ?? env('TASKGNOME_TERMINAL') ?? Object.keys(TERMINALS).find((t) => inPath(t));
  if (name === undefined) throw new Error('Aucun terminal trouvé (option --terminal ou variable TASKGNOME_TERMINAL)');
  const [bin = name, ...prefix] = TERMINALS[name] ?? [name, '-e'];
  const shell = env('SHELL') ?? '/bin/sh';
  const child = spawn(bin, [...prefix, shell, '-ic', `${command}; exec ${shq(shell)} -i`], { detached: true, stdio: 'ignore' });
  child.on('error', () => {
    // reported by the terminal itself
  });
  child.unref();
  return name;
}
