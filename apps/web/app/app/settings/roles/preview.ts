import {
  ACTIONS,
  MODULES,
  viewerFromSession,
  visibleActions,
  visibleModules,
  type ModuleTab,
  type QuickAction,
  type VisibleModule,
  type WorkspaceModule,
} from '../../workspace';
import { SETTINGS_SECTIONS, visibleSections, type SettingsSection } from '../sections';

/**
 * "Preview as role" (ADR-0154): what a person holding only these permissions would be shown in the
 * app, computed with the same workspace map and settings sections the shell uses. It is an
 * illustration in the viewer's browser: it never changes the viewer's own session, and the API still
 * checks every permission and limits it to the scope the role is assigned at.
 */
export interface RolePreview {
  modules: VisibleModule[];
  /** Modules with no tab this role may open. */
  hiddenModules: WorkspaceModule[];
  /** Tabs of shown modules that this role does not get. */
  hiddenTabs: Array<{ module: WorkspaceModule; tabs: ModuleTab[] }>;
  actions: QuickAction[];
  hiddenActions: QuickAction[];
  sections: SettingsSection[];
  hiddenSections: SettingsSection[];
}

export function rolePreview(
  permissions: string[],
  opts: { employee: boolean; askHr?: boolean } = { employee: true },
): RolePreview {
  const viewer = viewerFromSession(
    { permissions, employeeId: opts.employee ? 'preview' : null },
    opts.askHr ?? false,
  );
  const modules = visibleModules(viewer);
  const shown = new Map(modules.map((m) => [m.key, m]));
  const actions = visibleActions(viewer);
  const sections = visibleSections(viewer.has);
  return {
    modules,
    hiddenModules: MODULES.filter((m) => !shown.has(m.key)),
    hiddenTabs: MODULES.flatMap((m) => {
      const v = shown.get(m.key);
      const tabs = v ? m.tabs.filter((tab) => !v.tabs.some((x) => x.href === tab.href)) : [];
      return tabs.length ? [{ module: m, tabs }] : [];
    }),
    actions,
    hiddenActions: ACTIONS.filter((a) => !actions.includes(a)),
    sections,
    hiddenSections: SETTINGS_SECTIONS.filter((s) => !sections.includes(s)),
  };
}
