// User settings: ~/.config/taskgnome/config.json (TASKGNOME_CONFIG to override).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { env } from './env.ts';

export const CONFIG_PATH =
  env('TASKGNOME_CONFIG') ?? path.join(env('XDG_CONFIG_HOME') ?? path.join(os.homedir(), '.config'), 'taskgnome', 'config.json');

const Config = z.object({
  /** terminal used by "Continuer"; absent = automatic */
  terminal: z.string().optional(),
});
export type Config = z.output<typeof Config>;

export function readConfig(): Config {
  try {
    const parsed = Config.safeParse(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function writeConfig(c: Config): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(c, null, 2)}\n`);
}
