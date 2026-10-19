-- Explicit acknowledgement binds one permanent v2 successor key before any
-- new usage/procurement. Original unknown evidence and customer holds remain.

-- The FKs lock usage_requests/tenants/consumers/api_keys and the ALTER locks
-- the bindings table while the old public Pod is still serving: fail the
-- deploy fast rather than queue every Hub writer behind a slow transaction.
SET LOCAL lock_timeout = '5s';

CREATE TABLE control.data_search_protocol_retries (
  original_usage_request_id uuid PRIMARY KEY REFERENCES public.usage_requests(id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  consumer_id uuid NOT NULL REFERENCES public.consumers(id),
  api_key_id uuid NOT NULL REFERENCES public.api_keys(id),
  successor_idempotency_key text NOT NULL,
  request_fingerprint char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (consumer_id, successor_idempotency_key)
);
ALTER TABLE control.data_search_protocol_bindings
  ADD COLUMN acknowledged_request_ids uuid[] NOT NULL DEFAULT '{}';
REVOKE ALL ON control.data_search_protocol_retries FROM PUBLIC;
