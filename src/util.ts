import { Cron } from 'croner';

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/** "90", "90s", "30m", "2h", "1h30m" -> seconds. 0 = no timeout. */
export function parseDuration(v: string): number {
  if (/^\d+$/.test(v)) return Number(v);
  const re = /(\d+)\s*(h|m|s)/g;
  let total = 0;
  let matched = '';
  for (const m of v.matchAll(re)) {
    total += Number(m[1]) * { h: 3600, m: 60, s: 1 }[m[2] as 'h' | 'm' | 's'];
    matched += m[0];
  }
  if (!matched || matched.replace(/\s/g, '') !== v.replace(/\s/g, '')) throw new Error(`Durée invalide: ${v}`);
  return total;
}

/** Throws a readable error if the cron expression is invalid. */
export function validateCron(expr: string): void {
  try {
    new Cron(expr, { paused: true }).stop();
  } catch (e) {
    throw new Error(`Expression cron invalide "${expr}": ${(e as Error).message}`);
  }
}

export function nextRun(expr: string, from: Date = new Date()): Date | null {
  try {
    const c = new Cron(expr, { paused: true });
    const d = c.nextRun(from);
    c.stop();
    return d;
  } catch {
    return null;
  }
}

export function fmtDate(iso: string | Date | null | undefined): string {
  if (!iso) return '-';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const today = new Date();
  const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `aujourd'hui ${time}`;
  return `${d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} ${time}`;
}
