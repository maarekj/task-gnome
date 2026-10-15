// Markdown -> Gtk widgets (blocks from src/shared/markdown.ts).
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import { parseMarkdown, type Block } from '../../../src/shared/markdown.ts';

/** Sets Pango markup, falling back to plain text if the markup is invalid. */
function setMarkup(label: Gtk.Label, markup: string): void {
  try {
    label.set_markup(markup);
  } catch {
    label.set_text(markup);
  }
}

/** Selectable, wrapping label rendering Pango markup. */
export function MarkupLabel({ markup, css = [], hexpand = false }: { markup: string; css?: string[]; hexpand?: boolean }): JSX.Element {
  return (
    <Gtk.Label
      wrap
      wrapMode={Pango.WrapMode.WORD_CHAR}
      xalign={0}
      selectable
      useMarkup
      hexpand={hexpand}
      cssClasses={css}
      maxWidthChars={-1}
      $={(self) => {
        setMarkup(self, markup);
      }}
    />
  );
}

function Table({ header, rows }: { header: string[]; rows: string[][] }): JSX.Element {
  return (
    <Gtk.ScrolledWindow vscrollbarPolicy={Gtk.PolicyType.NEVER} propagateNaturalHeight cssClasses={['card']}>
      <Gtk.Grid
        columnSpacing={18}
        rowSpacing={6}
        marginTop={8}
        marginBottom={8}
        marginStart={12}
        marginEnd={12}
        $={(grid) => {
          // Gtk.Grid places children by coordinates: attached here
          [header, ...rows].forEach((row, y) => {
            row.forEach((cell, x) => {
              const label = new Gtk.Label({ wrap: true, wrapMode: Pango.WrapMode.WORD_CHAR, xalign: 0, selectable: true, maxWidthChars: 50 });
              setMarkup(label, y === 0 ? `<b>${cell}</b>` : cell);
              grid.attach(label, x, y, 1, 1);
            });
          });
        }}
      />
    </Gtk.ScrolledWindow>
  );
}

const HEADING_CSS: Readonly<Record<number, string>> = { 1: 'title-2', 2: 'title-3' };

function assertNever(value: never): never {
  throw new Error(`Bloc inattendu: ${JSON.stringify(value)}`);
}

function BlockView({ block: b }: { block: Block }): JSX.Element {
  switch (b.kind) {
    case 'paragraph':
      return <MarkupLabel markup={b.markup} />;
    case 'heading':
      return (
        <Gtk.Box marginTop={6}>
          <MarkupLabel markup={b.markup} css={[HEADING_CSS[b.level] ?? 'heading']} />
        </Gtk.Box>
      );
    case 'item':
      return (
        <Gtk.Box spacing={8} marginStart={6 + b.depth * 18}>
          <Gtk.Label label={b.bullet} valign={Gtk.Align.START} widthChars={3} xalign={1} cssClasses={['dim-label']} />
          <MarkupLabel markup={b.markup} hexpand />
        </Gtk.Box>
      );
    case 'quote':
      return (
        <Gtk.Box spacing={10}>
          <Gtk.Separator orientation={Gtk.Orientation.VERTICAL} />
          <MarkupLabel markup={`<i>${b.markup}</i>`} css={['dim-label']} />
        </Gtk.Box>
      );
    case 'code':
      return (
        <Gtk.Frame>
          <Gtk.Label
            label={b.text}
            xalign={0}
            selectable
            wrap
            wrapMode={Pango.WrapMode.CHAR}
            cssClasses={['monospace']}
            marginTop={8}
            marginBottom={8}
            marginStart={12}
            marginEnd={12}
          />
        </Gtk.Frame>
      );
    case 'table':
      return <Table header={b.header} rows={b.rows} />;
    case 'rule':
      return <Gtk.Separator marginTop={4} marginBottom={4} />;
    default:
      return assertNever(b);
  }
}

export function Markdown({ text }: { text: string }): JSX.Element {
  return (
    <Gtk.Box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
      {parseMarkdown(text).map((block) => (
        <BlockView block={block} />
      ))}
    </Gtk.Box>
  );
}
