import { describe, expect, it } from 'vitest';
import { can, canSome, fieldAccess, filterReadable, isAdmin, unwritableFields, type Principal, type RoleGrant } from '../src/permissions';
import { BUILT_IN_ROLES } from '../src/roles';

const role = (key: string, scope: RoleGrant['scope']): RoleGrant => {
  const r = BUILT_IN_ROLES.find((x) => x.key === key)!;
  return { roleKey: r.key, isAdmin: r.isAdmin, permissions: r.permissions, fieldAccess: r.fieldAccess, scope };
};

const alice: Principal = { userId: 'u-alice', employeeId: 'e-alice', grants: [role('employee', { type: 'self' })] };
const manager: Principal = {
  userId: 'u-mgr',
  employeeId: 'e-mgr',
  grants: [role('employee', { type: 'self' }), role('manager', { type: 'own_team' })],
};
const ukHr: Principal = {
  userId: 'u-ukhr',
  employeeId: 'e-ukhr',
  grants: [role('entity_hr_admin', { type: 'entity', values: ['ent-uk'] })],
};
const deHr: Principal = {
  userId: 'u-dehr',
  grants: [role('entity_hr_admin', { type: 'country', values: ['DE'] })],
};

const aliceTarget = { employeeId: 'e-alice', entityId: 'ent-uk', country: 'GB', managerChain: ['e-mgr', 'e-director'] };
const bobTarget = { employeeId: 'e-bob', entityId: 'ent-de', country: 'DE', managerChain: ['e-other'] };

describe('permission engine', () => {
  it('denies by default', () => {
    const nobody: Principal = { userId: 'x', grants: [] };
    expect(can(nobody, 'employees.read', aliceTarget)).toBe(false);
    expect(fieldAccess(nobody, 'employee', 'displayName', aliceTarget)).toBe('none');
  });

  it('employee sees own record only and can edit contact fields only', () => {
    expect(can(alice, 'self.read', aliceTarget)).toBe(true);
    expect(can(alice, 'self.read', bobTarget)).toBe(false);
    expect(fieldAccess(alice, 'employee', 'pay.salary', aliceTarget)).toBe('read');
    expect(unwritableFields(alice, 'employee', ['personalEmail', 'jobTitle'], aliceTarget)).toEqual(['jobTitle']);
    expect(fieldAccess(alice, 'employee', 'personalEmail', bobTarget)).toBe('none');
  });

  it('manager scope covers the whole reporting chain below them but not other teams', () => {
    expect(can(manager, 'leave.approve', aliceTarget)).toBe(true);
    expect(can(manager, 'leave.approve', bobTarget)).toBe(false);
    expect(fieldAccess(manager, 'employee', 'jobTitle', aliceTarget)).toBe('read');
    expect(fieldAccess(manager, 'employee', 'pay.salary', aliceTarget)).toBe('none');
    expect(filterReadable(manager, 'employee', { id: '1', displayName: 'A', homeAddress: 'x', jobTitle: 'Dev' }, aliceTarget)).toEqual({
      id: '1',
      displayName: 'A',
      jobTitle: 'Dev',
    });
  });

  it('delegation extends team authority for its duration only', () => {
    const delegate: Principal = { userId: 'u-d', employeeId: 'e-d', grants: [role('manager', { type: 'own_team' })] };
    expect(can(delegate, 'leave.approve', aliceTarget)).toBe(false);
    expect(can({ ...delegate, delegatedFromEmployeeIds: ['e-mgr'] }, 'leave.approve', aliceTarget)).toBe(true);
  });

  it('entity and country scopes are enforced', () => {
    expect(can(ukHr, 'employees.update', aliceTarget)).toBe(true);
    expect(can(ukHr, 'employees.update', bobTarget)).toBe(false);
    expect(can(deHr, 'employees.update', bobTarget)).toBe(true);
    expect(can(deHr, 'employees.update', aliceTarget)).toBe(false);
    expect(canSome(ukHr, 'employees.read')).toBe(true);
  });

  it('department and location scopes are enforced (deny when the target lacks the attribute)', () => {
    const deptHr: Principal = { userId: 'u-dept', grants: [role('entity_hr_admin', { type: 'department', values: ['dep-eng'] })] };
    const siteLead: Principal = { userId: 'u-site', grants: [role('entity_hr_admin', { type: 'location', values: ['loc-leeds'] })] };
    const eng = { employeeId: 'e-1', departmentId: 'dep-eng', locationId: 'loc-london' };
    const ops = { employeeId: 'e-2', departmentId: 'dep-ops', locationId: 'loc-leeds' };
    expect(can(deptHr, 'employees.update', eng)).toBe(true);
    expect(can(deptHr, 'employees.update', ops)).toBe(false);
    expect(can(siteLead, 'employees.update', ops)).toBe(true);
    expect(can(siteLead, 'employees.update', eng)).toBe(false);
    expect(can(siteLead, 'employees.update', { employeeId: 'e-3' })).toBe(false);
    expect(can(siteLead, 'employees.update')).toBe(false);
  });

  it('custom roles with field-level permissions: most specific key wins, highest grant wins', () => {
    const custom: Principal = {
      userId: 'u-c',
      grants: [
        {
          roleKey: 'recruiter',
          isAdmin: false,
          permissions: ['employees.read'],
          fieldAccess: { 'employee.*': 'read', 'employee.pay.*': 'none', 'employee.pay.grade': 'read' },
          scope: { type: 'department', values: ['dep-eng'] },
        },
      ],
    };
    const t = { departmentId: 'dep-eng' };
    expect(fieldAccess(custom, 'employee', 'jobTitle', t)).toBe('read');
    expect(fieldAccess(custom, 'employee', 'pay.salary', t)).toBe('none');
    expect(fieldAccess(custom, 'employee', 'pay.grade', t)).toBe('read');
    expect(fieldAccess(custom, 'employee', 'jobTitle', { departmentId: 'dep-sales' })).toBe('none');
  });

  it('vault permissions are category specific', () => {
    expect(can(ukHr, 'vault.read:health', aliceTarget)).toBe(true);
    expect(can(manager, 'vault.read:health', aliceTarget)).toBe(false);
  });

  it('admin flag', () => {
    expect(isAdmin(ukHr)).toBe(true);
    expect(isAdmin(manager)).toBe(false);
  });
});
