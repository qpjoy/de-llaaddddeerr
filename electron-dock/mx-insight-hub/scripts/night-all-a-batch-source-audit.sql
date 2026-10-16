-- Read-only batch evidence from the explicitly selected source database.
-- Run with psql -X -v ON_ERROR_STOP=1 -A -t -q -f this-file.sql.
-- No DSN discovery, application imports, business body/URL output or writes.
-- A successful empty result means no matching rows in this snapshot only.
-- Samples do not establish complete coverage or successful Hub ingestion.
\set ON_ERROR_STOP on
\pset pager off
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '1s';
SET LOCAL idle_in_transaction_session_timeout = '30s';
SET LOCAL search_path = pg_catalog;

-- BEGIN CONNECTION IDENTITY
SELECT jsonb_pretty(jsonb_build_object(
  'report', 'connection_identity',
  'database', current_database(),
  'serverAddress', inet_server_addr()::text,
  'serverPort', inet_server_port(),
  'postmasterStartedAt', pg_postmaster_start_time(),
  'snapshotAt', transaction_timestamp(),
  'transactionReadOnly', current_setting('transaction_read_only'),
  'transactionIsolation', current_setting('transaction_isolation'),
  'scope', 'this connection; not proof of application engine or Hub routing'
));
-- END CONNECTION IDENTITY

-- A Unix socket connection legitimately has null server address/port.
-- A shared system identifier can also belong to replicas or a cloned cluster.
-- BEGIN SYSTEM IDENTIFIER PERMISSION
SELECT COALESCE(has_function_privilege(current_user,
  to_regprocedure('pg_catalog.pg_control_system()'), 'EXECUTE'), false)
  AS audit_system_id_readable
-- END SYSTEM IDENTIFIER PERMISSION
\gset
\if :audit_system_id_readable
-- BEGIN SYSTEM IDENTIFIER
SELECT jsonb_pretty(jsonb_build_object(
  'report', 'cluster_identity', 'status', 'observed',
  'systemIdentifier', system_identifier::text
)) FROM pg_catalog.pg_control_system();
-- END SYSTEM IDENTIFIER
\else
SELECT jsonb_pretty(jsonb_build_object(
  'report', 'cluster_identity', 'status', 'unavailable',
  'systemIdentifier', NULL,
  'reason', 'pg_control_system unavailable or EXECUTE permission not granted'
));
\endif

-- Inspect catalog metadata before referring to tag or any business column.
-- BEGIN SCHEMA PREFLIGHT
WITH required(name, allowed_types) AS (VALUES
  ('tag', ARRAY['text', 'character varying']),
  ('source_type', ARRAY['text', 'character varying']),
  ('connector_id', ARRAY['text', 'character varying']),
  ('id', ARRAY['integer', 'bigint']),
  ('record_key', ARRAY['text', 'character varying']),
  ('attributes', ARRAY['jsonb']),
  ('created_at', ARRAY['timestamp with time zone']),
  ('last_seen_at', ARRAY['timestamp with time zone'])
), relation AS (
  SELECT c.oid, c.relkind FROM pg_class c
  WHERE c.oid = to_regclass('public.saved_records')
), problems AS (
  SELECT r.name, format_type(a.atttypid, NULL) AS actual_type
  FROM required r
  LEFT JOIN pg_attribute a ON a.attrelid = (SELECT oid FROM relation)
    AND a.attname = r.name AND a.attnum > 0 AND NOT a.attisdropped
  WHERE a.attname IS NULL OR NOT (format_type(a.atttypid, NULL) = ANY(r.allowed_types))
), checked AS (
  SELECT COALESCE((SELECT relkind IN ('r', 'p') FROM relation), false)
    AND NOT EXISTS (SELECT 1 FROM problems) AS ready
)
SELECT ready AS audit_schema_ready, jsonb_pretty(jsonb_build_object(
  'report', 'batch_schema',
  'status', CASE WHEN ready THEN 'ready' ELSE 'unsupported_schema' END,
  'relation', 'public.saved_records',
  'relationKind', (SELECT relkind FROM relation),
  'problems', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'column', name, 'actualType', actual_type) ORDER BY name) FROM problems), '[]'::jsonb),
  'businessRowsRead', false,
  'counts', NULL
)) AS audit_schema_report FROM checked
-- END SCHEMA PREFLIGHT
\gset
\echo :audit_schema_report
\if :audit_schema_ready

