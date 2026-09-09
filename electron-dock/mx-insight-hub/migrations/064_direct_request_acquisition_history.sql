-- Index the pre-connector generic API-search lineage used by acquisition
-- history.  The query intentionally admits only ingest runs linked directly
-- to one durable usage request and carrying neither newer call-ledger FK.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $large_table_preflight$
BEGIN
  IF pg_total_relation_size('ingest.ingest_runs'::regclass) > 134217728
     AND to_regclass('ingest.ingest_runs_request_history_idx') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'ingest_runs is larger than 128 MiB; the migration 064 request-history index must be pre-created CONCURRENTLY',
      HINT = 'Run scripts/acquisition-history-indexes.sql outside a transaction, then retry the migration.';
  END IF;
END
$large_table_preflight$;

DO $index_contract$
DECLARE
  index_exists boolean;
  contract_ready boolean;
BEGIN
  SELECT index_relation.oid IS NOT NULL,
         coalesce(
           index_state.indisvalid
           AND index_state.indisready
           AND index_state.indislive
           AND NOT index_state.indisunique
           AND access_method.amname = 'btree'
           AND table_namespace.nspname = 'ingest'
           AND table_relation.relname = 'ingest_runs'
           AND index_state.indnkeyatts = 3
           AND index_state.indnatts = 3
           AND index_state.indexprs IS NULL
           AND (
             SELECT array_agg(attribute.attname::text ORDER BY key_column.ordinality)
               FROM unnest(index_state.indkey::smallint[]) WITH ORDINALITY
                    AS key_column(attnum, ordinality)
               JOIN pg_attribute attribute
                 ON attribute.attrelid = index_state.indrelid
                AND attribute.attnum = key_column.attnum
              WHERE key_column.ordinality <= index_state.indnkeyatts
           ) = ARRAY['request_id', 'started_at', 'id']::text[]
           AND NOT EXISTS (
             SELECT 1
               FROM unnest(index_state.indoption::smallint[]) option(value)
              WHERE option.value <> 0
           )
           AND regexp_replace(
                 pg_get_expr(index_state.indpred, index_state.indrelid, true),
                 '[()[:space:]"]', '', 'g'
               ) = 'request_idISNOTNULLANDconnector_call_idISNULLANDexternal_platform_call_idISNULL',
           false
         )
    INTO index_exists, contract_ready
    FROM pg_namespace index_namespace
    LEFT JOIN pg_class index_relation
      ON index_relation.relnamespace = index_namespace.oid
     AND index_relation.relname = 'ingest_runs_request_history_idx'
    LEFT JOIN pg_index index_state ON index_state.indexrelid = index_relation.oid
    LEFT JOIN pg_class table_relation ON table_relation.oid = index_state.indrelid
    LEFT JOIN pg_namespace table_namespace ON table_namespace.oid = table_relation.relnamespace
    LEFT JOIN pg_am access_method ON access_method.oid = index_relation.relam
   WHERE index_namespace.nspname = 'ingest';

  IF index_exists AND NOT contract_ready THEN
    RAISE EXCEPTION 'ingest.ingest_runs_request_history_idx is invalid or has the wrong definition';
  END IF;

  IF NOT index_exists THEN
    EXECUTE $sql$
      CREATE INDEX ingest_runs_request_history_idx
        ON ingest.ingest_runs (request_id, started_at, id)
        WHERE request_id IS NOT NULL
          AND connector_call_id IS NULL
          AND external_platform_call_id IS NULL
    $sql$;
  END IF;
END
$index_contract$;

