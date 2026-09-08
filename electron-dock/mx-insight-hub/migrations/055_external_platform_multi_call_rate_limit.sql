-- One Hub request may legitimately fan out into several paid provider calls
-- (for example one Xiaohongshu search followed by bounded note-detail
-- enrichment).  Keep the customer usage request singular while recording
-- every real dispatch independently.

-- This file is run inside one transaction by server/migrate.mjs. Bound every
-- lock-taking statement, including the first ADD COLUMN, so a rolling deploy
-- fails closed instead of waiting indefinitely behind production writers.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE external_platform.provider_calls
  ADD COLUMN IF NOT EXISTS call_ordinal integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS call_role text NOT NULL DEFAULT 'primary',
  ADD COLUMN IF NOT EXISTS dispatch_fingerprint char(64);

-- Keep the schema compatible with an older Hub pod during a rolling deploy.
-- Older binaries omit dispatch_fingerprint, so the database derives the
-- legacy one-call value. Historical NULLs remain valid and readers coalesce
-- them to request_fingerprint; avoiding a full-table rewrite is intentional.
CREATE OR REPLACE FUNCTION external_platform.default_provider_call_dispatch_fingerprint()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.dispatch_fingerprint IS NULL THEN
    NEW.dispatch_fingerprint := NEW.request_fingerprint;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS provider_calls_default_dispatch_fingerprint
  ON external_platform.provider_calls;
CREATE TRIGGER provider_calls_default_dispatch_fingerprint
BEFORE INSERT ON external_platform.provider_calls
FOR EACH ROW
EXECUTE FUNCTION external_platform.default_provider_call_dispatch_fingerprint();

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'external_platform_provider_calls_ordinal_check'
       AND conrelid = 'external_platform.provider_calls'::regclass
  ) THEN
    ALTER TABLE external_platform.provider_calls
      ADD CONSTRAINT external_platform_provider_calls_ordinal_check
      CHECK (call_ordinal >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'external_platform_provider_calls_role_check'
       AND conrelid = 'external_platform.provider_calls'::regclass
  ) THEN
    ALTER TABLE external_platform.provider_calls
      ADD CONSTRAINT external_platform_provider_calls_role_check
      CHECK (call_role IN ('primary', 'enrichment')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'external_platform_provider_calls_dispatch_fingerprint_check'
       AND conrelid = 'external_platform.provider_calls'::regclass
  ) THEN
    ALTER TABLE external_platform.provider_calls
      ADD CONSTRAINT external_platform_provider_calls_dispatch_fingerprint_check
      CHECK (dispatch_fingerprint IS NULL OR dispatch_fingerprint ~ '^[0-9a-f]{64}$') NOT VALID;
  END IF;
END
$migration$;

-- The repository migration runner executes each file transactionally, so it
-- cannot issue CREATE INDEX CONCURRENTLY. Small installations may build the
-- indexes here. A larger production table must pre-create both indexes with
-- CONCURRENTLY (after adding the three columns above) before rerunning this
-- migration. Validate the catalog state, not just the relation names: an
-- interrupted concurrent build deliberately leaves an invalid same-name index.
-- Fail closed instead of dropping the old uniqueness fence in that state.

DO $indexes$
DECLARE
  provider_calls_bytes bigint;
  usage_index_exists boolean;
  usage_index_ready boolean;
  dispatch_index_exists boolean;
  dispatch_index_ready boolean;
