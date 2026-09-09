\set ON_ERROR_STOP on

-- Online Hub-database indexes for governed source-catalog lookups. The
-- publisher, collector and commerce entry indexes intentionally include
-- soft-deleted records because catalog governance reports active and deleted
-- counts. Run this file with psql as a standalone operation after migration
-- 066. CREATE/DROP INDEX CONCURRENTLY cannot run in a transaction.
SET lock_timeout = '2s';
SET statement_timeout = '30min';

CREATE TEMP VIEW crawler_catalog_index_contract AS
WITH expected (
  index_name,
  key_1,
  predicate
) AS (
  VALUES
    (
      'canonical_crawler_publisher_catalog_idx',
      'stable_fields#>>''{sourceCatalog,publisher,entryId}''::text[]',
      'stable_fields#>>''{sourceCatalog,publisher,entryId}''::text[]ISNOTNULL'
    ),
    (
      'canonical_crawler_collector_catalog_idx',
      'stable_fields#>>''{sourceCatalog,collector,entryId}''::text[]',
      'stable_fields#>>''{sourceCatalog,collector,entryId}''::text[]ISNOTNULL'
    ),
    (
      'canonical_source_catalog_commerce_entry_idx',
      'stable_fields#>>''{commerce,marketplace,entryId}''::text[]',
      'stable_fields#>>''{commerce,marketplace,entryId}''::text[]ISNOTNULL'
    ),
    (
      'canonical_source_catalog_platform_idx',
      'lowerbtrimNORMALIZEplatform,NFKC',
      NULL
    )
), inspected AS (
  SELECT e.index_name,
         coalesce(
           NOT i.indisunique
           AND am.amname = 'btree'
           AND table_namespace.nspname = 'core'
           AND table_class.relname = 'canonical_records'
           AND i.indnkeyatts = 1
           AND i.indnatts = 1
           AND i.indexprs IS NOT NULL
           AND regexp_replace(
                 pg_get_indexdef(index_class.oid, 1, true),
                 '[()[:space:]"]', '', 'g'
               ) = e.key_1
           AND i.indoption[0] = 0
           AND (
             (e.predicate IS NULL AND i.indpred IS NULL)
             OR (
               e.predicate IS NOT NULL
               AND i.indpred IS NOT NULL
               AND regexp_replace(
                     pg_get_expr(i.indpred, i.indrelid, true),
                     '[()[:space:]"]', '', 'g'
                   ) = e.predicate
             )
           ),
           false
         ) AS definition_matches,
         coalesce(i.indisvalid AND i.indisready AND i.indislive, false) AS live
    FROM expected AS e
    LEFT JOIN pg_namespace AS index_namespace
      ON index_namespace.nspname = 'core'
    LEFT JOIN pg_class AS index_class
      ON index_class.relnamespace = index_namespace.oid
     AND index_class.relname = e.index_name
    LEFT JOIN pg_index AS i
      ON i.indexrelid = index_class.oid
    LEFT JOIN pg_class AS table_class
      ON table_class.oid = i.indrelid
    LEFT JOIN pg_namespace AS table_namespace
      ON table_namespace.oid = table_class.relnamespace
    LEFT JOIN pg_am AS am
      ON am.oid = index_class.relam
)
SELECT index_name,
       definition_matches,
       definition_matches AND live AS contract_ready,
       definition_matches AND NOT live AS repairable_invalid_build
  FROM inspected;

-- Only an interrupted build whose complete definition already matches this
-- contract may be removed automatically. A same-name unrelated object fails
-- closed at CREATE INDEX instead of being deleted.
SELECT format('DROP INDEX CONCURRENTLY IF EXISTS core.%I', index_name)
  FROM crawler_catalog_index_contract
 WHERE repairable_invalid_build
 ORDER BY index_name
\gexec

SELECT contract_ready AS publisher_index_ready
  FROM crawler_catalog_index_contract
 WHERE index_name = 'canonical_crawler_publisher_catalog_idx'
\gset
\if :publisher_index_ready
  \echo 'canonical_crawler_publisher_catalog_idx is already valid'
\else
  CREATE INDEX CONCURRENTLY canonical_crawler_publisher_catalog_idx
    ON core.canonical_records (
      (stable_fields #>> '{sourceCatalog,publisher,entryId}')
    )
    WHERE (stable_fields #>> '{sourceCatalog,publisher,entryId}') IS NOT NULL;
\endif

SELECT contract_ready AS collector_index_ready
  FROM crawler_catalog_index_contract
 WHERE index_name = 'canonical_crawler_collector_catalog_idx'
\gset
\if :collector_index_ready
  \echo 'canonical_crawler_collector_catalog_idx is already valid'
\else
  CREATE INDEX CONCURRENTLY canonical_crawler_collector_catalog_idx
    ON core.canonical_records (
      (stable_fields #>> '{sourceCatalog,collector,entryId}')
    )
    WHERE (stable_fields #>> '{sourceCatalog,collector,entryId}') IS NOT NULL;
\endif

SELECT contract_ready AS commerce_index_ready
  FROM crawler_catalog_index_contract
 WHERE index_name = 'canonical_source_catalog_commerce_entry_idx'
\gset
\if :commerce_index_ready
  \echo 'canonical_source_catalog_commerce_entry_idx is already valid'
\else
  CREATE INDEX CONCURRENTLY canonical_source_catalog_commerce_entry_idx
    ON core.canonical_records (
      (stable_fields #>> '{commerce,marketplace,entryId}')
    )
    WHERE (stable_fields #>> '{commerce,marketplace,entryId}') IS NOT NULL;
\endif

SELECT contract_ready AS platform_index_ready
  FROM crawler_catalog_index_contract
 WHERE index_name = 'canonical_source_catalog_platform_idx'
\gset
\if :platform_index_ready
  \echo 'canonical_source_catalog_platform_idx is already valid'
\else
  CREATE INDEX CONCURRENTLY canonical_source_catalog_platform_idx
    ON core.canonical_records (
      (lower(btrim(normalize(platform, NFKC))))
    );
\endif

SELECT index_name, definition_matches, contract_ready
  FROM crawler_catalog_index_contract
 ORDER BY index_name;

SELECT count(*) = 4 AND bool_and(contract_ready)
         AS crawler_catalog_indexes_ready
  FROM crawler_catalog_index_contract
\gset

\if :crawler_catalog_indexes_ready
  \echo 'all source catalog indexes are ready'
\else
  \warn 'source catalog indexes did not become ready'
  \quit 1
\endif
