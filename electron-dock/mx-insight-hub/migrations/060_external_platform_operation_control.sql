-- Versioned runtime control for optional external-provider operations.
--
-- Deployment configuration remains the outer safety boundary (adapter host,
-- emergency contract gate and technical ceilings).  These rows are the
-- authoritative, hot-reloadable desired state inside that boundary.  A
-- provider operation may be blocked without making the Hub or its login plane
-- unready.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE SCHEMA IF NOT EXISTS control;

-- Migration 052 predates the JavaScript-safe evidence boundary. Keep the old
-- ledger online: enforce the bound for every new/changed revision without a
-- validation scan or an unsafe rewrite of any historical row.
DO $credential_revision_boundary$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'external_platform_provider_settings_revision_safe_check'
       AND conrelid = 'control.external_platform_provider_settings'::regclass
  ) THEN
    ALTER TABLE control.external_platform_provider_settings
      ADD CONSTRAINT external_platform_provider_settings_revision_safe_check
      CHECK (revision BETWEEN 0 AND 9007199254740991)
      NOT VALID;
  END IF;
END
$credential_revision_boundary$;

CREATE TABLE IF NOT EXISTS control.external_platform_provider_price_books (
  provider_key text NOT NULL
    CHECK (provider_key ~ '^[a-z][a-z0-9._-]{0,63}$'),
  version bigint NOT NULL CHECK (version BETWEEN 0 AND 9007199254740991),
  source text NOT NULL
    CHECK (source IN ('legacy_environment', 'database')),
  status text NOT NULL
    CHECK (status IN ('inherited', 'reviewed', 'retired')),
  currency char(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  pricing_as_of timestamptz,
  monthly_budget_minor bigint CHECK (
    monthly_budget_minor IS NULL OR monthly_budget_minor BETWEEN 0 AND 9007199254740991
  ),
  monthly_subsidy_budget_minor bigint
    CHECK (
      monthly_subsidy_budget_minor IS NULL
      OR monthly_subsidy_budget_minor BETWEEN 0 AND 9007199254740991
    ),
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_key, version),
  CHECK (
    status <> 'reviewed'
    OR (
      currency IS NOT NULL
      AND pricing_as_of IS NOT NULL
      AND monthly_budget_minor IS NOT NULL
      AND monthly_subsidy_budget_minor IS NOT NULL
      AND reviewed_at IS NOT NULL
    )
  )
);

