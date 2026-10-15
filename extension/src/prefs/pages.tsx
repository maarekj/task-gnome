// "Tâches" and "Historique" pages of the preferences window.
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import { createState, For, jsx, With } from 'gnim';
import type * as z from 'zod/mini';
import { Ack, FAILED_STATUSES, History, Launched, Overview, STATUS_ICON, TaskView, type RunView } from '../../../src/shared/api.ts';
import { errorMessage, tg } from '../common/cli.ts';
import { fmtDate, fmtDuration } from '../common/format.ts';
import { openTaskEditor } from './TaskEditor.tsx';

export interface PageProps {
  toast: (message: string) => void;
  openRun: (runId: number) => void;
}

const esc = (s: string): string => GLib.markup_escape_text(s, -1);

function iconButton(icon: string, tooltip: string, onClicked: () => void): Gtk.Button {
  return jsx(Gtk.Button, { iconName: icon, tooltipText: tooltip, valign: Gtk.Align.CENTER, cssClasses: ['flat'], onClicked });
}

// ---------------------------------------------------------------- tasks

function TaskRow({ task, act, edit }: { task: TaskView; act: (args: string[], done?: string) => void; edit: (t: TaskView) => void }): Adw.ActionRow {
  const last = task.last_run === null ? 'jamais lancée' : `${STATUS_ICON[task.last_run.status]} ${fmtDate(task.last_run.started_at)}`;
  const next = task.enabled ? `prochaine : ${fmtDate(task.next_run)}` : 'désactivée';
  const row = jsx(Adw.ActionRow, {
    title: esc(task.name),
    subtitle: esc(`${task.cron}  ·  ${next}  ·  dernier : ${last}\n${task.dir}`),
    subtitleLines: 2,
    activatable: true,
    onActivated: () => {
      edit(task);
    },
  });
  row.add_suffix(iconButton('media-playback-start-symbolic', 'Lancer maintenant', () => {
    act(['run', String(task.id)], `« ${task.name} » lancée`);
  }));
  row.add_suffix(iconButton('document-edit-symbolic', 'Modifier', () => {
    edit(task);
  }));
  row.add_suffix(iconButton('user-trash-symbolic', 'Supprimer', () => {
    const dlg = new Adw.AlertDialog({ heading: `Supprimer « ${task.name} » ?`, body: 'La tâche et tout son historique seront supprimés.' });
    dlg.add_response('cancel', 'Annuler');
    dlg.add_response('delete', 'Supprimer');
    dlg.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
    dlg.connect('response', (_d: Adw.AlertDialog, response: string) => {
      if (response === 'delete') act(['rm', String(task.id)], 'Tâche supprimée');
    });
    dlg.present(row);
  }));
  row.add_suffix(jsx(Gtk.Switch, {
    active: task.enabled,
    valign: Gtk.Align.CENTER,
    tooltipText: 'Activer / désactiver',
    onNotifyActive: (self: Gtk.Switch) => {
      act([self.active ? 'enable' : 'disable', String(task.id)]);
    },
  }));
  return row;
}

