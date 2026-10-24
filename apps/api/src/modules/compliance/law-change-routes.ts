import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type, type Static } from 'typebox';
import { getPool } from '@thapsus/db';
import { RULE_KEYS } from '@thapsus/rules';
import { authorizeSome } from '../../http/context';
import { ApiError } from '../../http/errors';
import { CivilDate, Nullable, Problem, Uuid } from '../../http/schemas';
import { backofficePool, requireStaff, staffAudit, assertElevated } from '../backoffice/auth';
import { ruleBook } from '../rules/routes';
import { relevantJurisdictions } from './engine';
import { tenantJurisdictionCodes } from './service';

const Code = Type.String({ pattern: '^(EU|[A-Z]{2}(-[A-Z0-9]{1,3}){0,2})$', maxLength: 10 });
const Localised = Type.Object(
  {
    'en-GB': Type.String({ minLength: 3, maxLength: 4000 }),
    'en-US': Type.Optional(Type.String({ minLength: 3, maxLength: 4000 })),
  },
  { additionalProperties: false },
);
const PackRef = Type.Object({
  jurisdiction: Code,
  key: Type.String({ maxLength: 80 }),
  effectiveFrom: CivilDate,
});
const Entry = Type.Object({
  id: Uuid,
  jurisdiction: Type.String(),
  effectiveDate: Type.String(),
  title: Type.Record(Type.String(), Type.String()),
  summary: Type.Record(Type.String(), Type.String()),
  whatToDo: Type.Record(Type.String(), Type.String()),
  ruleVersionIds: Type.Array(Uuid),
  packRuleRefs: Type.Array(PackRef),
  sourceUrl: Nullable(Type.String()),
  status: Type.String(),
  publishedAt: Nullable(Type.String()),
});
type Row = {
  id: string;
  jurisdiction: string;
  effective_date: string;
  title: Record<string, string>;
  summary: Record<string, string>;
  what_to_do: Record<string, string>;
  rule_version_ids: string[];
  pack_rule_refs: Array<{ jurisdiction: string; key: string; effectiveFrom: string }>;
  source_url: string | null;
  status: string;
  published_at: string | null;
};
const mapRow = (r: Row) => ({
  id: r.id,
  jurisdiction: r.jurisdiction,
  effectiveDate: r.effective_date,
  title: r.title,
  summary: r.summary,
  whatToDo: r.what_to_do,
  ruleVersionIds: r.rule_version_ids,
  packRuleRefs: r.pack_rule_refs,
  sourceUrl: r.source_url,
  status: r.status,
  publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
});
const COLS = `id, jurisdiction, effective_date::text AS effective_date, title, summary, what_to_do, rule_version_ids, pack_rule_refs, source_url, status, published_at`;

/** Published law-change entries, read from the cell database as the application role (no personal data). */
export async function publishedLawChanges(app: FastifyInstance): Promise<Row[]> {
  const pool = getPool(app.deps.router.config.databases[app.deps.router.registryKey]!);
  return (
    await pool.query<Row>(
      `SELECT ${COLS} FROM backoffice.law_changes WHERE status = 'published' ORDER BY effective_date DESC, published_at DESC`,
    )
  ).rows;
}

/** Entries relevant to a tenant: the jurisdictions of its entities, locations and employees, and their parents (e.g. EU). */
export async function relevantLawChanges(app: FastifyInstance, codes: string[]) {
  const book = await ruleBook(app);
  const set = relevantJurisdictions(book, codes);
  return (await publishedLawChanges(app)).filter((r) => set.has(r.jurisdiction));
}

