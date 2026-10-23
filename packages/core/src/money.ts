/**
 * Money is always an integer number of minor units plus an ISO 4217 code. Never floating point.
 */
export interface Money {
  amountMinor: bigint;
  currency: string;
}

/** Minor-unit exponent per currency (ISO 4217). Currencies not listed default to 2. */
const EXPONENTS: Record<string, number> = {
  JPY: 0,
  KRW: 0,
  ISK: 0,
  HUF: 2,
  CLP: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
  TND: 3,
};

export const SUPPORTED_CURRENCIES = [
  'GBP',
  'EUR',
  'USD',
  'SEK',
  'PLN',
  'DKK',
  'CHF',
  'CZK',
  'HUF',
  'RON',
  'NOK',
  'BGN',
  'CAD',
  'AUD',
  'JPY',
] as const;

export function currencyExponent(currency: string): number {
  return EXPONENTS[currency.toUpperCase()] ?? 2;
}

function assertCurrency(c: string) {
  if (!/^[A-Z]{3}$/.test(c)) throw new RangeError(`Invalid ISO 4217 code: ${c}`);
}

export function money(amountMinor: bigint | number, currency: string): Money {
  assertCurrency(currency);
  if (typeof amountMinor === 'number' && !Number.isInteger(amountMinor)) {
    throw new RangeError('Money amounts must be integer minor units');
  }
  return { amountMinor: BigInt(amountMinor), currency };
}

function same(a: Money, b: Money) {
  if (a.currency !== b.currency) throw new RangeError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
}

export const add = (a: Money, b: Money): Money => (
  same(a, b),
  { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency }
);
export const subtract = (a: Money, b: Money): Money => (
  same(a, b),
  { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency }
);

/** Banker's-free half-up rounding of a rational multiply: amount * num / den. */
export function multiplyRatio(a: Money, num: bigint | number, den: bigint | number = 1n): Money {
  const n = BigInt(num);
  const d = BigInt(den);
  if (d === 0n) throw new RangeError('Division by zero');
  const product = a.amountMinor * n;
  const q = product / d;
  const r = product % d;
  const absR2 = (r < 0n ? -r : r) * 2n;
  const absD = d < 0n ? -d : d;
  const neg = product < 0n !== d < 0n;
  const rounded = absR2 >= absD ? q + (neg ? -1n : 1n) : q;
  return { amountMinor: rounded, currency: a.currency };
}

/** Splits money into n parts whose sum equals the original (largest remainder first). */
export function allocate(a: Money, parts: number): Money[] {
  const n = BigInt(parts);
  const base = a.amountMinor / n;
  let remainder = a.amountMinor - base * n;
  return Array.from({ length: parts }, () => {
    const extra = remainder > 0n ? 1n : remainder < 0n ? -1n : 0n;
    remainder -= extra;
    return { amountMinor: base + extra, currency: a.currency };
  });
}

/** Parses a decimal string ("1234.5") into minor units without floating point. */
export function parseDecimal(value: string, currency: string): Money {
  assertCurrency(currency);
  const exp = currencyExponent(currency);
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new RangeError(`Invalid decimal amount: ${value}`);
  const frac = (m[3] ?? '').padEnd(exp, '0');
  if (frac.length > exp) throw new RangeError(`Too many decimal places for ${currency}: ${value}`);
  const minor = BigInt(m[2]! + frac);
  return { amountMinor: m[1] ? -minor : minor, currency };
}

export function toDecimalString(a: Money): string {
  const exp = currencyExponent(a.currency);
  const neg = a.amountMinor < 0n;
  const abs = (neg ? -a.amountMinor : a.amountMinor).toString().padStart(exp + 1, '0');
  const int = exp ? abs.slice(0, -exp) : abs;
  const frac = exp ? '.' + abs.slice(-exp) : '';
  return `${neg ? '-' : ''}${int}${frac}`;
}
