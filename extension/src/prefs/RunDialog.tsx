// Run detail: the whole opencode session (every run sharing it), live.
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import { createComputed, createEffect, createRoot, createState, jsx, onCleanup, With } from 'gnim';
import { Ack, Launched, Resumed, RunLogs, STATUS_ICON, type Entry, type SessionRunView } from '../../../src/shared/api.ts';
import { errorMessage, tg, tgText } from '../common/cli.ts';
import { fmtDate, fmtDuration } from '../common/format.ts';
import { Markdown } from './Markdown.tsx';

const POLL_RUNNING_S = 2;
const POLL_IDLE_S = 4;
const TOOL_ICON: Readonly<Record<string, string>> = { completed: 'object-select-symbolic', error: 'dialog-error-symbolic' };

function Text({ text, css = [], mono = false, selectable = true, xalign = 0 }: { text: string; css?: string[]; mono?: boolean; selectable?: boolean; xalign?: number }): Gtk.Label {
  return jsx(Gtk.Label, { label: text, wrap: true, wrapMode: Pango.WrapMode.WORD_CHAR, xalign, selectable, cssClasses: mono ? ['monospace', ...css] : css });
}

function Section({ title, css = [], child }: { title: string; css?: string[]; child: Gtk.Widget }): Gtk.Box {
  return jsx(Gtk.Box, {
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 6,
    children: [Text({ text: title, css: ['heading', ...css], selectable: false }), child],
  });
}

function ToolRow({ entry, expanded }: { entry: Extract<Entry, { kind: 'tool' }>; expanded: Set<string> }): Adw.ExpanderRow {
  const head = (entry.title === '' ? (entry.input.split('\n')[0] ?? '') : entry.title).slice(0, 160);
  const iconName = TOOL_ICON[entry.status];
  const body: Gtk.Widget[] = [];
  if (entry.input !== '') body.push(Section({ title: 'Entrée', child: Text({ text: entry.input, mono: true }) }));
  if (entry.output !== '') {
    const failed = entry.status === 'error';
    body.push(Section({ title: failed ? 'Erreur' : 'Sortie', child: Text({ text: entry.output, mono: true, css: failed ? ['error'] : [] }) }));
  }
  const row = jsx(Adw.ExpanderRow, {
    title: GLib.markup_escape_text(entry.tool, -1),
    subtitle: GLib.markup_escape_text(head, -1),
    subtitleLines: 1,
    expanded: expanded.has(entry.id),
    onNotifyExpanded: (self: Adw.ExpanderRow) => {
      if (self.expanded) expanded.add(entry.id);
      else expanded.delete(entry.id);
    },
  });
  row.add_prefix(
    iconName === undefined
      ? jsx(Adw.Spinner, {})
      : jsx(Gtk.Image, { iconName, cssClasses: [entry.status === 'error' ? 'error' : 'success'] }),
  );
  row.add_row(jsx(Gtk.Box, { orientation: Gtk.Orientation.VERTICAL, spacing: 8, marginTop: 10, marginBottom: 12, marginStart: 12, marginEnd: 12, children: body }));
  return row;
}

/** Transcript entries, consecutive tool calls grouped in a boxed list. */
function Transcript({ entries, expanded }: { entries: Entry[]; expanded: Set<string> }): Gtk.Widget[] {
  const out: Gtk.Widget[] = [];
  let tools: Gtk.ListBox | null = null;
  for (const e of entries) {
    if (e.kind !== 'tool') tools = null;
    switch (e.kind) {
      case 'prompt':
        out.push(Section({
          title: 'Prompt',
          css: ['accent'],
          child: jsx(Gtk.Frame, { child: Object.assign(Markdown({ text: e.text }), { marginStart: 12, marginEnd: 12, marginTop: 10, marginBottom: 10 }) }),
        }));
        break;
      case 'text':
        out.push(Section({ title: 'Assistant', child: Markdown({ text: e.text }) }));
        break;
      case 'reasoning':
        out.push(Section({ title: 'Réflexion', css: ['dim-label'], child: Text({ text: e.text, css: ['dim-label'] }) }));
        break;
      case 'error':
        out.push(Text({ text: `✗ ${e.text}`, mono: true, css: ['error'] }));
        break;
      case 'tool':
        if (tools === null) {
          tools = jsx(Gtk.ListBox, { selectionMode: Gtk.SelectionMode.NONE, cssClasses: ['boxed-list'] });
          out.push(tools);
        }
        tools.append(ToolRow({ entry: e, expanded }));
        break;
    }
  }
  return out;
}

