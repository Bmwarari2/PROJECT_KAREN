import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@thapsus/db';
import { ownerUrl, TEST_DBS } from '@thapsus/db/testing';
import { BUILT_IN_ROLES } from '@thapsus/core/roles';
import { EMPLOYEE_FIELDS } from '@thapsus/core/access';
import { closeDb, cookieFrom, enrolTotp, ownerSession, PASSWORD, randomIp, startTestApp, type TestContext } from './helpers';
import { assignRole } from '../src/modules/authz/principal';
import { hashPassword } from '../src/modules/auth/tokens';
import { DERIVED_PERMS, FIELDS } from '../src/modules/employees/model';

/** Role and access management: CRUD, validation, escalation guards, last owner, next-request effect, audit, isolation. */
let ctx: TestContext;
type Owner = Awaited<ReturnType<typeof ownerSession>>;
let owner: Owner;
let entityUk: string;
let entityDe: string;
let eng: string;
let sales: string;

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const call = (cookie: string, method: Method, url: string, payload?: unknown) => ctx.app.inject({ method, url, payload: payload as object, headers: { cookie }, remoteAddress: randomIp() });
const asOwner = (method: Method, url: string, payload?: unknown) => call(owner.cookie, method, url, payload);

async function hire(o: Owner, first: string, values: Record<string, unknown>) {
  const res = await call(o.cookie, 'POST', '/v1/employees', {
    startDate: '2026-01-05',
    legalFirstName: first,
    legalLastName: 'Fictional',
    jobTitle: 'Analyst',
    payAmountMinor: 4_000_000,
    payCurrency: 'GBP',
    payFrequency: 'annual',
    contractType: 'permanent',
    ...values,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

/** A sign-in for an employee (employee role only, unless more is given), signed in with a password. */
async function person(o: Owner, employeeId: string | null, opts: { role?: string; scope?: { type: 'all' | 'own_team' | 'department'; values?: string[] }; mfa?: boolean } = {}) {
  const email = `p.${Math.random().toString(36).slice(2, 8)}@${o.slug}.example.test`;
  const userId = await withTenant(ctx.deps.router, o.tenantId, async (tx) => {
    const u = await tx.one<{ id: string }>(`INSERT INTO app.users (tenant_id, email, display_name, employee_id) VALUES (app.current_tenant(), $1, 'Fictional Person', $2) RETURNING id`, [email, employeeId]);
    await tx.exec('INSERT INTO app.password_credentials (tenant_id, user_id, password_hash) VALUES (app.current_tenant(), $1, $2)', [u.id, await hashPassword(PASSWORD)]);
    await assignRole(tx, u.id, 'employee', { type: 'self' });
    if (opts.role) await assignRole(tx, u.id, opts.role, opts.scope);
    return u.id;
  });
  const res = await ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: o.slug, email, password: PASSWORD }, remoteAddress: randomIp() });
  expect(res.statusCode, res.body).toBe(200);
  const cookie = cookieFrom(res);
  if (opts.mfa) await enrolTotp(ctx, cookie);
  return { userId, email, cookie };
}

async function createRole(cookie: string, body: Record<string, unknown>) {
  const res = await call(cookie, 'POST', '/v1/roles', body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; key: string; isAdmin: boolean; permissions: string[]; fieldAccess: Record<string, string> };
}
async function assign(cookie: string, userId: string, roleId: string, scope: Record<string, unknown>) {
  return call(cookie, 'POST', `/v1/users/${userId}/role-assignments`, { roleId, scope });
}
const roleId = async (key: string) => ((await asOwner('GET', '/v1/roles')).json() as Array<{ id: string; key: string }>).find((r) => r.key === key)!.id;
const ownerAssignment = async (o: Owner) =>
  ((await call(o.cookie, 'GET', `/v1/users/${o.userId}/role-assignments`)).json().assignments as Array<{ id: string; roleKey: string }>).find((a) => a.roleKey === 'owner')!.id;
const auditRows = (o: Owner, action: string) =>
  withTenant(ctx.deps.router, o.tenantId, (tx) => tx.query<{ action: string; actor_id: string; target_id: string; diff: Record<string, { from: unknown; to: unknown }> }>(`SELECT action, actor_id, target_id, diff FROM audit.events WHERE action = $1 ORDER BY id`, [action]));

