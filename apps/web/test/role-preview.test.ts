import { describe, expect, it } from 'vitest';
import { BUILT_IN_ROLES } from '@thapsus/core/roles';
import { rolePreview } from '../app/app/settings/roles/preview';
import { MODULES, viewerFromSession, visibleModules } from '../app/app/workspace';
import { SETTINGS_SECTIONS } from '../app/app/settings/sections';

/**
 * "Preview as role" on the compare page reuses the workspace map, so it shows exactly what the shell
 * would (apps/web/test/workspace.test.ts pins the map itself).
 */
const perms = (key: string) => BUILT_IN_ROLES.find((r) => r.key === key)!.permissions;
const keys = (xs: Array<{ key: string }>) => xs.map((x) => x.key);

describe('role preview', () => {
  it('shows the same modules and tabs as the shell for every built-in role', () => {
    for (const r of BUILT_IN_ROLES) {
      const p = rolePreview(r.permissions, { employee: true });
      const shell = visibleModules(viewerFromSession({ permissions: r.permissions, employeeId: 'e-1' }));
      expect(p.modules.map((m) => [m.key, m.tabs.map((t) => t.href)])).toEqual(
        shell.map((m) => [m.key, m.tabs.map((t) => t.href)]),
      );
      // shown and hidden modules together are the whole map, without overlap
      expect([...keys(p.modules), ...keys(p.hiddenModules)].sort()).toEqual(keys(MODULES).sort());
      expect([...p.sections, ...p.hiddenSections].length).toBe(SETTINGS_SECTIONS.length);
    }
  });

  it('an employee gets self-service only: no reports, settings or billing, and no settings sections', () => {
    const p = rolePreview(perms('employee'), { employee: true });
    expect(keys(p.hiddenModules)).toEqual(expect.arrayContaining(['reports', 'settings', 'billing']));
    expect(p.sections).toEqual([]);
    expect(keys(p.actions)).toContain('requestLeave');
    expect(keys(p.actions)).not.toContain('buildReport');
    // the directory tab is hidden inside People, which still shows the org chart
    const people = p.hiddenTabs.find((h) => h.module.key === 'people');
    expect(people?.tabs.map((t) => t.href)).toContain('/app/people');
  });

  it('a manager sees the report catalogue but not the builder, and can hand off approvals', () => {
    const p = rolePreview(perms('manager'), { employee: true });
    const reports = p.modules.find((m) => m.key === 'reports');
    expect(reports?.tabs.map((t) => t.href)).toEqual(['/app/reports']);
    expect(p.hiddenTabs.find((h) => h.module.key === 'reports')?.tabs.map((t) => t.href)).toContain(
      '/app/reports/builder',
    );
    expect(keys(p.sections)).toEqual(['delegations']);
  });

  it('an HR admin reaches roles and users but not billing; the owner reaches every settings section', () => {
    const hr = rolePreview(perms('hr_admin'), { employee: true });
    expect(keys(hr.sections)).toEqual(expect.arrayContaining(['roles', 'users', 'leave']));
    expect(keys(hr.hiddenModules)).toContain('billing');
    expect(keys(hr.actions)).not.toContain('newRole');
    const owner = rolePreview(['*'], { employee: true });
    expect(owner.hiddenSections).toEqual([]);
    expect(owner.hiddenModules).toEqual([]);
  });

  it('without an employee record, the personal tabs and requesting leave are not shown', () => {
    const p = rolePreview(perms('employee'), { employee: false });
    expect(keys(p.actions)).not.toContain('requestLeave');
    expect(p.hiddenTabs.find((h) => h.module.key === 'me')?.tabs.map((t) => t.href)).toContain('/app/me');
  });
});
