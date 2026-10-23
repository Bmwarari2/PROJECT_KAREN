import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { rules, RuleNotFoundError, RULE_KEYS, type RuleBook, type RuleOverride } from '@thapsus/rules';
import { requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { CivilDate, Nullable, Problem } from '../../http/schemas';
import { getPool } from '@thapsus/db';
import { backofficePool, requireStaff, staffAudit } from '../backoffice/auth';

/** Pack data + back-office edits, refreshed at most every 60 s per process. */
let cache: { book: RuleBook; at: number } | undefined;
export async function ruleBook(app: FastifyInstance): Promise<RuleBook> {
  if (cache && Date.now() - cache.at < 60_000) return cache.book;
  let overrides: RuleOverride[] = [];
  try {
    const pool = getPool(app.deps.router.config.databases[app.deps.router.registryKey]!);
    const { rows } = await pool.query<{
      jurisdiction: string;
      rule_key: string;
      effective_from: string;
      effective_to: string | null;
      value: unknown;
      source_url: string;
      source_title: string;
      verified_on: string;
      reviewer: string;
      notes: string | null;
      created_at: string;
    }>('SELECT * FROM backoffice.rule_versions ORDER BY created_at');
    overrides = rows.map((r) => ({
      jurisdiction: r.jurisdiction,
      key: r.rule_key,
      effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to,
      value: r.value,
      source: { url: r.source_url, title: r.source_title },
      verifiedOn: r.verified_on,
      reviewer: r.reviewer,
      notes: r.notes ?? undefined,
      createdAt: r.created_at,
    }));
  } catch {
    // no database (e.g. spec generation): pack data only
  }
  cache = { book: rules().withOverrides(overrides), at: Date.now() };
  return cache.book;
}
export const invalidateRuleBook = () => {
  cache = undefined;
};

/** "EU", ISO 3166-1 ("GB"), ISO 3166-2 ("US-NY", "GB-NIR") or a locality below it ("US-NY-NYC"); unknown codes resolve through their hyphen ancestors. */
const JurisdictionCode = Type.String({ pattern: '^[A-Z]{2}(-[A-Z0-9]{1,3}){0,2}$', maxLength: 10 });
const Resolved = Type.Object({
  jurisdiction: Type.String(),
  key: Type.String(),
  value: Type.Any(),
  effectiveFrom: Type.String(),
  effectiveTo: Nullable(Type.String()),
  source: Type.Object({ url: Type.String(), title: Type.String() }),
  verifiedOn: Type.String(),
  packVersion: Type.Integer(),
  regions: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Subdivisions the answering version was verified for (e.g. GB-ENG, GB-WLS, GB-SCT); absent = the whole jurisdiction',
    }),
  ),
});

