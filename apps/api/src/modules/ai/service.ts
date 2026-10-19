import type { Tx } from '@thapsus/db';
import type { Deps } from '../../deps';
import { chunkText, extractPages, INDEXABLE_TYPES, type Chunk } from './extract';
import type { AiSources } from './flags';

/**
 * Categories that mark a document as personal or sensitive. Such documents are never a policy source,
 * even if an admin puts them in a policy folder (they are also excluded because they belong to an
 * employee: personal documents always carry employee_id).
 */
export const PERSONAL_CATEGORIES = [
  'payslip', 'contract', 'immigration', 'health', 'medical', 'fit_note', 'sick_note', 'rtw', 'right_to_work', 'i9', 'i-9',
  'signed', 'letter', 'disability', 'diversity', 'eeo', 'disciplinary', 'grievance', 'performance', 'offer', 'personal',
];

export interface PolicyDoc {
  id: string;
  title: string;
  content_type: string;
  file_key: string;
  sha256: string;
  folder_id: string | null;
}

const ELIGIBLE = `d.status = 'ready' AND d.sha256 IS NOT NULL AND d.employee_id IS NULL AND f.visibility = 'everyone'
  AND NOT (d.category = ANY($1::text[])) AND (d.folder_id = ANY($2::uuid[]) OR d.id = ANY($3::uuid[]))`;

/** The company documents Ask HR may read: ready, company-level, visible to everyone, in a policy source. */
export async function eligiblePolicyDocs(tx: Tx, src: AiSources): Promise<PolicyDoc[]> {
  return tx.query<PolicyDoc>(
    `SELECT d.id, d.title, d.content_type, d.file_key, d.sha256, d.folder_id FROM app.documents d
       JOIN app.document_folders f ON f.tenant_id = d.tenant_id AND f.id = d.folder_id
      WHERE ${ELIGIBLE} ORDER BY d.created_at LIMIT 5000`,
    [PERSONAL_CATEGORIES, src.policyFolderIds, src.policyDocumentIds],
  );
}

/** Why a requested source is not acceptable, or null when every source is acceptable. */
export async function invalidSources(tx: Tx, src: AiSources): Promise<string | null> {
  if (src.policyFolderIds.length) {
    const folders = await tx.query<{ id: string; visibility: string }>(`SELECT id, visibility FROM app.document_folders WHERE id = ANY($1::uuid[])`, [src.policyFolderIds]);
    if (folders.length !== new Set(src.policyFolderIds).size) return 'policyFolderNotFound';
    if (folders.some((f) => f.visibility !== 'everyone')) return 'policyFolderMustBeVisibleToEveryone';
  }
  if (src.policyDocumentIds.length) {
    const docs = await tx.query<{ id: string; employee_id: string | null; category: string; visibility: string | null; status: string }>(
      `SELECT d.id, d.employee_id, d.category, f.visibility, d.status FROM app.documents d
         LEFT JOIN app.document_folders f ON f.tenant_id = d.tenant_id AND f.id = d.folder_id WHERE d.id = ANY($1::uuid[])`,
      [src.policyDocumentIds],
    );
    if (docs.length !== new Set(src.policyDocumentIds).size) return 'policyDocumentNotFound';
    if (docs.some((d) => d.employee_id !== null || PERSONAL_CATEGORIES.includes(d.category))) return 'personalDocumentNotAllowed';
    if (docs.some((d) => d.visibility !== 'everyone')) return 'policyDocumentMustBeVisibleToEveryone';
  }
  return null;
}

export interface IndexResult {
  status: 'indexed' | 'unsupported' | 'failed' | 'empty';
  chunks: Chunk[];
  errorCode?: string;
}

/** Reads and chunks one document (outside any transaction: object storage and PDF parsing can be slow). */
export async function buildChunks(deps: Pick<Deps, 'objects'>, doc: Pick<PolicyDoc, 'content_type' | 'file_key'>, bytes?: Buffer): Promise<IndexResult> {
  if (!INDEXABLE_TYPES.has(doc.content_type)) return { status: 'unsupported', chunks: [] };
  try {
    const data = bytes ?? (await deps.objects.get(doc.file_key));
    const extracted = await extractPages(doc.content_type, data);
    if (!extracted) return { status: 'unsupported', chunks: [] };
    const chunks = chunkText(extracted.pages, extracted.paged);
    return chunks.length ? { status: 'indexed', chunks } : { status: 'empty', chunks: [] };
  } catch (err) {
    return { status: 'failed', chunks: [], errorCode: err instanceof Error ? err.name.slice(0, 60) : 'Error' };
  }
}

