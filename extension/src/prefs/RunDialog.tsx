// Run detail: the whole opencode session (every run sharing it), live.
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import { createComputed, createEffect, createRoot, createState, onCleanup, With, type Accessor } from 'gnim';
import { Ack, Launched, Resumed, RunLogs, STATUS_ICON, type Entry, type SessionRunView } from '../../../src/shared/api.ts';
import { errorMessage, tg, tgText } from '../common/cli.ts';
import { fmtDate, fmtDuration } from '../common/format.ts';
import { Markdown } from './Markdown.tsx';

const POLL_RUNNING_S = 2;
const POLL_IDLE_S = 4;
const TOOL_ICON: Readonly<Record<string, string>> = { completed: 'object-select-symbolic', error: 'dialog-error-symbolic' };

type ToolEntry = Extract<Entry, { kind: 'tool' }>;

/** Children list without the absent (null) ones: JSX arrays only accept elements. */
const present = (...nodes: (JSX.Element | null)[]): JSX.Element[] => nodes.filter((n): n is JSX.Element => n !== null);

interface TextProps {
  text: string;
  css?: string[];
  mono?: boolean;
  selectable?: boolean;
  xalign?: number;
}

function Text({ text, css = [], mono = false, selectable = true, xalign = 0 }: TextProps): JSX.Element {
  return <Gtk.Label label={text} wrap wrapMode={Pango.WrapMode.WORD_CHAR} xalign={xalign} selectable={selectable} cssClasses={mono ? ['monospace', ...css] : css} />;
}

function Section({ title, css = [], children }: { title: string; css?: string[]; children: JSX.Element }): JSX.Element {
  return (
    <Gtk.Box orientation={Gtk.Orientation.VERTICAL} spacing={6}>
      <Text text={title} css={['heading', ...css]} selectable={false} />
      {children}
    </Gtk.Box>
  );
}

function ToolRow({ entry, expanded }: { entry: ToolEntry; expanded: Set<string> }): JSX.Element {
  const head = (entry.title === '' ? (entry.input.split('\n')[0] ?? '') : entry.title).slice(0, 160);
  const iconName = TOOL_ICON[entry.status];
  const failed = entry.status === 'error';
  return (
    <Adw.ExpanderRow
      title={GLib.markup_escape_text(entry.tool, -1)}
      subtitle={GLib.markup_escape_text(head, -1)}
      subtitleLines={1}
      expanded={expanded.has(entry.id)}
      onNotifyExpanded={(self) => {
        if (self.expanded) expanded.add(entry.id);
        else expanded.delete(entry.id);
      }}
    >
      {iconName === undefined ? <Adw.Spinner $type="prefix" /> : <Gtk.Image $type="prefix" iconName={iconName} cssClasses={[failed ? 'error' : 'success']} />}
      <Gtk.Box orientation={Gtk.Orientation.VERTICAL} spacing={8} marginTop={10} marginBottom={12} marginStart={12} marginEnd={12}>
        {entry.input === '' ? null : (
          <Section title="Entrée">
            <Text text={entry.input} mono />
          </Section>
        )}
        {entry.output === '' ? null : (
          <Section title={failed ? 'Erreur' : 'Sortie'}>
            <Text text={entry.output} mono css={failed ? ['error'] : []} />
          </Section>
        )}
      </Gtk.Box>
    </Adw.ExpanderRow>
  );
}

function EntryView({ entry: e }: { entry: Exclude<Entry, ToolEntry> }): JSX.Element {
  switch (e.kind) {
    case 'prompt':
      return (
        <Section title="Prompt" css={['accent']}>
          <Gtk.Frame>
            <Gtk.Box marginStart={12} marginEnd={12} marginTop={10} marginBottom={10}>
              <Markdown text={e.text} />
            </Gtk.Box>
          </Gtk.Frame>
        </Section>
      );
    case 'text':
      return (
        <Section title="Assistant">
          <Markdown text={e.text} />
        </Section>
      );
    case 'reasoning':
      return (
        <Section title="Réflexion" css={['dim-label']}>
          <Text text={e.text} css={['dim-label']} />
        </Section>
      );
    case 'error':
      return <Text text={`✗ ${e.text}`} mono css={['error']} />;
    default:
      return assertNever(e);
  }
}