export async function rulesRoutes(app: FastifyInstance) {
  app.get(
    '/v1/rules/:jurisdiction/:key',
    {
      schema: {
        tags: ['rules'],
        params: Type.Object({ jurisdiction: JurisdictionCode, key: Type.String({ maxLength: 80 }) }),
        querystring: Type.Object({ date: Type.Optional(CivilDate) }),
        response: { 200: Resolved, 404: Problem },
      },
    },
    async (req) => {
      requireAuth(req);
      const { jurisdiction, key } = req.params as { jurisdiction: string; key: string };
      const date = (req.query as { date?: string }).date ?? new Date().toISOString().slice(0, 10);
      try {
        return (await ruleBook(app)).resolve(jurisdiction, key, date);
      } catch (e) {
        if (e instanceof RuleNotFoundError) throw new ApiError('notFound');
        throw e;
      }
    },
  );

  app.get(
    '/v1/rules/:jurisdiction',
    {
      schema: {
        tags: ['rules'],
        params: Type.Object({ jurisdiction: JurisdictionCode }),
        querystring: Type.Object({ date: Type.Optional(CivilDate) }),
        response: { 200: Type.Array(Resolved) },
      },
    },
    async (req) => {
      requireAuth(req);
      const { jurisdiction } = req.params as { jurisdiction: string };
      const date = (req.query as { date?: string }).date ?? new Date().toISOString().slice(0, 10);
      const book = await ruleBook(app);
      return Object.keys(RULE_KEYS).flatMap((k) => {
        const r = book.tryResolve(jurisdiction, k, date);
        return r ? [r] : [];
      });
    },
  );

  app.get(
    '/v1/holidays',
    {
      schema: {
        tags: ['rules'],
        querystring: Type.Object({
          country: Type.String({ pattern: '^[A-Z]{2}$' }),
          region: Type.Optional(Type.String({ pattern: '^[A-Z]{2}-[A-Z0-9]{1,3}$' })),
          year: Type.Integer({ minimum: 2000, maximum: 2100 }),
        }),
        response: {
          200: Type.Array(
            Type.Object({
              id: Type.String(),
              name: Type.String(),
              date: Type.String(),
              observed: Nullable(Type.String()),
            }),
          ),
        },
      },
    },
    async (req) => {
      requireAuth(req);
      const q = req.query as { country: string; region?: string; year: number };
      return (await ruleBook(app))
        .holidays(q.country, q.year, q.region)
        .map(({ id, name, date, observed }) => ({ id, name, date, observed }));
    },
  );

  // ---- back office: append-only rule versions -------------------------------------------------------
  app.get(
    '/v1/backoffice/rules/:jurisdiction/:key/versions',
    {
      config: { auth: 'public' },
      preHandler: requireStaff(app, ['rules_editor']),
      schema: {
        tags: ['backoffice'],
        params: Type.Object({ jurisdiction: Type.String(), key: Type.String() }),
        response: { 200: Type.Array(Type.Any()) },
      },
    },
    async (req) => {
      const { jurisdiction, key } = req.params as { jurisdiction: string; key: string };
      return (await ruleBook(app)).versions(jurisdiction, key);
    },
  );

  app.post(
    '/v1/backoffice/rules/:jurisdiction/:key/versions',
    {
      config: { auth: 'public', selfAudited: true },
      preHandler: requireStaff(app, ['rules_editor']),
      schema: {
        tags: ['backoffice'],
        params: Type.Object({ jurisdiction: JurisdictionCode, key: Type.String() }),
        body: Type.Object({
          effectiveFrom: CivilDate,
          effectiveTo: Type.Optional(Nullable(CivilDate)),
          value: Type.Any(),
          source: Type.Object({
            url: Type.String({ pattern: '^https://' }),
            title: Type.String({ minLength: 3 }),
          }),
          verifiedOn: CivilDate,
          notes: Type.Optional(Type.String({ maxLength: 2000 })),
        }),
        response: { 201: Type.Object({ id: Type.String() }), 400: Problem, 403: Problem },
      },
    },
    async (req, reply) => {
      const { jurisdiction, key } = req.params as { jurisdiction: string; key: string };
      const b = req.body as {
        effectiveFrom: string;
        effectiveTo?: string | null;
        value: unknown;
        source: { url: string; title: string };
        verifiedOn: string;
        notes?: string;
      };
      if (!(key in RULE_KEYS)) throw new ApiError('validation', 'Unknown rule key');
      if (!rules().pack(jurisdiction) && jurisdiction !== 'EU')
        throw new ApiError('validation', 'Unknown jurisdiction');
      if (b.effectiveTo && b.effectiveTo <= b.effectiveFrom)
        throw new ApiError('validation', 'effectiveTo must be after effectiveFrom');
      const { rows } = await backofficePool(app).query<{ id: string }>(
        `INSERT INTO backoffice.rule_versions (jurisdiction, rule_key, effective_from, effective_to, value, source_url, source_title, verified_on, reviewer, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [
          jurisdiction,
          key,
          b.effectiveFrom,
          b.effectiveTo ?? null,
          JSON.stringify(b.value),
          b.source.url,
          b.source.title,
          b.verifiedOn,
          req.staff!.email,
          b.notes ?? null,
          req.staff!.staffId,
        ],
      );
      await staffAudit(app, req, 'rules.version_added', {
        jurisdiction,
        key,
        effectiveFrom: b.effectiveFrom,
      });
      invalidateRuleBook();
      return reply.status(201).send({ id: rows[0]!.id });
    },
  );
}
