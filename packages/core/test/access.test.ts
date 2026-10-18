import { describe, expect, it } from 'vitest';
import {
  checkAssignment,
  excessFieldAccess,
  expandPermission,
  fieldAccessProblem,
  fieldProbes,
  isAdminGrade,
  permissionProblem,
  scopeCovers,
  uncoveredPermissions,
  PERMISSION_KEYS,
} from '../src/access';
import type { Principal, RoleGrant } from '../src/permissions';
import { BUILT_IN_ROLES } from '../src/roles';

const builtIn = (key: string, scope: RoleGrant['scope']): RoleGrant => {
  const r = BUILT_IN_ROLES.find((x) => x.key === key)!;
  return { roleKey: r.key, isAdmin: r.isAdmin, permissions: r.permissions, fieldAccess: r.fieldAccess, scope };
};
const grant = (permissions: string[], fieldAccess: RoleGrant['fieldAccess'], scope: RoleGrant['scope']): RoleGrant => ({ roleKey: 'x', isAdmin: false, permissions, fieldAccess, scope });

describe('access catalogue', () => {
  it('every built-in permission and field key is in the catalogue (only the owner holds *)', () => {
    for (const r of BUILT_IN_ROLES) {
      for (const perm of r.permissions) expect(permissionProblem(perm), `${r.key}: ${perm}`).toBe(r.key === 'owner' ? 'ownerOnly' : undefined);
      for (const [k, v] of Object.entries(r.fieldAccess)) expect(fieldAccessProblem(k, v), `${r.key}: ${k}`).toBe(r.key === 'owner' ? 'ownerOnly' : undefined);
    }
  });

  it('built-in admin flags agree with the admin-grade keys they hold', () => {
    for (const r of BUILT_IN_ROLES) expect(isAdminGrade(r.permissions), r.key).toBe(r.isAdmin);
  });

  it('accepts catalogue keys, area and category wildcards; rejects unknown keys and *', () => {
    expect(permissionProblem('leave.approve')).toBeUndefined();
    expect(permissionProblem('leave.*')).toBeUndefined();
    expect(permissionProblem('vault.read:*')).toBeUndefined();
    expect(permissionProblem('vault.read:health')).toBeUndefined();
    expect(permissionProblem('leave.teleport')).toBe('unknownPermission');
    expect(permissionProblem('nonsense.*')).toBe('unknownPermission');
    expect(permissionProblem('leave:*')).toBe('unknownPermission');
    expect(permissionProblem('*')).toBe('ownerOnly');
    expect(expandPermission('roles.*').sort()).toEqual(['roles.assign', 'roles.manage', 'roles.read']);
    expect(PERMISSION_KEYS).toContain('roles.manage');
  });

  it('validates field keys and levels, including the tenant’s custom fields', () => {
    expect(fieldAccessProblem('employee.jobTitle', 'read')).toBeUndefined();
    expect(fieldAccessProblem('employee.pay.*', 'none')).toBeUndefined();
    expect(fieldAccessProblem('employee.salary', 'read')).toBe('unknownField');
    expect(fieldAccessProblem('employee.jobTitle', 'admin')).toBe('invalidAccess');
    expect(fieldAccessProblem('employee.custom.shoeSize', 'read')).toBe('unknownField');
    expect(fieldAccessProblem('employee.custom.shoeSize', 'read', ['shoeSize'])).toBeUndefined();
    expect(fieldAccessProblem('*', 'write')).toBe('ownerOnly');
  });

  it('marks a role admin-grade when any key (or wildcard over one) is admin-grade', () => {
    expect(isAdminGrade(['employees.read', 'leave.read'])).toBe(false);
    expect(isAdminGrade(['employees.*'])).toBe(true);
    expect(isAdminGrade(['roles.assign'])).toBe(true);
    expect(isAdminGrade(['rota.*'])).toBe(false);
  });
});

