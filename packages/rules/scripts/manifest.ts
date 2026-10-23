import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JurisdictionPack } from '../src/schema';

/**
 * Pack version manifest (ADR-0024). Every pack's content hash is recorded against its `version` in
 * packages/rules/pack-manifest.json. Changing a pack's data without bumping `version` fails the
 * manifest test; `--write` appends the new (version, hash) pair only when the version went up, so the
 * history is append-only and each version names exactly one content.
 *
 *   pnpm --filter @thapsus/rules manifest           check
 *   pnpm --filter @thapsus/rules manifest -- --write record bumped packs
 */
const here = dirname(fileURLToPath(import.meta.url));
export const PACKS_ROOT = join(here, '..', 'packs');
export const MANIFEST_PATH = join(here, '..', 'pack-manifest.json');

export interface ManifestEntry {
  version: number;
  updatedOn: string;
  contentHash: string;
}
export interface Manifest {
  note: string;
  packs: Record<string, ManifestEntry[]>;
}

/** JSON with object keys sorted at every level, so formatting and key order never change the hash. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** sha256 of the pack's canonical content, excluding the bookkeeping fields `version` and `updatedOn`. */
export function contentHash(pack: JurisdictionPack): string {
  const { version: _version, updatedOn: _updatedOn, ...content } = pack;
  return `sha256:${createHash('sha256').update(canonical(content)).digest('hex')}`;
}

export function readPacks(dir = PACKS_ROOT): JurisdictionPack[] {
  const out: JurisdictionPack[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.json')) out.push(JSON.parse(readFileSync(p, 'utf8')) as JurisdictionPack);
    }
  };
  walk(dir);
  return out;
}

export function loadManifest(path = MANIFEST_PATH): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

/** Everything wrong between the packs on disk and the manifest (empty = consistent). */
export function manifestProblems(packs: JurisdictionPack[], manifest: Manifest): string[] {
  const problems: string[] = [];
  const codes = new Set(packs.map((p) => p.jurisdiction));
  for (const code of Object.keys(manifest.packs))
    if (!codes.has(code))
      problems.push(
        `${code}: in the manifest but no pack exists (packs are never deleted; supersede their rules with new versions)`,
      );
  for (const pack of packs) {
    const history = manifest.packs[pack.jurisdiction];
    if (!history?.length) {
      problems.push(
        `${pack.jurisdiction}: new pack is not in the manifest — run \`pnpm --filter @thapsus/rules manifest -- --write\``,
      );
      continue;
    }
    history.forEach((e, i) => {
      if (i === 0) return;
      const prev = history[i - 1]!;
      if (e.version <= prev.version)
        problems.push(
          `${pack.jurisdiction}: manifest versions must strictly increase (${prev.version} then ${e.version})`,
        );
      if (e.contentHash === prev.contentHash)
        problems.push(
          `${pack.jurisdiction}: manifest version ${e.version} has the same content as version ${prev.version}`,
        );
    });
    const last = history.at(-1)!;
    const hash = contentHash(pack);
    if (hash !== last.contentHash && pack.version === last.version)
      problems.push(
        `${pack.jurisdiction}: pack data changed but version is still ${pack.version} — bump \`version\` and \`updatedOn\`, then run the manifest script with --write`,
      );
    else if (hash !== last.contentHash || pack.version !== last.version)
      problems.push(
        `${pack.jurisdiction}: pack is version ${pack.version} but the manifest records version ${last.version} — run the manifest script with --write`,
      );
  }
  return problems;
}

/** Appends a manifest entry for every pack whose content changed and whose version increased. */
export function updateManifest(
  packs: JurisdictionPack[],
  manifest: Manifest,
): { manifest: Manifest; errors: string[] } {
  const next: Manifest = { note: manifest.note, packs: { ...manifest.packs } };
  const errors: string[] = [];
  for (const pack of [...packs].sort((a, b) => a.jurisdiction.localeCompare(b.jurisdiction))) {
    const history = [...(next.packs[pack.jurisdiction] ?? [])];
    const last = history.at(-1);
    const hash = contentHash(pack);
    if (last && last.contentHash === hash && last.version === pack.version) continue;
    if (last && pack.version <= last.version) {
      errors.push(
        `${pack.jurisdiction}: content changed but version ${pack.version} is not above recorded version ${last.version}; bump it`,
      );
      continue;
    }
    history.push({ version: pack.version, updatedOn: pack.updatedOn, contentHash: hash });
    next.packs[pack.jurisdiction] = history;
  }
  next.packs = Object.fromEntries(Object.entries(next.packs).sort(([a], [b]) => a.localeCompare(b)));
  return { manifest: next, errors };
}

if (process.argv[1]?.endsWith('manifest.ts')) {
  const packs = readPacks();
  let manifest: Manifest;
  try {
    manifest = loadManifest();
  } catch {
    manifest = {
      note: 'Generated by packages/rules/scripts/manifest.ts — append-only history of (version, content hash) per pack. Do not edit by hand.',
      packs: {},
    };
  }
  if (process.argv.includes('--write')) {
    const { manifest: next, errors } = updateManifest(packs, manifest);
    if (errors.length) {
      console.error(errors.join('\n'));
      process.exit(1);
    }
    writeFileSync(MANIFEST_PATH, JSON.stringify(next, null, 2) + '\n');
    console.log(`wrote ${MANIFEST_PATH}`);
  } else {
    const problems = manifestProblems(packs, manifest);
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exit(1);
    }
    console.log(`OK: ${packs.length} pack(s) match the manifest`);
  }
}
