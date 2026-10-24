import { hasFromGrants } from '@thapsus/core/capabilities';
import { helpReader, type HelpReader } from '@thapsus/core/help';
import type { SessionInfo } from '@/lib/api';

/**
 * The help centre's own reader for when the API does not answer in time (ADR-0190). The API's reader knows
 * the workspace's feature flags and the countries of its legal entities; this one does not, so it is
 * stricter: features flagged off by default stay hidden and country-specific articles are not shown.
 * Without a session only the general articles (signing in, accounts) are shown.
 */
export function fallbackReader(session: SessionInfo | null): HelpReader {
  if (!session) return { can: () => false, capability: () => false, countries: [] };
  return helpReader(
    { has: hasFromGrants(session.permissions), employeeId: session.employeeId, features: {}, askHr: false },
    [],
  );
}
