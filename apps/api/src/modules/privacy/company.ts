import { createHash } from 'node:crypto';
import { Zip, ZipDeflate } from 'fflate';
import { REGIONS, type HomeRegion } from '@thapsus/core';
import { isLocale, t } from '@thapsus/core/i18n';
import { LEGAL } from '@thapsus/core/trust';
import { addMinutes, compareInstants } from '@thapsus/core/time';
import { tenantTablesInOrder, withRegistry, withTenant, writeAudit, type JobContext, type Tx } from '@thapsus/db';
import type { Deps } from '../../deps';
import { open, type Envelope } from '../../lib/kms';
import { SECRET_COLUMN } from './subject-map';

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : Buffer.isBuffer(v) ? v.toString('hex') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Neutralise spreadsheet formula injection, then quote.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

/** Columns never exported, even to the customer: credential hashes, tokens and wrapped keys. */
const omitColumn = (table: string, column: string) => column === 'tenant_id' || column === 'search' || (table !== 'audit.events' && SECRET_COLUMN.test(column));

class ZipCollector {
  private chunks: Uint8Array[] = [];
  private done!: Promise<void>;
  readonly zip: Zip;
  constructor() {
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    this.done = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.zip = new Zip((err, chunk, final) => {
      if (err) return reject(err);
      this.chunks.push(chunk);
      if (final) resolve();
    });
  }
  add(name: string, data: Uint8Array) {
    const f = new ZipDeflate(name, { level: 6 });
    this.zip.add(f);
    f.push(data, true);
  }
  async finish(): Promise<Buffer> {
    this.zip.end();
    await this.done;
    return Buffer.concat(this.chunks);
  }
}

export interface ExportManifest {
  format: 'thapsus-hr.company-export';
  formatVersion: 1;
  tenantId: string;
  homeRegion: HomeRegion;
  generatedAt: string;
  tables: Array<{ table: string; file: string; rows: number; columns: string[]; omittedColumns: string[]; sha256: string }>;
  sensitive: { file: string; records: number; byCategory: Record<string, number> };
  files: { manifest: string; count: number; bytes: number };
  notes: string[];
}

/**
 * Full company export: every tenant table (enumerated from the catalog, as the tenant-move tool does)
 * as CSV, sensitive vault values decrypted (audited per category), every stored file under the
 * tenant's object prefix, and a manifest with row counts and SHA-256 per file.
 */