export function TasksPage({ toast }: PageProps): Adw.PreferencesPage {
  const [data, setData] = createState<Overview | null>(null);
  const [error, setError] = createState<string | null>(null);
  let page: Adw.PreferencesPage | null = null;

  const reload = async (): Promise<void> => {
    try {
      setData(await tg(['overview'], Overview));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const act = (args: string[], done?: string): void => {
    const schema: z.ZodMiniType = args[0] === 'run' ? Launched : args[0] === 'rm' ? Ack : TaskView;
    const run = async (): Promise<void> => {
      try {
        await tg(args, schema);
        if (done !== undefined) toast(done);
      } catch (e) {
        toast(errorMessage(e));
      }
      await reload();
    };
    void run();
  };

  const edit = (t: TaskView | null): void => {
    if (page === null) return;
    openTaskEditor(page, t, (msg) => {
      toast(msg);
      void reload();
    });
  };

  const status = data((d) => d?.daemon ?? null);
  const header = jsx(Gtk.Box, {
    spacing: 6,
    children: [
      iconButton('view-refresh-symbolic', 'Rafraîchir', () => void reload()),
      jsx(Gtk.Button, { label: 'Nouvelle tâche', cssClasses: ['suggested-action'], valign: Gtk.Align.CENTER, onClicked: () => {
        edit(null);
      } }),
    ],
  });

  void reload();
  return jsx(Adw.PreferencesPage, {
    title: 'Tâches',
    iconName: 'alarm-symbolic',
    $: (self: Adw.PreferencesPage) => {
      page = self;
    },
    children: [
      jsx(Adw.PreferencesGroup, {
        children: [
          jsx(Adw.ActionRow, {
            title: error((e) => (e === null ? (status() === null ? 'Démon arrêté' : `Démon actif (pid ${status()?.pid ?? ''})`) : 'taskgnome injoignable')),
            subtitle: error((e) => esc(e ?? (status() === null ? 'Démarre-le : systemctl --user start taskgnome (ou taskgnome install)' : 'Les tâches sont planifiées et lancées automatiquement.'))),
          }),
        ],
      }),
      jsx(Adw.PreferencesGroup, {
        title: 'Tâches planifiées',
        headerSuffix: header,
        children: [
          <With value={data((d) => d?.tasks.length === 0)}>
            {(empty: boolean) => (empty ? jsx(Adw.ActionRow, { title: 'Aucune tâche', subtitle: 'Clique sur « Nouvelle tâche » pour commencer.' }) : null)}
          </With>,
          <For each={data((d) => d?.tasks ?? [])}>{(t: TaskView) => TaskRow({ task: t, act, edit })}</For>,
        ],
      }),
    ],
  });
}

// ---------------------------------------------------------------- history

function RunRow({ run, openRun }: { run: RunView; openRun: (id: number) => void }): Adw.ActionRow {
  const err = run.error === null ? '' : `  ·  ${(run.error.split('\n')[0] ?? '').slice(0, 90)}`;
  const row = jsx(Adw.ActionRow, {
    title: esc(`${STATUS_ICON[run.status]}  ${run.task_name}`),
    subtitle: esc(`#${run.id}  ·  ${fmtDate(run.started_at)}  ·  ${fmtDuration(run.duration_ms)}  ·  ${run.trigger}${err}`),
    activatable: true,
    cssClasses: FAILED_STATUSES.has(run.status) ? ['error'] : [],
    onActivated: () => {
      openRun(run.id);
    },
  });
  row.add_suffix(jsx(Gtk.Image, { iconName: 'go-next-symbolic' }));
  return row;
}

export function HistoryPage({ toast, openRun }: PageProps): Adw.PreferencesPage {
  const [runs, setRuns] = createState<RunView[]>([]);
  const [failedOnly, setFailedOnly] = createState(false);

  const reload = async (): Promise<void> => {
    try {
      setRuns(await tg(['history', '--limit', '100', ...(failedOnly.peek() ? ['--failed'] : [])], History));
    } catch (e) {
      toast(errorMessage(e));
    }
  };

  const header = jsx(Gtk.Box, {
    spacing: 6,
    children: [
      jsx(Gtk.ToggleButton, { label: 'Erreurs seulement', valign: Gtk.Align.CENTER, onToggled: (self: Gtk.ToggleButton) => {
        setFailedOnly(self.active);
        void reload();
      } }),
      iconButton('view-refresh-symbolic', 'Rafraîchir', () => void reload()),
    ],
  });

  void reload();
  return jsx(Adw.PreferencesPage, {
    title: 'Historique',
    iconName: 'document-open-recent-symbolic',
    // refresh when shown
    onMap: () => void reload(),
    children: [
      jsx(Adw.PreferencesGroup, {
        title: 'Derniers runs',
        headerSuffix: header,
        children: [
          <With value={runs((r) => r.length === 0)}>{(empty: boolean) => (empty ? jsx(Adw.ActionRow, { title: 'Aucun run' }) : null)}</With>,
          <For each={runs}>{(r: RunView) => RunRow({ run: r, openRun })}</For>,
        ],
      }),
    ],
  });
}
