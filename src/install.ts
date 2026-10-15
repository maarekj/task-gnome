import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env } from './env.ts';
import { EXTENSION_UUID } from './open.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
export const ENTRY = path.join(ROOT, 'src', 'main.ts');

/** Installs the CLI wrapper, the GNOME Shell extension and the systemd user service. Returns log lines. */
export function install(): string[] {
  const out: string[] = [];
  const pathVar = env('PATH') ?? '';
  const nodeCmd = `${process.execPath} --disable-warning=ExperimentalWarning ${ENTRY}`;

  const binDir = path.join(os.homedir(), '.local', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const wrapper = path.join(binDir, 'taskgnome');
  fs.rmSync(wrapper, { force: true });
  // absolute node path: gnome-shell (extension) and systemd do not share the login shell PATH.
  // PATH is preserved so that opencode is found when running in the foreground.
  fs.writeFileSync(wrapper, `#!/bin/sh\nexport PATH="\${PATH:+$PATH:}${pathVar}"\nexec ${nodeCmd} "$@"\n`, { mode: 0o755 });
  out.push(`CLI: ${wrapper}`);

  const extDir = path.join(os.homedir(), '.local', 'share', 'gnome-shell', 'extensions');
  fs.mkdirSync(extDir, { recursive: true });
  const extLink = path.join(extDir, EXTENSION_UUID);
  fs.rmSync(extLink, { force: true });
  fs.symlinkSync(path.join(ROOT, 'extension'), extLink);
  out.push(`Extension: ${extLink}`);
  try {
    execFileSync('gnome-extensions', ['enable', EXTENSION_UUID], { stdio: 'ignore' });
    out.push('Extension activée.');
  } catch {
    out.push(`→ Wayland: déconnecte/reconnecte ta session, puis: gnome-extensions enable ${EXTENSION_UUID}`);
  }

  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  fs.mkdirSync(unitDir, { recursive: true });
  const unit = `[Unit]
Description=taskgnome — planificateur de prompts opencode
After=graphical-session.target

[Service]
ExecStart=${nodeCmd} daemon
Environment=PATH=${pathVar}
Restart=on-failure
RestartSec=10
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(path.join(unitDir, 'taskgnome.service'), unit);
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  execFileSync('systemctl', ['--user', 'enable', '--now', 'taskgnome.service'], { stdio: 'inherit' });
  execFileSync('systemctl', ['--user', 'restart', 'taskgnome.service'], { stdio: 'inherit' });
  out.push('Service taskgnome.service activé. Logs: journalctl --user -u taskgnome -f');
  if (!pathVar.split(':').includes(binDir)) out.push(`⚠ ${binDir} n'est pas dans ton PATH.`);
  return out;
}
