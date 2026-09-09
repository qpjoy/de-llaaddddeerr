\set ON_ERROR_STOP on

-- Online preparation/reconciliation for migration 061 acquisition history.
-- Run with psql as a standalone operation. The short additive schema setup is
-- needed only before migration 061; both populated-ledger indexes are built
-- CONCURRENTLY and are therefore deliberately outside the migration runner.
SET lock_timeout = '5s';
-- A timed-out concurrent build can leave an invalid same-name index. The
-- reconciliation below deliberately detects and replaces that artifact, so a
-- deploy retry is safe without letting this operator step run forever.
SET statement_timeout = '15min';

SELECT to_regclass('public.schema_migrations') IS NOT NULL
         AS migration_table_exists \gset
\if :migration_table_exists
  SELECT EXISTS (
           SELECT 1 FROM public.schema_migrations
            WHERE filename = '061_acquisition_query_run_history.sql'
         ) AS migration_061_applied \gset
\else
  \set migration_061_applied false
\endif

SELECT to_regclass('external_platform.gateway_requests') IS NOT NULL
         AS gateway_table_exists,
       to_regclass('core.observations') IS NOT NULL
         AS observations_table_exists \gset

-- Standard deployments stream this file through the mx-common superuser,
-- while migrations run through the mx_insight_hub product role. Functions
-- must be owned by the same role that will later CREATE OR REPLACE them. Derive
-- that role from the existing ledger tables instead of trusting the login
-- role, repair an object left by an interrupted older preflight, then perform
-- every schema mutation as the product owner.
DO $owner_boundary$
DECLARE
  gateway_owner oid;
  observations_owner oid;
  product_owner name;
  function_owner oid;
BEGIN
  SELECT relation.relowner
    INTO gateway_owner
    FROM pg_class relation
   WHERE relation.oid = to_regclass('external_platform.gateway_requests');
  SELECT relation.relowner
    INTO observations_owner
    FROM pg_class relation
   WHERE relation.oid = to_regclass('core.observations');

  IF gateway_owner IS NOT NULL
     AND observations_owner IS NOT NULL
     AND gateway_owner <> observations_owner THEN
    RAISE EXCEPTION 'acquisition-history ledger tables have different owners';
  END IF;

  SELECT pg_get_userbyid(coalesce(gateway_owner, observations_owner))
    INTO product_owner;
  IF product_owner IS NULL THEN
    product_owner := current_user;
  END IF;

  SELECT procedure.proowner
    INTO function_owner
    FROM pg_proc procedure
   WHERE procedure.oid = to_regprocedure(
     'external_platform.capture_gateway_source_provider_call()'
   );
  IF function_owner IS NOT NULL
     AND function_owner <> coalesce(gateway_owner, observations_owner, function_owner) THEN
    EXECUTE format(
      'ALTER FUNCTION external_platform.capture_gateway_source_provider_call() OWNER TO %I',
      product_owner
    );
  END IF;

  SELECT procedure.proowner
    INTO function_owner
    FROM pg_proc procedure
   WHERE procedure.oid = to_regprocedure('core.capture_observation_canonical_revision()');
  IF function_owner IS NOT NULL
     AND function_owner <> coalesce(gateway_owner, observations_owner, function_owner) THEN
    EXECUTE format(
      'ALTER FUNCTION core.capture_observation_canonical_revision() OWNER TO %I',
      product_owner
    );
  END IF;
END
$owner_boundary$;

SELECT pg_get_userbyid(coalesce(
         (SELECT relation.relowner
            FROM pg_class relation
           WHERE relation.oid = to_regclass('external_platform.gateway_requests')),
         (SELECT relation.relowner
            FROM pg_class relation
           WHERE relation.oid = to_regclass('core.observations')),
         (SELECT oid FROM pg_roles WHERE rolname = current_user)
       )) AS acquisition_history_product_owner \gset
SET ROLE :"acquisition_history_product_owner";

-- On an established database, install the nullable evidence columns and their
-- writer triggers before the concurrent builds. This mirrors migration 061 and
-- closes the gap in which rolling old writers could create new unknown rows.
-- A brand-new database may not have either table yet; the normal migration then
-- creates the empty/small table and its index transactionally.
\if :migration_061_applied
  \echo 'migration 061 is already applied; validating acquisition-history indexes only'
