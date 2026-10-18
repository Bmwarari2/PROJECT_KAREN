import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULE_KEYS, type JurisdictionPack } from '../src/schema';

/** Validates every pack JSON under packages/rules/packs: shape, dates, sources, no overlaps. */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'packs');
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const OFFICIAL = /(\.gov\.uk|legislation\.gov\.uk|\.gov(\/|$)|\.gov\.[a-z]{2}|europa\.eu|eur-lex|\.gouv\.fr|gesetze-im-internet\.de|bundesregierung\.de|overheid\.nl|rijksoverheid\.nl|boe\.es|gazzettaufficiale\.it|isap\.sejm\.gov\.pl|riksdagen\.se|retsinformation\.dk|ejustice\.just\.fgov\.be|ris\.bka\.gv\.at|dre\.pt|zakonyprolidi\.cz|legislatie\.just\.ro|finlex\.fi|irishstatutebook\.ie|citizensinformation\.ie|gov\.ie|riigiteataja\.ee|likumi\.lv|e-tar\.lt|njt\.hu|slov-lex\.sk|pisrs\.si|narodne-novine\.nn\.hr|lex\.bg|cylaw\.org|legislation\.mt|legilux\.public\.lu|\.admin\.ch|ilo\.org|\.state\.[a-z]{2}\.us|\.[a-z]{2}\.gov|nyc\.gov|eeoc\.gov|dol\.gov|uscis\.gov|opm\.gov|ecfr\.gov|congress\.gov|federalregister\.gov|govinfo\.gov|\.public\.lu|\.government\.bg|\.gov\.mt|\.gov\.gr|kodiko\.gr|ypakp\.gr|\.gov\.cy|\.vlada\.cz|\.gov\.pl|\.gov\.ro|\.gov\.sk|\.gov\.si|\.gov\.hr|\.gov\.lv|\.gov\.lt|\.gov\.ee|\.gov\.hu|\.gov\.it|\.gob\.es|\.gouv\.lu|\.belgium\.be|\.fgov\.be|\.gv\.at|\.bund\.de|\.government\.nl|\.regeringen\.se|\.verksamt\.se|\.borger\.dk|\.virk\.dk|\.gov\.pt|\.portaldocidadao\.pt|\.suomi\.fi|\.tem\.fi)/i;

const problems: string[] = [];
const files: string[] = [];
const walk = (d: string) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.json')) files.push(p);
  }
};
walk(root);

const overlaps = (a: { effectiveFrom: string; effectiveTo: string | null }, b: { effectiveFrom: string; effectiveTo: string | null }) =>
  (a.effectiveTo === null || a.effectiveTo > b.effectiveFrom) && (b.effectiveTo === null || b.effectiveTo > a.effectiveFrom);

for (const file of files) {
  const rel = file.slice(root.length + 1);
  let pack: JurisdictionPack;
  try {
    pack = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    problems.push(`${rel}: invalid JSON (${(e as Error).message})`);
    continue;
  }
  if (!pack.jurisdiction || !pack.name || typeof pack.version !== 'number') problems.push(`${rel}: missing jurisdiction/name/version`);
  const checkSource = (where: string, s: { url?: string; title?: string } | undefined, verifiedOn?: string, reviewer?: string) => {
    if (!s?.url || !/^https:\/\//.test(s.url)) problems.push(`${where}: source.url must be https`);
    else if (!OFFICIAL.test(s.url)) problems.push(`${where}: source ${s.url} is not on the official-domain allow-list`);
    if (!s?.title) problems.push(`${where}: source.title missing`);
    if (!verifiedOn || !DATE.test(verifiedOn)) problems.push(`${where}: verifiedOn missing`);
    if (!reviewer) problems.push(`${where}: reviewer missing`);
  };
  for (const rule of pack.rules ?? []) {
    const where = `${rel} ${rule.key}`;
    if (!(rule.key in RULE_KEYS)) problems.push(`${where}: unknown rule key`);
    if (!rule.versions?.length) problems.push(`${where}: no versions`);
    for (const [i, v] of (rule.versions ?? []).entries()) {
      if (!DATE.test(v.effectiveFrom) || (v.effectiveTo !== null && !DATE.test(v.effectiveTo))) problems.push(`${where} v${i}: bad dates`);
      if (v.effectiveTo !== null && v.effectiveTo <= v.effectiveFrom) problems.push(`${where} v${i}: effectiveTo must be after effectiveFrom`);
      if (v.value === undefined || v.value === null) problems.push(`${where} v${i}: value missing`);
      checkSource(`${where} v${i}`, v.source, v.verifiedOn, v.reviewer);
      for (const w of rule.versions.slice(i + 1)) if (overlaps(v, w)) problems.push(`${where}: overlapping versions`);
    }
  }
  const ids = new Set<string>();
  for (const h of pack.holidays ?? []) {
    const where = `${rel} holiday ${h.id}`;
    if (!h.id || !h.name || !h.rule || !h.regions?.length) problems.push(`${where}: incomplete`);
    if (ids.has(`${h.id}:${h.effectiveFrom}:${h.regions.join()}`)) problems.push(`${where}: duplicate`);
    ids.add(`${h.id}:${h.effectiveFrom}:${h.regions.join()}`);
    if (!DATE.test(h.effectiveFrom)) problems.push(`${where}: effectiveFrom missing`);
    checkSource(where, h.source, h.verifiedOn, h.reviewer);
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} problem(s) in ${files.length} pack file(s)`);
  process.exit(1);
}
console.log(`OK: ${files.length} pack file(s) valid`);
