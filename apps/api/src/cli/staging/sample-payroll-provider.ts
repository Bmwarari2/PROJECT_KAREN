import type { PayslipStatement } from '../../modules/payslips/statement';

/**
 * THE SAMPLE PAYROLL PROVIDER — a fixture, not a calculator (ADR-0167).
 *
 * Thapsus-HR does not run payroll and must never calculate tax, social security or other deductions. Payslips in
 * the staging workspace therefore come from this fixture, which plays the part of the customer's payroll provider:
 *
 *  - every deduction and employer contribution below is a figure written into this file by hand. They are
 *    ILLUSTRATIVE ONLY: not derived from any tax rule, not calculated by Thapsus-HR, and not correct tax for anyone;
 *  - a payslip takes the figures of the band its gross pay falls in, as they stand (nothing is scaled or derived);
 *  - gross pay is the fictional employee's contracted pay from the HR record (salary ÷ 12, or contracted hours ×
 *    hourly rate), plus the overtime hours and bonuses listed here;
 *  - every statement is flagged `illustrative`, its batch is flagged `sample`, and the product shows both with a
 *    "Sample data" marker and the issuing provider's name.
 *
 * The labels are what this fictional provider prints on its payslips (provider data, shown as received).
 */
export const SAMPLE_PROVIDER_NAME = 'Sample Payroll Provider (fictional)';
export const SAMPLE_NOTE =
  'ILLUSTRATIVE FIGURES from a fictional sample payroll provider for the staging environment. Not calculated by Thapsus-HR and not correct tax for anyone.';

type Line = { kind: string; label: string; amountMinor: number };
interface Band {
  /** The band applies while gross pay for the period is at most this (minor units); the last band has none. */
  upToGrossMinor: number | null;
  deductions: Line[];
  /** Shown only for people the fixture marks with a student loan. */
  studentLoan?: Line;
  employer: Line[];
}

/** UK (GBP), monthly. Hand-written illustrative figures. */
const GBP_MONTHLY: Band[] = [
  b(
    150_000,
    [
      ['income_tax', 'PAYE income tax', 4_560],
      ['social_security', 'National Insurance', 2_180],
      ['pension', 'Workplace pension', 3_750],
    ],
    ['student_loan', 'Student loan', 0],
    [
      ['pension', 'Employer pension', 2_250],
      ['social_security', 'Employer National Insurance', 9_800],
    ],
  ),
  b(
    200_000,
    [
      ['income_tax', 'PAYE income tax', 13_960],
      ['social_security', 'National Insurance', 5_860],
      ['pension', 'Workplace pension', 5_000],
    ],
    ['student_loan', 'Student loan', 3_140],
    [
      ['pension', 'Employer pension', 3_000],
      ['social_security', 'Employer National Insurance', 17_300],
    ],
  ),
  b(
    250_000,
    [
      ['income_tax', 'PAYE income tax', 23_960],
      ['social_security', 'National Insurance', 9_860],
      ['pension', 'Workplace pension', 6_250],
    ],
    ['student_loan', 'Student loan', 7_640],
    [
      ['pension', 'Employer pension', 3_750],
      ['social_security', 'Employer National Insurance', 24_800],
    ],
  ),
  b(
    300_000,
    [
      ['income_tax', 'PAYE income tax', 33_960],
      ['social_security', 'National Insurance', 13_860],
      ['pension', 'Workplace pension', 7_500],
    ],
    ['student_loan', 'Student loan', 12_140],
    [
      ['pension', 'Employer pension', 4_500],
      ['social_security', 'Employer National Insurance', 32_300],
    ],
  ),
  b(
    350_000,
    [
      ['income_tax', 'PAYE income tax', 43_960],
      ['social_security', 'National Insurance', 17_860],
      ['pension', 'Workplace pension', 8_750],
    ],
    ['student_loan', 'Student loan', 16_640],
    [
      ['pension', 'Employer pension', 5_250],
      ['social_security', 'Employer National Insurance', 39_800],
    ],
  ),
  b(
    450_000,
    [
      ['income_tax', 'PAYE income tax', 63_960],
      ['social_security', 'National Insurance', 25_860],
      ['pension', 'Workplace pension', 11_250],
    ],
    ['student_loan', 'Student loan', 25_640],
    [
      ['pension', 'Employer pension', 6_750],
      ['social_security', 'Employer National Insurance', 54_800],
    ],
  ),
  b(
    600_000,
    [
      ['income_tax', 'PAYE income tax', 110_340],
      ['social_security', 'National Insurance', 31_030],
      ['pension', 'Workplace pension', 15_000],
    ],
    ['student_loan', 'Student loan', 39_140],
    [
      ['pension', 'Employer pension', 9_000],
      ['social_security', 'Employer National Insurance', 77_300],
    ],
  ),
  b(
    900_000,
    [
      ['income_tax', 'PAYE income tax', 230_340],
      ['social_security', 'National Insurance', 37_030],
      ['pension', 'Workplace pension', 22_500],
    ],
    ['student_loan', 'Student loan', 66_140],
    [
      ['pension', 'Employer pension', 13_500],
      ['social_security', 'Employer National Insurance', 122_300],
    ],
  ),
  b(
    null,
    [
      ['income_tax', 'PAYE income tax', 470_340],
      ['social_security', 'National Insurance', 49_030],
      ['pension', 'Workplace pension', 37_500],
    ],
    ['student_loan', 'Student loan', 120_140],
    [
      ['pension', 'Employer pension', 22_500],
      ['social_security', 'Employer National Insurance', 212_300],
    ],
  ),
];

