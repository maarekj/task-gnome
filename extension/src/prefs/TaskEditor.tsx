// Create / edit a task (Adw.Dialog).
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import { createRoot, createState } from 'gnim';
import { TaskView, type Task } from '../../../src/shared/api.ts';
import { errorMessage, tg } from '../common/cli.ts';
import { fmtSeconds } from '../common/format.ts';

Gio._promisify(Gtk.FileDialog.prototype, 'select_folder', 'select_folder_finish');

const CRON_HELP = 'min heure jour-du-mois mois jour-semaine — ex. « 0 9 * * 1-5 » (9h en semaine), « */30 * * * * », @hourly, @daily';

const text = (row: Adw.EntryRow | undefined): string => row?.text.trim() ?? '';
const bufferText = (b: Gtk.TextBuffer): string => b.get_text(b.get_start_iter(), b.get_end_iter(), false);

function TextArea({ buffer, minHeight, marginTop = 0 }: { buffer: Gtk.TextBuffer; minHeight: number; marginTop?: number }): JSX.Element {
  return (
    <Gtk.ScrolledWindow minContentHeight={minHeight} cssClasses={['card']} marginTop={marginTop}>
      <Gtk.TextView buffer={buffer} monospace wrapMode={Gtk.WrapMode.WORD_CHAR} topMargin={8} bottomMargin={8} leftMargin={8} rightMargin={8} />
    </Gtk.ScrolledWindow>
  );
}

interface EditorProps {
  parent: Gtk.Widget;
  task: Task | null;
  onSaved: (message: string) => void;
  onClosed: () => void;
}

