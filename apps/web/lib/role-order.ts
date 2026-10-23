/**
 * The session's roles, most senior first: the built-in admin roles, then custom roles, then manager and
 * employee. The top bar shows the first one, so a manager who is also an employee reads as "Manager".
 */
const SENIORITY = ['owner', 'hr_admin', 'entity_hr_admin', 'payroll_admin', '', 'manager', 'employee'];
export function bySeniority(roles: string[]): string[] {
  const rank = (r: string) => {
    const i = SENIORITY.indexOf(r);
    return i === -1 ? SENIORITY.indexOf('') : i;
  };
  return [...roles].sort((a, b) => rank(a) - rank(b));
}
