import { depsFromEnv } from '../deps';
import { createStaff, STAFF_ENROLMENT_HOURS, type StaffRole } from '../modules/backoffice/auth';

/**
 * Creates a Thapsus back-office staff account and prints its one-time enrolment link (ADR-0173). Staff
 * sign in only with a passkey or security key, registered through that link; there is no password.
 * Only an operator with database access can run this (docs/runbooks/staff-access.md).
 */
const [email, name, role] = process.argv.slice(2);
const roles: StaffRole[] = ['super_admin', 'support', 'rules_editor', 'billing'];
if (!email || !name || !roles.includes(role as StaffRole)) {
  console.error(`usage: create-staff <email> "<name>" <${roles.join('|')}>`);
  process.exit(2);
}
const deps = await depsFromEnv();
const s = await createStaff({ deps }, email, name, role as StaffRole);
console.log(
  `staff ${s.id} created for ${email} (${role})\nenrolment link (one use, valid ${STAFF_ENROLMENT_HOURS} hours): ${s.enrolmentUrl}\nGive it to the staff member over a channel you trust; it registers their passkey or security key.`,
);
process.exit(0);
