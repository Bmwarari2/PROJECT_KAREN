import { daysBetween } from '@thapsus/core/time';
import type { Tx } from '@thapsus/db';
import { complianceSettings } from '../compliance/service';

/** `expired`, `expiring` (within the reminder window from the settings) or null. */
export function expiryStatus(expiresOn: string | null | undefined, today: string, windowDays: number) {
  if (!expiresOn) return null;
  const left = daysBetween(today, expiresOn);
  return left < 0 ? 'expired' : left <= windowDays ? 'expiring' : null;
}

export async function expiryWindows(tx: Tx) {
  const s = await complianceSettings(tx);
  return {
    rtw: Math.max(0, ...s.rtwReminderDays),
    other: Math.max(0, ...s.documentReminderDays),
  };
}
