import { describe, expect, it } from 'vitest';
import { BUILT_IN_ROLES } from '@thapsus/core/roles';
import { locate, MODULES, viewerFromSession, visibleActions, visibleModules } from '../app/app/workspace';

/**
 * The workspace map decides what each role sees (ADR-0154): modules, tabs and quick actions. These
 * tests pin the gating for the built-in roles, so a permission change shows up here as well as in the
 * API's own authorisation tests.
 */
const role = (key: string) => BUILT_IN_ROLES.find((r) => r.key === key)!;
const viewer = (key: string, employee = true, askHr = false) =>
  viewerFromSession({ permissions: role(key).permissions, employeeId: employee ? 'e-1' : null }, askHr);
const modules = (key: string, employee = true) => visibleModules(viewer(key, employee)).map((m) => m.key);
const tabs = (key: string, module: string) =>
  visibleModules(viewer(key))
    .find((m) => m.key === module)
    ?.tabs.map((t) => t.href) ?? [];

describe('workspace map', () => {
  it('every module has a label, a description, tabs and app paths', () => {
    for (const m of MODULES) {
      expect(m.label).toMatch(/^[a-z]/);
      expect(m.description).toMatch(/^app\.ws\.desc\./);
      expect(m.tabs.length).toBeGreaterThan(0);
      for (const t of m.tabs) expect(t.href).toMatch(/^\/app(\/|$)/);
    }
  });

  it('the owner sees every module', () => {
    expect(modules('owner')).toEqual(
      expect.arrayContaining([
        'home',
        'me',
        'inbox',
        'people',
        'time',
        'pay',
        'it',
        'reports',
        'compliance',
        'privacy',
        'settings',
        'billing',
        'help',
      ]),
    );
  });

  it('an employee sees self-service only: no directory, reports, compliance, privacy, settings or billing', () => {
    const m = modules('employee');
    expect(m).toEqual(expect.arrayContaining(['home', 'me', 'inbox', 'people', 'time', 'pay', 'it', 'help']));
    for (const hidden of ['reports', 'compliance', 'privacy', 'settings', 'billing'])
      expect(m).not.toContain(hidden);
    // People shows the org chart and their documents, not the directory or imports
    expect(tabs('employee', 'people')).not.toContain('/app/people');
    expect(tabs('employee', 'people')).not.toContain('/app/imports');
    expect(tabs('employee', 'people')).toEqual(expect.arrayContaining(['/app/org-chart', '/app/documents']));
    // their own payslips and equipment, not payroll or integrations
    expect(tabs('employee', 'pay')).toEqual(['/app/payslips']);
    expect(tabs('employee', 'it')).toEqual(['/app/assets']);
  });

  it('a manager sees the directory and team reports, but not the builder, payroll, privacy or billing', () => {
    expect(tabs('manager', 'people')).toContain('/app/people');
    expect(tabs('manager', 'reports')).toEqual(['/app/reports']);
    expect(modules('manager')).not.toContain('privacy');
    expect(modules('manager')).not.toContain('billing');
    expect(tabs('manager', 'pay')).not.toContain('/app/payroll');
  });

  it('an HR admin runs reports and imports but never sees billing', () => {
    expect(tabs('hr_admin', 'reports')).toContain('/app/reports/builder');
    expect(tabs('hr_admin', 'people')).toContain('/app/imports');
    expect(modules('hr_admin')).not.toContain('billing');
  });

  it('a payroll admin sees payroll, not compliance or privacy', () => {
    expect(tabs('payroll_admin', 'pay')).toContain('/app/payroll');
    expect(modules('payroll_admin')).not.toContain('compliance');
    expect(modules('payroll_admin')).not.toContain('privacy');
  });

  it('someone without an employee record has no profile tabs or time-off request action', () => {
    expect(tabs('owner', 'me')).toContain('/app/me');
    const v = viewer('owner', false);
    expect(
      visibleModules(v)
        .find((m) => m.key === 'me')
        ?.tabs.map((t) => t.href),
    ).not.toContain('/app/me');
    expect(visibleActions(v).map((a) => a.key)).not.toContain('requestLeave');
  });

  it('quick actions follow permissions', () => {
    const owner = visibleActions(viewer('owner')).map((a) => a.key);
    const employee = visibleActions(viewer('employee')).map((a) => a.key);
    expect(owner).toEqual(expect.arrayContaining(['addPerson', 'buildReport', 'newRole', 'assignRoles']));
    expect(employee).toEqual(expect.arrayContaining(['requestLeave', 'clockIn', 'myDocuments']));
    for (const k of ['addPerson', 'buildReport', 'newRole', 'assignRoles', 'import'])
      expect(employee).not.toContain(k);
  });

  it('Ask HR appears only when the workspace and region allow it', () => {
    expect(tabs('employee', 'help')).not.toContain('/app/ask');
    const v = viewer('employee', true, true);
    expect(
      visibleModules(v)
        .find((m) => m.key === 'help')
        ?.tabs.map((t) => t.href),
    ).toContain('/app/ask');
  });

  it('Time opens on its overview, for every role', () => {
    for (const key of ['owner', 'hr_admin', 'manager', 'employee'])
      expect(tabs(key, 'time')[0], key).toBe('/app/time');
    const all = visibleModules(viewer('employee'));
    expect(all.find((m) => m.key === 'time')?.href).toBe('/app/time');
    // the overview tab is exact, so time off (which shares its prefix) keeps its own tab
    expect(locate(all, '/app/time')?.tab?.href).toBe('/app/time');
    expect(locate(all, '/app/time-off')?.tab?.href).toBe('/app/time-off');
  });

  it('locates a path in its module and tab, detail pages included', () => {
    const all = visibleModules(viewer('owner'));
    expect(locate(all, '/app')?.module.key).toBe('home');
    expect(locate(all, '/app/people/123')?.tab?.href).toBe('/app/people');
    expect(locate(all, '/app/org-chart')?.module.key).toBe('people');
    expect(locate(all, '/app/reports/builder')?.tab?.href).toBe('/app/reports/builder');
    expect(locate(all, '/app/reports')?.tab?.href).toBe('/app/reports');
    expect(locate(all, '/app/reports/runs/abc')).toMatchObject({ tab: null });
    expect(locate(all, '/app/reports/runs/abc')?.module.key).toBe('reports');
    expect(locate(all, '/app/compliance/reports/eeo-1')?.tab?.href).toBe('/app/compliance/reports/eeo-1');
    expect(locate(all, '/app/settings/sso')?.module.key).toBe('settings');
    expect(locate(all, '/app/unknown')).toBeNull();
  });
});

describe('account menu role line', () => {
  it('shows the most senior role first: admin roles, custom roles, then manager and employee', async () => {
    const { bySeniority } = await import('../lib/role-order');
    expect(bySeniority(['employee', 'manager'])).toEqual(['manager', 'employee']);
    expect(bySeniority(['employee', 'Night shift lead', 'manager'])).toEqual([
      'Night shift lead',
      'manager',
      'employee',
    ]);
    expect(bySeniority(['manager', 'payroll_admin', 'owner'])).toEqual(['owner', 'payroll_admin', 'manager']);
  });
});
