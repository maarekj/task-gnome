// Protocol between the CLI and the daemon: one JSON line per request / response over a unix socket.
import net from 'node:net';
import { z } from 'zod';
import { SOCKET_PATH } from './paths.ts';
import { errorMessage } from './util.ts';

export const Request = z.discriminatedUnion('cmd', [
  z.object({ cmd: z.literal('ping') }),
  z.object({ cmd: z.literal('run'), task: z.number().int() }),
  z.object({ cmd: z.literal('cancel'), run: z.number().int() }),
  z.object({ cmd: z.literal('attach'), run: z.number().int() }),
]);
export type Request = z.output<typeof Request>;

const Failure = z.object({ ok: z.literal(false), error: z.string() });

export const PingResponse = z.object({
  ok: z.literal(true),
  pid: z.number().int(),
  running: z.array(z.number().int()),
  servers: z.array(z.object({ dir: z.string(), url: z.string(), clients: z.number().int() })),
});
export const RunResponse = z.object({ ok: z.literal(true), run: z.number().int() });
export const OkResponse = z.object({ ok: z.literal(true) });
export const AttachResponse = z.object({
  ok: z.literal(true),
  url: z.string(),
  password: z.string(),
  dir: z.string(),
  session: z.string(),
});

export type PingResponse = z.output<typeof PingResponse>;
export type AttachResponse = z.output<typeof AttachResponse>;

export class DaemonError extends Error {}

/** Raw exchange. Resolves null if the daemon is not reachable. */
async function exchange(req: Request, timeoutMs: number): Promise<unknown> {
  const line = await new Promise<string | null>((resolve) => {
    const sock = net.createConnection(SOCKET_PATH);
    let data = '';
    const done = (v: string | null): void => {
      sock.destroy();
      resolve(v);
    };
    sock.setEncoding('utf8');
    sock.setTimeout(timeoutMs, () => {
      done(null);
    });
    sock.on('error', () => {
      done(null);
    });
    sock.on('connect', () => {
      sock.write(`${JSON.stringify(req)}\n`);
    });
    sock.on('data', (chunk: string) => {
      data += chunk;
      const nl = data.indexOf('\n');
      if (nl >= 0) done(data.slice(0, nl));
    });
  });
  if (line === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (error) {
    throw new DaemonError(`Réponse invalide du démon: ${errorMessage(error)}`, { cause: error });
  }
  const failure = Failure.safeParse(raw);
  if (failure.success) throw new DaemonError(failure.data.error);
  return raw;
}

/**
 * Sends one request to the daemon and validates the answer.
 * Resolves null if the daemon is not reachable, throws DaemonError if it answered with an error.
 */
async function call<T>(req: Request, schema: z.ZodType<T>, timeoutMs = 3000): Promise<T | null> {
  const raw = await exchange(req, timeoutMs);
  return raw === null ? null : schema.parse(raw);
}

export const daemon = {
  ping: (timeoutMs?: number): Promise<PingResponse | null> => call({ cmd: 'ping' }, PingResponse, timeoutMs),
  run: (task: number): Promise<z.output<typeof RunResponse> | null> => call({ cmd: 'run', task }, RunResponse),
  cancel: (run: number): Promise<z.output<typeof OkResponse> | null> => call({ cmd: 'cancel', run }, OkResponse),
  attach: (run: number): Promise<AttachResponse | null> => call({ cmd: 'attach', run }, AttachResponse, 200_000),
} as const;

/** Union of every successful daemon answer (daemon side). */
export type Response = PingResponse | z.output<typeof RunResponse> | z.output<typeof OkResponse> | AttachResponse;
