import { execFile } from 'node:child_process';

import dbus from 'dbus-next';

export interface NotifyOptions {
  /** run shown when the notification is clicked (daemon only, see enableActions) */
  runId?: number;
  /** 0 = low, 1 = normal, 2 = critical (stays until dismissed) */
  urgency?: 0 | 1 | 2;
  /** id of a previous notification to replace */
  replaces?: number;
  icon?: string;
  timeoutMs?: number;
}

/** GVariant string literal (JSON escaping is compatible). */
const gv = (s: string) => JSON.stringify(s);
const escapeMarkup = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Sends a desktop notification through org.freedesktop.Notifications (via gdbus,
 * so no notify-send dependency). Returns the notification id, or 0 on failure.
 * Never throws.
 */
export function notify(summary: string, body: string, o: NotifyOptions = {}): Promise<number> {
  if (process.env.TASKGNOME_NO_NOTIFY) return Promise.resolve(0);
  if (actions) return notifyWithActions(summary, body, o);
  const args = [
    'call', '--session',
    '--dest', 'org.freedesktop.Notifications',
    '--object-path', '/org/freedesktop/Notifications',
    '--method', 'org.freedesktop.Notifications.Notify',
    '--', // otherwise the trailing "-1" timeout is parsed as an option and the call fails
    gv('taskgnome'),
    String(o.replaces ?? 0),
    gv(o.icon ?? 'alarm-symbolic'),
    gv(summary),
    gv(escapeMarkup(body)),
    '@as []',
    `{'urgency': <byte ${o.urgency ?? 1}>}`,
    String(o.timeoutMs ?? -1),
  ];
  return new Promise((resolve) => {
    execFile('gdbus', args, { timeout: 5000 }, (err, stdout) => {
      if (err) {
        console.error(`notification impossible: ${err.message.split('\n')[0]}`);
        return resolve(0);
      }
      const m = /uint32 (\d+)/.exec(stdout);
      resolve(m ? Number(m[1]) : 0);
    });
  });
}

// ---- clickable notifications (long-lived process only) ----
// GNOME Shell sends ActionInvoked to the sender while its D-Bus connection is alive,
// so the daemon keeps a persistent connection instead of one-shot gdbus calls.

let actions: { iface: any; runs: Map<number, number> } | null = null;

export async function enableActions(onOpen: (runId: number) => void): Promise<void> {
  try {
    const bus = dbus.sessionBus();
    const obj = await bus.getProxyObject('org.freedesktop.Notifications', '/org/freedesktop/Notifications');
    const iface = obj.getInterface('org.freedesktop.Notifications');
    const runs = new Map<number, number>(); // notification id -> run id
    iface.on('ActionInvoked', (id: number, action: string) => {
      const run = runs.get(id);
      if (run !== undefined && (action === 'default' || action === 'open')) onOpen(run);
    });
    iface.on('NotificationClosed', (id: number) => runs.delete(id));
    actions = { iface, runs };
  } catch (e) {
    console.error(`notifications cliquables indisponibles: ${(e as Error).message}`);
  }
}

async function notifyWithActions(summary: string, body: string, o: NotifyOptions): Promise<number> {
  try {
    const acts = o.runId !== undefined ? ['default', 'Voir le run', 'open', 'Voir le run'] : [];
    const id: number = await actions!.iface.Notify(
      'taskgnome', o.replaces ?? 0, o.icon ?? 'alarm-symbolic', summary, escapeMarkup(body), acts,
      { urgency: new dbus.Variant('y', o.urgency ?? 1) }, o.timeoutMs ?? -1,
    );
    if (o.runId !== undefined) actions!.runs.set(id, o.runId);
    return id;
  } catch (e) {
    console.error(`notification impossible: ${(e as Error).message}`);
    return 0;
  }
}
