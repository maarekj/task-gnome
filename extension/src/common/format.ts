const pad = (n: number): string => String(n).padStart(2, '0');

export function fmtDate(iso: string | null): string {
  if (iso === null) return '—';
  const d = new Date(iso);
  const now = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return time;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `demain ${time}`;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${time}`;
}

export function fmtDuration(ms: number | null): string {
  if (ms === null) return 'en cours';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${pad(s % 60)}s`;
  return `${Math.floor(m / 60)}h${pad(m % 60)}m`;
}

/** Seconds -> "30m", "1h", "90s". */
export function fmtSeconds(sec: number): string {
  if (sec === 0) return '0';
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}