function assertNever(value: never): never {
  throw new Error(`Entrée inattendue: ${JSON.stringify(value)}`);
}

/** Consecutive tool calls are grouped in one boxed list. */
function groupEntries(entries: Entry[]): (Exclude<Entry, ToolEntry> | ToolEntry[])[] {
  const out: (Exclude<Entry, ToolEntry> | ToolEntry[])[] = [];
  for (const e of entries) {
    const last = out.at(-1);
    if (e.kind !== 'tool') out.push(e);
    else if (Array.isArray(last)) last.push(e);
    else out.push([e]);
  }
  return out;
}

function Transcript({ entries, expanded }: { entries: Entry[]; expanded: Set<string> }): JSX.Element[] {
  return groupEntries(entries).map((g) =>
    Array.isArray(g) ? (
      <Gtk.ListBox selectionMode={Gtk.SelectionMode.NONE} cssClasses={['boxed-list']}>
        {g.map((entry) => (
          <ToolRow entry={entry} expanded={expanded} />
        ))}
      </Gtk.ListBox>
    ) : (
      <EntryView entry={g} />
    ),
  );
}

function RunHeader({ run }: { run: SessionRunView }): JSX.Element {
  const what = run.trigger === 'interactive' ? 'message depuis le terminal' : run.trigger;
  return (
    <Gtk.Box spacing={10} marginTop={10}>
      <Gtk.Separator valign={Gtk.Align.CENTER} hexpand />
      <Text text={`${STATUS_ICON[run.status]}  Run #${run.id} · ${what} · ${fmtDate(run.started_at)} · ${fmtDuration(run.duration_ms)}`} css={['dim-label', 'caption']} selectable={false} xalign={0.5} />
      <Gtk.Separator valign={Gtk.Align.CENTER} hexpand />
    </Gtk.Box>
  );
}

function Summary({ runs, cur, onResume }: { runs: SessionRunView[]; cur: SessionRunView; onResume: (print: boolean) => void }): JSX.Element {
  const cost = runs.reduce((t, r) => t + (r.cost ?? 0), 0);
  const tokens = runs.reduce((t, r) => t + (r.tokens ?? 0), 0);
  const meta = [fmtDate(runs[0]?.started_at ?? null), runs.length > 1 ? `${runs.length} runs` : fmtDuration(cur.duration_ms), cur.trigger];
  if (cost > 0) meta.push(`$${cost.toFixed(3)}`);
  if (tokens > 0) meta.push(`${Math.round(tokens / 1000)}k tokens`);
  const hasSession = cur.session_id !== null;
  return (
    <Adw.PreferencesGroup>
      <Adw.ActionRow title={GLib.markup_escape_text(`${STATUS_ICON[cur.status]}  ${cur.status}`, -1)} subtitle={GLib.markup_escape_text(meta.join('  ·  '), -1)}>
        <Gtk.Button $type="suffix" visible={hasSession} iconName="edit-copy-symbolic" tooltipText="Copier la commande pour continuer la session" valign={Gtk.Align.CENTER} cssClasses={['flat']} onClicked={() => onResume(true)} />
        <Gtk.Button $type="suffix" visible={hasSession} iconName="utilities-terminal-symbolic" tooltipText="Continuer dans un terminal" valign={Gtk.Align.CENTER} cssClasses={['flat']} onClicked={() => onResume(false)} />
      </Adw.ActionRow>
    </Adw.PreferencesGroup>
  );
}

