import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import pg from 'pg';
import type { HomeRegion } from '@thapsus/core';
import { secretToUrl } from '@thapsus/db';

/**
 * Global tenant directory: maps tenant id, slug and verified domains to a home region.
 * It deliberately has NO place for personal data — DIRECTORY_FIELDS is the complete schema and
 * test/directory.test.ts fails if anything else is added.
 */
export const DIRECTORY_FIELDS = [
  'tenantId',
  'slug',
  'homeRegion',
  'status',
  'planRef',
  'verifiedDomains',
  'createdAt',
  'updatedAt',
] as const;

export interface DirectoryEntry {
  tenantId: string;
  slug: string;
  homeRegion: HomeRegion;
  status: 'active' | 'suspended' | 'closing' | 'deleted';
  planRef: string | null;
  verifiedDomains: string[];
  /** When the workspace signed up (set by the directory; for sign-up counts by region and week). */
  createdAt?: string;
}

export interface TenantDirectory {
  register(entry: DirectoryEntry): Promise<void>;
  bySlug(slug: string): Promise<DirectoryEntry | undefined>;
  byDomain(domain: string): Promise<DirectoryEntry | undefined>;
  byId(tenantId: string): Promise<DirectoryEntry | undefined>;
  update(tenantId: string, patch: Partial<Omit<DirectoryEntry, 'tenantId'>>): Promise<void>;
  /** Every entry (back-office cross-region view: ids, slugs, regions, plan and status only). */
  list(limit?: number): Promise<DirectoryEntry[]>;
}

export class SlugTakenError extends Error {
  constructor() {
    super('slug already registered');
  }
}

export class InMemoryDirectory implements TenantDirectory {
  readonly entries = new Map<string, DirectoryEntry>();
  async register(e: DirectoryEntry) {
    for (const x of this.entries.values())
      if (x.slug === e.slug && x.tenantId !== e.tenantId) throw new SlugTakenError();
    this.entries.set(e.tenantId, { ...e });
    if (!this.created.has(e.tenantId)) this.created.set(e.tenantId, e.createdAt ?? new Date().toISOString());
  }
  /** Sign-up times, kept beside the entries (a stored directory keeps them in its created_at column). */
  private readonly created = new Map<string, string>();
  async bySlug(slug: string) {
    return [...this.entries.values()].find((e) => e.slug === slug);
  }
  async byDomain(domain: string) {
    const d = domain.toLowerCase();
    return [...this.entries.values()].find((e) => e.verifiedDomains.includes(d));
  }
  async byId(id: string) {
    return this.entries.get(id);
  }
  async update(id: string, patch: Partial<DirectoryEntry>) {
    const e = this.entries.get(id);
    if (e) this.entries.set(id, { ...e, ...patch, tenantId: id });
  }
  async list(limit = 5000) {
    return [...this.entries.values()]
      .slice(0, limit)
      .map((e) => ({ ...e, createdAt: this.created.get(e.tenantId) }));
  }
}

