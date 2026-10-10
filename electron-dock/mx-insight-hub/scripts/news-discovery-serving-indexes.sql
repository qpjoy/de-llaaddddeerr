\set ON_ERROR_STOP on

-- Hub-only online indexes, reconciled by deploy after migrations and before API
-- rollout. Run in psql outside a transaction; the source database is untouched.
SET lock_timeout = '2s';
SET statement_timeout = '30min';

SELECT pg_try_advisory_lock(hashtext('mx-insight-hub:news-serving-indexes')::bigint)
  AS news_index_lock_acquired \gset
\if :news_index_lock_acquired
\else
  \warn 'another session is reconciling news serving indexes; retry deploy after it completes'
  \quit 1
\endif

-- Name alone is not evidence that a concurrent build finished or that its
-- definition is correct. Only repair interrupted builds of our exact indexes;
-- refuse a conflicting definition rather than removing an unrelated object.
CREATE TEMP VIEW news_serving_index_contract AS
WITH expected (index_name, time_column) AS (
  VALUES ('canonical_news_collected_feed_idx', 'collected_at'),
         ('canonical_news_published_feed_idx', 'event_time')
), inspected AS (
  SELECT e.*,
         c.oid IS NOT NULL AS object_exists,
         coalesce(
           NOT i.indisunique AND NOT i.indisprimary
           AND am.amname = 'btree'
           AND i.indrelid = 'core.canonical_records'::regclass
           AND i.indnkeyatts = 3 AND i.indnatts = 3 AND i.indexprs IS NULL
           AND pg_get_indexdef(c.oid, 1, true) = 'platform'
           AND pg_get_indexdef(c.oid, 2, true) = e.time_column
           AND pg_get_indexdef(c.oid, 3, true) = 'id'
           AND i.indoption[0] = 0 AND i.indoption[1] = 3 AND i.indoption[2] = 3
           AND regexp_replace(
             regexp_replace(pg_get_expr(i.indpred, i.indrelid, true), '::text', '', 'g'),
             '[()[:space:]"]', '', 'g'
           ) = 'deleted_atISNULLANDcontent_type=ANYARRAY[''news'',''news.article'',''news.resolved'',''bbc.article'']',
           false
         ) AS definition_matches,
         coalesce(i.indisvalid AND i.indisready AND i.indislive, false) AS live
    FROM expected e
    LEFT JOIN pg_namespace n ON n.nspname = 'core'
    LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = e.index_name
    LEFT JOIN pg_index i ON i.indexrelid = c.oid
    LEFT JOIN pg_am am ON am.oid = c.relam
)
SELECT *, definition_matches AND live AS contract_ready FROM inspected;

SELECT bool_or(object_exists AND NOT definition_matches) AS news_index_conflict,
       bool_or(NOT contract_ready) AS news_indexes_changed
  FROM news_serving_index_contract \gset
\if :news_index_conflict
  TABLE news_serving_index_contract;
  \warn 'news index definition conflicts with the deployment contract; inspect it before retrying'
  \quit 1
\endif

SELECT format('DROP INDEX CONCURRENTLY core.%I', index_name)
  FROM news_serving_index_contract WHERE definition_matches AND NOT live
  ORDER BY index_name
\gexec

SELECT format($ddl$
  CREATE INDEX CONCURRENTLY %I ON core.canonical_records (platform, %I DESC, id DESC)
  WHERE deleted_at IS NULL AND content_type IN ('news', 'news.article', 'news.resolved', 'bbc.article')
$ddl$, index_name, time_column)
  FROM news_serving_index_contract WHERE NOT contract_ready ORDER BY index_name
\gexec

-- Analyze after a new/repaired index, not on every unchanged deployment.
\if :news_indexes_changed
  SET statement_timeout = '2min';
  ANALYZE core.canonical_records;
  ANALYZE catalog.record_catalog_bindings;
  ANALYZE catalog.source_catalog_entries;
\endif

TABLE news_serving_index_contract;
SELECT count(*) = 2 AND bool_and(contract_ready) AS news_indexes_ready
  FROM news_serving_index_contract \gset
\if :news_indexes_ready
  \echo 'news serving indexes are ready'
\else
  \warn 'news serving indexes did not become ready'
  \quit 1
\endif
SELECT pg_advisory_unlock(hashtext('mx-insight-hub:news-serving-indexes')::bigint);
