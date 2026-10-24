import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { compareDates, isCivilDate } from '@thapsus/core/time';

/**
 * Structured payslip content as the customer's payroll provider supplies it (ADR-0167). Thapsus-HR does not
 * run payroll and never calculates pay, tax or deductions (CLAUDE.md scope): every amount here is the
 * provider's, in integer minor units of the statement's ISO 4217 currency. The only arithmetic is the check
 * that the provider's lines add up to the provider's totals, so a statement that does not add up is refused
 * instead of being shown to an employee.
 */
const Minor = Type.Integer({ minimum: -1_000_000_000_000, maximum: 1_000_000_000_000 });
const Text = (max: number) => Type.String({ minLength: 1, maxLength: max });
const Day = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });

export const PAYMENT_KINDS = [
  'basic',
  'overtime',
  'bonus',
  'commission',
  'allowance',
  'holiday',
  'sick',
  'parental',
  'back_pay',
  'expenses',
  'other',
] as const;
export const DEDUCTION_KINDS = [
  'income_tax',
  'social_security',
  'pension',
  'student_loan',
  'benefit',
  'union',
  'attachment_of_earnings',
  'other',
] as const;
export const CONTRIBUTION_KINDS = ['pension', 'social_security', 'benefit', 'other'] as const;

const line = <K extends readonly string[]>(kinds: K) =>
  Type.Object(
    {
      kind: Type.Enum(kinds),
      /** As printed by the provider, e.g. "Basic pay", "PAYE income tax", "Overtime 1.5x". */
      label: Text(80),
      /** The provider's own code for the line, if any. */
      code: Type.Optional(Text(40)),
      /** Hours or units, as a decimal string ("12.50"), when the provider gives them. */
      quantity: Type.Optional(Type.String({ pattern: '^-?\\d{1,7}(\\.\\d{1,4})?$' })),
      /** Rate per unit in minor units, when the provider gives it. */
      rateMinor: Type.Optional(Minor),
      amountMinor: Minor,
    },
    { additionalProperties: false },
  );
export const PaymentLine = line(PAYMENT_KINDS);
export const DeductionLine = line(DEDUCTION_KINDS);
export const ContributionLine = line(CONTRIBUTION_KINDS);

const YtdItem = Type.Object(
  {
    key: Type.Enum([
      'gross',
      'taxable_pay',
      'income_tax',
      'social_security',
      'pension_employee',
      'pension_employer',
      'student_loan',
      'net',
      'other',
    ] as const),
    label: Text(80),
    amountMinor: Minor,
  },
  { additionalProperties: false },
);

