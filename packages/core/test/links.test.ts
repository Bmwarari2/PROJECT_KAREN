import { describe, expect, it } from 'vitest';
import {
  legacyTarget,
  notificationFallbackHref,
  notificationHref,
  personHref,
  safeAppLink,
  TARGET_TYPES,
  targetHref,
} from '../src/links';

const ID = '7d6f1c2a-3b4e-4c5d-8e9f-0a1b2c3d4e5f';

describe('deep links (ADR-0160)', () => {
  it('maps every target type to a page of the app that carries the id where the page has one', () => {
    for (const type of TARGET_TYPES) {
      const href = targetHref({ type, id: ID });
      expect(href, type).toMatch(/^\/app\//);
    }
    expect(targetHref({ type: 'approval_request', id: ID })).toBe(`/app/approvals/${ID}`);
    expect(targetHref({ type: 'task', id: ID })).toBe(`/app/tasks/${ID}`);
    expect(targetHref({ type: 'leave_request', id: ID })).toBe(`/app/time-off/${ID}`);
    expect(targetHref({ type: 'rtw_check', id: ID })).toBe(`/app/compliance/right-to-work/${ID}`);
    expect(targetHref({ type: 'document', id: ID })).toBe(`/app/documents/${ID}`);
    expect(targetHref({ type: 'asset_assignment', id: ID })).toBe(`/app/assets?ack=${ID}`);
  });

  it('refuses unknown types and ids that are not UUIDs', () => {
    expect(targetHref({ type: 'nope', id: ID })).toBeNull();
    expect(targetHref({ type: 'task', id: '../../etc' })).toBeNull();
    expect(targetHref(null)).toBeNull();
  });

  it('opens a profile on a tab, and the overview without a query', () => {
    expect(personHref(ID)).toBe(`/app/people/${ID}`);
    expect(personHref(ID, 'overview')).toBe(`/app/people/${ID}`);
    expect(personHref(ID, 'compliance')).toBe(`/app/people/${ID}?tab=compliance`);
  });

  it('keeps only relative links inside the app', () => {
    expect(safeAppLink('/app/tasks')).toBe('/app/tasks');
    expect(safeAppLink('/app')).toBe('/app');
    expect(safeAppLink('/application')).toBeNull();
    expect(safeAppLink('//evil.example/app')).toBeNull();
    expect(safeAppLink('https://evil.example/app')).toBeNull();
    expect(safeAppLink(null)).toBeNull();
  });

  it('opens a notification at its target, a refining link, a legacy key, its link or its list', () => {
    expect(
      notificationHref({ kind: 'task.assigned', targetType: 'task', targetId: ID, link: '/app/tasks' }),
    ).toBe(`/app/tasks/${ID}`);
    // a stored link that refines the target page wins (open the document at its signature request)
    expect(
      notificationHref({
        kind: 'document.signature_requested',
        targetType: 'document',
        targetId: ID,
        link: `/app/documents/${ID}?sign=abc`,
      }),
    ).toBe(`/app/documents/${ID}?sign=abc`);
    // older notifications: the dedupe key names the request or the task
    expect(
      notificationHref({ kind: 'approval.requested', link: '/app/approvals', dedupeKey: `appr:${ID}:0` }),
    ).toBe(`/app/approvals/${ID}`);
    expect(notificationHref({ kind: 'task.overdue', link: '/app/tasks', dedupeKey: `overdue:${ID}` })).toBe(
      `/app/tasks/${ID}`,
    );
    expect(notificationHref({ kind: 'report.ready', link: `/app/reports/runs/${ID}` })).toBe(
      `/app/reports/runs/${ID}`,
    );
    expect(notificationHref({ kind: 'compliance.rtw_missing', link: null })).toBe(
      '/app/compliance/right-to-work',
    );
    expect(notificationHref({ kind: 'something.else', link: 'https://evil.example' })).toBe(
      '/app/notifications',
    );
  });

  it('only reads ids from the dedupe keys of kinds that carry one', () => {
    expect(legacyTarget('approval.decided', `appr-done:${ID}`)).toEqual({ type: 'approval_request', id: ID });
    expect(legacyTarget('approval.escalated', `esc:${ID}`)).toBeNull();
    expect(legacyTarget('task.due', 'due:not-a-uuid')).toBeNull();
  });

  it('gives every kind a list page', () => {
    expect(notificationFallbackHref('leave.approved')).toBe('/app/time-off');
    expect(notificationFallbackHref('time.timesheet_approved')).toBe('/app/timesheets');
    expect(notificationFallbackHref('rota.published')).toBe('/app/rota');
    expect(notificationFallbackHref('compliance.i9_section2')).toBe('/app/compliance/i9');
    expect(notificationFallbackHref('privacy.dsr')).toBe('/app/privacy');
    expect(notificationFallbackHref('automation')).toBe('/app/notifications');
  });
});
