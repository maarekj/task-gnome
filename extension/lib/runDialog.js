import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {STATUS_ICON, fmtDate, fmtDuration, tg} from './cli.js';
import {renderMarkdown} from './markdown.js';

function iconButton(icon, tooltip, cb) {
    const b = new Gtk.Button({icon_name: icon, tooltip_text: tooltip, valign: Gtk.Align.CENTER, css_classes: ['flat']});
    b.connect('clicked', cb);
    return b;
}

// ---------------------------------------------------------------- run detail (live conversation)

const TOOL_ICON = {completed: 'object-select-symbolic', error: 'dialog-error-symbolic'};

function label(text, {css = [], mono = false, selectable = true, xalign = 0} = {}) {
    const l = new Gtk.Label({
        label: text, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, xalign, selectable,
        css_classes: mono ? ['monospace', ...css] : css,
    });
    return l;
}

function section(title, child, css = []) {
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
    box.append(label(title, {css: ['heading', ...css], selectable: false}));
    box.append(child);
    return box;
}

export class RunDialog {
    constructor(window, run) {
        this.window = window;
        this.run = run;
        this.signature = '';
        this.expanded = new Set();
        this.timer = 0;

        this.dialog = new Adw.Dialog({title: `Run #${run.id}${run.task_name ? ` — ${run.task_name}` : ''}`, content_width: 900, content_height: 760});
        const view = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        view.add_top_bar(header);

        this.banner = new Adw.Banner({title: 'En cours — mise à jour automatique', revealed: false});
        view.add_top_bar(this.banner);

        // discussion
        this.list = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 18,
            margin_top: 18, margin_bottom: 24, margin_start: 18, margin_end: 18});
        this.scroll = new Gtk.ScrolledWindow({vexpand: true, child: new Adw.Clamp({maximum_size: 860, child: this.list})});

        // raw events
        this.rawBuffer = new Gtk.TextBuffer();
        const rawView = new Gtk.TextView({buffer: this.rawBuffer, editable: false, monospace: true,
            wrap_mode: Gtk.WrapMode.WORD_CHAR, top_margin: 12, bottom_margin: 12, left_margin: 12, right_margin: 12});

        this.stack = new Adw.ViewStack();
        this.stack.add_titled_with_icon(this.scroll, 'chat', 'Discussion', 'chat-bubbles-text-symbolic');
        this.stack.add_titled_with_icon(new Gtk.ScrolledWindow({child: rawView}), 'raw', 'Événements bruts', 'text-x-generic-symbolic');
        this.stack.connect('notify::visible-child-name', () => this.load(true));
        header.set_title_widget(new Adw.ViewSwitcher({stack: this.stack, policy: Adw.ViewSwitcherPolicy.WIDE}));
        view.set_content(this.stack);

        const copy = iconButton('edit-copy-symbolic', 'Copier la discussion', async () => {
            try {
                const txt = await tg(['logs', String(this.run.id)], {json: false});
                this.dialog.get_clipboard().set(txt);
                this.toast('Copié');
            } catch (e) {
                this.toast(e.message);
            }
        });
        this.action = new Gtk.Button({label: 'Relancer'});
        this.action.connect('clicked', () => this.onAction());
        // continue the opencode session: open in a terminal / copy the command
        const copyCmd = new Gtk.Button({
            child: new Adw.ButtonContent({icon_name: 'edit-copy-symbolic', label: 'Copier la commande'}),
            css_classes: ['flat'],
        });
        copyCmd.connect('clicked', () => {
            this.copyCommand();
            popover.popdown();
        });
        const popover = new Gtk.Popover({child: copyCmd});
        const resume = new Adw.SplitButton({
            child: new Adw.ButtonContent({icon_name: 'utilities-terminal-symbolic', label: 'Continuer'}),
            tooltip_text: 'Ouvrir la session opencode dans un terminal',
            dropdown_tooltip: 'Autres options',
            popover,
        });
        resume.connect('clicked', () => this.openTerminal());

        header.pack_start(copy);
        header.pack_end(this.action);
        header.pack_end(resume);

        this.toastOverlay = new Adw.ToastOverlay({child: view});
        this.dialog.set_child(this.toastOverlay);
        this.dialog.connect('closed', () => this.stopPolling());
    }

    async copyCommand() {
        try {
            const res = await tg(['resume', String(this.run.id), '--print']);
            this.dialog.get_clipboard().set(res.command);
            this.toast('Commande copiée — colle-la dans un terminal');
        } catch (e) {
            this.toast(e.message);
        }
    }

    async openTerminal() {
        this.toast('Ouverture de la session…');
        try {
            const res = await tg(['resume', String(this.run.id)]);
            this.toast(`Session ouverte dans ${res.terminal}`);
        } catch (e) {
            this.toast(e.message);
        }
    }

    toast(msg) {
        this.toastOverlay.add_toast(new Adw.Toast({title: msg, timeout: 3}));
    }

    present() {
        this.dialog.present(this.window);
        this.load();
    }

    /** Run currently active in the session, or the most recent one. */
    current() {
        const runs = this.runs ?? [];
        return runs.find(r => r.status === 'running') ?? runs[runs.length - 1] ?? this.run;
    }

    async onAction() {
        const cur = this.current();
        try {
            if (cur.status === 'running') {
                await tg(['cancel', String(cur.id)]);
                this.toast('Annulation demandée');
            } else {
                const res = await tg(['run', String(this.run.task_id)]);
                this.toast(`« ${this.run.task_name} » relancée (nouvelle session)`);
                // follow the new run (new session) in the same dialog
                this.run = {...this.run, id: res.run, status: 'running'};
                this.runs = null;
                this.dialog.title = `Run #${res.run} — ${this.run.task_name}`;
                this.load(true);
            }
        } catch (e) {
            this.toast(e.message);
        }
    }

    stopPolling() {
        this.closed = true;
        if (this.timer) {
            GLib.source_remove(this.timer);
            this.timer = 0;
        }
    }

    async load(force = false) {
        if (this.closed)
            return;
        if (force)
            this.signature = '';
        const wasRunning = this.current().status === 'running';
        try {
            if (this.stack.visible_child_name === 'raw') {
                const out = await tg(['logs', String(this.current().id), '--raw'], {json: false});
                this.rawBuffer.text = out || '(aucun événement pour le moment)';
            }
            const data = await tg(['logs', String(this.run.id), '--transcript']);
            this.runs = data.session_runs?.length ? data.session_runs : [{...data}];
            if (this.run.task_id === undefined) {
                // opened from a bare run id (notification / panel menu)
                this.run = {...this.run, task_id: data.task_id, task_name: data.task_name};
                this.dialog.title = `Run #${data.id} — ${data.task_name}`;
            }
            const sig = JSON.stringify(this.runs.map(r => [r.id, r.status, r.error, r.transcript]));
            if (sig !== this.signature) {
                this.signature = sig;
                this.render();
            }
        } catch (e) {
            this.toast(e.message);
        }
        if (this.closed)
            return;

        const cur = this.current();
        const running = cur.status === 'running';
        this.banner.title = running && cur.trigger === 'interactive'
            ? 'Nouveau message en cours de traitement — mise à jour automatique'
            : 'En cours — mise à jour automatique';
        this.banner.revealed = running;
        this.action.label = running ? 'Annuler' : 'Relancer';
        this.action.css_classes = running ? ['destructive-action'] : [];
        if (wasRunning && !running)
            this.toast(`Terminé : ${STATUS_ICON[cur.status]} ${cur.status}`);

        // keep following the session while the dialog is open: a message can arrive from a terminal at any time
        if (this.timer)
            GLib.source_remove(this.timer);
        this.timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, running ? 2 : 4, () => {
            this.timer = 0;
            this.load();
            return GLib.SOURCE_REMOVE;
        });
    }

    render() {
        const runs = this.runs;
        const cur = this.current();
        const adj = this.scroll.vadjustment;
        const atBottom = adj.value + adj.page_size >= adj.upper - 40;
        const keepValue = adj.value;
        const grew = this.lastCount !== undefined && runs.length > this.lastCount;
        this.lastCount = runs.length;

        let child;
        while ((child = this.list.get_first_child()))
            this.list.remove(child);

        // session summary
        const sum = new Adw.PreferencesGroup();
        const cost = runs.reduce((t, r) => t + (r.cost ?? 0), 0);
        const tokens = runs.reduce((t, r) => t + (r.tokens ?? 0), 0);
        const meta = [`${fmtDate(runs[0].started_at)}`, runs.length > 1 ? `${runs.length} runs` : fmtDuration(cur.duration_ms), cur.trigger];
        if (cost)
            meta.push(`$${cost.toFixed(3)}`);
        if (tokens)
            meta.push(`${Math.round(tokens / 1000)}k tokens`);
        const row = new Adw.ActionRow({
            title: GLib.markup_escape_text(`${STATUS_ICON[cur.status] ?? '?'}  ${cur.status}`, -1),
            subtitle: GLib.markup_escape_text(meta.join('  ·  '), -1),
        });
        if (cur.session_id) {
            row.add_suffix(iconButton('edit-copy-symbolic', 'Copier la commande pour continuer la session', () => this.copyCommand()));
            row.add_suffix(iconButton('utilities-terminal-symbolic', 'Continuer dans un terminal', () => this.openTerminal()));
        }
        sum.add(row);
        this.list.append(sum);

        runs.forEach((r, i) => {
            if (runs.length > 1) {
                const head = new Gtk.Box({spacing: 10, margin_top: i ? 10 : 0});
                head.append(new Gtk.Separator({valign: Gtk.Align.CENTER, hexpand: true}));
                head.append(label(
                    `${STATUS_ICON[r.status] ?? '?'}  Run #${r.id} · ${r.trigger === 'interactive' ? 'message depuis le terminal' : r.trigger} · ${fmtDate(r.started_at)} · ${fmtDuration(r.duration_ms)}`,
                    {css: ['dim-label', 'caption'], selectable: false, xalign: 0.5}));
                head.append(new Gtk.Separator({valign: Gtk.Align.CENTER, hexpand: true}));
                this.list.append(head);
            }
            if (r.error)
                this.list.append(section('Erreur', label(r.error, {mono: true, css: ['error']}), ['error']));
            this.renderTranscript(r.transcript ?? []);
            if (r.status === 'running') {
                const sp = new Gtk.Box({spacing: 8, halign: Gtk.Align.CENTER});
                sp.append(new Adw.Spinner());
                sp.append(label('opencode travaille…', {css: ['dim-label'], selectable: false}));
                this.list.append(sp);
            }
        });

        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            adj.value = atBottom && (cur.status === 'running' || grew) ? adj.upper : keepValue;
            return GLib.SOURCE_REMOVE;
        });
    }

    renderTranscript(entries) {
        let toolList = null;
        for (const e of entries) {
            if (e.kind !== 'tool')
                toolList = null;
            switch (e.kind) {
            case 'prompt': {
                const l = renderMarkdown(e.text);
                l.set_margin_start(12);
                l.set_margin_end(12);
                l.set_margin_top(10);
                l.set_margin_bottom(10);
                this.list.append(section('Prompt', new Gtk.Frame({child: l}), ['accent']));
                break;
            }
            case 'text':
                this.list.append(section('Assistant', renderMarkdown(e.text)));
                break;
            case 'reasoning':
                this.list.append(section('Réflexion', label(e.text, {css: ['dim-label']}), ['dim-label']));
                break;
            case 'error':
                this.list.append(label(`✗ ${e.text}`, {mono: true, css: ['error']}));
                break;
            case 'tool':
                if (!toolList) {
                    toolList = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
                    this.list.append(toolList);
                }
                toolList.append(this.toolRow(e));
                break;
            }
        }
    }

    toolRow(e) {
        const head = (e.title || e.input.split('\n')[0] || '').slice(0, 160);
        const row = new Adw.ExpanderRow({title: GLib.markup_escape_text(e.tool, -1), subtitle: GLib.markup_escape_text(head, -1), subtitle_lines: 1});
        if (TOOL_ICON[e.status]) {
            const icon = new Gtk.Image({icon_name: TOOL_ICON[e.status]});
            icon.add_css_class(e.status === 'error' ? 'error' : 'success');
            row.add_prefix(icon);
        } else {
            row.add_prefix(new Adw.Spinner());
        }
        const body = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8,
            margin_top: 10, margin_bottom: 12, margin_start: 12, margin_end: 12});
        if (e.input)
            body.append(section('Entrée', label(e.input, {mono: true})));
        if (e.output)
            body.append(section(e.status === 'error' ? 'Erreur' : 'Sortie', label(e.output, {mono: true, css: e.status === 'error' ? ['error'] : []})));
        row.add_row(body);
        row.expanded = this.expanded.has(e.id);
        row.connect('notify::expanded', () => {
            if (row.expanded)
                this.expanded.add(e.id);
            else
                this.expanded.delete(e.id);
        });
        return row;
    }
}