const DEPT_VIEWER = {
  key: 'dept_viewer',
  name: 'Department viewer',
  description: 'Sees colleagues in a department: names and job titles only',
  permissions: ['employees.read'],
  fieldAccess: { 'employee.*': 'none', 'employee.displayName': 'read', 'employee.jobTitle': 'read', 'employee.department': 'read' },
};

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  owner = await ownerSession(ctx);
  entityUk = (await asOwner('POST', '/v1/org/legal-entities', { name: 'Fictional UK Ltd', country: 'GB', currency: 'GBP', timeZone: 'Europe/London' })).json().id;
  entityDe = (await asOwner('POST', '/v1/org/legal-entities', { name: 'Fictional GmbH', country: 'DE', currency: 'EUR', timeZone: 'Europe/Berlin' })).json().id;
  eng = (await asOwner('POST', '/v1/org/departments', { name: 'Engineering' })).json().id;
  sales = (await asOwner('POST', '/v1/org/departments', { name: 'Sales' })).json().id;
});
afterAll(async () => {
  await ctx.close();
  await closeDb();
});

describe('catalogue and built-in roles', () => {
  it('lists the built-in roles exactly as the code defines them, read-only', async () => {
    const res = await asOwner('GET', '/v1/roles');
    expect(res.statusCode).toBe(200);
    const roles = res.json() as Array<{ id: string; key: string; builtIn: boolean; isAdmin: boolean; permissions: string[]; fieldAccess: Record<string, string>; assignmentCount: number }>;
    for (const b of BUILT_IN_ROLES) {
      const r = roles.find((x) => x.key === b.key)!;
      expect(r).toMatchObject({ builtIn: true, isAdmin: b.isAdmin, permissions: b.permissions, fieldAccess: b.fieldAccess });
    }
    expect(roles.find((r) => r.key === 'owner')!.assignmentCount).toBe(1);
    const one = await asOwner('GET', `/v1/roles/${roles[0]!.id}`);
    expect(one.json()).toEqual(roles[0]);
    const hr = roles.find((r) => r.key === 'hr_admin')!;
    expect(hr.permissions).toContain('roles.read');
    for (const method of ['PATCH', 'DELETE'] as const) {
      const refused = await asOwner(method, `/v1/roles/${hr.id}`, method === 'PATCH' ? { name: 'Renamed' } : undefined);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().reason).toBe('builtInRole');
    }
  });

  it('serves the permission and field catalogue, which covers every employee field the API checks', async () => {
    const res = await asOwner('GET', '/v1/roles/catalogue');
    expect(res.statusCode).toBe(200);
    const cat = res.json() as { areas: Array<{ area: string; permissions: Array<{ key: string; admin: boolean }> }>; fields: Array<{ key: string }> };
    expect(cat.areas.find((a) => a.area === 'roles')!.permissions).toEqual([
      { key: 'roles.read', admin: true },
      { key: 'roles.manage', admin: true },
      { key: 'roles.assign', admin: true },
    ]);
    const keys = new Set(EMPLOYEE_FIELDS.map((f) => f.key));
    for (const def of Object.values(FIELDS)) expect(keys.has(def.perm), def.perm).toBe(true);
    for (const perm of Object.values(DERIVED_PERMS)) expect(keys.has(perm), perm).toBe(true);
    expect(cat.fields.map((f) => f.key)).toEqual([...keys]);
  });
});

