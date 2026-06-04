CREATE TABLE IF NOT EXISTS hdo_dns_records (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain       text NOT NULL UNIQUE,
  target_host  text NOT NULL,
  enabled      boolean NOT NULL DEFAULT true,
  note         text,
  metadata     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hdo_dns_records_enabled_idx ON hdo_dns_records(enabled);
