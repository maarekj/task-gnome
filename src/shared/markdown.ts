// Minimal Markdown parser: blocks + inline styles as Pango markup. Pure (no GTK, no Node).

export type Block =
  | { kind: 'paragraph'; markup: string }
  | { kind: 'heading'; level: number; markup: string }
  | { kind: 'item'; depth: number; bullet: string; markup: string }
  | { kind: 'quote'; markup: string }
  | { kind: 'code'; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'rule' };

/** Escapes text for Pango markup. */
export const escapeMarkup = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/** Private-use character marking protected code spans (must not be a NUL: GLib strings stop there). */
const MARK = '\uE000';

/** Inline markdown -> Pango markup. */
export function inline(src: string): string {
  const codes: string[] = [];
  let s = src.replaceAll(/`([^`]+)`/gu, (_m, code: string) => {
    codes.push(code);
    return `${MARK}${codes.length - 1}${MARK}`;
  });
  s = escapeMarkup(s);
  s = s.replaceAll(/\[([^\]]+)\]\(([^)\s]+)\)/gu, (_m, text: string, url: string) => `<a href="${url}">${text}</a>`);
  s = s.replaceAll(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)])/gu, (_m, pre: string, url: string) => `${pre}<a href="${url}">${url}</a>`);
  s = s.replaceAll(/\*\*(.+?)\*\*/gu, '<b>$1</b>').replaceAll(/__(.+?)__/gu, '<b>$1</b>');
  s = s.replaceAll(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/gu, '$1<i>$2</i>');
  s = s.replaceAll(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/gu, '$1<i>$2</i>');
  s = s.replaceAll(/~~(.+?)~~/gu, '<s>$1</s>');
  return s.replaceAll(new RegExp(`${MARK}(\\d+)${MARK}`, 'gu'), (_m, i: string) => `<tt>${escapeMarkup(codes[Number(i)] ?? '')}</tt>`);
}

const TABLE_ROW = /^\s*\|.*\|\s*$/u;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}/u;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/u;
const LIST_START = /^\s*(?:[-*+]|\d+[.)])\s/u;

const cells = (row: string): string[] =>
  row.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((c) => inline(c.trim()));

export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  let para: string[] = [];
  const flush = (): void => {
    if (para.length > 0) blocks.push({ kind: 'paragraph', markup: inline(para.join('\n')) });
    para = [];
  };
  const at = (i: number): string => lines[i] ?? '';

  for (let i = 0; i < lines.length; i += 1) {
    const line = at(i);
    let m: RegExpExecArray | null;
    if ((m = /^\s*(```|~~~)/u.exec(line)) !== null) {
      flush();
      const fence = m[1] ?? '```';
      const code: string[] = [];
      while (i + 1 < lines.length && !at(i + 1).trim().startsWith(fence)) {
        i += 1;
        code.push(at(i));
      }
      i += 1; // closing fence
      blocks.push({ kind: 'code', text: code.join('\n') });
    } else if (TABLE_ROW.test(line)) {
      flush();
      const rows = [line];
      while (i + 1 < lines.length && TABLE_ROW.test(at(i + 1))) {
        i += 1;
        rows.push(at(i));
      }
      const [header = [], ...body] = rows.filter((r) => !TABLE_SEPARATOR.test(r)).map((r) => cells(r));
      blocks.push({ kind: 'table', header, rows: body });
    } else if ((m = /^(#{1,6})\s+(.*)$/u.exec(line)) !== null) {
      flush();
      blocks.push({ kind: 'heading', level: (m[1] ?? '#').length, markup: inline((m[2] ?? '').replace(/\s#+\s*$/u, '')) });
    } else if (/^\s*([-*_])(?:\s*\1){2,}\s*$/u.test(line)) {
      flush();
      blocks.push({ kind: 'rule' });
    } else if ((m = LIST_ITEM.exec(line)) !== null) {
      flush();
      const depth = Math.floor((m[1] ?? '').replaceAll('\t', '  ').length / 2);
      const marker = m[2] ?? '-';
      const check = m[3];
      let bullet = /\d/u.test(marker) ? marker : depth > 0 ? '◦' : '•';
      if (check !== undefined) bullet = /x/iu.test(check) ? '☑' : '☐';
      let content = m[4] ?? '';
      // continuation lines of the same item
      while (i + 1 < lines.length && /^\s{2,}\S/u.test(at(i + 1)) && !LIST_START.test(at(i + 1))) {
        i += 1;
        content += ` ${at(i).trim()}`;
      }
      blocks.push({ kind: 'item', depth, bullet, markup: inline(content) });
    } else if ((m = /^\s*>\s?(.*)$/u.exec(line)) !== null) {
      flush();
      const quote = [m[1] ?? ''];
      while (i + 1 < lines.length && /^\s*>/u.test(at(i + 1))) {
        i += 1;
        quote.push(at(i).replace(/^\s*>\s?/u, ''));
      }
      blocks.push({ kind: 'quote', markup: inline(quote.join(' ')) });
    } else if (line.trim() === '') {
      flush();
    } else {
      para.push(line.trim());
    }
  }
  flush();
  return blocks;
}
