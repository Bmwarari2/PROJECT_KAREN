import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import { can } from '@thapsus/core/permissions';
import { isLocale, t } from '@thapsus/core/i18n';
import {
  ASK_KEY,
  fieldsIn,
  isSigningOrder,
  unknownFields,
  type AskField,
  type SigningOrder,
} from '@thapsus/core/documents';
import type { Tx } from '@thapsus/db';
import { authorizeSome, requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Nullable, Problem, Uuid } from '../../http/schemas';
import { loadTarget } from '../employees/service';
import { tenantLocale } from '../compliance/service';
import { SAMPLE_TEMPLATES, sampleByKey } from './samples';
import { partiesFor, renderVersionFor, templateVersion, valuesFor, type VersionRow } from './signing';

/**
 * Document templates in Settings → Documents → Templates (16.9, 16.10, ADR-0194). Managing them needs
 * documents.manage. Saving creates a new version (app.document_template_versions); documents keep the version
 * they were made from. Archived templates are hidden from sending and can be restored. Starter samples for the UK,
 * Ireland and the US are copied into the workspace on request and stay labelled as samples.
 */
const ORDER = Type.Union(['employee_first', 'company_first', 'any'].map((v) => Type.Literal(v)));
const AskFieldSchema = Type.Object({
  key: Type.String({ pattern: '^[a-zA-Z][a-zA-Z0-9_]{0,39}$' }),
  label: Type.String({ minLength: 1, maxLength: 80 }),
  required: Type.Boolean(),
});
const TemplateBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  body: Type.String({ minLength: 1, maxLength: 50_000 }),
  locale: Type.Optional(Type.String()),
  category: Type.Optional(Type.String({ maxLength: 40 })),
  /** Signed documents from this template need the company's signature (default: contracts, offers and policies). */
  requiresCountersign: Type.Optional(Type.Boolean()),
  /** Who signs first by default (employee first unless set). */
  signingOrder: Type.Optional(ORDER),
  /** Fields typed in when sending, used in the body as {{ask.<key>}}. */
  askFields: Type.Optional(Type.Array(AskFieldSchema, { maxItems: 20 })),
});
type TemplateInput = {
  name: string;
  body: string;
  locale?: string;
  category?: string;
  requiresCountersign?: boolean;
  signingOrder?: SigningOrder;
  askFields?: AskField[];
};
const Summary = Type.Object({
  id: Uuid,
  name: Type.String(),
  locale: Type.String(),
  category: Type.String(),
  requiresCountersign: Type.Boolean(),
  status: Type.String(),
  version: Type.Integer(),
  /** A starter template copied from Thapsus-HR's samples: its wording needs legal review. */
  sampleKey: Nullable(Type.String()),
  signingOrder: Type.String(),
  askFields: Type.Array(AskFieldSchema),
  updatedAt: Nullable(Type.String()),
});
const MissingSchema = Type.Object({
  key: Type.String(),
  reason: Type.String(),
  label: Type.Optional(Type.String()),
});

/** Documents in these categories need a company signature unless the template says otherwise (ADR-0169). */
const COUNTERSIGNED_BY_DEFAULT = ['contract', 'offer', 'policy'];

function checkAsk(fields: AskField[] = []) {
  const keys = new Set<string>();
  for (const f of fields) {
    if (!ASK_KEY.test(f.key) || keys.has(f.key)) throw new ApiError('validation', 'askFieldKey');
    keys.add(f.key);
  }
  return fields.map((f) => ({ key: f.key, label: f.label.trim(), required: !!f.required }));
}

