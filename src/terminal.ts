import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from './config.ts';
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

/** Known terminals, in automatic-choice order. */
export const KNOWN_TERMINALS: readonly string[] = Object.keys(TERMINALS);

/** Known terminals installed on this machine. */
export function installedTerminals(): string[] {
  return KNOWN_TERMINALS.filter((t) => inPath(t));
}

/** Terminal that "Continuer" will use and where the choice comes from. */
export function resolveTerminal(wanted?: string): { name: string | undefined; source: 'option' | 'env' | 'config' | 'auto' } {
  if (wanted !== undefined) return { name: wanted, source: 'option' };
  const fromEnv = env('TASKGNOME_TERMINAL');
  if (fromEnv !== undefined) return { name: fromEnv, source: 'env' };
  const fromConfig = readConfig().terminal;
  if (fromConfig !== undefined) return { name: fromConfig, source: 'config' };
  return { name: installedTerminals()[0], source: 'auto' };
}

/**
 * Opens a terminal running `command` in an interactive shell, then leaves the shell open.
 * Terminal: `wanted`, else $TASKGNOME_TERMINAL, else the configured one, else the first one found.
 */
export function openTerminal(command: string, wanted?: string): string {
  const { name } = resolveTerminal(wanted);
  if (name === undefined) throw new Error('Aucun terminal trouvé : choisis-en un (taskgnome terminal --set <nom>)');
  const [bin = name, ...prefix] = TERMINALS[name] ?? [name, '-e'];
  const shell = env('SHELL') ?? '/bin/sh';
  const child = spawn(bin, [...prefix, shell, '-ic', `${command}; exec ${shq(shell)} -i`], { detached: true, stdio: 'ignore' });
  child.on('error', () => {
    // reported by the terminal itself
  });
  child.unref();
  return name;
}
