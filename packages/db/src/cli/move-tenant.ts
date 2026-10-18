import { moveTenant } from '../move-tenant';

/**
 * Usage: pnpm --filter @thapsus/db move-tenant -- <tenantId> <targetKey> [--purge-source]
 * Owner URLs come from OWNER_DATABASES (JSON map of db key → migrator URL), from Secrets Manager in AWS.
 */
const [tenantId, targetKey] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!tenantId || !targetKey) {
  console.error('usage: move-tenant <tenantId> <targetKey> [--purge-source]');
  process.exit(2);
}
const ownerUrls = JSON.parse(process.env.OWNER_DATABASES ?? '{}') as Record<string, string>;
const report = await moveTenant({
  tenantId,
  targetKey,
  ownerUrls,
  purgeSource: process.argv.includes('--purge-source'),
  settleMs: Number(process.env.ROUTER_CACHE_TTL_MS ?? 15_000) + 5_000,
  log: (m) => console.log(m),
});
console.log(JSON.stringify(report, null, 2));
