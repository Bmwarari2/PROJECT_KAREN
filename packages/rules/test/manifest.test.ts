import { describe, expect, it } from 'vitest';
import type { JurisdictionPack } from '../src/schema';
import { contentHash, loadManifest, manifestProblems, readPacks, updateManifest, type Manifest } from '../scripts/manifest';

/** ADR-0024: a pack's `version` must go up whenever its data changes; the manifest proves it. */
describe('pack version manifest', () => {
  const packs = readPacks();

  it('every pack matches its latest manifest entry (content hash and version)', () => {
    expect(manifestProblems(packs, loadManifest())).toEqual([]);
  });

  it('every pack version is a positive integer and history is append-only', () => {
    const manifest = loadManifest();
    for (const p of packs) {
      expect(Number.isInteger(p.version) && p.version >= 1, p.jurisdiction).toBe(true);
      const versions = manifest.packs[p.jurisdiction]!.map((e) => e.version);
      expect(versions, p.jurisdiction).toEqual([...versions].sort((a, b) => a - b));
    }
  });

  describe('detects changes', () => {
    const pack: JurisdictionPack = { jurisdiction: 'ZZ', parent: null, name: 'Fictional test land', version: 1, updatedOn: '2026-10-18', rules: [], holidays: [] };
    const recorded: Manifest = { note: 'test', packs: { ZZ: [{ version: 1, updatedOn: '2026-10-18', contentHash: contentHash(pack) }] } };

    it('ignores formatting, key order and the bookkeeping fields', () => {
      const reordered = JSON.parse(JSON.stringify({ holidays: [], rules: [], updatedOn: '2027-01-01', version: 1, name: pack.name, parent: null, jurisdiction: 'ZZ' })) as JurisdictionPack;
      expect(contentHash(reordered)).toBe(contentHash(pack));
    });
    it('fails when data changes without a version bump', () => {
      const edited = { ...pack, name: 'Fictional test land (edited)' };
      expect(manifestProblems([edited], recorded).join()).toMatch(/bump `version`/);
      expect(updateManifest([edited], recorded).errors.join()).toMatch(/not above recorded version 1/);
    });
    it('records the new content once the version is bumped', () => {
      const bumped = { ...pack, name: 'Fictional test land (edited)', version: 2 };
      expect(manifestProblems([bumped], recorded).join()).toMatch(/run the manifest script/);
      const { manifest, errors } = updateManifest([bumped], recorded);
      expect(errors).toEqual([]);
      expect(manifest.packs.ZZ!.map((e) => e.version)).toEqual([1, 2]);
      expect(manifestProblems([bumped], manifest)).toEqual([]);
    });
    it('flags new packs and packs missing from disk', () => {
      const problems = manifestProblems([{ ...pack, jurisdiction: 'ZY' }], recorded).join('\n');
      expect(problems).toMatch(/ZY: new pack/);
      expect(problems).toMatch(/ZZ: in the manifest but no pack exists/);
    });
  });
});
