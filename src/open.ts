import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.ts';

export const EXTENSION_UUID = 'taskgnome@maarek';
/** Read by the preferences window (extension/prefs.js), at startup or through a file monitor. */
export const OPEN_REQUEST = path.join(DATA_DIR, 'open-request.json');

/** Opens the extension preferences window directly on a run. */
export function openRun(runId: number): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OPEN_REQUEST, JSON.stringify({ run: runId, ts: Date.now() }));
  return new Promise((resolve, reject) => {
    execFile(
      'gdbus',
      ['call', '--session', '--dest', 'org.gnome.Shell', '--object-path', '/org/gnome/Shell',
        '--method', 'org.gnome.Shell.Extensions.OpenExtensionPrefs', '--', `'${EXTENSION_UUID}'`, "''", '@a{sv} {}'],
      { timeout: 5000 },
      (err) => (err ? reject(new Error(`Impossible d'ouvrir les préférences: ${err.message.split('\n')[0]}`)) : resolve()),
    );
  });
}