/** Replaces a document's chunks and records its index state (idempotent per document version). */
export async function writeIndex(tx: Tx, doc: Pick<PolicyDoc, 'id' | 'sha256'>, res: IndexResult): Promise<void> {
  await tx.exec(`DELETE FROM app.ai_policy_chunks WHERE document_id = $1`, [doc.id]);
  if (res.chunks.length) {
    await tx.exec(
      `INSERT INTO app.ai_policy_chunks (tenant_id, document_id, doc_sha256, ordinal, heading, page, content, sanitised)
       SELECT app.current_tenant(), $1, $2, x.o, x.h, x.p, x.c, x.s
         FROM unnest($3::int[], $4::text[], $5::int[], $6::text[], $7::bool[]) AS x(o, h, p, c, s)`,
      [doc.id, doc.sha256, res.chunks.map((c) => c.ordinal), res.chunks.map((c) => c.heading), res.chunks.map((c) => c.page), res.chunks.map((c) => c.content.slice(0, 4000)), res.chunks.map((c) => c.sanitised)],
    );
  }
  await tx.exec(
    `INSERT INTO app.ai_index_state (tenant_id, document_id, sha256, status, chunk_count, sanitised_chunks, error_code, indexed_at)
     VALUES (app.current_tenant(), $1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (tenant_id, document_id) DO UPDATE SET sha256 = EXCLUDED.sha256, status = EXCLUDED.status, chunk_count = EXCLUDED.chunk_count,
       sanitised_chunks = EXCLUDED.sanitised_chunks, error_code = EXCLUDED.error_code, indexed_at = EXCLUDED.indexed_at`,
    [doc.id, doc.sha256, res.status, res.chunks.length, res.chunks.filter((c) => c.sanitised).length, res.errorCode ?? null],
  );
}

/** Drops chunks and index state of documents that are no longer policy sources. */
export async function pruneIndex(tx: Tx, keepIds: string[]): Promise<number> {
  const a = await tx.exec(`DELETE FROM app.ai_policy_chunks WHERE NOT (document_id = ANY($1::uuid[]))`, [keepIds]);
  await tx.exec(`DELETE FROM app.ai_index_state WHERE NOT (document_id = ANY($1::uuid[]))`, [keepIds]);
  return a;
}

export interface RetrievedChunk {
  document_id: string;
  title: string;
  heading: string | null;
  page: number | null;
  content: string;
  ordinal: number;
  score: number;
}

export const MAX_EXCERPTS = 5;
const FUZZY_THRESHOLD = 0.5;
const STOPWORDS = new Set('a about all am an and any are as at be can could do does for from get got have how i if in is it its me my of on or our should so that the their there they this to us was we what when where which who why will with would you your'.split(' '));

/** The question without stop words and placeholders, for the trigram fallback (null when nothing is left). */
export function significantWords(question: string): string | null {
  const words = question
    .toLowerCase()
    .replace(/\[(?:person|employee number|redacted)\]/gi, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return words.length ? words.join(' ') : null;
}
const MAX_PER_DOCUMENT = 3;
const MAX_EXCERPT_CHARS = 8_000;

/**
 * PostgreSQL full-text search over policy chunks (OR of the question's English lexemes, ranked with
 * ts_rank_cd and a pg_trgm word-similarity boost), with a trigram fallback for misspelt questions.
 * Eligibility is re-checked against app.documents on every query, so a document that stops being a
 * policy source (or becomes personal) is never retrieved even before the index is pruned.
 */
export async function retrieve(tx: Tx, question: string, src: AiSources): Promise<RetrievedChunk[]> {
  if (!src.policyFolderIds.length && !src.policyDocumentIds.length) return [];
  const base = `FROM app.ai_policy_chunks c
      JOIN app.documents d ON d.tenant_id = c.tenant_id AND d.id = c.document_id
      JOIN app.document_folders f ON f.tenant_id = d.tenant_id AND f.id = d.folder_id
     WHERE ${ELIGIBLE} AND c.doc_sha256 = d.sha256`;
  const params = [PERSONAL_CATEGORIES, src.policyFolderIds, src.policyDocumentIds, question];
  let rows = await tx.query<RetrievedChunk>(
    `WITH q AS (
       SELECT to_tsquery('simple', string_agg(quote_literal(l), ' | ')) AS query
         FROM unnest(tsvector_to_array(to_tsvector('english', $4))) AS l
     )
     SELECT c.document_id, d.title, c.heading, c.page, c.content, c.ordinal,
            (ts_rank_cd(c.tsv, q.query, 32) + 0.25 * app.trgm_word_similarity($4, c.content))::float8 AS score
       ${base.replace('FROM app.ai_policy_chunks c', 'FROM q, app.ai_policy_chunks c')} AND q.query IS NOT NULL AND c.tsv @@ q.query
      ORDER BY score DESC, c.document_id, c.ordinal LIMIT 20`,
    params,
  );
  const fuzzy = significantWords(question);
  if (!rows.length && fuzzy) {
    // Misspelt questions: trigram word similarity of the question's significant words, over this
    // tenant's eligible policy chunks only (a bounded scan; policy corpora are small).
    rows = await tx.query<RetrievedChunk>(
      `SELECT * FROM (
         SELECT c.document_id, d.title, c.heading, c.page, c.content, c.ordinal, app.trgm_word_similarity($4, c.content)::float8 AS score ${base}
       ) x WHERE x.score >= $5 ORDER BY x.score DESC, x.document_id, x.ordinal LIMIT 10`,
      [...params.slice(0, 3), fuzzy, FUZZY_THRESHOLD],
    );
  }
  const picked: RetrievedChunk[] = [];
  const perDoc = new Map<string, number>();
  let chars = 0;
  for (const r of rows) {
    if (picked.length >= MAX_EXCERPTS) break;
    const n = perDoc.get(r.document_id) ?? 0;
    if (n >= MAX_PER_DOCUMENT || chars + r.content.length > MAX_EXCERPT_CHARS) continue;
    perDoc.set(r.document_id, n + 1);
    chars += r.content.length;
    picked.push(r);
  }
  return picked;
}
