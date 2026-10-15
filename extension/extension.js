import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {FAILED, STATUS_ICON, fmtDate, fmtDuration, tg} from './lib/cli.js';

const REFRESH_SECONDS = 20;
const OPEN_REQUEST = GLib.build_filenamev([GLib.get_user_data_dir(), 'taskgnome', 'open-request.json']);
const SEEN_FILE = GLib.build_filenamev([GLib.get_user_data_dir(), 'taskgnome', 'ext-seen-failure']);

function readSeen() {
    try {
        const [ok, bytes] = GLib.file_get_contents(SEEN_FILE);
        return ok ? Number(new TextDecoder().decode(bytes)) || 0 : 0;
    } catch {
        return 0;
    }
}

function writeSeen(id) {
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(SEEN_FILE), 0o755);
        GLib.file_set_contents(SEEN_FILE, String(id));
    } catch (e) {
        console.warn(`taskgnome: ${e.message}`);
    }
}

function notifyError(title, err) {
    Main.notifyError(title, err?.message ?? String(err));
}

const TaskIndicator = GObject.registerClass(
class TaskIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'taskgnome');
        this._ext = ext;
        this._data = null;
        this._error = null;
        this._busy = false;
        this._destroyed = false;
        this._seen = readSeen();

        const stack = new St.Widget({layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({icon_name: 'alarm-symbolic', style_class: 'system-status-icon'});
        this._badge = new St.Widget({
            style_class: 'taskgnome-badge',
            visible: false,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_expand: true,
        });
        stack.add_child(this._icon);
        stack.add_child(this._badge);
        this.add_child(stack);

        this.menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                this._markSeen();
                this.refresh(true);
            }
        });

        this._rebuildMenu();
        this.refresh();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async refresh(forceRebuild = false) {
        if (this._busy)
            return;
        this._busy = true;
        try {
            this._data = await tg(['overview']);
            this._error = null;
        } catch (e) {
            this._error = e.message;
        } finally {
            this._busy = false;
        }
        if (this._destroyed)
            return;
        this._updateIcon();
        if (forceRebuild || !this.menu.isOpen)
            this._rebuildMenu();
    }

    _authBroken() {
        return (this._data?.tasks ?? []).filter(t => t.last_run?.status === 'auth_error');
    }

    _maxFailedId() {
        return Math.max(0, ...(this._data?.runs ?? []).filter(r => FAILED.has(r.status)).map(r => r.id));
    }

    _markSeen() {
        const max = this._maxFailedId();
        if (max > this._seen) {
            this._seen = max;
            writeSeen(max);
        }
        this._updateIcon();
    }

    _updateIcon() {
        const d = this._data;
        const running = (d?.runs ?? []).some(r => r.status === 'running');
        const auth = this._authBroken().length > 0;
        const unseen = this._maxFailedId() > this._seen;

        if (running)
            this._icon.add_style_class_name('taskgnome-running');
        else
            this._icon.remove_style_class_name('taskgnome-running');
        this._icon.opacity = this._error || (d && !d.daemon) ? 128 : 255;

        this._badge.visible = auth || unseen;
        if (auth)
            this._badge.add_style_class_name('auth');
        else
            this._badge.remove_style_class_name('auth');
    }

    _label(text, style) {
        const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
        if (style)
            item.label.add_style_class_name(style);
        return item;
    }

    _rebuildMenu() {
        const menu = this.menu;
        menu.removeAll();
        const d = this._data;

        if (this._error) {
            menu.addMenuItem(this._label('taskgnome injoignable', 'taskgnome-alert'));
            menu.addMenuItem(this._label(this._error.slice(0, 120), 'taskgnome-dim'));
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            menu.addAction('Réessayer', () => this.refresh(true));
            return;
        }
        if (!d) {
            menu.addMenuItem(this._label('Chargement…', 'taskgnome-dim'));
            return;
        }

        const running = d.runs.filter(r => r.status === 'running');
        const header = d.daemon
            ? `Démon actif${running.length ? ` — ${running.length} en cours` : ''}`
            : 'Démon arrêté — les tâches ne seront pas lancées';
        menu.addMenuItem(this._label(header, d.daemon ? 'taskgnome-header' : 'taskgnome-alert'));

        for (const t of this._authBroken()) {
            const item = new PopupMenu.PopupMenuItem(`🔑 Token Claude expiré (${t.name}) — lance « claude » puis relance`);
            item.label.add_style_class_name('taskgnome-alert');
            item.connect('activate', () => this._run(t));
            menu.addMenuItem(item);
        }

        // ---- tasks
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Tâches'));
        if (!d.tasks.length)
            menu.addMenuItem(this._label('Aucune tâche', 'taskgnome-dim'));
        for (const t of d.tasks)
            menu.addMenuItem(this._taskItem(t, running.find(r => r.task_id === t.id)));

        // ---- recent runs
        if (d.runs.length) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Derniers runs'));
            for (const r of d.runs.slice(0, 6)) {
                const item = new PopupMenu.PopupMenuItem(
                    `${STATUS_ICON[r.status] ?? '?'}  ${r.task_name}  ·  ${fmtDate(r.started_at)}  ·  ${fmtDuration(r.duration_ms)}`);
                if (FAILED.has(r.status))
                    item.label.add_style_class_name('taskgnome-alert');
                item.connect('activate', () => this._showLog(r));
                menu.addMenuItem(item);
            }
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction('Gérer les tâches et l\'historique…', () => this._ext.openPreferences(), 'emblem-system-symbolic');
    }

    _taskItem(t, activeRun) {
        const status = activeRun ? STATUS_ICON.running : t.last_run ? STATUS_ICON[t.last_run.status] : '·';
        const when = !t.enabled ? 'désactivée' : activeRun ? 'en cours…' : fmtDate(t.next_run);
        const item = new PopupMenu.PopupSubMenuMenuItem(`${status}  ${t.name}   —   ${when}`);
        if (!t.enabled)
            item.label.add_style_class_name('taskgnome-dim');

        const sub = item.menu;
        if (activeRun)
            sub.addAction(`Annuler le run #${activeRun.id}`, () => this._do(['cancel', String(activeRun.id)], 'Annulation'), 'process-stop-symbolic');
        else
            sub.addAction('Lancer maintenant', () => this._run(t), 'media-playback-start-symbolic');
        if (t.last_run)
            sub.addAction(`Dernière sortie (${fmtDate(t.last_run.started_at)})`, () => this._showLog(t.last_run), 'document-open-recent-symbolic');
        sub.addAction(t.enabled ? 'Désactiver' : 'Activer',
            () => this._do([t.enabled ? 'disable' : 'enable', String(t.id)], 'Modification'),
            t.enabled ? 'media-playback-pause-symbolic' : 'object-select-symbolic');
        sub.addMenuItem(this._label(`${t.cron}  ·  ${t.dir}`, 'taskgnome-dim'));
        return item;
    }

    _run(t) {
        this._do(['run', String(t.id)], `Lancement de ${t.name}`);
    }

    async _do(args, what) {
        try {
            await tg(args);
        } catch (e) {
            notifyError(`taskgnome: ${what} impossible`, e);
        }
        this.refresh();
    }

    /** Opens the preferences window directly on this run (read by prefs.js). */
    _showLog(run) {
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(OPEN_REQUEST), 0o755);
            GLib.file_set_contents(OPEN_REQUEST, JSON.stringify({run: run.id, ts: Date.now()}));
        } catch (e) {
            notifyError('taskgnome', e);
            return;
        }
        this.menu.close();
        this._ext.openPreferences();
    }

    destroy() {
        this._destroyed = true;
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
        super.destroy();
    }
});

export default class TaskGnomeExtension extends Extension {
    enable() {
        this._indicator = new TaskIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
