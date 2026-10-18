-- Phase 11 (expand only): "Ask HR" assistant. Policy-document text chunks for PostgreSQL full-text and
-- trigram retrieval, per-document index state, and a minimal question log (no question or answer text).

-- Text chunks of the company's policy documents only (never personal documents). Retrieval re-checks
-- eligibility against app.documents on every query; doc_sha256 ties a chunk to the indexed version.
CREATE TABLE app.ai_policy_chunks (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  doc_sha256 text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  heading text CHECK (length(heading) <= 200),
  page integer CHECK (page > 0),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  sanitised boolean NOT NULL DEFAULT false,
  tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(heading, '')), 'A') || setweight(to_tsvector('english', content), 'B')
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, document_id, ordinal),
  FOREIGN KEY (tenant_id, document_id) REFERENCES app.documents (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ai_policy_chunks_tsv ON app.ai_policy_chunks USING gin (tsv);
CREATE INDEX ai_policy_chunks_document ON app.ai_policy_chunks (tenant_id, document_id);
SELECT app.enable_tenant_rls('app.ai_policy_chunks');

-- One row per policy document: makes indexing idempotent (unchanged sha256 = skip) and shows the admin
-- what was indexed, skipped as unsupported, or failed.
CREATE TABLE app.ai_index_state (
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  sha256 text NOT NULL,
  status text NOT NULL CHECK (status IN ('indexed', 'unsupported', 'failed', 'empty')),
  chunk_count integer NOT NULL DEFAULT 0,
  sanitised_chunks integer NOT NULL DEFAULT 0,
  error_code text CHECK (length(error_code) <= 60),
  indexed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES app.documents (tenant_id, id) ON DELETE CASCADE
);
SELECT app.enable_tenant_rls('app.ai_index_state');

-- Minimal record of each question: a hash and the length of the question, what was cited, why it was
-- refused, and latency. Never the question text or the answer text.
CREATE TABLE app.ai_questions (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  question_sha256 text NOT NULL CHECK (question_sha256 ~ '^[0-9a-f]{64}$'),
  question_length integer NOT NULL CHECK (question_length >= 0),
  outcome text NOT NULL CHECK (outcome IN ('answered', 'refused', 'no_answer', 'unavailable')),
  refusal_reason text CHECK (length(refusal_reason) <= 60),
  rule text CHECK (length(rule) <= 60),
  cited_document_ids uuid[] NOT NULL DEFAULT '{}',
  excerpt_count integer NOT NULL DEFAULT 0,
  model_id text CHECK (length(model_id) <= 120),
  latency_ms integer NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  feedback text CHECK (feedback IN ('helpful', 'not_helpful')),
  feedback_reason text CHECK (feedback_reason IN ('wrong', 'unclear', 'missing_source', 'other')),
  feedback_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app.users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ai_questions_created ON app.ai_questions (tenant_id, created_at);
CREATE INDEX ai_questions_user ON app.ai_questions (tenant_id, user_id, created_at);
SELECT app.enable_tenant_rls('app.ai_questions');

-- pg_trgm lives in the public schema, which the application role cannot use (0001 revokes it). This
-- pinned-search-path wrapper exposes only the pure word_similarity() function to the app role; it reads
-- nothing and runs under the caller's RLS context like any expression.
CREATE OR REPLACE FUNCTION app.trgm_word_similarity(a text, b text) RETURNS real
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT public.word_similarity(a, b) $$;
REVOKE ALL ON FUNCTION app.trgm_word_similarity(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.trgm_word_similarity(text, text) TO thapsus_app;
