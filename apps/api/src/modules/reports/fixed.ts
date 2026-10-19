/**
 * Fixed-point helpers for report arithmetic. Every calculation runs on integers (bigint) and is rounded
 * ONCE at the end, half away from zero (the same rule as @thapsus/core/money multiplyRatio).
 */

/** Integer division rounded half away from zero. */
export function roundDiv(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError('Division by zero');
  const q = n / d;
  const r = n % d;
  const absR2 = (r < 0n ? -r : r) * 2n;
  const absD = d < 0n ? -d : d;
  if (absR2 < absD) return q;
  return n < 0n !== d < 0n ? q - 1n : q + 1n;
}

/**
 * Converts a decimal value from the leave engine (already rounded to at most 4 dp) to integer
 * ten-thousandths. Math.round only removes binary representation noise (e.g. 12.3 * 10000 = 122999.99…).
 */
export const e4 = (x: number): bigint => BigInt(Math.round(x * 10_000));

/** Parses a PostgreSQL numeric string ("0.8000", "37.5", "-2") to an integer at `scale` decimal places. */
export function parseScaled(value: string | number | null | undefined, scale: number): bigint {
  if (value === null || value === undefined || value === '') return 0n;
  const s = String(value).trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new RangeError(`Not a decimal: ${s}`);
  const frac = (m[3] ?? '').padEnd(scale + 1, '0');
  // round half away from zero on the first dropped digit
  let v = BigInt(m[2]! + frac.slice(0, scale));
  if (Number(frac[scale]) >= 5) v += 1n;
  return m[1] ? -v : v;
}

/** Formats an integer at `fromScale` decimal places as a fixed-point string with `toScale` places. */
export function formatScaled(value: bigint, fromScale: number, toScale: number): string {
  let v = value;
  if (toScale < fromScale) v = roundDiv(value, 10n ** BigInt(fromScale - toScale));
  else if (toScale > fromScale) v = value * 10n ** BigInt(toScale - fromScale);
  const neg = v < 0n;
  const abs = (neg ? -v : v).toString().padStart(toScale + 1, '0');
  const int = toScale ? abs.slice(0, -toScale) : abs;
  const frac = toScale ? `.${abs.slice(-toScale)}` : '';
  return `${neg ? '-' : ''}${int}${frac}`;
}

/** numerator / denominator × 100 as a fixed-point percentage string, or null when the denominator is 0. */
export function percent(numerator: bigint, denominator: bigint, scale = 2): string | null {
  if (denominator === 0n) return null;
  const scaled = roundDiv(numerator * 100n * 10n ** BigInt(scale), denominator);
  return formatScaled(scaled, scale, scale);
}
