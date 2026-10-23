import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds packages/core/src/trust/generated.json from the documents that are the source of truth:
 *  - docs/SUBPROCESSORS.md (sub-processor tables per section + change log)
 *  - docs/legal/privacy-notice-{uk,eu,us}.md (editable templates served to tenants)
 *  - docs/legal/dpa-{uk,eu,us}.md (version + hash, for acceptance tracking)
 * Run: pnpm --filter @thapsus/core trust-data. test/trust.test.ts fails when the output is stale.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface SubprocessorTable {
  title: string;
  columns: string[];
  rows: string[][];
}

function tables(md: string): SubprocessorTable[] {
  const out: SubprocessorTable[] = [];
  let title = '';
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('## ')) title = line.slice(3).trim();
    if (line.startsWith('|') && lines[i + 1]?.startsWith('| ---')) {
      const cells = (l: string) =>
        l
          .slice(1, -1)
          .split('|')
          .map((c) => c.trim().replace(/\*\*/g, ''));
      const columns = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.startsWith('|')) rows.push(cells(lines[i++]!));
      out.push({ title, columns, rows });
    }
  }
  return out;
}

export function trustData() {
  const sub = tables(read('docs/SUBPROCESSORS.md'));
  const log = sub.find((t) => t.title === 'Change log');
  if (!log) throw new Error('docs/SUBPROCESSORS.md has no change log table');
  const col = (name: string) => log.columns.indexOf(name);
  const changes = log.rows.map((r) => ({
    id: r[col('Id')]!,
    type: r[col('Type')]! as 'baseline' | 'addition' | 'replacement' | 'removal' | 'change',
    announced: r[col('Announced')]!,
    effectiveFrom: r[col('Effective from')]!,
    regions: r[col('Regions')]!.split(',').map((x) => x.trim()),
    change: r[col('Change')]!,
  }));
  const notices: Record<string, { title: string; version: string; body: string; sha256: string }> = {};
  const dpa: Record<string, { version: string; sha256: string; path: string }> = {};
  for (const t of ['uk', 'eu', 'us']) {
    const body = read(`docs/legal/privacy-notice-${t}.md`);
    const version = /Template version (\d{4}-\d{2}-\d{2})/.exec(body)?.[1];
    if (!version || !body.startsWith('# ') || !body.includes('DRAFT — for legal review'))
      throw new Error(`privacy-notice-${t}.md must have a title, the DRAFT banner and a template version`);
    notices[t] = { title: body.split('\n')[0]!.slice(2), version, body, sha256: sha256(body) };
    const d = read(`docs/legal/dpa-${t}.md`);
    const dv = /Version (\d{4}-\d{2}-\d{2})/.exec(d)?.[1];
    if (!dv) throw new Error(`dpa-${t}.md must state its version`);
    dpa[t] = { version: dv, sha256: sha256(d), path: `docs/legal/dpa-${t}.md` };
  }
  return { subprocessors: { sections: sub.filter((t) => t.title !== 'Change log'), changes }, notices, dpa };
}

export const GENERATED = join(ROOT, 'packages', 'core', 'src', 'trust', 'generated.json');
export const serialise = (d: ReturnType<typeof trustData>) => JSON.stringify(d, null, 2) + '\n';

if (process.argv[1]?.endsWith('trust-data.ts')) {
  writeFileSync(GENERATED, serialise(trustData()));
  console.log(`wrote ${GENERATED}`);
}
