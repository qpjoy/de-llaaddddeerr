CREATE TABLE IF NOT EXISTS consumer_platform_policies (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  consumer_id uuid NOT NULL REFERENCES consumers(id) ON DELETE CASCADE,
  platform text NOT NULL,
  max_requests integer NOT NULL CHECK (max_requests > 0),
  window_seconds integer NOT NULL CHECK (window_seconds > 0),
  max_page_size integer NOT NULL CHECK (max_page_size > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_id, platform)
);

CREATE INDEX IF NOT EXISTS consumer_platform_policies_tenant_idx
  ON consumer_platform_policies (tenant_id, consumer_id);

-- Preserve the old tenant-wide behavior without deleting or rewriting the
-- legacy table: every currently existing consumer receives the former default.
INSERT INTO consumer_platform_policies
  (tenant_id, consumer_id, platform, max_requests, window_seconds, max_page_size, updated_at)
SELECT p.tenant_id, c.id, p.platform, p.max_requests, p.window_seconds, p.max_page_size, p.updated_at
FROM platform_policies p
JOIN consumers c ON c.tenant_id = p.tenant_id
ON CONFLICT (consumer_id, platform) DO NOTHING;

