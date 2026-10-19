import { colors, contrast, type Mode } from './tokens';

/**
 * Custom branding: a customer accent colour replaces the single design-token accent only if every
 * accent pair the design system tests (TEXT_PAIRS / UI_PAIRS in tokens.ts) still meets WCAG 2.2 AA
 * against the token surfaces, in light AND dark mode. The hover, on-accent and subtle variants are
 * derived here so they are checked too; the API stores the validated palette and the app shell
 * applies it as CSS variables.
 */
export const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

export interface BrandPalette {
  accent: string;
  accentHover: string;
  onAccent: string;
  accentSubtle: string;
}
export interface ContrastCheck {
  mode: Mode;
  /** e.g. "accent/bg" — foreground/background. */
  pair: string;
  ratio: number;
  required: number;
  pass: boolean;
}
export interface BrandCheckResult {
  ok: boolean;
  palette: Record<Mode, BrandPalette>;
  checks: ContrastCheck[];
  failures: ContrastCheck[];
  /** True when the dark-mode accent was derived from the light one. */
  darkDerived: boolean;
}

const TEXT = 4.5;
const UI = 3;

function parse(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function toHex([r, g, b]: [number, number, number]) {
  return `#${[r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`;
}
/** Linear mix in sRGB: t = 0 → a, t = 1 → b. */
export function mix(a: string, b: string, t: number): string {
  const [x, y] = [parse(a), parse(b)];
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

export function derivePalette(accent: string, mode: Mode): BrandPalette {
  const a = accent.toLowerCase();
  const accentHover = mode === 'light' ? mix(a, '#000000', 0.18) : mix(a, '#ffffff', 0.25);
  const candidates = ['#ffffff', colors['surface-inverse'].light, colors['on-accent'][mode]];
  const onAccent = candidates.reduce((best, c) => (Math.min(contrast(c, a), contrast(c, accentHover)) > Math.min(contrast(best, a), contrast(best, accentHover)) ? c : best));
  const accentSubtle = mix(colors.bg[mode], a, mode === 'light' ? 0.1 : 0.2);
  return { accent: a, accentHover, onAccent, accentSubtle };
}

export function paletteChecks(p: BrandPalette, mode: Mode): ContrastCheck[] {
  const c = (fg: string, fgName: string, bg: string, bgName: string, required: number): ContrastCheck => {
    const ratio = Math.round(contrast(fg, bg) * 100) / 100;
    return { mode, pair: `${fgName}/${bgName}`, ratio, required, pass: contrast(fg, bg) >= required };
  };
  return [
    c(p.accent, 'accent', colors.bg[mode], 'bg', TEXT),
    c(p.accent, 'accent', colors.surface[mode], 'surface', TEXT),
    c(p.accent, 'accent', colors['surface-raised'][mode], 'surface-raised', TEXT),
    c(p.accent, 'accent', p.accentSubtle, 'accent-subtle', TEXT),
    c(p.accentHover, 'accent-hover', colors.bg[mode], 'bg', TEXT),
    c(colors.text[mode], 'text', p.accentSubtle, 'accent-subtle', TEXT),
    c(p.onAccent, 'on-accent', p.accent, 'accent', TEXT),
    c(p.onAccent, 'on-accent', p.accentHover, 'accent-hover', TEXT),
    // Focus ring and control borders (non-text contrast).
    c(p.accent, 'focus', colors.bg[mode], 'bg', UI),
    c(p.accent, 'focus', colors.surface[mode], 'surface', UI),
  ];
}

/**
 * Validates a brand accent. `dark` is optional: when omitted, the light accent is used if it passes in
 * dark mode, otherwise it is lightened step by step until it does.
 */
export function checkBrandAccent(input: { light: string; dark?: string | null }): BrandCheckResult {
  if (!HEX_COLOUR.test(input.light) || (input.dark && !HEX_COLOUR.test(input.dark))) throw new Error('Colours must be #RRGGBB');
  const light = derivePalette(input.light, 'light');
  let dark: BrandPalette;
  let darkDerived = false;
  if (input.dark) dark = derivePalette(input.dark, 'dark');
  else {
    darkDerived = true;
    dark = derivePalette(input.light, 'dark');
    for (let t = 0.05; t < 1 && paletteChecks(dark, 'dark').some((x) => !x.pass); t += 0.05) dark = derivePalette(mix(input.light, '#ffffff', t), 'dark');
  }
  const checks = [...paletteChecks(light, 'light'), ...paletteChecks(dark, 'dark')];
  const failures = checks.filter((x) => !x.pass);
  return { ok: failures.length === 0, palette: { light, dark }, checks, failures, darkDerived };
}

/** CSS that overrides the accent tokens for both modes (values are validated hex only). */
export function brandingCss(p: Record<Mode, BrandPalette>): string {
  for (const m of ['light', 'dark'] as const) for (const v of Object.values(p[m])) if (!HEX_COLOUR.test(v)) throw new Error('invalid colour');
  const vars = (x: BrandPalette, indent: string) =>
    [`--color-accent: ${x.accent};`, `--color-accent-hover: ${x.accentHover};`, `--color-on-accent: ${x.onAccent};`, `--color-accent-subtle: ${x.accentSubtle};`].map((l) => `${indent}${l}`).join('\n');
  return `:root {\n${vars(p.light, '  ')}\n}\n:root[data-theme='dark'] {\n${vars(p.dark, '  ')}\n}\n@media (prefers-color-scheme: dark) {\n  :root:not([data-theme='light']) {\n${vars(p.dark, '    ')}\n  }\n}\n`;
}
