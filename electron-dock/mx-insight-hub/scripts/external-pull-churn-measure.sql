-- Measure what a database external pull (the TG monitor) actually writes.
--
-- Read-only, one READ ONLY transaction, ROLLBACK at the end. Every statement is
-- bounded by import_runs_source_idx (runs of the last 24 h) and
-- record_revisions_external_import_run_idx (revisions those runs wrote); no
-- full-table scan and no EXPLAIN ANALYZE. Each statement stops at 30 s.
--
--   psql -X "$DATABASE_URL" -v ON_ERROR_STOP=1 < scripts/external-pull-churn-measure.sql
--
-- Section 4 answers "why is 变更 as large as 读取": it lists which raw columns
-- differ between a canonical revision and the one before it. `updated_at` alone
-- means a touched-but-unchanged row (fixed by the watermark exclusion);
-- metrics columns mean real heat changes; the deleted column means a soft
-- delete. See docs/operations/external-pull-ingest-pressure-2026-10-20.md.

BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '1s';
SET LOCAL max_parallel_workers_per_gather = 0;

-- 1. Relation sizes (catalog only).
SELECT c.oid::regclass AS relation,
       c.reltuples::bigint AS estimated_rows,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total
  FROM pg_class c
 WHERE c.oid IN (
   'ingest.source_objects'::regclass,
   'ingest.source_object_revisions'::regclass,
   'core.canonical_records'::regclass,
   'core.record_revisions'::regclass,
   'outbox.projection_events'::regclass,
   'retrieval.jobs'::regclass
 )
 ORDER BY pg_total_relation_size(c.oid) DESC;

-- 2. Pulls per hour over the last 24 h: rows read vs rows written.
SELECT s.source_key,
       date_trunc('hour', r.started_at) AS hour,
       count(*) AS runs,
       sum(r.row_count) AS rows_read,
       sum(r.ingested_count) AS rows_ingested,
       round(avg(extract(epoch FROM r.finished_at - r.started_at))::numeric, 1) AS avg_run_seconds
  FROM catalog.external_sources s
  JOIN ingest.import_runs r
    ON r.source_id = s.id AND r.started_at > now() - interval '24 hours'
 WHERE s.source_kind = 'database'
 GROUP BY 1, 2
 ORDER BY 1, 2 DESC;

-- 3. Canonical revisions written by those runs (each one = an ES reindex and a
--    retrieval chunk rewrite) and source revisions (raw lineage copies).
WITH runs AS (
  SELECT s.source_key, r.id
    FROM catalog.external_sources s
    JOIN ingest.import_runs r
      ON r.source_id = s.id AND r.started_at > now() - interval '24 hours'
   WHERE s.source_kind = 'database'
)
SELECT runs.source_key,
       count(*) AS canonical_revisions_24h,
       count(*) FILTER (WHERE rr.revision = 1) AS first_seen,
       count(DISTINCT rr.record_id) AS distinct_records,
       round(count(*)::numeric / greatest(count(DISTINCT rr.record_id), 1), 2) AS revisions_per_record
  FROM runs
  JOIN core.record_revisions rr ON rr.external_import_run_id = runs.id
 GROUP BY 1
 ORDER BY 2 DESC;

-- 4. Which raw columns changed between consecutive canonical revisions
--    (latest 2000 non-initial revisions of the last 24 h).
WITH runs AS (
  SELECT r.id
    FROM catalog.external_sources s
    JOIN ingest.import_runs r
      ON r.source_id = s.id AND r.started_at > now() - interval '24 hours'
   WHERE s.source_kind = 'database'
), recent AS (
  SELECT rr.record_id, rr.revision, rr.normalized_payload
    FROM runs
    JOIN core.record_revisions rr ON rr.external_import_run_id = runs.id
   WHERE rr.revision > 1
   ORDER BY rr.valid_from DESC
   LIMIT 2000
), pairs AS (
  SELECT recent.record_id,
         recent.revision,
         recent.normalized_payload AS cur,
         prev.normalized_payload AS before
    FROM recent
    JOIN core.record_revisions prev
      ON prev.record_id = recent.record_id AND prev.revision = recent.revision - 1
), changed AS (
  SELECT array_agg(k.key ORDER BY k.key) AS keys
    FROM pairs
   CROSS JOIN LATERAL (
     SELECT key FROM jsonb_object_keys(pairs.cur) AS key
     UNION
     SELECT key FROM jsonb_object_keys(pairs.before) AS key
   ) k
   WHERE pairs.cur -> k.key IS DISTINCT FROM pairs.before -> k.key
   GROUP BY pairs.record_id, pairs.revision
)
SELECT array_to_string(keys, ',') AS changed_columns,
       count(*) AS revisions
  FROM changed
 GROUP BY 1
 ORDER BY 2 DESC
 LIMIT 30;

-- 5. Work still queued behind ingestion.
SELECT 'outbox.projection_events pending' AS queue, count(*) AS rows
  FROM outbox.projection_events WHERE status = 'pending'
UNION ALL
SELECT 'retrieval.jobs pending', count(*)
  FROM retrieval.jobs WHERE status = 'pending';

ROLLBACK;
