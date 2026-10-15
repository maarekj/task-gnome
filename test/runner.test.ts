// Integration: the real Runner / ServerPool against a fake `opencode serve` (test/fake-opencode).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskgnome-test-'));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskgnome-work-'));
// before importing the modules: paths and options are read at import time
process.env['TASKGNOME_DATA_DIR'] = dataDir;
process.env['TASKGNOME_NO_NOTIFY'] = '1';
process.env['PATH'] = `${path.join(import.meta.dirname, 'fake-opencode')}:${process.env['PATH'] ?? ''}`;

const db = await import('../src/db.ts');
const { Runner } = await import('../src/runner.ts');
const { newTaskInput } = await import('../src/cli/ops.ts');
const { sessionOf } = await import('../src/cli/ops.ts');

const runner = new Runner();
const addTask = (name: string, prompt: string, timeout_sec = 30): ReturnType<typeof db.createTask> =>
  db.createTask(newTaskInput({ name, cron: '@yearly', dir: workDir, prompt, timeout_sec }));

describe('Runner (faux serveur opencode)', () => {
  before(() => {
    // logs of the runner are noise in test output
    console.log = (): void => undefined;
  });
  after(() => {
    runner.pool.stopAll();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('run réussi : statut, sortie, coût, discussion', async () => {
    const t = addTask('ok', 'bonjour');
    const fin = await runner.start(t, 'manual').done;
    assert.equal(fin.status, 'success');
    assert.equal(fin.output, 'réponse à: bonjour');
    assert.equal(fin.cost, 0.01);
    assert.equal(fin.tokens, 100);
    assert.match(fin.session_id ?? '', /^ses_/u);
    const [view] = sessionOf(fin);
    assert.deepEqual(view?.transcript.map((e) => e.kind), ['prompt', 'tool', 'text']);
  });

  it('token expiré -> auth_error', async () => {
    const fin = await runner.start(addTask('auth', 'auth please'), 'manual').done;
    assert.equal(fin.status, 'auth_error');
    assert.match(fin.error ?? '', /ProviderAuthError/u);
  });

  it('timeout -> annulation de la session', async () => {
    const fin = await runner.start(addTask('slow', 'slow', 1), 'manual').done;
    assert.equal(fin.status, 'timeout');
  });

  it('annulation', async () => {
    const s = runner.start(addTask('cancel', 'slow'), 'manual');
    setTimeout(() => {
      runner.cancel(s.run.id);
    }, 300);
    assert.equal((await s.done).status, 'cancelled');
  });

  it('message envoyé depuis un terminal attaché -> nouveau run interactif dans la même session', async () => {
    const first = await runner.start(addTask('interactive', 'premier'), 'manual').done;
    const a = await runner.attach(first);
    // what `opencode attach` does when the user sends a message
    const res = await fetch(`${a.url}/session/${a.session}/prompt_async`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`opencode:${a.password}`).toString('base64')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'second' }] }),
    });
    assert.equal(res.status, 204);
    // the run is created by the event stream: wait for it
    let runs = db.sessionRuns(a.session);
    for (let i = 0; i < 50 && (runs.length < 2 || runs.at(-1)?.status === 'running'); i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- polling
      await new Promise((r) => {
        setTimeout(r, 50);
      });
      runs = db.sessionRuns(a.session);
    }
    const second = runs.at(-1);
    assert.equal(runs.length, 2);
    assert.equal(second?.trigger, 'interactive');
    assert.equal(second?.status, 'success');
    assert.equal(second?.prompt, 'second');
  });

  it('un seul serveur par dossier', () => {
    assert.equal(runner.pool.list().length, 1);
  });
});
