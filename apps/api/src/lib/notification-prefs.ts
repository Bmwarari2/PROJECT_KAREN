/**
 * Notification preferences (employee self-service). In-app notifications are always recorded; a user can turn
 * email and web push off overall or per category. The category of a notification is the prefix of its kind
 * ("leave.approved" → "leave"). Sign-in and security notices are not routed through here and always send.
 */
export const NOTIFICATION_CATEGORIES = [
  'approval',
  'leave',
  'absence',
  'rota',
  'time',
  'task',
  'document',
  'payslip',
  'compliance',
  'asset',
  'report',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];
export type Channel = 'email' | 'push';

export interface NotificationPrefs {
  email?: boolean;
  push?: boolean;
  categories?: Partial<Record<string, { email?: boolean; push?: boolean }>>;
}

export const categoryOf = (kind: string) => kind.split('.')[0] ?? kind;

/** Whether a notification of `kind` goes out on `channel` (missing preferences mean "on"). */
export function channelEnabled(
  prefs: NotificationPrefs | null | undefined,
  kind: string,
  channel: Channel,
): boolean {
  if (!prefs) return true;
  if (prefs[channel] === false) return false;
  return prefs.categories?.[categoryOf(kind)]?.[channel] !== false;
}

/** Normalised preferences for the API: every channel and category spelled out. */
export function expandPrefs(prefs: NotificationPrefs | null | undefined) {
  return {
    email: prefs?.email !== false,
    push: prefs?.push !== false,
    categories: Object.fromEntries(
      NOTIFICATION_CATEGORIES.map((c) => [
        c,
        { email: prefs?.categories?.[c]?.email !== false, push: prefs?.categories?.[c]?.push !== false },
      ]),
    ) as Record<NotificationCategory, { email: boolean; push: boolean }>,
  };
}
