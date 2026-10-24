import { closeAllPools, secretToUrl } from '@thapsus/db';
import type { Deps } from '../deps';
import { addSecretVersion, parseInvitee, staffInvite } from './staging/staff-invite';

/**
 * Cloud Run job `thapsus-stg-<cell>-staff-invite` (infra/gcp/staging/run.tf, ADR-0174). Reads the invitee
 * from STAFF_INVITEE (a Secret Manager value from the GCP_STAFF_OWNER_* repository variables), the
 * back-office database from BACKOFFICE_DATABASE_SECRET, and writes the enrolment link to STAFF_INVITE_SECRET.
 * Logs only the outcome and the staff id.
 */
const env = process.env;
// Only what the invite needs (the passkey is bound to the back office's address); no other secrets.
const config = {
  env: (env.APP_ENV ?? 'dev') as Deps['config']['env'],
  cell: (env.CELL_REGION ?? 'uk') as Deps['config']['cell'],
  appBaseUrl: env.APP_BASE_URL ?? 'http://localhost:3000',
  backofficeBaseUrl: env.BACKOFFICE_BASE_URL || undefined,
} as Deps['config'];
const backofficeDbUrl =
  env.BACKOFFICE_DATABASE_URL ??
  (env.BACKOFFICE_DATABASE_SECRET
    ? secretToUrl(env.BACKOFFICE_DATABASE_SECRET, env.DATABASE_HOST)
    : undefined);
if (!backofficeDbUrl) {
  console.error('BACKOFFICE_DATABASE_SECRET (or BACKOFFICE_DATABASE_URL) is required');
  process.exit(2);
}
const secret = env.STAFF_INVITE_SECRET ?? '';
try {
  const outcome = await staffInvite({
    deps: { config, now: () => new Date(), backofficeDbUrl },
    invitee: parseInvitee(env.STAFF_INVITEE),
    mode: env.STAFF_INVITE_MODE === 'reissue' ? 'reissue' : 'first',
    write: (payload) => addSecretVersion(globalThis.fetch, secret, payload),
  });
  console.log(
    outcome.done === 'invited'
      ? `staff invite: ${outcome.created ? 'created' : 'reissued'} for staff ${outcome.staffId}; the one-time link is in Secret Manager until ${outcome.expiresAt.toISOString()}`
      : `staff invite: skipped (${outcome.reason === 'staffExists' ? 'the back office already has staff; run the workflow with staff_invite ticked to send a new link' : 'GCP_STAFF_OWNER_EMAIL is not set'})`,
  );
} catch (err) {
  console.error(`staff invite failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await closeAllPools();
}
