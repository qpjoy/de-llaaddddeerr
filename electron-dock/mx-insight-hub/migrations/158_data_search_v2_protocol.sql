-- Additive protocol ownership only. Existing usage/billing/replay rows are
-- never rewritten and no platform, identity, grant or operation is enabled.
CREATE TABLE control.data_search_protocol_bindings (
  consumer_id uuid NOT NULL REFERENCES public.consumers(id),
  idempotency_key text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  api_key_id uuid NOT NULL REFERENCES public.api_keys(id),
  platform text NOT NULL,
  query_hash char(64) NOT NULL,
  fingerprint char(64) NOT NULL,
  request_body jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('running','retryable','complete','failed','unknown')),
  owner_id uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  result jsonb,
  error jsonb,
  usage_request_id uuid REFERENCES public.usage_requests(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_id, idempotency_key)
);
CREATE INDEX data_search_protocol_query ON control.data_search_protocol_bindings
  (tenant_id, consumer_id, api_key_id, platform, query_hash, state);
CREATE INDEX data_search_protocol_usage ON control.data_search_protocol_bindings (usage_request_id);
CREATE TABLE control.data_search_protocol_leases (
  owner_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  consumer_id uuid NOT NULL,
  api_key_id uuid NOT NULL,
  platform text NOT NULL,
  query_hash char(64) NOT NULL,
  idempotency_key text NOT NULL,
  version smallint NOT NULL CHECK (version IN (1,2)),
  expires_at timestamptz NOT NULL
);
CREATE INDEX data_search_protocol_lease_scope ON control.data_search_protocol_leases
  (tenant_id, consumer_id, api_key_id, platform, query_hash, expires_at);
CREATE INDEX data_search_protocol_lease_key ON control.data_search_protocol_leases (consumer_id, idempotency_key);
REVOKE ALL ON control.data_search_protocol_bindings, control.data_search_protocol_leases FROM PUBLIC;
