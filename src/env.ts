/** Environment variable, `undefined` when unset or empty. */
export function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}
