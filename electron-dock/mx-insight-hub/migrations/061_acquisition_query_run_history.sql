-- Historical acquisition/query-run bindings.
--
-- This migration deliberately adds references to existing evidence instead of
-- copying response archives or restricted raw payloads into a second ledger.
-- New gateway deliveries retain the provider call that actually produced a
-- cached/fallback response, and new observations retain the canonical revision
-- visible when that observation was written. Legacy NULLs stay unknown rather
-- than being backfilled from mutable current state.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Refuse an unprepared large ledger before taking any table lock. The online
-- preparation script adds the nullable columns/triggers and creates the exact
-- indexes concurrently; merely entering this transaction must never turn into
-- an unexpected blocking index build on a production-sized table.
DO $large_table_preflight$
BEGIN
  IF pg_total_relation_size('external_platform.gateway_requests'::regclass) > 134217728
     AND to_regclass(
       'external_platform.external_platform_gateway_requests_usage_source_idx'
     ) IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'gateway_requests is larger than 128 MiB; the migration 061 history index must be pre-created CONCURRENTLY',
      HINT = 'Run scripts/acquisition-history-indexes.sql outside a transaction, then retry the migration.';
  END IF;

  IF pg_total_relation_size('core.observations'::regclass) > 134217728
     AND to_regclass('core.observations_ingest_order_idx') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'core.observations is larger than 128 MiB; the migration 061 history index must be pre-created CONCURRENTLY',
      HINT = 'Run scripts/acquisition-history-indexes.sql outside a transaction, then retry the migration.';
  END IF;
END
$large_table_preflight$;

ALTER TABLE external_platform.gateway_requests
  ADD COLUMN IF NOT EXISTS source_provider_call_id uuid;

