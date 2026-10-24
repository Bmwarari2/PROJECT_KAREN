import { depsFromEnv } from '../deps';
import { createStaff, type StaffRole } from '../modules/backoffice/auth';

/** Creates a Thapsus back-office staff account and prints its one-time password and TOTP secret. */
const [email, name, role] = process.argv.slice(2);
const roles: StaffRole[] = ['super_admin', 'support', 'rules_editor', 'billing', 'security_analyst'];
if (!email || !name || !roles.includes(role as StaffRole)) {
  console.error(`usage: create-staff <email> "<name>" <${roles.join('|')}>`);
  process.exit(2);
}
const deps = await depsFromEnv();
const s = await createStaff({ deps } as never, email, name, role as StaffRole);
console.log(
  `staff ${s.id} created for ${email} (${role})\none-time password: ${s.password}\nTOTP secret (add to an authenticator app): ${s.totpSecret}`,
);
process.exit(0);