-- Output is bounded; exact aggregation can still scan the matching rows.
-- A timeout or permission error stops psql with a nonzero exit, never zero counts.
-- BEGIN BATCH COUNTS
WITH grouped AS (
  SELECT tag, source_type, connector_id,
    count(*) AS row_count,
    count(DISTINCT NULLIF(attributes->>'site_id', '')) AS site_count,
    count(*) FILTER (WHERE NULLIF(attributes->>'site_id', '') IS NULL) AS missing_site_id_rows,
    min(last_seen_at) AS first_last_seen_at,
    max(last_seen_at) AS latest_last_seen_at
  FROM public.saved_records
  WHERE tag IN ('tasiting', 'maidanglao')
  GROUP BY tag, source_type, connector_id
), bounded AS (
  SELECT * FROM grouped ORDER BY tag, source_type, connector_id LIMIT 100
)
SELECT jsonb_pretty(jsonb_build_object(
  'report', 'batch_counts', 'status', 'observed',
  'tags', jsonb_build_array('tasiting', 'maidanglao'),
  'totalGroups', (SELECT count(*) FROM grouped),
  'groupsComplete', (SELECT count(*) <= 100 FROM grouped),
  'groupLimit', 100,
  'groups', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'tag', tag, 'sourceType', source_type, 'connectorId', connector_id,
    'rowCount', row_count, 'siteCount', site_count, 'missingSiteIdRows', missing_site_id_rows,
    'minLastSeenAt', first_last_seen_at, 'maxLastSeenAt', latest_last_seen_at
  ) ORDER BY tag, source_type, connector_id) FROM bounded), '[]'::jsonb),
  'scope', 'rows retaining these tags in this snapshot; not historical collection or Hub coverage'
));
-- END BATCH COUNTS

-- BEGIN LATEST SAMPLES
WITH samples AS (
  SELECT kinds.source_type, r.id, r.record_key, r.site_id, r.body_status,
    r.created_at, r.last_seen_at
  FROM (VALUES ('news'), ('web')) AS kinds(source_type)
  CROSS JOIN LATERAL (
    SELECT id, record_key, attributes->>'site_id' AS site_id,
      attributes->>'body_status' AS body_status, created_at, last_seen_at
    FROM public.saved_records
    WHERE tag = 'maidanglao' AND connector_id = 'organization-web'
      AND source_type = kinds.source_type
    ORDER BY last_seen_at DESC NULLS LAST, id DESC
    LIMIT 5
  ) r
)
SELECT jsonb_pretty(jsonb_build_object(
  'report', 'latest_samples', 'status', 'observed',
  'tag', 'maidanglao', 'connectorId', 'organization-web',
  'limitPerSourceType', 5, 'sampleOnly', true,
  'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'sourceType', source_type, 'id', id, 'recordKey', record_key,
    'siteId', site_id, 'bodyStatus', body_status,
    'createdAt', created_at, 'lastSeenAt', last_seen_at
  ) ORDER BY source_type, last_seen_at DESC NULLS LAST, id DESC) FROM samples), '[]'::jsonb),
  'scope', 'reconciliation identifiers only; not proof of full coverage or writer ordering'
));
-- END LATEST SAMPLES

\else
-- The schema JSON above names missing or incompatible columns. No data query ran.
-- ON_ERROR_STOP closes the connection and rolls back this read-only transaction.
DO $$ BEGIN
  RAISE EXCEPTION 'batch audit schema unsupported; no business rows read; see batch_schema report';
END $$;
\endif
ROLLBACK;
