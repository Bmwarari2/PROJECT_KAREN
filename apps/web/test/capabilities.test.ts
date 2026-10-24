import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allows, CAPABILITIES, pageFor, PAGES } from '@thapsus/core/capabilities';
import { BUILT_IN_ROLES } from '@thapsus/core/roles';
import {
  ACTIONS,
  dockModules,
  mayOpenPage,
  MODULES,
  viewerFromSession,
  visibleActions,
  visibleModules,
} from '../app/app/workspace';
import { sectionCapability, SETTINGS_SECTIONS, visibleSections } from '../app/app/settings/sections';

/**
 * The app reads the permission map (PROGRESS 16.1–16.2, ADR-0188): every page of the app has an entry,
 * and the navigation (rail, phone tab bar, menu sheet), global search's pages and actions, and the
 * settings index decide what to show from it.
 */
const APP = join(import.meta.dirname, '..', 'app');
function pageRoutes(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name === 'page.tsx')
        out.push(
          '/' +
            relative(APP, dir)
              .split(sep)
              .filter((s) => s && !/^\(.*\)$/.test(s))
              .join('/'),
        );
    }
  };
  walk(join(APP, 'app'));
  return out.sort();
}
const viewer = (key: string, features?: Record<string, boolean>) =>
  viewerFromSession(
    { permissions: BUILT_IN_ROLES.find((r) => r.key === key)!.permissions, employeeId: 'e-1' },
    false,
    { features },
  );

describe('the app reads the permission map', () => {
  it('every page of the app has an entry (add new pages to PAGES in @thapsus/core/capabilities)', () => {
    const missing = pageRoutes().filter((r) => !PAGES.some((p) => p.path === r));
    expect(missing).toEqual([]);
    const stale = PAGES.filter((p) => !pageRoutes().includes(p.path)).map((p) => p.path);
    expect(stale).toEqual([]);
  });

  it('every navigation tab, quick action and settings section is a page of the map', () => {
    for (const m of MODULES) for (const t of m.tabs) expect(pageFor(t.href)?.path, t.href).toBe(t.href);
    for (const a of ACTIONS) expect(pageFor(a.href), a.href).toBeDefined();
    for (const s of SETTINGS_SECTIONS) expect(CAPABILITIES[sectionCapability(s)], s.key).toBeDefined();
  });

  it('for every role, a tab is shown exactly when its page may be opened', () => {
    for (const r of BUILT_IN_ROLES) {
      const v = viewer(r.key);
      const shown = new Set(visibleModules(v).flatMap((m) => m.tabs.map((t) => t.href)));
      for (const m of MODULES)
        for (const t of m.tabs)
          expect(shown.has(t.href), `${r.key} ${t.href}`).toBe(allows(v, pageFor(t.href)!.view));
      // a page someone may not open shows the not-allowed state; a tab never leads there
      for (const href of shown) expect(mayOpenPage(v, href), `${r.key} ${href}`).toBe(true);
      // the phone tab bar only holds modules from the rail
      const keys = new Set(visibleModules(v).map((m) => m.key));
      for (const d of dockModules(visibleModules(v), v)) expect(keys.has(d.key)).toBe(true);
      // quick actions (home page and search) only where the viewer may act and open the page
      for (const a of visibleActions(v)) {
        expect(v.can(a.capability), `${r.key} ${a.key}`).toBe(true);
        expect(mayOpenPage(v, a.href), `${r.key} ${a.key}`).toBe(true);
      }
    }
  });

  it('the settings index lists only sections whose page opens, with the workspace’s features applied', () => {
    for (const r of BUILT_IN_ROLES) {
      const v = viewer(r.key);
      for (const s of visibleSections(v.has)) expect(allows(v, sectionCapability(s)), `${r.key} ${s.key}`).toBe(true);
    }
    const owner = viewer('owner');
    const withFlags = (on: boolean) =>
      visibleSections(owner.has, { feature: () => on, sandbox: false }).map((s) => s.key);
    expect(withFlags(true)).toContain('branding');
    expect(withFlags(false)).not.toContain('branding');
    expect(withFlags(false)).not.toContain('webhooks');
    expect(visibleSections(owner.has, { feature: () => true, sandbox: true }).map((s) => s.key)).not.toContain(
      'sandbox',
    );
  });

  it('hides pages and settings an HR admin may not open, and keeps read-only ones (Branding)', () => {
    const hr = viewer('hr_admin');
    const sections = visibleSections(hr.has).map((s) => s.key);
    expect(sections).toContain('branding');
    expect(hr.can('settings.branding.manage')).toBe(false);
    // webhooks need webhooks.manage, API keys and streams settings.manage: HR admins see neither
    for (const k of ['webhooks', 'api', 'streams', 'sandbox']) expect(sections, k).not.toContain(k);
    // company exports and closure are the owner's
    const tabs = visibleModules(hr).flatMap((m) => m.tabs.map((t) => t.href));
    expect(tabs).not.toContain('/app/privacy/exports');
    expect(tabs).toContain('/app/privacy');
  });

  it('a manager no longer gets compliance report tabs that would refuse them', () => {
    const tabs = visibleModules(viewer('manager')).flatMap((m) => m.tabs.map((t) => t.href));
    expect(tabs).toContain('/app/compliance');
    expect(tabs).not.toContain('/app/compliance/reports/gender-pay-gap');
  });

  it('features turned off hide their navigation', () => {
    const off = viewer('owner', { aiAssistant: false, customBranding: false });
    expect(off.can('settings.branding')).toBe(false);
    expect(viewer('owner').can('settings.branding')).toBe(true);
  });

  it('IT admins get IT, inbox and the SCIM settings, and none of pay, people records or compliance', () => {
    const it = viewer('it_admin');
    const modules = visibleModules(it).map((m) => m.key);
    expect(modules).toEqual(expect.arrayContaining(['home', 'me', 'inbox', 'people', 'it', 'settings', 'help']));
    for (const k of ['compliance', 'privacy', 'reports', 'billing']) expect(modules, k).not.toContain(k);
    const tabs = visibleModules(it).flatMap((m) => m.tabs.map((t) => t.href));
    expect(tabs).toEqual(expect.arrayContaining(['/app/assets', '/app/integrations', '/app/people']));
    expect(tabs).not.toContain('/app/payroll');
    expect(visibleSections(it.has).map((s) => s.key)).toEqual(['scim']);
  });
});
