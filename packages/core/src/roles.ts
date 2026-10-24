import type { FieldAccess, ScopeType } from './permissions';

/**
 * Built-in tenant roles seeded for every new tenant. Customers can add custom roles; built-in roles
 * can be copied but not edited. The Thapsus super-admin is a back-office role, not a tenant role.
 */
export interface BuiltInRole {
  key: string;
  name: string;
  isAdmin: boolean;
  defaultScope: ScopeType;
  permissions: string[];
  fieldAccess: Record<string, FieldAccess>;
}

const SELF_SERVICE = [
  'self.read',
  'self.update_contact',
  'leave.request',
  'time.clock',
  'rota.view_own',
  'rota.swap_request',
  'rota.availability',
  'documents.read_own',
  'documents.sign',
  'payslips.read_own',
  'assets.read_own',
  'assets.acknowledge',
  'help.read',
  'ai.ask',
];

/**
 * Who people turn to (ADR-0163): admin roles contact Thapsus-HR support (`support.ticket`); employees
 * and managers ask their own HR team (`hr.contact`), which lands as a task in the HR admins' inbox.
 */
const CONTACT_SUPPORT = 'support.ticket';
const CONTACT_HR = 'hr.contact';

export const BUILT_IN_ROLES: BuiltInRole[] = [
  {
    key: 'owner',
    name: 'Company owner',
    isAdmin: true,
    defaultScope: 'all',
    permissions: ['*'],
    fieldAccess: { '*': 'write' },
  },
  {
    key: 'hr_admin',
    name: 'HR admin',
    isAdmin: true,
    defaultScope: 'all',
    permissions: [
      'employees.*',
      'org.*',
      'documents.*',
      'workflows.*',
      'approvals.*',
      'automation.*',
      'leave.*',
      'absence.*',
      'rota.*',
      'time.*',
      'compliance.*',
      'reports.*',
      'imports.*',
      'exports.*',
      'audit.read',
      'audit.export',
      'settings.read',
      'roles.read',
      'privacy.*',
      'assets.*',
      'payroll.read',
      'integrations.*',
      'vault.read:*',
      'vault.write:*',
      'support.*',
      'help.*',
      'users.*',
      ...SELF_SERVICE,
    ],
    fieldAccess: { 'employee.*': 'write', 'employee.pay.*': 'write' },
  },
  {
    key: 'entity_hr_admin',
    name: 'Country or entity HR admin',
    isAdmin: true,
    defaultScope: 'entity',
    permissions: [
      'employees.*',
      'documents.*',
      'workflows.*',
      'approvals.*',
      'leave.*',
      'absence.*',
      'rota.*',
      'time.*',
      'compliance.*',
      'reports.read',
      'reports.run',
      'imports.*',
      'exports.*',
      'privacy.read',
      'assets.*',
      'vault.read:*',
      'vault.write:*',
      CONTACT_SUPPORT,
      ...SELF_SERVICE,
    ],
    fieldAccess: { 'employee.*': 'write', 'employee.pay.*': 'write' },
  },
  {
    key: 'payroll_admin',
    name: 'Payroll admin',
    isAdmin: true,
    defaultScope: 'all',
    permissions: [
      'employees.read',
      'payroll.*',
      'leave.read',
      'absence.read',
      'time.read',
      'time.export',
      'reports.read',
      'reports.run',
      'exports.*',
      'payslips.*',
      CONTACT_SUPPORT,
      ...SELF_SERVICE,
    ],
    fieldAccess: { 'employee.*': 'read', 'employee.pay.*': 'write', 'employee.bank.*': 'write' },
  },
  {
    key: 'manager',
    name: 'Manager',
    isAdmin: false,
    defaultScope: 'own_team',
    permissions: [
      'employees.read',
      'leave.read',
      'leave.approve',
      'absence.read',
      'absence.record',
      'rota.*',
      'time.read',
      'time.approve',
      'time.correct',
      'approvals.act',
      'reports.read_team',
      'documents.read',
      'workflows.tasks',
      'compliance.read',
      CONTACT_HR,
      ...SELF_SERVICE,
    ],
    fieldAccess: {
      'employee.*': 'none',
      'employee.id': 'read',
      'employee.displayName': 'read',
      'employee.preferredName': 'read',
      'employee.workEmail': 'read',
      'employee.workPhone': 'read',
      'employee.jobTitle': 'read',
      'employee.department': 'read',
      'employee.location': 'read',
      'employee.startDate': 'read',
      'employee.manager': 'read',
      'employee.status': 'read',
      'employee.photoUrl': 'read',
    },
  },
  {
    key: 'employee',
    name: 'Employee',
    isAdmin: false,
    defaultScope: 'self',
    permissions: [CONTACT_HR, ...SELF_SERVICE],
    fieldAccess: {
      'employee.*': 'read',
      'employee.pay.*': 'read',
      'employee.personalEmail': 'write',
      'employee.personalPhone': 'write',
      'employee.address': 'write',
      'employee.emergencyContacts': 'write',
      'employee.preferredName': 'write',
      'employee.pronouns': 'write',
    },
  },
];

/** Directory fields every signed-in employee may see about colleagues (org chart, people search). */
export const DIRECTORY_FIELDS = [
  'id',
  'displayName',
  'preferredName',
  'jobTitle',
  'department',
  'location',
  'workEmail',
  'photoUrl',
  'manager',
];
