import type { HomeRegion } from '../regions';
import { addDays, addMinutes, compareInstants, dayOfWeek, instantToDate, minutesBetween, startOfDayInstant, zonedToInstant, type Instant } from '../time';
import { planById, type BillingConfig, type Priority, type SupportHours } from './config';

/**
 * Support SLA timers (ADR-0102). Targets per plan and priority come from the billing config. Clocks
 * run in support hours (the region's support time zone, weekdays and opening hours) for
 * 'business_hours' plans, or around the clock for 'always' plans. All instants are UTC ISO strings.
 */

/** Adds `minutes` of support time to `start`, skipping closed hours (DST-safe via the zone rules). */
export function addSupportMinutes(start: Instant, minutes: number, hours: SupportHours | null): Instant {
  if (!Number.isSafeInteger(minutes) || minutes < 0) throw new RangeError('minutes must be a non-negative integer');
  if (!hours) return addMinutes(start, minutes);
  let cursor = start;
  let remaining = minutes;
  for (let guard = 0; guard < 3700; guard++) {
    const date = instantToDate(cursor, hours.timeZone);
    if (hours.days.includes(dayOfWeek(date))) {
      const open = zonedToInstant(date, hours.start, hours.timeZone);
      const close = zonedToInstant(date, hours.end, hours.timeZone);
      const from = compareInstants(cursor, open) < 0 ? open : cursor;
      if (compareInstants(from, close) < 0) {
        const available = minutesBetween(from, close);
        if (remaining <= available) return addMinutes(from, remaining);
        remaining -= available;
      }
    }
    cursor = startOfDayInstant(addDays(date, 1), hours.timeZone);
  }
  throw new Error('support hours never open');
}

export interface SlaDeadlines {
  firstResponseDueAt: Instant;
  firstResponseAtRiskAt: Instant;
  resolutionDueAt: Instant;
  resolutionAtRiskAt: Instant;
}

export function supportHoursFor(cfg: BillingConfig, planId: string, region: HomeRegion): SupportHours | null {
  const plan = planById(cfg, planId) ?? planById(cfg, cfg.trial.planId)!;
  return plan.support.coverage === 'always' ? null : cfg.support.hours[region];
}

/** Deadlines for a ticket opened at `openedAt` on a plan and priority, in a region. */
export function slaDeadlines(cfg: BillingConfig, planId: string, priority: Priority, region: HomeRegion, openedAt: Instant): SlaDeadlines {
  const plan = planById(cfg, planId) ?? planById(cfg, cfg.trial.planId)!;
  const target = plan.support.sla[priority];
  const hours = supportHoursFor(cfg, plan.id, region);
  const pct = cfg.support.atRiskPercent;
  const atRisk = (m: number) => Math.floor((m * pct) / 100);
  return {
    firstResponseDueAt: addSupportMinutes(openedAt, target.firstResponseMinutes, hours),
    firstResponseAtRiskAt: addSupportMinutes(openedAt, atRisk(target.firstResponseMinutes), hours),
    resolutionDueAt: addSupportMinutes(openedAt, target.resolutionMinutes, hours),
    resolutionAtRiskAt: addSupportMinutes(openedAt, atRisk(target.resolutionMinutes), hours),
  };
}

export type SlaState = 'on_track' | 'at_risk' | 'breached' | 'met' | 'met_late';

/** State of one timer at `now`: met (on time or late) once `metAt` is set, otherwise by deadline. */
export function slaState(t: { dueAt: Instant; atRiskAt: Instant; metAt: Instant | null }, now: Instant): SlaState {
  if (t.metAt) return compareInstants(t.metAt, t.dueAt) <= 0 ? 'met' : 'met_late';
  if (compareInstants(now, t.dueAt) > 0) return 'breached';
  if (compareInstants(now, t.atRiskAt) >= 0) return 'at_risk';
  return 'on_track';
}

/** The more urgent of the two timer states (for flags and the queue). */
export function worstSla(a: SlaState, b: SlaState): SlaState {
  const order: SlaState[] = ['breached', 'at_risk', 'on_track', 'met_late', 'met'];
  return order.indexOf(a) <= order.indexOf(b) ? a : b;
}
