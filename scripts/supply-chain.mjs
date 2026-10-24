// Supply-chain install policy (plan §5, P0), checked by `pnpm verify` (security step): pnpm installs only
// versions published at least seven days ago, and runs install scripts only for the packages allowed in
// `allowBuilds`. Removing or weakening either setting in pnpm-workspace.yaml fails the check.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Seven days, in minutes: a compromised release is usually caught and pulled well within a week. */
export const MIN_RELEASE_AGE_MINUTES = 10_080;

/** Top-level scalar keys and the `allowBuilds` mapping of a pnpm-workspace.yaml (flat YAML only). */
export function readWorkspace(text) {
  const top = {};
  const allowBuilds = {};
  const excluded = [];
  let section = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
    if (!line.trim()) continue;
    const key = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (key) {
      section = key[2] === '' ? key[1] : null;
      top[key[1]] = key[2] === '' ? {} : key[2].replace(/^['"]|['"]$/g, '');
      continue;
    }
    const entry = /^\s+(['"]?)([@\w./-]+)\1:\s*(\S+)$/.exec(line);
    if (entry && section === 'allowBuilds') allowBuilds[entry[2]] = entry[3];
    const item = /^\s+-\s+(['"]?)(\S+?)\1$/.exec(line);
    if (item && section === 'minimumReleaseAgeExclude') excluded.push(item[2]);
  }
  return { top, allowBuilds: 'allowBuilds' in top ? allowBuilds : null, excluded };
}

/** `name@1.2.3` or `@scope/name@1.2.3`: one exact version, never a whole package or a pattern. */
const EXACT = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*@\d+\.\d+\.\d+(-[\w.]+)?$/i;

/** Problems with the install policy; empty when it holds. */
export function checkWorkspace(text) {
  const { top, allowBuilds, excluded } = readWorkspace(text);
  const problems = [];
  const age = Number(top.minimumReleaseAge);
  if (!Number.isInteger(age) || age < MIN_RELEASE_AGE_MINUTES)
    problems.push(
      `minimumReleaseAge must be at least ${MIN_RELEASE_AGE_MINUTES} minutes (seven days); found ${top.minimumReleaseAge ?? 'nothing'}`,
    );
  for (const e of excluded)
    if (!EXACT.test(e))
      problems.push(`minimumReleaseAgeExclude entry ${e} must name one exact version (name@1.2.3)`);
  if (top.minimumReleaseAgeStrict === 'false')
    problems.push('minimumReleaseAgeStrict must not be false (too-new versions would be let in silently)');
  if (top.strictDepBuilds !== 'true')
    problems.push('strictDepBuilds must be true (an unlisted install script must fail the install)');
  if (top.dangerouslyAllowAllBuilds === 'true') problems.push('dangerouslyAllowAllBuilds must not be true');
  if (!allowBuilds) problems.push('allowBuilds (the install-script allowlist) is missing');
  else
    for (const [name, value] of Object.entries(allowBuilds))
      if (value !== 'true' && value !== 'false')
        problems.push(`allowBuilds.${name} must be true or false, not ${value}`);
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkWorkspace(readFileSync('pnpm-workspace.yaml', 'utf8'));
  if (problems.length) {
    console.error(
      'Supply-chain policy FAILED (pnpm-workspace.yaml):\n' + problems.map((p) => `- ${p}`).join('\n'),
    );
    process.exit(1);
  }
  console.log(
    `Supply-chain policy passed (versions at least ${MIN_RELEASE_AGE_MINUTES / 1440} days old; install scripts only from allowBuilds).`,
  );
}
