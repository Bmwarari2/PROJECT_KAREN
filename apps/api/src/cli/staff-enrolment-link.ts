import { getPool } from '@thapsus/db';
import { depsFromEnv } from '../deps';
import { issueStaffEnrolment, STAFF_ENROLMENT_HOURS } from '../modules/backoffice/auth';

/**
 * Issues a new one-time enrolment link for an existing staff member (another key, or a replacement).
 * `--reset-keys` first removes every key they registered and ends their sessions (a lost or stolen key).
 * Operator-only: it needs the back-office database credentials (docs/runbooks/staff-access.md).
 */
const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith('--'));
const resetKeys = args.includes('--reset-keys');
if (!email) {
  console.error('usage: staff-enrolment-link <email> [--reset-keys]');
  process.exit(2);
}
const deps = await depsFromEnv();
const { rows } = await getPool(deps.backofficeDbUrl!).query<{ id: string; active: boolean }>(
  'SELECT id, active FROM backoffice.staff_users WHERE email = $1',
  [email],
);
const staff = rows[0];
if (!staff || !staff.active) {
  console.error(`no active staff account for ${email}`);
  process.exit(1);
}
const link = await issueStaffEnrolment({ deps }, staff.id, { resetKeys });
console.log(
  `${resetKeys ? 'keys removed and sessions ended; ' : ''}enrolment link (one use, valid ${STAFF_ENROLMENT_HOURS} hours): ${link.url}`,
);
process.exit(0);
