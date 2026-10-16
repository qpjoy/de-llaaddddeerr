\set ON_ERROR_STOP on

-- Explicit deployment maintenance only; discovery and Hub migrations never run
-- this source DDL. CONCURRENTLY requires this standalone psql session.
SET lock_timeout = '2s';
SET statement_timeout = '30min';
SET search_path = pg_catalog, pg_temp;
SELECT current_database() = 'agent_data_crawler_platform' AS crawler_source_database_matches
\gset
\if :crawler_source_database_matches
  \echo 'Night-All saved_records source database verified'
\else
  \warn 'refusing to migrate a database other than agent_data_crawler_platform'
  \quit 1
\endif
SHOW transaction_read_only
\gset
\if :transaction_read_only
  \warn 'Night-All saved_records source-index migration requires a writable session'
  \quit 1
\endif
SELECT pg_try_advisory_lock(
  hashtextextended('mx-insight-hub:night-all-saved-records-source-indexes:v1', 0)
) AS crawler_source_index_lock_acquired
\gset
\if :crawler_source_index_lock_acquired
  \echo 'Night-All saved_records source-index migration lock acquired'
\else
  \warn 'another Night-All saved_records source-index migration is running'
  \quit 1
\endif

-- BEGIN CATALOG PREFLIGHT
CREATE TEMP VIEW crawler_source_leaf_catalog AS
SELECT c.oid AS table_oid, n.nspname AS schema_name, c.relname AS table_name,
       c.relkind, c.relispartition,
       NOT EXISTS (SELECT 1 FROM pg_inherits child WHERE child.inhparent = c.oid) AS is_leaf,
       pg_get_expr(c.relpartbound, c.oid, true) AS partition_bound,
       substring(pg_get_expr(c.relpartbound, c.oid, true)
         FROM '^FOR VALUES IN \(''([^'']+)''\)$') AS source_type
  FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE i.inhparent = to_regclass('public.saved_records')
 ORDER BY n.nspname, c.relname
 LIMIT 501;

CREATE FUNCTION pg_temp.assert_crawler_source_leaves() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class p
     WHERE p.oid = to_regclass('public.saved_records') AND p.relkind = 'p'
       AND regexp_replace(pg_get_partkeydef(p.oid), '["[:space:]]', '', 'g') = 'LIST(source_type)'
  ) THEN
    RAISE EXCEPTION 'public.saved_records must be LIST partitioned by source_type';
  END IF;
  IF (SELECT count(*) FROM crawler_source_leaf_catalog) NOT BETWEEN 13 AND 500 THEN
    RAISE EXCEPTION 'saved_records direct partition inventory must contain 13 to 500 entries';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY[
      'automotive', 'finance', 'forum', 'hotspot', 'local_news', 'media',
      'news', 'other', 'recruitment', 'research', 'social', 'technology', 'web'
    ]::text[]) required(source_type)
    WHERE NOT EXISTS (SELECT 1 FROM crawler_source_leaf_catalog leaf
      WHERE leaf.source_type = required.source_type)
  ) THEN
    RAISE EXCEPTION 'a required original saved_records category is missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM crawler_source_leaf_catalog
     WHERE source_type IS NOT NULL AND (
       length(source_type) > 38 OR source_type !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
       OR schema_name <> 'public' OR table_name <> 'saved_records_' || source_type
       OR relkind <> 'r' OR NOT relispartition OR NOT is_leaf
     )
  ) THEN
    RAISE EXCEPTION 'saved_records category must have a canonical single-value ordinary public leaf';
  END IF;
  IF EXISTS (
    SELECT 1 FROM crawler_source_leaf_catalog leaf
    CROSS JOIN (VALUES ('last_seen_at', 'timestamptz'), ('id', 'int4')) required(name, type_name)
    WHERE leaf.source_type IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE a.attrelid = leaf.table_oid AND a.attname = required.name
        AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
        AND n.nspname = 'pg_catalog' AND t.typname = required.type_name
    )
  ) THEN
    RAISE EXCEPTION 'saved_records cursor requires non-null pg_catalog timestamptz last_seen_at and int4 id';
  END IF;