function RunHeader({ run }: { run: SessionRunView }): Gtk.Box {
  const what = run.trigger === 'interactive' ? 'message depuis le terminal' : run.trigger;
  return jsx(Gtk.Box, {
    spacing: 10,
    marginTop: 10,
    children: [
      jsx(Gtk.Separator, { valign: Gtk.Align.CENTER, hexpand: true }),
      Text({ text: `${STATUS_ICON[run.status]}  Run #${run.id} · ${what} · ${fmtDate(run.started_at)} · ${fmtDuration(run.duration_ms)}`, css: ['dim-label', 'caption'], selectable: false, xalign: 0.5 }),
      jsx(Gtk.Separator, { valign: Gtk.Align.CENTER, hexpand: true }),
    ],
  });
}

/** The conversation of every run of the session. */
function Conversation({ runs, expanded, actions }: { runs: SessionRunView[]; expanded: Set<string>; actions: Gtk.Widget[] }): Gtk.Box {
  const cur = runs.find((r) => r.status === 'running') ?? runs.at(-1);
  const children: Gtk.Widget[] = [];
  if (cur !== undefined) {
    const cost = runs.reduce((t, r) => t + (r.cost ?? 0), 0);
    const tokens = runs.reduce((t, r) => t + (r.tokens ?? 0), 0);
    const meta = [fmtDate(runs[0]?.started_at ?? null), runs.length > 1 ? `${runs.length} runs` : fmtDuration(cur.duration_ms), cur.trigger];
    if (cost > 0) meta.push(`$${cost.toFixed(3)}`);
    if (tokens > 0) meta.push(`${Math.round(tokens / 1000)}k tokens`);
    const summary = jsx(Adw.ActionRow, {
      title: GLib.markup_escape_text(`${STATUS_ICON[cur.status]}  ${cur.status}`, -1),
      subtitle: GLib.markup_escape_text(meta.join('  ·  '), -1),
    });
    if (cur.session_id !== null) for (const a of actions) summary.add_suffix(a);
    children.push(jsx(Adw.PreferencesGroup, { children: [summary] }));
  }
  for (const r of runs) {
    if (runs.length > 1) children.push(RunHeader({ run: r }));
    if (r.error !== null) children.push(Section({ title: 'Erreur', css: ['error'], child: Text({ text: r.error, mono: true, css: ['error'] }) }));
    children.push(...Transcript({ entries: r.transcript, expanded }));
    if (r.status === 'running') {
      children.push(jsx(Gtk.Box, {
        spacing: 8,
        halign: Gtk.Align.CENTER,
        children: [jsx(Adw.Spinner, {}), Text({ text: 'opencode travaille…', css: ['dim-label'], selectable: false })],
      }));
    }
  }
  return jsx(Gtk.Box, { orientation: Gtk.Orientation.VERTICAL, spacing: 18, marginTop: 18, marginBottom: 24, marginStart: 18, marginEnd: 18, children });
}

const noop = (): void => undefined;

const signature = (l: RunLogs | null): string => JSON.stringify(l?.session_runs.map((r) => [r.id, r.status, r.error, r.transcript]) ?? null);

