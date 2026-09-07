-- Explicit per-key scope snapshots and a versioned plan assignment.
--
-- Existing keys keep their legacy dynamic-grant semantics so this additive
-- rollout cannot cut off a working customer or change the old bootstrap flow.
-- Keys issued by the new API use snapshot mode: later consumer grants may
-- narrow them immediately but cannot silently widen them.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS scope_mode text NOT NULL DEFAULT 'legacy_dynamic';

ALTER TABLE api_keys
  DROP CONSTRAINT IF EXISTS api_keys_scope_mode_check;

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_scope_mode_check
  CHECK (scope_mode IN ('legacy_dynamic', 'snapshot'));

CREATE TABLE IF NOT EXISTS api_key_platform_entitlements (
  api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform <> ''),
  max_requests integer NOT NULL CHECK (max_requests > 0),
  window_seconds integer NOT NULL CHECK (window_seconds > 0),
  max_page_size integer NOT NULL CHECK (max_page_size > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (api_key_id, platform)
);

CREATE TABLE IF NOT EXISTS api_key_capability_entitlements (
  api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  capability text NOT NULL CHECK (capability <> ''),
  max_requests integer NOT NULL CHECK (max_requests > 0),
  window_seconds integer NOT NULL CHECK (window_seconds > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (api_key_id, capability)
);

-- Keep the caller-visible idempotency name stable while allowing a deliberately
-- fresh execution (after its replay window, or after a released pre-dispatch
-- attempt) to receive a new immutable usage row.  The previous implementation
-- reused and cleared the old usage_requests row, which collapsed multiple real
-- executions into one metered request and overwrote historical evidence.
CREATE TABLE IF NOT EXISTS usage_idempotency_bindings (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  consumer_id uuid NOT NULL REFERENCES consumers(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE RESTRICT,
  fingerprint char(64) NOT NULL,
  current_request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_id, idempotency_key),
  UNIQUE (current_request_id),
  FOREIGN KEY (current_request_id, tenant_id, consumer_id, api_key_id, fingerprint)
    REFERENCES usage_requests (id, tenant_id, consumer_id, api_key_id, fingerprint)
    ON DELETE RESTRICT
);

INSERT INTO usage_idempotency_bindings
  (tenant_id, consumer_id, idempotency_key, api_key_id, fingerprint, current_request_id,
   created_at, updated_at)
SELECT tenant_id, consumer_id, idempotency_key, api_key_id, fingerprint, id,
       created_at, greatest(created_at, coalesce(completed_at, reserved_at))
  FROM usage_requests
ON CONFLICT (consumer_id, idempotency_key) DO NOTHING;

ALTER TABLE usage_requests
  DROP CONSTRAINT IF EXISTS usage_requests_consumer_id_idempotency_key_key;

CREATE INDEX IF NOT EXISTS usage_requests_idempotency_history_idx
  ON usage_requests (consumer_id, idempotency_key, reserved_at DESC);

DROP TRIGGER IF EXISTS api_keys_snapshot_entitlements_insert ON api_keys;
DROP FUNCTION IF EXISTS snapshot_api_key_entitlements_on_insert();

-- Quota indexes live in scripts/api-key-quota-indexes.sql because this
-- migrator is transactional and production indexes must be built CONCURRENTLY.

CREATE TABLE IF NOT EXISTS plans (
  id uuid PRIMARY KEY,
  plan_key text NOT NULL UNIQUE CHECK (plan_key ~ '^[a-z][a-z0-9._-]{0,63}$'),
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plan_versions (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  limits jsonb NOT NULL CHECK (jsonb_typeof(limits) = 'object'),
  pricing jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(pricing) = 'object'),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, version)
);

ALTER TABLE plan_versions
  DROP CONSTRAINT IF EXISTS plan_versions_limits_contract_check;