\else
  \if :gateway_table_exists
    BEGIN;
    SET LOCAL lock_timeout = '5s';
    SET LOCAL statement_timeout = '30s';

    ALTER TABLE external_platform.gateway_requests
      ADD COLUMN IF NOT EXISTS source_provider_call_id uuid;

    -- Historical values of this new nullable column are necessarily NULL. Keep
    -- the foreign key enforced for all new writes without scanning a populated
    -- gateway ledger under a table lock during online preparation.
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

    COMMIT;
  \else
    \echo 'gateway_requests is not present; migration 051/061 will create its small-table index'
  \endif

  \if :observations_table_exists
    BEGIN;
    SET LOCAL lock_timeout = '5s';
    SET LOCAL statement_timeout = '30s';

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

    COMMIT;
  \else
    \echo 'core.observations is not present; migration 005/061 will create its small-table index'
  \endif
\endif

-- A failed concurrent build can leave an invalid same-name object. A manually
-- replaced object can also have the right name but the wrong keys/predicate.
-- Validate the entire catalog contract, repair only when necessary, then reuse
-- the same view for the final fail-closed assertion.
CREATE TEMP VIEW acquisition_history_index_contract AS
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
    ),
    (
      'ingest',
      'ingest_runs_request_history_idx',
      'ingest_runs',
      ARRAY['request_id', 'started_at', 'id']::text[],
      3,
      'request_idISNOTNULLANDconnector_call_idISNULLANDexternal_platform_call_idISNULL'
    )
)
SELECT expected.index_name,
       target_relation.oid IS NOT NULL AS table_exists,
       coalesce(
         index_state.indisvalid
         AND index_state.indisready
         AND index_state.indislive
         AND NOT index_state.indisunique
         AND access_method.amname = 'btree'
         AND index_state.indrelid = target_relation.oid
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
  LEFT JOIN pg_namespace target_namespace
    ON target_namespace.nspname = expected.schema_name
  LEFT JOIN pg_class target_relation
    ON target_relation.relnamespace = target_namespace.oid
   AND target_relation.relname = expected.table_name
  LEFT JOIN pg_namespace index_namespace
    ON index_namespace.nspname = expected.schema_name
  LEFT JOIN pg_class index_relation
    ON index_relation.relnamespace = index_namespace.oid
   AND index_relation.relname = expected.index_name
  LEFT JOIN pg_index index_state ON index_state.indexrelid = index_relation.oid
  LEFT JOIN pg_am access_method ON access_method.oid = index_relation.relam;

SELECT table_exists AS gateway_table_ready,
       contract_ready AS gateway_index_ready
  FROM acquisition_history_index_contract
 WHERE index_name = 'external_platform_gateway_requests_usage_source_idx' \gset

\if :gateway_table_ready
  \if :gateway_index_ready
    \echo 'external_platform_gateway_requests_usage_source_idx is already valid'
  \else
    DROP INDEX CONCURRENTLY IF EXISTS
      external_platform.external_platform_gateway_requests_usage_source_idx;
    CREATE INDEX CONCURRENTLY external_platform_gateway_requests_usage_source_idx
      ON external_platform.gateway_requests
        (usage_request_id, source_provider_call_id, created_at)
      WHERE usage_request_id IS NOT NULL;
  \endif
\endif

SELECT table_exists AS observations_table_ready,
       contract_ready AS observations_index_ready
  FROM acquisition_history_index_contract
 WHERE index_name = 'observations_ingest_order_idx' \gset

\if :observations_table_ready
  \if :observations_index_ready
    \echo 'observations_ingest_order_idx is already valid'
  \else
    DROP INDEX CONCURRENTLY IF EXISTS core.observations_ingest_order_idx;
    CREATE INDEX CONCURRENTLY observations_ingest_order_idx
      ON core.observations (ingest_run_id, rank, observed_at, id)
      WHERE ingest_run_id IS NOT NULL;
  \endif
\endif

SELECT table_exists AS ingest_runs_table_ready,
       contract_ready AS ingest_runs_index_ready
  FROM acquisition_history_index_contract
 WHERE index_name = 'ingest_runs_request_history_idx' \gset

\if :ingest_runs_table_ready
  \if :ingest_runs_index_ready
    \echo 'ingest_runs_request_history_idx is already valid'
  \else
    DROP INDEX CONCURRENTLY IF EXISTS ingest.ingest_runs_request_history_idx;
    CREATE INDEX CONCURRENTLY ingest_runs_request_history_idx
      ON ingest.ingest_runs (request_id, started_at, id)
      WHERE request_id IS NOT NULL
        AND connector_call_id IS NULL
        AND external_platform_call_id IS NULL;
  \endif
\endif

SELECT index_name, table_exists, contract_ready
  FROM acquisition_history_index_contract
 ORDER BY index_name;

SELECT bool_and(NOT table_exists OR contract_ready)
         AS acquisition_history_indexes_ready
  FROM acquisition_history_index_contract \gset

\if :acquisition_history_indexes_ready
  \echo 'acquisition-history indexes are ready for every existing ledger table'
\else
  \warn 'acquisition-history indexes did not become ready'
  \quit 1
\endif
