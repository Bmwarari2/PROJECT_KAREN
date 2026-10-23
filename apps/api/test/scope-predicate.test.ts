import { describe, expect, it } from 'vitest';
import type { Principal } from '@thapsus/core/permissions';
import { scopePredicate } from '../src/modules/employees/service';

const grant = (permissions: string[], scope: Principal['grants'][number]['scope']) => ({
  roleKey: 'fictional',
  isAdmin: false,
  permissions,
  fieldAccess: {},
  scope,
});
const EMP = '00000000-0000-4000-8000-000000000001';

describe('scopePredicate', () => {
  it('an all-scope grant after a narrower one leaves no unused query parameters', () => {
    const p: Principal = {
      userId: 'u',
      employeeId: EMP,
      grants: [grant(['leave.read'], { type: 'own_team' }), grant(['leave.read'], { type: 'all' })],
    };
    const params: unknown[] = ['kept'];
    expect(scopePredicate(p, 'leave.read', params)).toBe('true');
    expect(params).toEqual(['kept']);
  });
  it('narrower grants are OR-ed with their own parameters', () => {
    const p: Principal = {
      userId: 'u',
      employeeId: EMP,
      grants: [
        grant(['absence.read'], { type: 'department', values: ['d1'] }),
        grant(['leave.read'], { type: 'all' }),
      ],
    };
    const params: unknown[] = [];
    expect(scopePredicate(p, 'absence.read', params)).toBe('(e.department_id = ANY($1::uuid[]))');
    expect(params).toEqual([['d1']]);
    expect(scopePredicate({ userId: 'u', grants: [] }, 'absence.read', [])).toBe('false');
  });
});
