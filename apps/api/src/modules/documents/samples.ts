import type { AskField, SigningOrder } from '@thapsus/core/documents';

/**
 * Starter templates (16.9, ADR-0194): a sample for the UK, Ireland and the US that a workspace can copy into its
 * own templates and edit. They are labelled as samples everywhere they appear: the wording is a starting point
 * laid out with merge fields, not legal advice, and is waiting for review by a qualified employment lawyer in each
 * country (HUMAN_TODO 3.17). They state no employment rule themselves: every value (pay, hours, holiday, notice,
 * probation) comes from the person's record or the leave policy, and anything the system does not hold (the date
 * continuous employment began) is asked for when sending.
 *
 * The wording is document content in the template's own language (like a customer's own template), not interface
 * text, so it lives here as data rather than in the message catalogues; the sample's name and the labels of its
 * ask-when-sending fields are catalogue messages (docTpl.samples.<key>).
 */
export interface SampleTemplate {
  key: string;
  country: 'GB' | 'IE' | 'US';
  locale: 'en-GB' | 'en-US';
  category: string;
  requiresCountersign: boolean;
  signingOrder: SigningOrder;
  /** labels are catalogue messages: docTpl.samples.<key>.ask.<field> */
  askFields: Array<Omit<AskField, 'label'>>;
  body: string;
}

const UK_STATEMENT = `# Your employment

This statement sets out the main terms of your employment with **{{entity.name}}** ({{entity.address}}).

- Employee: {{employee.displayName}} ({{employee.employeeNumber}})
- Job title: {{employee.jobTitle}}, {{employee.department}}
- Place of work: {{employee.location}}
- Manager: {{manager.name}}, {{manager.jobTitle}}

## Dates

Your employment starts on {{employee.startDate}}. Your period of continuous employment began on {{ask.continuousEmployment}}. Your contract is {{contract.type}}, and your probation period ends on {{contract.probationEndDate}}.

## Pay

You are paid {{pay.rate}}. Pay is paid {{pay.schedule}}; the next pay day is {{pay.nextPayDate}}.

## Hours

You work {{employee.workPattern}}.

## Holiday

Your holiday entitlement is {{leave.annualEntitlement}}. The holiday year starts on {{leave.yearStart}}.

## Notice

The notice period to end your employment is {{contract.noticePeriod}}.

## Other terms

Sick pay, pensions, training, disciplinary and grievance procedures and other terms are set out in the employee handbook.`;

const IE_STATEMENT = `# Your employment

This statement sets out the terms of your employment with **{{entity.name}}** ({{entity.address}}, registered number {{entity.registrationNumber}}).

- Employee: {{employee.displayName}} ({{employee.employeeNumber}})
- Job title: {{employee.jobTitle}}, {{employee.department}}
- Place of work: {{employee.location}}

## Dates

Your employment starts on {{employee.startDate}}. Your contract is {{contract.type}}, and your probation period ends on {{contract.probationEndDate}}.

## Pay

You are paid {{pay.rate}}, {{pay.schedule}}. The next pay day is {{pay.nextPayDate}}.

## Hours

You work {{employee.workPattern}}. Your normal start and finish times are {{ask.normalHours}}.

## Holiday

Your annual leave is {{leave.annualEntitlement}}, and the leave year starts on {{leave.yearStart}}.

## Notice

The notice period to end your employment is {{contract.noticePeriod}}.

## Other terms

Sick pay, pensions, the disciplinary and grievance procedures and other terms are set out in the employee handbook.`;

const US_OFFER = `Dear {{employee.firstName}},

We are pleased to offer you the position of **{{employee.jobTitle}}** at {{entity.name}}, reporting to {{manager.name}}.

## Your offer

- Start date: {{employee.startDate}}
- Location: {{employee.location}}
- Employment type: {{employee.employmentType}}
- Pay: {{pay.rate}}, paid {{pay.schedule}}
- Paid time off: {{leave.annualEntitlement}}

## Next steps

Please sign this letter by {{ask.respondBy}} to accept the offer. On your first day, please bring the documents you will use to complete Form I-9.

We look forward to welcoming you.

{{company.name}}`;

export const SAMPLE_TEMPLATES: SampleTemplate[] = [
  {
    key: 'uk_statement',
    country: 'GB',
    locale: 'en-GB',
    category: 'contract',
    requiresCountersign: true,
    signingOrder: 'employee_first',
    askFields: [{ key: 'continuousEmployment', required: true }],
    body: UK_STATEMENT,
  },
  {
    key: 'ie_statement',
    country: 'IE',
    locale: 'en-GB',
    category: 'contract',
    requiresCountersign: true,
    signingOrder: 'employee_first',
    askFields: [{ key: 'normalHours', required: true }],
    body: IE_STATEMENT,
  },
  {
    key: 'us_offer',
    country: 'US',
    locale: 'en-US',
    category: 'offer',
    requiresCountersign: true,
    signingOrder: 'company_first',
    askFields: [{ key: 'respondBy', required: true }],
    body: US_OFFER,
  },
];

export const sampleByKey = (key: string) => SAMPLE_TEMPLATES.find((s) => s.key === key);
