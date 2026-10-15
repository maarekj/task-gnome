import fs from 'node:fs';

export type Entry =
  | { kind: 'prompt'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; id: string; tool: string; title: string; status: string; input: string; output: string }
  | { kind: 'error'; text: string };

const MAX_OUTPUT = 6000;
const clip = (s: string, n = MAX_OUTPUT) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} caractères de plus)` : s);

/** Short human description of a tool input. */
function describeInput(tool: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  switch (tool) {
    case 'bash':
      return input.command ?? '';
    case 'read':
    case 'write':
    case 'edit':
      return input.filePath ?? '';
    case 'grep':
    case 'glob':
      return [input.pattern, input.path].filter(Boolean).join('  in  ');
    case 'task':
      return `${input.description ?? ''}\n\n${input.prompt ?? ''}`.trim();
    case 'todowrite':
      return (input.todos ?? []).map((t: any) => `${t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▶' : '☐'} ${t.content}`).join('\n');
    case 'webfetch':
      return input.url ?? '';
    default:
      return JSON.stringify(input, null, 2);
  }
}

/** Rebuilds the conversation from the `opencode run --format json` event stream (works while running). */
export function readTranscript(file: string, prompt: string | null): Entry[] {
  const entries: Entry[] = [];
  if (prompt) entries.push({ kind: 'prompt', text: prompt });
  if (!fs.existsSync(file)) return entries;
  const tools = new Map<string, Entry & { kind: 'tool' }>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // partial last line while running
    }
    const p = ev.part ?? {};
    if (ev.type === 'text' && p.text) entries.push({ kind: 'text', text: p.text });
    else if (ev.type === 'reasoning' && p.text) entries.push({ kind: 'reasoning', text: p.text });
    else if (ev.type === 'tool_use') {
      const s = p.state ?? {};
      const id = p.callID ?? p.id;
      const e = {
        kind: 'tool' as const,
        id,
        tool: p.tool ?? '?',
        title: s.title ?? '',
        status: s.status ?? '?',
        input: clip(describeInput(p.tool, s.input), 2000),
        output: clip(String(s.error ?? s.output ?? '')),
      };
      const prev = tools.get(id);
      if (prev) Object.assign(prev, e);
      else {
        tools.set(id, e);
        entries.push(e);
      }
    } else if (ev.type === 'error') {
      const er = ev.error ?? {};
      entries.push({ kind: 'error', text: `${er.name ?? 'Error'}: ${er.data?.message ?? er.message ?? ''}` });
    }
  }
  return entries;
}

/** Plain-text rendering, for the terminal and the GNOME Shell dialog. */
export function transcriptText(entries: Entry[]): string {
  const out: string[] = [];
  for (const e of entries) {
    switch (e.kind) {
      case 'prompt':
        out.push(`▌ PROMPT\n${e.text}`);
        break;
      case 'text':
        out.push(`▌ ASSISTANT\n${e.text}`);
        break;
      case 'reasoning':
        out.push(`  (réflexion) ${e.text.slice(0, 400)}`);
        break;
      case 'tool': {
        const icon = e.status === 'completed' ? '✓' : e.status === 'error' ? '✗' : '⏳';
        const head = (e.title || e.input.split('\n')[0]).slice(0, 140);
        out.push(`  ${icon} ${e.tool}  ${head}` + (e.status === 'error' ? `\n    ${e.output.split('\n')[0]}` : ''));
        break;
      }
      case 'error':
        out.push(`✗ ${e.text}`);
        break;
    }
  }
  return out.join('\n\n');
}