CREATE TABLE IF NOT EXISTS control.external_platform_provider_price_book_entries (
  provider_key text NOT NULL,
  price_book_version bigint NOT NULL,
  endpoint_key text NOT NULL
    CHECK (endpoint_key ~ '^[a-z][a-z0-9._-]{0,127}$'),
  unit_cost_minor bigint NOT NULL CHECK (unit_cost_minor BETWEEN 1 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_key, price_book_version, endpoint_key),
  FOREIGN KEY (provider_key, price_book_version)
    REFERENCES control.external_platform_provider_price_books(provider_key, version)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS control.external_platform_operation_releases (
  provider_key text NOT NULL
    CHECK (provider_key ~ '^[a-z][a-z0-9._-]{0,63}$'),
  operation_key text NOT NULL
    CHECK (operation_key ~ '^[a-z][a-z0-9._-]{0,127}$'),
  release_revision bigint NOT NULL CHECK (
    release_revision BETWEEN 1 AND 9007199254740991
  ),
  contract_version text NOT NULL CHECK (length(contract_version) BETWEEN 1 AND 255),
  endpoint_keys text[] NOT NULL CHECK (cardinality(endpoint_keys) > 0),
  price_book_version bigint NOT NULL,
  status text NOT NULL DEFAULT 'released'
    CHECK (status IN ('candidate', 'released', 'retired')),
  created_by text NOT NULL DEFAULT 'migration',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_key, operation_key, release_revision),
  FOREIGN KEY (provider_key, price_book_version)
    REFERENCES control.external_platform_provider_price_books(provider_key, version)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS control.external_platform_operation_policies (
  provider_key text NOT NULL,
  operation_key text NOT NULL,
  release_revision bigint NOT NULL CHECK (
    release_revision BETWEEN 1 AND 9007199254740991
  ),
  control_source text NOT NULL DEFAULT 'legacy_environment'
    CHECK (control_source IN ('legacy_environment', 'database')),
  desired_state text NOT NULL DEFAULT 'active'
    CHECK (desired_state IN ('disabled', 'shadow', 'canary', 'active', 'paused')),
  canary_consumer_ids uuid[] NOT NULL DEFAULT '{}',
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
  updated_by text NOT NULL DEFAULT 'migration',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_key, operation_key),
  FOREIGN KEY (provider_key, operation_key, release_revision)
    REFERENCES control.external_platform_operation_releases(
      provider_key, operation_key, release_revision
    )
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS control.external_platform_operation_policy_events (
  event_id uuid PRIMARY KEY,
  provider_key text NOT NULL,
  operation_key text NOT NULL,
  previous_revision bigint CHECK (
    previous_revision IS NULL OR previous_revision BETWEEN 0 AND 9007199254740991
  ),
  revision bigint NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  previous_state text
    CHECK (previous_state IS NULL OR previous_state IN ('disabled', 'shadow', 'canary', 'active', 'paused')),
  desired_state text NOT NULL
    CHECK (desired_state IN ('disabled', 'shadow', 'canary', 'active', 'paused')),
  canary_consumer_ids uuid[] NOT NULL DEFAULT '{}',
  actor text NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_key, operation_key, revision),
  FOREIGN KEY (provider_key, operation_key)
    REFERENCES control.external_platform_operation_policies(provider_key, operation_key)
    ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION control.reject_external_platform_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'external platform evidence rows are append-only'
    USING ERRCODE = '55000';
END
$function$;

CREATE OR REPLACE TRIGGER external_platform_price_book_entries_append_only
BEFORE UPDATE OR DELETE ON control.external_platform_provider_price_book_entries
FOR EACH ROW
EXECUTE FUNCTION control.reject_external_platform_append_only_mutation();

CREATE OR REPLACE TRIGGER external_platform_policy_events_append_only
BEFORE UPDATE OR DELETE ON control.external_platform_operation_policy_events
FOR EACH ROW
EXECUTE FUNCTION control.reject_external_platform_append_only_mutation();

CREATE OR REPLACE FUNCTION control.protect_external_platform_version_status()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'retired' OR NEW.status <> 'retired' THEN
    RAISE EXCEPTION 'external platform version evidence is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF TG_TABLE_NAME = 'external_platform_provider_price_books' THEN
    IF NEW.provider_key IS DISTINCT FROM OLD.provider_key
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.source IS DISTINCT FROM OLD.source
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.pricing_as_of IS DISTINCT FROM OLD.pricing_as_of
       OR NEW.monthly_budget_minor IS DISTINCT FROM OLD.monthly_budget_minor
       OR NEW.monthly_subsidy_budget_minor IS DISTINCT FROM OLD.monthly_subsidy_budget_minor
       OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
       OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'external platform version evidence is immutable'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.provider_key IS DISTINCT FROM OLD.provider_key
     OR NEW.operation_key IS DISTINCT FROM OLD.operation_key
     OR NEW.release_revision IS DISTINCT FROM OLD.release_revision
     OR NEW.contract_version IS DISTINCT FROM OLD.contract_version
     OR NEW.endpoint_keys IS DISTINCT FROM OLD.endpoint_keys
     OR NEW.price_book_version IS DISTINCT FROM OLD.price_book_version
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'external platform version evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE TRIGGER external_platform_price_books_protect
BEFORE UPDATE OR DELETE ON control.external_platform_provider_price_books
FOR EACH ROW
EXECUTE FUNCTION control.protect_external_platform_version_status();

CREATE OR REPLACE TRIGGER external_platform_operation_releases_protect
BEFORE UPDATE OR DELETE ON control.external_platform_operation_releases
FOR EACH ROW
EXECUTE FUNCTION control.protect_external_platform_version_status();

CREATE INDEX IF NOT EXISTS external_platform_operation_policy_events_time_idx
  ON control.external_platform_operation_policy_events
    (provider_key, operation_key, occurred_at DESC);

CREATE OR REPLACE FUNCTION control.enforce_external_platform_active_price_book()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.control_source = 'database'
     AND NEW.desired_state IN ('active', 'canary')
     AND NOT EXISTS (
       SELECT 1
         FROM control.external_platform_operation_releases release
         JOIN control.external_platform_provider_price_books price
           ON price.provider_key = release.provider_key
          AND price.version = release.price_book_version
        WHERE release.provider_key = NEW.provider_key
          AND release.operation_key = NEW.operation_key
          AND release.release_revision = NEW.release_revision
          AND release.status = 'released'
          AND price.source = 'database'
          AND price.status = 'reviewed'
          AND NOT EXISTS (
            SELECT 1
              FROM unnest(release.endpoint_keys) endpoint_key
             WHERE NOT EXISTS (
               SELECT 1
                 FROM control.external_platform_provider_price_book_entries entry
                WHERE entry.provider_key = price.provider_key
                  AND entry.price_book_version = price.version
                  AND entry.endpoint_key = endpoint_key
                  AND entry.unit_cost_minor > 0
             )
          )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'database active/canary policy requires a reviewed positive price book';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS external_platform_active_price_book_guard
  ON control.external_platform_operation_policies;
CREATE TRIGGER external_platform_active_price_book_guard
BEFORE INSERT OR UPDATE OF control_source, desired_state, release_revision
ON control.external_platform_operation_policies
FOR EACH ROW EXECUTE FUNCTION control.enforce_external_platform_active_price_book();

-- Version zero delegates price evidence to the retained environment config.
-- A later reviewed database price book receives a positive version and can be
-- bound by a new operation release without rewriting old policy events.
INSERT INTO control.external_platform_provider_price_books
  (provider_key, version, source, status)
VALUES
  ('justone', 0, 'legacy_environment', 'inherited'),
  ('tikhub', 0, 'legacy_environment', 'inherited')
ON CONFLICT (provider_key, version) DO NOTHING;

INSERT INTO control.external_platform_operation_releases
  (provider_key, operation_key, release_revision, contract_version, endpoint_keys,
   price_book_version, status)
VALUES
  (
    'justone', 'ecommerce.products.search', 1,
    'mx-insight-hub.ecommerce-products.v1',
    ARRAY[
      'taobao-tmall.product-search.v1',
      'jd.product-search.v1',
      'xiaohongshu-ec.product-search.v1',
      'xianyu.product-search.v1'
    ]::text[],
    0, 'released'
  ),
  (
    'tikhub', 'social.posts.resolve', 1,
    'mx-insight-hub.social-post.v1',
    ARRAY['xiaohongshu.image-note-detail.v2']::text[],
    0, 'released'
  ),
  (
    'tikhub', 'social.posts.search', 1,
    'night-all.data-search.v1',
    ARRAY['xiaohongshu.app-v2.search-notes.v1']::text[],
    0, 'released'
  ),
  (
    'tikhub', 'social.users.resolve', 1,
    'night-all.compat.user-info.v1',
    ARRAY[
      'xiaohongshu.app-v2.search-users.v1',
      'xiaohongshu.app-v2.get-user-info.v1'
    ]::text[],
    0, 'released'
  ),
  (
    'tikhub', 'social.users.posts', 1,
    'night-all.compat.crawl.v1',
    ARRAY[
      'xiaohongshu.app-v2.search-users.v1',
      'xiaohongshu.app-v2.get-user-info.v1',
      'xiaohongshu.app-v2.get-user-posted-notes.v1'
    ]::text[],
    0, 'released'
  )
ON CONFLICT (provider_key, operation_key, release_revision) DO NOTHING;

INSERT INTO control.external_platform_operation_policies
  (provider_key, operation_key, release_revision, control_source, desired_state,
   canary_consumer_ids, revision, updated_by)
SELECT provider_key, operation_key, release_revision, 'legacy_environment', 'active',
       '{}'::uuid[], 0, 'migration-060'
  FROM control.external_platform_operation_releases
 WHERE release_revision = 1
   AND provider_key IN ('justone', 'tikhub')
ON CONFLICT (provider_key, operation_key) DO NOTHING;

INSERT INTO control.external_platform_operation_policy_events
  (event_id, provider_key, operation_key, previous_revision, revision,
   previous_state, desired_state, canary_consumer_ids, actor, reason)
SELECT (
         substr(md5(provider_key || ':' || operation_key || ':0'), 1, 8) || '-' ||
         substr(md5(provider_key || ':' || operation_key || ':0'), 9, 4) || '-4' ||
         substr(md5(provider_key || ':' || operation_key || ':0'), 14, 3) || '-8' ||
         substr(md5(provider_key || ':' || operation_key || ':0'), 18, 3) || '-' ||
         substr(md5(provider_key || ':' || operation_key || ':0'), 21, 12)
       )::uuid,
       provider_key, operation_key, NULL, 0, NULL, desired_state,
       canary_consumer_ids, 'migration-060',
       'Seeded in legacy-environment compatibility mode'
  FROM control.external_platform_operation_policies
 WHERE revision = 0
ON CONFLICT (provider_key, operation_key, revision) DO NOTHING;

-- Bind every new upstream call to the immutable control-plane evidence that
-- admitted it.  Existing calls remain NULL because inferring a historical
-- revision or credential would manufacture billing evidence.
ALTER TABLE external_platform.provider_calls
  ADD COLUMN IF NOT EXISTS operation_policy_revision bigint,
  ADD COLUMN IF NOT EXISTS operation_release_revision bigint,
  ADD COLUMN IF NOT EXISTS provider_price_book_version bigint,
  ADD COLUMN IF NOT EXISTS provider_credential_revision bigint;

-- Keep the additive hot-ledger change metadata-only. NOT VALID constraints
-- protect every new write immediately without scanning historical calls while
-- the ALTER TABLE lock is held.
DO $provider_call_safe_integer_boundaries$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'external_platform_provider_calls_policy_revision_safe_check'
       AND conrelid = 'external_platform.provider_calls'::regclass
  ) THEN
    ALTER TABLE external_platform.provider_calls
      ADD CONSTRAINT external_platform_provider_calls_policy_revision_safe_check
      CHECK (
        operation_policy_revision IS NULL
        OR operation_policy_revision BETWEEN 0 AND 9007199254740991
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'external_platform_provider_calls_release_revision_safe_check'
       AND conrelid = 'external_platform.provider_calls'::regclass
  ) THEN
    ALTER TABLE external_platform.provider_calls
      ADD CONSTRAINT external_platform_provider_calls_release_revision_safe_check
      CHECK (
        operation_release_revision IS NULL
        OR operation_release_revision BETWEEN 1 AND 9007199254740991
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'external_platform_provider_calls_price_book_version_safe_check'
       AND conrelid = 'external_platform.provider_calls'::regclass
  ) THEN
    ALTER TABLE external_platform.provider_calls
      ADD CONSTRAINT external_platform_provider_calls_price_book_version_safe_check
      CHECK (
        provider_price_book_version IS NULL
        OR provider_price_book_version BETWEEN 0 AND 9007199254740991
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'external_platform_provider_calls_credential_revision_safe_check'
       AND conrelid = 'external_platform.provider_calls'::regclass
  ) THEN
    ALTER TABLE external_platform.provider_calls
      ADD CONSTRAINT external_platform_provider_calls_credential_revision_safe_check
      CHECK (
        provider_credential_revision IS NULL
        OR provider_credential_revision BETWEEN 0 AND 9007199254740991
      ) NOT VALID;
  END IF;
END
$provider_call_safe_integer_boundaries$;

-- Old Public pods can remain online while this transaction commits. Derive the
-- immutable control snapshot for those writers at INSERT time; new binaries
-- submit the same values explicitly. This closes the mixed-version evidence
-- gap without pausing public traffic or guessing historical rows.
CREATE OR REPLACE FUNCTION external_platform.capture_provider_call_control_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.provider_key IS DISTINCT FROM OLD.provider_key
       OR NEW.operation IS DISTINCT FROM OLD.operation
       OR NEW.operation_policy_revision IS DISTINCT FROM OLD.operation_policy_revision
       OR NEW.operation_release_revision IS DISTINCT FROM OLD.operation_release_revision
       OR NEW.provider_price_book_version IS DISTINCT FROM OLD.provider_price_book_version
       OR NEW.provider_credential_revision IS DISTINCT FROM OLD.provider_credential_revision THEN
      RAISE EXCEPTION 'provider call control evidence is immutable'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.operation_policy_revision IS NULL
     AND NEW.operation_release_revision IS NULL
     AND NEW.provider_price_book_version IS NULL THEN
    SELECT policy.revision,
           release.release_revision,
           release.price_book_version,
           coalesce(settings.revision, 0)
      INTO NEW.operation_policy_revision,
           NEW.operation_release_revision,
           NEW.provider_price_book_version,
           NEW.provider_credential_revision
      FROM control.external_platform_operation_policies policy
      JOIN control.external_platform_operation_releases release
        ON release.provider_key = policy.provider_key
       AND release.operation_key = policy.operation_key
       AND release.release_revision = policy.release_revision
 LEFT JOIN control.external_platform_provider_settings settings
        ON settings.provider_key = policy.provider_key
     WHERE policy.provider_key = NEW.provider_key
       AND policy.operation_key = NEW.operation;
  END IF;

  IF (NEW.operation_policy_revision IS NULL)
     <> (NEW.operation_release_revision IS NULL)
     OR (NEW.operation_policy_revision IS NULL)
        <> (NEW.provider_price_book_version IS NULL)
     OR (NEW.operation_policy_revision IS NULL)
        <> (NEW.provider_credential_revision IS NULL) THEN
    RAISE EXCEPTION 'provider call control evidence must be complete'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE TRIGGER provider_calls_capture_control_evidence
BEFORE INSERT OR UPDATE
ON external_platform.provider_calls
FOR EACH ROW
EXECUTE FUNCTION external_platform.capture_provider_call_control_evidence();

DO $provider_call_lineage$
BEGIN
  -- Repair an interrupted development/preflight version of this not-yet-
  -- released migration whose completeness check covered only three columns.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'external_platform_provider_calls_control_completeness_check'
       AND conrelid = 'external_platform.provider_calls'::regclass
       AND position(
         'provider_credential_revision' IN pg_get_constraintdef(oid)
       ) = 0
  ) THEN
    ALTER TABLE external_platform.provider_calls
      DROP CONSTRAINT external_platform_provider_calls_control_completeness_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'external_platform_provider_calls_control_completeness_check'
       AND conrelid = 'external_platform.provider_calls'::regclass
  ) THEN
    ALTER TABLE external_platform.provider_calls
      ADD CONSTRAINT external_platform_provider_calls_control_completeness_check
      CHECK (
        (
          operation_policy_revision IS NULL
          AND operation_release_revision IS NULL
          AND provider_price_book_version IS NULL
          AND provider_credential_revision IS NULL
        ) OR (
          operation_policy_revision IS NOT NULL
          AND operation_release_revision IS NOT NULL
          AND provider_price_book_version IS NOT NULL
          AND provider_credential_revision IS NOT NULL
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'external_platform_provider_calls_policy_event_fkey'
       AND conrelid = 'external_platform.provider_calls'::regclass
  ) THEN
    ALTER TABLE external_platform.provider_calls
      ADD CONSTRAINT external_platform_provider_calls_policy_event_fkey
      FOREIGN KEY (provider_key, operation, operation_policy_revision)
      REFERENCES control.external_platform_operation_policy_events(
        provider_key, operation_key, revision
      ) ON DELETE RESTRICT NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'external_platform_provider_calls_release_fkey'
       AND conrelid = 'external_platform.provider_calls'::regclass
  ) THEN
    ALTER TABLE external_platform.provider_calls
      ADD CONSTRAINT external_platform_provider_calls_release_fkey
      FOREIGN KEY (provider_key, operation, operation_release_revision)
      REFERENCES control.external_platform_operation_releases(
        provider_key, operation_key, release_revision
      ) ON DELETE RESTRICT NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'external_platform_provider_calls_price_book_fkey'
       AND conrelid = 'external_platform.provider_calls'::regclass
  ) THEN
    ALTER TABLE external_platform.provider_calls
      ADD CONSTRAINT external_platform_provider_calls_price_book_fkey
      FOREIGN KEY (provider_key, provider_price_book_version)
      REFERENCES control.external_platform_provider_price_books(provider_key, version)
      ON DELETE RESTRICT NOT VALID;
  END IF;
