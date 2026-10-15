import { Cron } from 'croner';

/** Exhaustiveness check for switches (unreachable at runtime). */
export function assertNever(value: never): never {
  throw new Error(`Valeur inattendue: ${JSON.stringify(value)}`);
}

/** Message of anything thrown. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

const UNIT_SECONDS = { h: 3600, m: 60, s: 1 } as const;
const compact = (s: string): string => s.replaceAll(/\s/gu, '');
const isUnit = (u: string): u is keyof typeof UNIT_SECONDS => Object.hasOwn(UNIT_SECONDS, u);

/** "90", "90s", "30m", "2h", "1h30m" -> seconds. 0 = no timeout. */
export function parseDuration(value: string): number {
  const v = value.trim();
  if (/^\d+$/u.test(v)) return Number(v);
  let total = 0;
  let matched = '';
  for (const m of v.matchAll(/(\d+)\s*([hms])/gu)) {
    const [whole, amount, unit] = m;
    if (amount === undefined || unit === undefined || !isUnit(unit)) continue;
    total += Number(amount) * UNIT_SECONDS[unit];
    matched += whole;
  }
  if (matched === '' || compact(matched) !== compact(v)) throw new Error(`Durée invalide: ${value}`);
  return total;
}

/** Throws a readable error if the cron expression is invalid. */
export function validateCron(expr: string): void {
  try {
    new Cron(expr, { paused: true }).stop();
  } catch (error) {
    throw new Error(`Expression cron invalide "${expr}": ${errorMessage(error)}`, { cause: error });
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

export function fmtDate(value: string | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-';
  const d = typeof value === 'string' ? new Date(value) : value;
  const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return `aujourd'hui ${time}`;
  return `${d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} ${time}`;
}

export const sleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};
