import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  contentDisposition,
  crossSiteRefusal,
  sessionCookie,
  trustedOrigins,
  withCharset,
} from '../src/http/security';
import { checkZipBounds, declaredEntryCount, InflateBudget, openZip } from '../src/lib/archive';
import { COMMON_PASSWORD_COUNT, contextWords, passwordProblems } from '../src/modules/auth/password-policy';
import { expandUploads, MAX_ARCHIVE_ENTRIES, MAX_FILE_BYTES } from '../src/modules/payslips/matching';
import { mfaGate, type AuthContext } from '../src/modules/auth/sessions';
import { WEAK_XMLDSIG } from '../src/modules/auth/sso';

const zip = async (files: Record<string, Buffer | string>) => {
  const z = new JSZip();
  for (const [name, body] of Object.entries(files)) z.file(name, body);
  return Buffer.from(await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
};
const pdf = (n = 100) => Buffer.concat([Buffer.from('%PDF-1.4 fictional\n'), Buffer.alloc(n, 0x20)]);

describe('V3.3 and V3.5 browser hardening helpers', () => {
  it('names the session cookie __Host-thr_sid only behind HTTPS', () => {
    expect(sessionCookie({ apiBaseUrl: 'https://api.uk.thapsus-hr.test' })).toEqual({
      name: '__Host-thr_sid',
      secure: true,
      path: '/',
    });
    expect(sessionCookie({ apiBaseUrl: 'http://127.0.0.1:4000' })).toEqual({
      name: 'thr_sid',
      secure: false,
      path: '/',
    });
  });

  it('refuses unsafe requests from untrusted origins and cross-site fetch metadata; lets safe methods, the app and header-authenticated clients through', () => {
    const trusted = trustedOrigins({
      appBaseUrl: 'https://app.uk.thapsus-hr.test/',
      apiBaseUrl: 'https://api.uk.thapsus-hr.test',
      globalBaseUrl: 'https://www.thapsus-hr.test',
    });
    const r = (method: string, headers: Record<string, string>) =>
      crossSiteRefusal({ method, headers }, trusted);
    expect(r('POST', { origin: 'https://evil.example.test', cookie: 'x=1' })).toBe('untrustedOrigin');
    expect(r('DELETE', { origin: 'null' })).toBe('untrustedOrigin');
    expect(r('PUT', { 'sec-fetch-site': 'cross-site', cookie: 'x=1' })).toBe('crossSite');
    expect(r('PATCH', { 'sec-fetch-site': 'same-site' })).toBe('crossSite');
    expect(
      r('POST', { origin: 'https://app.uk.thapsus-hr.test', 'sec-fetch-site': 'same-origin' }),
    ).toBeUndefined();
    expect(
      r('POST', { origin: 'https://www.thapsus-hr.test', 'sec-fetch-site': 'same-site' }),
    ).toBeUndefined();
    expect(r('GET', { origin: 'https://evil.example.test' })).toBeUndefined();
    expect(r('POST', {})).toBeUndefined();
    expect(
      r('POST', { authorization: 'Bearer thr_sk_fictional', origin: 'https://integrator.example.test' }),
    ).toBeUndefined();
    // a bearer header does not excuse a request that also carries the browser's cookies
    expect(
      r('POST', { authorization: 'Bearer x', cookie: 'thr_sid=1', origin: 'https://evil.example.test' }),
    ).toBe('untrustedOrigin');
  });
});

describe('V4.1.1 charset', () => {
  it('adds charset=utf-8 to text and XML types, leaves JSON, binary and explicit charsets alone', () => {
    expect(withCharset('text/html')).toBe('text/html; charset=utf-8');
    expect(withCharset('text/csv; header=present')).toBe('text/csv; header=present; charset=utf-8');
    expect(withCharset('application/samlmetadata+xml')).toBe('application/samlmetadata+xml; charset=utf-8');
    expect(withCharset('text/calendar; charset=utf-8')).toBe('text/calendar; charset=utf-8');
    expect(withCharset('application/json; charset=utf-8')).toBe('application/json; charset=utf-8');
    expect(withCharset('application/problem+json')).toBe('application/problem+json');
    expect(withCharset('application/pdf')).toBe('application/pdf');
  });
});

describe('V5.4.1 and V5.4.2 download file names', () => {
  it('keeps plain ASCII names, and never lets a name break out of the header', () => {
    expect(contentDisposition('payslip-2026-03.pdf')).toBe('attachment; filename="payslip-2026-03.pdf"');
    expect(contentDisposition('evil".pdf\r\nSet-Cookie: x=1')).toBe(
      'attachment; filename="evil_.pdf__Set-Cookie: x=1"',
    );
    expect(contentDisposition('../../etc/passwd')).toBe('attachment; filename="_.._etc_passwd"');
    expect(contentDisposition('a;b\\c.txt')).toBe('attachment; filename="a_b_c.txt"');
    expect(contentDisposition('', 'inline')).toBe('inline; filename="download"');
  });

  it('sends non-ASCII names as RFC 8187 filename* with an ASCII fallback', () => {
    expect(contentDisposition('Fiche de paie – Zoë.pdf')).toBe(
      `attachment; filename="Fiche de paie _ Zo_.pdf"; filename*=UTF-8''Fiche%20de%20paie%20%E2%80%93%20Zo%C3%AB.pdf`,
    );
  });
});

describe('V5.2.3 zip archives', () => {
  it('reads the entry count from the end-of-central-directory record before anything is inflated', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 25; i++) files[`f${i}.txt`] = 'x';
    const buf = await zip(files);
    expect(declaredEntryCount(buf)).toBe(25);
    expect(declaredEntryCount(Buffer.from('PK\u0003\u0004 not really a zip'))).toBeUndefined();
    expect(await openZip(buf, { maxEntries: 24, maxEntryBytes: 10, maxTotalBytes: 10 })).toBe(
      'tooManyEntries',
    );
  });

  it('stops inflating at the per-entry limit even when the archive declares a tiny size', async () => {
    const buf = await zip({ 'bomb.pdf': Buffer.concat([pdf(), Buffer.alloc(5 * 1024 * 1024)]) });
    // patch the declared uncompressed size in the local and central headers to 10 bytes
    const lying = Buffer.from(buf);
    lying.writeUInt32LE(10, 22);
    const central = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    lying.writeUInt32LE(10, central + 24);
    const opened = await openZip(lying, {
      maxEntries: 10,
      maxEntryBytes: 1024 * 1024,
      maxTotalBytes: 100 * 1024 * 1024,
    });
    if (typeof opened === 'string') throw new Error(opened);
    expect(await opened.inflate(opened.entries[0]!)).toBe('tooLarge');
  });

  it('shares one inflation budget across entries and archives', async () => {
    const a = await zip({ 'a.bin': Buffer.alloc(600_000), 'b.bin': Buffer.alloc(600_000) });
    const budget = new InflateBudget(1_000_000);
    const opened = await openZip(
      a,
      { maxEntries: 10, maxEntryBytes: 700_000, maxTotalBytes: 1_000_000 },
      budget,
    );
    if (typeof opened === 'string') throw new Error(opened);
    expect(Buffer.isBuffer(await opened.inflate(opened.entries[0]!))).toBe(true);
    expect(await opened.inflate(opened.entries[1]!)).toBe('tooLarge');
    expect(
      await checkZipBounds(a, { maxEntries: 10, maxEntryBytes: 700_000, maxTotalBytes: 1_000_000 }),
    ).toBe('tooLarge');
    expect(
      await checkZipBounds(a, { maxEntries: 10, maxEntryBytes: 700_000, maxTotalBytes: 2_000_000 }),
    ).toBeUndefined();
  });

  it('payslip uploads refuse archives listing too many entries, and oversized entries, without failing the rest', async () => {
    const many: Record<string, Buffer> = {};
    for (let i = 0; i <= MAX_ARCHIVE_ENTRIES; i++) many[`E${i}.pdf`] = pdf(1);
    const tooMany = await expandUploads([{ name: 'many.zip', body: await zip(many) }]);
    expect(tooMany).toEqual({ accepted: [], rejected: [{ name: 'many.zip', reason: 'tooMany' }] });
    const mixed = await expandUploads([
      {
        name: 'mixed.zip',
        body: await zip({ 'E1.pdf': pdf(), 'E2.pdf': Buffer.concat([pdf(), Buffer.alloc(MAX_FILE_BYTES)]) }),
      },
    ]);
    expect(mixed.accepted.map((f) => f.name)).toEqual(['E1.pdf']);
    expect(mixed.rejected).toEqual([{ name: 'E2.pdf', reason: 'tooLarge' }]);
  });
});