describe('custom role CRUD and validation', () => {
  it('creates, reads, updates and deletes a custom role, auditing each change with a before/after diff', async () => {
    const created = await createRole(owner.cookie, { ...DEPT_VIEWER, key: 'crud_role' });
    expect(created).toMatchObject({ key: 'crud_role', isAdmin: false, permissions: ['employees.read'] });
    expect((await asOwner('GET', `/v1/roles/${created.id}`)).json()).toMatchObject({ name: 'Department viewer', builtIn: false, assignmentCount: 0 });
    const updated = await asOwner('PATCH', `/v1/roles/${created.id}`, { name: 'Department reader', permissions: ['employees.read', 'leave.read'] });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({ name: 'Department reader', permissions: ['employees.read', 'leave.read'], fieldAccess: DEPT_VIEWER.fieldAccess });
    expect((await asOwner('POST', '/v1/roles', { ...DEPT_VIEWER, key: 'crud_role' })).statusCode).toBe(409);
    expect((await asOwner('DELETE', `/v1/roles/${created.id}`)).statusCode).toBe(204);
    expect((await asOwner('GET', `/v1/roles/${created.id}`)).statusCode).toBe(404);

    const [c] = (await auditRows(owner, 'role.created')).filter((r) => r.target_id === created.id);
    expect(c!.actor_id).toBe(owner.userId);
    expect(c!.diff.permissions).toEqual({ from: null, to: ['employees.read'] });
    expect(c!.diff.fieldAccess!.to).toContain('employee.jobTitle=read');
    const [u] = (await auditRows(owner, 'role.updated')).filter((r) => r.target_id === created.id);
    expect(u!.diff).toEqual({ name: { from: 'Department viewer', to: 'Department reader' }, permissions: { from: ['employees.read'], to: ['employees.read', 'leave.read'] } });
    const [d] = (await auditRows(owner, 'role.deleted')).filter((r) => r.target_id === created.id);
    expect(d!.diff.key).toEqual({ from: 'crud_role', to: null });
  });

  it('rejects unknown permissions, *, unknown fields, bad levels and built-in keys', async () => {
    const bad = async (body: Record<string, unknown>, status = 400) => {
      const res = await asOwner('POST', '/v1/roles', { ...DEPT_VIEWER, key: 'bad_role', ...body });
      expect(res.statusCode, res.body).toBe(status);
      return res.json();
    };
    expect((await bad({ permissions: ['employees.read', 'employees.teleport'] })).errors).toEqual([{ path: '/permissions/1', message: 'unknownPermission' }]);
    expect((await bad({ permissions: ['*'] })).errors).toEqual([{ path: '/permissions/0', message: 'ownerOnly' }]);
    expect((await bad({ fieldAccess: { 'employee.salary': 'read' } })).errors).toEqual([{ path: '/fieldAccess/employee.salary', message: 'unknownField' }]);
    await bad({ fieldAccess: { 'employee.jobTitle': 'admin' } });
    await bad({ key: 'Not A Key' });
    await bad({ surprise: true });
    expect((await bad({ key: 'hr_admin' }, 409)).reason).toBe('keyTaken');
    expect((await bad({ fieldAccess: { 'employee.custom.shoeSize': 'read' } })).errors[0].message).toBe('unknownField');
    // a custom field of this workspace becomes a valid field key
    expect((await asOwner('POST', '/v1/settings/custom-fields', { key: 'shoeSize', label: { 'en-GB': 'Shoe size' }, fieldType: 'number' })).statusCode).toBe(201);
    const ok = await createRole(owner.cookie, { ...DEPT_VIEWER, key: 'custom_field_role', fieldAccess: { 'employee.custom.shoeSize': 'read' } });
    expect(ok.fieldAccess).toEqual({ 'employee.custom.shoeSize': 'read' });
  });

  it('a role holding admin-grade permissions is always an admin role (MFA cannot be avoided)', async () => {
    const r = await createRole(owner.cookie, { key: 'quiet_admin', name: 'Quiet admin', permissions: ['roles.read', 'settings.manage'], isAdmin: false });
    expect(r.isAdmin).toBe(true);
    const patched = await asOwner('PATCH', `/v1/roles/${r.id}`, { isAdmin: false });
    expect(patched.json().isAdmin).toBe(true);
    const plain = await createRole(owner.cookie, { key: 'plain_reader', name: 'Plain reader', permissions: ['leave.read'], isAdmin: true });
    expect(plain.isAdmin).toBe(true);
  });

  it('refuses to delete a role in use until its assignments are revoked', async () => {
    const r = await createRole(owner.cookie, { ...DEPT_VIEWER, key: 'in_use_role' });
    const emp = await hire(owner, 'Ivy', { entityId: entityUk, departmentId: eng });
    const p = await person(owner, emp);
    const a = await assign(owner.cookie, p.userId, r.id, { type: 'department', values: [eng] });
    expect(a.statusCode, a.body).toBe(201);
    const refused = await asOwner('DELETE', `/v1/roles/${r.id}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ reason: 'roleInUse', assignments: 1 });
    expect((await asOwner('DELETE', `/v1/users/${p.userId}/role-assignments/${a.json().id}`)).statusCode).toBe(204);
    expect((await asOwner('DELETE', `/v1/roles/${r.id}`)).statusCode).toBe(204);
  });
});

describe('assignments', () => {
  it('validates scope values against the workspace and refuses duplicates', async () => {
    const r = await createRole(owner.cookie, { ...DEPT_VIEWER, key: 'scope_role' });
    const p = await person(owner, await hire(owner, 'Sam', { entityId: entityUk, departmentId: eng }));
    const errorsFor = async (scope: Record<string, unknown>, roleKeyId = r.id) => {
      const res = await assign(owner.cookie, p.userId, roleKeyId, scope);
      expect(res.statusCode, res.body).toBe(400);
      return res.json().errors.map((e: { message: string }) => e.message);
    };
    expect(await errorsFor({ type: 'department', values: [crypto.randomUUID()] })).toEqual(['unknownScopeValue']);
    expect(await errorsFor({ type: 'department', values: [entityUk] })).toEqual(['unknownScopeValue']);
    expect(await errorsFor({ type: 'department' })).toEqual(['scopeNeedsValues']);
    expect(await errorsFor({ type: 'self', values: [eng] })).toEqual(['scopeTakesNoValues']);
    expect(await errorsFor({ type: 'country', values: ['FR'] })).toEqual(['unknownScopeValue']);
    expect(await errorsFor({ type: 'galaxy', values: [] })).toBeDefined();
    expect(await errorsFor({ type: 'department', values: [eng] }, await roleId('owner'))).toEqual(['ownerScopeAll']);

    const ok = await assign(owner.cookie, p.userId, r.id, { type: 'country', values: ['DE'] });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ roleKey: 'scope_role', scope: { type: 'country', values: ['DE'] }, scopeLabels: ['DE'], createdBy: owner.userId });
    const entity = await assign(owner.cookie, p.userId, r.id, { type: 'entity', values: [entityDe, entityUk] });
    expect(entity.statusCode, entity.body).toBe(201);
    expect(entity.json().scopeLabels.sort()).toEqual(['Fictional GmbH', 'Fictional UK Ltd']);
    const dup = await assign(owner.cookie, p.userId, r.id, { type: 'entity', values: [entityUk, entityDe] });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().reason).toBe('duplicateAssignment');

    const list = await asOwner('GET', `/v1/users/${p.userId}/role-assignments`);
    expect(list.statusCode).toBe(200);
    expect(list.json().user).toMatchObject({ id: p.userId, hasMfa: false, roles: ['employee', 'scope_role'] });
    expect(list.json().assignments.map((a: { roleKey: string; canRevoke: boolean }) => [a.roleKey, a.canRevoke])).toEqual([
      ['employee', true],
      ['scope_role', true],
      ['scope_role', true],
    ]);
    const users = (await asOwner('GET', `/v1/users?q=${encodeURIComponent(p.email)}`)).json();
    expect(users.data).toEqual([expect.objectContaining({ id: p.userId, roles: ['employee', 'scope_role'] })]);
  });

  it('a change applies to the person’s very next request: grant, edit and revoke', async () => {
    const r = await createRole(owner.cookie, { ...DEPT_VIEWER, key: 'next_request_role' });
    const ana = await hire(owner, 'Ana', { entityId: entityUk, departmentId: eng, workEmail: 'ana@fictional.example.test' });
    const ben = await hire(owner, 'Ben', { entityId: entityUk, departmentId: eng, workEmail: 'ben@fictional.example.test' });
    const cat = await hire(owner, 'Cat', { entityId: entityUk, departmentId: sales });
    const p = await person(owner, ana);
    expect((await call(p.cookie, 'GET', '/v1/employees')).statusCode).toBe(403);

    const a = await assign(owner.cookie, p.userId, r.id, { type: 'department', values: [eng] });
    expect(a.statusCode, a.body).toBe(201);
    const list = await call(p.cookie, 'GET', '/v1/employees?limit=200');
    expect(list.statusCode).toBe(200);
    const rows = list.json().data as Array<Record<string, unknown>>;
    const ids = rows.map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining([ana, ben]));
    expect(ids).not.toContain(cat);
    // field access from the role: names and job titles, never work email or pay for colleagues
    const benRow = rows.find((x) => x.id === ben)!;
    expect(benRow).toMatchObject({ displayName: 'Ben Fictional', jobTitle: 'Analyst', department: 'Engineering' });
    expect(benRow.workEmail).toBeUndefined();
    const benProfile = (await call(p.cookie, 'GET', `/v1/employees/${ben}`)).json();
    expect(benProfile.access).toMatchObject({ jobTitle: 'read', payAmountMinor: 'none', workEmail: 'none' });
    expect(benProfile.employee.payAmountMinor).toBeUndefined();
    expect((await call(p.cookie, 'GET', `/v1/employees/${cat}`)).statusCode).toBe(403);

    // editing the role reaches holders immediately
    expect((await asOwner('PATCH', `/v1/roles/${r.id}`, { fieldAccess: { ...DEPT_VIEWER.fieldAccess, 'employee.jobTitle': 'none' } })).statusCode).toBe(200);
    expect((await call(p.cookie, 'GET', `/v1/employees/${ben}`)).json().access.jobTitle).toBe('none');
    // and so does revoking it
    expect((await asOwner('DELETE', `/v1/users/${p.userId}/role-assignments/${a.json().id}`)).statusCode).toBe(204);
    expect((await call(p.cookie, 'GET', '/v1/employees')).statusCode).toBe(403);
    const [revoked] = (await auditRows(owner, 'role.revoked')).filter((x) => x.target_id === p.userId);
    expect(revoked!.diff).toMatchObject({ assignmentId: a.json().id, role: { from: 'next_request_role', to: null }, scopeType: { from: 'department', to: null }, scopeValues: { from: [eng], to: null } });
  });

  it('an admin role can be given to someone without MFA, who must then verify before using anything', async () => {
    const p = await person(owner, await hire(owner, 'Mia', { entityId: entityUk }));
    expect((await call(p.cookie, 'GET', '/v1/auth/session')).json().isAdmin).toBe(false);
    const a = await assign(owner.cookie, p.userId, await roleId('hr_admin'), { type: 'all' });
    expect(a.statusCode, a.body).toBe(201);
    expect(a.json().isAdmin).toBe(true);
    const blocked = await call(p.cookie, 'GET', '/v1/employees');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('mfaEnrollmentRequired');
    const session = await call(p.cookie, 'GET', '/v1/auth/session');
    expect(session.json()).toMatchObject({ isAdmin: true, mfaVerified: false, roles: expect.arrayContaining(['hr_admin']) });
    await enrolTotp(ctx, p.cookie);
    expect((await call(p.cookie, 'GET', '/v1/employees')).statusCode).toBe(200);
  });
});

describe('privilege-escalation guards', () => {
  let access: Awaited<ReturnType<typeof person>>;
  let accessRole: string;
  let teammate: Awaited<ReturnType<typeof person>>;

  beforeAll(async () => {
    // A delegated access administrator for Engineering only.
    const role = await createRole(owner.cookie, {
      key: 'eng_access_admin',
      name: 'Engineering access admin',
      permissions: ['roles.read', 'roles.manage', 'roles.assign', 'employees.read', 'leave.read'],
      fieldAccess: { 'employee.displayName': 'read', 'employee.jobTitle': 'read' },
    });
    expect(role.isAdmin).toBe(true);
    accessRole = role.id;
    access = await person(owner, await hire(owner, 'Ada', { entityId: entityUk, departmentId: eng }), { mfa: true });
    expect((await assign(owner.cookie, access.userId, accessRole, { type: 'department', values: [eng] })).statusCode).toBe(201);
    teammate = await person(owner, await hire(owner, 'Tom', { entityId: entityUk, departmentId: eng }));
  });

  it('subset rule: roles may only grant permissions and field access the caller holds', async () => {
    const tryCreate = async (body: Record<string, unknown>) => call(access.cookie, 'POST', '/v1/roles', { key: `sub_${Math.random().toString(36).slice(2, 7)}`, name: 'Sub role', ...body });
    const perm = await tryCreate({ permissions: ['employees.read', 'employees.update'] });
    expect(perm.statusCode).toBe(403);
    expect(perm.json()).toMatchObject({ reason: 'exceedsYourAccess', permissions: ['employees.update'], fields: [] });
    const wildcard = await tryCreate({ permissions: ['employees.*'] });
    expect(wildcard.json()).toMatchObject({ reason: 'exceedsYourAccess', permissions: ['employees.*'] });
    // their own employee role lets them read (not write) their own pay, so pay write is beyond them
    const field = await tryCreate({ permissions: ['employees.read'], fieldAccess: { 'employee.pay.amount': 'write' } });
    expect(field.statusCode).toBe(403);
    expect(field.json().fields).toEqual(['employee.pay.amount']);
    const write = await tryCreate({ permissions: ['employees.read'], fieldAccess: { 'employee.jobTitle': 'write' } });
    expect(write.json().fields).toEqual(['employee.jobTitle']);
    const wide = await tryCreate({ permissions: ['employees.read'], fieldAccess: { 'employee.*': 'write' } });
    expect(wide.statusCode).toBe(403);
    const ok = await tryCreate({ permissions: ['employees.read'], fieldAccess: { 'employee.jobTitle': 'read' } });
    expect(ok.statusCode, ok.body).toBe(201);
    // nor edit a role that is beyond them, nor delete one
    const payRole = await createRole(owner.cookie, { key: 'pay_editor', name: 'Pay editor', permissions: ['employees.update'], fieldAccess: { 'employee.pay.amount': 'write' } });
    const edit = await call(access.cookie, 'PATCH', `/v1/roles/${payRole.id}`, { name: 'Renamed by someone with less access' });
    expect(edit.statusCode).toBe(403);
    expect((await call(access.cookie, 'DELETE', `/v1/roles/${payRole.id}`)).statusCode).toBe(403);
    // and cannot widen their own role
    expect((await call(access.cookie, 'PATCH', `/v1/roles/${accessRole}`, { permissions: ['roles.read', 'roles.manage', 'roles.assign', 'employees.read', 'leave.read', 'leave.approve'] })).statusCode).toBe(403);
  });

  it('scope rule: assignments may not reach further than the caller’s own scope', async () => {
    const r = await createRole(access.cookie, { key: 'eng_reader', name: 'Engineering reader', permissions: ['employees.read'], fieldAccess: { 'employee.jobTitle': 'read' } });
    const inside = await assign(access.cookie, teammate.userId, r.id, { type: 'department', values: [eng] });
    expect(inside.statusCode, inside.body).toBe(201);
    for (const scope of [{ type: 'department', values: [sales] }, { type: 'department', values: [eng, sales] }, { type: 'all' }, { type: 'entity', values: [entityUk] }]) {
      const res = await assign(access.cookie, teammate.userId, r.id, scope);
      expect(res.statusCode, JSON.stringify(scope)).toBe(403);
      expect(res.json().reason).toBe('scopeTooWide');
    }
    // access held only for their own record (pay, via their employee role) cannot be handed out for a department
    const ownPay = await createRole(access.cookie, { key: 'own_pay_reader', name: 'Own pay reader', permissions: ['employees.read'], fieldAccess: { 'employee.pay.amount': 'read' } });
    const payOut = await assign(access.cookie, teammate.userId, ownPay.id, { type: 'department', values: [eng] });
    expect(payOut.statusCode).toBe(403);
    expect(payOut.json()).toMatchObject({ reason: 'exceedsYourAccess', permissions: [], fields: ['employee.pay.amount'] });
    // a built-in role with more than the caller holds, even at the caller's own scope
    const hr = await assign(access.cookie, teammate.userId, await roleId('hr_admin'), { type: 'department', values: [eng] });
    expect(hr.statusCode).toBe(403);
    expect(hr.json().reason).toBe('exceedsYourAccess');
    expect(hr.json().permissions).toContain('employees.*');
    // nor to themselves
    expect((await assign(access.cookie, access.userId, await roleId('hr_admin'), { type: 'department', values: [eng] })).statusCode).toBe(403);
    expect((await assign(access.cookie, access.userId, await roleId('owner'), { type: 'all' })).statusCode).toBe(403);
    // nor revoke what they could not have granted (the owner's own owner role)
    const revokeOwner = await call(access.cookie, 'DELETE', `/v1/users/${owner.userId}/role-assignments/${await ownerAssignment(owner)}`);
    expect(revokeOwner.statusCode).toBe(403);
    const seen = (await call(access.cookie, 'GET', `/v1/users/${owner.userId}/role-assignments`)).json().assignments as Array<{ roleKey: string; canRevoke: boolean }>;
    expect(seen.find((a) => a.roleKey === 'owner')!.canRevoke).toBe(false);
    // but they can revoke what they granted
    expect((await call(access.cookie, 'DELETE', `/v1/users/${teammate.userId}/role-assignments/${inside.json().id}`)).statusCode).toBe(204);
  });

  it('editing a role cannot add access its holders would get beyond the editor’s scope; narrowing is always allowed', async () => {
    const r = await createRole(access.cookie, { key: 'shared_reader', name: 'Shared reader', permissions: ['employees.read'], fieldAccess: { 'employee.jobTitle': 'read' } });
    const salesPerson = await person(owner, await hire(owner, 'Sol', { entityId: entityUk, departmentId: sales }));
    // the owner hands the same role out company-wide
    expect((await assign(owner.cookie, salesPerson.userId, r.id, { type: 'all' })).statusCode).toBe(201);
    const widen = await call(access.cookie, 'PATCH', `/v1/roles/${r.id}`, { permissions: ['employees.read', 'leave.read'] });
    expect(widen.statusCode).toBe(403);
    expect(widen.json()).toMatchObject({ reason: 'exceedsYourAccess', permissions: ['leave.read'] });
    const field = await call(access.cookie, 'PATCH', `/v1/roles/${r.id}`, { fieldAccess: { 'employee.jobTitle': 'read', 'employee.displayName': 'read' } });
    expect(field.statusCode).toBe(403);
    expect(field.json().fields).toEqual(['employee.displayName']);
    const narrow = await call(access.cookie, 'PATCH', `/v1/roles/${r.id}`, { name: 'Shared reader (narrow)', fieldAccess: {} });
    expect(narrow.statusCode, narrow.body).toBe(200);
    // the owner may widen it (they hold everything everywhere)
    expect((await asOwner('PATCH', `/v1/roles/${r.id}`, { permissions: ['employees.read', 'leave.read'] })).statusCode).toBe(200);
  });

  it('people without role permissions cannot read or change roles', async () => {
    const mgr = await person(owner, await hire(owner, 'Max', { entityId: entityUk }), { role: 'manager', scope: { type: 'own_team' } });
    expect((await call(mgr.cookie, 'GET', '/v1/roles')).statusCode).toBe(403);
    expect((await call(mgr.cookie, 'GET', '/v1/roles/catalogue')).statusCode).toBe(403);
    expect((await call(mgr.cookie, 'GET', '/v1/users')).statusCode).toBe(403);
    expect((await call(mgr.cookie, 'POST', '/v1/roles', { ...DEPT_VIEWER, key: 'mgr_role' })).statusCode).toBe(403);
    expect((await assign(mgr.cookie, mgr.userId, await roleId('hr_admin'), { type: 'all' })).statusCode).toBe(403);
    // HR admins can read roles but not change them
    const hr = await person(owner, await hire(owner, 'Hal', { entityId: entityUk }), { role: 'hr_admin', scope: { type: 'all' }, mfa: true });
    expect((await call(hr.cookie, 'GET', '/v1/roles')).statusCode).toBe(200);
    expect((await call(hr.cookie, 'POST', '/v1/roles', { ...DEPT_VIEWER, key: 'hr_role' })).statusCode).toBe(403);
    expect((await assign(hr.cookie, hr.userId, await roleId('owner'), { type: 'all' })).statusCode).toBe(403);
  });
});

describe('last owner', () => {
  it('nobody can remove the last owner; with a second owner, one may step down', async () => {
    const o = await ownerSession(ctx);
    const first = await ownerAssignment(o);
    const last = await call(o.cookie, 'DELETE', `/v1/users/${o.userId}/role-assignments/${first}`);
    expect(last.statusCode).toBe(409);
    expect(last.json().reason).toBe('lastOwner');

    const entity = (await call(o.cookie, 'POST', '/v1/org/legal-entities', { name: 'Fictional Co Ltd', country: 'GB', currency: 'GBP', timeZone: 'Europe/London' })).json().id;
    const second = await person(o, await hire(o, 'Nia', { entityId: entity }), { mfa: true });
    const ownerRole = ((await call(o.cookie, 'GET', '/v1/roles')).json() as Array<{ id: string; key: string }>).find((r) => r.key === 'owner')!.id;
    expect((await call(o.cookie, 'POST', `/v1/users/${second.userId}/role-assignments`, { roleId: ownerRole, scope: { type: 'all' } })).statusCode).toBe(201);
    // a deactivated owner does not count: deactivate the second owner, and the first is the last again
    await withTenant(ctx.deps.router, o.tenantId, (tx) => tx.exec(`UPDATE app.users SET status = 'deactivated' WHERE id = $1`, [second.userId]));
    expect((await call(o.cookie, 'DELETE', `/v1/users/${o.userId}/role-assignments/${first}`)).statusCode).toBe(409);
    await withTenant(ctx.deps.router, o.tenantId, (tx) => tx.exec(`UPDATE app.users SET status = 'active' WHERE id = $1`, [second.userId]));
    expect((await call(o.cookie, 'DELETE', `/v1/users/${o.userId}/role-assignments/${first}`)).statusCode).toBe(204);
    // the original owner lost the role on their next request; the new owner is now the last one
    expect((await call(o.cookie, 'GET', '/v1/roles')).statusCode).toBe(403);
    const secondOwner = ((await call(second.cookie, 'GET', `/v1/users/${second.userId}/role-assignments`)).json().assignments as Array<{ id: string; roleKey: string }>).find((a) => a.roleKey === 'owner')!.id;
    const refused = await call(second.cookie, 'DELETE', `/v1/users/${second.userId}/role-assignments/${secondOwner}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().reason).toBe('lastOwner');
  });
});

