import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { parseMarkup } from '@thapsus/core/documents';
import {
  addSignaturePage,
  placedFieldRects,
  renderTemplatePdf,
  renderTextPdf,
  stampSignature,
} from '../src/modules/documents/pdf';
import { blockLabels, partiesFor, stageOf, workingKey } from '../src/modules/documents/signing';
import { signatureFont } from '../src/modules/documents/signature-font';
import { pdfPageTexts } from './pdf-text';

/** Template PDFs, signature blocks and stamping (ADR-0197), and the signing order (ADR-0196). Fictional data only. */
const labels = blockLabels('en-GB');

describe('template PDFs', () => {
  it('has the company name, title, headings, page numbers on every page and a block per signing party', async () => {
    const body = `# Terms\n\n${Array.from({ length: 70 }, (_, i) => `- Fictional clause ${i + 1}`).join('\n')}`;
    const { bytes, fields } = await renderTemplatePdf({
      title: 'Fictional statement',
      company: 'Example Trading Ltd',
      blocks: parseMarkup(body),
      parties: ['employee', 'company'],
      labels,
    });
    const pages = await pdfPageTexts(bytes);
    expect(pages.length).toBeGreaterThan(1);
    pages.forEach((p, i) => {
      expect(p).toContain(`Page ${i + 1} of ${pages.length}`);
      expect(p).toContain('Example Trading Ltd');
    });
    expect(pages[0]).toContain('Fictional statement');
    expect(pages.at(-1)).toContain('Signatures');
    expect(new Set(fields.map((f) => `${f.party}:${f.kind}`))).toEqual(
      new Set([
        'employee:signature',
        'employee:name',
        'employee:date',
        'employee:reference',
        'company:signature',
        'company:name',
        'company:onBehalf',
        'company:date',
        'company:reference',
      ]),
    );
    expect(fields.every((f) => f.page === pages.length - 1)).toBe(true);
  });

  it('puts whoever signs first on the left', () => {
    expect(partiesFor({ employeeSigns: true, companySigns: true, order: 'employee_first' })).toEqual([
      'employee',
      'company',
    ]);
    expect(partiesFor({ employeeSigns: true, companySigns: true, order: 'company_first' })).toEqual([
      'company',
      'employee',
    ]);
    expect(partiesFor({ employeeSigns: false, companySigns: true, order: 'any' })).toEqual(['company']);
  });
});

describe('stamping signatures', () => {
  it('stamps the typed name in the bundled OFL handwriting font, with the printed name, date and reference', async () => {
    const r = await renderTemplatePdf({
      title: 'Fictional letter',
      company: 'Example Ltd',
      blocks: parseMarkup('Hello.'),
      parties: ['employee', 'company'],
      labels,
    });
    const once = await stampSignature(r.bytes, r.fields, 'employee', {
      method: 'typed',
      name: 'Zoë Example',
      date: '24 October 2026',
      reference: 'Ref. 0000',
    });
    const twice = await stampSignature(once, r.fields, 'company', {
      method: 'typed',
      name: 'Sam Sample',
      onBehalf: 'For and on behalf of Example Ltd',
      date: '25 October 2026',
      reference: 'Ref. 0000',
    });
    const text = (await pdfPageTexts(twice))[0]!;
    for (const v of [
      'Zoë Example',
      'Sam Sample',
      'For and on behalf of Example Ltd',
      '24 October 2026',
      'Ref. 0000',
    ])
      expect(text, v).toContain(v);
    expect(Buffer.from(twice).toString('latin1')).toMatch(/AlexBrush/);
    // the employee's stamp leaves the company's block empty until the company signs
    expect((await pdfPageTexts(once))[0]).not.toContain('Sam Sample');
  });

  it('falls back to an oblique standard font for names the handwriting font cannot draw', async () => {
    const r = await renderTemplatePdf({
      title: 'Fictional letter',
      company: '',
      blocks: parseMarkup('Hello.'),
      parties: ['employee'],
      labels,
    });
    const out = await stampSignature(r.bytes, r.fields, 'employee', {
      method: 'typed',
      name: 'Ελένη Παράδειγμα',
      date: '1 May 2026',
      reference: 'Ref. 1',
    });
    expect(Buffer.from(out).toString('latin1')).toMatch(/Helvetica-Oblique/);
  });

  it('adds a signature page to an uploaded PDF, or places boxes where HR put them', async () => {
    const upload = await renderTextPdf('Fictional upload', 'Text.');
    const added = await addSignaturePage(upload, {
      title: 'Fictional upload',
      parties: ['employee'],
      labels,
    });
    expect((await PDFDocument.load(added.bytes)).getPageCount()).toBe(2);
    expect(added.fields.every((f) => f.page === 1)).toBe(true);
    const placed = await placedFieldRects(upload, [
      { party: 'employee', kind: 'signature', page: 1, position: 'bottom_right' },
      { party: 'company', kind: 'date', page: 1, position: 'top_left' },
    ]);
    expect(placed.map((f) => f.kind)).toEqual(['signature', 'caption', 'date']);
    expect(placed[0]!.x).toBeGreaterThan(300);
    expect(placed[2]!.y).toBeGreaterThan(700);
    await expect(
      placedFieldRects(upload, [{ party: 'employee', kind: 'signature', page: 2, position: 'top_left' }]),
    ).rejects.toThrow(RangeError);
  });

  it('bundles the font with its open font licence (never an Apple font)', () => {
    const dir = join(__dirname, '..', '..', '..', 'assets', 'fonts', 'alex-brush');
    expect(readFileSync(join(dir, 'OFL.txt'), 'utf8')).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(signatureFont().length).toBeGreaterThan(50_000);
    expect(Buffer.from(signatureFont()).toString('latin1')).not.toMatch(/SF Pro|Apple Inc/);
  });
});

describe('whose turn it is', () => {
  const base = {
    status: 'pending',
    completed_at: null,
    requires_employee_signature: true,
    requires_countersign: true,
    approval_status: null as string | null,
  };
  it('follows the signing order', () => {
    expect(stageOf({ ...base, signing_order: 'employee_first' })).toBe('employee');
    expect(stageOf({ ...base, signing_order: 'company_first', approval_status: 'pending' })).toBe('company');
    expect(stageOf({ ...base, signing_order: 'company_first', approval_status: 'approved' })).toBe(
      'employee',
    );
    expect(stageOf({ ...base, signing_order: 'any', approval_status: 'pending' })).toBe('both');
    expect(stageOf({ ...base, signing_order: 'any', status: 'signed', approval_status: 'pending' })).toBe(
      'company',
    );
    expect(stageOf({ ...base, signing_order: 'any', status: 'cancelled' })).toBe('voided');
    expect(stageOf({ ...base, signing_order: 'any', completed_at: '2026-01-01' as unknown as null })).toBe(
      'completed',
    );
  });
  it('signs into the latest version', () => {
    const sr = {
      status: 'pending',
      employee_signed_file_key: null,
      signed_file_key: null,
      company_signed_file_key: null,
      approval_status: null,
      original_file_key: 'sent.pdf',
      file_key: 'upload.pdf',
    };
    expect(workingKey(sr, 'employee')).toBe('sent.pdf');
    expect(
      workingKey({ ...sr, approval_status: 'approved', company_signed_file_key: 'company.pdf' }, 'employee'),
    ).toBe('company.pdf');
    expect(workingKey({ ...sr, status: 'signed', employee_signed_file_key: 'employee.pdf' }, 'company')).toBe(
      'employee.pdf',
    );
    expect(workingKey({ ...sr, original_file_key: null }, 'company')).toBe('upload.pdf');
  });
});
