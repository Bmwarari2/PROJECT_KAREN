import type { FastifyInstance } from 'fastify';
import { enqueueJob } from '@thapsus/db';
import { periodic, registerJob } from '../../jobs/registry';
import { apiClientRoutes } from './api-clients';
import { auditStreamRoutes } from './audit-streams';
import { platformBackofficeRoutes } from './backoffice';
import { oauthRoutes } from './oauth';
import { sandboxRoutes } from './sandbox';
import { tenantSettingsRoutes } from './tenant-settings';
import { webhookRoutes } from './webhooks';

export { platformHttpPlugin } from './http';

/** Phase 9 — enterprise platform (brief §6.10): public API, webhooks, SIEM streaming, sandboxes, flags, branding. */
export async function platformRoutes(app: FastifyInstance) {
  await app.register(oauthRoutes);
  await app.register(apiClientRoutes);
  await app.register(webhookRoutes);
  await app.register(auditStreamRoutes);
  await app.register(sandboxRoutes);
  await app.register(tenantSettingsRoutes);
  await app.register(platformBackofficeRoutes);
}

// Expiry job: idempotency keys (replay window) and OAuth access tokens past their lifetime. Enqueued
// once per tenant per hour by the scheduler sweep; idempotent by its hourly key.
registerJob('platform.purge_expired', async (ctx) => {
  const now = ctx.deps.now();
  return ctx.tx(async (tx) => ({
    idempotencyKeys: await tx.exec('DELETE FROM app.idempotency_keys WHERE expires_at <= $1', [now]),
    accessTokens: await tx.exec('DELETE FROM app.oauth_access_tokens WHERE expires_at <= $1', [now]),
  }));
});
periodic.push(async (tx, now) => {
  await enqueueJob(tx, 'platform.purge_expired', now.toISOString().slice(0, 13), {});
});
