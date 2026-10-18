/**
 * Privacy and retention rule keys (Phase 8). Kept in their own module so employment-rule work on the
 * pack engine and the privacy rules can evolve independently; schema.ts spreads them into RULE_KEYS.
 */
export const PRIVACY_RULE_KEYS = {
  'privacy.dsr_deadline': 'Deadline to respond to a data subject / consumer rights request (access, correction, deletion)',
  'privacy.breach_notification': 'Personal data breach notification deadlines (regulator, individuals, processor to controller)',
  'retention.time_records': 'Minimum retention of working-time and time-card records',
  'retention.payroll_records': 'Minimum retention of payroll and pay records',
  'retention.minimum_wage_records': 'Minimum retention of records showing minimum wage compliance',
  'retention.leave_records': 'Minimum retention of statutory leave records',
  'retention.personnel_records': 'Retention of personnel records (statutory minimum or suggested default for legal review)',
} as const;
