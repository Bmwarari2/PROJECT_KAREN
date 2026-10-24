import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROFILE_TABS, TARGET_TYPES } from '@thapsus/core/links';
import {
  FORM_KINDS,
  OPEN_LINK_LABELS,
  resolveTaskAction,
  TASK_ACTION_KINDS,
  taskActionContractHref,
  taskActionKind,
  type TaskAction,
} from '@thapsus/core/task-actions';

/**
 * A task's main button never leads to a missing page (ADR-0191): for every kind, the page it opens today —
 * its own page once its part has landed, otherwise its fallback — matches a route of this app. When a part
 * sets `landed: true` on its kind, this test fails until its page exists.
 */
const APP = join(__dirname, '..', 'app');
const ID = '7d6f1c2a-3b4e-4c5d-8e9f-0a1b2c3d4e5f';
const ctx = { taskId: ID, subjectEmployeeId: ID };

/** Whether a path (without query or hash) is a page of the app: static segments, `[param]` and `(group)` folders. */
function isRoute(path: string): boolean {
  const segments = path.split('/').filter(Boolean);
  const walk = (dir: string, rest: string[]): boolean => {
    if (!rest.length) {
      if (existsSync(join(dir, 'page.tsx'))) return true;
      return readdirSync(dir, { withFileTypes: true }).some(
        (e) => e.isDirectory() && /^\(.+\)$/.test(e.name) && walk(join(dir, e.name), rest),
      );
    }
    const [head, ...tail] = rest;
    return readdirSync(dir, { withFileTypes: true }).some((e) => {
      if (!e.isDirectory()) return false;
      if (/^\(.+\)$/.test(e.name)) return walk(join(dir, e.name), rest);
      if (e.name === head || /^\[[^.\]]+\]$/.test(e.name)) return walk(join(dir, e.name), tail);
      return false;
    });
  };
  return walk(APP, segments);
}

const SAMPLES: TaskAction[] = [
  ...OPEN_LINK_LABELS.map((label) => ({
    kind: 'open_link' as const,
    params: { href: '/app/payroll', label },
  })),
  ...PROFILE_TABS.map((tab) => ({ kind: 'open_person' as const, params: { tab } })),
  ...TARGET_TYPES.map((type) => ({ kind: 'open_record' as const, params: { type, id: ID } })),
  { kind: 'send_document', params: { templateId: ID } },
  { kind: 'rtw_check', params: {} },
  { kind: 'i9_section1', params: {} },
  { kind: 'i9_section2', params: {} },
  { kind: 'i9_reverify', params: {} },
  { kind: 'compliance_renewal', params: { requirementId: ID } },
  { kind: 'payroll_starter', params: {} },
  { kind: 'payroll_leaver', params: {} },
  ...FORM_KINDS.map((formKind) => ({ kind: 'form' as const, params: { formKind } })),
  { kind: 'it_request', params: {} },
  { kind: 'access_removal', params: {} },
];

describe('task buttons open pages that exist', () => {
  it('finds the routes of the app (and refuses ones that do not exist)', () => {
    expect(isRoute('/app/tasks')).toBe(true);
    expect(isRoute(`/app/people/${ID}`)).toBe(true);
    expect(isRoute('/app')).toBe(true);
    expect(isRoute('/app/no-such-page')).toBe(false);
  });

  it('every kind’s button, or its fallback until the kind lands, opens a route of the app', () => {
    expect(new Set(SAMPLES.map((a) => a.kind))).toEqual(new Set(TASK_ACTION_KINDS));
    for (const a of SAMPLES) {
      const r = resolveTaskAction(a, ctx)!;
      const path = r.href.split(/[?#]/)[0]!;
      expect(isRoute(path), `${a.kind} opens ${r.href}`).toBe(true);
      // a landed kind opens its own contract page
      if (taskActionKind(a.kind).landed) expect(r.href).toBe(taskActionContractHref(a, ctx));
    }
  });
});
