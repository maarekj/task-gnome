// Calls the `taskgnome` CLI. Shared by the shell extension and the preferences window.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import type * as z from 'zod/mini';
import { Failure } from '../../../src/shared/api.ts';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

function binPath(): string {
  const local = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'taskgnome']);
  if (GLib.file_test(local, GLib.FileTest.IS_EXECUTABLE)) return local;
  return GLib.find_program_in_path('taskgnome') ?? local;
}

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function spawn(args: readonly string[], input: string | null): Promise<{ ok: boolean; out: string; err: string }> {
  let flags = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE;
  if (input !== null) flags |= Gio.SubprocessFlags.STDIN_PIPE;
  const proc = Gio.Subprocess.new([binPath(), ...args], flags);
  const [out, err] = await proc.communicate_utf8_async(input, null);
  return { ok: proc.get_successful(), out: out ?? '', err: err ?? '' };
}

/** `taskgnome <args>` as text (human output). */
export async function tgText(args: readonly string[]): Promise<string> {
  const r = await spawn(args, null);
  if (!r.ok) throw new Error((r.err || r.out || 'échec de taskgnome').trim());
  return r.out;
}

/**
 * `taskgnome <args> --json`, validated against the shared contract.
 * Throws with the CLI's message on failure (JSON `{ok:false}` or argument errors on stderr).
 */
export async function tg<T>(args: readonly string[], schema: z.ZodMiniType<T>, input: string | null = null): Promise<T> {
  const r = await spawn([...args, '--json'], input);
  let raw: unknown;
  try {
    raw = JSON.parse(r.out);
  } catch {
    throw new Error((r.err || r.out || 'sortie invalide de taskgnome').trim());
  }
  const failure = Failure.safeParse(raw);
  if (failure.success) throw new Error(failure.data.error);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`Réponse inattendue de taskgnome: ${parsed.error.message}`);
  return parsed.data;
}
