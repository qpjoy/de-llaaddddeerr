-- psql -X -v ON_ERROR_STOP=1 -A -t -q -f night-all-saved-records-index-status.sql
-- PostgreSQL 16+ (the observed source uses PostgreSQL 16).
-- Read-only snapshot after an interrupted/blocked index build. No business rows,
-- SQL text, connection credentials, cancellation, index repair or task changes.
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = pg_catalog;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '1s';
SET LOCAL idle_in_transaction_session_timeout = '15s';

WITH
parent AS MATERIALIZED (
  SELECT c.oid, n.nspname AS schema_name, c.relname AS table_name,
         c.relkind, pg_get_partkeydef(c.oid) AS partition_key
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'saved_records'
),
children AS MATERIALIZED (
  SELECT c.oid, n.nspname AS schema_name, c.relname AS table_name, c.relkind,
         pg_get_expr(c.relpartbound, c.oid, true) AS partition_bound,
         substring(pg_get_expr(c.relpartbound, c.oid, true)
           FROM '^FOR VALUES IN \(''([^'']+)''\)$') AS source_type,
         NOT EXISTS (SELECT 1 FROM pg_inherits next_level WHERE next_level.inhparent = c.oid) AS is_leaf
    FROM parent p JOIN pg_inherits i ON i.inhparent = p.oid
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
),
relations AS MATERIALIZED (
  SELECT p.oid, p.schema_name, p.table_name, p.relkind,
         NULL::text AS partition_bound, NULL::text AS source_type,
         false AS is_leaf, true AS is_parent
    FROM parent p
  UNION ALL
  SELECT c.*, false AS is_parent FROM (
    SELECT * FROM children ORDER BY schema_name, table_name, oid LIMIT 500
  ) c
),
expected AS MATERIALIZED (
  SELECT r.*, CASE WHEN NOT is_parent AND is_leaf AND relkind = 'r'
      AND schema_name = 'public' AND source_type ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
      AND length(source_type) <= 38 AND table_name = 'saved_records_' || source_type
      AND EXISTS (SELECT 1 FROM parent p WHERE p.relkind = 'p'
        AND regexp_replace(p.partition_key, '["[:space:]]', '', 'g') = 'LIST(source_type)')
    THEN CASE WHEN octet_length(table_name || '_last_seen_at_id_uidx') <= 63
      THEN table_name || '_last_seen_at_id_uidx'
      ELSE 'saved_records_' || left(source_type, 15) || '_' || left(md5(source_type), 12) || '_last_seen_at_id_uidx'
    END END AS expected_index_name
    FROM relations r
),
indexes AS MATERIALIZED (
  SELECT r.oid AS relation_oid, i.indexrelid AS oid, ic.relname AS name,
         i.indisvalid AS valid, i.indisready AS ready, i.indislive AS live,
         i.indisunique AS is_unique, am.amname AS access_method,
         i.indexprs IS NULL AS no_expressions, i.indpred IS NULL AS no_predicate,
         i.indnkeyatts AS key_count, i.indnatts AS total_columns,
         a1.attname AS first_column, a2.attname AS second_column,
         i.indoption[0] AS first_option, i.indoption[1] AS second_option,
         COALESCE(i.indisvalid AND i.indisready AND i.indislive AND i.indisunique
           AND am.amname = 'btree' AND i.indexprs IS NULL AND i.indpred IS NULL
           AND i.indnkeyatts = 2 AND i.indnatts = 2
           AND regexp_replace(pg_get_indexdef(i.indexrelid, 1, true), '[()[:space:]"]', '', 'g') = 'last_seen_at'
           AND regexp_replace(pg_get_indexdef(i.indexrelid, 2, true), '[()[:space:]"]', '', 'g') = 'id'
           AND i.indoption[0] = 0 AND i.indoption[1] = 0, false) AS cursor_contract_ready
    FROM relations r JOIN pg_index i ON i.indrelid = r.oid
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_am am ON am.oid = ic.relam
    LEFT JOIN pg_attribute a1 ON a1.attrelid = r.oid AND a1.attnum = i.indkey[0]
    LEFT JOIN pg_attribute a2 ON a2.attrelid = r.oid AND a2.attnum = i.indkey[1]
),
lock_targets AS MATERIALIZED (
  SELECT oid FROM relations UNION SELECT oid FROM indexes
),
related_locks AS MATERIALIZED (
  SELECT l.pid, l.relation, l.mode, l.granted, l.waitstart
    FROM pg_locks l JOIN lock_targets t ON t.oid = l.relation
   WHERE l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
     AND l.pid IS DISTINCT FROM pg_backend_pid()
),
progress_all AS MATERIALIZED (
  SELECT p.pid, p.relid, p.index_relid, p.command, p.phase,
         p.lockers_total, p.lockers_done, p.current_locker_pid,
         p.blocks_total, p.blocks_done, p.tuples_total, p.tuples_done,
         p.partitions_total, p.partitions_done
    FROM pg_stat_progress_create_index p
   WHERE p.datid = (SELECT oid FROM pg_database WHERE datname = current_database())
     AND (p.relid IN (SELECT oid FROM relations) OR p.index_relid IN (SELECT oid FROM indexes))
),
progress AS MATERIALIZED (
  SELECT * FROM progress_all ORDER BY pid LIMIT 500
),
seed_pids AS MATERIALIZED (
  SELECT pid FROM related_locks WHERE pid IS NOT NULL
  UNION SELECT pid FROM progress
  UNION SELECT current_locker_pid::integer FROM progress WHERE current_locker_pid > 0
),
seed_waits AS MATERIALIZED (
  SELECT pid, pg_blocking_pids(pid) AS blocking_pids
    FROM (SELECT pid FROM seed_pids ORDER BY pid LIMIT 500) selected
),
session_pids AS MATERIALIZED (
  SELECT pid FROM seed_waits
  UNION SELECT unnest(blocking_pids) FROM seed_waits
),
sessions AS MATERIALIZED (
  SELECT s.pid, a.pid IS NOT NULL AS activity_visible, a.state, a.backend_type,
         EXTRACT(epoch FROM (statement_timestamp() - a.xact_start)) AS transaction_age_seconds,
         EXTRACT(epoch FROM (statement_timestamp() - a.state_change)) AS state_age_seconds,
         a.wait_event_type, a.wait_event,
         CASE WHEN w.pid IS NOT NULL THEN w.blocking_pids
              WHEN s.pid > 0 THEN pg_blocking_pids(s.pid) ELSE ARRAY[]::integer[] END AS blocking_pids
    FROM (SELECT pid FROM session_pids ORDER BY pid LIMIT 500) s
    LEFT JOIN pg_stat_activity a ON a.pid = s.pid
    LEFT JOIN seed_waits w ON w.pid = s.pid
),
relation_reports AS (
  SELECT r.oid, r.schema_name, r.table_name, r.is_parent,
         jsonb_build_object(
           'oid', r.oid, 'schema', r.schema_name, 'table', r.table_name,
           'relationKind', r.relkind, 'isParent', r.is_parent, 'isLeaf', r.is_leaf,
           'sourceType', r.source_type, 'partitionBound', r.partition_bound,
           'supportedLeaf', r.expected_index_name IS NOT NULL,
           'expectedIndexName', r.expected_index_name,
           'managedNameObject', (SELECT jsonb_build_object(
             'oid', c.oid, 'kind', c.relkind, 'indexedTableOid', i.indrelid,
             'compatible', EXISTS (SELECT 1 FROM indexes x
               WHERE x.oid = c.oid AND x.relation_oid = r.oid AND x.cursor_contract_ready))
             FROM pg_class c LEFT JOIN pg_index i ON i.indexrelid = c.oid
             WHERE c.relnamespace = 'public'::regnamespace AND c.relname = r.expected_index_name),
           'cursorIndexReady', EXISTS (SELECT 1 FROM indexes i WHERE i.relation_oid = r.oid AND i.cursor_contract_ready),
           'indexCount', (SELECT count(*) FROM indexes i WHERE i.relation_oid = r.oid),
           'indexesComplete', (SELECT count(*) <= 500 FROM indexes i WHERE i.relation_oid = r.oid),
           'indexes', COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'oid', i.oid, 'name', i.name, 'valid', i.valid, 'ready', i.ready, 'live', i.live,
             'unique', i.is_unique, 'accessMethod', i.access_method,
             'noExpressions', i.no_expressions, 'noPredicate', i.no_predicate,
             'keyCount', i.key_count, 'totalColumns', i.total_columns,
             'firstColumn', i.first_column, 'secondColumn', i.second_column,
             'firstOption', i.first_option, 'secondOption', i.second_option,
             'cursorContractReady', i.cursor_contract_ready) ORDER BY i.name, i.oid)
             FROM (SELECT * FROM indexes i WHERE i.relation_oid = r.oid ORDER BY name, oid LIMIT 500) i), '[]'::jsonb)
         ) AS report
    FROM expected r
)
SELECT jsonb_build_object(
  'version', 'night-all-saved-records.index-status.v1',
  'observedAt', statement_timestamp(),
  'target', jsonb_build_object('database', current_database(),
    'expectedDatabase', 'agent_data_crawler_platform',
    'databaseMatches', current_database() = 'agent_data_crawler_platform',
    'serverAddress', inet_server_addr()::text, 'serverPort', inet_server_port(),
    'serverVersion', current_setting('server_version'),
    'readOnly', current_setting('transaction_read_only') = 'on'),
  'scope', jsonb_build_object('businessRowsRead', false, 'sqlTextIncluded', false,
    'hasReadAllStats', pg_has_role(current_user, 'pg_read_all_stats', 'USAGE'),
    'limitations', jsonb_build_array(
      'A snapshot only; a timed-out builder may already have exited and no longer appear.',
      'Other sessions may be redacted without pg_read_all_stats; empty progress is not proof of no contention.',
      'Only the parent, up to 500 direct children, and their indexes are observed; nested descendants are excluded.',
      'Sessions include related relation-lock holders, builders, their current locker, and direct blockers; not a complete blocking graph.',
      'A blocking PID of zero can indicate a prepared transaction; it has no pg_stat_activity session.',
      'Database-name matching does not establish that this server is the Hub configured source.',
      'Does not authorize cancellation, index deletion, task activation or checkpoint changes.'),
    'directPartitionLimit', 500, 'perRelationIndexLimit', 500,
    'progressLimit', 500, 'lockLimit', 500, 'sessionLimit', 500),
  'parentFound', EXISTS (SELECT 1 FROM parent),
  'parentPartitionKey', (SELECT partition_key FROM parent),
  'directPartitionCount', (SELECT count(*) FROM children),
  'partitionsComplete', (SELECT count(*) <= 500 FROM children),
  'relations', COALESCE((SELECT jsonb_agg(report ORDER BY is_parent DESC, schema_name, table_name, oid)
    FROM relation_reports), '[]'::jsonb),
  'progressCount', (SELECT count(*) FROM progress_all),
  'progressComplete', (SELECT count(*) <= 500 FROM progress_all),
  'progress', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.pid) FROM progress p), '[]'::jsonb),
  'relatedLockCount', (SELECT count(*) FROM related_locks),
  'locksComplete', (SELECT count(*) <= 500 FROM related_locks),
  'locks', COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.pid, l.relation, l.mode)
    FROM (SELECT * FROM related_locks ORDER BY pid, relation, mode LIMIT 500) l), '[]'::jsonb),
  'seedSessionCount', (SELECT count(*) FROM seed_pids),
  'sessionsComplete', (SELECT count(*) <= 500 FROM seed_pids) AND (SELECT count(*) <= 500 FROM session_pids),
  'sessions', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.pid) FROM sessions s), '[]'::jsonb)
) AS index_status;

ROLLBACK;
