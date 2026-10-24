import { describe, expect, it } from 'vitest';
import { PERMISSION_KEYS } from '../src/access';
import {
  allows,
  CAPABILITIES,
  CAPABILITY_KEYS,
  hasFromGrants,
  implies,
  namedPermissions,
  pageFor,
  PAGES,
  permits,
  type CapabilityKey,
} from '../src/capabilities';
import { BUILT_IN_ROLES } from '../src/roles';

/** The permission map (PROGRESS 16.1, ADR-0188). */
const role = (key: string) => {
  const r = BUILT_IN_ROLES.find((x) => x.key === key)!;
  return { has: hasFromGrants(r.permissions), employeeId: 'e-1', askHr: true };
};
const can = (key: string, c: CapabilityKey) => allows(role(key), c);

describe('the permission map', () => {
  it('names only permissions from the catalogue', () => {
    for (const k of CAPABILITY_KEYS)
      for (const p of namedPermissions(k)) expect(PERMISSION_KEYS, `${k}: ${p}`).toContain(p);
  });

  it('lists every page once, each with capabilities that exist', () => {
    const paths = PAGES.map((p) => p.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of PAGES) {
      expect(p.path).toMatch(/^\/app(\/|$)/);
      expect(CAPABILITY_KEYS, p.path).toContain(p.view);
      if (p.manage) expect(CAPABILITY_KEYS, p.path).toContain(p.manage);
    }
  });

  it('finds the page of a path, dynamic segments included, the most specific first', () => {
    expect(pageFor('/app/people/7f9c')?.path).toBe('/app/people/[id]');
    expect(pageFor('/app/people/new')?.path).toBe('/app/people/new');
    expect(pageFor('/app/settings/roles/compare')?.path).toBe('/app/settings/roles/compare');
    expect(pageFor('/app/settings/branding/')?.path).toBe('/app/settings/branding');
    expect(pageFor('/app/people?tab=history')?.path).toBe('/app/people');
    expect(pageFor('/app/unknown')).toBeUndefined();
  });

  it('opens the settings index to anyone who may open one of its pages', () => {
    const any = CAPABILITIES['settings.index'].any ?? [];
    for (const p of PAGES.filter((x) => x.path.startsWith('/app/settings/')))
      for (const perm of CAPABILITIES[p.view].any ?? []) expect(any).toContain(perm);
  });

  it('decides "implies" on permissions: a stricter UI action passes, a weaker one does not', () => {
    expect(implies('settings.branding.manage', 'settings.branding.manage')).toBe(true);
    expect(implies('settings.branding', 'settings.branding.manage')).toBe(false);
    expect(implies('people.edit', 'people.changes')).toBe(true);
    expect(implies('people.changes', 'people.edit')).toBe(false);
    expect(implies('settings.sso.manage', 'settings.signInPolicy.manage')).toBe(true);
    expect(implies({ all: ['exports.schedule', 'exports.destinations'] }, 'reports.exports.schedule')).toBe(true);
    expect(implies('home', 'settings.features.manage')).toBe(false);
    expect(implies('settings.features.manage', 'home')).toBe(true);
  });

  it('checks none, employee, feature, Ask HR and sandbox only where they apply', () => {
    const employee = role('employee');
    expect(allows(employee, 'help.contactHr')).toBe(true);
    expect(allows(role('owner'), 'help.contactHr')).toBe(false); // admins contact support instead
    expect(permits(role('owner').has, 'help.contactHr')).toBe(true); // the API does not enforce `none`
    expect(allows({ ...employee, employeeId: null }, 'me.profile')).toBe(false);
    expect(allows({ ...employee, askHr: false }, 'askHr.ask')).toBe(false);
    const owner = role('owner');
    expect(allows(owner, 'settings.webhooks')).toBe(true); // flags unknown: shown
    expect(allows({ ...owner, features: { webhooks: false } }, 'settings.webhooks')).toBe(false);
    expect(allows({ ...owner, features: {} }, 'settings.askHr')).toBe(false); // aiAssistant is off by default
    expect(allows({ ...owner, sandbox: true }, 'settings.sandbox')).toBe(false);
  });

  it('Settings → Branding: an HR admin may look but not change; the owner may do both', () => {
    expect(can('hr_admin', 'settings.branding')).toBe(true);
    expect(can('hr_admin', 'settings.branding.manage')).toBe(false);
    expect(can('owner', 'settings.branding.manage')).toBe(true);
    expect(pageFor('/app/settings/branding')).toEqual({
      path: '/app/settings/branding',
      view: 'settings.branding',
      manage: 'settings.branding.manage',
    });
  });

  it('IT admins hold devices, IT accounts and SCIM, and nothing about pay, contracts or sensitive records', () => {
    for (const c of [
      'it.assets.manage',
      'it.assets.register',
      'it.integrations.manage',
      'settings.scim',
      'settings.scim.manage',
      'people.directory',
      'inbox.tasks',
      // Settings opens on the SCIM section alone
      'settings.index',
    ] as CapabilityKey[])
      expect(can('it_admin', c), c).toBe(true);
    for (const c of [
      'pay.payroll',
      'pay.payslips.manage',
      'people.edit',
      'people.documents.attach',
      'compliance.overview',
      'privacy.overview',
      'settings.sso',
      'reports.catalogue',
    ] as CapabilityKey[])
      expect(can('it_admin', c), c).toBe(false);
    // HR admins keep a read-only view of the register, enough to see what a leaver holds
    expect(can('hr_admin', 'it.assets.register')).toBe(true);
    expect(can('hr_admin', 'it.assets.manage')).toBe(false);
    expect(can('entity_hr_admin', 'it.assets.manage')).toBe(false);
  });
});
