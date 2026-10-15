// Markdown -> Gtk widgets (blocks from src/shared/markdown.ts).
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import { jsx } from 'gnim';
import { parseMarkdown, type Block } from '../../../src/shared/markdown.ts';

/** Selectable, wrapping label with Pango markup (falls back to plain text on invalid markup). */
export function MarkupLabel({ markup, css = [] }: { markup: string; css?: string[] }): Gtk.Label {
  const l = jsx(Gtk.Label, {
    wrap: true,
    wrapMode: Pango.WrapMode.WORD_CHAR,
    xalign: 0,
    selectable: true,
    useMarkup: true,
    cssClasses: css,
  });
  try {
    l.set_markup(markup);
  } catch {
    l.set_text(markup);
  }
  return l;
}

function CodeBlock({ text }: { text: string }): Gtk.Frame {
  return jsx(Gtk.Frame, {
    child: jsx(Gtk.Label, {
      label: text,
      xalign: 0,
      selectable: true,
      wrap: true,
      wrapMode: Pango.WrapMode.CHAR,
      cssClasses: ['monospace'],
      marginTop: 8,
      marginBottom: 8,
      marginStart: 12,
      marginEnd: 12,
    }),
  });
}

function Table({ header, rows }: { header: string[]; rows: string[][] }): Gtk.ScrolledWindow {
  const grid = jsx(Gtk.Grid, { columnSpacing: 18, rowSpacing: 6, marginTop: 8, marginBottom: 8, marginStart: 12, marginEnd: 12 });
  [header, ...rows].forEach((row, y) => {
    row.forEach((cell, x) => {
      const l = MarkupLabel({ markup: y === 0 ? `<b>${cell}</b>` : cell });
      l.maxWidthChars = 50;
      grid.attach(l, x, y, 1, 1);
    });
  });
  return jsx(Gtk.ScrolledWindow, { child: grid, vscrollbarPolicy: Gtk.PolicyType.NEVER, propagateNaturalHeight: true, cssClasses: ['card'] });
}

const HEADING_CSS: Readonly<Record<number, string>> = { 1: 'title-2', 2: 'title-3' };

function renderBlock(b: Block): Gtk.Widget {
  switch (b.kind) {
    case 'paragraph':
      return MarkupLabel({ markup: b.markup });
    case 'heading': {
      const l = MarkupLabel({ markup: b.markup, css: [HEADING_CSS[b.level] ?? 'heading'] });
      l.marginTop = 6;
      return l;
    }
    case 'item':
      return (
        jsx(Gtk.Box, {
          spacing: 8,
          marginStart: 6 + b.depth * 18,
          children: [
            jsx(Gtk.Label, { label: b.bullet, valign: Gtk.Align.START, widthChars: 3, xalign: 1, cssClasses: ['dim-label'] }),
            Object.assign(MarkupLabel({ markup: b.markup }), { hexpand: true }),
          ],
        })
      );
    case 'quote':
      return jsx(Gtk.Box, {
        spacing: 10,
        children: [jsx(Gtk.Separator, { orientation: Gtk.Orientation.VERTICAL }), MarkupLabel({ markup: `<i>${b.markup}</i>`, css: ['dim-label'] })],
      });
    case 'code':
      return CodeBlock({ text: b.text });
    case 'table':
      return Table({ header: b.header, rows: b.rows });
    case 'rule':
      return jsx(Gtk.Separator, { marginTop: 4, marginBottom: 4 });
    default:
      return assertNever(b);
  }
}

function assertNever(value: never): never {
  throw new Error(`Bloc inattendu: ${JSON.stringify(value)}`);
}

export function Markdown({ text }: { text: string }): Gtk.Box {
  return jsx(Gtk.Box, {
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 8,
    children: parseMarkdown(text).map((b) => renderBlock(b)),
  });
}
