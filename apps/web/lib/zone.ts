/**
 * The viewer's IANA zone (account setting, else the device). Its own module, without the time library,
 * so a page that only needs the zone does not load it (ADR-0186).
 */
export function viewerZone(sessionZone: string | null | undefined): string {
  return sessionZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
