import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  createTask, deleteTask, findTask, getRun, sessionRuns, lastRun, listRuns, listTasks, reapStaleRuns, updateTask,
  type Run, type Task, type TaskInput,
} from './db.ts';
import { request } from './ipc.ts';
import { DATA_DIR, runLogPaths, SOCKET_PATH } from './paths.ts';
import { Runner } from './runner.ts';
import { openRun } from './open.ts';
import { readTranscript, transcriptText } from './transcript.ts';
import { fmtDate, fmtDuration, nextRun, parseDuration, validateCron } from './util.ts';

const HELP = `taskgnome — planifie des prompts opencode

Usage:
  taskgnome add --name N --cron "0 9 * * 1-5" --dir DIR (--prompt P | --prompt-file F | --prompt -)
                [--model provider/model] [--agent A] [--timeout 30m] [--no-catch-up] [--disabled]
                [--direnv] [--env KEY=VAL ...]   (--env KEY= supprime, --clear-env vide tout)
  taskgnome edit <task> [mêmes options, + --enable/--disable, --catch-up/--no-catch-up, --no-direnv]
  taskgnome list                      tâches, prochaine exécution, dernier statut
  taskgnome show <task>               détail d'une tâche
  taskgnome rm <task>                 supprime la tâche et son historique
  taskgnome enable|disable <task>
  taskgnome run <task> [--foreground] lance maintenant (via le démon, sinon en avant-plan)
  taskgnome cancel <run>              annule un run en cours
  taskgnome history [<task>] [--failed] [--limit N]
  taskgnome logs <run> [--raw|--stderr|--transcript]  discussion d'un run (même en cours)
  taskgnome resume <run> [--print] [--terminal T]
                                      rouvre la session opencode du run dans un terminal
                                      (--print: affiche seulement la commande)
  taskgnome open <run>                ouvre la fenêtre de l'extension sur ce run
  taskgnome status                    état du démon, runs en cours, dernière erreur
  taskgnome daemon                    lance le planificateur (service systemd --user)
  taskgnome install                   installe le lien ~/.local/bin et le service systemd --user

<task> = id ou nom. Option globale: --json (sortie machine).
Cron: 5 champs (min h jdm mois jds), 6 avec secondes, ou @hourly/@daily/@weekly.
Les sessions opencode créées sont titrées "[task] <nom>".`;

const STATUS_ICON: Record<string, string> = {
  running: '⏳', success: '✓', error: '✗', auth_error: '🔑', timeout: '⌛', cancelled: '⏹',
};

class UsageError extends Error {}

