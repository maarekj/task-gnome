import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {FAILED, STATUS_ICON, fmtDate, fmtDuration, fmtSeconds, tg} from './lib/cli.js';
import {RunDialog} from './lib/runDialog.js';

Gio._promisify(Gtk.FileDialog.prototype, 'select_folder', 'select_folder_finish');

const CRON_HELP = 'min heure jour-du-mois mois jour-semaine — ex. « 0 9 * * 1-5 » (9h en semaine), « */30 * * * * », @hourly, @daily';

export default class TaskGnomePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(860, 720);
        window.set_search_enabled(false);
        new TasksPage(window);
        const history = new HistoryPage(window);

        // "open on a run" requests (notification click, panel menu, `taskgnome open <run>`)
        const consume = () => {
            const run = takeOpenRequest();
            if (run === null)
                return;
            window.visible_page = history.page;
            history.showRun({id: run});
            window.present();
        };
        consume();
        const file = Gio.File.new_for_path(OPEN_REQUEST);
        const monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
        monitor.connect('changed', (_m, _f, _o, ev) => {
            if (ev === Gio.FileMonitorEvent.CHANGES_DONE_HINT || ev === Gio.FileMonitorEvent.CREATED)
                consume();
        });
        window._taskgnomeMonitor = monitor; // keep a reference
        window.connect('close-request', () => {
            monitor.cancel();
            return false;
        });
    }
}

const OPEN_REQUEST = GLib.build_filenamev([GLib.get_user_data_dir(), 'taskgnome', 'open-request.json']);

/** Returns the requested run id (and deletes the request), or null. */
function takeOpenRequest() {
    try {
        const [ok, bytes] = GLib.file_get_contents(OPEN_REQUEST);
        if (!ok)
            return null;
        GLib.unlink(OPEN_REQUEST);
        const req = JSON.parse(new TextDecoder().decode(bytes));
        if (!req.run || Date.now() - req.ts > 60_000)
            return null;
        return Number(req.run);
    } catch {
        return null;
    }
}

function toast(window, msg) {
    window.add_toast(new Adw.Toast({title: msg, timeout: 4}));
}

function iconButton(icon, tooltip, cb, cls = 'flat') {
    const b = new Gtk.Button({icon_name: icon, tooltip_text: tooltip, valign: Gtk.Align.CENTER, css_classes: [cls]});
    b.connect('clicked', cb);
    return b;
}

// ---------------------------------------------------------------- tasks

class TasksPage {
    constructor(window) {
        this.window = window;
        this.page = new Adw.PreferencesPage({title: 'Tâches', icon_name: 'alarm-symbolic'});
        window.add(this.page);

        const suffix = new Gtk.Box({spacing: 6});
        suffix.append(iconButton('view-refresh-symbolic', 'Rafraîchir', () => this.reload()));
        const add = new Gtk.Button({label: 'Nouvelle tâche', css_classes: ['suggested-action'], valign: Gtk.Align.CENTER});
        add.connect('clicked', () => this.openEditor(null));
        suffix.append(add);

        this.status = new Adw.PreferencesGroup();
        this.page.add(this.status);
        this.statusRow = new Adw.ActionRow({title: 'Chargement…'});
        this.status.add(this.statusRow);

        this.group = new Adw.PreferencesGroup({title: 'Tâches planifiées', header_suffix: suffix});
        this.page.add(this.group);
        this.rows = [];
        this.reload();
    }

    async reload() {
        let data;
        try {
            data = await tg(['overview']);
        } catch (e) {
            this.statusRow.title = 'taskgnome injoignable';
            this.statusRow.subtitle = e.message;
            return;
        }
        this.statusRow.title = data.daemon ? `Démon actif (pid ${data.daemon.pid})` : 'Démon arrêté';
        this.statusRow.subtitle = data.daemon
            ? 'Les tâches sont planifiées et lancées automatiquement.'
            : 'Démarre-le : systemctl --user start taskgnome (ou taskgnome install)';

        for (const r of this.rows)
            this.group.remove(r);
        this.rows = [];
        if (!data.tasks.length) {
            const empty = new Adw.ActionRow({title: 'Aucune tâche', subtitle: 'Clique sur « Nouvelle tâche » pour commencer.'});
            this.rows.push(empty);
            this.group.add(empty);
        }
        for (const t of data.tasks) {
            const row = this.taskRow(t);
            this.rows.push(row);
            this.group.add(row);
        }
    }

