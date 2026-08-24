\set ON_ERROR_STOP on

-- Online Hub-local serving indexes for canonical Telegram message context.
-- Run this file with psql as a standalone operation; CREATE/DROP INDEX
-- CONCURRENTLY cannot run in a transaction block. The source stays paused and
-- no upstream data is read.
SET lock_timeout = '2s';
SET statement_timeout = '0';

-- A concurrent build can leave an invalid same-name index behind. Likewise, a
-- manually replaced index can have the right name but the wrong contract. Test
-- the complete catalog contract before reusing either index, rebuild only when
-- necessary, and reuse this view for the final fail-closed assertion.
CREATE TEMP VIEW canonical_context_serving_index_contract AS
WITH expected (
  index_name,
  key_1,
  key_2,
  key_3,
  option_1,
  option_2,
  option_3,
  predicate
) AS (
  VALUES
    (
      'canonical_monitor_tg_messages_chat_time_idx',
      'stable_fields#>>''{relations,chatId}''::text[]',
      'event_time',
      'id',
      0, 3, 3,
      'dataset_id=''telegram.monitor.messages.v1''ANDplatform=''telegram''ANDobject_type=''message''ANDdeleted_atISNULL'
    ),
    (
      'canonical_sqlite_tg_messages_chat_time_idx',
      'stable_fields#>>''{relations,chatId}''::text[]',
      'event_time',
      'id',
      0, 3, 3,
      'dataset_id=''telegram.sqlite.messages.v1''ANDplatform=''telegram''ANDobject_type=''message''ANDdeleted_atISNULL'
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
         AND i.indnkeyatts = 3
         AND regexp_replace(pg_get_indexdef(c.oid, 1, true), '[()[:space:]"]', '', 'g') = e.key_1
         AND regexp_replace(pg_get_indexdef(c.oid, 2, true), '[()[:space:]"]', '', 'g') = e.key_2
         AND regexp_replace(pg_get_indexdef(c.oid, 3, true), '[()[:space:]"]', '', 'g') = e.key_3
         AND i.indoption[0] = e.option_1
         AND i.indoption[1] = e.option_2
         AND i.indoption[2] = e.option_3
         AND regexp_replace(
           regexp_replace(pg_get_expr(i.indpred, i.indrelid, true), '::text', '', 'g'),
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

SELECT contract_ready AS monitor_index_ready
  FROM canonical_context_serving_index_contract
 WHERE index_name = 'canonical_monitor_tg_messages_chat_time_idx' \gset

\if :monitor_index_ready
  \echo 'canonical_monitor_tg_messages_chat_time_idx is already valid'
\else
  DROP INDEX CONCURRENTLY IF EXISTS core.canonical_monitor_tg_messages_chat_time_idx;
  CREATE INDEX CONCURRENTLY canonical_monitor_tg_messages_chat_time_idx
    ON core.canonical_records (
      (stable_fields #>> '{relations,chatId}'),
      event_time DESC,
      id DESC
    )
    WHERE dataset_id = 'telegram.monitor.messages.v1'
      AND platform = 'telegram'
      AND object_type = 'message'
      AND deleted_at IS NULL;
\endif

SELECT contract_ready AS sqlite_index_ready
  FROM canonical_context_serving_index_contract
 WHERE index_name = 'canonical_sqlite_tg_messages_chat_time_idx' \gset

\if :sqlite_index_ready
  \echo 'canonical_sqlite_tg_messages_chat_time_idx is already valid'
\else
  DROP INDEX CONCURRENTLY IF EXISTS core.canonical_sqlite_tg_messages_chat_time_idx;
  CREATE INDEX CONCURRENTLY canonical_sqlite_tg_messages_chat_time_idx
    ON core.canonical_records (
      (stable_fields #>> '{relations,chatId}'),
      event_time DESC,
      id DESC
    )
    WHERE dataset_id = 'telegram.sqlite.messages.v1'
      AND platform = 'telegram'
      AND object_type = 'message'
      AND deleted_at IS NULL;
\endif

SELECT c.relname AS index_name, i.indisready, i.indisvalid
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_index i ON i.indexrelid = c.oid
 WHERE n.nspname = 'core'
   AND c.relname IN (
     'canonical_monitor_tg_messages_chat_time_idx',
     'canonical_sqlite_tg_messages_chat_time_idx'
   )
 ORDER BY c.relname;

SELECT count(*) = 2 AND bool_and(contract_ready)
         AS canonical_context_serving_indexes_ready
  FROM canonical_context_serving_index_contract \gset

\if :canonical_context_serving_indexes_ready
  \echo 'canonical context serving indexes are ready'
\else
  \warn 'canonical context serving indexes did not become ready'
  \quit 1
\endif
