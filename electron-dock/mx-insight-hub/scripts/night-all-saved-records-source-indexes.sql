\set ON_ERROR_STOP on

-- Online source-database indexes for the fixed Night-All saved_records leaves.
-- Run this file with psql against agent_data_crawler_platform as a standalone
-- operation. CREATE/DROP INDEX CONCURRENTLY cannot be nested in a transaction.
-- This script contains no source coordinates or credentials and reads only
-- PostgreSQL catalogs outside the index builds themselves.
SET lock_timeout = '2s';
SET statement_timeout = '30min';

SELECT current_database() = 'agent_data_crawler_platform'
         AS crawler_source_database_matches
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

-- The repository deploy lock covers one checkout only. This session lock
-- prevents two operators from racing the same concurrent repair from separate
-- checkouts or hosts and is released automatically when psql exits.
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

CREATE TEMP TABLE crawler_source_index_expected (
  table_name text PRIMARY KEY,
  index_name text NOT NULL UNIQUE
);

INSERT INTO crawler_source_index_expected (table_name, index_name)
VALUES
  ('saved_records_automotive', 'saved_records_automotive_last_seen_at_id_uidx'),
  ('saved_records_finance', 'saved_records_finance_last_seen_at_id_uidx'),
  ('saved_records_forum', 'saved_records_forum_last_seen_at_id_uidx'),
  ('saved_records_hotspot', 'saved_records_hotspot_last_seen_at_id_uidx'),
  ('saved_records_local_news', 'saved_records_local_news_last_seen_at_id_uidx'),
  ('saved_records_media', 'saved_records_media_last_seen_at_id_uidx'),
  ('saved_records_news', 'saved_records_news_last_seen_at_id_uidx'),
  ('saved_records_other', 'saved_records_other_last_seen_at_id_uidx'),
  ('saved_records_recruitment', 'saved_records_recruitment_last_seen_at_id_uidx'),
  ('saved_records_research', 'saved_records_research_last_seen_at_id_uidx'),
  ('saved_records_social', 'saved_records_social_last_seen_at_id_uidx'),
  ('saved_records_technology', 'saved_records_technology_last_seen_at_id_uidx'),
  ('saved_records_web', 'saved_records_web_last_seen_at_id_uidx');

-- Re-evaluating this view after each DDL phase catches an interrupted
-- concurrent build as well as a same-name index with a different definition.
CREATE TEMP VIEW crawler_source_index_contract AS
SELECT expected.table_name,
       expected.index_name,
       index_class.oid IS NOT NULL AS index_exists,
       coalesce(
         table_namespace.nspname = 'public'
         AND table_class.relname = expected.table_name
         AND access_method.amname = 'btree'
         AND index_state.indisunique
         AND index_state.indnkeyatts = 2
         AND index_state.indnatts = 2
         AND index_state.indexprs IS NULL
         AND index_state.indpred IS NULL
         AND regexp_replace(
           pg_get_indexdef(index_class.oid, 1, true),
           '[()[:space:]"]',
           '',
           'g'
         ) = 'last_seen_at'
         AND regexp_replace(
           pg_get_indexdef(index_class.oid, 2, true),
           '[()[:space:]"]',
           '',
           'g'
         ) = 'id'
         AND index_state.indoption[0] = 0
         AND index_state.indoption[1] = 0
         AND NOT (
           index_state.indisvalid
           AND index_state.indisready
           AND index_state.indislive
         ),
         false
       ) AS repairable_invalid_build,
       coalesce(
         index_state.indisvalid
         AND index_state.indisready
         AND index_state.indislive
         AND index_state.indisunique
         AND access_method.amname = 'btree'
         AND table_namespace.nspname = 'public'
         AND table_class.relname = expected.table_name
         AND index_state.indnkeyatts = 2
         AND index_state.indnatts = 2
         AND index_state.indexprs IS NULL
         AND index_state.indpred IS NULL
         AND regexp_replace(
           pg_get_indexdef(index_class.oid, 1, true),
           '[()[:space:]"]',
           '',
           'g'
         ) = 'last_seen_at'
         AND regexp_replace(
           pg_get_indexdef(index_class.oid, 2, true),
           '[()[:space:]"]',
           '',
           'g'
         ) = 'id'
         AND index_state.indoption[0] = 0
         AND index_state.indoption[1] = 0,
         false
       ) AS contract_ready
  FROM crawler_source_index_expected AS expected
  LEFT JOIN pg_namespace AS index_namespace
    ON index_namespace.nspname = 'public'
  LEFT JOIN pg_class AS index_class
    ON index_class.relnamespace = index_namespace.oid
   AND index_class.relname = expected.index_name
  LEFT JOIN pg_index AS index_state
    ON index_state.indexrelid = index_class.oid
  LEFT JOIN pg_class AS table_class
    ON table_class.oid = index_state.indrelid
  LEFT JOIN pg_namespace AS table_namespace
    ON table_namespace.oid = table_class.relnamespace
  LEFT JOIN pg_am AS access_method
    ON access_method.oid = index_class.relam;

SELECT format('DROP INDEX CONCURRENTLY IF EXISTS public.%I', index_name)
  FROM crawler_source_index_contract
 WHERE repairable_invalid_build
 ORDER BY index_name
\gexec

SELECT contract_ready AS automotive_index_ready
  FROM crawler_source_index_contract
 WHERE table_name = 'saved_records_automotive'
\gset
\if :automotive_index_ready
  \echo 'saved_records_automotive cursor index is already valid'
\else
  CREATE UNIQUE INDEX CONCURRENTLY saved_records_automotive_last_seen_at_id_uidx
    ON public.saved_records_automotive (last_seen_at, id);
