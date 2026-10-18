-- Run against the source database with psql -X -v ON_ERROR_STOP=1 -f this-file.sql.
-- Add -A -t -q for a single JSON result without psql headings/command tags.
-- Catalog evidence only: no business rows, DDL, task activation or checkpoint changes.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path = pg_catalog;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '1s';
SET LOCAL idle_in_transaction_session_timeout = '15s';

WITH
expected_columns(name, database_type, nullable, optional) AS (
  VALUES
    ('id', 'int4', false, false),
    ('source_type', 'varchar', false, false),
    ('connector_id', 'varchar', false, false),
    ('run_id', 'int4', true, false),
    ('source_family', 'varchar', true, false),
    ('collection_mode', 'varchar', true, false),
    ('evidence', 'jsonb', false, false),
    ('quality_status', 'varchar', false, false),
    ('record_type', 'varchar', false, false),
    ('source_id', 'varchar', false, false),
    ('record_key', 'varchar', false, false),
    ('source_url', 'text', false, false),
    ('title', 'varchar', false, false),
    ('text', 'text', false, false),
    ('author', 'jsonb', false, false),
    ('published_at', 'varchar', true, false),
    ('metrics', 'jsonb', false, false),
    ('media', 'jsonb', false, false),
    ('attributes', 'jsonb', false, false),
    ('raw', 'jsonb', true, false),
    ('first_seen_at', 'timestamptz', false, false),
    ('last_seen_at', 'timestamptz', false, false),
    ('created_at', 'timestamptz', false, false),
    ('tag', 'varchar', true, true)
),
parent AS MATERIALIZED (
  SELECT c.oid, n.nspname AS schema_name, c.relname AS table_name,
         c.relkind, c.relispartition, pg_get_partkeydef(c.oid) AS partition_key
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'saved_records'
),
children AS MATERIALIZED (
  SELECT c.oid, n.nspname AS schema_name, c.relname AS table_name,
         c.relkind, c.relispartition, pg_get_partkeydef(c.oid) AS partition_key,
         pg_get_expr(c.relpartbound, c.oid, true) AS partition_bound,
         NOT EXISTS (SELECT 1 FROM pg_inherits next_level WHERE next_level.inhparent = c.oid) AS is_leaf
    FROM parent p JOIN pg_inherits i ON i.inhparent = p.oid
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
),
selected_children AS MATERIALIZED (
  SELECT * FROM children ORDER BY schema_name, table_name, oid LIMIT 500
),
relations AS MATERIALIZED (
  SELECT p.*, NULL::text AS partition_bound,
         NOT EXISTS (SELECT 1 FROM children) AS is_leaf, true AS is_parent
    FROM parent p
  UNION ALL
  SELECT c.*, false AS is_parent FROM selected_children c
),
columns AS MATERIALIZED (
  SELECT r.oid AS relation_oid, a.attnum AS ordinal, a.attname AS name,
         t.typname AS database_type, tn.nspname AS type_schema,
         format_type(a.atttypid, a.atttypmod) AS declared_type, NOT a.attnotnull AS nullable
    FROM relations r JOIN pg_attribute a ON a.attrelid = r.oid
    JOIN pg_type t ON t.oid = a.atttypid
    JOIN pg_namespace tn ON tn.oid = t.typnamespace
   WHERE a.attnum > 0 AND NOT a.attisdropped
),
indexes AS MATERIALIZED (
  SELECT r.oid AS relation_oid, i.indexrelid AS oid, ns.nspname AS schema_name,
         ic.relname AS name, am.amname AS access_method,
         i.indisvalid AS valid, i.indisready AS ready, i.indislive AS live,
         i.indisunique AS is_unique, i.indexprs IS NULL AS no_expressions,
         i.indpred IS NULL AS no_predicate, i.indnkeyatts AS key_count,
         i.indnatts AS total_columns,
         pg_get_indexdef(i.indexrelid, 1, true) AS first_key,
         CASE WHEN i.indnatts >= 2 THEN pg_get_indexdef(i.indexrelid, 2, true) END AS second_key,
         i.indoption[0] AS first_option, i.indoption[1] AS second_option,
         COALESCE(i.indisvalid AND i.indisready AND i.indislive AND i.indisunique
           AND am.amname = 'btree' AND i.indexprs IS NULL AND i.indpred IS NULL
           AND i.indnkeyatts = 2 AND i.indnatts = 2
           AND a1.attname = 'last_seen_at' AND a2.attname = 'id'
           AND regexp_replace(pg_get_indexdef(i.indexrelid, 1, true), '[()[:space:]"]', '', 'g') = 'last_seen_at'
           AND regexp_replace(pg_get_indexdef(i.indexrelid, 2, true), '[()[:space:]"]', '', 'g') = 'id'
           AND i.indoption[0] = 0 AND i.indoption[1] = 0, false) AS cursor_contract_ready
    FROM relations r JOIN pg_index i ON i.indrelid = r.oid
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_namespace ns ON ns.oid = ic.relnamespace
    JOIN pg_am am ON am.oid = ic.relam
    LEFT JOIN pg_attribute a1 ON a1.attrelid = r.oid AND a1.attnum = i.indkey[0]
    LEFT JOIN pg_attribute a2 ON a2.attrelid = r.oid AND a2.attnum = i.indkey[1]
),
relation_reports AS (
  SELECT r.oid, r.schema_name, r.table_name, r.is_parent,
         jsonb_build_object(
           'oid', r.oid, 'schema', r.schema_name, 'table', r.table_name,
           'relationKind', r.relkind, 'isPartition', r.relispartition,
           'partitionKey', r.partition_key, 'partitionBound', r.partition_bound,
           'isLeaf', r.is_leaf,
           'tag', COALESCE((SELECT jsonb_build_object('present', true,
             'databaseType', c.database_type, 'typeSchema', c.type_schema,
             'declaredType', c.declared_type, 'nullable', c.nullable)
             FROM columns c WHERE c.relation_oid = r.oid AND c.name = 'tag'), '{"present":false}'::jsonb),
           'columnCount', (SELECT count(*) FROM columns c WHERE c.relation_oid = r.oid),
           'columnsComplete', (SELECT count(*) <= 500 FROM columns c WHERE c.relation_oid = r.oid),
           'columns', COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'name', c.name, 'databaseType', c.database_type, 'typeSchema', c.type_schema,
             'declaredType', c.declared_type, 'nullable', c.nullable, 'ordinal', c.ordinal)
             ORDER BY c.ordinal)
             FROM (SELECT * FROM columns c WHERE c.relation_oid = r.oid ORDER BY ordinal LIMIT 500) c), '[]'::jsonb),
           'missingColumns', COALESCE((SELECT jsonb_agg(e.name ORDER BY e.name)
             FROM expected_columns e WHERE NOT e.optional AND NOT EXISTS
               (SELECT 1 FROM columns c WHERE c.relation_oid = r.oid AND c.name = e.name)), '[]'::jsonb),
           'unexpectedColumns', COALESCE((SELECT jsonb_agg(c.name ORDER BY c.name)
             FROM (SELECT name FROM columns c WHERE c.relation_oid = r.oid
               AND NOT EXISTS (SELECT 1 FROM expected_columns e WHERE e.name = c.name)
               ORDER BY name LIMIT 500) c), '[]'::jsonb),
           'columnMismatches', COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'name', e.name, 'expectedType', e.database_type, 'actualType', c.database_type,
             'actualTypeSchema', c.type_schema, 'expectedNullable', e.nullable, 'actualNullable', c.nullable)
             ORDER BY e.name)
             FROM expected_columns e JOIN columns c ON c.name = e.name AND c.relation_oid = r.oid
             WHERE c.database_type <> e.database_type OR c.type_schema <> 'pg_catalog' OR c.nullable <> e.nullable), '[]'::jsonb),
           'cursorIndexReady', EXISTS (SELECT 1 FROM indexes i WHERE i.relation_oid = r.oid AND i.cursor_contract_ready),
           'indexCount', (SELECT count(*) FROM indexes i WHERE i.relation_oid = r.oid),
           'indexesComplete', (SELECT count(*) <= 500 FROM indexes i WHERE i.relation_oid = r.oid),
           'indexes', COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'oid', i.oid, 'schema', i.schema_name, 'name', i.name,
             'valid', i.valid, 'ready', i.ready, 'live', i.live, 'unique', i.is_unique,
             'accessMethod', i.access_method, 'noExpressions', i.no_expressions,
             'noPredicate', i.no_predicate, 'keyCount', i.key_count, 'totalColumns', i.total_columns,
             'firstKey', i.first_key, 'secondKey', i.second_key,
             'firstOption', i.first_option, 'secondOption', i.second_option,
             'cursorContractReady', i.cursor_contract_ready) ORDER BY i.name, i.oid)
             FROM (SELECT * FROM indexes i WHERE i.relation_oid = r.oid ORDER BY name, oid LIMIT 500) i), '[]'::jsonb)
         ) AS report
    FROM relations r
)
SELECT jsonb_build_object(
  'version', 'night-all-saved-records.source-audit.v1',
  'scope', jsonb_build_object(
    'catalogOnly', true, 'businessRowsRead', false, 'readOnly', current_setting('transaction_read_only') = 'on',
    'limitations', jsonb_build_array('Does not prove writer commit ordering, identity retention or deletion behavior.',
      'Does not measure business data, collection coverage, freshness or successful Hub ingestion.',
      'Reports the parent and direct children only. Nested descendants are not audited.',
      'Does not authorize index creation, source activation or checkpoint changes.'),
    'directPartitionLimit', 500, 'perRelationColumnLimit', 500, 'perRelationIndexLimit', 500),
  'database', current_database(), 'serverVersion', current_setting('server_version'),
  'serverVersionNumber', current_setting('server_version_num')::integer,
  'observedAt', transaction_timestamp(),
  'parentFound', EXISTS (SELECT 1 FROM parent),
  'status', CASE WHEN NOT EXISTS (SELECT 1 FROM parent) THEN 'parent_missing'
    WHEN EXISTS (SELECT 1 FROM parent WHERE relkind = 'p') THEN 'catalog_observed'
    ELSE 'parent_not_partitioned' END,
  'parent', (SELECT report FROM relation_reports WHERE is_parent),
  'directPartitionCount', (SELECT count(*) FROM children),
  'returnedPartitionCount', (SELECT count(*) FROM selected_children),
  'partitionsComplete', (SELECT count(*) <= 500 FROM children),
  'expectedColumnContract', (SELECT jsonb_agg(jsonb_build_object(
    'name', name, 'databaseType', database_type, 'nullable', nullable, 'optional', optional) ORDER BY name)
    FROM expected_columns),
  'partitions', COALESCE((SELECT jsonb_agg(report ORDER BY schema_name, table_name, oid)
    FROM relation_reports WHERE NOT is_parent), '[]'::jsonb)
) AS source_audit;

ROLLBACK;
