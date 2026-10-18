import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { colors, contrast, TEXT_PAIRS, tokensCss, UI_PAIRS, type Mode } from '../src/tokens';

describe.each<Mode>(['light', 'dark'])('WCAG 2.2 AA contrast (%s mode)', (mode) => {
  it.each(TEXT_PAIRS)('text %s on %s ≥ 4.5:1', (fg, bg) => {
    expect(contrast(colors[fg][mode], colors[bg][mode])).toBeGreaterThanOrEqual(4.5);
  });
  it.each(UI_PAIRS)('UI %s on %s ≥ 3:1', (fg, bg) => {
    expect(contrast(colors[fg][mode], colors[bg][mode])).toBeGreaterThanOrEqual(3);
  });
});

describe('generated CSS', () => {
  it('theme.css is up to date with tokens.ts', () => {
    const onDisk = readFileSync(join(__dirname, '..', 'src', 'theme.css'), 'utf8').replace(/\r\n/g, '\n');
    expect(onDisk).toBe(tokensCss());
  });
  it('defines exactly one accent colour', () => {
    expect(Object.keys(colors).filter((k) => k === 'accent')).toHaveLength(1);
  });
});
