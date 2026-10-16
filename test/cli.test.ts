// The CLI as a process: --json outputs must match the contract read by the GNOME extension.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type * as z from 'zod/mini';
import { Failure, History, Overview, RunLogs, TaskView, TerminalInfo } from '../src/shared/api.ts';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskgnome-cli-'));
const main = path.join(import.meta.dirname, '..', 'src', 'main.ts');
const env = { ...process.env, TASKGNOME_TERMINAL: '', TASKGNOME_CONFIG: path.join(dataDir, 'config.json'), TASKGNOME_DATA_DIR: dataDir, TASKGNOME_SOCKET: path.join(dataDir, 'none.sock'), TASKGNOME_NO_NOTIFY: '1' };

function cli(args: string[], input?: string): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', main, ...args], { env, input, encoding: 'utf8' });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

function json<T>(schema: z.ZodMiniType<T>, args: string[], input?: string): T {
  const r = cli([...args, '--json'], input);
  assert.equal(r.code, 0, r.out + r.err);
  return schema.parse(JSON.parse(r.out));
}

describe('CLI --json (contrat avec l\'extension)', () => {
  after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('add / edit / show', () => {
    const t = json(TaskView, ['add', '--name=t', '--cron=0 9 * * 1-5', `--dir=${dataDir}`, '--env=A=1', '--model=', '--prompt=-'], 'le prompt\n');
    assert.equal(t.prompt, 'le prompt');
    assert.equal(t.model, null);
    assert.deepEqual(t.env, { A: '1' });
    const e = json(TaskView, ['edit', 't', '--model=anthropic/x', '--no-enabled', '--clear-env', '--env=B=2']);
    assert.deepEqual([e.model, e.enabled, e.env], ['anthropic/x', false, { B: '2' }]);
    assert.equal(json(TaskView, ['show', String(t.id)]).name, 't');
  });

  it('overview et history (démon arrêté)', () => {
    const o = json(Overview, ['overview']);
    assert.equal(o.daemon, null);
    assert.equal(o.tasks.length, 1);
    assert.deepEqual(json(History, ['history']), []);
  });

  it('logs d\'un run (base remplie directement)', () => {
    // a finished run, written like the runner does
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
      const db = await import(${JSON.stringify(path.join(import.meta.dirname, '..', 'src', 'db.ts'))});
      const t = db.findTask('t');
      const r = db.createRun(t, 'manual', 'p');
      db.finishRun(r.id, { status: 'success', exit_code: null, session_id: 'ses_x', error: null, output: 'ok', cost: null, tokens: null });
    `], { env });
    const l = json(RunLogs, ['logs', '1', '--transcript']);
    assert.equal(l.status, 'success');
    assert.deepEqual(l.session_runs.map((r) => r.id), [1]);
  });

  it('erreurs : une ligne {ok:false} sur stdout, code 2', () => {
    for (const args of [['show', '99'], ['add', '--cron=@daily'], ['nope'], ['history', '--limit=0']]) {
      const r = cli([...args, '--json']);
      assert.equal(r.code, 2, args.join(' '));
      const f = Failure.parse(JSON.parse(r.out));
      assert.notEqual(f.error, '');
    }
  });

  it('réglage du terminal : réglé, puis retour à l\'automatique', () => {
    const set = json(TerminalInfo, ['terminal', '--set', 'mon-terminal']);
    assert.deepEqual([set.current, set.source, set.configured], ['mon-terminal', 'config', 'mon-terminal']);
    const auto = json(TerminalInfo, ['terminal', '--auto']);
    assert.equal(auto.configured, null);
    assert.equal(auto.source, 'auto');
  });

  it('erreurs en français sans --json', () => {
    const r = cli(['show', '99']);
    assert.equal(r.code, 2);
    assert.equal(r.err.trim(), 'Erreur: Tâche introuvable: 99');
  });
});