describe('subset rule', () => {
  it('a permission is covered only by an equal key or a wider wildcard', () => {
    const g = [grant(['employees.*', 'leave.read', 'vault.read:health'], {}, { type: 'all' })];
    expect(uncoveredPermissions(g, ['employees.update', 'employees.*', 'leave.read'])).toEqual([]);
    expect(uncoveredPermissions(g, ['leave.*', 'vault.read:*', 'vault.read:health', 'roles.manage'])).toEqual(['leave.*', 'vault.read:*', 'roles.manage']);
    expect(uncoveredPermissions([builtIn('owner', { type: 'all' })], ['*', 'roles.assign'])).toEqual([]);
  });

  it('field access may not exceed the caller’s, and a wildcard cannot hide a narrower denial', () => {
    const hr = [grant([], { 'employee.*': 'write', 'employee.pay.*': 'none' }, { type: 'all' })];
    const probes = fieldProbes();
    expect(excessFieldAccess(hr, { 'employee.jobTitle': 'write' }, probes)).toEqual([]);
    expect(excessFieldAccess(hr, { 'employee.pay.amount': 'read' }, probes)).toEqual(['employee.pay.amount']);
    // employee.* read would grant pay fields the caller cannot see
    expect(excessFieldAccess(hr, { 'employee.*': 'read' }, probes)).toEqual(expect.arrayContaining(['employee.pay.*', 'employee.pay.amount', 'employee.pay.grade']));
    // …unless the role itself denies them
    expect(excessFieldAccess(hr, { 'employee.*': 'read', 'employee.pay.*': 'none' }, probes)).toEqual([]);
    const manager = [builtIn('manager', { type: 'own_team' })];
    expect(excessFieldAccess(manager, { 'employee.jobTitle': 'read' }, probes)).toEqual([]);
    expect(excessFieldAccess(manager, { 'employee.jobTitle': 'write' }, probes)).toEqual(['employee.jobTitle']);
  });
});

describe('scope rule', () => {
  const caller: Principal = { userId: 'u-c', employeeId: 'e-c', grants: [], delegatedFromEmployeeIds: ['e-boss'] };
  it('all covers everything; nothing narrower covers all', () => {
    expect(scopeCovers(caller, { type: 'all' }, { type: 'department', values: ['d1'] })).toBe(true);
    expect(scopeCovers(caller, { type: 'entity', values: ['ent-uk'] }, { type: 'all' })).toBe(false);
  });
  it('value scopes cover the same type with a subset of values only', () => {
    const held = { type: 'department' as const, values: ['d1', 'd2'] };
    expect(scopeCovers(caller, held, { type: 'department', values: ['d1'] })).toBe(true);
    expect(scopeCovers(caller, held, { type: 'department', values: ['d1', 'd3'] })).toBe(false);
    expect(scopeCovers(caller, held, { type: 'department', values: [] })).toBe(false);
    expect(scopeCovers(caller, held, { type: 'location', values: ['d1'] })).toBe(false);
  });
  it('self is covered when the held scope covers the assignee’s own record', () => {
    const held = { type: 'entity' as const, values: ['ent-uk'] };
    expect(scopeCovers(caller, held, { type: 'self' }, { target: { employeeId: 'e-a', entityId: 'ent-uk' } })).toBe(true);
    expect(scopeCovers(caller, held, { type: 'self' }, { target: { employeeId: 'e-b', entityId: 'ent-de' } })).toBe(false);
    expect(scopeCovers(caller, held, { type: 'self' }, {})).toBe(false);
  });
  it('own team is covered only for the caller or someone inside the caller’s own (not delegated) team', () => {
    const held = { type: 'own_team' as const };
    expect(scopeCovers(caller, held, { type: 'own_team' }, { inCallersTeam: true })).toBe(true);
    expect(scopeCovers(caller, held, { type: 'own_team' }, { isCaller: true })).toBe(true);
    expect(scopeCovers(caller, held, { type: 'own_team' }, {})).toBe(false);
    // delegated authority never lets a delegate hand out access over the delegator's team
    expect(scopeCovers(caller, held, { type: 'self' }, { target: { employeeId: 'e-x', managerChain: ['e-boss'] } })).toBe(false);
  });
  it('checkAssignment needs roles.assign and every permission at a covering scope', () => {
    const entityAdmin: Principal = { userId: 'u', employeeId: 'e', grants: [grant(['roles.assign', 'employees.read'], { 'employee.jobTitle': 'read' }, { type: 'entity', values: ['ent-uk'] })] };
    const def = { permissions: ['employees.read'], fieldAccess: { 'employee.jobTitle': 'read' as const } };
    expect(checkAssignment(entityAdmin, def, { type: 'entity', values: ['ent-uk'] }, {}, fieldProbes())).toEqual({ mayAssign: true, permissions: [], fields: [] });
    expect(checkAssignment(entityAdmin, def, { type: 'all' }, {}, fieldProbes())).toEqual({ mayAssign: false, permissions: ['employees.read'], fields: ['employee.jobTitle'] });
  });
});
