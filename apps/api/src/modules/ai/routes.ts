import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import { aiModelFor } from '@thapsus/core/ai-models';
import { t, type Locale } from '@thapsus/core/i18n';
import { canSome } from '@thapsus/core/permissions';
import { scrubString } from '@thapsus/core/scrub';
import { enqueueJob, type Tx } from '@thapsus/db';
import { authorizeSome, requireAuth } from '../../http/context';
import { ApiError } from '../../http/errors';
import { Nullable, Problem, Uuid } from '../../http/schemas';
import { objectKey } from '../../lib/object-store';
import { periodic, registerJob } from '../../jobs/registry';
import { throttle } from '../auth/common';
import { sha256 } from '../documents/pdf';
import { requireFeature } from '../../lib/features';
import { aiAssistantEnabled, aiAssistantEntitled, aiConfig, aiSources, updateAiConfig, type AiSources } from './flags';
import { COLLEAGUE_PERSONAL_TOPIC, guardAnswer, guardQuestion, normaliseQuestion, type RefusalReason } from './guard';
import { buildUserTurn, parseModelAnswer, SYSTEM_PROMPT, type Excerpt } from './prompt';
import { redactPeople } from './redact';
import { buildChunks, eligiblePolicyDocs, invalidSources, PERSONAL_CATEGORIES, pruneIndex, retrieve, writeIndex } from './service';

export const QUESTION_MAX = 1_000;
export const MODEL_MAX_TOKENS = 8_000;
const MODEL_TIMEOUT_MS = 60_000;
/** Per-user and per-tenant limits on questions (fixed windows, deps.limiter). */
export const ASK_LIMITS = { perUser: [20, 600] as const, perTenant: [2_000, 3_600] as const };

type Outcome = 'answered' | 'refused' | 'no_answer' | 'unavailable';
type Reason = RefusalReason | 'model_declined' | 'post_model_check';

const Citation = Type.Object({ n: Type.Integer(), documentId: Uuid, title: Type.String(), heading: Nullable(Type.String()), page: Nullable(Type.Integer()) });
const AskOut = Type.Object({
  id: Uuid,
  outcome: Type.Union(['answered', 'refused', 'no_answer', 'unavailable'].map((v) => Type.Literal(v))),
  answer: Nullable(Type.String()),
  message: Nullable(Type.String()),
  refusalReason: Nullable(Type.String()),
  citations: Type.Array(Citation),
  disclosure: Type.String(),
  aiGenerated: Type.Literal(true),
  model: Nullable(Type.String()),
});
const StatusOut = Type.Object({ enabled: Type.Boolean(), available: Type.Boolean(), entitled: Type.Boolean(), canAsk: Type.Boolean(), disclosure: Type.String() });
const SettingsOut = Type.Object({
  enabled: Type.Boolean(),
  available: Type.Boolean(),
  entitled: Type.Boolean(),
  customerEnabled: Type.Boolean(),
  region: Type.String(),
  awsRegion: Type.String(),
  model: Nullable(Type.Object({ name: Type.String(), id: Type.String(), provider: Type.String() })),
  availabilityNote: Nullable(Type.String()),
  sourceUrl: Type.String(),
  verifiedOn: Type.String(),
  canManageFlag: Type.Boolean(),
  canManageSources: Type.Boolean(),
  policyFolderIds: Type.Array(Uuid),
  policyDocumentIds: Type.Array(Uuid),
  folders: Type.Array(Type.Object({ id: Uuid, name: Type.String(), visibility: Type.String() })),
  candidateDocuments: Type.Array(Type.Object({ id: Uuid, title: Type.String(), folderId: Nullable(Uuid) })),
  documents: Type.Array(Type.Object({ id: Uuid, title: Type.String(), contentType: Type.String(), status: Type.String(), chunks: Type.Integer(), sanitisedChunks: Type.Integer(), indexedAt: Nullable(Type.String()) })),
  stats: Type.Object({ questions: Type.Integer(), answered: Type.Integer(), refused: Type.Integer(), noAnswer: Type.Integer(), helpful: Type.Integer(), notHelpful: Type.Integer() }),
});

