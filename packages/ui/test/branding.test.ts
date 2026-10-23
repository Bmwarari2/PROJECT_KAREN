import { describe, expect, it } from 'vitest';
import { brandingCss, checkBrandAccent, derivePalette, mix, paletteChecks } from '../src/branding';
import { colors, contrast } from '../src/tokens';

describe('custom brand accent (WCAG 2.2 AA in light and dark mode)', () => {
  it('accepts the design-token accents themselves', () => {
    const r = checkBrandAccent({ light: colors.accent.light, dark: colors.accent.dark });
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('accepts a dark navy and derives a passing dark-mode accent when none is given', () => {
    const r = checkBrandAccent({ light: '#1f3a8a' });
    expect(r.ok).toBe(true);
    expect(r.darkDerived).toBe(true);
    for (const surface of ['bg', 'surface', 'surface-raised'] as const) {
      expect(contrast(r.palette.light.accent, colors[surface].light)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(r.palette.dark.accent, colors[surface].dark)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(r.palette.light.onAccent, r.palette.light.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(r.palette.dark.onAccent, r.palette.dark.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ['#ffff00', 'bright yellow on white'],
    ['#7fbfff', 'pastel blue on white'],
    ['#888888', 'mid grey'],
  ])('rejects %s (%s) in light mode', (hex) => {
    const r = checkBrandAccent({ light: hex, dark: colors.accent.dark });
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.mode === 'light' && f.pair === 'accent/bg')).toBe(true);
  });

  it('rejects a dark-mode accent that fails on the dark surfaces even when light mode passes', () => {
    const r = checkBrandAccent({ light: '#1f3a8a', dark: '#1f3a8a' });
    expect(r.ok).toBe(false);
    expect(r.failures.every((f) => f.mode === 'dark')).toBe(true);
    expect(r.failures.map((f) => f.pair)).toContain('accent/bg');
  });

  it('checks the hover, on-accent and subtle variants too', () => {
    const p = derivePalette('#0b6b63', 'light');
    const pairs = paletteChecks(p, 'light').map((c) => c.pair);
    expect(pairs).toEqual(
      expect.arrayContaining([
        'on-accent/accent',
        'on-accent/accent-hover',
        'text/accent-subtle',
        'accent-hover/bg',
        'focus/bg',
      ]),
    );
  });

  it('refuses anything that is not #RRGGBB (no CSS injection)', () => {
    expect(() => checkBrandAccent({ light: 'red;}body{display:none' })).toThrow();
    expect(() =>
      brandingCss({
        light: { ...derivePalette('#0b6b63', 'light'), accent: 'url(x)' },
        dark: derivePalette('#5fd3c6', 'dark'),
      }),
    ).toThrow();
  });

  it('generates CSS variables for both modes', () => {
    const r = checkBrandAccent({ light: '#1f3a8a' });
    const css = brandingCss(r.palette);
    expect(css).toContain(`--color-accent: ${r.palette.light.accent};`);
    expect(css).toContain(":root[data-theme='dark']");
    expect(css).toContain('prefers-color-scheme: dark');
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
  });
});
