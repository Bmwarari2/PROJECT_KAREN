import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { formatMessage, interpolate } from '@thapsus/core/i18n';
import { sanitiseFileName, sniffType } from '../src/lib/file-sniff';
import { LocalKeyProvider } from '../src/lib/kms';
import { isSealedFile, openFile, sealFile, sealedFileContext } from '../src/lib/sealed-file';
import {
  checkStatement,
  maskNationalId,
  storedStatement,
  type PayslipStatement,
} from '../src/modules/payslips/statement';
import { expiryStatus } from '../src/modules/documents/expiry';
import {
  BANDS,
  sampleStatement,
  SAMPLE_NOTE,
  withYearToDate,
} from '../src/cli/staging/sample-payroll-provider';

/** Units for documents people attach and read (ADR-0165, ADR-0166) and provider payslips (ADR-0167). Fictional data only. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const PDF = Buffer.from('%PDF-1.7\n% fictional\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

describe('type sniffing (the bytes decide, not the name)', () => {
  it('recognises PDFs, PNG, JPEG, WebP and Word files from their content', async () => {
    expect(sniffType(PDF)).toBe('application/pdf');
    expect(sniffType(Buffer.concat([Buffer.from('\r\n\r\n junk '), PDF]))).toBe('application/pdf');
    expect(sniffType(PNG)).toBe('image/png');
    expect(sniffType(JPEG)).toBe('image/jpeg');
    expect(sniffType(Buffer.from('RIFF\x10\0\0\0WEBPVP8 ', 'latin1'))).toBe('image/webp');
    const docx = new JSZip();
    docx.file('[Content_Types].xml', '<Types/>');
    docx.file('word/document.xml', '<w:document/>');
    expect(sniffType(await docx.generateAsync({ type: 'nodebuffer' }))).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('refuses everything else, whatever the file is called', async () => {
    const xlsx = new JSZip();
    xlsx.file('[Content_Types].xml', '<Types/>');
    xlsx.file('xl/workbook.xml', '<workbook/>');
    for (const bytes of [
      Buffer.from('<!doctype html><script>alert(1)</script>'),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
      Buffer.from('MZ\x90\0\x03\0\0\0\x04\0\0\0', 'latin1'), // a Windows executable
      Buffer.from('GIF89a\x01\0\x01\0', 'latin1'),
      Buffer.from('plain text, not a document'),
      await xlsx.generateAsync({ type: 'nodebuffer' }),
      Buffer.from('%PD'),
    ])
      expect(sniffType(bytes)).toBeNull();
  });

  it('sanitises names: last path segment, no control, reserved or bidi characters, the detected extension', () => {
    expect(sanitiseFileName('../../etc/passport.pdf', 'application/pdf')).toBe('passport.pdf');
    expect(sanitiseFileName('C:\\Users\\x\\scan.PDF', 'application/pdf')).toBe('scan.pdf');
    expect(sanitiseFileName('licence.pdf.exe', 'application/pdf')).toBe('licence.pdf.exe.pdf');
    expect(sanitiseFileName('photo.png', 'image/jpeg')).toBe('photo.jpg');
    expect(sanitiseFileName('inv\u202eoice<>:"|?*\u0007.pdf', 'application/pdf')).toBe('invoice.pdf');
    expect(sanitiseFileName('...', 'image/png')).toBe('document.png');
    expect(sanitiseFileName(`${'a'.repeat(300)}.pdf`, 'application/pdf')).toHaveLength(120);
  });
});

describe('sealed files (right-to-work evidence at rest)', () => {
  const kp = new LocalKeyProvider('44'.repeat(32));
  const ctx = { tenant: 't-1', subject: 'e-1', category: 'immigration', field: 'document:d-1' };

  it('round-trips under its own context and records it in a header without personal data', async () => {
    const sealed = await sealFile(kp, PDF, ctx);
    expect(isSealedFile(sealed)).toBe(true);
    expect(sealed.includes(PDF)).toBe(false);
    expect(sealedFileContext(sealed)).toEqual(ctx);
    expect((await openFile(kp, sealed, ctx)).equals(PDF)).toBe(true);
  });

  it('cannot be opened as another person’s or another field’s file, or after tampering', async () => {
    const sealed = await sealFile(kp, PDF, ctx);
    await expect(openFile(kp, sealed, { ...ctx, subject: 'e-2' })).rejects.toThrow();
    await expect(openFile(kp, sealed, { ...ctx, field: 'document:d-2' })).rejects.toThrow();
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1]! ^= 1;
    await expect(openFile(kp, tampered, ctx)).rejects.toThrow();
    await expect(openFile(new LocalKeyProvider('55'.repeat(32)), sealed, ctx)).rejects.toThrow();
    expect(isSealedFile(PDF)).toBe(false);
  });
});

describe('expiry status', () => {
  it('is expired after the date, expiring inside the window, otherwise nothing', () => {
    expect(expiryStatus('2026-10-01', '2026-10-24', 30)).toBe('expired');
    expect(expiryStatus('2026-10-24', '2026-10-24', 30)).toBe('expiring');
    expect(expiryStatus('2026-11-23', '2026-10-24', 30)).toBe('expiring');
    expect(expiryStatus('2026-11-24', '2026-10-24', 30)).toBeNull();
    expect(expiryStatus(null, '2026-10-24', 30)).toBeNull();
  });
});

const statement = (over: Partial<PayslipStatement> = {}): PayslipStatement => ({
  employeeNumber: 'FX-1',
  currency: 'GBP',
  employer: { name: 'Fictional Employer Ltd' },
  employee: { name: 'Ada Fictional', taxCode: 'SAMPLE', nationalId: 'QQ 12 34 56 C' },
  period: { start: '2026-09-01', end: '2026-09-30', payDate: '2026-09-28', frequency: 'monthly' },
  payment: { method: 'bank_transfer', account: '12345678' },
  payments: [
    { kind: 'basic', label: 'Basic salary', amountMinor: 250_000 },
    { kind: 'overtime', label: 'Overtime', quantity: '6.50', rateMinor: 2_000, amountMinor: 13_000 },
  ],
  deductions: [
    { kind: 'income_tax', label: 'Income tax', amountMinor: 30_000 },
    { kind: 'social_security', label: 'Social security', amountMinor: 12_000 },
  ],
  employerContributions: [{ kind: 'pension', label: 'Employer pension', amountMinor: 7_500 }],
  totals: { grossMinor: 263_000, deductionsMinor: 42_000, netMinor: 221_000 },
  ...over,
});

describe('payslip statement totals (the provider’s lines must add up; nothing is calculated)', () => {
  it('accepts a statement whose payments, deductions and net agree with its totals', () => {
    expect(checkStatement(statement())).toEqual([]);
  });

  it('refuses one whose lines do not sum to its totals, or whose net is not gross less deductions', () => {
    expect(
      checkStatement(
        statement({ totals: { grossMinor: 263_001, deductionsMinor: 42_000, netMinor: 221_001 } }),
      ),
    ).toEqual(['paymentsDoNotAddUp']);
    expect(
      checkStatement(
        statement({ totals: { grossMinor: 263_000, deductionsMinor: 41_000, netMinor: 222_000 } }),
      ),
    ).toEqual(['deductionsDoNotAddUp']);
    expect(
      checkStatement(
        statement({ totals: { grossMinor: 263_000, deductionsMinor: 42_000, netMinor: 221_100 } }),
      ),
    ).toEqual(['netDoesNotAddUp']);
  });

  it('employer contributions are shown but are not part of net pay', () => {
    expect(
      checkStatement(
        statement({
          employerContributions: [{ kind: 'pension', label: 'Employer pension', amountMinor: 999_999 }],
        }),
      ),
    ).toEqual([]);
  });

  it('refuses a malformed statement: fractional minor units, an unknown line kind, extra fields, bad dates', () => {
    expect(
      checkStatement(statement({ payments: [{ kind: 'basic', label: 'Basic', amountMinor: 2500.5 }] })),
    ).toEqual(['invalidStatement']);
    expect(
      checkStatement({ ...statement(), payments: [{ kind: 'tips', label: 'x', amountMinor: 1 }] }),
    ).toEqual(['invalidStatement']);
    expect(checkStatement({ ...statement(), computedByUs: true })).toEqual(['invalidStatement']);
    expect(
      checkStatement(
        statement({
          period: { start: '2026-09-30', end: '2026-09-01', payDate: '2026-09-28', frequency: 'monthly' },
        }),
      ),
    ).toEqual(['periodInvalid']);
    expect(
      checkStatement(
        statement({
          period: { start: '2026-02-30', end: '2026-03-01', payDate: '2026-03-01', frequency: 'monthly' },
        }),
      ),
    ).toEqual(['periodInvalid']);
  });

  it('keeps only a masked national identifier and the last digits of the account', () => {
    const s = storedStatement(statement());
    expect(s.employee.nationalId).toBe('•••• 456C');
    expect(s.payment.account).toBe('•••• 5678');
    expect(maskNationalId('000-00-1042')).toBe('•••• 1042');
    expect(JSON.stringify(s)).not.toContain('123456');
  });
});

describe('the sample payroll provider fixture (staging)', () => {
  it('takes every deduction from its bands as written, flags each statement illustrative, and adds up', () => {
    for (const [currency, bands] of Object.entries(BANDS) as Array<
      ['GBP' | 'EUR' | 'USD', (typeof BANDS)['GBP']]
    >) {
      expect(bands.at(-1)!.upToGrossMinor).toBeNull();
      for (const gross of [90_000, 199_999, 310_000, 1_200_000]) {
        const s = sampleStatement({
          employeeNumber: 'FX-2',
          employeeName: 'Bo Fictional',
          employeeAddress: [],
          department: 'Operations',
          jobTitle: 'Operative',
          employer: { name: 'Fictional Ltd', address: [], taxReference: 'SAMPLE' },
          currency,
          period: { start: '2026-09-01', end: '2026-09-30', payDate: '2026-09-28', frequency: 'monthly' },
          payments: [{ kind: 'basic', label: 'Basic', amountMinor: gross }],
          studentLoan: true,
          nationalId: 'SAMPLE0001',
          taxCode: null,
          accountNumber: '00000000',
        });
        expect(checkStatement(s)).toEqual([]);
        expect(s.illustrative).toBe(true);
        expect(s.notes).toEqual([SAMPLE_NOTE]);
        const band = bands.find((b) => b.upToGrossMinor === null || gross <= b.upToGrossMinor)!;
        // the deductions are the band's figures, unchanged (not derived from the gross)
        for (const d of band.deductions) expect(s.deductions).toContainEqual(d);
      }
    }
  });

  it('year-to-date figures are the sums of the provider’s own earlier figures in the tax year', () => {
    const a = sampleStatement({
      employeeNumber: 'FX-3',
      employeeName: 'Cy Fictional',
      employeeAddress: [],
      department: 'Operations',
      jobTitle: 'Operative',
      employer: { name: 'Fictional Ltd', address: [], taxReference: 'SAMPLE' },
      currency: 'GBP',
      period: { start: '2026-08-01', end: '2026-08-31', payDate: '2026-08-28', frequency: 'monthly' },
      payments: [{ kind: 'basic', label: 'Basic', amountMinor: 200_000 }],
      studentLoan: false,
      nationalId: 'SAMPLE0002',
      taxCode: null,
      accountNumber: '00000000',
    });
    const b = withYearToDate([a], {
      ...a,
      period: { ...a.period, start: '2026-09-01', end: '2026-09-30', payDate: '2026-09-28' },
    });
    expect(b.ytd!.find((y) => y.key === 'gross')!.amountMinor).toBe(400_000);
    expect(b.ytd!.find((y) => y.key === 'net')!.amountMinor).toBe(2 * a.totals.netMinor);
  });
});

describe('locale month placeholders in stored messages', () => {
  it('formats {name:month} in the reader’s locale and leaves other placeholders alone', () => {
    expect(interpolate('Your payslip for {period:month} is ready', { period: '2026-08-01' }, 'en-GB')).toBe(
      'Your payslip for August 2026 is ready',
    );
    expect(interpolate('{period:month}', { period: '2026-08-01' }, 'en-US')).toBe('August 2026');
    expect(interpolate('{label} and {missing}', { label: 'x' })).toBe('x and {missing}');
    expect(formatMessage({ k: 'Paid {period:month}' }, 'k', { period: '2026-12-31' }, 'en-GB')).toBe(
      'Paid December 2026',
    );
  });
});
