import { addDays, addYears, compareDates, dayOfWeek, daysBetween, maxDate, minDate } from '@thapsus/core/time';
import { multiplyRatio, money } from '@thapsus/core/money';
import { computeBalance, entitlementForYear, type BalanceInput, type WorkPattern } from '../../leave/engine';
import { e4, formatScaled, roundDiv } from '../fixed';

/**
 * Holiday liability (pure): the value of leave earned but not yet taken on `asOf`, at contractual basic pay.
 * Never floating point: amounts are integer ten-thousandths of a day (or hour) and integer minor units.
 *
 *   accrued to date   annual_upfront: entitlement × (days of the leave year employed up to asOf) /
 *                                     (days of the leave year employed);  monthly / per-hour: as the leave
 *                                     engine accrues them
 *   untaken           accrued + carried over (capped, minus expired) + adjustments
 *                     − public holidays already taken (policies whose entitlement includes them) − leave taken
 *   annualised pay    annual × 1 · monthly × 12 · weekly × 52 · daily × 52 × working days per week
 *                     · hourly × weekly hours × 52
 *   liability         annualised pay × untaken / (52 × working days per week)       (unit = days)
 *                     annualised pay × untaken / (52 × weekly hours)                 (unit = hours)
 *
 * The liability is rounded ONCE, half away from zero, to the currency's minor unit (multiplyRatio).
 * Over-taken leave gives a negative liability (an amount the employer could recover). See ADR-0073.
 */
export interface LiabilityInput extends Omit<BalanceInput, 'year'> {
  /** Leave year start (YYYY-MM-DD) containing asOf. */
  yearStart: string;
  pay: { amountMinor: string; currency: string; frequency: 'annual' | 'monthly' | 'weekly' | 'daily' | 'hourly' } | null;
}

export interface LiabilityResult {
  unit: 'days' | 'hours';
  accruedE4: bigint;
  takenE4: bigint;
  untakenE4: bigint;
  /** 2 dp strings for display */
  accrued: string;
  taken: string;
  untaken: string;
  liabilityMinor: bigint | null;
  currency: string | null;
}

const workingDays = (p: WorkPattern) => Object.values(p).filter((h) => h > 0).length;
const weeklyHoursE2 = (p: WorkPattern) => Object.values(p).reduce((s, h) => s + BigInt(Math.round(h * 100)), 0n);

export function computeLiability(i: LiabilityInput): LiabilityResult {
  const p = i.policy;
  const ys = i.yearStart;
  const ye = addYears(ys, 1);
  const year = Number(ys.slice(0, 4));
  const b = computeBalance({ ...i, year });

  // accrued to date
  let accruedE4: bigint;
  if (p.accrual.method === 'annual_upfront') {
    const entE4 = e4(entitlementForYear(p, i.employee, year));
    let from = maxDate(ys, i.employee.startDate);
    if (p.effectiveFrom) from = maxDate(from, p.effectiveFrom);
    let to = ye;
    if (i.employee.endDate) to = minDate(to, addDays(i.employee.endDate, 1));
    if (p.effectiveTo) to = minDate(to, p.effectiveTo);
    const covered = Math.max(0, daysBetween(from, to));
    const elapsed = Math.max(0, Math.min(covered, daysBetween(from, minDate(addDays(i.asOf, 1), to))));
    accruedE4 = covered ? roundDiv(entE4 * BigInt(elapsed), BigInt(covered)) : 0n;
  } else {
    accruedE4 = e4(b.accrued);
  }
  const carriedE4 = e4(Math.min(i.carriedIn, p.carryOver?.maxDays ?? 0)) - e4(b.carryOverExpired);
  const adjustmentsE4 = e4(b.adjustments);

  // public holidays already taken (entitlements that include them)
  let phE4 = 0n;
  if (p.includesPublicHolidays) {
    for (const d of i.holidays) {
      if (compareDates(d, maxDate(ys, i.employee.startDate)) < 0 || compareDates(d, i.asOf) > 0 || compareDates(d, ye) >= 0) continue;
      const h = i.pattern[dayOfWeek(d) as 1];
      if (h > 0) phE4 += p.unit === 'hours' ? BigInt(Math.round(h * 100)) * 100n : 10_000n;
    }
  }
  const takenE4 = e4(b.taken) + phE4;
  const untakenE4 = accruedE4 + carriedE4 + adjustmentsE4 - takenE4;

  let liabilityMinor: bigint | null = null;
  const days = BigInt(workingDays(i.pattern));
  const whE2 = weeklyHoursE2(i.pattern);
  if (i.pay && days > 0n && whE2 > 0n) {
    // annualised pay as a fraction annNum / annDen of the pay amount
    let annNum: bigint;
    let annDen = 1n;
    switch (i.pay.frequency) {
      case 'annual':
        annNum = 1n;
        break;
      case 'monthly':
        annNum = 12n;
        break;
      case 'weekly':
        annNum = 52n;
        break;
      case 'daily':
        annNum = 52n * days;
        break;
      case 'hourly':
        annNum = whE2 * 52n;
        annDen = 100n;
        break;
    }
    // per unit: days → 52 × working days per week; hours → 52 × weekly hours (whE2 / 100)
    const unitNum = p.unit === 'hours' ? 52n * whE2 : 52n * days * 100n;
    const num = annNum * untakenE4 * 100n;
    const den = annDen * unitNum * 10_000n;
    liabilityMinor = multiplyRatio(money(BigInt(i.pay.amountMinor), i.pay.currency), num, den).amountMinor;
  }
  return {
    unit: p.unit,
    accruedE4: accruedE4 + carriedE4 + adjustmentsE4,
    takenE4,
    untakenE4,
    accrued: formatScaled(accruedE4 + carriedE4 + adjustmentsE4, 4, 2),
    taken: formatScaled(takenE4, 4, 2),
    untaken: formatScaled(untakenE4, 4, 2),
    liabilityMinor,
    currency: i.pay?.currency ?? null,
  };
}
