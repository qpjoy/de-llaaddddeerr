-- Optional metering-only provider. No consumer or Key receives implicit access.
INSERT INTO external_platform.provider_state (provider_key)
VALUES ('ipsearch') ON CONFLICT (provider_key) DO NOTHING;

CREATE TABLE external_platform.ipsearch_request_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  consumer_id uuid NOT NULL REFERENCES consumers(id),
  api_key_id uuid NOT NULL REFERENCES api_keys(id),
  usage_request_id uuid REFERENCES usage_requests(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status integer CHECK (status BETWEEN 100 AND 599),
  error_code text,
  replay boolean NOT NULL DEFAULT false,
  latency_ms integer CHECK (latency_ms >= 0)
);
CREATE INDEX ipsearch_request_events_time_idx ON external_platform.ipsearch_request_events(started_at);
