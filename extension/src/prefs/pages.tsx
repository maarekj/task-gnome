// "Tâches" and "Historique" pages of the preferences window.
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import { createState, For, With, type FCProps } from 'gnim';
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

function IconButton({ icon, tooltip, onClicked }: { icon: string; tooltip: string; onClicked: () => void }): JSX.Element {
  return <Gtk.Button iconName={icon} tooltipText={tooltip} valign={Gtk.Align.CENTER} cssClasses={['flat']} onClicked={onClicked} />;
}

// ---------------------------------------------------------------- tasks

interface TaskRowProps {
  task: TaskView;
  act: (args: string[], done?: string) => void;
  edit: (t: TaskView) => void;
  confirmDelete: (t: TaskView) => void;
}

function TaskRow({ task, act, edit, confirmDelete }: TaskRowProps): JSX.Element {
  const last = task.last_run === null ? 'jamais lancée' : `${STATUS_ICON[task.last_run.status]} ${fmtDate(task.last_run.started_at)}`;
  const next = task.enabled ? `prochaine : ${fmtDate(task.next_run)}` : 'désactivée';
  return (
    <Adw.ActionRow title={esc(task.name)} subtitle={esc(`${task.cron}  ·  ${next}  ·  dernier : ${last}\n${task.dir}`)} subtitleLines={2} activatable onActivated={() => edit(task)}>
      <Gtk.Box $type="suffix" spacing={6}>
        <IconButton icon="media-playback-start-symbolic" tooltip="Lancer maintenant" onClicked={() => act(['run', String(task.id)], `« ${task.name} » lancée`)} />
        <IconButton icon="document-edit-symbolic" tooltip="Modifier" onClicked={() => edit(task)} />
        <IconButton icon="user-trash-symbolic" tooltip="Supprimer" onClicked={() => confirmDelete(task)} />
        <Gtk.Switch active={task.enabled} valign={Gtk.Align.CENTER} tooltipText="Activer / désactiver" onNotifyActive={(self) => act([self.active ? 'enable' : 'disable', String(task.id)])} />
      </Gtk.Box>
    </Adw.ActionRow>
  );
}

export function TasksPage({ toast }: PageProps): JSX.Element {
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

  const confirmDelete = (t: TaskView): void => {
    const dlg = new Adw.AlertDialog({ heading: `Supprimer « ${t.name} » ?`, body: 'La tâche et tout son historique seront supprimés.' });
    dlg.add_response('cancel', 'Annuler');
    dlg.add_response('delete', 'Supprimer');
    dlg.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
    dlg.connect('response', (_d: Adw.AlertDialog, response: string) => {
      if (response === 'delete') act(['rm', String(t.id)], 'Tâche supprimée');
    });
    dlg.present(page);
  };

  const daemon = data((d) => d?.daemon ?? null);
  const statusTitle = error((e) => (e === null ? (daemon() === null ? 'Démon arrêté' : `Démon actif (pid ${daemon()?.pid ?? ''})`) : 'taskgnome injoignable'));
  const statusText = error((e) =>
    esc(e ?? (daemon() === null ? 'Démarre-le : systemctl --user start taskgnome (ou taskgnome install)' : 'Les tâches sont planifiées et lancées automatiquement.')),
  );

  void reload();
  return (
    <Adw.PreferencesPage title="Tâches" iconName="alarm-symbolic" $={(self) => {
        page = self;
      }}>
      <Adw.PreferencesGroup>
        <Adw.ActionRow title={statusTitle} subtitle={statusText} />
      </Adw.PreferencesGroup>
      <Adw.PreferencesGroup title="Tâches planifiées">
        <Gtk.Box $type="header-suffix" spacing={6}>
          <IconButton icon="view-refresh-symbolic" tooltip="Rafraîchir" onClicked={() => void reload()} />
          <Gtk.Button label="Nouvelle tâche" cssClasses={['suggested-action']} valign={Gtk.Align.CENTER} onClicked={() => edit(null)} />
        </Gtk.Box>
        <With value={data((d) => d?.tasks.length === 0)}>
          {(empty: boolean) => (empty ? <Adw.ActionRow title="Aucune tâche" subtitle="Clique sur « Nouvelle tâche » pour commencer." /> : null)}
        </With>
        <For each={data((d) => d?.tasks ?? [])}>{(t: TaskView) => <TaskRow task={t} act={act} edit={edit} confirmDelete={confirmDelete} />}</For>
      </Adw.PreferencesGroup>
    </Adw.PreferencesPage>
  );
}

// ---------------------------------------------------------------- history

function RunRow({ run, openRun }: { run: RunView; openRun: (id: number) => void }): JSX.Element {
  const err = run.error === null ? '' : `  ·  ${(run.error.split('\n')[0] ?? '').slice(0, 90)}`;
  return (
    <Adw.ActionRow
      title={esc(`${STATUS_ICON[run.status]}  ${run.task_name}`)}
      subtitle={esc(`#${run.id}  ·  ${fmtDate(run.started_at)}  ·  ${fmtDuration(run.duration_ms)}  ·  ${run.trigger}${err}`)}
      activatable
      cssClasses={FAILED_STATUSES.has(run.status) ? ['error'] : []}
      onActivated={() => openRun(run.id)}
    >
      <Gtk.Image $type="suffix" iconName="go-next-symbolic" />
    </Adw.ActionRow>
  );
}

/** `$` gives the parent a typed reference to the page (to show it). */
export function HistoryPage({ toast, openRun }: FCProps<Adw.PreferencesPage, PageProps>): JSX.Element {
  const [runs, setRuns] = createState<RunView[]>([]);
  const [failedOnly, setFailedOnly] = createState(false);

  const reload = async (): Promise<void> => {
    try {
      setRuns(await tg(['history', '--limit', '100', ...(failedOnly.peek() ? ['--failed'] : [])], History));
    } catch (e) {
      toast(errorMessage(e));
    }
  };

  void reload();
  return (
    // refreshed each time the page is shown
    <Adw.PreferencesPage title="Historique" iconName="document-open-recent-symbolic" onMap={() => void reload()}>
      <Adw.PreferencesGroup title="Derniers runs">
        <Gtk.Box $type="header-suffix" spacing={6}>
          <Gtk.ToggleButton
            label="Erreurs seulement"
            valign={Gtk.Align.CENTER}
            onToggled={(self) => {
              setFailedOnly(self.active);
              void reload();
            }}
          />
          <IconButton icon="view-refresh-symbolic" tooltip="Rafraîchir" onClicked={() => void reload()} />
        </Gtk.Box>
        <With value={runs((r) => r.length === 0)}>{(empty: boolean) => (empty ? <Adw.ActionRow title="Aucun run" /> : null)}</With>
        <For each={runs}>{(r: RunView) => <RunRow run={r} openRun={openRun} />}</For>
      </Adw.PreferencesGroup>
    </Adw.PreferencesPage>
  );
}