/** Ireland (EUR), monthly. Hand-written illustrative figures. */
const EUR_MONTHLY: Band[] = [
  b(
    250_000,
    [
      ['income_tax', 'PAYE', 14_200],
      ['social_security', 'USC', 3_850],
      ['social_security', 'PRSI', 9_000],
      ['pension', 'Pension', 7_500],
    ],
    undefined,
    [
      ['pension', 'Employer pension', 7_500],
      ['social_security', 'Employer PRSI', 27_600],
    ],
  ),
  b(
    350_000,
    [
      ['income_tax', 'PAYE', 34_200],
      ['social_security', 'USC', 7_350],
      ['social_security', 'PRSI', 13_300],
      ['pension', 'Pension', 10_500],
    ],
    undefined,
    [
      ['pension', 'Employer pension', 10_500],
      ['social_security', 'Employer PRSI', 38_700],
    ],
  ),
  b(
    500_000,
    [
      ['income_tax', 'PAYE', 77_900],
      ['social_security', 'USC', 12_600],
      ['social_security', 'PRSI', 19_800],
      ['pension', 'Pension', 15_000],
    ],
    undefined,
    [
      ['pension', 'Employer pension', 15_000],
      ['social_security', 'Employer PRSI', 55_300],
    ],
  ),
  b(
    null,
    [
      ['income_tax', 'PAYE', 158_900],
      ['social_security', 'USC', 23_600],
      ['social_security', 'PRSI', 33_000],
      ['pension', 'Pension', 25_000],
    ],
    undefined,
    [
      ['pension', 'Employer pension', 25_000],
      ['social_security', 'Employer PRSI', 92_100],
    ],
  ),
];

/** United States (USD), semi-monthly. Hand-written illustrative figures. */
const USD_SEMI_MONTHLY: Band[] = [
  b(
    150_000,
    [
      ['income_tax', 'Federal income tax', 9_800],
      ['income_tax', 'State income tax', 4_150],
      ['social_security', 'Social Security', 9_300],
      ['social_security', 'Medicare', 2_180],
      ['pension', '401(k)', 6_000],
    ],
    undefined,
    [
      ['pension', '401(k) match', 4_500],
      ['social_security', 'Employer Social Security', 9_300],
      ['social_security', 'Employer Medicare', 2_180],
    ],
  ),
  b(
    250_000,
    [
      ['income_tax', 'Federal income tax', 22_400],
      ['income_tax', 'State income tax', 8_900],
      ['social_security', 'Social Security', 15_500],
      ['social_security', 'Medicare', 3_630],
      ['pension', '401(k)', 10_000],
    ],
    undefined,
    [
      ['pension', '401(k) match', 7_500],
      ['social_security', 'Employer Social Security', 15_500],
      ['social_security', 'Employer Medicare', 3_630],
    ],
  ),
  b(
    400_000,
    [
      ['income_tax', 'Federal income tax', 51_300],
      ['income_tax', 'State income tax', 17_600],
      ['social_security', 'Social Security', 24_800],
      ['social_security', 'Medicare', 5_800],
      ['pension', '401(k)', 16_000],
    ],
    undefined,
    [
      ['pension', '401(k) match', 12_000],
      ['social_security', 'Employer Social Security', 24_800],
      ['social_security', 'Employer Medicare', 5_800],
    ],
  ),
  b(
    null,
    [
      ['income_tax', 'Federal income tax', 118_900],
      ['income_tax', 'State income tax', 36_100],
      ['social_security', 'Social Security', 41_200],
      ['social_security', 'Medicare', 9_650],
      ['pension', '401(k)', 26_600],
    ],
    undefined,
    [
      ['pension', '401(k) match', 20_000],
      ['social_security', 'Employer Social Security', 41_200],
      ['social_security', 'Employer Medicare', 9_650],
    ],
  ),
];

function b(
  upTo: number | null,
  deductions: Array<[string, string, number]>,
  loan: [string, string, number] | undefined,
  employer: Array<[string, string, number]>,
): Band {
  const line = ([kind, label, amountMinor]: [string, string, number]) => ({ kind, label, amountMinor });
  return {
    upToGrossMinor: upTo,
    deductions: deductions.map(line),
    ...(loan && loan[2] > 0 ? { studentLoan: line(loan) } : {}),
    employer: employer.map(line),
  };
}

export const BANDS: Record<'GBP' | 'EUR' | 'USD', Band[]> = {
  GBP: GBP_MONTHLY,
  EUR: EUR_MONTHLY,
  USD: USD_SEMI_MONTHLY,
};

