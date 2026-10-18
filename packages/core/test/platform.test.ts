import { describe, expect, it } from 'vitest';
import { API_SCOPE_KEYS, API_SCOPES, apiClientMayCall, intersectPattern, scopedPermissions } from '../src/api-scopes';
import { FEATURE_FLAGS, FEATURE_KEYS, isFeatureKey, resolveFeatureFlags } from '../src/features';
import { BUILT_IN_ROLES } from '../src/roles';
import { can, type Principal } from '../src/permissions';
import { flatten, CATALOGUES } from '../src/i18n';

describe('API scopes', () => {
  it('intersects wildcard and exact patterns', () => {
    expect(intersectPattern('*', 'employees.read')).toBe('employees.read');
    expect(intersectPattern('employees.*', 'employees.read')).toBe('employees.read');
    expect(intersectPattern('employees.read', 'employees.*')).toBe('employees.read');
    expect(intersectPattern('employees.read', 'leave.read')).toBeUndefined();
    expect(intersectPattern('vault.read:*', 'vault.read:health')).toBe('vault.read:health');
  });

  it('a machine client gets role ∩ scopes, never more than either', () => {
    const owner = BUILT_IN_ROLES.find((r) => r.key === 'owner')!;
    const manager = BUILT_IN_ROLES.find((r) => r.key === 'manager')!;
    expect(scopedPermissions(owner.permissions, ['employees:read'])).toEqual(['employees.history', 'employees.read']);
    // the manager role has employees.read but not employees.create, so the write scope cannot add it
    const m = scopedPermissions(manager.permissions, ['employees:write']);
    expect(m).toContain('employees.read');
    expect(m).not.toContain('employees.create');
    expect(scopedPermissions(owner.permissions, [])).toEqual([]);
    expect(scopedPermissions(owner.permissions, ['not-a-scope'])).toEqual([]);
  });

  it('no scope ever grants identity, settings, vault or back-office permissions', () => {
    const owner = BUILT_IN_ROLES.find((r) => r.key === 'owner')!;
    const all = scopedPermissions(owner.permissions, API_SCOPE_KEYS);
    const principal: Principal = { userId: 'c', grants: [{ roleKey: 'api', isAdmin: false, permissions: all, fieldAccess: {}, scope: { type: 'all' } }], kind: 'api_client' };
    for (const action of ['settings.manage', 'settings.read', 'users.create', 'roles.manage', 'vault.read:health', 'support.grant', 'privacy.export', 'payroll.read']) {
      expect(can(principal, action), action).toBe(false);
    }
    for (const perms of Object.values(API_SCOPES)) for (const p of perms) expect(p).not.toMatch(/\*|settings|users|vault|roles|support/);
  });

  it('API clients may only call the public resource paths', () => {
    expect(apiClientMayCall('/v1/employees')).toBe(true);
    expect(apiClientMayCall('/v1/employees/:id')).toBe(true);
    expect(apiClientMayCall('/v1/org-chart/roots')).toBe(true);
    expect(apiClientMayCall('/v1/webhooks/:id/deliveries')).toBe(true);
    for (const p of ['/v1/auth/session', '/v1/auth/mfa/totp/enroll', '/v1/me/preferences', '/v1/settings/api-keys', '/v1/settings/domains', '/v1/backoffice/auth/login', '/v1/employeesx', '/v1/sandboxes']) {
      expect(apiClientMayCall(p), p).toBe(false);
    }
  });
});

describe('feature flag registry', () => {
  it('resolves defaults and ignores unknown or malformed overrides', () => {
    const resolved = resolveFeatureFlags({ webhooks: false, aiAssistant: true, notAFlag: true, publicApi: 'yes' });
    expect(resolved.webhooks).toBe(false);
    expect(resolved.aiAssistant).toBe(true);
    expect(resolved.publicApi).toBe(true);
    expect(Object.keys(resolved).sort()).toEqual([...FEATURE_KEYS].sort());
    expect(resolveFeatureFlags(null)).toEqual(Object.fromEntries(FEATURE_KEYS.map((k) => [k, FEATURE_FLAGS[k].default])));
    expect(isFeatureKey('webhooks')).toBe(true);
    expect(isFeatureKey('nope')).toBe(false);
  });

  it('the AI assistant is off by default (brief §6.13)', () => {
    expect(FEATURE_FLAGS.aiAssistant.default).toBe(false);
  });

  it('every flag has catalogue text in en-GB', () => {
    const flat = flatten(CATALOGUES['en-GB']);
    for (const f of Object.values(FEATURE_FLAGS)) {
      expect(flat[f.labelKey], f.labelKey).toBeTruthy();
      expect(flat[f.descriptionKey], f.descriptionKey).toBeTruthy();
    }
  });

  it('every scope has catalogue text in en-GB', () => {
    const flat = flatten(CATALOGUES['en-GB']);
    for (const s of API_SCOPE_KEYS) expect(flat[`platform.scopes.${s.replace(':', '_')}`], s).toBeTruthy();
  });
});