describe('audit export and tenant isolation', () => {
  it('role changes appear in the customer’s audit export', async () => {
    await createRole(owner.cookie, { ...DEPT_VIEWER, key: 'export_role' });
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 3_600_000).toISOString();
    const csv = await asOwner('GET', `/v1/audit/events?from=${from}&to=${to}&format=csv&action=role.`);
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('"role.created"');
    expect(csv.body).toContain('"role.assigned"');
    expect(csv.body).toContain('"role.revoked"');
    expect(csv.body).toContain('export_role');
  });

  it('another workspace cannot see, change, assign or use this workspace’s roles and users', async () => {
    const other = await ownerSession(ctx);
    const mine = await createRole(owner.cookie, { ...DEPT_VIEWER, key: 'isolated_role' });
    const theirs = await createRole(other.cookie, { ...DEPT_VIEWER, key: 'isolated_role' }); // same key, separate workspace
    expect(theirs.id).not.toBe(mine.id);
    const p = await person(owner, await hire(owner, 'Iso', { entityId: entityUk, departmentId: eng }));
    const otherCall = (method: Method, url: string, payload?: unknown) => call(other.cookie, method, url, payload);
    expect((await otherCall('GET', `/v1/roles/${mine.id}`)).statusCode).toBe(404);
    expect((await otherCall('PATCH', `/v1/roles/${mine.id}`, { name: 'Hijacked' })).statusCode).toBe(404);
    expect((await otherCall('DELETE', `/v1/roles/${mine.id}`)).statusCode).toBe(404);
    expect((await otherCall('GET', `/v1/users/${p.userId}/role-assignments`)).statusCode).toBe(404);
    expect((await otherCall('POST', `/v1/users/${p.userId}/role-assignments`, { roleId: theirs.id, scope: { type: 'all' } })).statusCode).toBe(404);
    expect((await otherCall('POST', `/v1/users/${other.userId}/role-assignments`, { roleId: mine.id, scope: { type: 'all' } })).statusCode).toBe(404);
    expect(((await otherCall('GET', '/v1/roles')).json() as Array<{ id: string }>).map((r) => r.id)).not.toContain(mine.id);
    expect(((await otherCall('GET', '/v1/users?limit=200')).json().data as Array<{ id: string }>).map((u) => u.id)).not.toContain(p.userId);
    // and the database itself refuses: RLS hides the row even when queried by id
    const seen = await withTenant(ctx.deps.router, other.tenantId, (tx) => tx.query(`SELECT 1 FROM app.roles WHERE id = $1`, [mine.id]));
    expect(seen).toEqual([]);
    expect((await asOwner('GET', `/v1/roles/${mine.id}`)).json().name).toBe('Department viewer');
  });
});

