import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { unzipSync, strFromU8 } from 'fflate';
import { tenantTablesInOrder, withTenant } from '@thapsus/db';
import { ownerUrl, TEST_DBS } from '@thapsus/db/testing';
import { closeDb, PASSWORD, startTestApp, type TestContext } from './helpers';
import { privacyCompany, type PrivacyCompany } from './privacy-fixtures';
import { DIRECTORY_FIELDS } from '../src/lib/directory';
import type { MemoryObjectStore } from '../src/lib/object-store';
import type { MemoryRateLimiter } from '../src/lib/rate-limit';
import type { MemoryMailer } from '../src/lib/mailer';

let ctx: TestContext;
let c: PrivacyCompany;
let other: PrivacyCompany;
let owner: pg.Client;

beforeAll(async () => {
  ctx = await startTestApp({ listen: false });
  c = await privacyCompany(ctx);
  other = await privacyCompany(ctx);
  owner = new pg.Client({ connectionString: ownerUrl(TEST_DBS.shared) });
  await owner.connect();
});
afterAll(async () => {
  await owner.end();
  await ctx.close();
  await closeDb();
});

const store = () => ctx.deps.objects as MemoryObjectStore;

async function seed(co: PrivacyCompany) {
  const emp = await co.hire('london');
  await co.loginAs(emp, 'employee');
  await co.putSensitive(emp, 'immigration', 'share_code', 'FICTIONAL-SHARE-CODE');
  const key = `${co.owner.tenantId}/documents/${crypto.randomUUID()}.pdf`;
  await store().put(key, Buffer.from('%PDF-1.7 fictional document'), 'application/pdf');
  await co.tx((t) => t.exec(`INSERT INTO app.documents (tenant_id, employee_id, title, category, file_key, file_name, content_type, size_bytes, status) VALUES (app.current_tenant(), $1, 'Fictional letter', 'letter', $2, 'l.pdf', 'application/pdf', 27, 'ready')`, [emp, key]));
  return { emp, key };
}

describe('company data export', () => {
  it('exports every tenant table, decrypted sensitive data and stored files as a zip with a manifest', async () => {
    const { key } = await seed(c);
    const res = await c.api('POST', '/v1/privacy/company-exports');
    expect(res.statusCode, res.body).toBe(202);
    const exportId = res.json().id;
    await c.runQueued('privacy.company_export');
    const list = (await c.api('GET', '/v1/privacy/company-exports')).json();
    const x = list.find((e: { id: string }) => e.id === exportId);
    expect(x).toMatchObject({ status: 'ready', files: 1 });
    expect(x.progressDone).toBe(x.progressTotal);
    const dl = (await c.api('GET', `/v1/privacy/company-exports/${exportId}/download`)).json();
    const zipKey = decodeURIComponent(dl.url.replace('memory://get/', ''));
    expect(zipKey).toBe(`${c.owner.tenantId}/exports/${exportId}.zip`);
    const files = unzipSync(new Uint8Array(store().objects.get(zipKey)!.body));
    const manifest = JSON.parse(strFromU8(files['manifest.json']!));
    const tables = await withTenant(ctx.deps.router, c.owner.tenantId, (t) => tenantTablesInOrder(t.client));
    expect(manifest.tables.map((m: { table: string }) => m.table).sort()).toEqual([...tables].sort());
    const users = strFromU8(files['tables/app.users.csv']!);
    expect(users).toContain(c.owner.email);
    expect(Object.keys(files)).toContain('tables/app.password_credentials.csv');
    expect(strFromU8(files['tables/app.password_credentials.csv']!)).not.toMatch(/argon2|password_hash/);
    expect(strFromU8(files['sensitive/vault-records.jsonl']!)).toContain('FICTIONAL-SHARE-CODE');
    expect(strFromU8(files['tables/vault.records.csv']!)).not.toContain('"envelope"');
    expect(strFromU8(files[`files/${key.slice(c.owner.tenantId.length + 1)}`]!)).toBe('%PDF-1.7 fictional document');
    expect(strFromU8(files['files/manifest.csv']!)).toContain(key);
    // The export never contains another tenant's data.
    expect(JSON.stringify(Object.keys(files))).not.toContain(other.owner.tenantId);
    const audited = await c.tx((t) => t.query(`SELECT 1 FROM audit.events WHERE action = 'vault.read' AND diff->>'purpose' = 'company_export'`));
    expect(audited.length).toBeGreaterThanOrEqual(1);
  });
});