ALTER TABLE plan_versions
  ADD CONSTRAINT plan_versions_limits_contract_check CHECK (
    (limits - ARRAY['monthlyRequests', 'maxRequests', 'windowSeconds', 'maxPageSize', 'burstRps']) = '{}'::jsonb
    AND ((limits ? 'maxRequests') = (limits ? 'windowSeconds'))
    AND
    (CASE
      WHEN NOT (limits ? 'monthlyRequests') THEN true
      WHEN jsonb_typeof(limits -> 'monthlyRequests') <> 'number' THEN false
      WHEN (limits ->> 'monthlyRequests') !~ '^[1-9][0-9]*$' THEN false
      ELSE (limits ->> 'monthlyRequests')::numeric <= 2147483647
    END)
    AND (CASE
      WHEN NOT (limits ? 'maxRequests') THEN true
      WHEN jsonb_typeof(limits -> 'maxRequests') <> 'number' THEN false
      WHEN (limits ->> 'maxRequests') !~ '^[1-9][0-9]*$' THEN false
      ELSE (limits ->> 'maxRequests')::numeric <= 2147483647
    END)
    AND (CASE
      WHEN NOT (limits ? 'windowSeconds') THEN true
      WHEN jsonb_typeof(limits -> 'windowSeconds') <> 'number' THEN false
      WHEN (limits ->> 'windowSeconds') !~ '^[1-9][0-9]*$' THEN false
      ELSE (limits ->> 'windowSeconds')::numeric <= 31536000
    END)
    AND (CASE
      WHEN NOT (limits ? 'maxPageSize') THEN true
      WHEN jsonb_typeof(limits -> 'maxPageSize') <> 'number' THEN false
      WHEN (limits ->> 'maxPageSize') !~ '^[1-9][0-9]*$' THEN false
      ELSE (limits ->> 'maxPageSize')::numeric <= 1000
    END)
    AND (CASE
      WHEN NOT (limits ? 'burstRps') THEN true
      WHEN jsonb_typeof(limits -> 'burstRps') <> 'number' THEN false
      WHEN (limits ->> 'burstRps') !~ '^[1-9][0-9]*$' THEN false
      ELSE (limits ->> 'burstRps')::numeric <= 100000
    END)
  );

ALTER TABLE plan_versions
  DROP CONSTRAINT IF EXISTS plan_versions_published_at_check;

ALTER TABLE plan_versions
  ADD CONSTRAINT plan_versions_published_at_check CHECK (
    status <> 'published' OR published_at IS NOT NULL
  );

CREATE TABLE IF NOT EXISTS consumer_plan_assignments (
  consumer_id uuid PRIMARY KEY REFERENCES consumers(id) ON DELETE RESTRICT,
  plan_version_id uuid NOT NULL REFERENCES plan_versions(id) ON DELETE RESTRICT,
  assigned_by text NOT NULL DEFAULT 'migration'
    CHECK (length(btrim(assigned_by)) BETWEEN 1 AND 256),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0)
);

