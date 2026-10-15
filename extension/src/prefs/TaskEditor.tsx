// Create / edit a task (Adw.Dialog).
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import { createRoot, createState, jsx } from 'gnim';
import { TaskView, type Task } from '../../../src/shared/api.ts';
import { errorMessage, tg } from '../common/cli.ts';
import { fmtSeconds } from '../common/format.ts';

Gio._promisify(Gtk.FileDialog.prototype, 'select_folder', 'select_folder_finish');

const CRON_HELP = 'min heure jour-du-mois mois jour-semaine — ex. « 0 9 * * 1-5 » (9h en semaine), « */30 * * * * », @hourly, @daily';

const textArea = (buffer: Gtk.TextBuffer, minHeight: number, margin = 0): Gtk.ScrolledWindow =>
  jsx(Gtk.ScrolledWindow, {
    minContentHeight: minHeight,
    cssClasses: ['card'],
    marginTop: margin,
    child: jsx(Gtk.TextView, { buffer, monospace: true, wrapMode: Gtk.WrapMode.WORD_CHAR, topMargin: 8, bottomMargin: 8, leftMargin: 8, rightMargin: 8 }),
  });

const bufferText = (b: Gtk.TextBuffer): string => b.get_text(b.get_start_iter(), b.get_end_iter(), false);

/** Opens the editor; `task` null = new task. `onSaved` is called after a successful save. */
export function openTaskEditor(parent: Gtk.Widget, task: Task | null, onSaved: (message: string) => void): void {
  createRoot((dispose) => {
    const isNew = task === null;
    const [dir, setDir] = createState(task?.dir ?? GLib.get_home_dir());
    const [saving, setSaving] = createState(false);

    const name = jsx(Adw.EntryRow, { title: 'Nom', text: task?.name ?? '' });
    const cron = jsx(Adw.EntryRow, { title: 'Planification (cron)', text: task?.cron ?? '0 9 * * 1-5' });
    const model = jsx(Adw.EntryRow, { title: 'Modèle (provider/model, vide = défaut)', text: task?.model ?? '' });
    const agent = jsx(Adw.EntryRow, { title: 'Agent (vide = défaut)', text: task?.agent ?? '' });
    const timeout = jsx(Adw.EntryRow, { title: 'Timeout (ex. 30m, 1h, 0 = aucun)', text: task === null ? '30m' : fmtSeconds(task.timeout_sec) });
    const catchUp = jsx(Adw.SwitchRow, {
      title: 'Rattraper les exécutions manquées',
      subtitle: 'Après une veille ou un PC éteint, lance une fois la tâche en retard',
      active: task?.catch_up ?? true,
    });
    const enabled = jsx(Adw.SwitchRow, { title: 'Activée', active: task?.enabled ?? true });
    const direnv = jsx(Adw.SwitchRow, {
      title: 'Charger direnv',
      subtitle: 'Lance opencode via « direnv exec » pour charger le .envrc du dossier (il doit avoir été autorisé avec direnv allow)',
      active: task?.direnv ?? false,
    });
    const envBuffer = new Gtk.TextBuffer({ text: Object.entries(task?.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n') });
    const promptBuffer = new Gtk.TextBuffer({ text: task?.prompt ?? '' });

    let dialog: Adw.Dialog | null = null;
    let toasts: Adw.ToastOverlay | null = null;

    const pickDir = async (): Promise<void> => {
      try {
        const fd = new Gtk.FileDialog({ title: 'Dossier de la tâche', initialFolder: Gio.File.new_for_path(dir.peek()) });
        const root = parent.get_root();
        const f = await fd.select_folder(root instanceof Gtk.Window ? root : null, null);
        const p = f?.get_path();
        if (p !== null && p !== undefined) setDir(p);
      } catch {
        // cancelled
      }
    };

    const save = async (): Promise<void> => {
      const args = isNew ? ['add'] : ['edit', String(task.id)];
      // empty --model= / --agent= clear the value (default model / agent)
      args.push(
        `--name=${name.text.trim()}`, `--cron=${cron.text.trim()}`, `--dir=${dir.peek()}`,
        `--model=${model.text.trim()}`, `--agent=${agent.text.trim()}`, `--timeout=${timeout.text.trim() === '' ? '0' : timeout.text.trim()}`,
        catchUp.active ? '--catch-up' : '--no-catch-up',
        direnv.active ? '--direnv' : '--no-direnv',
        '--prompt=-',
      );
      if (!isNew) args.push('--clear-env');
      for (const line of bufferText(envBuffer).split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'))) {
        args.push(`--env=${line.replace(/^export\s+/u, '')}`);
      }
      // on edit, only when changed: re-enabling restarts the schedule from now
      if (isNew || enabled.active !== task.enabled) args.push(enabled.active ? '--enabled' : '--no-enabled');
      setSaving(true);
      try {
        await tg(args, TaskView, bufferText(promptBuffer));
        dialog?.close();
        onSaved(isNew ? 'Tâche créée' : 'Tâche enregistrée');
      } catch (error) {
        toasts?.add_toast(new Adw.Toast({ title: errorMessage(error), timeout: 6 }));
      } finally {
        setSaving(false);
      }
    };

    const dirRow = jsx(Adw.ActionRow, { title: 'Dossier', subtitle: dir });
    const pick = jsx(Gtk.Button, { iconName: 'folder-open-symbolic', tooltipText: 'Choisir…', valign: Gtk.Align.CENTER, cssClasses: ['flat'], onClicked: () => void pickDir() });
    dirRow.add_suffix(pick);
    dirRow.activatableWidget = pick;

    const header = jsx(Adw.HeaderBar, {});
    header.pack_end(jsx(Gtk.Button, { label: isNew ? 'Créer' : 'Enregistrer', cssClasses: ['suggested-action'], sensitive: saving((s) => !s), onClicked: () => void save() }));

    const page = jsx(Adw.PreferencesPage, {
      children: [
        jsx(Adw.PreferencesGroup, { description: CRON_HELP, children: [name, cron] }),
        jsx(Adw.PreferencesGroup, { title: 'Exécution', children: [dirRow, model, agent, timeout, catchUp, enabled] }),
        jsx(Adw.PreferencesGroup, {
          title: 'Environnement',
          description: 'Une variable par ligne, au format CLE=valeur. Stockées en clair dans la base taskgnome.',
          children: [direnv, textArea(envBuffer, 70, 12)],
        }),
        jsx(Adw.PreferencesGroup, {
          title: 'Prompt',
          description: 'Envoyé à opencode dans le dossier, avec toutes les permissions. Mets-y tout le contexte nécessaire.',
          children: [textArea(promptBuffer, 220)],
        }),
      ],
    });

    const view = jsx(Adw.ToolbarView, {
      content: jsx(Adw.ToastOverlay, { child: page, $: (self: Adw.ToastOverlay) => {
        toasts = self;
      } }),
    });
    view.add_top_bar(header);

    dialog = jsx(Adw.Dialog, {
      title: isNew ? 'Nouvelle tâche' : `Modifier « ${task.name} »`,
      contentWidth: 640,
      contentHeight: 720,
      child: view,
      onClosed: () => {
        dispose();
      },
    });
    dialog.present(parent);
    return dialog;
  });
}