END
$$;
SELECT pg_temp.assert_crawler_source_leaves();

CREATE TEMP TABLE crawler_source_index_expected (
  source_type text PRIMARY KEY,
  table_oid oid NOT NULL UNIQUE,
  table_name text NOT NULL UNIQUE,
  index_name text NOT NULL UNIQUE CHECK (octet_length(index_name) <= 63)
);
INSERT INTO crawler_source_index_expected
SELECT source_type, table_oid, table_name,
       CASE WHEN octet_length(table_name || '_last_seen_at_id_uidx') <= 63
            THEN table_name || '_last_seen_at_id_uidx'
            ELSE 'saved_records_' || left(source_type, 15) || '_' || left(md5(source_type), 12) || '_last_seen_at_id_uidx'
       END
  FROM crawler_source_leaf_catalog
 WHERE source_type IS NOT NULL;

-- DEFAULT and multi-value partitions are reported, never maintained or activated.
SELECT schema_name, table_name, partition_bound, 'unsupported_partition_skipped' AS maintenance
  FROM crawler_source_leaf_catalog WHERE source_type IS NULL;

CREATE TEMP VIEW crawler_source_index_evidence AS
WITH definitions AS (
SELECT expected.table_oid, index_class.oid AS index_oid, index_class.relname AS index_name,
       index_class.relkind, index_state.indisvalid, index_state.indisready, index_state.indislive,
       coalesce(
         index_state.indisunique AND access_method.amname = 'btree'
         AND index_state.indnkeyatts = 2 AND index_state.indnatts = 2
         AND index_state.indexprs IS NULL AND index_state.indpred IS NULL
         AND regexp_replace(pg_get_indexdef(index_class.oid, 1, true), '[()[:space:]"]', '', 'g') = 'last_seen_at'
         AND regexp_replace(pg_get_indexdef(index_class.oid, 2, true), '[()[:space:]"]', '', 'g') = 'id'
         AND index_state.indoption[0] = 0 AND index_state.indoption[1] = 0,
         false
       ) AS exact_shape
  FROM crawler_source_index_expected expected
  LEFT JOIN pg_index index_state ON index_state.indrelid = expected.table_oid
  LEFT JOIN pg_class index_class ON index_class.oid = index_state.indexrelid
  LEFT JOIN pg_am access_method ON access_method.oid = index_class.relam
)
SELECT definitions.*,
       coalesce(exact_shape AND indisvalid AND indisready AND indislive, false) AS contract_ready,
       coalesce(exact_shape AND NOT indisvalid AND indislive AND relkind = 'i'
         AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conindid = index_oid)
         AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = index_oid OR inhparent = index_oid),
         false) AS repairable_invalid_build
  FROM definitions;

CREATE TEMP VIEW crawler_source_index_contract AS
SELECT expected.*,
       reserved.oid IS NOT NULL AS managed_name_exists,
       EXISTS (SELECT 1 FROM crawler_source_index_evidence evidence
               WHERE evidence.table_oid = expected.table_oid AND evidence.index_oid = reserved.oid
                 AND evidence.contract_ready) AS managed_name_ready,
       EXISTS (SELECT 1 FROM crawler_source_index_evidence evidence
               WHERE evidence.table_oid = expected.table_oid AND evidence.index_oid = reserved.oid
                 AND evidence.repairable_invalid_build) AS managed_name_repairable,
       EXISTS (SELECT 1 FROM crawler_source_index_evidence evidence
               WHERE evidence.table_oid = expected.table_oid AND evidence.contract_ready) AS contract_ready
  FROM crawler_source_index_expected expected
  LEFT JOIN pg_class reserved ON reserved.relnamespace = 'public'::regnamespace
                            AND reserved.relname = expected.index_name;
