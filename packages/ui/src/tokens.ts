/**
 * Design tokens — the single source for docs/DESIGN.md. tokens.css is generated from this file
 * (pnpm --filter @thapsus/ui tokens) and test/tokens.test.ts fails if it is stale.
 */
export type Mode = 'light' | 'dark';

export const colors = {
  bg: { light: '#ffffff', dark: '#0a0a0b' },
  surface: { light: '#f5f5f7', dark: '#161618' },
  'surface-raised': { light: '#ffffff', dark: '#1c1c1f' },
  'surface-inverse': { light: '#111113', dark: '#f5f5f7' },
  text: { light: '#1d1d1f', dark: '#f5f5f7' },
  'text-secondary': { light: '#5f5f66', dark: '#a8a8ae' },
  'text-inverse': { light: '#f5f5f7', dark: '#111113' },
  border: { light: '#d2d2d7', dark: '#3a3a3f' },
  'border-strong': { light: '#8e8e93', dark: '#6e6e73' },
  accent: { light: '#0b6b63', dark: '#5fd3c6' },
  'accent-hover': { light: '#085650', dark: '#86e0d6' },
  'on-accent': { light: '#ffffff', dark: '#04201d' },
  'accent-subtle': { light: '#e6f2f1', dark: '#0f2e2b' },
  success: { light: '#1b7a3a', dark: '#5fd38a' },
  warning: { light: '#8a5a00', dark: '#f2c14e' },
  danger: { light: '#b42318', dark: '#ff7b72' },
  'on-danger': { light: '#ffffff', dark: '#2a0705' },
} as const satisfies Record<string, Record<Mode, string>>;

export type ColorToken = keyof typeof colors;

/** Text/background pairs that must meet WCAG 2.2 AA (4.5:1) in both modes. */
export const TEXT_PAIRS: Array<[fg: ColorToken, bg: ColorToken]> = [
  ['text', 'bg'],
  ['text', 'surface'],
  ['text', 'surface-raised'],
  ['text', 'accent-subtle'],
  ['text-secondary', 'bg'],
  ['text-secondary', 'surface'],
  ['text-secondary', 'surface-raised'],
  ['text-inverse', 'surface-inverse'],
  ['accent', 'bg'],
  ['accent', 'surface'],
  ['accent', 'surface-raised'],
  ['accent', 'accent-subtle'],
  ['on-accent', 'accent'],
  ['on-accent', 'accent-hover'],
  ['success', 'bg'],
  ['success', 'surface'],
  ['warning', 'bg'],
  ['warning', 'surface'],
  ['danger', 'bg'],
  ['danger', 'surface'],
  ['on-danger', 'danger'],
];

/** Non-text UI pairs (control borders, focus ring) that must meet 3:1. */
export const UI_PAIRS: Array<[fg: ColorToken, bg: ColorToken]> = [
  ['border-strong', 'bg'],
  ['border-strong', 'surface-raised'],
  ['accent', 'bg'],
  ['accent', 'surface'],
];

export const fontStack = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif';

export const typeScale = {
  display: { size: 80, line: 84, phoneSize: 48, phoneLine: 52, weight: 700, tracking: '-0.03em' },
  headline: { size: 56, line: 60, phoneSize: 36, phoneLine: 40, weight: 700, tracking: '-0.025em' },
  'title-1': { size: 40, line: 44, phoneSize: 30, phoneLine: 34, weight: 700, tracking: '-0.02em' },
  'title-2': { size: 28, line: 32, weight: 600, tracking: '-0.015em' },
  'title-3': { size: 21, line: 26, weight: 600, tracking: '-0.01em' },
  'body-lg': { size: 21, line: 30, weight: 400, tracking: '0' },
  body: { size: 17, line: 26, weight: 400, tracking: '0' },
  callout: { size: 15, line: 22, weight: 400, tracking: '0' },
  footnote: { size: 13, line: 18, weight: 400, tracking: '0' },
} as const;

