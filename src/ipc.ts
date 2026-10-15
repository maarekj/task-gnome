import net from 'node:net';
import { SOCKET_PATH } from './paths.ts';

export type Request =
  | { cmd: 'ping' }
  | { cmd: 'run'; task: number }
  | { cmd: 'cancel'; run: number }
  | { cmd: 'attach'; run: number };

/** Sends one request to the daemon. Resolves null if the daemon is not reachable. */
export function request<T = any>(req: Request, timeoutMs = 3000): Promise<T | null> {
  return new Promise((resolve) => {
    const sock = net.createConnection(SOCKET_PATH);
    let data = '';
    const done = (v: T | null) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => done(null));
    sock.on('error', () => done(null));
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
    sock.on('data', (c) => {
      data += c;
      const nl = data.indexOf('\n');
      if (nl >= 0) {
        try {
          done(JSON.parse(data.slice(0, nl)));
        } catch {
          done(null);
        }
      }
    });
  });
}