async function writeVersion(
  tx: Tx,
  templateId: string,
  version: number,
  v: Required<Omit<TemplateInput, 'locale'>> & { locale: string },
  actor: string,
) {
  await tx.exec(
    `INSERT INTO app.document_template_versions (tenant_id, template_id, version, name, locale, category, body, ask_fields, requires_countersign, signing_order, created_by)
     VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      templateId,
      version,
      v.name,
      v.locale,
      v.category,
      v.body,
      JSON.stringify(v.askFields),
      v.requiresCountersign,
      v.signingOrder,
      actor,
    ],
  );
}

async function createTemplate(tx: Tx, b: TemplateInput, actor: string, sampleKey: string | null = null) {
  const category = b.category?.trim() || 'letter';
  const v = {
    name: b.name.trim(),
    body: b.body,
    locale: isLocale(b.locale) ? b.locale : await tenantLocale(tx),
    category,
    requiresCountersign: b.requiresCountersign ?? COUNTERSIGNED_BY_DEFAULT.includes(category),
    signingOrder: isSigningOrder(b.signingOrder) ? b.signingOrder : 'employee_first',
    askFields: checkAsk(b.askFields),
  };
  const r = await tx.one<{ id: string }>(
    `INSERT INTO app.document_templates (tenant_id, name, body, locale, category, requires_countersign, signing_order, sample_key, updated_at, updated_by)
     VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7, now(), $8) RETURNING id`,
    [v.name, v.body, v.locale, v.category, v.requiresCountersign, v.signingOrder, sampleKey, actor],
  );
  await writeVersion(tx, r.id, 1, v, actor);
  return { id: r.id, v };
}

const toSummary = (r: {
  id: string;
  name: string;
  locale: string;
  category: string;
  requires_countersign: boolean;
  status: string;
  current_version: number;
  sample_key: string | null;
  signing_order: string;
  ask_fields: AskField[] | null;
  updated_at: string | null;
}) => ({
  id: r.id,
  name: r.name,
  locale: r.locale,
  category: r.category,
  requiresCountersign: r.requires_countersign,
  status: r.status,
  version: r.current_version,
  sampleKey: r.sample_key,
  signingOrder: r.signing_order,
  askFields: r.ask_fields ?? [],
  updatedAt: r.updated_at,
});

export async function templateRoutes(app: FastifyInstance) {
  app.get(
    '/v1/document-templates',
    {
      schema: {
        tags: ['documents'],
        querystring: Type.Object({
          /** active (default), archived or all */
          status: Type.Optional(Type.Union(['active', 'archived', 'all'].map((v) => Type.Literal(v)))),
        }),
        response: { 200: Type.Array(Summary) },
      },
    },
    async (req) => {
      authorizeSome(req, 'documents.manage');
      const status = (req.query as { status?: string }).status ?? 'active';
      return app.tenantTx(
        req,
        async (tx) =>
          (
            await tx.query<Parameters<typeof toSummary>[0]>(
              `SELECT t.id, t.name, t.locale, t.category, t.requires_countersign, t.status, t.current_version, t.sample_key, t.signing_order,
                      v.ask_fields, t.updated_at
                 FROM app.document_templates t
                 LEFT JOIN app.document_template_versions v ON v.tenant_id = t.tenant_id AND v.template_id = t.id AND v.version = t.current_version
                WHERE ($1 = 'all' OR t.status = $1) ORDER BY t.name`,
              [status],
            )
          ).map(toSummary),
        { readOnly: true },
      );
    },
  );

  app.get(
    '/v1/document-templates/samples',
    {
      schema: {
        tags: ['documents'],
        summary: 'Starter templates (samples for legal review) that can be copied into the workspace',
        response: {
          200: Type.Array(
            Type.Object({
              key: Type.String(),
              country: Type.String(),
              name: Type.String(),
              category: Type.String(),
              locale: Type.String(),
              /** The workspace's copy, when it has one. */
              templateId: Nullable(Uuid),
            }),
          ),
        },
      },
    },
    async (req) => {
      authorizeSome(req, 'documents.manage');
      return app.tenantTx(
        req,
        async (tx) => {
          const locale = await tenantLocale(tx);
          const copies = await tx.query<{ id: string; sample_key: string }>(
            `SELECT id, sample_key FROM app.document_templates WHERE sample_key IS NOT NULL AND status = 'active' ORDER BY created_at`,
          );
          return SAMPLE_TEMPLATES.map((s) => ({
            key: s.key,
            country: s.country,
            name: t(locale, `docTpl.samples.${s.key}.name`),
            category: s.category,
            locale: s.locale,
            templateId: copies.find((c) => c.sample_key === s.key)?.id ?? null,
          }));
        },
        { readOnly: true },
      );
    },
  );

  app.post(
    '/v1/document-templates/samples/:key',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['documents'],
        summary: 'Copies a starter template into the workspace (labelled as a sample)',
        params: Type.Object({ key: Type.String({ maxLength: 40 }) }),
        response: { 201: Type.Object({ id: Uuid }), 404: Problem, 409: Problem },
      },
    },
    async (req, reply) => {
      authorizeSome(req, 'documents.manage');
      const auth = requireAuth(req);
      const sample = sampleByKey((req.params as { key: string }).key);
      if (!sample) throw new ApiError('notFound');
      const id = await app.tenantTx(req, async (tx) => {
        const existing = await tx.maybe<{ id: string }>(
          `SELECT id FROM app.document_templates WHERE sample_key = $1 AND status = 'active' LIMIT 1`,
          [sample.key],
        );
        if (existing) throw new ApiError('conflict', 'sampleAlreadyCopied', { templateId: existing.id });
        const locale = await tenantLocale(tx);
        const created = await createTemplate(
          tx,
          {
            name: t(locale, `docTpl.samples.${sample.key}.name`),
            body: sample.body,
            locale: sample.locale,
            category: sample.category,
            requiresCountersign: sample.requiresCountersign,
            signingOrder: sample.signingOrder,
            askFields: sample.askFields.map((a) => ({
              ...a,
              label: t(locale, `docTpl.samples.${sample.key}.ask.${a.key}`),
            })),
          },
          auth.userId,
          sample.key,
        );
        await app.audit(tx, req, {
          action: 'document_template.created',
          targetType: 'document_template',
          targetId: created.id,
          diff: { sample: sample.key, version: 1 },
        });
        return created.id;
      });
      return reply.status(201).send({ id });
    },
  );

  app.post(
    '/v1/document-templates',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['documents'],
        body: TemplateBody,
        response: {
          201: Type.Object({
            id: Uuid,
            version: Type.Integer(),
            mergeFields: Type.Array(Type.String()),
            /** Merge fields that are neither known nor ask-when-sending fields (the editor flags them). */
            unknownFields: Type.Array(Type.String()),
          }),
          400: Problem,
          403: Problem,
        },
      },
    },
    async (req, reply) => {
      const auth = authorizeSome(req, 'documents.manage');
      const b = req.body as TemplateInput;
      const row = await app.tenantTx(req, async (tx) => {
        const r = await createTemplate(tx, b, auth.userId);
        await app.audit(tx, req, {
          action: 'document_template.created',
          targetType: 'document_template',
          targetId: r.id,
          diff: { version: 1, category: r.v.category },
        });
        return r;
      });
      return reply.status(201).send({
        id: row.id,
        version: 1,
        mergeFields: fieldsIn(b.body),
        unknownFields: unknownFields(b.body, row.v.askFields),
      });
    },
  );

  app.get(
    '/v1/document-templates/:id',
    {
      schema: {
        tags: ['documents'],
        params: Type.Object({ id: Uuid }),
        response: {
          200: Type.Object({
            ...Summary.properties,
            body: Type.String(),
            unknownFields: Type.Array(Type.String()),
            versions: Type.Array(
              Type.Object({
                version: Type.Integer(),
                createdAt: Type.String(),
                createdByName: Nullable(Type.String()),
              }),
            ),
            /** Documents made from this template, all versions. */
            documents: Type.Integer(),
          }),
          404: Problem,
        },
      },
    },
    async (req) => {
      authorizeSome(req, 'documents.manage');
      const { id } = req.params as { id: string };
      return app.tenantTx(req, async (tx) => {
        const v = await templateVersion(tx, id);
        if (!v) throw new ApiError('notFound');
        const tpl = await tx.one<Parameters<typeof toSummary>[0]>(
          `SELECT t.id, t.name, t.locale, t.category, t.requires_countersign, t.status, t.current_version, t.sample_key, t.signing_order,
                  $2::jsonb AS ask_fields, t.updated_at FROM app.document_templates t WHERE t.id = $1`,
          [id, JSON.stringify(v.ask_fields)],
        );
        const versions = await tx.query<{
          version: number;
          created_at: string;
          created_by_name: string | null;
        }>(
          `SELECT v.version, v.created_at, u.display_name AS created_by_name FROM app.document_template_versions v
             LEFT JOIN app.users u ON u.tenant_id = v.tenant_id AND u.id = v.created_by
            WHERE v.template_id = $1 ORDER BY v.version DESC`,
          [id],
        );
        const docs = await tx.one<{ n: string }>(
          `SELECT count(*)::text AS n FROM app.documents WHERE template_id = $1`,
          [id],
        );
        return {
          ...toSummary({ ...tpl, name: v.name, locale: v.locale, category: v.category }),
          body: v.body,
          unknownFields: unknownFields(v.body, v.ask_fields),
          versions: versions.map((x) => ({
            version: x.version,
            createdAt: new Date(x.created_at).toISOString(),
            createdByName: x.created_by_name,
          })),
          documents: Number(docs.n),
        };
      });
    },
  );

  app.put(
    '/v1/document-templates/:id',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['documents'],
        summary: 'Saves a new version of a template; documents already made keep their version',
        params: Type.Object({ id: Uuid }),
        body: TemplateBody,
        response: {
          200: Type.Object({ id: Uuid, version: Type.Integer(), unknownFields: Type.Array(Type.String()) }),
          404: Problem,
          409: Problem,
        },
      },
    },
    async (req) => {
      const auth = authorizeSome(req, 'documents.manage');
      const { id } = req.params as { id: string };
      const b = req.body as TemplateInput;
      return app.tenantTx(req, async (tx) => {
        const current = await templateVersion(tx, id);
        if (!current) throw new ApiError('notFound');
        if (current.status !== 'active') throw new ApiError('conflict', 'templateArchived');
        await tx.exec('SELECT 1 FROM app.document_templates WHERE id = $1 FOR UPDATE', [id]);
        const category = b.category?.trim() || current.category;
        const v = {
          name: b.name.trim(),
          body: b.body,
          locale: isLocale(b.locale) ? b.locale : current.locale,
          category,
          requiresCountersign: b.requiresCountersign ?? current.requires_countersign,
          signingOrder: isSigningOrder(b.signingOrder) ? b.signingOrder : current.signing_order,
          askFields: b.askFields ? checkAsk(b.askFields) : current.ask_fields,
        };
        const version = current.version + 1;
        await writeVersion(tx, id, version, v, auth.userId);
        // the template row keeps the latest wording for readers that do not know versions (expand phase)
        await tx.exec(
          `UPDATE app.document_templates SET name = $2, body = $3, locale = $4, category = $5, requires_countersign = $6, signing_order = $7,
                  current_version = $8, updated_at = now(), updated_by = $9 WHERE id = $1`,
          [
            id,
            v.name,
            v.body,
            v.locale,
            v.category,
            v.requiresCountersign,
            v.signingOrder,
            version,
            auth.userId,
          ],
        );
        await app.audit(tx, req, {
          action: 'document_template.updated',
          targetType: 'document_template',
          targetId: id,
          diff: { version, previousVersion: current.version, nameChanged: v.name !== current.name },
        });
        return { id, version, unknownFields: unknownFields(v.body, v.askFields) };
      });
    },
  );

  for (const [action, status] of [
    ['archive', 'archived'],
    ['restore', 'active'],
  ] as const)
    app.post(
      `/v1/document-templates/:id/${action}`,
      {
        config: { selfAudited: true },
        schema: {
          tags: ['documents'],
          summary:
            action === 'archive'
              ? 'Archives a template: it can no longer be sent; its documents and versions stay'
              : 'Restores an archived template',
          params: Type.Object({ id: Uuid }),
          response: { 200: Type.Object({ id: Uuid, status: Type.String() }), 404: Problem },
        },
      },
      async (req) => {
        const auth = authorizeSome(req, 'documents.manage');
        const { id } = req.params as { id: string };
        return app.tenantTx(req, async (tx) => {
          const r = await tx.maybe<{ id: string }>(
            `UPDATE app.document_templates SET status = $2, archived_at = CASE WHEN $2 = 'archived' THEN now() END,
                    archived_by = CASE WHEN $2 = 'archived' THEN $3::uuid END WHERE id = $1 RETURNING id`,
            [id, status, auth.userId],
          );
          if (!r) throw new ApiError('notFound');
          await app.audit(tx, req, {
            action: `document_template.${action === 'archive' ? 'archived' : 'restored'}`,
            targetType: 'document_template',
            targetId: id,
          });
          return { id, status };
        });
      },
    );

  // ---- sending: what is missing, and a preview of the filled PDF (16.11) --------------------------------------
  const Prepare = Type.Object({
    employeeId: Uuid,
    /** Values for the ask-when-sending fields. */
    values: Type.Optional(Type.Record(Type.String({ maxLength: 40 }), Type.String({ maxLength: 500 }))),
    employeeSigns: Type.Optional(Type.Boolean()),
    companySigns: Type.Optional(Type.Boolean()),
    signingOrder: Type.Optional(ORDER),
    title: Type.Optional(Type.String({ maxLength: 200 })),
  });
  type PrepareBody = {
    employeeId: string;
    values?: Record<string, string>;
    employeeSigns?: boolean;
    companySigns?: boolean;
    signingOrder?: SigningOrder;
    title?: string;
  };
  const forPerson = async (tx: Tx, req: Parameters<typeof requireAuth>[0], id: string, b: PrepareBody) => {
    const auth = requireAuth(req);
    if (!can(auth.principal, 'documents.manage', await loadTarget(tx, b.employeeId)))
      throw new ApiError('forbidden');
    const v = await templateVersion(tx, id);
    if (!v) throw new ApiError('notFound');
    if (v.status !== 'active') throw new ApiError('conflict', 'templateArchived');
    return v;
  };
  const sendDefaults = (v: VersionRow, b: PrepareBody) => ({
    employeeSigns: b.employeeSigns ?? true,
    companySigns: b.companySigns ?? v.requires_countersign,
    order: isSigningOrder(b.signingOrder) ? b.signingOrder : v.signing_order,
  });

  app.post(
    '/v1/document-templates/:id/prepare',
    {
      schema: {
        tags: ['documents'],
        summary:
          'What sending this template to a person needs: its ask-when-sending fields, the values still missing and the default signing options',
        params: Type.Object({ id: Uuid }),
        body: Prepare,
        response: {
          200: Type.Object({
            templateId: Uuid,
            version: Type.Integer(),
            name: Type.String(),
            category: Type.String(),
            askFields: Type.Array(AskFieldSchema),
            missing: Type.Array(MissingSchema),
            requiresCountersign: Type.Boolean(),
            signingOrder: Type.String(),
            sampleKey: Nullable(Type.String()),
          }),
          403: Problem,
          404: Problem,
          409: Problem,
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const b = req.body as PrepareBody;
      return app.tenantTx(
        req,
        async (tx) => {
          const v = await forPerson(tx, req, id, b);
          const { missing } = await valuesFor(tx, v, b.employeeId, b.values);
          return {
            templateId: id,
            version: v.version,
            name: v.name,
            category: v.category,
            askFields: v.ask_fields,
            missing,
            requiresCountersign: v.requires_countersign,
            signingOrder: v.signing_order,
            sampleKey: v.sample_key,
          };
        },
        { readOnly: true },
      );
    },
  );

  app.post(
    '/v1/document-templates/:id/preview',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['documents'],
        summary:
          'The filled PDF for one person, for the viewer before sending (rendered in the home region, not stored; the preview is audited)',
        params: Type.Object({ id: Uuid }),
        body: Prepare,
        response: { 403: Problem, 404: Problem, 409: Problem },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = req.body as PrepareBody;
      const pdf = await app.tenantTx(req, async (tx) => {
        const v = await forPerson(tx, req, id, b);
        const r = await renderVersionFor(tx, v, b.employeeId, {
          typed: b.values,
          parties: partiesFor(sendDefaults(v, b)),
          title: b.title,
        });
        await app.audit(tx, req, {
          action: 'document_template.previewed',
          targetType: 'document_template',
          targetId: id,
          diff: { employeeId: b.employeeId, version: v.version, missing: r.missing.length },
        });
        return r.bytes;
      });
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', 'inline; filename="preview.pdf"')
        .header('x-content-type-options', 'nosniff')
        .send(Buffer.from(pdf));
    },
  );
}