const questionHash = (tenantId: string, q: string) => createHash('sha256').update(`${tenantId}\n${normaliseQuestion(q)}`).digest('hex');

export async function aiRoutes(app: FastifyInstance) {
  const deps = app.deps;
  const cell = deps.config.cell;
  const model = aiModelFor(cell);
  /** The assistant can run in this cell only with an in-region model and a configured provider. */
  const available = model.available && !!deps.ai;

  const disclosure = (locale: Locale) => t(locale, 'askHr.disclosure');
  const enabledFor = async (tx: Tx) => available && (await aiAssistantEnabled(tx));
  /** 403 featureDisabled unless the platform flag, the region and the customer's opt-in all allow it. */
  const requireAssistant = async (tx: Tx) => {
    await requireFeature(tx, 'aiAssistant');
    if (!(await enabledFor(tx))) throw new ApiError('forbidden', 'featureDisabled', { feature: 'aiAssistant' });
  };

  app.get('/v1/ai/status', { schema: { tags: ['ai'], response: { 200: StatusOut, 401: Problem } } }, async (req) => {
    const auth = requireAuth(req);
    const [enabled, entitled] = await app.tenantTx(req, async (tx) => [await enabledFor(tx), await aiAssistantEntitled(tx)], { readOnly: true });
    return { enabled, available, entitled, canAsk: enabled && canSome(auth.principal, 'ai.ask'), disclosure: disclosure(req.ctx.locale) };
  });

  // ---- admin settings -----------------------------------------------------------------------------------
  async function settingsView(tx: Tx, req: FastifyRequest) {
    const auth = requireAuth(req);
    const [entitled, src] = [await aiAssistantEntitled(tx), await aiConfig(tx)];
    const folders = await tx.query<{ id: string; name: string; visibility: string }>(`SELECT id, name, visibility FROM app.document_folders ORDER BY name, id LIMIT 500`);
    const candidates = await tx.query<{ id: string; title: string; folder_id: string | null }>(
      `SELECT d.id, d.title, d.folder_id FROM app.documents d JOIN app.document_folders f ON f.tenant_id = d.tenant_id AND f.id = d.folder_id
        WHERE d.status = 'ready' AND d.employee_id IS NULL AND f.visibility = 'everyone' AND NOT (d.category = ANY($1::text[])) ORDER BY d.title, d.id LIMIT 500`,
      [PERSONAL_CATEGORIES],
    );
    const eligible = await eligiblePolicyDocs(tx, src);
    const states = new Map(
      (await tx.query<{ document_id: string; sha256: string; status: string; chunk_count: number; sanitised_chunks: number; indexed_at: string }>(`SELECT * FROM app.ai_index_state`)).map((s) => [s.document_id, s]),
    );
    const stats = await tx.one<Record<string, number>>(
      `SELECT count(*)::int AS questions, count(*) FILTER (WHERE outcome = 'answered')::int AS answered, count(*) FILTER (WHERE outcome = 'refused')::int AS refused,
              count(*) FILTER (WHERE outcome = 'no_answer')::int AS "noAnswer", count(*) FILTER (WHERE feedback = 'helpful')::int AS helpful,
              count(*) FILTER (WHERE feedback = 'not_helpful')::int AS "notHelpful"
         FROM app.ai_questions WHERE created_at >= now() - interval '30 days'`,
    );
    return {
      enabled: entitled && src.enabled && available,
      available,
      entitled,
      customerEnabled: src.enabled,
      region: cell,
      awsRegion: model.awsRegion,
      model: model.available ? { name: model.modelName, id: model.modelId, provider: 'Amazon Bedrock' } : null,
      availabilityNote: model.available ? null : model.note,
      sourceUrl: model.sourceUrl,
      verifiedOn: model.verifiedOn,
      canManageFlag: canSome(auth.principal, 'settings.manage'),
      canManageSources: canSome(auth.principal, 'documents.manage'),
      policyFolderIds: src.policyFolderIds,
      policyDocumentIds: src.policyDocumentIds,
      folders,
      candidateDocuments: candidates.map((c) => ({ id: c.id, title: c.title, folderId: c.folder_id })),
      documents: eligible.map((d) => {
        const s = states.get(d.id);
        const current = s && s.sha256 === d.sha256;
        return { id: d.id, title: d.title, contentType: d.content_type, status: current ? s.status : 'pending', chunks: current ? s.chunk_count : 0, sanitisedChunks: current ? s.sanitised_chunks : 0, indexedAt: current ? s.indexed_at : null };
      }),
      stats: stats as { questions: number; answered: number; refused: number; noAnswer: number; helpful: number; notHelpful: number },
    };
  }

  app.get('/v1/ai/settings', { schema: { tags: ['ai'], response: { 200: SettingsOut, 403: Problem } } }, async (req) => {
    const auth = requireAuth(req);
    if (!canSome(auth.principal, 'settings.read') && !canSome(auth.principal, 'documents.manage')) throw new ApiError('forbidden');
    return app.tenantTx(req, (tx) => settingsView(tx, req), { readOnly: true });
  });

  app.put(
    '/v1/ai/settings',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['ai'],
        body: Type.Object({ enabled: Type.Optional(Type.Boolean()), policyFolderIds: Type.Optional(Type.Array(Uuid, { maxItems: 50 })), policyDocumentIds: Type.Optional(Type.Array(Uuid, { maxItems: 500 })) }, { additionalProperties: false }),
        response: { 200: SettingsOut, 403: Problem, 422: Problem },
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const b = req.body as { enabled?: boolean; policyFolderIds?: string[]; policyDocumentIds?: string[] };
      const sourcesChanged = b.policyFolderIds !== undefined || b.policyDocumentIds !== undefined;
      if (b.enabled !== undefined && !canSome(auth.principal, 'settings.manage')) throw new ApiError('forbidden');
      if (sourcesChanged && !canSome(auth.principal, 'documents.manage')) throw new ApiError('forbidden');
      // A region without an in-region model can never turn the assistant on (data must not leave the region).
      if (b.enabled === true && !available) throw new ApiError('unprocessable', 'aiNotAvailableInRegion');
      return app.tenantTx(req, async (tx) => {
        // Turning it on needs the staff-managed entitlement (plan or contract) first.
        if (b.enabled === true) await requireFeature(tx, 'aiAssistant');
        const before = await aiConfig(tx);
        const next: AiSources = { policyFolderIds: b.policyFolderIds ?? before.policyFolderIds, policyDocumentIds: b.policyDocumentIds ?? before.policyDocumentIds };
        if (sourcesChanged) {
          const problem = await invalidSources(tx, next);
          if (problem) throw new ApiError('unprocessable', problem);
          await updateAiConfig(tx, next);
        }
        if (b.enabled !== undefined) await updateAiConfig(tx, { enabled: b.enabled });
        const job = sourcesChanged ? await enqueueJob(tx, 'ai.index_policies', `sources:${req.id}`, {}, { createdBy: auth.userId }) : null;
        await app.audit(tx, req, { action: 'ai.settings_updated', targetType: 'tenant', targetId: auth.tenantId, diff: { before, after: { enabled: b.enabled ?? before.enabled, ...next }, indexJobId: job?.id ?? null } });
        return settingsView(tx, req);
      });
    },
  );

  app.post('/v1/ai/reindex', { config: { selfAudited: true }, schema: { tags: ['ai'], response: { 202: Type.Object({ jobId: Uuid }), 403: Problem } } }, async (req, reply) => {
    const auth = authorizeSome(req, 'documents.manage');
    const job = await app.tenantTx(req, async (tx) => {
      const j = await enqueueJob(tx, 'ai.index_policies', `reindex:${req.id}`, { force: true }, { createdBy: auth.userId });
      await app.audit(tx, req, { action: 'ai.reindex_requested', targetType: 'job', targetId: j.id });
      return j;
    });
    return reply.status(202).send({ jobId: job.id });
  });

  // HR can write a policy straight into a policy folder (stored as a Markdown company document, indexed now).
  app.post(
    '/v1/ai/policy-documents',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['ai'],
        body: Type.Object({ title: Type.String({ minLength: 1, maxLength: 200 }), body: Type.String({ minLength: 1, maxLength: 200_000 }), folderId: Uuid }, { additionalProperties: false }),
        response: { 201: Type.Object({ documentId: Uuid, status: Type.String(), chunks: Type.Integer() }), 403: Problem, 422: Problem },
      },
    },
    async (req, reply) => {
      const auth = authorizeSome(req, 'documents.manage');
      const b = req.body as { title: string; body: string; folderId: string };
      const bytes = Buffer.from(b.body, 'utf8');
      const out = await app.tenantTx(req, async (tx) => {
        const src = await aiSources(tx);
        const folder = await tx.maybe<{ visibility: string }>(`SELECT visibility FROM app.document_folders WHERE id = $1`, [b.folderId]);
        if (!folder || !src.policyFolderIds.includes(b.folderId) || folder.visibility !== 'everyone') throw new ApiError('unprocessable', 'notAPolicyFolder');
        const key = objectKey(auth.tenantId, 'company', '.md');
        await deps.objects.put(key, bytes, 'text/markdown');
        const digest = sha256(bytes);
        const doc = await tx.one<{ id: string }>(
          `INSERT INTO app.documents (tenant_id, folder_id, title, category, file_key, file_name, content_type, size_bytes, sha256, status, created_by, uploaded_at)
           VALUES (app.current_tenant(), $1, $2, 'policy', $3, $4, 'text/markdown', $5, $6, 'ready', $7, now()) RETURNING id`,
          [b.folderId, b.title, key, `${b.title.replace(/[^\w.-]+/g, '_').slice(0, 120)}.md`, bytes.length, digest, auth.userId],
        );
        const res = await buildChunks(deps, { content_type: 'text/markdown', file_key: key }, bytes);
        await writeIndex(tx, { id: doc.id, sha256: digest }, res);
        await app.audit(tx, req, { action: 'ai.policy_document_created', targetType: 'document', targetId: doc.id, diff: { title: b.title, chunks: res.chunks.length } });
        return { documentId: doc.id, status: res.status, chunks: res.chunks.length };
      });
      return reply.status(201).send(out);
    },
  );

  // ---- ask ------------------------------------------------------------------------------------------------
  app.post(
    '/v1/ai/ask',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['ai'],
        body: Type.Object({ question: Type.String({ minLength: 3, maxLength: QUESTION_MAX }) }, { additionalProperties: false }),
        response: { 200: AskOut, 403: Problem, 429: Problem },
      },
    },
    async (req) => {
      const started = performance.now();
      const auth = authorizeSome(req, 'ai.ask');
      const locale = req.ctx.locale;
      const { question } = req.body as { question: string };
      await throttle(deps, [
        [`ai:user:${auth.tenantId}:${auth.userId}`, ASK_LIMITS.perUser[0], ASK_LIMITS.perUser[1]],
        [`ai:tenant:${auth.tenantId}`, ASK_LIMITS.perTenant[0], ASK_LIMITS.perTenant[1]],
      ]);

      type Prepared = { kind: 'refused'; reason: Reason; rule: string } | { kind: 'no_answer' } | { kind: 'model'; question: string; excerpts: Excerpt[] };
      const prepared = await app.tenantTx(
        req,
        async (tx): Promise<Prepared> => {
          await requireAssistant(tx);
          const guard = guardQuestion(question);
          if (!guard.allowed) return { kind: 'refused', reason: guard.reason, rule: guard.rule };
          const red = await redactPeople(tx, [question], auth.principal.employeeId ?? null);
          const q = red.texts[0]!;
          if (red.questionMentionsColleague && COLLEAGUE_PERSONAL_TOPIC.test(normaliseQuestion(question))) return { kind: 'refused', reason: 'about_colleague', rule: 'colleague_personal_topic' };
          const chunks = await retrieve(tx, q, await aiSources(tx));
          if (!chunks.length) return { kind: 'no_answer' };
          const cleaned = (await redactPeople(tx, chunks.flatMap((c) => [c.content, c.title, c.heading ?? '']), auth.principal.employeeId ?? null)).texts;
          const excerpts = chunks.map((c, i) => ({ n: i + 1, documentId: c.document_id, title: cleaned[i * 3 + 1]!, heading: c.heading ? cleaned[i * 3 + 2]! : null, page: c.page, text: cleaned[i * 3]! }));
          return { kind: 'model', question: q, excerpts };
        },
        { readOnly: true },
      );

      let outcome: Outcome;
      let reason: Reason | null = null;
      let rule: string | null = null;
      let answer: string | null = null;
      let cited: Excerpt[] = [];
      let excerptCount = 0;
      let titles = new Map<string, string>();
      if (prepared.kind === 'refused') {
        outcome = 'refused';
        reason = prepared.reason;
        rule = prepared.rule;
      } else if (prepared.kind === 'no_answer') {
        [outcome, rule] = ['no_answer', 'no_sources'];
      } else {
        excerptCount = prepared.excerpts.length;
        try {
          const res = await deps.ai!.complete({ system: SYSTEM_PROMPT, user: buildUserTurn(prepared.question, prepared.excerpts, locale), maxTokens: MODEL_MAX_TOKENS }, { signal: AbortSignal.timeout(MODEL_TIMEOUT_MS) });
          const decision = guardAnswer(res.text);
          if (res.stopReason === 'refusal') [outcome, reason, rule] = ['refused', 'model_declined', 'stop_reason_refusal'];
          else if (decision) [outcome, reason, rule] = ['refused', 'post_model_check', decision];
          else if (res.stopReason === 'max_tokens') [outcome, rule] = ['no_answer', 'max_tokens'];
          else {
            const parsed = parseModelAnswer(res.text, prepared.excerpts);
            if (parsed.kind === 'declined') [outcome, reason, rule] = ['refused', 'model_declined', 'declined_decision'];
            else if (parsed.kind === 'no_answer') [outcome, rule] = ['no_answer', parsed.why];
            else {
              outcome = 'answered';
              answer = parsed.text;
              cited = prepared.excerpts.filter((e) => parsed.cited.includes(e.n));
            }
          }
        } catch (err) {
          req.log.warn({ err: { name: (err as Error).name } }, 'ai provider call failed');
          [outcome, rule] = ['unavailable', 'provider_error'];
        }
      }

      const latencyMs = Math.round(performance.now() - started);
      const citedIds = [...new Set(cited.map((c) => c.documentId))];
      const row = await app.tenantTx(req, async (tx) => {
        if (answer) answer = (await redactPeople(tx, [scrubString(answer)], auth.principal.employeeId ?? null)).texts[0]!;
        if (citedIds.length) titles = new Map((await tx.query<{ id: string; title: string }>(`SELECT id, title FROM app.documents WHERE id = ANY($1::uuid[])`, [citedIds])).map((d) => [d.id, d.title]));
        const q = await tx.one<{ id: string }>(
          `INSERT INTO app.ai_questions (tenant_id, user_id, question_sha256, question_length, outcome, refusal_reason, rule, cited_document_ids, excerpt_count, model_id, latency_ms)
           VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7::uuid[], $8, $9, $10) RETURNING id`,
          [auth.userId, questionHash(auth.tenantId, question), question.length, outcome, reason, rule, citedIds, excerptCount, prepared.kind === 'model' ? deps.ai!.modelId : null, latencyMs],
        );
        // Audit the question without its content.
        await app.audit(tx, req, { action: 'ai.question_asked', targetType: 'ai_question', targetId: q.id, diff: { outcome, refusalReason: reason, citedDocumentIds: citedIds, excerptCount, questionLength: question.length, latencyMs } });
        return q;
      });

      const message =
        outcome === 'answered' ? null
        : outcome === 'refused' ? t(locale, `askHr.refusal.${reason === 'model_declined' || reason === 'post_model_check' ? 'employment_decision' : reason}`)
        : outcome === 'no_answer' ? t(locale, 'askHr.noAnswer')
        : t(locale, 'askHr.unavailable');
      return {
        id: row.id,
        outcome,
        answer,
        message,
        refusalReason: reason,
        citations: cited.map((c) => ({ n: c.n, documentId: c.documentId, title: titles.get(c.documentId) ?? c.title, heading: c.heading, page: c.page })),
        disclosure: disclosure(locale),
        aiGenerated: true as const,
        model: prepared.kind === 'model' ? deps.ai!.modelName : null,
      };
    },
  );

  app.post(
    '/v1/ai/questions/:id/feedback',
    {
      config: { selfAudited: true },
      schema: {
        tags: ['ai'],
        params: Type.Object({ id: Uuid }),
        body: Type.Object({ rating: Type.Union([Type.Literal('helpful'), Type.Literal('not_helpful')]), reason: Type.Optional(Type.Union(['wrong', 'unclear', 'missing_source', 'other'].map((v) => Type.Literal(v)))) }, { additionalProperties: false }),
        response: { 204: Type.Null(), 403: Problem, 404: Problem },
      },
    },
    async (req, reply) => {
      const auth = authorizeSome(req, 'ai.ask');
      const { id } = req.params as { id: string };
      const b = req.body as { rating: 'helpful' | 'not_helpful'; reason?: string };
      await app.tenantTx(req, async (tx) => {
        await requireAssistant(tx);
        const n = await tx.exec(`UPDATE app.ai_questions SET feedback = $2, feedback_reason = $3, feedback_at = now() WHERE id = $1 AND user_id = $4`, [id, b.rating, b.rating === 'not_helpful' ? (b.reason ?? null) : null, auth.userId]);
        if (!n) throw new ApiError('notFound');
        await app.audit(tx, req, { action: 'ai.feedback_given', targetType: 'ai_question', targetId: id, diff: { rating: b.rating, reason: b.reason ?? null } });
      });
      return reply.status(204).send(null);
    },
  );
}

