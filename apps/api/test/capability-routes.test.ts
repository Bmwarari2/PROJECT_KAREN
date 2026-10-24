import { describe, expect, it } from 'vitest';
import { CAPABILITIES, isCapabilityKey, namedPermissions } from '@thapsus/core/capabilities';
import { PERMISSION_KEYS } from '@thapsus/core/access';
import { routeBlocks } from './capability-scan';

/**
 * The API side of the permission map (ADR-0188). A route that declares a capability is enforced with
 * the capability's permissions before its handler runs; the handler may still check a record's scope
 * (the same permission with a target) or another area (a vault category). What it must not do is ask
 * for a different permission of the same area — settings.manage where the capability says
 * settings.read — because the app would then show the action to people the route refuses.
 */
const area = (p: string) => p.split(/[.:]/)[0]!;
const blocks = routeBlocks();

describe('routes that declare a capability (ADR-0188)', () => {
  it('are found in the API modules', () => {
    expect(blocks.length).toBeGreaterThan(150);
  });

  it('name capabilities that exist, whose permissions are in the catalogue', () => {
    for (const b of blocks) {
      expect(isCapabilityKey(b.capability), `${b.file}:${b.line} ${b.capability}`).toBe(true);
      for (const p of namedPermissions(CAPABILITIES[b.capability as keyof typeof CAPABILITIES]))
        expect(PERMISSION_KEYS, `${b.file}:${b.line} ${b.capability}: ${p}`).toContain(p);
    }
  });

  it('check no permission of the capability’s own area beyond what it declares', () => {
    const problems: string[] = [];
    for (const b of blocks) {
      if (!isCapabilityKey(b.capability)) continue;
      const declared = new Set(namedPermissions(b.capability));
      const areas = new Set([...declared].map(area));
      for (const p of b.checks)
        if (areas.has(area(p)) && !declared.has(p))
          problems.push(
            `${b.file}:${b.line} ${b.method} ${b.url}: the handler checks ${p}, which ${b.capability} does not name (${[...declared].join(', ')})`,
          );
    }
    expect(problems).toEqual([]);
  });

  it('say "company-wide" where the handler checks the permission without a record to scope it', () => {
    // authorize(req, p) without a target passes only a role assigned for the whole workspace; the app
    // would otherwise show the action to a country or entity HR admin whom the route refuses
    const problems: string[] = [];
    for (const b of blocks) {
      if (!isCapabilityKey(b.capability)) continue;
      const req = CAPABILITIES[b.capability];
      const declared = new Set([...(req.any ?? []), ...(req.all ?? [])]);
      for (const p of b.workspaceChecks)
        if (declared.has(p) && !req.workspace)
          problems.push(
            `${b.file}:${b.line} ${b.method} ${b.url}: checks ${p} company-wide; mark ${b.capability} workspace`,
          );
    }
    expect(problems).toEqual([]);
  });

  it('would catch a route stricter than its capability (the Settings → Branding case)', () => {
    const put = blocks.find((b) => b.method === 'PUT' && b.url === '/v1/settings/branding')!;
    expect(put.capability).toBe('settings.branding.manage');
    expect(put.checks).toContain('settings.manage');
    // had the route declared the page's capability, its own settings.manage check would be flagged
    const declared = new Set(namedPermissions('settings.branding'));
    expect([...declared]).toEqual(['settings.read']);
    expect(put.checks.filter((p) => area(p) === 'settings' && !declared.has(p))).toEqual(['settings.manage']);
  });
});
