-- Diagnostic-only, first saved failure per usage request. This table does not
-- settle usage, billing, provider calls, ingestion or idempotency bindings.
CREATE TABLE public.usage_request_failures (
  request_id uuid PRIMARY KEY REFERENCES public.usage_requests(id) ON DELETE CASCADE,
  phase text NOT NULL CHECK (phase IN (
    'admission', 'begin_call', 'provider_request', 'supplier_handoff',
    'project_response', 'stage_evidence', 'finish_step', 'finish_failure',
    'assemble_page', 'build_delivery', 'commit_delivery'
  )),
  sql_state char(5) CHECK (sql_state IS NULL OR sql_state::text ~ '^[0-9A-Z]{5}$'),
  call_id uuid,
  error_class text NOT NULL CHECK (error_class IN (
    'Error', 'TypeError', 'RangeError', 'SyntaxError', 'AppError', 'RapidApiUpstreamError'
  )),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