export async function lawChangeRoutes(app: FastifyInstance) {
  // ---- back office (Thapsus staff with MFA) --------------------------------------------------------
  async function validateRefs(b: {
    ruleVersionIds?: string[];
    packRuleRefs?: Array<{ jurisdiction: string; key: string; effectiveFrom: string }>;
  }) {
    if (b.ruleVersionIds?.length) {
      const { rows } = await backofficePool(app).query<{ id: string }>(
        'SELECT id FROM backoffice.rule_versions WHERE id = ANY($1::uuid[])',
        [b.ruleVersionIds],
      );
      const missing = b.ruleVersionIds.filter((id) => !rows.some((r) => r.id === id));
      if (missing.length) throw new ApiError('validation', 'Unknown rule version', { missing });
    }
    if (b.packRuleRefs?.length) {
      const book = await ruleBook(app);
      for (const ref of b.packRuleRefs) {
        if (
          !(ref.key in RULE_KEYS) ||
          !book.versions(ref.jurisdiction, ref.key).some((v) => v.effectiveFrom === ref.effectiveFrom)
        )
          throw new ApiError('validation', 'Unknown pack rule version', ref);
      }
    }
  }
  const Body = Type.Object({
    jurisdiction: Code,
    effectiveDate: CivilDate,
    title: Localised,
    summary: Localised,
    whatToDo: Localised,
    ruleVersionIds: Type.Optional(Type.Array(Uuid, { maxItems: 50 })),
    packRuleRefs: Type.Optional(Type.Array(PackRef, { maxItems: 50 })),
    sourceUrl: Type.Optional(Nullable(Type.String({ pattern: '^https://', maxLength: 500 }))),
    status: Type.Optional(
      Type.Union([Type.Literal('draft'), Type.Literal('published'), Type.Literal('withdrawn')]),
    ),
  });

  app.post(
    '/v1/backoffice/law-changes',
    {
      config: { auth: 'public', selfAudited: true },
      preHandler: requireStaff(app, ['rules_editor']),
      schema: {
        tags: ['backoffice'],
        summary: 'Add a law-changes feed entry',
        body: Body,
        response: { 201: Entry, 400: Problem, 401: Problem, 403: Problem },
      },
    },
    async (req, reply) => {
      const b = req.body as Static<typeof Body>;
      if (b.jurisdiction !== 'EU' && !(await ruleBook(app)).chain(b.jurisdiction).length)
        throw new ApiError('validation', 'Unknown jurisdiction');
      await validateRefs(b);
      const status = b.status ?? 'published';
      // publishing reaches every tenant's compliance feed: it needs an approved, time-boxed elevation
      if (status === 'published') assertElevated(app.deps, req, 'rules_publish');
      const { rows } = await backofficePool(app).query<Row>(
        `INSERT INTO backoffice.law_changes (jurisdiction, effective_date, title, summary, what_to_do, rule_version_ids, pack_rule_refs, source_url, status, published_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $9 = 'published' THEN now() END, $10) RETURNING ${COLS}`,
        [
          b.jurisdiction,
          b.effectiveDate,
          JSON.stringify(b.title),
          JSON.stringify(b.summary),
          JSON.stringify(b.whatToDo),
          b.ruleVersionIds ?? [],
          JSON.stringify(b.packRuleRefs ?? []),
          b.sourceUrl ?? null,
          status,
          req.staff!.staffId,
        ],
      );
      await staffAudit(app, req, 'law_change.created', {
        id: rows[0]!.id,
        jurisdiction: b.jurisdiction,
        effectiveDate: b.effectiveDate,
        status,
      });
      return reply.status(201).send(mapRow(rows[0]!));
    },
  );

  app.get(
    '/v1/backoffice/law-changes',
    {
      config: { auth: 'public' },
      preHandler: requireStaff(app, ['rules_editor', 'support']),
      schema: { tags: ['backoffice'], response: { 200: Type.Array(Entry), 401: Problem, 403: Problem } },
    },
    async () => {
      return (
        await backofficePool(app).query<Row>(
          `SELECT ${COLS} FROM backoffice.law_changes ORDER BY created_at DESC LIMIT 500`,
        )
      ).rows.map(mapRow);
    },
  );

  app.patch(
    '/v1/backoffice/law-changes/:id',
    {
      config: { auth: 'public', selfAudited: true },
      preHandler: requireStaff(app, ['rules_editor']),
      schema: {
        tags: ['backoffice'],
        summary: 'Correct, publish or withdraw an entry (every change is in the staff audit trail)',
        params: Type.Object({ id: Uuid }),
        body: Type.Partial(Body),
        response: { 200: Entry, 400: Problem, 401: Problem, 403: Problem, 404: Problem },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const b = req.body as Partial<Static<typeof Body>>;
      await validateRefs(b);
      const pool = backofficePool(app);
      const before = (await pool.query<Row>(`SELECT ${COLS} FROM backoffice.law_changes WHERE id = $1`, [id]))
        .rows[0];
      if (!before) throw new ApiError('notFound');
      if ((b.status ?? before.status) === 'published') assertElevated(app.deps, req, 'rules_publish');
      const { rows } = await pool.query<Row>(
        `UPDATE backoffice.law_changes SET jurisdiction = $2, effective_date = $3, title = $4, summary = $5, what_to_do = $6, rule_version_ids = $7, pack_rule_refs = $8, source_url = $9, status = $10,
         published_at = CASE WHEN $10 = 'published' AND published_at IS NULL THEN now() ELSE published_at END WHERE id = $1 RETURNING ${COLS}`,
        [
          id,
          b.jurisdiction ?? before.jurisdiction,
          b.effectiveDate ?? before.effective_date,
          JSON.stringify(b.title ?? before.title),
          JSON.stringify(b.summary ?? before.summary),
          JSON.stringify(b.whatToDo ?? before.what_to_do),
          b.ruleVersionIds ?? before.rule_version_ids,
          JSON.stringify(b.packRuleRefs ?? before.pack_rule_refs),
          b.sourceUrl !== undefined ? b.sourceUrl : before.source_url,
          b.status ?? before.status,
        ],
      );
      await staffAudit(app, req, 'law_change.updated', {
        id,
        changed: Object.keys(b),
        status: rows[0]!.status,
      });
      return mapRow(rows[0]!);
    },
  );

  // ---- customers ---------------------------------------------------------------------------------
  const pick = (req: FastifyRequest, m: Record<string, string>) =>
    m[req.ctx.locale] ?? m['en-GB'] ?? Object.values(m)[0] ?? '';
  const FeedItem = Type.Object({
    id: Uuid,
    jurisdiction: Type.String(),
    effectiveDate: Type.String(),
    title: Type.String(),
    summary: Type.String(),
    whatToDo: Type.String(),
    sourceUrl: Nullable(Type.String()),
    publishedAt: Nullable(Type.String()),
    ruleVersions: Type.Array(
      Type.Object({
        jurisdiction: Type.String(),
        key: Type.String(),
        effectiveFrom: Type.String(),
        effectiveTo: Nullable(Type.String()),
        source: Type.Object({ url: Type.String(), title: Type.String() }),
        verifiedOn: Type.String(),
        origin: Type.String(),
      }),
    ),
    readAt: Nullable(Type.String()),
    acknowledgedAt: Nullable(Type.String()),
    acknowledgements: Type.Array(
      Type.Object({ userId: Uuid, displayName: Type.String(), acknowledgedAt: Type.String() }),
    ),
  });

  app.get(
    '/v1/compliance/law-changes',
    {
      schema: {
        tags: ['compliance'],
        summary:
          'Law changes relevant to the jurisdictions where the company has entities, locations or employees, with read and acknowledged state',
        querystring: Type.Object({ unacknowledgedOnly: Type.Optional(Type.Boolean()) }),
        response: {
          200: Type.Object({ jurisdictions: Type.Array(Type.String()), items: Type.Array(FeedItem) }),
          403: Problem,
        },
      },
    },
    async (req) => {
      const auth = authorizeSome(req, 'compliance.law_changes');
      const book = await ruleBook(app);
      const codes = await app.tenantTx(req, (tx) => tenantJurisdictionCodes(tx), { readOnly: true });
      const entries = await relevantLawChanges(app, codes);
      const { rows: overlay } = entries.some((e) => e.rule_version_ids.length)
        ? await getPool(app.deps.router.config.databases[app.deps.router.registryKey]!).query<{
            id: string;
            jurisdiction: string;
            rule_key: string;
            effective_from: string;
            effective_to: string | null;
            source_url: string;
            source_title: string;
            verified_on: string;
          }>(
            `SELECT id, jurisdiction, rule_key, effective_from::text, effective_to::text, source_url, source_title, verified_on::text FROM backoffice.rule_versions WHERE id = ANY($1::uuid[])`,
            [entries.flatMap((e) => e.rule_version_ids)],
          )
        : { rows: [] };
      const state = await app.tenantTx(
        req,
        (tx) =>
          tx.query<{
            law_change_id: string;
            user_id: string;
            display_name: string;
            read_at: string;
            acknowledged_at: string | null;
          }>(
            `SELECT r.law_change_id, r.user_id, u.display_name, r.read_at, r.acknowledged_at FROM app.law_change_reads r JOIN app.users u ON u.tenant_id = r.tenant_id AND u.id = r.user_id WHERE r.law_change_id = ANY($1::uuid[])`,
            [entries.map((e) => e.id)],
          ),
        { readOnly: true },
      );
      const items = entries.map((e) => {
        const mine = state.find((s) => s.law_change_id === e.id && s.user_id === auth.userId);
        const pack = e.pack_rule_refs.flatMap((ref) => {
          const v = book
            .versions(ref.jurisdiction, ref.key)
            .find((x) => x.effectiveFrom === ref.effectiveFrom);
          return v
            ? [
                {
                  jurisdiction: ref.jurisdiction,
                  key: ref.key,
                  effectiveFrom: v.effectiveFrom,
                  effectiveTo: v.effectiveTo,
                  source: v.source,
                  verifiedOn: v.verifiedOn,
                  origin: v.origin,
                },
              ]
            : [];
        });
        const edits = overlay
          .filter((o) => e.rule_version_ids.includes(o.id))
          .map((o) => ({
            jurisdiction: o.jurisdiction,
            key: o.rule_key,
            effectiveFrom: o.effective_from,
            effectiveTo: o.effective_to,
            source: { url: o.source_url, title: o.source_title },
            verifiedOn: o.verified_on,
            origin: 'backoffice',
          }));
        return {
          id: e.id,
          jurisdiction: e.jurisdiction,
          effectiveDate: e.effective_date,
          title: pick(req, e.title),
          summary: pick(req, e.summary),
          whatToDo: pick(req, e.what_to_do),
          sourceUrl: e.source_url,
          publishedAt: e.published_at ? new Date(e.published_at).toISOString() : null,
          ruleVersions: [...pack, ...edits],
          readAt: mine ? new Date(mine.read_at).toISOString() : null,
          acknowledgedAt: mine?.acknowledged_at ? new Date(mine.acknowledged_at).toISOString() : null,
          acknowledgements: state
            .filter((s) => s.law_change_id === e.id && s.acknowledged_at)
            .map((s) => ({
              userId: s.user_id,
              displayName: s.display_name,
              acknowledgedAt: new Date(s.acknowledged_at!).toISOString(),
            })),
        };
      });
      const q = req.query as { unacknowledgedOnly?: boolean };
      return {
        jurisdictions: codes.sort(),
        items: q.unacknowledgedOnly ? items.filter((i) => !i.acknowledgedAt) : items,
      };
    },
  );

  async function mark(req: FastifyRequest, id: string, ack: boolean) {
    const auth = authorizeSome(req, 'compliance.law_changes');
    const codes = await app.tenantTx(req, (tx) => tenantJurisdictionCodes(tx), { readOnly: true });
    if (!(await relevantLawChanges(app, codes)).some((e) => e.id === id)) throw new ApiError('notFound');
    return app.tenantTx(req, async (tx) => {
      const row = await tx.one<{ read_at: string; acknowledged_at: string | null }>(
        `INSERT INTO app.law_change_reads (tenant_id, law_change_id, user_id, acknowledged_at) VALUES (app.current_tenant(), $1, $2, CASE WHEN $3 THEN now() END)
         ON CONFLICT (tenant_id, law_change_id, user_id) DO UPDATE SET acknowledged_at = CASE WHEN $3 THEN coalesce(app.law_change_reads.acknowledged_at, now()) ELSE app.law_change_reads.acknowledged_at END
         RETURNING read_at, acknowledged_at`,
        [id, auth.userId, ack],
      );
      await app.audit(tx, req, {
        action: ack ? 'law_change.acknowledged' : 'law_change.read',
        targetType: 'law_change',
        targetId: id,
      });
      return {
        id,
        readAt: new Date(row.read_at).toISOString(),
        acknowledgedAt: row.acknowledged_at ? new Date(row.acknowledged_at).toISOString() : null,
      };
    });
  }
  const MarkOut = Type.Object({ id: Uuid, readAt: Type.String(), acknowledgedAt: Nullable(Type.String()) });
  app.post(
    '/v1/compliance/law-changes/:id/read',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['compliance'],
        params: Type.Object({ id: Uuid }),
        response: { 200: MarkOut, 403: Problem, 404: Problem },
      },
    },
    async (req) => mark(req, (req.params as { id: string }).id, false),
  );
  app.post(
    '/v1/compliance/law-changes/:id/acknowledge',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['compliance'],
        summary: 'Acknowledge an entry (audited)',
        params: Type.Object({ id: Uuid }),
        response: { 200: MarkOut, 403: Problem, 404: Problem },
      },
    },
    async (req) => mark(req, (req.params as { id: string }).id, true),
  );
}