/** Postgres-backed directory for local development (its own database, not a cell database). */
export class PgDirectory implements TenantDirectory {
  private pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 4 });
  }
  static readonly DDL = `CREATE TABLE IF NOT EXISTS directory_tenants (
    tenant_id uuid PRIMARY KEY, slug text NOT NULL UNIQUE, home_region text NOT NULL, status text NOT NULL,
    plan_ref text, verified_domains text[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now())`;
  async init() {
    await this.pool.query(PgDirectory.DDL);
  }
  private map(r: Record<string, unknown> | undefined): DirectoryEntry | undefined {
    if (!r) return undefined;
    return {
      tenantId: r.tenant_id as string,
      slug: r.slug as string,
      homeRegion: r.home_region as HomeRegion,
      status: r.status as DirectoryEntry['status'],
      planRef: (r.plan_ref as string) ?? null,
      verifiedDomains: (r.verified_domains as string[]) ?? [],
      createdAt: r.created_at ? new Date(r.created_at as string).toISOString() : undefined,
    };
  }
  async register(e: DirectoryEntry) {
    try {
      await this.pool.query(
        `INSERT INTO directory_tenants (tenant_id, slug, home_region, status, plan_ref, verified_domains) VALUES ($1,$2,$3,$4,$5,$6)`,
        [e.tenantId, e.slug, e.homeRegion, e.status, e.planRef, e.verifiedDomains],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new SlugTakenError();
      throw err;
    }
  }
  async bySlug(slug: string) {
    return this.map(
      (await this.pool.query('SELECT * FROM directory_tenants WHERE slug = $1', [slug])).rows[0],
    );
  }
  async byDomain(domain: string) {
    return this.map(
      (
        await this.pool.query('SELECT * FROM directory_tenants WHERE $1 = ANY(verified_domains)', [
          domain.toLowerCase(),
        ])
      ).rows[0],
    );
  }
  async byId(id: string) {
    return this.map(
      (await this.pool.query('SELECT * FROM directory_tenants WHERE tenant_id = $1', [id])).rows[0],
    );
  }
  async list(limit = 5000) {
    return (
      await this.pool.query('SELECT * FROM directory_tenants ORDER BY slug LIMIT $1', [limit])
    ).rows.map((r) => this.map(r)!);
  }
  async update(id: string, p: Partial<DirectoryEntry>) {
    await this.pool.query(
      `UPDATE directory_tenants SET status = coalesce($2, status), plan_ref = coalesce($3, plan_ref),
        verified_domains = coalesce($4, verified_domains), slug = coalesce($5, slug), updated_at = now()
        WHERE tenant_id = $1`,
      [id, p.status ?? null, p.planRef ?? null, p.verifiedDomains ?? null, p.slug ?? null],
    );
  }
}