/** The band a gross amount falls in (the first whose ceiling it does not exceed). */
export const bandFor = (currency: 'GBP' | 'EUR' | 'USD', grossMinor: number) =>
  BANDS[currency].find((x) => x.upToGrossMinor === null || grossMinor <= x.upToGrossMinor)!;

/** Overtime hours this fictional provider reports, by months before the latest pay date (hourly and shift staff). */
export const OVERTIME_HOURS_BY_MONTHS_AGO: Record<number, string> = {
  1: '6.50',
  2: '12.00',
  4: '4.00',
  7: '9.50',
  10: '15.00',
};
/** Overtime is paid at this multiple of the hourly rate (the fictional company's policy, ×100). */
export const OVERTIME_RATE_PERCENT = 150;
/** Bonuses this fictional provider reports: months before the latest pay date → amount by seniority. */
export const BONUSES_BY_MONTHS_AGO: Record<
  number,
  { label: string; member: number; lead: number; exec: number }
> = {
  6: { label: 'Annual bonus', member: 40_000, lead: 120_000, exec: 450_000 },
  3: { label: 'Quarterly performance bonus', member: 15_000, lead: 25_000, exec: 60_000 },
};

export interface SampleStatementInput {
  employeeNumber: string;
  employeeName: string;
  employeeAddress: string[];
  department: string;
  jobTitle: string;
  employer: { name: string; address: string[]; taxReference: string };
  currency: 'GBP' | 'EUR' | 'USD';
  period: PayslipStatement['period'];
  /** Payment lines (from the HR record and the overtime and bonus lists above). */
  payments: PayslipStatement['payments'];
  studentLoan: boolean;
  /** A fictional identifier; only its last characters are kept when imported. */
  nationalId: string;
  taxCode: string | null;
  accountNumber: string;
}

/** One illustrative statement: the payment lines given, and the band's deductions and contributions as they stand. */
export function sampleStatement(i: SampleStatementInput): PayslipStatement {
  const gross = i.payments.reduce((a, l) => a + l.amountMinor, 0);
  const band = bandFor(i.currency, gross);
  const deductions = [
    ...band.deductions,
    ...(i.studentLoan && band.studentLoan ? [band.studentLoan] : []),
  ].map((l) => ({ ...l }) as PayslipStatement['deductions'][number]);
  const total = deductions.reduce((a, l) => a + l.amountMinor, 0);
  return {
    employeeNumber: i.employeeNumber,
    currency: i.currency,
    employer: i.employer,
    employee: {
      name: i.employeeName,
      address: i.employeeAddress,
      department: i.department,
      jobTitle: i.jobTitle,
      ...(i.taxCode ? { taxCode: i.taxCode } : {}),
      nationalId: i.nationalId,
    },
    period: i.period,
    payment: { method: 'bank_transfer', account: i.accountNumber },
    payments: i.payments,
    deductions,
    employerContributions: band.employer.map(
      (l) => ({ ...l }) as NonNullable<PayslipStatement['employerContributions']>[number],
    ),
    totals: { grossMinor: gross, deductionsMinor: total, netMinor: gross - total },
    notes: [SAMPLE_NOTE],
    illustrative: true,
  };
}

/**
 * Year-to-date figures as this provider prints them: the sums of its own figures on the earlier statements of the
 * same tax year (adding up the provider's lines; no tax is worked out).
 */
export function withYearToDate(earlier: PayslipStatement[], s: PayslipStatement): PayslipStatement {
  const all = [...earlier, s];
  const total = (f: (x: PayslipStatement) => number) => all.reduce((a, x) => a + f(x), 0);
  const kindSum = (x: PayslipStatement, kind: string) =>
    x.deductions.filter((d) => d.kind === kind).reduce((a, d) => a + d.amountMinor, 0);
  const employerPension = (x: PayslipStatement) =>
    (x.employerContributions ?? [])
      .filter((d) => d.kind === 'pension')
      .reduce((a, d) => a + d.amountMinor, 0);
  const ytd: NonNullable<PayslipStatement['ytd']> = [
    { key: 'gross', label: 'Gross pay to date', amountMinor: total((x) => x.totals.grossMinor) },
    { key: 'income_tax', label: 'Income tax to date', amountMinor: total((x) => kindSum(x, 'income_tax')) },
    {
      key: 'social_security',
      label: 'Social security to date',
      amountMinor: total((x) => kindSum(x, 'social_security')),
    },
    {
      key: 'pension_employee',
      label: 'Your pension to date',
      amountMinor: total((x) => kindSum(x, 'pension')),
    },
    { key: 'pension_employer', label: 'Employer pension to date', amountMinor: total(employerPension) },
    ...(all.some((x) => kindSum(x, 'student_loan'))
      ? [
          {
            key: 'student_loan' as const,
            label: 'Student loan to date',
            amountMinor: total((x) => kindSum(x, 'student_loan')),
          },
        ]
      : []),
    { key: 'net', label: 'Net pay to date', amountMinor: total((x) => x.totals.netMinor) },
  ];
  return { ...s, ytd };
}