    taskRow(t) {
        const last = t.last_run ? `${STATUS_ICON[t.last_run.status]} ${fmtDate(t.last_run.started_at)}` : 'jamais lancée';
        const next = t.enabled ? `prochaine : ${fmtDate(t.next_run)}` : 'désactivée';
        const row = new Adw.ActionRow({
            title: GLib.markup_escape_text(t.name, -1),
            subtitle: GLib.markup_escape_text(`${t.cron}  ·  ${next}  ·  dernier : ${last}\n${t.dir}`, -1),
            subtitle_lines: 2,
            activatable: true,
        });
        row.connect('activated', () => this.openEditor(t));

        const sw = new Gtk.Switch({active: t.enabled, valign: Gtk.Align.CENTER, tooltip_text: 'Activer / désactiver'});
        sw.connect('notify::active', () => this.act([sw.active ? 'enable' : 'disable', String(t.id)]));
        row.add_suffix(iconButton('media-playback-start-symbolic', 'Lancer maintenant', async () => {
            await this.act(['run', String(t.id)]);
            toast(this.window, `« ${t.name} » lancée`);
        }));
        row.add_suffix(iconButton('document-edit-symbolic', 'Modifier', () => this.openEditor(t)));
        row.add_suffix(iconButton('user-trash-symbolic', 'Supprimer', () => this.confirmDelete(t)));
        row.add_suffix(sw);
        return row;
    }

    async act(args) {
        try {
            await tg(args);
        } catch (e) {
            toast(this.window, e.message);
        }
        this.reload();
    }

    confirmDelete(t) {
        const dlg = new Adw.AlertDialog({
            heading: `Supprimer « ${t.name} » ?`,
            body: 'La tâche et tout son historique seront supprimés.',
        });
        dlg.add_response('cancel', 'Annuler');
        dlg.add_response('delete', 'Supprimer');
        dlg.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dlg.connect('response', (_d, resp) => {
            if (resp === 'delete')
                this.act(['rm', String(t.id)]);
        });
        dlg.present(this.window);
    }