export async function buildCompanyExport(ctx: JobContext<Deps>, exportId: string): Promise<{ key: string; size: number; sha256: string; manifest: ExportManifest }> {
  const { deps, tenantId } = ctx;
  const out = new ZipCollector();
  const generatedAt = deps.now().toISOString();
  const home = await ctx.tx(async (tx) => (await tx.one<{ home_region: HomeRegion }>('SELECT home_region FROM app.tenants WHERE tenant_id = app.current_tenant()')).home_region);
  const tables = await ctx.tx((tx) => tenantTablesInOrder(tx.client));
  const manifest: ExportManifest = {
    format: 'thapsus-hr.company-export',
    formatVersion: 1,
    tenantId,
    homeRegion: home,
    generatedAt,
    tables: [],
    sensitive: { file: 'sensitive/vault-records.jsonl', records: 0, byCategory: {} },
    files: { manifest: 'files/manifest.csv', count: 0, bytes: 0 },
    notes: [
      'Credential hashes, session and API tokens are never exported.',
      'vault.records envelopes are replaced by decrypted values in sensitive/vault-records.jsonl.',
      'Each table is read in its own statement; rows changed during the export may appear in their new state.',
    ],
  };
  const total = tables.length + 2;
  let step = 0;
  for (const table of tables) {
    const csv = await ctx.tx(async (tx) => {
      const cols = await tx.query<{ c: string }>(`SELECT attname AS c FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`, [table]);
      const all = cols.map((c) => c.c);
      const keep = all.filter((c) => !omitColumn(table, c));
      const lines = [keep.map(csvCell).join(',')];
      let rows = 0;
      await tx.exec(`DECLARE export_cursor NO SCROLL CURSOR FOR SELECT ${keep.map((c) => `"${c}"`).join(', ')} FROM ${table}`);
      for (;;) {
        const batch = await tx.query<Record<string, unknown>>('FETCH 5000 FROM export_cursor');
        if (!batch.length) break;
        for (const r of batch) lines.push(keep.map((c) => csvCell(r[c])).join(','));
        rows += batch.length;
      }
      await tx.exec('CLOSE export_cursor');
      return { body: Buffer.from(lines.join('\r\n') + '\r\n'), rows, keep, omitted: all.filter((c) => !keep.includes(c)) };
    });
    const file = `tables/${table}.csv`;
    out.add(file, csv.body);
    manifest.tables.push({ table, file, rows: csv.rows, columns: csv.keep, omittedColumns: csv.omitted, sha256: sha256(csv.body) });
    await ctx.progress(++step, total);
  }

  // Sensitive vault values, decrypted for the controller; one audit entry per category.
  const sensitive = await ctx.tx(async (tx) => {
    const lines: string[] = [];
    const byCategory: Record<string, number> = {};
    await tx.exec(`DECLARE vault_cursor NO SCROLL CURSOR FOR SELECT id, subject_id, category, field, envelope, file_key, created_at FROM vault.records ORDER BY category, created_at`);
    for (;;) {
      const batch = await tx.query<{ id: string; subject_id: string; category: string; field: string; envelope: Envelope; file_key: string | null; created_at: string }>('FETCH 500 FROM vault_cursor');
      if (!batch.length) break;
      for (const r of batch) {
        const value = await open(deps.keys, r.envelope, { tenant: tenantId, subject: r.subject_id, category: r.category, field: r.field });
        lines.push(JSON.stringify({ id: r.id, subjectId: r.subject_id, category: r.category, field: r.field, value, fileKey: r.file_key, recordedAt: r.created_at }));
        byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
      }
    }
    await tx.exec('CLOSE vault_cursor');
    for (const [category, n] of Object.entries(byCategory)) {
      await writeAudit(tx, { actorType: ctx.job.created_by ? 'user' : 'system', actorId: ctx.job.created_by, action: 'vault.read', targetType: `vault:${category}`, targetId: exportId, diff: { purpose: 'company_export', exportId, records: n }, sensitive: true });
    }
    return { body: Buffer.from(lines.join('\n') + (lines.length ? '\n' : '')), byCategory, records: lines.length };
  });
  out.add(manifest.sensitive.file, sensitive.body);
  manifest.sensitive = { ...manifest.sensitive, records: sensitive.records, byCategory: sensitive.byCategory };
  await ctx.progress(++step, total);

  // Stored files under the tenant prefix (earlier exports excluded so archives do not nest).
  const keys = (await deps.objects.list(`${tenantId}/`)).filter((k) => !k.startsWith(`${tenantId}/exports/`));
  const fileLines = ['"key","bytes","sha256","archivePath"'];
  for (const key of keys) {
    const body = await deps.objects.get(key);
    const path = `files/${key.slice(tenantId.length + 1)}`;
    out.add(path, body);
    fileLines.push([key, body.length, sha256(body), path].map(csvCell).join(','));
    manifest.files.count++;
    manifest.files.bytes += body.length;
  }
  out.add(manifest.files.manifest, Buffer.from(fileLines.join('\r\n') + '\r\n'));
  out.add('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  await ctx.progress(++step, total);
  const zip = await out.finish();
  const key = `${tenantId}/exports/${exportId}.zip`;
  await deps.objects.put(key, zip, 'application/zip');
  return { key, size: zip.length, sha256: sha256(zip), manifest };
}

// ---- Account closure: verified deletion -----------------------------------------------------------------
export interface DeletionCertificate {
  certificate: 'thapsus-hr.deletion-certificate';
  version: 1;
  tenantId: string;
  workspace: string;
  homeRegion: HomeRegion;
  awsRegion: string;
  closureRequestedAt: string;
  gracePeriodDays: number;
  purgeStartedAt: string;
  completedAt: string;
  database: { tables: number; rowsDeleted: number; auditEventsDeleted: number; verifiedEmpty: boolean };
  files: { objectsDeleted: number; verifiedEmpty: boolean; versionsIncluded: true };
  caches: { keysDeleted: number; verifiedEmpty: boolean };
  search: string;
  backups: { retentionDays: number; expiresBy: string; statement: string };
  logs: { retentionDays: number; statement: string };
  globalDirectory: string;
}

export interface PurgeResult {
  skipped?: string;
  certificate?: DeletionCertificate;
  sha256?: string;
}

const addDaysInstant = (iso: string, days: number) => addMinutes(iso, days * 24 * 60);

/**
 * Deletes a closed tenant everywhere it lives in its cell, verifies each store is empty and issues a
 * deletion certificate (stored in the regional registry and emailed to the requester). The global
 * directory keeps only the routing entry, marked deleted.
 */
export async function purgeTenant(deps: Deps, tenantId: string, closureId: string): Promise<PurgeResult> {
  const now = () => deps.now().toISOString();
  const pre = await withTenant(deps.router, tenantId, async (tx) => {
    const c = await tx.maybe<{ status: string; purge_after: string; requested_at: string; grace_days: number; requested_by: string | null }>('SELECT status, purge_after, requested_at, grace_days, requested_by FROM app.account_closures WHERE id = $1', [closureId]);
    if (!c) return { skip: 'closure not found' as const };
    if (c.status !== 'scheduled') return { skip: `closure ${c.status}` };
    if (compareInstants(c.purge_after, deps.now().toISOString()) > 0) return { skip: 'grace period not over' };
    const tenant = await tx.one<{ slug: string; home_region: HomeRegion; default_locale: string }>('SELECT slug, home_region, default_locale FROM app.tenants WHERE tenant_id = app.current_tenant()');
    const requester = c.requested_by ? await tx.maybe<{ email: string; locale: string | null }>('SELECT email, locale FROM app.users WHERE id = $1', [c.requested_by]) : undefined;
    const userIds = (await tx.query<{ id: string }>('SELECT id FROM app.users')).map((r) => r.id);
    const kioskIds = (await tx.query<{ id: string }>('SELECT id FROM app.kiosks')).map((r) => r.id);
    return { closure: c, tenant, requester, userIds, kioskIds };
  });
  if ('skip' in pre) return { skipped: pre.skip };
  const purgeStartedAt = now();

  // 1. Stop all access: the registry status blocks sign-in and API use; the directory follows.
  await withRegistry(deps.router, (tx) => tx.exec(`UPDATE registry.tenants SET status = 'closing' WHERE tenant_id = $1`, [tenantId]));
  deps.router.invalidate(tenantId);
  await deps.directory.update(tenantId, { status: 'closing' });

  // 2. Database: the audit trail through its guarded purge function, then every tenant table, children first.
  const db = await withTenant(deps.router, tenantId, async (tx) => {
    await tx.exec(`UPDATE app.account_closures SET status = 'purging' WHERE id = $1`, [closureId]);
    const auditEvents = Number((await tx.one<{ n: string }>('SELECT audit.purge_closed_tenant() AS n')).n);
    const tables = (await tenantTablesInOrder(tx.client)).filter((x) => !x.startsWith('audit.'));
    let rows = 0;
    for (const table of [...tables].reverse()) rows += await tx.exec(`DELETE FROM ${table} WHERE tenant_id = app.current_tenant()`);
    return { tables: tables.length + 2, rows: rows + auditEvents, auditEvents };
  });

  // 3. Files: every object and every stored version under the tenant prefix.
  const objectsDeleted = await deps.objects.deletePrefix(`${tenantId}/`);

  // 4. Caches: rate-limit and lockout counters keyed by workspace, user or kiosk.
  const prefixes = [`login:acct:${pre.tenant.slug}:`, `magic:acct:${pre.tenant.slug}:`, ...pre.userIds.map((u) => `totp:${u}`), ...pre.kioskIds.flatMap((k) => [`kiosk:${k}`, `kiosk-unknown:${k}:`])];
  let keysDeleted = 0;
  for (const p of prefixes) keysDeleted += await deps.limiter.resetPrefix(p);

  // 5. Verify every store is empty.
  const remaining = await withTenant(deps.router, tenantId, async (tx: Tx) => {
    let n = 0;
    for (const table of await tenantTablesInOrder(tx.client)) n += Number((await tx.one<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).n);
    return n;
  });
  const filesLeft = (await deps.objects.list(`${tenantId}/`)).length;
  let cacheLeft = 0;
  for (const p of prefixes) cacheLeft += await deps.limiter.resetPrefix(p);
  if (remaining || filesLeft || cacheLeft) throw new Error(`verified deletion failed: ${remaining} rows, ${filesLeft} files, ${cacheLeft} cache keys remain`);

  const completedAt = now();
  const env = deps.config.env;
  const retentionDays = LEGAL.backupRetentionDays[env];
  const certificate: DeletionCertificate = {
    certificate: 'thapsus-hr.deletion-certificate',
    version: 1,
    tenantId,
    workspace: pre.tenant.slug,
    homeRegion: pre.tenant.home_region,
    awsRegion: REGIONS[pre.tenant.home_region].awsRegion,
    closureRequestedAt: pre.closure.requested_at,
    gracePeriodDays: pre.closure.grace_days,
    purgeStartedAt,
    completedAt,
    database: { tables: db.tables, rowsDeleted: db.rows, auditEventsDeleted: db.auditEvents, verifiedEmpty: true },
    files: { objectsDeleted, verifiedEmpty: true, versionsIncluded: true },
    caches: { keysDeleted, verifiedEmpty: true },
    search: 'Search indexes are PostgreSQL full-text and trigram indexes over the deleted rows; no separate search store exists.',
    backups: {
      retentionDays,
      expiresBy: addDaysInstant(completedAt, retentionDays),
      statement: `Encrypted database and file backups (continuous and daily, plus in-jurisdiction copies where configured) expire automatically within ${retentionDays} days and are only restored for disaster recovery.`,
    },
    logs: { retentionDays: LEGAL.logRetentionDays[env], statement: 'Application logs are scrubbed of personal data and expire on their own schedule.' },
    globalDirectory: 'The global tenant directory keeps the workspace id, slug and region with status deleted; it never held personal data.',
  };
  const digest = sha256(JSON.stringify(certificate));

  // 6. Record the certificate in the regional registry, mark the tenant deleted, update the directory.
  await withRegistry(deps.router, async (tx) => {
    await tx.exec(`INSERT INTO registry.deletion_certificates (tenant_id, certificate, certificate_sha256) VALUES ($1, $2, $3) ON CONFLICT (tenant_id) DO NOTHING`, [tenantId, JSON.stringify(certificate), digest]);
    await tx.exec(`DELETE FROM registry.work_signals WHERE tenant_id = $1`, [tenantId]);
    await tx.exec(`UPDATE registry.tenants SET status = 'deleted' WHERE tenant_id = $1`, [tenantId]);
  });
  deps.router.invalidate(tenantId);
  await deps.directory.update(tenantId, { status: 'deleted' });

  // 7. Tell the requester (from the home region's mail service); the address was read before the purge.
  if (pre.requester) {
    const locale = isLocale(pre.requester.locale) ? pre.requester.locale : isLocale(pre.tenant.default_locale) ? pre.tenant.default_locale : 'en-GB';
    await deps.mailer.send({
      to: pre.requester.email,
      subject: t(locale, 'privacy.closure.certificateSubject', { workspace: pre.tenant.slug }),
      text: `${t(locale, 'privacy.closure.certificateBody', { workspace: pre.tenant.slug, date: completedAt, expires: certificate.backups.expiresBy })}\n\nSHA-256: ${digest}\n\n${JSON.stringify(certificate, null, 2)}`,
    });
  }
  return { certificate, sha256: digest };
}