-- The column is new and historical values are NULL. NOT VALID avoids scanning
-- a populated gateway ledger while still enforcing the reference for every
-- value written after this migration begins.
DO $gateway_reference$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'gateway_requests_source_provider_call_id_fkey'
       AND conrelid = 'external_platform.gateway_requests'::regclass
  ) THEN
    ALTER TABLE external_platform.gateway_requests
      ADD CONSTRAINT gateway_requests_source_provider_call_id_fkey
      FOREIGN KEY (source_provider_call_id)
      REFERENCES external_platform.provider_calls(id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END
$gateway_reference$;

CREATE OR REPLACE FUNCTION external_platform.capture_gateway_source_provider_call()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.source_provider_call_id IS DISTINCT FROM OLD.source_provider_call_id
       OR NEW.provider_call_id IS DISTINCT FROM OLD.provider_call_id
       OR NEW.source_mode IS DISTINCT FROM OLD.source_mode
       OR (
         NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id
         AND NEW.snapshot_id IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'gateway request source provider call is immutable'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- A stored fallback can contain both the failed request call and an older
  -- successful snapshot. The snapshot origin is the delivered data source.
  IF NEW.snapshot_id IS NOT NULL AND NEW.source_mode <> 'live' THEN
    SELECT snapshot.last_success_call_id
      INTO NEW.source_provider_call_id
      FROM external_platform.response_snapshots snapshot
     WHERE snapshot.id = NEW.snapshot_id;
  ELSIF NEW.provider_call_id IS NOT NULL THEN
    NEW.source_provider_call_id := NEW.provider_call_id;
  ELSIF NEW.snapshot_id IS NOT NULL THEN
    SELECT snapshot.last_success_call_id
      INTO NEW.source_provider_call_id
      FROM external_platform.response_snapshots snapshot
     WHERE snapshot.id = NEW.snapshot_id;
  ELSE
    NEW.source_provider_call_id := NULL;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE TRIGGER gateway_requests_capture_source_provider_call
BEFORE INSERT OR UPDATE OF source_provider_call_id, provider_call_id, snapshot_id, source_mode
ON external_platform.gateway_requests
FOR EACH ROW
EXECUTE FUNCTION external_platform.capture_gateway_source_provider_call();

ALTER TABLE core.observations
  ADD COLUMN IF NOT EXISTS canonical_revision integer;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'core_observations_canonical_revision_check'
       AND conrelid = 'core.observations'::regclass
  ) THEN
    ALTER TABLE core.observations
      ADD CONSTRAINT core_observations_canonical_revision_check
      CHECK (canonical_revision IS NULL OR canonical_revision > 0) NOT VALID;
  END IF;
END
$migration$;

CREATE OR REPLACE FUNCTION core.capture_observation_canonical_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.record_id IS DISTINCT FROM OLD.record_id
       OR (
         NEW.ingest_run_id IS DISTINCT FROM OLD.ingest_run_id
         AND NEW.ingest_run_id IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'observation canonical record is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.canonical_revision IS DISTINCT FROM OLD.canonical_revision THEN
      RAISE EXCEPTION 'observation canonical revision is immutable'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT record.current_revision
    INTO NEW.canonical_revision
    FROM core.canonical_records record
   WHERE record.id = NEW.record_id;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE TRIGGER observations_capture_canonical_revision
BEFORE INSERT OR UPDATE OF canonical_revision, record_id, ingest_run_id
ON core.observations
FOR EACH ROW
EXECUTE FUNCTION core.capture_observation_canonical_revision();

-- The migration runner is transactional and therefore cannot use CONCURRENTLY.
-- Small installations can build these indexes here. A populated production
-- ledger must run scripts/acquisition-history-indexes.sql first; the standard
-- Kubernetes deploy does that automatically before starting this migration.
-- Validate the complete catalog contract so an invalid concurrent build or a
-- manually drifted same-name object can never satisfy the migration by name.
DO $indexes$
DECLARE
  gateway_requests_bytes bigint;
  observations_bytes bigint;
  gateway_index_exists boolean;
  gateway_index_ready boolean;
  observations_index_exists boolean;
  observations_index_ready boolean;
BEGIN
  gateway_requests_bytes := pg_total_relation_size(
    'external_platform.gateway_requests'::regclass
  );
  observations_bytes := pg_total_relation_size('core.observations'::regclass);

  WITH expected (
    schema_name, index_name, table_name, key_names, key_count, predicate
  ) AS (
    VALUES
      (
        'external_platform',
        'external_platform_gateway_requests_usage_source_idx',
        'gateway_requests',
        ARRAY['usage_request_id', 'source_provider_call_id', 'created_at']::text[],
        3,
        'usage_request_idISNOTNULL'
      ),
      (
        'core',
        'observations_ingest_order_idx',
        'observations',
        ARRAY['ingest_run_id', 'rank', 'observed_at', 'id']::text[],
        4,
        'ingest_run_idISNOTNULL'
      )
  ), states AS (
    SELECT expected.index_name,
           index_relation.oid IS NOT NULL AS index_exists,
           coalesce(
             index_state.indisvalid
             AND index_state.indisready
             AND index_state.indislive
             AND NOT index_state.indisunique
             AND access_method.amname = 'btree'
             AND table_namespace.nspname = expected.schema_name
             AND table_relation.relname = expected.table_name
             AND index_state.indnkeyatts = expected.key_count
             AND index_state.indnatts = expected.key_count
             AND index_state.indexprs IS NULL
             AND (
               SELECT array_agg(attribute.attname::text ORDER BY key_column.ordinality)
                 FROM unnest(index_state.indkey::smallint[]) WITH ORDINALITY
                      AS key_column(attnum, ordinality)
                 JOIN pg_attribute attribute
                   ON attribute.attrelid = index_state.indrelid
                  AND attribute.attnum = key_column.attnum
                WHERE key_column.ordinality <= index_state.indnkeyatts
             ) = expected.key_names
             AND NOT EXISTS (
               SELECT 1
                 FROM unnest(index_state.indoption::smallint[]) option(value)
                WHERE option.value <> 0
             )
             AND regexp_replace(
                   pg_get_expr(index_state.indpred, index_state.indrelid, true),
                   '[()[:space:]"]', '', 'g'
                 ) = expected.predicate,
             false
           ) AS contract_ready
      FROM expected
      LEFT JOIN pg_namespace index_namespace
        ON index_namespace.nspname = expected.schema_name
      LEFT JOIN pg_class index_relation
        ON index_relation.relnamespace = index_namespace.oid
       AND index_relation.relname = expected.index_name
      LEFT JOIN pg_index index_state ON index_state.indexrelid = index_relation.oid
      LEFT JOIN pg_class table_relation ON table_relation.oid = index_state.indrelid
      LEFT JOIN pg_namespace table_namespace ON table_namespace.oid = table_relation.relnamespace
      LEFT JOIN pg_am access_method ON access_method.oid = index_relation.relam
  )
  SELECT bool_or(index_exists) FILTER (
           WHERE index_name = 'external_platform_gateway_requests_usage_source_idx'
         ),
         bool_or(contract_ready) FILTER (
           WHERE index_name = 'external_platform_gateway_requests_usage_source_idx'
         ),
         bool_or(index_exists) FILTER (
           WHERE index_name = 'observations_ingest_order_idx'
         ),
         bool_or(contract_ready) FILTER (
           WHERE index_name = 'observations_ingest_order_idx'
         )
    INTO gateway_index_exists, gateway_index_ready,
         observations_index_exists, observations_index_ready
    FROM states;

  IF gateway_index_exists AND NOT gateway_index_ready THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 061 gateway history index exists but is invalid or has the wrong definition',
      HINT = 'Run scripts/acquisition-history-indexes.sql outside a transaction, then retry the migration.';
  END IF;
  IF observations_index_exists AND NOT observations_index_ready THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 061 observation history index exists but is invalid or has the wrong definition',
      HINT = 'Run scripts/acquisition-history-indexes.sql outside a transaction, then retry the migration.';
  END IF;

  IF gateway_requests_bytes > 134217728 AND NOT gateway_index_ready THEN
    RAISE EXCEPTION USING
      MESSAGE = 'gateway_requests is larger than 128 MiB; the migration 061 history index must be pre-created CONCURRENTLY',
      HINT = 'Run scripts/acquisition-history-indexes.sql outside a transaction, then retry the migration.';
  END IF;
  IF observations_bytes > 134217728 AND NOT observations_index_ready THEN
    RAISE EXCEPTION USING
      MESSAGE = 'core.observations is larger than 128 MiB; the migration 061 history index must be pre-created CONCURRENTLY',
      HINT = 'Run scripts/acquisition-history-indexes.sql outside a transaction, then retry the migration.';
  END IF;

  IF NOT gateway_index_exists THEN
    EXECUTE 'CREATE INDEX external_platform_gateway_requests_usage_source_idx '
      'ON external_platform.gateway_requests '
      '(usage_request_id, source_provider_call_id, created_at) '
      'WHERE usage_request_id IS NOT NULL';
  END IF;
  IF NOT observations_index_exists THEN
    EXECUTE 'CREATE INDEX observations_ingest_order_idx '
      'ON core.observations (ingest_run_id, rank, observed_at, id) '
      'WHERE ingest_run_id IS NOT NULL';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_index index_state
     WHERE index_state.indexrelid = to_regclass(
             'external_platform.external_platform_gateway_requests_usage_source_idx'
           )
       AND index_state.indisvalid
       AND index_state.indisready
       AND index_state.indislive
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_index index_state
     WHERE index_state.indexrelid = to_regclass('core.observations_ingest_order_idx')
       AND index_state.indisvalid
       AND index_state.indisready
       AND index_state.indislive
  ) THEN
    RAISE EXCEPTION 'migration 061 could not establish both acquisition-history indexes';
  END IF;
END
$indexes$;

COMMENT ON COLUMN external_platform.gateway_requests.source_provider_call_id IS
  'Immutable provider call whose data was delivered; differs from provider_call_id on stored fallback. Legacy NULL is unknown, never inferred from a mutable snapshot later.';

COMMENT ON COLUMN core.observations.canonical_revision IS
  'Canonical revision visible when the observation was inserted. Legacy NULL remains unknown unless an exact same-ingest record_revision exists.';