describe('account closure', () => {
  it('requires typing the workspace name, can be cancelled, and is owner-only', async () => {
    expect((await c.api('POST', '/v1/privacy/closure', { confirmWorkspace: 'not-it' })).statusCode).toBe(422);
    const s = await c.api('POST', '/v1/privacy/closure', { confirmWorkspace: c.owner.slug, reason: 'Fictional test' });
    expect(s.statusCode, s.body).toBe(201);
    expect(s.json().closure).toMatchObject({ status: 'scheduled', graceDays: 30 });
    expect(ctx.directory.entries.get(c.owner.tenantId)!.status).toBe('closing');
    expect((await c.api('POST', '/v1/privacy/closure', { confirmWorkspace: c.owner.slug })).statusCode).toBe(409);
    expect((await c.api('POST', '/v1/privacy/closure/cancel')).json().closure.status).toBe('cancelled');
    expect(ctx.directory.entries.get(c.owner.tenantId)!.status).toBe('active');
    const hr = await c.loginAs(null, 'hr_admin');
    const { enrolTotp } = await import('./helpers');
    await enrolTotp(ctx, hr.cookie);
    expect((await c.api('GET', '/v1/privacy/closure', undefined, hr.cookie)).statusCode).toBe(403);
  });

  it('after the grace period deletes the tenant everywhere, verifies it and issues a certificate', async () => {
    const theirs = await seed(other);
    const mine = await seed(c);
    // A lockout counter keyed by workspace and email (Valkey in AWS, in-memory here).
    await ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: c.owner.slug, email: c.owner.email, password: 'wrong-password-123' }, remoteAddress: '10.99.1.1' });
    const limiter = ctx.deps.limiter as MemoryRateLimiter;
    expect(limiter.keys().some((k) => k.includes(c.owner.slug))).toBe(true);

    const s = (await c.api('POST', '/v1/privacy/closure', { confirmWorkspace: c.owner.slug })).json();
    const closureId = s.closure.id;
    const saved = ctx.clock.now;
    try {
      expect(await c.runJob('privacy.closure_purge', { closureId })).toEqual({ skipped: 'grace period not over' });
      ctx.clock.now = new Date(Date.parse(s.closure.purgeAfter) + 60_000);
      const result = await c.runJob('privacy.closure_purge', { closureId });
      expect(result).toMatchObject({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    } finally {
      ctx.clock.now = saved;
    }

    // Database: no row for the tenant in any tenant table (checked as the owner, bypassing RLS).
    const { rows: tables } = await owner.query<{ t: string }>(`SELECT format('%I.%I', n.nspname, c.relname) AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname IN ('app', 'vault', 'audit') AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id')`);
    for (const { t } of tables) {
      const n = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [c.owner.tenantId]);
      expect(n.rows[0]!.n, t).toBe(0);
    }
    // Files and caches.
    expect([...store().objects.keys()].filter((k) => k.startsWith(`${c.owner.tenantId}/`))).toEqual([]);
    expect(store().objects.has(mine.key)).toBe(false);
    expect(limiter.keys().some((k) => k.includes(c.owner.slug))).toBe(false);
    // Registry, directory and certificate.
    const reg = await owner.query(`SELECT status FROM registry.tenants WHERE tenant_id = $1`, [c.owner.tenantId]);
    expect(reg.rows[0].status).toBe('deleted');
    const cert = await owner.query<{ certificate: Record<string, unknown>; certificate_sha256: string }>(`SELECT certificate, certificate_sha256 FROM registry.deletion_certificates WHERE tenant_id = $1`, [c.owner.tenantId]);
    expect(cert.rows[0]!.certificate).toMatchObject({ tenantId: c.owner.tenantId, homeRegion: 'uk', awsRegion: 'eu-west-2', database: { verifiedEmpty: true }, files: { verifiedEmpty: true }, caches: { verifiedEmpty: true }, backups: { retentionDays: 7 } });
    const entry = ctx.directory.entries.get(c.owner.tenantId)!;
    expect(entry.status).toBe('deleted');
    expect(Object.keys(entry).every((k) => (DIRECTORY_FIELDS as readonly string[]).includes(k))).toBe(true);
    expect(JSON.stringify(entry)).not.toContain('@');
    expect(JSON.stringify(cert.rows[0]!.certificate)).not.toContain('@');
    // The requester received the certificate from the home region.
    const mail = (ctx.mailer as MemoryMailer).sent.find((m) => m.to === c.owner.email && m.subject.includes(c.owner.slug));
    expect(mail?.text).toContain(cert.rows[0]!.certificate_sha256);
    // Signing in is no longer possible; the other tenant is untouched.
    const login = await ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: c.owner.slug, email: c.owner.email, password: PASSWORD }, remoteAddress: '10.99.1.2' });
    expect(login.statusCode).toBeGreaterThanOrEqual(400);
    expect(store().objects.has(theirs.key)).toBe(true);
    const theirRows = await other.tx((t) => t.one<{ n: number }>(`SELECT count(*)::int AS n FROM app.employees`));
    expect(theirRows.n).toBeGreaterThan(0);
  });
});
