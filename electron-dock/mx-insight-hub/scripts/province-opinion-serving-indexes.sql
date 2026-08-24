\set ON_ERROR_STOP on

-- Online Hub-local serving indexes for the fixed province-opinion pipeline.
-- Run this file with psql against the Hub database as a standalone operation;
-- do not wrap it in BEGIN/COMMIT.  CREATE/DROP INDEX CONCURRENTLY cannot run in
-- a transaction block.  The source stays paused and no upstream data is read.

-- pg_get_indexdef(index_oid, column_no, pretty) returns only the key expression,
-- not its DESC/NULLS attributes. Keep expressions and pg_index.indoption bits
-- separate, and reuse this dynamic view for both preflight and the final
-- fail-closed assertion so those contracts cannot drift apart.
CREATE TEMP VIEW province_opinion_serving_index_contract AS
WITH expected (
  index_name,
  key_1,
  key_2,
  key_3,
  key_4,
  option_1,
  option_2,
  option_3,
  option_4,
  predicate
) AS (
  VALUES
    (
      'canonical_province_opinion_hot_idx',
      'admin1_code',
      'heat_score',
      'coalesceevent_time,collected_at',
      'id',
      0, 1, 1, 3,
      'dataset_id=''public-opinion.province.v1''andplatform=''public_opinion''andobject_type=''opinion_item''anddeleted_atisnullandadmin1_codeisnotnullandheat_scoreisnotnullandcollected_atisnotnull'
    ),
    (
      'canonical_province_opinion_latest_idx',
      'admin1_code',
      'coalesceevent_time,collected_at',
      'collected_at',
      'id',
      0, 1, 1, 3,
      'dataset_id=''public-opinion.province.v1''andplatform=''public_opinion''andobject_type=''opinion_item''anddeleted_atisnullandadmin1_codeisnotnullandcollected_atisnotnull'
    )
)
SELECT e.index_name,
       coalesce(
         i.indisvalid
         AND i.indisready
         AND i.indislive
         AND am.amname = 'btree'
         AND tn.nspname = 'core'
         AND t.relname = 'canonical_records'
         AND i.indnkeyatts = 4
         AND regexp_replace(lower(pg_get_indexdef(c.oid, 1, true)), '[()[:space:]"]', '', 'g') = e.key_1
         AND regexp_replace(lower(pg_get_indexdef(c.oid, 2, true)), '[()[:space:]"]', '', 'g') = e.key_2
         AND regexp_replace(lower(pg_get_indexdef(c.oid, 3, true)), '[()[:space:]"]', '', 'g') = e.key_3
         AND regexp_replace(lower(pg_get_indexdef(c.oid, 4, true)), '[()[:space:]"]', '', 'g') = e.key_4
         AND i.indoption[0] = e.option_1
         AND i.indoption[1] = e.option_2
         AND i.indoption[2] = e.option_3
         AND i.indoption[3] = e.option_4
         AND regexp_replace(
           regexp_replace(lower(pg_get_expr(i.indpred, i.indrelid, true)), '::text', '', 'g'),
           '[()[:space:]"]', '', 'g'
         ) = e.predicate,
         false
       ) AS contract_ready
  FROM expected e
  LEFT JOIN pg_namespace n
    ON n.nspname = 'core'
  LEFT JOIN pg_class c
    ON c.relnamespace = n.oid
   AND c.relname = e.index_name
  LEFT JOIN pg_index i
    ON i.indexrelid = c.oid
  LEFT JOIN pg_class t
    ON t.oid = i.indrelid
  LEFT JOIN pg_namespace tn
    ON tn.oid = t.relnamespace
  LEFT JOIN pg_am am
    ON am.oid = c.relam;

SELECT contract_ready AS hot_index_ready
  FROM province_opinion_serving_index_contract
 WHERE index_name = 'canonical_province_opinion_hot_idx' \gset

\if :hot_index_ready
  \echo 'canonical_province_opinion_hot_idx is already valid'
\else
  DROP INDEX CONCURRENTLY IF EXISTS core.canonical_province_opinion_hot_idx;
  CREATE INDEX CONCURRENTLY canonical_province_opinion_hot_idx
    ON core.canonical_records (
      admin1_code,
      heat_score DESC NULLS LAST,
      (coalesce(event_time, collected_at)) DESC NULLS LAST,
      id DESC
    )
    WHERE dataset_id = 'public-opinion.province.v1'
      AND platform = 'public_opinion'
      AND object_type = 'opinion_item'
      AND deleted_at IS NULL
      AND admin1_code IS NOT NULL
      AND heat_score IS NOT NULL
      AND collected_at IS NOT NULL;
\endif

SELECT contract_ready AS latest_index_ready
  FROM province_opinion_serving_index_contract
 WHERE index_name = 'canonical_province_opinion_latest_idx' \gset

\if :latest_index_ready
  \echo 'canonical_province_opinion_latest_idx is already valid'
\else
  DROP INDEX CONCURRENTLY IF EXISTS core.canonical_province_opinion_latest_idx;
  CREATE INDEX CONCURRENTLY canonical_province_opinion_latest_idx
    ON core.canonical_records (
      admin1_code,
      (coalesce(event_time, collected_at)) DESC NULLS LAST,
      collected_at DESC NULLS LAST,
      id DESC
    )
    WHERE dataset_id = 'public-opinion.province.v1'
      AND platform = 'public_opinion'
      AND object_type = 'opinion_item'
      AND deleted_at IS NULL
      AND admin1_code IS NOT NULL
      AND collected_at IS NOT NULL;
\endif

SELECT c.relname AS index_name, i.indisready, i.indisvalid
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_index i ON i.indexrelid = c.oid
 WHERE n.nspname = 'core'
   AND c.relname IN (
     'canonical_province_opinion_hot_idx',
     'canonical_province_opinion_latest_idx'
   )
 ORDER BY c.relname;

SELECT count(*) = 2 AND bool_and(contract_ready)
         AS province_opinion_serving_indexes_ready
  FROM province_opinion_serving_index_contract \gset

\if :province_opinion_serving_indexes_ready
  \echo 'province-opinion serving indexes are ready'
\else
  \warn 'province-opinion serving indexes did not become ready'
  \quit 1
\endif