\endif

SELECT contract_ready AS finance_index_ready
  FROM crawler_source_index_contract
 WHERE table_name = 'saved_records_finance'
\gset
\if :finance_index_ready
  \echo 'saved_records_finance cursor index is already valid'
\else
  CREATE UNIQUE INDEX CONCURRENTLY saved_records_finance_last_seen_at_id_uidx
    ON public.saved_records_finance (last_seen_at, id);
\endif

SELECT contract_ready AS forum_index_ready
  FROM crawler_source_index_contract
 WHERE table_name = 'saved_records_forum'
\gset
\if :forum_index_ready
  \echo 'saved_records_forum cursor index is already valid'
\else
  CREATE UNIQUE INDEX CONCURRENTLY saved_records_forum_last_seen_at_id_uidx
    ON public.saved_records_forum (last_seen_at, id);
\endif

SELECT contract_ready AS hotspot_index_ready
  FROM crawler_source_index_contract
 WHERE table_name = 'saved_records_hotspot'
\gset
\if :hotspot_index_ready
  \echo 'saved_records_hotspot cursor index is already valid'
\else
  CREATE UNIQUE INDEX CONCURRENTLY saved_records_hotspot_last_seen_at_id_uidx
    ON public.saved_records_hotspot (last_seen_at, id);
\endif

SELECT contract_ready AS local_news_index_ready
  FROM crawler_source_index_contract
 WHERE table_name = 'saved_records_local_news'
\gset
\if :local_news_index_ready
  \echo 'saved_records_local_news cursor index is already valid'
\else
  CREATE UNIQUE INDEX CONCURRENTLY saved_records_local_news_last_seen_at_id_uidx
    ON public.saved_records_local_news (last_seen_at, id);
\endif

SELECT contract_ready AS media_index_ready
  FROM crawler_source_index_contract
 WHERE table_name = 'saved_records_media'
\gset
\if :media_index_ready
  \echo 'saved_records_media cursor index is already valid'
\else
  CREATE UNIQUE INDEX CONCURRENTLY saved_records_media_last_seen_at_id_uidx
    ON public.saved_records_media (last_seen_at, id);
\endif

SELECT contract_ready AS news_index_ready
  FROM crawler_source_index_contract
 WHERE table_name = 'saved_records_news'
\gset
\if :news_index_ready
  \echo 'saved_records_news cursor index is already valid'
\else
  CREATE UNIQUE INDEX CONCURRENTLY saved_records_news_last_seen_at_id_uidx
    ON public.saved_records_news (last_seen_at, id);
\endif

SELECT contract_ready AS other_index_ready
  FROM crawler_source_index_contract
 WHERE table_name = 'saved_records_other'
\gset
\if :other_index_ready
  \echo 'saved_records_other cursor index is already valid'
\else
  CREATE UNIQUE INDEX CONCURRENTLY saved_records_other_last_seen_at_id_uidx
    ON public.saved_records_other (last_seen_at, id);
\endif

SELECT contract_ready AS recruitment_index_ready
  FROM crawler_source_index_contract
 WHERE table_name = 'saved_records_recruitment'
\gset
\if :recruitment_index_ready
  \echo 'saved_records_recruitment cursor index is already valid'
\else
  CREATE UNIQUE INDEX CONCURRENTLY saved_records_recruitment_last_seen_at_id_uidx
    ON public.saved_records_recruitment (last_seen_at, id);
\endif

SELECT contract_ready AS research_index_ready
  FROM crawler_source_index_contract
 WHERE table_name = 'saved_records_research'
\gset
\if :research_index_ready
  \echo 'saved_records_research cursor index is already valid'
\else
  CREATE UNIQUE INDEX CONCURRENTLY saved_records_research_last_seen_at_id_uidx
    ON public.saved_records_research (last_seen_at, id);
\endif

SELECT contract_ready AS social_index_ready
  FROM crawler_source_index_contract
 WHERE table_name = 'saved_records_social'
\gset
\if :social_index_ready
  \echo 'saved_records_social cursor index is already valid'
\else
  CREATE UNIQUE INDEX CONCURRENTLY saved_records_social_last_seen_at_id_uidx
    ON public.saved_records_social (last_seen_at, id);
\endif

SELECT contract_ready AS technology_index_ready
  FROM crawler_source_index_contract
 WHERE table_name = 'saved_records_technology'
\gset
\if :technology_index_ready
  \echo 'saved_records_technology cursor index is already valid'
\else
  CREATE UNIQUE INDEX CONCURRENTLY saved_records_technology_last_seen_at_id_uidx
    ON public.saved_records_technology (last_seen_at, id);
\endif

SELECT contract_ready AS web_index_ready
  FROM crawler_source_index_contract
 WHERE table_name = 'saved_records_web'
\gset
\if :web_index_ready
  \echo 'saved_records_web cursor index is already valid'
\else
  CREATE UNIQUE INDEX CONCURRENTLY saved_records_web_last_seen_at_id_uidx
    ON public.saved_records_web (last_seen_at, id);
\endif

SELECT table_name, index_name, index_exists, contract_ready
  FROM crawler_source_index_contract
 ORDER BY table_name;

SELECT count(*) = 13 AND bool_and(contract_ready)
         AS crawler_source_indexes_ready
  FROM crawler_source_index_contract
\gset

\if :crawler_source_indexes_ready
  \echo 'all Night-All saved_records source indexes are ready'
\else
  \warn 'Night-All saved_records source indexes did not become ready'
  \quit 1
\endif
