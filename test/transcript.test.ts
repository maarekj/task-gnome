import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { readTranscript } from '../src/transcript.ts';

it('reconstruit la discussion depuis un journal de run (même incomplet)', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-')), 'run.jsonl');
  const lines = [
    { type: 'tool_use', part: { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'running', input: { command: 'ls' } } } },
    { type: 'tool_use', part: { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', input: { command: 'ls' }, output: 'a\nb', title: 'ls' } } },
    { type: 'text', part: { type: 'text', text: 'Fini' } },
    { type: 'error', error: { name: 'UnknownError', data: { message: 'boom' } } },
    { type: 'ignored' },
  ];
  // last line truncated, as while the run is still writing
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n{"type":"te`);
  assert.deepEqual(readTranscript(file, 'Le prompt'), [
    { kind: 'prompt', text: 'Le prompt' },
    { kind: 'tool', id: 'c1', tool: 'bash', title: 'ls', status: 'completed', input: 'ls', output: 'a\nb' },
    { kind: 'text', text: 'Fini' },
    { kind: 'error', text: 'UnknownError: boom' },
  ]);
});