/** DynamoDB-backed directory used by the global stack (table + GSIs on slug and domain). */
export class DynamoDirectory implements TenantDirectory {
  private client: DynamoDBClient;
  constructor(
    private readonly table: string,
    region: string,
  ) {
    this.client = new DynamoDBClient({ region });
  }
  private map(
    item: Record<string, { S?: string; SS?: string[]; NULL?: boolean }> | undefined,
  ): DirectoryEntry | undefined {
    if (!item) return undefined;
    return {
      tenantId: item.tenantId!.S!,
      slug: item.slug!.S!,
      homeRegion: item.homeRegion!.S! as HomeRegion,
      status: item.status!.S! as DirectoryEntry['status'],
      planRef: item.planRef?.S ?? null,
      verifiedDomains: item.verifiedDomains?.SS ?? [],
      createdAt: item.createdAt?.S,
    };
  }
  async register(e: DirectoryEntry) {
    // Slug uniqueness via a sentinel item keyed by slug.
    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.table,
          Item: { pk: { S: `SLUG#${e.slug}` }, tenantId: { S: e.tenantId } },
          ConditionExpression: 'attribute_not_exists(pk) OR tenantId = :t',
          ExpressionAttributeValues: { ':t': { S: e.tenantId } },
        }),
      );
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') throw new SlugTakenError();
      throw err;
    }
    await this.client.send(
      new PutItemCommand({
        TableName: this.table,
        Item: {
          pk: { S: `TENANT#${e.tenantId}` },
          tenantId: { S: e.tenantId },
          slug: { S: e.slug },
          homeRegion: { S: e.homeRegion },
          status: { S: e.status },
          ...(e.planRef ? { planRef: { S: e.planRef } } : {}),
          ...(e.verifiedDomains.length ? { verifiedDomains: { SS: e.verifiedDomains } } : {}),
          createdAt: { S: new Date().toISOString() },
        },
      }),
    );
    if (e.verifiedDomains.length) await this.update(e.tenantId, { verifiedDomains: e.verifiedDomains });
  }
  async byId(id: string) {
    const out = await this.client.send(
      new GetItemCommand({ TableName: this.table, Key: { pk: { S: `TENANT#${id}` } } }),
    );
    return this.map(out.Item as never);
  }
  async bySlug(slug: string) {
    const out = await this.client.send(
      new GetItemCommand({ TableName: this.table, Key: { pk: { S: `SLUG#${slug}` } } }),
    );
    const id = out.Item?.tenantId?.S;
    return id ? this.byId(id) : undefined;
  }
  async byDomain(domain: string) {
    const out = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: 'byDomain',
        KeyConditionExpression: 'domainKey = :d',
        ExpressionAttributeValues: { ':d': { S: domain.toLowerCase() } },
        Limit: 1,
      }),
    );
    const id = out.Items?.[0]?.tenantId?.S;
    return id ? this.byId(id) : undefined;
  }
  async list(limit = 5000) {
    const out: DirectoryEntry[] = [];
    let start: Record<string, { S: string }> | undefined;
    do {
      const page = await this.client.send(
        new ScanCommand({
          TableName: this.table,
          FilterExpression: 'begins_with(pk, :p)',
          ExpressionAttributeValues: { ':p': { S: 'TENANT#' } },
          ExclusiveStartKey: start,
        }),
      );
      for (const item of page.Items ?? []) out.push(this.map(item as never)!);
      start = page.LastEvaluatedKey as typeof start;
    } while (start && out.length < limit);
    return out.slice(0, limit).sort((a, b) => a.slug.localeCompare(b.slug));
  }
  async update(id: string, p: Partial<DirectoryEntry>) {
    // Renaming is only used to retire a deleted staging workspace (ADR-0185), never in production.
    if (p.slug) throw new Error('The DynamoDB directory does not rename workspaces');
    const sets: string[] = [];
    const values: Record<string, { S: string } | { SS: string[] }> = {};
    if (p.status) {
      sets.push('#s = :s');
      values[':s'] = { S: p.status };
    }
    if (p.planRef) {
      sets.push('planRef = :p');
      values[':p'] = { S: p.planRef };
    }
    if (p.verifiedDomains?.length) {
      sets.push('verifiedDomains = :v');
      values[':v'] = { SS: p.verifiedDomains };
    }
    if (!sets.length) return;
    await this.client.send(
      new UpdateItemCommand({
        TableName: this.table,
        Key: { pk: { S: `TENANT#${id}` } },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: p.status ? { '#s': 'status' } : undefined,
        ExpressionAttributeValues: values,
      }),
    );
    for (const d of p.verifiedDomains ?? []) {
      await this.client.send(
        new PutItemCommand({
          TableName: this.table,
          Item: { pk: { S: `DOMAIN#${d}` }, domainKey: { S: d }, tenantId: { S: id } },
        }),
      );
    }
  }
}

/**
 * Connection URL of a Postgres directory: DIRECTORY_DATABASE_URL (local development), or DIRECTORY_DATABASE_SECRET
 * with DATABASE_HOST (Google Cloud staging, ADR-0156: the `thapsus_global` database on the cell's Cloud SQL
 * instance, reached through its unix socket; the secret's dbname wins when it has one).
 */
export function directoryDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.DIRECTORY_DATABASE_URL) return env.DIRECTORY_DATABASE_URL;
  if (env.DIRECTORY_DATABASE_SECRET)
    return secretToUrl(env.DIRECTORY_DATABASE_SECRET, env.DATABASE_HOST, { dbname: 'thapsus_global' });
  return undefined;
}

export async function directoryFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<TenantDirectory> {
  if (env.DIRECTORY_TABLE)
    return new DynamoDirectory(env.DIRECTORY_TABLE, env.DIRECTORY_REGION ?? 'eu-west-2');
  const url = directoryDatabaseUrl(env);
  if (url) {
    const d = new PgDirectory(url);
    await d.init();
    return d;
  }
  return new InMemoryDirectory();
}
