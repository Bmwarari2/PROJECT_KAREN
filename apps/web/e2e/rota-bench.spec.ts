import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Route } from '@playwright/test';
import { signUpAndEnrol } from './helpers';

// UK English labels (the catalogue's en-US variant says "Schedule" and "Time clock").
test.use({ locale: 'en-GB' });

/**
 * Rota grid at enterprise scale (PROGRESS 4.1): 10,000 fictional shift workers with a five-shift week
 * each (50,000 shifts), served through the same keyset-paged /v1/rota contract. Measures first render,
 * a jump to the middle, frame times while scrolling, and that only a window of rows is in the DOM.
 * API latency at this scale is measured separately by scripts/bench-rota.ts.
 */
const WORKERS = 10_000;
const ROW = 48;

function syntheticPage(url: URL) {
  const weekStart = url.searchParams.get('weekStart')!;
  const limit = Number(url.searchParams.get('limit') ?? 100);
  const cursor = url.searchParams.get('cursor');
  const from = cursor ? Number(JSON.parse(Buffer.from(cursor, 'base64url').toString())[0]) : 0;
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${weekStart}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
  const rows = [];
  for (let i = from; i < Math.min(WORKERS, from + limit); i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    rows.push({
      employeeId: id,
      name: `Worker ${String(i).padStart(5, '0')} Fictional`,
      employeeNumber: `E${String(i).padStart(6, '0')}`,
      jobTitle: 'Store associate',
      shifts: days.slice(0, 5).map((date, k) => ({ id: `10000000-0000-4000-8000-${String(i * 7 + k).padStart(12, '0')}`, employeeId: id, employeeName: null, date, start: i % 2 ? '07:00' : '13:00', end: i % 2 ? '15:00' : '21:00', startLocal: `${date}T07:00`, endLocal: `${date}T15:00`, zone: 'Europe/London', startsAt: `${date}T06:00:00Z`, endsAt: `${date}T14:00:00Z`, breakMinutes: 30, status: 'published', locationId: null, departmentId: null, role: null, notes: null, publishedAt: null })),
    });
  }
  const next = from + limit < WORKERS ? Buffer.from(JSON.stringify([from + limit])).toString('base64url') : null;
  return { weekStart, days, total: cursor ? null : WORKERS, rows, openShifts: [], nextCursor: next };
}

test('virtualised rota grid stays responsive with 10,000 workers (only a window of rows in the DOM)', async ({ page }) => {
  test.setTimeout(300_000);
  await signUpAndEnrol(page);
  let pages = 0;
  await page.route(/\/v1\/rota\?/, async (route: Route) => {
    pages++;
    await route.fulfill({ json: syntheticPage(new URL(route.request().url())) });
  });

  const t0 = Date.now();
  await page.goto('/app/rota');
  const grid = page.getByRole('grid', { name: /Rota for the week of/ });
  await expect(grid.locator('[data-row="0"]')).toContainText('Worker 00000 Fictional');
  const firstRenderMs = Date.now() - t0;
  await expect(page.getByText('10,000 people')).toBeVisible();
  expect(await grid.getAttribute('aria-rowcount')).toBe(String(WORKERS + 2));
  const domRowsAtTop = await grid.locator('[data-row]').count();

  // jump to the middle: keyset pages load in order until the window is covered
  const jumpStart = Date.now();
  await grid.evaluate((el, y) => (el.scrollTop = y), 5_000 * ROW);
  await expect(grid.locator('[data-row="5000"]')).toContainText('Worker 05000 Fictional', { timeout: 60_000 });
  const jumpMs = Date.now() - jumpStart;
  const domRowsMiddle = await grid.locator('[data-row]').count();

  // continuous scrolling: frame-to-frame time while moving 10 rows per frame
  const frames = await grid.evaluate(async (el) => {
    const deltas: number[] = [];
    let last = performance.now();
    for (let i = 0; i < 180; i++) {
      el.scrollTop += 480;
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const now = performance.now();
      deltas.push(now - last);
      last = now;
    }
    return deltas.sort((a, b) => a - b);
  });
  const p95Frame = frames[Math.floor(frames.length * 0.95)]!;
  const medianFrame = frames[Math.floor(frames.length / 2)]!;
  const domRowsAfterScroll = await grid.locator('[data-row]').count();

  const result = { workers: WORKERS, shifts: WORKERS * 5, firstRenderMs, jumpToMiddleMs: jumpMs, keysetPagesFetched: pages, domRowsAtTop, domRowsMiddle, domRowsAfterScroll, medianFrameMs: Math.round(medianFrame * 10) / 10, p95FrameMs: Math.round(p95Frame * 10) / 10 };
  console.log(`ROTA_GRID_BENCH ${JSON.stringify(result)}`);
  const dir = join(process.cwd(), 'e2e', '.results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'rota-grid-bench.json'), JSON.stringify(result, null, 2));

  // Windowing: the DOM never holds more than a screenful plus overscan, whatever the row count.
  for (const n of [domRowsAtTop, domRowsMiddle, domRowsAfterScroll]) expect(n).toBeLessThan(80);
  expect(firstRenderMs).toBeLessThan(15_000);
  expect(p95Frame).toBeLessThan(100);
});
