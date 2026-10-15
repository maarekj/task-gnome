import fs from 'node:fs';
import { z } from 'zod';
import { errorText, LogLine, type Part } from './opencode.ts';
import { assertNever } from './util.ts';

import type { Entry } from './shared/api.ts';

export type { Entry };

type ToolEntry = Extract<Entry, { kind: 'tool' }>;

const MAX_OUTPUT = 6000;
const MAX_INPUT = 2000;
const clip = (s: string, n = MAX_OUTPUT): string => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} caractères de plus)` : s);

const str = z.string().catch('');
const BashInput = z.object({ command: str });
const FileInput = z.object({ filePath: str });
const SearchInput = z.object({ pattern: str, path: str });
const TaskInput = z.object({ description: str, prompt: str });
const TodoInput = z.object({ todos: z.array(z.object({ content: str, status: str })).catch([]) });
const UrlInput = z.object({ url: str });

const TODO_ICON: Record<string, string> = { completed: '☑', in_progress: '▶' };

/** Short human description of a tool input. */
function describeInput(tool: string, input: unknown): string {
  if (input === null || typeof input !== 'object') return '';
  const pick = <T>(schema: z.ZodType<T>, f: (v: T) => string): string => {
    const r = schema.safeParse(input);
    return r.success ? f(r.data) : JSON.stringify(input, null, 2);
  };
  switch (tool) {
    case 'bash':
      return pick(BashInput, (i) => i.command);
    case 'read':
    case 'write':
    case 'edit':
      return pick(FileInput, (i) => i.filePath);
    case 'grep':
    case 'glob':
      return pick(SearchInput, (i) => [i.pattern, i.path].filter((s) => s !== '').join('  in  '));
    case 'task':
      return pick(TaskInput, (i) => `${i.description}\n\n${i.prompt}`.trim());
    case 'todowrite':
      return pick(TodoInput, (i) => i.todos.map((t) => `${TODO_ICON[t.status] ?? '☐'} ${t.content}`).join('\n'));
    case 'webfetch':
      return pick(UrlInput, (i) => i.url);
    default:
      return JSON.stringify(input, null, 2);
  }
}

const asText = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
};

function toolEntry(p: Part): ToolEntry {
  const s = p.state;
  const tool = p.tool ?? '?';
  return {
    kind: 'tool',
    id: p.callID ?? p.id ?? '',
    tool,
    title: s?.title ?? '',
    status: s?.status ?? '?',
    input: clip(describeInput(tool, s?.input), MAX_INPUT),
    output: clip(asText(s?.error ?? s?.output)),
  };
}

function parseLine(line: string): LogLine | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null; // partial last line while running
  }
  const r = LogLine.safeParse(raw);
  return r.success ? r.data : null;
}

/** Rebuilds the conversation from a run log (works while the run is in progress). */
export function readTranscript(file: string, prompt: string | null): Entry[] {
  const entries: Entry[] = [];
  if (prompt !== null && prompt !== '') entries.push({ kind: 'prompt', text: prompt });
  if (!fs.existsSync(file)) return entries;
  const tools = new Map<string, ToolEntry>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const ev = parseLine(line);
    if (ev === null) continue;
    switch (ev.type) {
      case 'text':
      case 'reasoning':
        if (ev.part.text !== undefined && ev.part.text !== '') entries.push({ kind: ev.type, text: ev.part.text });
        break;
      case 'tool_use': {
        const e = toolEntry(ev.part);
        const prev = tools.get(e.id);
        if (prev === undefined) {
          tools.set(e.id, e);
          entries.push(e);
        } else Object.assign(prev, e);
        break;
      }
      case 'error':
        entries.push({ kind: 'error', text: errorText(ev.error) });
        break;
      case 'step_finish':
      case 'step_start':
        break;
    }
  }
  return entries;
}

const TOOL_ICON: Record<string, string> = { completed: '✓', error: '✗' };

/** Plain-text rendering, for the terminal. */
export function transcriptText(entries: Entry[]): string {
  return entries
    .map((e) => {
      switch (e.kind) {
        case 'prompt':
          return `▌ PROMPT\n${e.text}`;
        case 'text':
          return `▌ ASSISTANT\n${e.text}`;
        case 'reasoning':
          return `  (réflexion) ${e.text.slice(0, 400)}`;
        case 'tool': {
          const head = (e.title === '' ? (e.input.split('\n')[0] ?? '') : e.title).slice(0, 140);
          const err = e.status === 'error' ? `\n    ${e.output.split('\n')[0] ?? ''}` : '';
          return `  ${TOOL_ICON[e.status] ?? '⏳'} ${e.tool}  ${head}${err}`;
        }
        case 'error':
          return `✗ ${e.text}`;
        default:
          return assertNever(e);
      }
    })
    .join('\n\n');
}
