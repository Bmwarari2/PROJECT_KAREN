import { describe, expect, it } from 'vitest';
import {
  addSupportMinutes,
  loadBillingConfig,
  planById,
  slaDeadlines,
  slaState,
  supportHoursFor,
  worstSla,
} from '../src/billing';

const cfg = loadBillingConfig('builtin:billing-config-v1');
const uk = cfg.support.hours.uk;

describe('support-hours arithmetic', () => {
  it('counts only opening hours on support days in the region time zone', () => {
    // Friday 2027-01-15 16:30 London (UTC+0): one hour left on Friday, the rest on Monday from 09:00
    expect(addSupportMinutes('2027-01-15T16:30:00Z', 60, uk)).toBe('2027-01-15T17:30:00Z');
    expect(addSupportMinutes('2027-01-15T16:30:00Z', 90, uk)).toBe('2027-01-18T09:30:00Z');
    // opened at night: clock starts at the next opening
    expect(addSupportMinutes('2027-01-13T22:00:00Z', 30, uk)).toBe('2027-01-14T09:30:00Z');
    // opened on Saturday
    expect(addSupportMinutes('2027-01-16T11:00:00Z', 0, uk)).toBe('2027-01-18T09:00:00Z');
  });

  it('is DST-safe (London spring forward: opening hours stay at local 09:00)', () => {
    // Friday 2027-03-26 17:00 GMT; next opening Monday 2027-03-29 09:00 BST = 08:00Z
    expect(addSupportMinutes('2027-03-26T17:00:00Z', 60, uk)).toBe('2027-03-29T08:30:00Z');
  });

  it('runs around the clock for always-on plans', () => {
    expect(supportHoursFor(cfg, 'enterprise', 'us')).toBeNull();
    expect(addSupportMinutes('2027-01-16T11:00:00Z', 30, null)).toBe('2027-01-16T11:30:00Z');
    expect(supportHoursFor(cfg, 'core', 'eu')).toEqual(cfg.support.hours.eu);
  });

  it('rejects negative or fractional minutes', () => {
    expect(() => addSupportMinutes('2027-01-16T11:00:00Z', -1, uk)).toThrow();
    expect(() => addSupportMinutes('2027-01-16T11:00:00Z', 1.5, uk)).toThrow();
  });
});

describe('SLA deadlines and states per plan and priority', () => {
  it('derives first-response and resolution deadlines (and at-risk points) from the plan config', () => {
    const opened = '2027-01-13T10:00:00Z'; // Wednesday, London
    const d = slaDeadlines(cfg, 'plus', 'urgent', 'uk', opened);
    const target = planById(cfg, 'plus')!.support.sla.urgent;
    expect(d.firstResponseDueAt).toBe(addSupportMinutes(opened, target.firstResponseMinutes, uk));
    expect(d.firstResponseAtRiskAt).toBe(
      addSupportMinutes(
        opened,
        Math.floor((target.firstResponseMinutes * cfg.support.atRiskPercent) / 100),
        uk,
      ),
    );
    expect(d.resolutionDueAt).toBe(addSupportMinutes(opened, target.resolutionMinutes, uk));
    // urgent beats low; enterprise beats core
    const low = slaDeadlines(cfg, 'plus', 'low', 'uk', opened);
    expect(low.firstResponseDueAt > d.firstResponseDueAt).toBe(true);
    const ent = slaDeadlines(cfg, 'enterprise', 'urgent', 'us', opened);
    expect(ent.firstResponseDueAt).toBe(
      addSupportMinutes(opened, planById(cfg, 'enterprise')!.support.sla.urgent.firstResponseMinutes, null),
    );
    // unknown plan ids fall back to the trial plan's targets
    expect(slaDeadlines(cfg, 'retired-plan', 'urgent', 'uk', opened)).toEqual(
      slaDeadlines(cfg, cfg.trial.planId, 'urgent', 'uk', opened),
    );
  });

  it('flags on track → at risk → breached, and met on time or late', () => {
    const t = { dueAt: '2027-01-13T11:00:00Z', atRiskAt: '2027-01-13T10:45:00Z', metAt: null };
    expect(slaState(t, '2027-01-13T10:30:00Z')).toBe('on_track');
    expect(slaState(t, '2027-01-13T10:45:00Z')).toBe('at_risk');
    expect(slaState(t, '2027-01-13T11:00:00Z')).toBe('at_risk');
    expect(slaState(t, '2027-01-13T11:00:01Z')).toBe('breached');
    expect(slaState({ ...t, metAt: '2027-01-13T10:59:00Z' }, '2027-01-14T00:00:00Z')).toBe('met');
    expect(slaState({ ...t, metAt: '2027-01-13T11:30:00Z' }, '2027-01-14T00:00:00Z')).toBe('met_late');
    expect(worstSla('at_risk', 'breached')).toBe('breached');
    expect(worstSla('met', 'on_track')).toBe('on_track');
  });
});