describe('V6.2 password policy', () => {
  it('bundles at least the top 3,000 common passwords of the allowed length (offline)', () => {
    expect(COMMON_PASSWORD_COUNT).toBeGreaterThanOrEqual(10_000);
    expect(passwordProblems('qwertyuiopasdfgh')).toEqual(['tooCommon']);
    expect(passwordProblems('QWERTYUIOPASDFGH')).toEqual(['tooCommon']);
    expect(passwordProblems('password1234')).toEqual(['tooCommon']);
  });

  it('permits any composition and length from 12 to 128 characters, counting characters not bytes', () => {
    expect(passwordProblems('correct horse battery staple')).toEqual([]);
    expect(passwordProblems('ééééééééééé')).toEqual(['tooShort']);
    expect(passwordProblems('😀'.repeat(64))).toEqual([]);
    expect(passwordProblems('a'.repeat(64) + 'b'.repeat(64))).toEqual([]);
    expect(passwordProblems('x'.repeat(129))).toEqual(['tooLong']);
    expect(passwordProblems('            ')).toEqual([]);
  });

  it('refuses context-specific words: product, company, workspace, the person’s name and email', () => {
    const ctx = {
      companyName: 'Fictional Bramble & Co Ltd',
      workspaceSlug: 'bramble-co',
      email: 'olive.owner@bramble.example.test',
      displayName: 'Olive Owner',
    };
    expect(contextWords(ctx)).toEqual(
      expect.arrayContaining(['thapsus', 'fictional', 'bramble', 'brambleco', 'olive', 'owner']),
    );
    expect(contextWords(ctx)).not.toContain('example');
    for (const pw of [
      'Thapsus-HR-is-great',
      'my bramble passphrase',
      'BrambleCo!2026-spring',
      'olive-loves-tea-9',
      'Ôwner-of-the-garden',
    ])
      expect(passwordProblems(pw, ctx), pw).toContain('contextSpecific');
    expect(passwordProblems('a quiet river at dawn', ctx)).toEqual([]);
  });
});

