/**
 * Public event catalogue for webhooks. Only these outbox topics are delivered to customer endpoints;
 * internal topics never leave the cell. Payloads carry identifiers and changed field names only
 * (exactly what the outbox event holds), never field values. Phases that add outbox topics add the
 * public ones here (and to docs/api.md#events).
 */
export const WEBHOOK_EVENT_TYPES = [
  'employee.created',
  'employee.changed',
  'employee.transferred',
  'employee.terminated',
  'integration.requested',
  'webhook.ping',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** Subscription patterns: an exact event type, a family wildcard ("employee.*") or everything ("*"). */
export function isValidSubscription(pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return WEBHOOK_EVENT_TYPES.some((t) => t.startsWith(pattern.slice(0, -1)));
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(pattern);
}

export function subscriptionMatches(patterns: readonly string[], topic: string): boolean {
  if (!(WEBHOOK_EVENT_TYPES as readonly string[]).includes(topic)) return false;
  // ping events are only sent to the endpoint that asked for them (handled by the subscriber)
  if (topic === 'webhook.ping') return true;
  return patterns.some(
    (p) => p === '*' || p === topic || (p.endsWith('.*') && topic.startsWith(p.slice(0, -1))),
  );
}