export const PayslipStatement = Type.Object(
  {
    /** Matches the employee in this workspace (the same matching as payslip files). */
    employeeNumber: Text(60),
    currency: Type.String({ pattern: '^[A-Z]{3}$' }),
    employer: Type.Object(
      {
        name: Text(160),
        address: Type.Optional(Type.Array(Text(120), { maxItems: 6 })),
        /** Employer tax reference (for example a PAYE reference or an EIN), as the provider prints it. */
        taxReference: Type.Optional(Text(40)),
      },
      { additionalProperties: false },
    ),
    employee: Type.Object(
      {
        name: Text(160),
        address: Type.Optional(Type.Array(Text(120), { maxItems: 6 })),
        department: Type.Optional(Text(120)),
        jobTitle: Type.Optional(Text(120)),
        /** Tax code (UK) or filing status, as the provider prints it. */
        taxCode: Type.Optional(Text(20)),
        /** National identifier: only a masked form is kept (maskNationalId), whatever the provider sends. */
        nationalId: Type.Optional(Text(30)),
      },
      { additionalProperties: false },
    ),
    period: Type.Object(
      {
        start: Day,
        end: Day,
        payDate: Day,
        frequency: Type.Enum([
          'weekly',
          'fortnightly',
          'four_weekly',
          'semi_monthly',
          'monthly',
          'other',
        ] as const),
        /** The provider's period label, e.g. "Month 7" or "Week 32". */
        number: Type.Optional(Text(20)),
        /** The tax year the year-to-date figures cover, e.g. "2026-27" or "2026". */
        taxYear: Type.Optional(Text(20)),
      },
      { additionalProperties: false },
    ),
    payment: Type.Object(
      {
        method: Type.Enum(['bank_transfer', 'cheque', 'cash', 'other'] as const),
        /** Only the last digits are kept (maskAccount). */
        account: Type.Optional(Text(40)),
      },
      { additionalProperties: false },
    ),
    payments: Type.Array(PaymentLine, { minItems: 1, maxItems: 60 }),
    deductions: Type.Array(DeductionLine, { maxItems: 60 }),
    employerContributions: Type.Optional(Type.Array(ContributionLine, { maxItems: 30 })),
    totals: Type.Object(
      { grossMinor: Minor, deductionsMinor: Minor, netMinor: Minor },
      { additionalProperties: false },
    ),
    ytd: Type.Optional(Type.Array(YtdItem, { maxItems: 20 })),
    /** Messages the provider prints on the payslip. */
    notes: Type.Optional(Type.Array(Text(300), { maxItems: 5 })),
    /** Fictional sample figures: the statement is shown with a "Sample data" marker (ADR-0167). */
    illustrative: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type PayslipStatement = Static<typeof PayslipStatement>;

/** The import file: who issued the statements, and the statements. */
export const StatementImport = Type.Object(
  {
    provider: Type.Object({ name: Text(120) }, { additionalProperties: false }),
    /** Fictional sample data (staging): the payslips are marked as such everywhere they are shown. */
    sample: Type.Optional(Type.Boolean()),
    statements: Type.Array(PayslipStatement, { minItems: 1, maxItems: 5000 }),
  },
  { additionalProperties: false },
);
export type StatementImport = Static<typeof StatementImport>;

export type StatementProblem =
  'invalidStatement' | 'paymentsDoNotAddUp' | 'deductionsDoNotAddUp' | 'netDoesNotAddUp' | 'periodInvalid';

const sum = (lines: Array<{ amountMinor: number }> | undefined) =>
  (lines ?? []).reduce((a, l) => a + BigInt(l.amountMinor), 0n);

/**
 * Checks a statement as received: the shape, the period, and that the provider's lines add up to the
 * provider's totals (payments = gross, deductions = total deductions, gross − deductions = net), exactly, in
 * integer minor units. Employer contributions are not part of net pay and are not checked against it.
 */
export function checkStatement(s: unknown): StatementProblem[] {
  if (!Value.Check(PayslipStatement, s)) return ['invalidStatement'];
  const st = s as PayslipStatement;
  const problems: StatementProblem[] = [];
  if (![st.period.start, st.period.end, st.period.payDate].every(isCivilDate)) return ['periodInvalid'];
  if (
    compareDates(st.period.end, st.period.start) < 0 ||
    compareDates(st.period.payDate, st.period.start) < 0
  )
    problems.push('periodInvalid');
  const gross = sum(st.payments);
  const deductions = sum(st.deductions);
  if (gross !== BigInt(st.totals.grossMinor)) problems.push('paymentsDoNotAddUp');
  if (deductions !== BigInt(st.totals.deductionsMinor)) problems.push('deductionsDoNotAddUp');
  if (BigInt(st.totals.grossMinor) - BigInt(st.totals.deductionsMinor) !== BigInt(st.totals.netMinor))
    problems.push('netDoesNotAddUp');
  return problems;
}

/** Keeps the last `visible` letters and digits of an identifier and masks the rest ("•••• 456C"). */
function mask(value: string, visible: number): string {
  const chars = value.replace(/[^A-Za-z0-9]/g, '');
  if (!chars) return '';
  const shown = chars.slice(-Math.min(visible, Math.max(0, chars.length - 2)));
  return `•••• ${shown}`.trim();
}
/** A national identifier (NI number, SSN, PPS number…) is never stored whole: at most its last four characters. */
export const maskNationalId = (v: string) => mask(v, 4);
/** A bank account number: its last four digits. */
export const maskAccount = (v: string) => mask(v, 4);

/** The statement as stored: identifiers masked, nothing else changed. */
export function storedStatement(s: PayslipStatement): PayslipStatement {
  return {
    ...s,
    employee: {
      ...s.employee,
      ...(s.employee.nationalId ? { nationalId: maskNationalId(s.employee.nationalId) } : {}),
    },
    payment: { ...s.payment, ...(s.payment.account ? { account: maskAccount(s.payment.account) } : {}) },
  };
}
