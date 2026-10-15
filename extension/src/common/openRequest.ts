// "Open the preferences window on run N": written by the panel menu (and the CLI), read by prefs.
import GLib from 'gi://GLib';
import { OPEN_REQUEST_FILE, OPEN_REQUEST_MAX_AGE_MS, OpenRequest } from '../../../src/shared/api.ts';

export const OPEN_REQUEST = GLib.build_filenamev([GLib.get_user_data_dir(), 'taskgnome', OPEN_REQUEST_FILE]);

export function writeOpenRequest(run: number): void {
  GLib.mkdir_with_parents(GLib.path_get_dirname(OPEN_REQUEST), 0o755);
  GLib.file_set_contents(OPEN_REQUEST, JSON.stringify({ run, ts: Date.now() } satisfies OpenRequest));
}

/** Requested run id (the request is consumed), or null. */
export function takeOpenRequest(): number | null {
  try {
    const [ok, bytes] = GLib.file_get_contents(OPEN_REQUEST);
    if (!ok) return null;
    GLib.unlink(OPEN_REQUEST);
    const req = OpenRequest.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    if (!req.success || Date.now() - req.data.ts > OPEN_REQUEST_MAX_AGE_MS) return null;
    return req.data.run;
  } catch {
    return null;
  }
}
