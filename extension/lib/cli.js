// Thin wrapper around the `taskgnome` CLI, shared by extension.js (gnome-shell) and prefs.js (Gtk).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

export const STATUS_ICON = {
    running: '⏳', success: '✓', error: '✗', auth_error: '🔑', timeout: '⌛', cancelled: '⏹',
};
export const FAILED = new Set(['error', 'auth_error', 'timeout']);

export function binPath() {
    const p = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'taskgnome']);
    if (GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE))
        return p;
    return GLib.find_program_in_path('taskgnome') ?? p;
}

/**
 * Runs `taskgnome <args>`. With json=true (default) appends --json and returns the parsed value.
 * Throws an Error carrying the CLI message on failure.
 */
export async function tg(args, {input = null, json = true} = {}) {
    const argv = [binPath(), ...args];
    if (json)
        argv.push('--json');
    let flags = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE;
    if (input !== null)
        flags |= Gio.SubprocessFlags.STDIN_PIPE;
    const proc = Gio.Subprocess.new(argv, flags);
    const [out, err] = await proc.communicate_utf8_async(input, null);
    if (!json) {
        if (!proc.get_successful())
            throw new Error((err || out || 'échec').trim());
        return out;
    }
    let data;
    try {
        data = JSON.parse(out);
    } catch {
        throw new Error((err || out || 'sortie invalide de taskgnome').trim());
    }
    if (data && data.ok === false)
        throw new Error(data.error);
    return data;
}

const pad = n => String(n).padStart(2, '0');

export function fmtDate(iso) {
    if (!iso)
        return '—';
    const d = new Date(iso);
    const now = new Date();
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.toDateString() === now.toDateString())
        return time;
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    if (d.toDateString() === tomorrow.toDateString())
        return `demain ${time}`;
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${time}`;
}

export function fmtDuration(ms) {
    if (ms === null || ms === undefined)
        return 'en cours';
    const s = Math.round(ms / 1000);
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}m${pad(s % 60)}s`;
    return `${Math.floor(m / 60)}h${pad(m % 60)}m`;
}

export function fmtSeconds(sec) {
    if (!sec)
        return '0';
    if (sec % 3600 === 0)
        return `${sec / 3600}h`;
    if (sec % 60 === 0)
        return `${sec / 60}m`;
    return `${sec}s`;
}
