import { moveTenant } from '../move-tenant';
import { ownerUrlsFromEnv, processMoveRequests } from '../move-requests';

/**
 * Usage:
 *   pnpm --filter @thapsus/db move-tenant -- <tenantId> <targetKey> [--purge-source]
 *   pnpm --filter @thapsus/db move-tenant -- --process-requests
 * The second form runs the move requests staff created in the back office (status-tracked in
 * backoffice.tenant_moves). Owner URLs come from OWNER_DATABASES (JSON map of db key → migrator URL) or,
 * in AWS, from the owner secrets of a dedicated database's tools task (ownerUrlsFromEnv). In the api image
 * it is bundled as dist/move-tenant.mjs.
 */
const ownerUrls = ownerUrlsFromEnv();
const settleMs = Number(process.env.ROUTER_CACHE_TTL_MS ?? 15_000) + 5_000;

if (process.argv.includes('--process-requests')) {
  const outcomes = await processMoveRequests({ ownerUrls, settleMs, log: (m) => console.log(m) });
  console.log(JSON.stringify(outcomes.map(({ report: _r, ...o }) => o), null, 2));
  process.exit(outcomes.some((o) => o.status === 'failed') ? 1 : 0);
}

const [tenantId, targetKey] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!tenantId || !targetKey) {
  console.error('usage: move-tenant <tenantId> <targetKey> [--purge-source] | move-tenant --process-requests');
  process.exit(2);
}
const report = await moveTenant({
  tenantId,
  targetKey,
  ownerUrls,
  purgeSource: process.argv.includes('--purge-source'),
  settleMs,
  log: (m) => console.log(m),
});
console.log(JSON.stringify(report, null, 2));
