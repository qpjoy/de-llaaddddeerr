-- Private per-consumer response snapshots; never grant new scopes or alter login tables.
CREATE TABLE external_platform.ipsearch_batches (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  consumer_id uuid NOT NULL REFERENCES consumers(id),
  api_key_id uuid NOT NULL REFERENCES api_keys(id),
  idempotency_key text NOT NULL,
  fingerprint text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (consumer_id, idempotency_key)
);
CREATE INDEX ipsearch_batches_time_idx ON external_platform.ipsearch_batches(created_at);

ALTER TABLE external_platform.ipsearch_request_events ADD COLUMN batch_id uuid REFERENCES external_platform.ipsearch_batches(id);

INSERT INTO control.external_platform_provider_settings (provider_key, source, revision)
VALUES ('ipsearch', 'environment', 0) ON CONFLICT (provider_key) DO NOTHING;
