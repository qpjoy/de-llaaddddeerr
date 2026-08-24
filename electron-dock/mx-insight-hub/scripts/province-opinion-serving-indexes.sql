\set ON_ERROR_STOP on

-- Online Hub-local serving indexes for the fixed province-opinion pipeline.
-- Run this file with psql against the Hub database as a standalone operation;
-- do not wrap it in BEGIN/COMMIT.  CREATE/DROP INDEX CONCURRENTLY cannot run in
-- a transaction block.  The source stays paused and no upstream data is read.

SELECT coalesce((
  SELECT i.indisvalid AND i.indisready
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace tn ON tn.oid = t.relnamespace
    JOIN pg_am am ON am.oid = c.relam
   WHERE n.nspname = 'core'
     AND c.relname = 'canonical_province_opinion_hot_idx'
     AND tn.nspname = 'core'
     AND t.relname = 'canonical_records'
     AND i.indislive
     AND am.amname = 'btree'
     AND i.indnkeyatts = 4
     AND regexp_replace(lower(pg_get_indexdef(c.oid, 1, true)), '[()[:space:]"]', '', 'g') = 'admin1_code'
     AND regexp_replace(lower(pg_get_indexdef(c.oid, 2, true)), '[()[:space:]"]', '', 'g') = 'heat_scoredescnullslast'
     AND regexp_replace(lower(pg_get_indexdef(c.oid, 3, true)), '[()[:space:]"]', '', 'g') = 'coalesceevent_time,collected_atdescnullslast'
     AND regexp_replace(lower(pg_get_indexdef(c.oid, 4, true)), '[()[:space:]"]', '', 'g') = 'iddesc'
     AND regexp_replace(
       regexp_replace(lower(pg_get_expr(i.indpred, i.indrelid, true)), '::text', '', 'g'),
       '[()[:space:]"]', '', 'g'
     ) = 'dataset_id=''public-opinion.province.v1''andplatform=''public_opinion''andobject_type=''opinion_item''anddeleted_atisnullandadmin1_codeisnotnullandheat_scoreisnotnullandcollected_atisnotnull'
), false) AS hot_index_ready \gset

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

SELECT coalesce((
  SELECT i.indisvalid AND i.indisready
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace tn ON tn.oid = t.relnamespace
    JOIN pg_am am ON am.oid = c.relam
   WHERE n.nspname = 'core'
     AND c.relname = 'canonical_province_opinion_latest_idx'
     AND tn.nspname = 'core'
     AND t.relname = 'canonical_records'
     AND i.indislive
     AND am.amname = 'btree'
     AND i.indnkeyatts = 4
     AND regexp_replace(lower(pg_get_indexdef(c.oid, 1, true)), '[()[:space:]"]', '', 'g') = 'admin1_code'
     AND regexp_replace(lower(pg_get_indexdef(c.oid, 2, true)), '[()[:space:]"]', '', 'g') = 'coalesceevent_time,collected_atdescnullslast'
     AND regexp_replace(lower(pg_get_indexdef(c.oid, 3, true)), '[()[:space:]"]', '', 'g') = 'collected_atdescnullslast'
     AND regexp_replace(lower(pg_get_indexdef(c.oid, 4, true)), '[()[:space:]"]', '', 'g') = 'iddesc'
     AND regexp_replace(
       regexp_replace(lower(pg_get_expr(i.indpred, i.indrelid, true)), '::text', '', 'g'),
       '[()[:space:]"]', '', 'g'
     ) = 'dataset_id=''public-opinion.province.v1''andplatform=''public_opinion''andobject_type=''opinion_item''anddeleted_atisnullandadmin1_codeisnotnullandcollected_atisnotnull'
), false) AS latest_index_ready \gset

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