CREATE TABLE IF NOT EXISTS consumer_plan_assignment_events (
  id bigserial PRIMARY KEY,
  consumer_id uuid NOT NULL REFERENCES consumers(id) ON DELETE RESTRICT,
  previous_plan_version_id uuid REFERENCES plan_versions(id) ON DELETE RESTRICT,
  plan_version_id uuid NOT NULL REFERENCES plan_versions(id) ON DELETE RESTRICT,
  assigned_by text NOT NULL CHECK (length(btrim(assigned_by)) BETWEEN 1 AND 256),
  assigned_at timestamptz NOT NULL,
  previous_revision integer CHECK (previous_revision > 0),
  revision integer NOT NULL CHECK (revision > 0),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO plans (id, plan_key, name, status)
VALUES ('da4438fa-f15a-4cf1-94dd-4d2179f91b12', 'launch-1m', 'Launch 1M', 'active')
ON CONFLICT (plan_key) DO NOTHING;

INSERT INTO plans (id, plan_key, name, status)
VALUES ('a6b487df-cc58-4714-bf28-55f17a270dd1', 'legacy-unmetered', 'Legacy (unchanged)', 'active')
ON CONFLICT (plan_key) DO NOTHING;

INSERT INTO plan_versions (id, plan_id, version, status, limits, pricing, published_at)
SELECT 'd8dba62c-7243-48dc-a857-2b8c2672f4f7', id, 1, 'published',
       '{"monthlyRequests":1000000,"maxPageSize":100,"burstRps":100}'::jsonb,
       '{"currency":"CNY","mode":"operator_price_book"}'::jsonb,
       now()
  FROM plans WHERE plan_key = 'launch-1m'
ON CONFLICT (plan_id, version) DO NOTHING;

INSERT INTO plan_versions (id, plan_id, version, status, limits, pricing, published_at)
SELECT '54eefde2-2524-4cc1-9357-99dbcae31cb8', id, 1, 'published',
       '{}'::jsonb,
       '{"currency":"CNY","mode":"legacy_unchanged"}'::jsonb,
       now()
  FROM plans WHERE plan_key = 'legacy-unmetered'
ON CONFLICT (plan_id, version) DO NOTHING;

CREATE OR REPLACE FUNCTION protect_published_plan_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'published' THEN
    RAISE EXCEPTION 'published plan versions are immutable; publish a new version instead'
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS plan_versions_protect_published ON plan_versions;
CREATE TRIGGER plan_versions_protect_published
BEFORE UPDATE OR DELETE ON plan_versions
FOR EACH ROW EXECUTE FUNCTION protect_published_plan_version();

CREATE OR REPLACE FUNCTION record_consumer_plan_assignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO consumer_plan_assignment_events
    (consumer_id, previous_plan_version_id, plan_version_id, assigned_by, assigned_at,
     previous_revision, revision)
  VALUES
    (NEW.consumer_id,
     CASE WHEN TG_OP = 'UPDATE' THEN OLD.plan_version_id ELSE NULL END,
     NEW.plan_version_id, NEW.assigned_by, NEW.assigned_at,
     CASE WHEN TG_OP = 'UPDATE' THEN OLD.revision ELSE NULL END, NEW.revision);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_consumer_plan_assignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'consumer plan assignments cannot be deleted; replace the assignment instead'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.assigned_at > now() THEN
    RAISE EXCEPTION 'consumer plan assignments cannot start in the future'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'consumer plan assignment revision must increase by exactly one'
      USING ERRCODE = '23514';
  END IF;
  PERFORM 1
    FROM plan_versions plan_version_record
    JOIN plans plan ON plan.id = plan_version_record.plan_id
   WHERE plan_version_record.id = NEW.plan_version_id
     AND plan_version_record.status = 'published'
     AND plan.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'consumer plan assignments require an active published plan version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS consumer_plan_assignments_validate ON consumer_plan_assignments;
CREATE TRIGGER consumer_plan_assignments_validate
BEFORE INSERT OR UPDATE OR DELETE ON consumer_plan_assignments
FOR EACH ROW EXECUTE FUNCTION validate_consumer_plan_assignment();

DROP TRIGGER IF EXISTS consumer_plan_assignments_audit ON consumer_plan_assignments;
CREATE TRIGGER consumer_plan_assignments_audit
AFTER INSERT OR UPDATE ON consumer_plan_assignments
FOR EACH ROW EXECUTE FUNCTION record_consumer_plan_assignment();

CREATE OR REPLACE FUNCTION protect_consumer_plan_assignment_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'consumer plan assignment audit events are immutable'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS consumer_plan_assignment_events_immutable
  ON consumer_plan_assignment_events;
CREATE TRIGGER consumer_plan_assignment_events_immutable
BEFORE UPDATE OR DELETE ON consumer_plan_assignment_events
FOR EACH ROW EXECUTE FUNCTION protect_consumer_plan_assignment_event();

CREATE OR REPLACE FUNCTION assign_launch_plan_to_new_consumer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO consumer_plan_assignments (consumer_id, plan_version_id, assigned_by)
  SELECT NEW.id, plan_version_record.id, 'database-default'
    FROM plan_versions plan_version_record
    JOIN plans plan ON plan.id = plan_version_record.plan_id
   WHERE plan.plan_key = 'launch-1m'
     AND plan.status = 'active'
     AND plan_version_record.status = 'published'
   ORDER BY plan_version_record.version DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no published launch-1m plan is available for a new consumer'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS consumers_assign_default_plan ON consumers;
CREATE TRIGGER consumers_assign_default_plan
AFTER INSERT ON consumers
FOR EACH ROW EXECUTE FUNCTION assign_launch_plan_to_new_consumer();

INSERT INTO consumer_plan_assignments (consumer_id, plan_version_id, assigned_by)
SELECT consumer.id, plan_version_record.id, 'migration-grandfather'
  FROM consumers consumer
  CROSS JOIN plan_versions plan_version_record
  JOIN plans plan ON plan.id = plan_version_record.plan_id
 WHERE plan.plan_key = 'legacy-unmetered' AND plan_version_record.version = 1
ON CONFLICT (consumer_id) DO NOTHING;

INSERT INTO external_platform.provider_state (provider_key)
VALUES ('tikhub')
ON CONFLICT (provider_key) DO NOTHING;

INSERT INTO control.external_platform_provider_settings (provider_key, source, revision)
VALUES ('tikhub', 'environment', 0)
ON CONFLICT (provider_key) DO NOTHING;

COMMENT ON TABLE api_key_platform_entitlements IS
  'Issuance-time platform scope and ceiling for a snapshot-mode Hub API key.';
COMMENT ON TABLE api_key_capability_entitlements IS
  'Issuance-time capability scope and ceiling for a snapshot-mode Hub API key.';
COMMENT ON TABLE plan_versions IS
  'Published customer plan versions; assignments point to one immutable version.';
