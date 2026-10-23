import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOME_REGIONS, REGIONS } from '@thapsus/core/regions';

/**
 * The Google Cloud staging cell (infra/gcp/staging) takes its region from its own cell → region map,
 * so it can be planned without Node. That map must equal gcpRegion in packages/core/src/regions.ts,
 * and no other Google Cloud region may appear in the configuration. `tofu test` (pnpm verify step
 * `gcp`) checks the planned resources themselves.
 */
const dir = join(__dirname, '..', 'gcp', 'staging');
const tf = readdirSync(dir)
  .filter((f) => f.endsWith('.tf'))
  .map((f) => readFileSync(join(dir, f), 'utf8'))
  .join('\n');

describe('Google Cloud staging residency', () => {
  it('the cell → region map matches the residency map', () => {
    const block = /gcp_regions\s*=\s*\{([^}]*)\}/.exec(tf)?.[1] ?? '';
    const map = Object.fromEntries(
      [...block.matchAll(/(\w+)\s*=\s*"([a-z0-9-]+)"/g)].map((m) => [m[1], m[2]]),
    );
    expect(map).toEqual(Object.fromEntries(HOME_REGIONS.map((c) => [c, REGIONS[c].gcpRegion])));
  });

  it('names no Google Cloud region outside the map', () => {
    const allowed = new Set(HOME_REGIONS.map((c) => REGIONS[c].gcpRegion));
    const named = [
      ...tf.matchAll(/"((?:europe|us|asia|me|africa|australia|northamerica|southamerica)-[a-z]+\d+)"/g),
    ].map((m) => m[1]!);
    expect(named.filter((r) => !allowed.has(r))).toEqual([]);
  });

  it('pins every regional resource and the backups to the cell region', () => {
    // location/region attributes are local.region (or its upper-case form for buckets), never a literal
    const literals = [...tf.matchAll(/^\s*(location|region)\s*=\s*"([^"]+)"/gm)].map(
      (m) => `${m[1]}=${m[2]}`,
    );
    expect(literals).toEqual([]);
    expect(tf).toMatch(/backup_configuration\s*\{[^}]*location\s*=\s*local\.region/s);
  });
});