// ---- indexing job (idempotent: unchanged document versions are skipped) -----------------------------------
registerJob('ai.index_policies', async (ctx) => {
  const force = ctx.job.input.force === true;
  const { docs, states } = await ctx.tx(async (tx) => ({
    docs: await eligiblePolicyDocs(tx, await aiSources(tx)),
    states: new Map((await tx.query<{ document_id: string; sha256: string; status: string }>(`SELECT document_id, sha256, status FROM app.ai_index_state`)).map((s) => [s.document_id, s])),
  }));
  const counts = { indexed: 0, skipped: 0, unsupported: 0, failed: 0, empty: 0, pruned: 0 };
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i]!;
    const s = states.get(d.id);
    if (!force && s && s.sha256 === d.sha256 && s.status !== 'failed') {
      counts.skipped++;
      continue;
    }
    const res = await buildChunks(ctx.deps, d);
    await ctx.tx((tx) => writeIndex(tx, d, res));
    counts[res.status]++;
    if (i % 20 === 19) await ctx.progress(i + 1, docs.length);
  }
  counts.pruned = await ctx.tx((tx) => pruneIndex(tx, docs.map((d) => d.id)));
  await ctx.progress(docs.length, docs.length);
  return counts;
});

// Hourly sweep picks up policy documents uploaded through the documents module after configuration.
periodic.push(async (tx, now) => {
  const src = await aiSources(tx);
  if (!src.policyFolderIds.length && !src.policyDocumentIds.length) return;
  await enqueueJob(tx, 'ai.index_policies', `sweep:${now.toISOString().slice(0, 13)}`, {});
});
