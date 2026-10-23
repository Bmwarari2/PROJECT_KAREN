import { describe, expect, it } from 'vitest';
import { foldOther, niceTicks } from '../src/components/charts';

/** Chart helpers (DESIGN.md §6). Fictional values only. */
describe('niceTicks', () => {
  it('rounds the axis up from zero in about four steps', () => {
    expect(niceTicks(2)).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(niceTicks(100)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(0)).toEqual([0, 1]);
  });

  it('keeps every tick a whole number for counts', () => {
    expect(niceTicks(2, 4, true)).toEqual([0, 1, 2]);
    expect(niceTicks(1, 4, true)).toEqual([0, 1]);
    expect(niceTicks(7, 4, true)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(10, 4, true)).toEqual([0, 5, 10]);
    for (const max of [1, 3, 9, 13, 37, 250, 4_321])
      for (const tick of niceTicks(max, 4, true))
        expect(Number.isInteger(tick), `${max}: ${tick}`).toBe(true);
  });
});

describe('foldOther', () => {
  it('keeps at most six slices, the rest folded into one', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ label: `Fictional ${i}`, value: 8 - i }));
    const folded = foldOther(items, 'Other');
    expect(folded).toHaveLength(6);
    expect(folded.at(-1)).toEqual({ label: 'Other', value: 3 + 2 + 1 });
    expect(foldOther(items.slice(0, 3), 'Other')).toHaveLength(3);
  });
});