function main(argv: string[]): Promise<number> | number {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      name: { type: 'string' },
      cron: { type: 'string' },
      dir: { type: 'string' },
      prompt: { type: 'string' },
      'prompt-file': { type: 'string' },
      model: { type: 'string' },
      agent: { type: 'string' },
      timeout: { type: 'string' },
      'catch-up': { type: 'boolean' },
      'no-catch-up': { type: 'boolean' },
      disabled: { type: 'boolean' },
      enable: { type: 'boolean' },
      disable: { type: 'boolean' },
      foreground: { type: 'boolean' },
      failed: { type: 'boolean' },
      limit: { type: 'string' },
      raw: { type: 'boolean' },
      stderr: { type: 'boolean' },
      transcript: { type: 'boolean' },
      env: { type: 'string', multiple: true },
      'clear-env': { type: 'boolean' },
      direnv: { type: 'boolean' },
      print: { type: 'boolean' },
      terminal: { type: 'string' },
      'no-direnv': { type: 'boolean' },
    },
  });
  const [cmd, ...args] = positionals;
  const json = !!o.json;
  const out = (data: unknown, human: () => void) => (json ? console.log(JSON.stringify(data, null, 2)) : human());

  if (!cmd || o.help || cmd === 'help') {
    console.log(HELP);
    return 0;
  }

  const needTask = (): Task => {
    if (!args[0]) throw new UsageError(`Usage: taskgnome ${cmd} <task>`);
    const t = findTask(args[0]);
    if (!t) throw new UsageError(`Tâche introuvable: ${args[0]}`);
    return t;
  };

  const readPrompt = (): string | undefined => {
    if (o['prompt-file']) return fs.readFileSync(o['prompt-file'], 'utf8');
    if (o.prompt === '-') return fs.readFileSync(0, 'utf8');
    return o.prompt;
  };

  const resolveDir = (d: string): string => {
    const abs = path.resolve(d.replace(/^~(?=$|\/)/, os.homedir()));
    if (!fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`Dossier inexistant: ${abs}`);
    return abs;
  };

  /** --env KEY=VAL (repeatable). `--env KEY=` removes KEY. */
  const buildEnv = (base: Record<string, string>): string | undefined => {
    if (!o.env && !o['clear-env']) return undefined;
    const env: Record<string, string> = o['clear-env'] ? {} : { ...base };
    for (const kv of o.env ?? []) {
      const i = kv.indexOf('=');
      const k = kv.slice(0, i).trim();
      if (i < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new UsageError(`Variable invalide: "${kv}" (attendu KEY=VALEUR)`);
      const v = kv.slice(i + 1);
      if (v === '') delete env[k];
      else env[k] = v;
    }
    return JSON.stringify(env);
  };

  switch (cmd) {
    case 'add': {
      const prompt = readPrompt();
      if (!o.name || !o.cron || !o.dir || !prompt?.trim()) throw new UsageError('add requiert --name, --cron, --dir et --prompt/--prompt-file');
      if (findTask(o.name)) throw new UsageError(`Une tâche "${o.name}" existe déjà`);
      if (/^\d+$/.test(o.name)) throw new UsageError('Le nom ne peut pas être purement numérique');
      validateCron(o.cron);
      const input: TaskInput = {
        name: o.name, cron: o.cron, dir: resolveDir(o.dir), prompt: prompt.trim(),
        model: o.model || null, agent: o.agent || null,
        timeout_sec: o.timeout ? parseDuration(o.timeout) : 1800,
        enabled: o.disabled ? 0 : 1, catch_up: o['no-catch-up'] ? 0 : 1,
        env: buildEnv({}) ?? '{}', direnv: o.direnv ? 1 : 0,
      };
      const t = createTask(input);
      out(taskView(t), () => console.log(`Tâche #${t.id} "${t.name}" créée. Prochaine exécution: ${fmtDate(nextRun(t.cron))}`));
      return 0;
    }

    case 'edit': {
      const t = needTask();
      const prompt = readPrompt();
      if (o.cron) validateCron(o.cron);
      if (o.name && o.name !== t.name && findTask(o.name)) throw new UsageError(`Une tâche "${o.name}" existe déjà`);
      const u = updateTask(t.id, {
        name: o.name, cron: o.cron, dir: o.dir ? resolveDir(o.dir) : undefined,
        prompt: prompt?.trim() || undefined,
        model: o.model === undefined ? undefined : o.model || null,
        agent: o.agent === undefined ? undefined : o.agent || null,
        timeout_sec: o.timeout ? parseDuration(o.timeout) : undefined,
        enabled: o.enable ? 1 : o.disable ? 0 : undefined,
        catch_up: o['catch-up'] ? 1 : o['no-catch-up'] ? 0 : undefined,
        env: buildEnv(JSON.parse(t.env || '{}')),
        direnv: o.direnv ? 1 : o['no-direnv'] ? 0 : undefined,
        // changing the schedule restarts it from now (no surprise immediate run)
        last_fire_at: o.cron || o.enable ? new Date().toISOString() : undefined,
      });
      out(taskView(u), () => console.log(`Tâche #${u.id} "${u.name}" mise à jour.`));
      return 0;
    }

    case 'enable':
    case 'disable': {
      const t = needTask();
      const u = updateTask(t.id, { enabled: cmd === 'enable' ? 1 : 0, last_fire_at: cmd === 'enable' ? new Date().toISOString() : undefined });
      out(taskView(u), () => console.log(`Tâche "${u.name}" ${u.enabled ? 'activée' : 'désactivée'}.`));
      return 0;
    }

    case 'rm': {
      const t = needTask();
      deleteTask(t.id);
      out({ ok: true, id: t.id }, () => console.log(`Tâche "${t.name}" supprimée.`));
      return 0;
    }

    case 'list': {
      const tasks = listTasks().map(taskView);
      out(tasks, () => {
        if (!tasks.length) return console.log('Aucune tâche. → taskgnome add --help');
        for (const t of tasks) {
          const st = t.last_run ? `${STATUS_ICON[t.last_run.status]} ${fmtDate(t.last_run.started_at)}` : '—';
          console.log(
            `${String(t.id).padStart(3)}  ${t.enabled ? '●' : '○'} ${t.name.padEnd(24)} ${t.cron.padEnd(16)} ` +
              `next: ${(t.enabled ? fmtDate(t.next_run) : 'désactivée').padEnd(18)} last: ${st}`,
          );
        }
      });
      return 0;
    }

    case 'show': {
      const t = taskView(needTask());
      out(t, () => {
        console.log(`#${t.id} ${t.name} ${t.enabled ? '' : '(désactivée)'}`);
        console.log(`  cron:     ${t.cron}  (prochaine: ${fmtDate(t.next_run)})`);
        console.log(`  dossier:  ${t.dir}`);
        console.log(`  modèle:   ${t.model ?? '(défaut)'}   agent: ${t.agent ?? '(défaut)'}`);
        console.log(`  timeout:  ${t.timeout_sec ? fmtDuration(t.timeout_sec * 1000) : 'aucun'}   rattrapage: ${t.catch_up ? 'oui' : 'non'}`);
        console.log(`  direnv:   ${t.direnv ? 'oui' : 'non'}   env: ${Object.keys(t.env).join(', ') || '(aucune)'}`);
        console.log(`  prompt:\n${t.prompt.replace(/^/gm, '    ')}`);
      });
      return 0;
    }

    case 'run':
      return cmdRun(needTask(), !!o.foreground, json);

    case 'cancel': {
      const id = Number(args[0]);
      return request({ cmd: 'cancel', run: id }).then((r) => {
        if (r?.ok) {
          out({ ok: true }, () => console.log(`Annulation du run #${id} demandée.`));
          return 0;
        }
        const run = getRun(id);
        if (run?.status === 'running' && run.pid) {
          // foreground run started by another CLI process
          process.kill(run.pid, 'SIGTERM');
          out({ ok: true }, () => console.log(`SIGTERM envoyé au processus ${run.pid}.`));
          return 0;
        }
        throw new UsageError(r?.error ?? `Run #${id} introuvable ou terminé`);
      });
    }

    case 'history': {
      const t = args[0] ? needTask() : undefined;
      const runs = listRuns({ taskId: t?.id, failed: !!o.failed, limit: o.limit ? Number(o.limit) : 20 });
      out(runs.map(runView), () => {
        if (!runs.length) return console.log('Aucun run.');
        for (const r of runs) {
          const dur = r.finished_at ? fmtDuration(Date.parse(r.finished_at) - Date.parse(r.started_at)) : 'en cours';
          const extra = r.status === 'success' ? '' : `  ${(r.error ?? '').split('\n')[0].slice(0, 80)}`;
          console.log(
            `${String(r.id).padStart(4)}  ${STATUS_ICON[r.status]} ${r.status.padEnd(10)} ${r.task_name.padEnd(24)} ` +
              `${fmtDate(r.started_at).padEnd(18)} ${dur.padEnd(8)} ${r.trigger}${extra}`,
          );
        }
      });
      return 0;
    }

    case 'logs': {
      const r = getRun(Number(args[0]));
      if (!r) throw new UsageError(`Run introuvable: ${args[0]}`);
      const p = runLogPaths(r.id);
      if (o.raw || o.stderr) {
        const f = o.stderr ? p.stderr : p.stdout;
        process.stdout.write(fs.existsSync(f) ? fs.readFileSync(f) : '');
        return 0;
      }
      const transcriptOf = (x: Run) =>
        readTranscript(runLogPaths(x.id).stdout, x.prompt ?? (x.trigger === 'interactive' ? null : findTask(x.task_id)?.prompt ?? null));
      const entries = transcriptOf(r);
      // the whole conversation: every run sharing this opencode session (scheduled + messages sent from a terminal)
      const session = r.session_id ? sessionRuns(r.session_id) : [r];
      const extra = o.transcript
        ? { transcript: entries, session_runs: session.map((x) => ({ ...runView(x), transcript: transcriptOf(x) })) }
        : {};
      out({ ...runView(r), output: r.output, logs: p, ...extra }, () => {
        console.log(`Run #${r.id} — ${r.task_name} — ${STATUS_ICON[r.status]} ${r.status} — ${fmtDate(r.started_at)} (${r.trigger})`);
        if (r.session_id) console.log(`Session opencode: ${r.session_id}`);
        if (r.cost) console.log(`Coût: $${r.cost.toFixed(4)}  tokens: ${r.tokens}`);
        if (r.error) console.log(`\n--- erreur ---\n${r.error}`);
        console.log(`\n--- discussion ---\n${transcriptText(entries)}`);
        if (r.status === 'running') console.log('\n⏳ en cours…');
      });
      return 0;
    }

    case 'open': {
      const r = getRun(Number(args[0]));
      if (!r) throw new UsageError(`Run introuvable: ${args[0]}`);
      return openRun(r.id).then(() => {
        out({ ok: true }, () => console.log(`Fenêtre ouverte sur le run #${r.id}`));
        return 0;
      });
    }

    case 'overview':
      // everything the GNOME extension needs, in a single call
      return request({ cmd: 'ping' }, 1000).then((pong) => {
        console.log(JSON.stringify({
          daemon: pong ? { pid: pong.pid } : null,
          tasks: listTasks().map(taskView),
          runs: listRuns({ limit: o.limit ? Number(o.limit) : 8 }).map(runView),
        }));
        return 0;
      });

    case 'resume': {
      const r = getRun(Number(args[0]));
      if (!r) throw new UsageError(`Run introuvable: ${args[0]}`);
      // the daemon hosts the session on an opencode server; the terminal is only a client,
      // so the work continues (and is followed) even if the terminal is closed.
      return request({ cmd: 'attach', run: r.id }, 200_000).then((a) => {
        if (!a) throw new UsageError('Démon injoignable: lance-le (systemctl --user start taskgnome)');
        if (!a.ok) throw new UsageError(a.error);
        const command = `cd ${shq(a.dir)} && OPENCODE_SERVER_PASSWORD=${shq(a.password)} opencode attach ${a.url} --dir ${shq(a.dir)} -s ${a.session}`;
        if (o.print) {
          out({ command, session_id: a.session, dir: a.dir, url: a.url }, () => console.log(command));
          return 0;
        }
        const term = openTerminal(command, o.terminal);
        out({ ok: true, command, terminal: term }, () => console.log(`Ouvert dans ${term}: ${command}`));
        return 0;
      });
    }

    case 'status':
      return request({ cmd: 'ping' }).then((pong) => {
        const running = listRuns({ limit: 50 }).filter((r) => r.status === 'running').map(runView);
        const lastFail = listRuns({ failed: true, limit: 1 })[0];
        const data = { daemon: pong ? { pid: pong.pid, servers: pong.servers } : null, running, last_failure: lastFail ? runView(lastFail) : null };
        out(data, () => {
          console.log(pong ? `Démon actif (pid ${pong.pid})` : `Démon arrêté (socket ${SOCKET_PATH} injoignable)`);
          console.log(`Données: ${DATA_DIR}`);
          console.log(running.length ? `En cours: ${running.map((r) => `#${r.id} ${r.task_name}`).join(', ')}` : 'Aucun run en cours');
          for (const sv of pong?.servers ?? []) console.log(`Serveur opencode: ${sv.url}  ${sv.dir}  (${sv.clients} terminal(aux) attaché(s))`);
          if (lastFail) console.log(`Dernier échec: #${lastFail.id} ${lastFail.task_name} ${lastFail.status} ${fmtDate(lastFail.started_at)}`);
        });
        return 0;
      });

    case 'daemon':
      return import('./daemon.ts').then((m) => m.runDaemon()).then(() => new Promise<number>(() => {}));

    case 'install':
      return install();

    default:
      throw new UsageError(`Commande inconnue: ${cmd}\n\n${HELP}`);
  }
}

async function cmdRun(t: Task, foreground: boolean, json: boolean): Promise<number> {
  if (!foreground) {
    const r = await request({ cmd: 'run', task: t.id });
    if (r) {
      if (!r.ok) throw new UsageError(r.error);
      if (json) console.log(JSON.stringify({ ok: true, run: r.run }));
      else console.log(`Run #${r.run} lancé par le démon. Suivi: taskgnome logs ${r.run}`);
      return 0;
    }
    if (!json) console.error('Démon injoignable, exécution en avant-plan…');
  }
  reapStaleRuns();
  const cur = lastRun(t.id);
  if (cur?.status === 'running') throw new UsageError(`La tâche tourne déjà (run #${cur.id})`);
  const runner = new Runner();
  const s = runner.start(t, 'manual');
  if (!json) console.error(`Run #${s.run.id} en cours…`);
  const onSig = () => runner.cancel(s.run.id);
  process.on('SIGINT', onSig).on('SIGTERM', onSig);
  const fin = await s.done;
  runner.pool.stopAll();
  setTimeout(() => process.exit(fin.status === 'success' ? 0 : 1), 300).unref();
  if (json) console.log(JSON.stringify(runView(fin), null, 2));
  else {
    console.log(`${STATUS_ICON[fin.status]} ${fin.status}`);
    if (fin.error) console.log(fin.error);
    if (fin.output) console.log(`\n${fin.output}`);
  }
  return fin.status === 'success' ? 0 : 1;
}

const shq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** terminal -> argv prefix that runs the following program + args */
const TERMINALS: Record<string, string[]> = {
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

function which(bin: string): boolean {
  return (process.env.PATH ?? '').split(':').some((d) => d && fs.existsSync(path.join(d, bin)));
}

/**
 * Opens a terminal running `command` in an interactive login shell, then leaves the shell open.
 * Terminal: --terminal, else $TASKGNOME_TERMINAL, else first one found.
 */
function openTerminal(command: string, wanted?: string): string {
  const pref = wanted ?? process.env.TASKGNOME_TERMINAL;
  const name = pref ?? Object.keys(TERMINALS).find(which);
  if (!name) throw new Error('Aucun terminal trouvé (option --terminal ou variable TASKGNOME_TERMINAL)');
  const prefix = TERMINALS[name] ?? [name, '-e'];
  const shell = process.env.SHELL || '/bin/sh';
  const child = spawn(prefix[0], [...prefix.slice(1), shell, '-ic', `${command}; exec ${shq(shell)} -i`], {
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', () => {});
  child.unref();
  return name;
}

function taskView(t: Task) {
  const last = lastRun(t.id);
  return {
    ...t,
    enabled: !!t.enabled,
    catch_up: !!t.catch_up,
    direnv: !!t.direnv,
    env: JSON.parse(t.env || '{}') as Record<string, string>,
    next_run: t.enabled ? (nextRun(t.cron)?.toISOString() ?? null) : null,
    last_run: last ? runView(last) : null,
  };
}

function runView(r: Run) {
  const { output: _o, ...rest } = r;
  return {
    ...rest,
    duration_ms: r.finished_at ? Date.parse(r.finished_at) - Date.parse(r.started_at) : null,
  };
}

function install(): number {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cliPath = path.join(root, 'src', 'cli.ts');
  const binDir = path.join(os.homedir(), '.local', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const wrapper = path.join(binDir, 'taskgnome');
  fs.rmSync(wrapper, { force: true });
  // absolute node path: gnome-shell (extension) and systemd do not share the login shell PATH.
  // PATH is preserved so that opencode is found when running in the foreground.
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh\nexport PATH="\${PATH:+$PATH:}${process.env.PATH}"\nexec ${process.execPath} --disable-warning=ExperimentalWarning ${cliPath} "$@"\n`,
    { mode: 0o755 },
  );
  console.log(`CLI: ${wrapper}`);

  const uuid = 'taskgnome@maarek';
  const extDir = path.join(os.homedir(), '.local', 'share', 'gnome-shell', 'extensions');
  fs.mkdirSync(extDir, { recursive: true });
  const extLink = path.join(extDir, uuid);
  fs.rmSync(extLink, { force: true, recursive: false });
  fs.symlinkSync(path.join(root, 'extension'), extLink);
  console.log(`Extension: ${extLink}`);
  try {
    execFileSync('gnome-extensions', ['enable', uuid], { stdio: 'ignore' });
    console.log('Extension activée.');
  } catch {
    console.log(`→ Wayland: déconnecte/reconnecte ta session, puis: gnome-extensions enable ${uuid}`);
  }

  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  fs.mkdirSync(unitDir, { recursive: true });
  const unit = `[Unit]
Description=taskgnome — planificateur de prompts opencode
After=graphical-session.target

[Service]
ExecStart=${process.execPath} --disable-warning=ExperimentalWarning ${cliPath} daemon
Environment=PATH=${process.env.PATH}
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
  console.log('Service taskgnome.service activé. Logs: journalctl --user -u taskgnome -f');
  if (!(process.env.PATH ?? '').split(':').includes(binDir)) console.log(`⚠ ${binDir} n'est pas dans ton PATH.`);
  return 0;
}

try {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
} catch (e) {
  const json = process.argv.includes('--json');
  const msg = (e as Error).message;
  if (json) console.log(JSON.stringify({ ok: false, error: msg }));
  else console.error(`Erreur: ${msg}`);
  process.exitCode = e instanceof UsageError ? 2 : 1;
}