/** The conversation of every run of the session. */
function Conversation({ runs, expanded, onResume }: { runs: SessionRunView[]; expanded: Set<string>; onResume: (print: boolean) => void }): JSX.Element {
  const cur = runs.find((r) => r.status === 'running') ?? runs.at(-1);
  return (
    <Gtk.Box orientation={Gtk.Orientation.VERTICAL} spacing={18} marginTop={18} marginBottom={24} marginStart={18} marginEnd={18}>
      {cur === undefined ? null : <Summary runs={runs} cur={cur} onResume={onResume} />}
      {runs.flatMap((r) =>
        present(
          runs.length > 1 ? <RunHeader run={r} /> : null,
          r.error === null ? null : (
            <Section title="Erreur" css={['error']}>
              <Text text={r.error} mono css={['error']} />
            </Section>
          ),
          ...Transcript({ entries: r.transcript, expanded }),
          r.status === 'running' ? (
            <Gtk.Box spacing={8} halign={Gtk.Align.CENTER}>
              <Adw.Spinner />
              <Text text="opencode travaille…" css={['dim-label']} selectable={false} />
            </Gtk.Box>
          ) : null,
        ),
      )}
    </Gtk.Box>
  );
}

const signature = (l: RunLogs | null): string => JSON.stringify(l?.session_runs.map((r) => [r.id, r.status, r.error, r.transcript]) ?? null);

interface DialogProps {
  runId: number;
  onClosed: () => void;
}