describe('migration 0018', () => {
  it('gives existing tenants’ built-in roles the role-management keys, never touching custom roles', async () => {
    const o = await ownerSession(ctx);
    const custom = await createRole(o.cookie, { key: 'legacy_role', name: 'Legacy role', permissions: ['leave.read'] });
    const client = new pg.Client({ connectionString: ownerUrl(TEST_DBS.shared) });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [o.tenantId]);
      // an "old" tenant whose HR admin row predates role management
      await client.query(`UPDATE app.roles SET permissions = array_remove(permissions, 'roles.read') WHERE key = 'hr_admin'`);
      await client.query(readFileSync(join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations', '0018_role_management.sql'), 'utf8'));
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [o.tenantId]);
      const rows = (await client.query<{ key: string; permissions: string[] }>(`SELECT key, permissions FROM app.roles WHERE key IN ('hr_admin', 'owner', 'legacy_role')`)).rows;
      expect(rows.find((r) => r.key === 'hr_admin')!.permissions).toContain('roles.read');
      expect(rows.find((r) => r.key === 'owner')!.permissions).toEqual(['*']);
      expect(rows.find((r) => r.key === 'legacy_role')!.permissions).toEqual(custom.permissions);
      // re-running is harmless (no duplicate keys)
      await client.query(readFileSync(join(__dirname, '..', '..', '..', 'packages', 'db', 'migrations', '0018_role_management.sql'), 'utf8'));
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [o.tenantId]);
      const again = (await client.query<{ permissions: string[] }>(`SELECT permissions FROM app.roles WHERE key = 'hr_admin'`)).rows[0]!;
      expect(again.permissions.filter((x) => x === 'roles.read')).toHaveLength(1);
      const forced = (await client.query<{ relforcerowsecurity: boolean }>(`SELECT relforcerowsecurity FROM pg_class WHERE oid = 'app.roles'::regclass`)).rows[0]!;
      expect(forced.relforcerowsecurity).toBe(true);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });
});
