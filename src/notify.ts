// Desktop notifications through org.freedesktop.Notifications.
import { execFile } from 'node:child_process';
import dbus from 'dbus-next';
import { z } from 'zod';
import { env } from './env.ts';
import { errorMessage } from './util.ts';

export interface NotifyOptions {
  /** run shown when the notification is clicked (needs enableActions) */
  runId?: number;
  /** 0 = low, 1 = normal, 2 = critical (stays until dismissed) */
  urgency?: 0 | 1 | 2;
  /** id of a previous notification to replace */
  replaces?: number;
  icon?: string;
  timeoutMs?: number;
}

const DEST = 'org.freedesktop.Notifications';
const PATH = '/org/freedesktop/Notifications';
const IFACE = 'org.freedesktop.Notifications';

const escapeMarkup = (s: string): string => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/**
 * Sends a desktop notification. Returns its id, or 0 on failure. Never throws.
 * In the daemon (after enableActions) notifications are clickable and open the run.
 */
export function notify(summary: string, body: string, o: NotifyOptions = {}): Promise<number> {
  if (env('TASKGNOME_NO_NOTIFY') !== undefined) return Promise.resolve(0);
  if (session !== null) return notifyOverBus(session, summary, body, o);
  return notifyOverGdbus(summary, body, o);
}

/** One-shot call (CLI): gdbus disconnects right away, so no actions. */
/** GVariant string literal. */
const gv = (s: string): string => JSON.stringify(s);

function notifyOverGdbus(summary: string, body: string, o: NotifyOptions): Promise<number> {
  const args = [
    'call', '--session', '--dest', DEST, '--object-path', PATH, '--method', `${IFACE}.Notify`,
    '--', // otherwise the trailing "-1" timeout is parsed as an option
    gv('taskgnome'), String(o.replaces ?? 0), gv(o.icon ?? 'alarm-symbolic'), gv(summary), gv(escapeMarkup(body)),
    '@as []', `{'urgency': <byte ${o.urgency ?? 1}>}`, String(o.timeoutMs ?? -1),
  ];
  return new Promise((resolve) => {
    execFile('gdbus', args, { timeout: 5000 }, (error, stdout) => {
      if (error !== null) {
        console.error(`notification impossible: ${error.message.split('\n')[0] ?? ''}`);
        resolve(0);
        return;
      }
      resolve(Number(/uint32 (\d+)/u.exec(stdout)?.[1] ?? 0));
    });
  });
}

// ---------------------------------------------------------------- clickable notifications
// GNOME Shell sends ActionInvoked to the sender while its D-Bus connection is alive,
// so the daemon keeps a persistent connection.

interface Session {
  bus: dbus.MessageBus;
  /** notification id -> run id */
  runs: Map<number, number>;
}

let session: Session | null = null;

const NotifyReply = z.tuple([z.number().int()]);
const ActionInvoked = z.tuple([z.number().int(), z.string()]);
const NotificationClosed = z.tuple([z.number().int(), z.number().int()]);

export async function enableActions(onOpen: (runId: number) => void): Promise<void> {
  try {
    const bus = dbus.sessionBus();
    const s: Session = { bus, runs: new Map() };
    await bus.call(
      new dbus.Message({
        destination: 'org.freedesktop.DBus',
        path: '/org/freedesktop/DBus',
        interface: 'org.freedesktop.DBus',
        member: 'AddMatch',
        signature: 's',
        body: [`type='signal',interface='${IFACE}',path='${PATH}'`],
      }),
    );
    bus.on('message', (msg) => {
      if (msg.interface !== IFACE) return;
      if (msg.member === 'ActionInvoked') {
        const parsed = ActionInvoked.safeParse(msg.body);
        if (!parsed.success) return;
        const [id, action] = parsed.data;
        const run = s.runs.get(id);
        if (run !== undefined && (action === 'default' || action === 'open')) onOpen(run);
      } else if (msg.member === 'NotificationClosed') {
        const parsed = NotificationClosed.safeParse(msg.body);
        if (parsed.success) s.runs.delete(parsed.data[0]);
      }
    });
    session = s;
  } catch (error) {
    console.error(`notifications cliquables indisponibles: ${errorMessage(error)}`);
  }
}

async function notifyOverBus(s: Session, summary: string, body: string, o: NotifyOptions): Promise<number> {
  try {
    const actions = o.runId === undefined ? [] : ['default', 'Voir le run', 'open', 'Voir le run'];
    const reply = await s.bus.call(
      new dbus.Message({
        destination: DEST,
        path: PATH,
        interface: IFACE,
        member: 'Notify',
        signature: 'susssasa{sv}i',
        body: [
          'taskgnome', o.replaces ?? 0, o.icon ?? 'alarm-symbolic', summary, escapeMarkup(body), actions,
          { urgency: new dbus.Variant('y', o.urgency ?? 1) }, o.timeoutMs ?? -1,
        ],
      }),
    );
    const [id] = NotifyReply.parse(reply?.body);
    if (o.runId !== undefined) s.runs.set(id, o.runId);
    return id;
  } catch (error) {
    console.error(`notification impossible: ${errorMessage(error)}`);
    return 0;
  }
}