/** Opens the run dialog on `parent`. Returns a function closing it. */
export function openRunDialog(parent: Gtk.Widget, initialRunId: number): () => void {
  let close = noop;
  createRoot((dispose) => {
    const [runId, setRunId] = createState(initialRunId);
    const [logs, setLogs] = createState<RunLogs | null>(null, { equals: (a, b) => signature(a) === signature(b) });
    const [raw, setRaw] = createState('');
    const [page, setPage] = createState('chat');
    const expanded = new Set<string>();

    const runs = logs((l) => l?.session_runs ?? []);
    const current = createComputed(() => runs().find((r) => r.status === 'running') ?? runs().at(-1) ?? null);
    const running = current((c) => c?.status === 'running');

    let alive = true;
    let timer = 0;
    let scroll: Gtk.ScrolledWindow | null = null;
    let toasts: Adw.ToastOverlay | null = null;
    let dialog: Adw.Dialog | null = null;
    const toast = (title: string): void => {
      toasts?.add_toast(new Adw.Toast({ title, timeout: 3 }));
    };

    async function load(): Promise<void> {
      const id = runId.peek();
      try {
        const wasRunning = running.peek();
        const data = await tg(['logs', String(id), '--transcript'], RunLogs);
        if (!alive) return;
        const atBottom = scroll === null ? true : scroll.vadjustment.value + scroll.vadjustment.pageSize >= scroll.vadjustment.upper - 40;
        const keep = scroll?.vadjustment.value ?? 0;
        setLogs(data);
        if (dialog !== null) dialog.title = `Run #${data.id} — ${data.task_name}`;
        if (page.peek() === 'raw') setRaw((await tgText(['logs', String(current.peek()?.id ?? id), '--raw'])) || '(aucun événement pour le moment)');
        if (wasRunning && !running.peek()) toast(`Terminé : ${STATUS_ICON[current.peek()?.status ?? 'success']} ${current.peek()?.status ?? ''}`);
        GLib.idle_add(GLib.PRIORITY_LOW, () => {
          if (scroll !== null) scroll.vadjustment.value = atBottom && running.peek() ? scroll.vadjustment.upper : keep;
          return GLib.SOURCE_REMOVE;
        });
      } catch (error) {
        toast(errorMessage(error));
      }
      if (!alive) return;
      // keep following the session while open: a message can arrive from a terminal at any time
      timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, running.peek() ? POLL_RUNNING_S : POLL_IDLE_S, () => {
        timer = 0;
        void load();
        return GLib.SOURCE_REMOVE;
      });
    }
    onCleanup(() => {
      alive = false;
      if (timer !== 0) GLib.source_remove(timer);
    });

    const resume = async (print: boolean): Promise<void> => {
      if (!print) toast('Ouverture de la session…');
      try {
        const res = await tg(['resume', String(runId.peek()), ...(print ? ['--print'] : [])], Resumed);
        if (print) {
          dialog?.get_clipboard().set(res.command);
          toast('Commande copiée — colle-la dans un terminal');
        } else toast('Session ouverte dans un terminal');
      } catch (error) {
        toast(errorMessage(error));
      }
    };

    const onAction = async (): Promise<void> => {
      const cur = current.peek();
      const l = logs.peek();
      try {
        if (cur?.status === 'running') {
          await tg(['cancel', String(cur.id)], Ack);
          toast('Annulation demandée');
        } else if (l !== null) {
          const res = await tg(['run', String(l.task_id)], Launched);
          toast(`« ${l.task_name} » relancée (nouvelle session)`);
          setRunId(res.run); // follow the new run in the same dialog
          setLogs(null);
        }
      } catch (error) {
        toast(errorMessage(error));
      }
    };

    const copyTranscript = async (): Promise<void> => {
      try {
        dialog?.get_clipboard().set(await tgText(['logs', String(runId.peek())]));
        toast('Copié');
      } catch (error) {
        toast(errorMessage(error));
      }
    };

    const summaryActions = (): Gtk.Widget[] => [
      jsx(Gtk.Button, { iconName: 'edit-copy-symbolic', tooltipText: 'Copier la commande pour continuer la session', valign: Gtk.Align.CENTER, cssClasses: ['flat'], onClicked: () => void resume(true) }),
      jsx(Gtk.Button, { iconName: 'utilities-terminal-symbolic', tooltipText: 'Continuer dans un terminal', valign: Gtk.Align.CENTER, cssClasses: ['flat'], onClicked: () => void resume(false) }),
    ];

    const popover = jsx(Gtk.Popover, {
      child: jsx(Gtk.Button, {
        cssClasses: ['flat'],
        child: jsx(Adw.ButtonContent, { iconName: 'edit-copy-symbolic', label: 'Copier la commande' }),
        onClicked: () => {
          popover.popdown();
          void resume(true);
        },
      }),
    });

    // Gtk.TextBuffer:text cannot be bound (its getter takes arguments): updated by an effect
    const rawBuffer = new Gtk.TextBuffer();
    createEffect(() => {
      rawBuffer.text = raw();
    });

    const stack = jsx(Adw.ViewStack, { onNotifyVisibleChildName: (self: Adw.ViewStack) => {
      setPage(self.visibleChildName ?? 'chat');
      void load();
    } });
    stack.add_titled_with_icon(
      jsx(Gtk.ScrolledWindow, {
        vexpand: true,
        $: (self: Gtk.ScrolledWindow) => {
          scroll = self;
        },
        child: jsx(Adw.Clamp, {
          maximumSize: 860,
          // <With> is a fragment: it must be the child of a container
          child: jsx(Gtk.Box, {
            orientation: Gtk.Orientation.VERTICAL,
            children: [
              <With value={logs}>
                {(l: RunLogs | null) =>
                  l === null ? jsx(Adw.Spinner, { heightRequest: 48, marginTop: 48 }) : Conversation({ runs: l.session_runs, expanded, actions: summaryActions() })}
              </With>,
            ],
          }),
        }),
      }),
      'chat', 'Discussion', 'chat-bubbles-text-symbolic',
    );
    stack.add_titled_with_icon(
      jsx(Gtk.ScrolledWindow, {
        child: jsx(Gtk.TextView, {
          editable: false, monospace: true, wrapMode: Gtk.WrapMode.WORD_CHAR, topMargin: 12, bottomMargin: 12, leftMargin: 12, rightMargin: 12,
          buffer: rawBuffer,
        }),
      }),
      'raw', 'Événements bruts', 'text-x-generic-symbolic',
    );

    const header = jsx(Adw.HeaderBar, { titleWidget: jsx(Adw.ViewSwitcher, { stack, policy: Adw.ViewSwitcherPolicy.WIDE }) });
    header.pack_start(jsx(Gtk.Button, { iconName: 'edit-copy-symbolic', tooltipText: 'Copier la discussion', onClicked: () => void copyTranscript() }));
    header.pack_end(jsx(Gtk.Button, {
      label: running((r) => (r ? 'Annuler' : 'Relancer')),
      cssClasses: running((r) => (r ? ['destructive-action'] : [])),
      onClicked: () => void onAction(),
    }));
    header.pack_end(jsx(Adw.SplitButton, {
      child: jsx(Adw.ButtonContent, { iconName: 'utilities-terminal-symbolic', label: 'Continuer' }),
      tooltipText: 'Ouvrir la session opencode dans un terminal',
      dropdownTooltip: 'Autres options',
      popover,
      onClicked: () => void resume(false),
    }));

    const view = jsx(Adw.ToolbarView, { content: stack });
    view.add_top_bar(header);
    view.add_top_bar(jsx(Adw.Banner, {
      title: current((c) => (c?.trigger === 'interactive' ? 'Nouveau message en cours de traitement — mise à jour automatique' : 'En cours — mise à jour automatique')),
      revealed: running,
    }));

    dialog = jsx(Adw.Dialog, {
      title: `Run #${initialRunId}`,
      contentWidth: 900,
      contentHeight: 760,
      child: jsx(Adw.ToastOverlay, { child: view, $: (self: Adw.ToastOverlay) => {
        toasts = self;
      } }),
      onClosed: () => {
        dispose();
      },
    });
    close = (): void => {
      dialog?.close();
    };
    dialog.present(parent);
    void load();
    return dialog;
  });
  return close;
}