describe('V6.3.3 and V6.4.3 second-factor gate', () => {
  const auth = (over: Partial<AuthContext>, admin = false) =>
    ({
      mfaVerified: false,
      hasMfaFactor: false,
      principal: {
        userId: 'u',
        employeeId: null,
        kind: 'user',
        delegatedFromEmployeeIds: [],
        grants: [{ roleKey: 'r', isAdmin: admin, permissions: [], fieldAccess: {}, scope: { type: 'all' } }],
      },
      ...over,
    }) as AuthContext;
  it('anyone with a factor must use it; admins must enrol one; others without a factor pass', () => {
    expect(mfaGate(auth({ hasMfaFactor: true }))).toBe('mfaRequired');
    expect(mfaGate(auth({ hasMfaFactor: true }, true))).toBe('mfaRequired');
    expect(mfaGate(auth({}, true))).toBe('mfaEnrollmentRequired');
    expect(mfaGate(auth({}))).toBe('ok');
    expect(mfaGate(auth({ hasMfaFactor: true, mfaVerified: true }))).toBe('ok');
  });
});

describe('V11.4.1 SAML algorithms', () => {
  it('flags SHA-1 and MD5 signature or digest algorithms, accepts SHA-2', () => {
    for (const weak of [
      'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
      'http://www.w3.org/2000/09/xmldsig#sha1',
      'http://www.w3.org/2001/04/xmldsig-more#rsa-md5',
    ])
      expect(WEAK_XMLDSIG.test(`<ds:SignatureMethod Algorithm="${weak}"/>`), weak).toBe(true);
    for (const strong of [
      'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      'http://www.w3.org/2001/04/xmlenc#sha256',
      'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha384',
    ])
      expect(WEAK_XMLDSIG.test(`<ds:DigestMethod Algorithm="${strong}"/>`), strong).toBe(false);
  });
});
