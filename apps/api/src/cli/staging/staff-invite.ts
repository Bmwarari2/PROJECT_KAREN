import type { Deps } from '../../deps';
import {
  backofficePool,
  createStaff,
  issueStaffEnrolment,
  STAFF_ROLES,
  type StaffRole,
} from '../../modules/backoffice/auth';

/**
 * Invites the first Thapsus staff member (the product owner) to the back office of a Google Cloud staging
 * cell (ADR-0174). It runs as the Cloud Run job `thapsus-stg-<cell>-staff-invite` after the seed, and
 * writes the one-time passkey enrolment link to the Secret Manager secret of the same name. The link,
 * the email and the name are never written to a log.
 *
 * - `first` (the deploy's automatic run): does nothing once the back office has any staff account.
 * - `reissue` (the workflow's manual `staff_invite` input): a new link for the configured person; the
 *   keys they already registered stay (an operator removes lost keys with `staff-enrolment-link --reset-keys`).
 */
export interface Invitee {
  email: string;
  name: string;
  role: StaffRole;
}

export function parseInvitee(raw: string | undefined): Invitee | undefined {
  if (!raw) return undefined;
  const v = JSON.parse(raw) as Partial<Invitee>;
  const email = String(v.email ?? '').trim();
  if (!email) return undefined;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
    throw new Error('STAFF_INVITEE email is not an email address');
  const name = String(v.name ?? '').trim();
  if (!name || name.length > 120) throw new Error('STAFF_INVITEE name must be 1 to 120 characters');
  const role = (v.role ?? 'super_admin') as StaffRole;
  if (!STAFF_ROLES.includes(role)) throw new Error('STAFF_INVITEE role is not a staff role');
  return { email, name, role };
}

/** Writes a new version of a Secret Manager secret with the job's own identity (metadata server token). */
export async function addSecretVersion(fetchImpl: typeof fetch, name: string, data: string) {
  if (!/^projects\/[a-z0-9-]+\/secrets\/[A-Za-z0-9_-]+$/.test(name))
    throw new Error('STAFF_INVITE_SECRET must be projects/<project>/secrets/<id>');
  const token = await fetchImpl(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } },
  );
  if (!token.ok) throw new Error(`metadata server answered ${token.status}`);
  const { access_token } = (await token.json()) as { access_token: string };
  const res = await fetchImpl(`https://secretmanager.googleapis.com/v1/${name}:addVersion`, {
    method: 'POST',
    headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ payload: { data: Buffer.from(data, 'utf8').toString('base64') } }),
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`Secret Manager answered ${res.status}`);
}

export type InviteOutcome =
  | { done: 'skipped'; reason: 'notConfigured' | 'staffExists' }
  | { done: 'invited'; staffId: string; created: boolean; expiresAt: Date };

export async function staffInvite(opts: {
  deps: Pick<Deps, 'config' | 'now' | 'backofficeDbUrl'>;
  invitee: Invitee | undefined;
  mode: 'first' | 'reissue';
  write: (payload: string) => Promise<void>;
}): Promise<InviteOutcome> {
  if (opts.deps.config.env === 'prod') throw new Error('The staff invite job runs on staging only');
  if (!opts.invitee) return { done: 'skipped', reason: 'notConfigured' };
  const app = { deps: opts.deps as Deps };
  const pool = backofficePool(app);
  if (opts.mode === 'first') {
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM backoffice.staff_users WHERE active',
    );
    if (rows[0]!.n > 0) return { done: 'skipped', reason: 'staffExists' };
  }
  const existing = (
    await pool.query<{ id: string; active: boolean }>(
      'SELECT id, active FROM backoffice.staff_users WHERE email = $1',
      [opts.invitee.email],
    )
  ).rows[0];
  if (existing && !existing.active) throw new Error('That staff account is deactivated');
  const link = existing
    ? { id: existing.id, ...(await issueStaffEnrolment(app, existing.id)) }
    : await createStaff(app, opts.invitee.email, opts.invitee.name, opts.invitee.role).then((s) => ({
        id: s.id,
        url: s.enrolmentUrl,
        expiresAt: s.expiresAt,
      }));
  await opts.write(
    JSON.stringify({
      enrolmentUrl: link.url,
      expiresAt: link.expiresAt.toISOString(),
      role: opts.invitee.role,
      note: 'Open this link on the device whose passkey (Face ID, Touch ID or a security key) you will sign in with. It works once.',
    }),
  );
  return { done: 'invited', staffId: link.id, created: !existing, expiresAt: link.expiresAt };
}