export const space = [0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128] as const;
export const radii = { sm: 8, md: 12, lg: 18, xl: 28, pill: 9999 } as const;
export const shadows = {
  sm: '0 1px 2px rgb(0 0 0 / 0.06)',
  md: '0 4px 16px rgb(0 0 0 / 0.08)',
  lg: '0 12px 40px rgb(0 0 0 / 0.12)',
} as const;
export const motion = {
  'duration-fast': '120ms',
  'duration-base': '200ms',
  'duration-slow': '320ms',
  'duration-reveal': '600ms',
  'ease-standard': 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  'ease-exit': 'cubic-bezier(0.4, 0, 1, 1)',
} as const;
export const layout = {
  'content-width': '980px',
  'content-wide': '1200px',
  'app-width': '1440px',
  'prose-width': '680px',
  'sidebar-width': '248px',
  'topbar-height': '56px',
  'nav-height': '48px',
} as const;

// ---- WCAG contrast ----------------------------------------------------------------------
function channel(c: number) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
export function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
export function contrast(a: string, b: string) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

// ---- CSS generation --------------------------------------------------------------------
function modeVars(mode: Mode) {
  return Object.entries(colors)
    .map(([k, v]) => `  --color-${k}: ${v[mode]};`)
    .join('\n');
}

export function tokensCss(): string {
  const statics = [
    `  --font-sans: ${fontStack};`,
    ...space.map((v, i) => `  --space-${i}: ${v}px;`),
    ...Object.entries(radii).map(([k, v]) => `  --radius-${k}: ${v}px;`),
    ...Object.entries(shadows).map(([k, v]) => `  --shadow-${k}: ${v};`),
    ...Object.entries(motion).map(([k, v]) => `  --${k}: ${v};`),
    ...Object.entries(layout).map(([k, v]) => `  --${k}: ${v};`),
    ...Object.entries(typeScale).flatMap(([k, v]) => [
      `  --text-${k}: ${v.size}px;`,
      `  --text-${k}--line-height: ${v.line}px;`,
      `  --text-${k}--letter-spacing: ${v.tracking};`,
      `  --text-${k}--font-weight: ${v.weight};`,
    ]),
  ].join('\n');
  const phone = Object.entries(typeScale)
    .filter(([, v]) => 'phoneSize' in v)
    .map(
      ([k, v]) =>
        `    --text-${k}: ${(v as { phoneSize: number }).phoneSize}px;\n    --text-${k}--line-height: ${(v as { phoneLine: number }).phoneLine}px;`,
    )
    .join('\n');
  return `/* GENERATED from packages/ui/src/tokens.ts — do not edit by hand. Tailwind v4 theme. */
@theme {
  --color-*: initial;
  --radius-*: initial;
  --shadow-*: initial;
  --font-*: initial;
  --text-*: initial;
  --spacing: 4px;
${statics}
${modeVars('light')}
}
:root {
  color-scheme: light;
}
@media (max-width: 767px) {
  :root {
${phone}
  }
}
:root[data-theme='dark'] {
  color-scheme: dark;
${modeVars('dark')}
  --shadow-sm: 0 0 0 1px var(--color-border);
  --shadow-md: 0 0 0 1px var(--color-border);
  --shadow-lg: 0 0 0 1px var(--color-border);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    color-scheme: dark;
${modeVars('dark').replace(/^ {2}/gm, '    ')}
    --shadow-sm: 0 0 0 1px var(--color-border);
    --shadow-md: 0 0 0 1px var(--color-border);
    --shadow-lg: 0 0 0 1px var(--color-border);
  }
}
@media (prefers-reduced-motion: reduce) {
  :root {
    --duration-fast: 0ms;
    --duration-base: 0ms;
    --duration-slow: 0ms;
    --duration-reveal: 0ms;
  }
}
`;
}