BEGIN
  provider_calls_bytes := pg_total_relation_size('external_platform.provider_calls'::regclass);

  SELECT EXISTS (
    SELECT 1
      FROM pg_class index_relation
      JOIN pg_namespace index_namespace ON index_namespace.oid = index_relation.relnamespace
     WHERE index_namespace.nspname = 'external_platform'
       AND index_relation.relname = 'external_platform_provider_calls_usage_ordinal_idx'
  ) INTO usage_index_exists;
  SELECT EXISTS (
    SELECT 1
      FROM pg_index index_state
      JOIN pg_class index_relation ON index_relation.oid = index_state.indexrelid
      JOIN pg_namespace index_namespace ON index_namespace.oid = index_relation.relnamespace
      JOIN pg_am access_method ON access_method.oid = index_relation.relam
     WHERE index_namespace.nspname = 'external_platform'
       AND index_relation.relname = 'external_platform_provider_calls_usage_ordinal_idx'
       AND index_state.indrelid = 'external_platform.provider_calls'::regclass
       AND index_state.indisunique
       AND index_state.indisvalid
       AND index_state.indisready
       AND index_state.indislive
       AND index_state.indpred IS NULL
       AND index_state.indexprs IS NULL
       AND index_state.indnkeyatts = 2
       AND index_state.indnatts = 2
       AND access_method.amname = 'btree'
       AND (
         SELECT array_agg(attribute.attname::text ORDER BY key_column.ordinality)
           FROM unnest(index_state.indkey::smallint[]) WITH ORDINALITY
                AS key_column(attnum, ordinality)
           JOIN pg_attribute attribute
             ON attribute.attrelid = index_state.indrelid
            AND attribute.attnum = key_column.attnum
          WHERE key_column.ordinality <= index_state.indnkeyatts
       ) = ARRAY['usage_request_id', 'call_ordinal']::text[]
  ) INTO usage_index_ready;

  SELECT EXISTS (
    SELECT 1
      FROM pg_class index_relation
      JOIN pg_namespace index_namespace ON index_namespace.oid = index_relation.relnamespace
     WHERE index_namespace.nspname = 'external_platform'
       AND index_relation.relname = 'external_platform_provider_calls_dispatch_fingerprint_idx'
  ) INTO dispatch_index_exists;
  SELECT EXISTS (
    SELECT 1
      FROM pg_index index_state
      JOIN pg_class index_relation ON index_relation.oid = index_state.indexrelid
      JOIN pg_namespace index_namespace ON index_namespace.oid = index_relation.relnamespace
      JOIN pg_am access_method ON access_method.oid = index_relation.relam
     WHERE index_namespace.nspname = 'external_platform'
       AND index_relation.relname = 'external_platform_provider_calls_dispatch_fingerprint_idx'
       AND index_state.indrelid = 'external_platform.provider_calls'::regclass
       AND NOT index_state.indisunique
       AND index_state.indisvalid
       AND index_state.indisready
       AND index_state.indislive
       AND index_state.indpred IS NULL
       AND index_state.indexprs IS NULL
       AND index_state.indnkeyatts = 5
       AND index_state.indnatts = 5
       AND access_method.amname = 'btree'
       AND (
         SELECT array_agg(attribute.attname::text ORDER BY key_column.ordinality)
           FROM unnest(index_state.indkey::smallint[]) WITH ORDINALITY
                AS key_column(attnum, ordinality)
           JOIN pg_attribute attribute
             ON attribute.attrelid = index_state.indrelid
            AND attribute.attnum = key_column.attnum
          WHERE key_column.ordinality <= index_state.indnkeyatts
       ) = ARRAY[
         'provider_key', 'consumer_id', 'operation', 'dispatch_fingerprint', 'completed_at'
       ]::text[]
       AND pg_index_column_has_property(index_state.indexrelid, 5, 'desc') IS TRUE
  ) INTO dispatch_index_ready;

  IF provider_calls_bytes > 134217728 AND (
    NOT usage_index_ready OR NOT dispatch_index_ready
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'provider_calls is larger than 128 MiB; valid migration 055 indexes must be pre-created CONCURRENTLY before rollout',
      HINT = 'See docs/operations/external-data-platforms.md for the online preparation SQL.';
  END IF;

  IF usage_index_exists AND NOT usage_index_ready THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 055 usage ordinal index exists but is invalid or has the wrong definition',
      HINT = 'Remove the failed index CONCURRENTLY and recreate it with the reviewed runbook before retrying.';
  END IF;
  IF dispatch_index_exists AND NOT dispatch_index_ready THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 055 dispatch fingerprint index exists but is invalid or has the wrong definition',
      HINT = 'Remove the failed index CONCURRENTLY and recreate it with the reviewed runbook before retrying.';
  END IF;

  IF NOT usage_index_exists THEN
    EXECUTE 'CREATE UNIQUE INDEX external_platform_provider_calls_usage_ordinal_idx '
      'ON external_platform.provider_calls (usage_request_id, call_ordinal)';
  END IF;
  IF NOT dispatch_index_exists THEN
    EXECUTE 'CREATE INDEX external_platform_provider_calls_dispatch_fingerprint_idx '
      'ON external_platform.provider_calls '
      '(provider_key, consumer_id, operation, dispatch_fingerprint, completed_at DESC)';
  END IF;

  -- Re-verify indexes built in this transaction before removing the legacy
  -- one-call-per-request fence. This also protects against accidental manual
  -- objects that merely reused the expected names.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index index_state
      JOIN pg_class index_relation ON index_relation.oid = index_state.indexrelid
     WHERE index_relation.oid = to_regclass(
             'external_platform.external_platform_provider_calls_usage_ordinal_idx'
           )
       AND index_state.indrelid = 'external_platform.provider_calls'::regclass
       AND index_state.indisunique
       AND index_state.indisvalid
       AND index_state.indisready
       AND index_state.indislive
       AND index_state.indpred IS NULL
       AND index_state.indexprs IS NULL
       AND index_state.indnkeyatts = 2
       AND index_state.indnatts = 2
       AND (
         SELECT array_agg(attribute.attname::text ORDER BY key_column.ordinality)
           FROM unnest(index_state.indkey::smallint[]) WITH ORDINALITY
                AS key_column(attnum, ordinality)
           JOIN pg_attribute attribute
             ON attribute.attrelid = index_state.indrelid
            AND attribute.attnum = key_column.attnum
          WHERE key_column.ordinality <= index_state.indnkeyatts
       ) = ARRAY['usage_request_id', 'call_ordinal']::text[]
  ) THEN
    RAISE EXCEPTION 'migration 055 could not establish the usage ordinal uniqueness fence';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index index_state
      JOIN pg_class index_relation ON index_relation.oid = index_state.indexrelid
     WHERE index_relation.oid = to_regclass(
             'external_platform.external_platform_provider_calls_dispatch_fingerprint_idx'
           )
       AND index_state.indrelid = 'external_platform.provider_calls'::regclass
       AND NOT index_state.indisunique
       AND index_state.indisvalid
       AND index_state.indisready
       AND index_state.indislive
       AND index_state.indpred IS NULL
       AND index_state.indexprs IS NULL
       AND index_state.indnkeyatts = 5
       AND index_state.indnatts = 5
       AND (
         SELECT array_agg(attribute.attname::text ORDER BY key_column.ordinality)
           FROM unnest(index_state.indkey::smallint[]) WITH ORDINALITY
                AS key_column(attnum, ordinality)
           JOIN pg_attribute attribute
             ON attribute.attrelid = index_state.indrelid
            AND attribute.attnum = key_column.attnum
          WHERE key_column.ordinality <= index_state.indnkeyatts
       ) = ARRAY[
         'provider_key', 'consumer_id', 'operation', 'dispatch_fingerprint', 'completed_at'
       ]::text[]
       AND pg_index_column_has_property(index_state.indexrelid, 5, 'desc') IS TRUE
  ) THEN
    RAISE EXCEPTION 'migration 055 could not establish the dispatch fingerprint index';
  END IF;
END
$indexes$;

DROP INDEX IF EXISTS external_platform.external_platform_provider_calls_usage_idx;

-- A PostgreSQL-clock-driven token bucket protects provider capacity across Hub
-- replicas without the 2x burst at a fixed-window boundary. Admission is
-- deliberately conservative: an admitted token is never refunded after a
-- later pre-dispatch persistence failure.
CREATE TABLE IF NOT EXISTS external_platform.provider_rate_buckets (
  provider_key text PRIMARY KEY
    CHECK (provider_key ~ '^[a-z][a-z0-9._-]{0,63}$'),
  capacity integer NOT NULL CHECK (capacity > 0),
  window_ms integer NOT NULL CHECK (window_ms BETWEEN 1000 AND 3600000),
  tokens double precision NOT NULL CHECK (tokens >= 0 AND tokens <= capacity),
  last_admitted boolean NOT NULL,
  refilled_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (capacity <= 2147483647)
);