    openEditor(t) {
        const isNew = !t;
        const dialog = new Adw.Dialog({title: isNew ? 'Nouvelle tâche' : `Modifier « ${t.name} »`, content_width: 640, content_height: 720});
        const view = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        const save = new Gtk.Button({label: isNew ? 'Créer' : 'Enregistrer', css_classes: ['suggested-action']});
        header.pack_end(save);
        view.add_top_bar(header);

        const page = new Adw.PreferencesPage();
        const g1 = new Adw.PreferencesGroup();
        const name = new Adw.EntryRow({title: 'Nom', text: t?.name ?? ''});
        const cron = new Adw.EntryRow({title: 'Planification (cron)', text: t?.cron ?? '0 9 * * 1-5'});
        g1.add(name);
        g1.add(cron);
        g1.set_description(CRON_HELP);
        page.add(g1);

        const g2 = new Adw.PreferencesGroup({title: 'Exécution'});
        let dir = t?.dir ?? GLib.get_home_dir();
        const dirRow = new Adw.ActionRow({title: 'Dossier', subtitle: dir});
        const pick = iconButton('folder-open-symbolic', 'Choisir…', async () => {
            try {
                const fd = new Gtk.FileDialog({title: 'Dossier de la tâche', initial_folder: Gio.File.new_for_path(dir)});
                const f = await fd.select_folder(this.window, null);
                if (f) {
                    dir = f.get_path();
                    dirRow.subtitle = dir;
                }
            } catch {
                /* cancelled */
            }
        });
        dirRow.add_suffix(pick);
        dirRow.activatable_widget = pick;
        const model = new Adw.EntryRow({title: 'Modèle (provider/model, vide = défaut)', text: t?.model ?? ''});
        const agent = new Adw.EntryRow({title: 'Agent (vide = défaut)', text: t?.agent ?? ''});
        const timeout = new Adw.EntryRow({title: 'Timeout (ex. 30m, 1h, 0 = aucun)', text: t ? fmtSeconds(t.timeout_sec) : '30m'});
        const catchUp = new Adw.SwitchRow({
            title: 'Rattraper les exécutions manquées',
            subtitle: 'Après une veille ou un PC éteint, lance une fois la tâche en retard',
            active: t ? t.catch_up : true,
        });
        const enabled = new Adw.SwitchRow({title: 'Activée', active: t ? t.enabled : true});
        for (const w of [dirRow, model, agent, timeout, catchUp, enabled])
            g2.add(w);
        page.add(g2);

        const gEnv = new Adw.PreferencesGroup({
            title: 'Environnement',
            description: 'Une variable par ligne, au format CLE=valeur. Stockées en clair dans la base taskgnome.',
        });
        const direnv = new Adw.SwitchRow({
            title: 'Charger direnv',
            subtitle: 'Lance opencode via « direnv exec » pour charger le .envrc du dossier (il doit avoir été autorisé avec direnv allow)',
            active: t ? t.direnv : false,
        });
        gEnv.add(direnv);
        const envBuffer = new Gtk.TextBuffer({
            text: Object.entries(t?.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
        });
        const envView = new Gtk.TextView({
            buffer: envBuffer, monospace: true, wrap_mode: Gtk.WrapMode.CHAR,
            top_margin: 8, bottom_margin: 8, left_margin: 8, right_margin: 8,
        });
        const envScroll = new Gtk.ScrolledWindow({child: envView, min_content_height: 70, css_classes: ['card'], margin_top: 12});
        gEnv.add(envScroll);
        page.add(gEnv);

        const g3 = new Adw.PreferencesGroup({
            title: 'Prompt',
            description: 'Envoyé à « opencode run » dans le dossier, avec toutes les permissions. Mets-y tout le contexte nécessaire.',
        });
        const buffer = new Gtk.TextBuffer({text: t?.prompt ?? ''});
        const tv = new Gtk.TextView({
            buffer, wrap_mode: Gtk.WrapMode.WORD_CHAR, monospace: true,
            top_margin: 8, bottom_margin: 8, left_margin: 8, right_margin: 8,
        });
        const sc = new Gtk.ScrolledWindow({child: tv, min_content_height: 220, css_classes: ['card']});
        g3.add(sc);
        page.add(g3);

        const toastOverlay = new Adw.ToastOverlay({child: page});
        view.set_content(toastOverlay);
        dialog.set_child(view);

        save.connect('clicked', async () => {
            const prompt = buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false);
            const args = isNew ? ['add'] : ['edit', String(t.id)];
            args.push(`--name=${name.text.trim()}`, `--cron=${cron.text.trim()}`, `--dir=${dir}`,
                `--model=${model.text.trim()}`, `--agent=${agent.text.trim()}`, `--timeout=${timeout.text.trim() || '0'}`,
                catchUp.active ? (isNew ? '' : '--catch-up') : '--no-catch-up', '--prompt=-');
            args.push(direnv.active ? '--direnv' : (isNew ? '' : '--no-direnv'));
            if (!isNew)
                args.push('--clear-env');
            const envText = envBuffer.get_text(envBuffer.get_start_iter(), envBuffer.get_end_iter(), false);
            for (const line of envText.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')))
                args.push(`--env=${line.replace(/^export\s+/, '')}`);
            if (isNew && !enabled.active)
                args.push('--disabled');
            if (!isNew && enabled.active !== t.enabled)
                args.push(enabled.active ? '--enable' : '--disable');
            save.sensitive = false;
            try {
                await tg(args.filter(Boolean), {input: prompt});
                dialog.close();
                toast(this.window, isNew ? 'Tâche créée' : 'Tâche enregistrée');
                this.reload();
            } catch (e) {
                toastOverlay.add_toast(new Adw.Toast({title: e.message, timeout: 6}));
            } finally {
                save.sensitive = true;
            }
        });
        dialog.present(this.window);
    }
}

// ---------------------------------------------------------------- history

class HistoryPage {
    constructor(window) {
        this.window = window;
        this.page = new Adw.PreferencesPage({title: 'Historique', icon_name: 'document-open-recent-symbolic'});
        window.add(this.page);

        const suffix = new Gtk.Box({spacing: 6});
        this.failedOnly = new Gtk.ToggleButton({label: 'Erreurs seulement', valign: Gtk.Align.CENTER});
        this.failedOnly.connect('toggled', () => this.reload());
        suffix.append(this.failedOnly);
        suffix.append(iconButton('view-refresh-symbolic', 'Rafraîchir', () => this.reload()));

        this.group = new Adw.PreferencesGroup({title: 'Derniers runs', header_suffix: suffix});
        this.page.add(this.group);
        this.rows = [];
        this.reload();

        // refresh when the page becomes visible
        window.connect('notify::visible-page', () => {
            if (window.visible_page === this.page)
                this.reload();
        });
    }

    async reload() {
        let runs;
        try {
            runs = await tg(['history', '--limit', '100', ...(this.failedOnly.active ? ['--failed'] : [])]);
        } catch (e) {
            toast(this.window, e.message);
            return;
        }
        for (const r of this.rows)
            this.group.remove(r);
        this.rows = [];
        if (!runs.length) {
            const empty = new Adw.ActionRow({title: 'Aucun run'});
            this.rows.push(empty);
            this.group.add(empty);
        }
        for (const r of runs) {
            const err = r.error ? `  ·  ${r.error.split('\n')[0].slice(0, 90)}` : '';
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(`${STATUS_ICON[r.status] ?? '?'}  ${r.task_name}`, -1),
                subtitle: GLib.markup_escape_text(
                    `#${r.id}  ·  ${fmtDate(r.started_at)}  ·  ${fmtDuration(r.duration_ms)}  ·  ${r.trigger}${err}`, -1),
                activatable: true,
            });
            if (FAILED.has(r.status))
                row.add_css_class('error');
            row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
            row.connect('activated', () => this.showRun(r));
            this.rows.push(row);
            this.group.add(row);
        }
    }

    showRun(r) {
        // a single run dialog at a time
        this.dialog?.dialog.close();
        this.dialog = new RunDialog(this.window, r);
        this.dialog.present();
    }
}