CREATE FUNCTION pg_temp.assert_crawler_source_index_maintenance() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  conflict record;
BEGIN
  -- A failed concurrent REINDEX can leave _ccnew/_ccold (possibly truncated
  -- or numbered). Never silently accumulate or remove these other indexes.
  SELECT evidence.* INTO conflict
    FROM crawler_source_index_evidence evidence
    JOIN crawler_source_index_expected expected USING (table_oid)
   WHERE evidence.exact_shape AND NOT evidence.contract_ready
     AND evidence.index_name <> expected.index_name
   ORDER BY evidence.index_name LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'unmanaged incomplete cursor index % (valid %, ready %, live %); operator review required',
      conflict.index_name, conflict.indisvalid, conflict.indisready, conflict.indislive;
  END IF;
  IF EXISTS (SELECT 1 FROM crawler_source_index_contract
             WHERE managed_name_exists AND NOT managed_name_ready AND NOT managed_name_repairable) THEN
    RAISE EXCEPTION 'a managed cursor index name is occupied by an incompatible or invalid object; operator review required';
  END IF;
  IF EXISTS (SELECT 1 FROM crawler_source_index_contract WHERE managed_name_repairable) THEN
    IF NOT pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') THEN
      RAISE EXCEPTION 'invalid cursor index repair requires visibility of all index builders (pg_read_all_stats or superuser)';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_stat_progress_create_index progress
               JOIN crawler_source_index_contract expected ON expected.table_oid = progress.relid
               WHERE expected.managed_name_repairable AND progress.pid <> pg_backend_pid()
                 AND progress.datid = (SELECT oid FROM pg_database WHERE datname = current_database())) THEN
      RAISE EXCEPTION 'an index builder is active on a cursor repair table; retry after it finishes';
    END IF;
  END IF;
END
$$;
SELECT pg_temp.assert_crawler_source_index_maintenance();
-- END CATALOG PREFLIGHT

SELECT table_name, index_name,
       CASE WHEN managed_name_repairable THEN 'reindex_invalid_concurrently'
            WHEN contract_ready THEN 'reuse_ready_index'
            ELSE 'create_concurrently' END AS maintenance
  FROM crawler_source_index_contract ORDER BY table_name;

-- Concurrent builds legitimately wait for existing writers and old snapshots.
-- Keep the per-statement 30 minute ceiling, not the catalog's 2 second lock cap.
-- Do not run separate manual source DDL alongside this maintenance session.
SET lock_timeout = '0';
\echo 'concurrent source index maintenance: each statement is limited to 30 minutes'
\set ECHO queries
-- BEGIN CONCURRENT INDEX PLAN
SELECT CASE WHEN managed_name_repairable
            THEN format('REINDEX INDEX CONCURRENTLY public.%I', index_name)
            ELSE format('CREATE UNIQUE INDEX CONCURRENTLY %I ON public.%I (last_seen_at, id)', index_name, table_name)
       END
  FROM crawler_source_index_contract
 WHERE managed_name_repairable OR NOT contract_ready
 ORDER BY table_name
\gexec
-- END CONCURRENT INDEX PLAN
\set ECHO none
SET lock_timeout = '2s';

-- BEGIN FINAL VERIFICATION
SELECT pg_temp.assert_crawler_source_leaves();
SELECT pg_temp.assert_crawler_source_index_maintenance();
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM crawler_source_index_expected expected
    FULL JOIN (SELECT * FROM crawler_source_leaf_catalog WHERE source_type IS NOT NULL) leaf
      ON leaf.source_type = expected.source_type
    WHERE leaf.table_oid IS DISTINCT FROM expected.table_oid
       OR leaf.table_name IS DISTINCT FROM expected.table_name
  ) THEN
    RAISE EXCEPTION 'saved_records partition inventory changed during index maintenance; re-inspect before retrying';
  END IF;
  IF EXISTS (SELECT 1 FROM crawler_source_index_contract
             WHERE NOT contract_ready OR (managed_name_exists AND NOT managed_name_ready)) THEN
    RAISE EXCEPTION 'Night-All saved_records source indexes did not become ready';
  END IF;
END
$$;
SELECT table_name, index_name, contract_ready FROM crawler_source_index_contract ORDER BY table_name;
-- END FINAL VERIFICATION
\echo 'all supported Night-All saved_records source indexes are ready; writer guarantees remain a separate review'
