// Panel icon (badge = unseen failure / expired token) and its menu.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import { createComputed, createEffect, createState, onCleanup, onMount, This } from 'gnim';
import { register } from 'gnim/gobject';
import type { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Ack, FAILED_STATUSES, Launched, Overview, STATUS_ICON, type RunView, type TaskView } from '../../../src/shared/api.ts';
import type * as z from 'zod/mini';
import { errorMessage, tg } from '../common/cli.ts';
import { fmtDate, fmtDuration } from '../common/format.ts';
import { writeOpenRequest } from '../common/openRequest.ts';

const REFRESH_SECONDS = 20;
const RECENT_RUNS = 6;
const SEEN_FILE = GLib.build_filenamev([GLib.get_user_data_dir(), 'taskgnome', 'ext-seen-failure']);

/** Highest failed run id the user has already seen (opening the menu clears the red badge). */
function readSeen(): number {
  try {
    const [ok, bytes] = GLib.file_get_contents(SEEN_FILE);
    return ok ? Number(new TextDecoder().decode(bytes)) || 0 : 0;
  } catch {
    return 0;
  }
}

function writeSeen(id: number): void {
  try {
    GLib.mkdir_with_parents(GLib.path_get_dirname(SEEN_FILE), 0o755);
    GLib.file_set_contents(SEEN_FILE, String(id));
  } catch (error) {
    console.warn(`taskgnome: ${errorMessage(error)}`);
  }
}

const maxFailedId = (d: Overview | null): number =>
  Math.max(0, ...(d?.runs ?? []).filter((r) => FAILED_STATUSES.has(r.status)).map((r) => r.id));

const authBroken = (d: Overview | null): TaskView[] => (d?.tasks ?? []).filter((t) => t.last_run?.status === 'auth_error');

const icon = (name: string): Gio.Icon => Gio.ThemedIcon.new(name);

function label(text: string, style?: string): PopupMenu.PopupMenuItem {
  const item = new PopupMenu.PopupMenuItem(text, { reactive: false });
  if (style !== undefined) item.label.add_style_class_name(style);
  return item;
}

@register()
export class Indicator extends PanelMenu.Button {
  private readonly ext: Extension;
  private busy = false;
  private alive = true;
  private readonly setData: (d: Overview | null) => void;
  private readonly setError: (e: string | null) => void;
  private readonly setSeen: (n: number) => void;
  private readonly data: () => Overview | null;
  private readonly error: () => string | null;