END
$provider_call_lineage$;

-- No production query depends on a control-revision range index yet. Building
-- one here would block writers on an established provider-call ledger; add it
-- through a standalone CREATE INDEX CONCURRENTLY operation when a query needs
-- that access path.

REVOKE ALL ON TABLE control.external_platform_provider_price_books FROM PUBLIC;
REVOKE ALL ON TABLE control.external_platform_provider_price_book_entries FROM PUBLIC;
REVOKE ALL ON TABLE control.external_platform_operation_releases FROM PUBLIC;
REVOKE ALL ON TABLE control.external_platform_operation_policies FROM PUBLIC;
REVOKE ALL ON TABLE control.external_platform_operation_policy_events FROM PUBLIC;

COMMENT ON TABLE control.external_platform_operation_policies IS
  'Hot-reloadable desired operation state. Deployment gates and ceilings remain authoritative outer bounds.';
COMMENT ON TABLE control.external_platform_operation_policy_events IS
  'Append-only CAS policy audit trail; in-flight calls keep the revision admitted at request start.';
COMMENT ON TABLE control.external_platform_provider_price_books IS
  'Versioned upstream procurement evidence; version zero inherits retained environment pricing.';
COMMENT ON COLUMN external_platform.provider_calls.operation_policy_revision IS
  'Operation policy revision admitted at call start; immutable for this in-flight call.';
COMMENT ON COLUMN external_platform.provider_calls.operation_release_revision IS
  'Provider operation release revision admitted at call start.';
COMMENT ON COLUMN external_platform.provider_calls.provider_price_book_version IS
  'Upstream price-book version used for cost admission; version zero is legacy environment evidence.';
COMMENT ON COLUMN external_platform.provider_calls.provider_credential_revision IS
  'Credential-settings revision observed at call admission when available; never contains the secret.';