function TaskEditor({ parent, task, onSaved, onClosed }: EditorProps): JSX.Element {
  const isNew = task === null;
  const [dir, setDir] = createState(task?.dir ?? GLib.get_home_dir());
  const [saving, setSaving] = createState(false);
  // Gtk.TextBuffer:text cannot be bound reactively, buffers are plain objects
  const envBuffer = new Gtk.TextBuffer({ text: Object.entries(task?.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n') });
  const promptBuffer = new Gtk.TextBuffer({ text: task?.prompt ?? '' });

  // filled by the setup functions ($) of the widgets below
  const f: {
    dialog?: Adw.Dialog; toasts?: Adw.ToastOverlay;
    name?: Adw.EntryRow; cron?: Adw.EntryRow; model?: Adw.EntryRow; agent?: Adw.EntryRow; timeout?: Adw.EntryRow;
    catchUp?: Adw.SwitchRow; enabled?: Adw.SwitchRow; direnv?: Adw.SwitchRow;
  } = {};

  const pickDir = async (): Promise<void> => {
    try {
      const root = parent.get_root();
      const fd = new Gtk.FileDialog({ title: 'Dossier de la tâche', initialFolder: Gio.File.new_for_path(dir.peek()) });
      const file = await fd.select_folder(root instanceof Gtk.Window ? root : null, null);
      const p = file?.get_path();
      if (p !== null && p !== undefined) setDir(p);
    } catch {
      // cancelled
    }
  };

  const save = async (): Promise<void> => {
    const enabled = f.enabled?.active ?? true;
    const args = isNew ? ['add'] : ['edit', String(task.id)];
    // empty --model= / --agent= clear the value (default model / agent)
    args.push(
      `--name=${text(f.name)}`, `--cron=${text(f.cron)}`, `--dir=${dir.peek()}`,
      `--model=${text(f.model)}`, `--agent=${text(f.agent)}`, `--timeout=${text(f.timeout) === '' ? '0' : text(f.timeout)}`,
      f.catchUp?.active === false ? '--no-catch-up' : '--catch-up',
      f.direnv?.active === true ? '--direnv' : '--no-direnv',
      '--prompt=-',
    );
    if (!isNew) args.push('--clear-env');
    for (const line of bufferText(envBuffer).split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'))) {
      args.push(`--env=${line.replace(/^export\s+/u, '')}`);
    }
    // on edit, only when changed: re-enabling restarts the schedule from now
    if (isNew || enabled !== task.enabled) args.push(enabled ? '--enabled' : '--no-enabled');
    setSaving(true);
    try {
      await tg(args, TaskView, bufferText(promptBuffer));
      f.dialog?.close();
      onSaved(isNew ? 'Tâche créée' : 'Tâche enregistrée');
    } catch (error) {
      f.toasts?.add_toast(new Adw.Toast({ title: errorMessage(error), timeout: 6 }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Adw.Dialog
      title={isNew ? 'Nouvelle tâche' : `Modifier « ${task.name} »`}
      contentWidth={640}
      contentHeight={720}
      onClosed={onClosed}
      $={(self) => {
        f.dialog = self;
      }}
    >
      <Adw.ToolbarView>
        <Adw.HeaderBar $type="top">
          <Gtk.Button $type="end" label={isNew ? 'Créer' : 'Enregistrer'} cssClasses={['suggested-action']} sensitive={saving((s) => !s)} onClicked={() => void save()} />
        </Adw.HeaderBar>
        <Adw.ToastOverlay $={(self) => {
        f.toasts = self;
      }}>
          <Adw.PreferencesPage>
            <Adw.PreferencesGroup description={CRON_HELP}>
              <Adw.EntryRow title="Nom" text={task?.name ?? ''} $={(self) => {
        f.name = self;
      }} />
              <Adw.EntryRow title="Planification (cron)" text={task?.cron ?? '0 9 * * 1-5'} $={(self) => {
        f.cron = self;
      }} />
            </Adw.PreferencesGroup>
            <Adw.PreferencesGroup title="Exécution">
              <Adw.ActionRow title="Dossier" subtitle={dir}>
                <Gtk.Button $type="suffix" iconName="folder-open-symbolic" tooltipText="Choisir…" valign={Gtk.Align.CENTER} cssClasses={['flat']} onClicked={() => void pickDir()} />
              </Adw.ActionRow>
              <Adw.EntryRow title="Modèle (provider/model, vide = défaut)" text={task?.model ?? ''} $={(self) => {
        f.model = self;
      }} />
              <Adw.EntryRow title="Agent (vide = défaut)" text={task?.agent ?? ''} $={(self) => {
        f.agent = self;
      }} />
              <Adw.EntryRow title="Timeout (ex. 30m, 1h, 0 = aucun)" text={task === null ? '30m' : fmtSeconds(task.timeout_sec)} $={(self) => {
        f.timeout = self;
      }} />
              <Adw.SwitchRow
                title="Rattraper les exécutions manquées"
                subtitle="Après une veille ou un PC éteint, lance une fois la tâche en retard"
                active={task?.catch_up ?? true}
                $={(self) => {
        f.catchUp = self;
      }}
              />
              <Adw.SwitchRow title="Activée" active={task?.enabled ?? true} $={(self) => {
        f.enabled = self;
      }} />
            </Adw.PreferencesGroup>
            <Adw.PreferencesGroup title="Environnement" description="Une variable par ligne, au format CLE=valeur. Stockées en clair dans la base taskgnome.">
              <Adw.SwitchRow
                title="Charger direnv"
                subtitle="Lance opencode via « direnv exec » pour charger le .envrc du dossier (il doit avoir été autorisé avec direnv allow)"
                active={task?.direnv ?? false}
                $={(self) => {
        f.direnv = self;
      }}
              />
              <TextArea buffer={envBuffer} minHeight={70} marginTop={12} />
            </Adw.PreferencesGroup>
            <Adw.PreferencesGroup title="Prompt" description="Envoyé à opencode dans le dossier, avec toutes les permissions. Mets-y tout le contexte nécessaire.">
              <TextArea buffer={promptBuffer} minHeight={220} />
            </Adw.PreferencesGroup>
          </Adw.PreferencesPage>
        </Adw.ToastOverlay>
      </Adw.ToolbarView>
    </Adw.Dialog>
  );
}

/** Opens the editor; `task` null = new task. `onSaved` is called after a successful save. */
export function openTaskEditor(parent: Gtk.Widget, task: Task | null, onSaved: (message: string) => void): void {
  createRoot((dispose) => {
    const node = <TaskEditor parent={parent} task={task} onSaved={onSaved} onClosed={dispose} />;
    // the only place where the concrete type is needed: Adw.Dialog.present()
    if (node instanceof Adw.Dialog) node.present(parent);
    return node;
  });
}