  constructor(ext: Extension) {
    super(0.5, ext.uuid);
    this.ext = ext;

    const [data, setData] = createState<Overview | null>(null);
    const [error, setError] = createState<string | null>(null);
    const [seen, setSeen] = createState(readSeen());
    this.data = data;
    this.error = error;
    this.setData = setData;
    this.setError = setError;
    this.setSeen = setSeen;

    const running = data((d) => (d?.runs ?? []).some((r) => r.status === 'running'));
    const auth = data((d) => authBroken(d).length > 0);
    const badge = createComputed(() => auth() || maxFailedId(data()) > seen());
    const unreachable = createComputed(() => error() !== null || data()?.daemon === null);

    // rebuild the menu when data changes (not while it is open: it would close submenus)
    createEffect(() => {
      data();
      error();
      if (this.popup?.isOpen !== true) this.rebuildMenu();
    });

    this.popup?.connect('open-state-changed', (_menu: unknown, open: boolean) => {
      if (open) {
        this.markSeen();
        void this.refresh(true);
      }
    });

    const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
      void this.refresh();
      return GLib.SOURCE_CONTINUE;
    });
    onMount(() => {
      Main.panel.addToStatusArea(ext.uuid, this);
      void this.refresh();
    });
    onCleanup(() => {
      this.alive = false;
      GLib.source_remove(timer);
      this.destroy();
    });

    // <This> needs the concrete class, not the polymorphic `this` type
    void (
      <This<Indicator> this={this}>
        <St.Widget layoutManager={new Clutter.BinLayout()} yAlign={Clutter.ActorAlign.CENTER}>
          <St.Icon
            iconName="alarm-symbolic"
            class={running((r) => (r ? 'system-status-icon taskgnome-running' : 'system-status-icon'))}
            opacity={unreachable((u) => (u ? 128 : 255))}
          />
          <St.Widget
            class={auth((a) => (a ? 'taskgnome-badge auth' : 'taskgnome-badge'))}
            visible={badge}
            xAlign={Clutter.ActorAlign.END}
            yAlign={Clutter.ActorAlign.START}
            xExpand
            yExpand
          />
        </St.Widget>
      </This>
    );
  }

  async refresh(forceRebuild = false): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const d = await tg(['overview'], Overview);
      if (!this.alive) return;
      this.setData(d);
      this.setError(null);
    } catch (error) {
      if (this.alive) this.setError(errorMessage(error));
    } finally {
      this.busy = false;
    }
    if (this.alive && forceRebuild) this.rebuildMenu();
  }

  /** The button's menu (a PopupDummyMenu is never used here, but the type allows it). */
  private get popup(): PopupMenu.PopupMenu | null {
    return this.menu instanceof PopupMenu.PopupMenu ? this.menu : null;
  }

  private markSeen(): void {
    const max = maxFailedId(this.data());
    if (max > readSeen()) writeSeen(max);
    this.setSeen(Math.max(max, readSeen()));
  }

  private rebuildMenu(): void {
    const menu = this.popup;
    if (menu === null) return;
    menu.removeAll();
    const d = this.data();
    const error = this.error();

    if (error !== null) {
      menu.addMenuItem(label('taskgnome injoignable', 'taskgnome-alert'));
      menu.addMenuItem(label(error.slice(0, 120), 'taskgnome-dim'));
      menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      menu.addAction('Réessayer', () => void this.refresh(true));
      return;
    }
    if (d === null) {
      menu.addMenuItem(label('Chargement…', 'taskgnome-dim'));
      return;
    }

    const running = d.runs.filter((r) => r.status === 'running');
    const header = d.daemon === null
      ? 'Démon arrêté — les tâches ne seront pas lancées'
      : `Démon actif${running.length > 0 ? ` — ${running.length} en cours` : ''}`;
    menu.addMenuItem(label(header, d.daemon === null ? 'taskgnome-alert' : 'taskgnome-header'));

    for (const t of authBroken(d)) {
      const item = new PopupMenu.PopupMenuItem(`🔑 Token Claude expiré (${t.name}) — lance « claude » puis relance`);
      item.label.add_style_class_name('taskgnome-alert');
      item.connect('activate', () => {
        this.run(t);
      });
      menu.addMenuItem(item);
    }

    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Tâches'));
    if (d.tasks.length === 0) menu.addMenuItem(label('Aucune tâche', 'taskgnome-dim'));
    for (const t of d.tasks) menu.addMenuItem(this.taskItem(t, running.find((r) => r.task_id === t.id)));

    if (d.runs.length > 0) {
      menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Derniers runs'));
      for (const r of d.runs.slice(0, RECENT_RUNS)) {
        const item = new PopupMenu.PopupMenuItem(`${STATUS_ICON[r.status]}  ${r.task_name}  ·  ${fmtDate(r.started_at)}  ·  ${fmtDuration(r.duration_ms)}`);
        if (FAILED_STATUSES.has(r.status)) item.label.add_style_class_name('taskgnome-alert');
        item.connect('activate', () => {
          this.showRun(r);
        });
        menu.addMenuItem(item);
      }
    }

    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    menu.addAction("Gérer les tâches et l'historique…", () => {
      this.ext.openPreferences();
    }, icon('emblem-system-symbolic'));
  }

  private taskItem(t: TaskView, active: RunView | undefined): PopupMenu.PopupSubMenuMenuItem {
    const status = active === undefined ? (t.last_run === null ? '·' : STATUS_ICON[t.last_run.status]) : STATUS_ICON.running;
    const when = t.enabled ? (active === undefined ? fmtDate(t.next_run) : 'en cours…') : 'désactivée';
    const item = new PopupMenu.PopupSubMenuMenuItem(`${status}  ${t.name}   —   ${when}`, false);
    if (!t.enabled) item.label.add_style_class_name('taskgnome-dim');

    const sub = item.menu;
    if (active === undefined) sub.addAction('Lancer maintenant', () => {
      this.run(t);
    }, icon('media-playback-start-symbolic'));
    else sub.addAction(`Annuler le run #${active.id}`, () => {
      this.act(['cancel', String(active.id)], 'Annulation');
    }, icon('process-stop-symbolic'));
    const last = t.last_run;
    if (last !== null) sub.addAction(`Dernière sortie (${fmtDate(last.started_at)})`, () => {
      this.showRun(last);
    }, icon('document-open-recent-symbolic'));
    sub.addAction(t.enabled ? 'Désactiver' : 'Activer', () => {
      this.act([t.enabled ? 'disable' : 'enable', String(t.id)], 'Modification');
    }, icon(t.enabled ? 'media-playback-pause-symbolic' : 'object-select-symbolic'));
    sub.addMenuItem(label(`${t.cron}  ·  ${t.dir}`, 'taskgnome-dim'));
    return item;
  }

  private run(t: TaskView): void {
    this.act(['run', String(t.id)], `Lancement de ${t.name}`, Launched);
  }

  private act(args: string[], what: string, schema: z.ZodMiniType = Ack): void {
    tg(args, schema)
      .catch((error: unknown) => {
        Main.notifyError(`taskgnome: ${what} impossible`, errorMessage(error));
      })
      .finally(() => void this.refresh());
  }

  /** Opens the preferences window directly on this run. */
  private showRun(run: RunView): void {
    try {
      writeOpenRequest(run.id);
    } catch (error) {
      Main.notifyError('taskgnome', errorMessage(error));
      return;
    }
    this.menu.close();
    this.ext.openPreferences();
  }
}