/** The dialog content; state and polling live in its scope. */
function RunDialog({ runId: initialRunId, onClosed }: DialogProps): JSX.Element {
  const [runId, setRunId] = createState(initialRunId);
  const [logs, setLogs] = createState<RunLogs | null>(null, { equals: (a, b) => signature(a) === signature(b) });
  const [raw, setRaw] = createState('');
  const [page, setPage] = createState('chat');
  const expanded = new Set<string>();

  const runs = logs((l) => l?.session_runs ?? []);
  const current: Accessor<SessionRunView | null> = createComputed(() => runs().find((r) => r.status === 'running') ?? runs().at(-1) ?? null);
  const running = current((c) => c?.status === 'running');
  const title = createComputed(() => {
    const l = logs();
    return l === null ? `Run #${runId()}` : `Run #${l.id} — ${l.task_name}`;
  });

  let alive = true;
  let timer = 0;
  let scroll: Gtk.ScrolledWindow | null = null;
  let toasts: Adw.ToastOverlay | null = null;
  let dialog: Adw.Dialog | null = null;
  let popover: Gtk.Popover | null = null;
  const toast = (text: string): void => {
    toasts?.add_toast(new Adw.Toast({ title: text, timeout: 3 }));
  };

  // Gtk.TextBuffer:text cannot be bound (its getter takes arguments): updated by an effect
  const rawBuffer = new Gtk.TextBuffer();
  createEffect(() => {
    rawBuffer.text = raw();
  });

  async function load(): Promise<void> {
    const id = runId.peek();
    try {
      const wasRunning = running.peek();
      const data = await tg(['logs', String(id), '--transcript'], RunLogs);
      if (!alive) return;
      const adj = scroll?.vadjustment ?? null;
      const atBottom = adj === null || adj.value + adj.pageSize >= adj.upper - 40;
      const keep = adj?.value ?? 0;
      setLogs(data);
      if (page.peek() === 'raw') setRaw((await tgText(['logs', String(current.peek()?.id ?? id), '--raw'])) || '(aucun événement pour le moment)');
      const cur = current.peek();
      if (wasRunning && cur !== null && cur.status !== 'running') toast(`Terminé : ${STATUS_ICON[cur.status]} ${cur.status}`);
      GLib.idle_add(GLib.PRIORITY_LOW, () => {
        if (adj !== null) adj.value = atBottom && running.peek() ? adj.upper : keep;
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
    popover?.popdown();
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

  const onResume = (print: boolean): void => {
    void resume(print);
  };

  let chat: Gtk.Widget | null = null;
  let rawPage: Gtk.Widget | null = null;
  let switcher: Adw.ViewSwitcher | null = null;

  void load();
  return (
    <Adw.Dialog
      title={title}
      contentWidth={900}
      contentHeight={760}
      onClosed={onClosed}
      $={(self) => {
        dialog = self;
      }}
    >
      <Adw.ToastOverlay
        $={(self) => {
          toasts = self;
        }}
      >
        <Adw.ToolbarView>
          <Adw.HeaderBar $type="top">
            <Gtk.Button $type="start" iconName="edit-copy-symbolic" tooltipText="Copier la discussion" onClicked={() => void copyTranscript()} />
            <Adw.ViewSwitcher
              $type="title"
              policy={Adw.ViewSwitcherPolicy.WIDE}
              $={(self) => {
                switcher = self;
              }}
            />
            <Gtk.Button $type="end" label={running((r) => (r ? 'Annuler' : 'Relancer'))} cssClasses={running((r) => (r ? ['destructive-action'] : []))} onClicked={() => void onAction()} />
            <Adw.SplitButton $type="end" tooltipText="Ouvrir la session opencode dans un terminal" dropdownTooltip="Autres options" onClicked={() => onResume(false)}>
              <Adw.ButtonContent iconName="utilities-terminal-symbolic" label="Continuer" />
              <Gtk.Popover
                $={(self) => {
                  popover = self;
                }}
              >
                <Gtk.Button cssClasses={['flat']} onClicked={() => onResume(true)}>
                  <Adw.ButtonContent iconName="edit-copy-symbolic" label="Copier la commande" />
                </Gtk.Button>
              </Gtk.Popover>
            </Adw.SplitButton>
          </Adw.HeaderBar>
          <Adw.Banner
            $type="top"
            revealed={running}
            title={current((c) => (c?.trigger === 'interactive' ? 'Nouveau message en cours de traitement — mise à jour automatique' : 'En cours — mise à jour automatique'))}
          />
          <Adw.ViewStack
            onNotifyVisibleChildName={(self) => {
              setPage(self.visibleChildName ?? 'chat');
              void load();
            }}
            $={(self) => {
              // the switcher (in the header, built earlier) is connected once the stack exists
              if (switcher !== null) switcher.stack = self;
              // pages are added as children; their title / icon are set on the page objects
              const pages: [Gtk.Widget | null, string, string, string][] = [
                [chat, 'chat', 'Discussion', 'chat-bubbles-text-symbolic'],
                [rawPage, 'raw', 'Événements bruts', 'text-x-generic-symbolic'],
              ];
              for (const [child, name, label, icon] of pages) {
                if (child === null) continue;
                const p = self.get_page(child);
                p.name = name;
                p.title = label;
                p.iconName = icon;
              }
            }}
          >
            <Gtk.ScrolledWindow
              vexpand
              $={(self) => {
                chat = self;
                scroll = self;
              }}
            >
              <Adw.Clamp maximumSize={860}>
                {/* <With> is a fragment: it must be the child of a container */}
                <Gtk.Box orientation={Gtk.Orientation.VERTICAL}>
                  <With value={logs}>
                    {(l: RunLogs | null) =>
                      l === null ? <Adw.Spinner heightRequest={48} marginTop={48} /> : <Conversation runs={l.session_runs} expanded={expanded} onResume={onResume} />}
                  </With>
                </Gtk.Box>
              </Adw.Clamp>
            </Gtk.ScrolledWindow>
            <Gtk.ScrolledWindow
              $={(self) => {
                rawPage = self;
              }}
            >
              <Gtk.TextView buffer={rawBuffer} editable={false} monospace wrapMode={Gtk.WrapMode.WORD_CHAR} topMargin={12} bottomMargin={12} leftMargin={12} rightMargin={12} />
            </Gtk.ScrolledWindow>
          </Adw.ViewStack>
        </Adw.ToolbarView>
      </Adw.ToastOverlay>
    </Adw.Dialog>
  );
}

/** Opens the run dialog on `parent`. Returns a function closing it. */
export function openRunDialog(parent: Gtk.Widget, runId: number): () => void {
  let dialog: Adw.Dialog | null = null;
  createRoot((dispose) => {
    const node = <RunDialog runId={runId} onClosed={dispose} />;
    // the only place where the concrete type is needed: Adw.Dialog.present()
    if (node instanceof Adw.Dialog) {
      dialog = node;
      node.present(parent);
    }
    return node;
  });
  return () => {
    dialog?.close();
  };
}
