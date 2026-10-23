// Fails when any tracked or untracked (non-ignored) text file still holds git merge-conflict markers.
import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const files = execSync('git ls-files -co --exclude-standard', { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((f) => !/\.(png|jpg|jpeg|gif|webp|avif|woff2?|ico|pdf|zip)$/i.test(f));

const MARKER = /^(<{7}|>{7})( |$)/m;
const findings = [];
for (const f of files) {
  let text;
  try {
    if (statSync(f).size > 2_000_000) continue;
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  const m = MARKER.exec(text);
  if (m) findings.push(`${f}:${text.slice(0, m.index).split('\n').length}`);
}
if (findings.length) {
  console.error(`merge-conflict markers found:\n  ${findings.join('\n  ')}`);
  process.exit(1);
}
console.log(`conflict-marker check: ${files.length} files clean`);
