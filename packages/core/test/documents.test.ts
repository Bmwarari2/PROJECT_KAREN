import { describe, expect, it } from 'vitest';
import {
  addressInWords,
  entitlementInWords,
  fieldsIn,
  isKnownField,
  mergeBlocks,
  MERGE_FIELDS,
  newDocumentHref,
  noticeInWords,
  parseInline,
  parseMarkup,
  patternInWords,
  rateInWords,
  splitFields,
  unknownFields,
} from '../src/documents';
import { t } from '../src/i18n';

/** Document templates (ADR-0194): the simple formatting, merge fields and values in words. Fictional data only. */
const tr = (locale: 'en-GB' | 'en-US') => (key: string, vars?: Record<string, string | number>) =>
  t(locale, key, vars);

describe('template formatting', () => {
  it('parses headings, paragraphs with line breaks, bulleted and numbered lists, and bold', () => {
    const blocks = parseMarkup(
      '# Your terms\n\nEmployer: **Example Ltd**\nEmployee: Alex\n\n## Pay\n- Salary\n- Bonus\n\n3. Third clause\n4. Fourth clause\nAfter the list.',
    );
    expect(blocks).toEqual([
      { type: 'heading', level: 1, runs: [{ text: 'Your terms', bold: false }] },
      {
        type: 'paragraph',
        lines: [
          [
            { text: 'Employer: ', bold: false },
            { text: 'Example Ltd', bold: true },
          ],
          [{ text: 'Employee: Alex', bold: false }],
        ],
      },
      { type: 'heading', level: 2, runs: [{ text: 'Pay', bold: false }] },
      {
        type: 'list',
        ordered: false,
        items: [
          { marker: '•', runs: [{ text: 'Salary', bold: false }] },
          { marker: '•', runs: [{ text: 'Bonus', bold: false }] },
        ],
      },
      {
        type: 'list',
        ordered: true,
        items: [
          { marker: '3.', runs: [{ text: 'Third clause', bold: false }] },
          { marker: '4.', runs: [{ text: 'Fourth clause', bold: false }] },
        ],
      },
      { type: 'paragraph', lines: [[{ text: 'After the list.', bold: false }]] },
    ]);
    // an unmatched marker stays as typed
    expect(parseInline('5 ** 2')).toEqual([{ text: '5 ** 2', bold: false }]);
  });

  it('merges values after parsing, so a value never becomes formatting', () => {
    const merged = mergeBlocks(parseMarkup('Hello {{employee.firstName}}'), () => '# **not a heading**');
    expect(merged).toEqual([
      { type: 'paragraph', lines: [[{ text: 'Hello # **not a heading**', bold: false }]] },
    ]);
  });
});

describe('merge fields', () => {
  it('knows the catalogue and the ask-when-sending fields, and flags anything else', () => {
    const ask = [{ key: 'startTime', label: 'Start time', required: true }];
    const body =
      '{{employee.firstName}} {{ask.startTime}} {{ask.other}} {{employee.nope}} {{ employee.firstName }}';
    expect(fieldsIn(body)).toEqual(['employee.firstName', 'ask.startTime', 'ask.other', 'employee.nope']);
    expect(unknownFields(body, ask)).toEqual(['ask.other', 'employee.nope']);
    expect(isKnownField('contract.noticePeriod')).toBe(true);
    expect(splitFields('A {{b.c}} d')).toEqual(['A ', { field: 'b.c' }, ' d']);
    // every field has a label in both catalogues
    for (const f of MERGE_FIELDS) {
      expect(t('en-GB', `docFields.${f.key}`), f.key).not.toBe(`docFields.${f.key}`);
      expect(t('en-US', `docFields.${f.key}`), f.key).not.toBe(`docFields.${f.key}`);
    }
  });

  it('puts values in words for the locale', () => {
    expect(noticeInWords(28, 'en-GB')).toBe('4 weeks');
    expect(noticeInWords(30, 'en-GB')).toBe('30 days');
    expect(noticeInWords(7, 'en-US')).toBe('1 week');
    expect(patternInWords({ 1: 7.5, 2: 7.5, 3: 7.5, 4: 7.5, 5: 7.5 }, 'en-GB', tr('en-GB'))).toBe(
      'Monday, Tuesday, Wednesday, Thursday and Friday (37.5 hours a week)',
    );
    expect(patternInWords({ 6: 8, 7: 8 }, 'en-US', tr('en-US'))).toBe(
      'Saturday and Sunday (16 hours a week)',
    );
    expect(entitlementInWords({ kind: 'days', amount: 25 }, 'en-GB', tr('en-GB'))).toBe('25 days a year');
    expect(entitlementInWords({ kind: 'hours', amount: 1 }, 'en-GB', tr('en-GB'))).toBe('1 hour a year');
    expect(entitlementInWords({ kind: 'percent', amount: 12.07 }, 'en-GB', tr('en-GB'))).toBe(
      '12.07% of the hours worked',
    );
    expect(rateInWords('£30,000.00', 'annual', tr('en-GB'))).toBe('£30,000.00 a year');
    expect(rateInWords('$20.00', 'hourly', tr('en-US'))).toBe('$20.00 an hour');
    expect(
      addressInWords({ line1: '1 Sample Street', city: 'Exampletown', postcode: 'ZZ1 1ZZ', country: 'GB' }),
    ).toBe('1 Sample Street, Exampletown, ZZ1 1ZZ');
  });

  it('links the send page with the person, template and task (the send_document task action)', () => {
    expect(newDocumentHref({ employeeId: 'e1', templateId: 't1', taskId: 'k1' })).toBe(
      '/app/people/e1/documents/new?template=t1&task=k1',
    );
    expect(newDocumentHref({ employeeId: 'e1', documentId: 'd1' })).toBe(
      '/app/people/e1/documents/new?document=d1',
    );
  });
});
