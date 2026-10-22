-- Read-only: where one delivery's raw data is written, in stored bytes per
-- provider call, so the WAL share of each copy can be judged before changing
-- anything. See docs/operations/delivery-write-amplification-2026-10-21.md.
--
--   kubectl -n mx-common exec -i statefulset/mx-common-postgres -- \
--     psql -X -U mx_common -d mx_insight_hub < scripts/delivery-write-amplification.sql
--
-- Plain SQL (no psql meta-commands) in one READ ONLY transaction. Sizes are
-- pg_column_size(): the stored, compressed bytes of that value, which is what
-- its INSERT writes to WAL. It reads the TOAST pointer and does not fetch the
-- value. Tuple headers, index entries and full-page images come on top, so a
-- share against pg_stat_wal is a lower bound.
--
-- Cost: sections 1-3 use existing indexes only (a loose index scan over
-- provider keys, then the provider_calls time index for at most 5000 calls per
-- provider, unique provider_call_id lookups and jobs_dedupe_lookup_idx).
-- Sections 4-5 read and parse the 200 newest ingest jobs. Section 7 is the only full scan of mxq.jobs (heap only,
-- no TOAST reads). It runs last; Ctrl-C there loses nothing.

BEGIN READ ONLY;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '2s';
SET LOCAL application_name = 'delivery-write-amplification';

-- 1. Settings and WAL rate since the statistics were last reset.
SELECT current_setting('server_version') AS server_version,
       current_setting('wal_compression') AS wal_compression,
       current_setting('default_toast_compression') AS toast_compression,
       current_setting('full_page_writes') AS full_page_writes,
       current_setting('checkpoint_timeout') AS checkpoint_timeout,
       current_setting('max_wal_size') AS max_wal_size;

SELECT pg_size_pretty(wal_bytes) AS wal_since_reset,
       stats_reset,
       pg_size_pretty((wal_bytes / greatest(extract(epoch FROM now() - stats_reset), 1) * 86400)::bigint)
         AS wal_per_day,
       round(100.0 * wal_fpi / nullif(wal_records, 0), 1) AS fpi_pct_of_records
  FROM pg_stat_wal;

-- 2. Stored bytes per call, by table, for calls started in the last 24h.
--    Per provider the newest 5000 calls of the window are measured and the
--    totals are scaled to the provider's full 24h count, so the cost stays
--    bounded at any volume. Every per-call value is a correlated lookup on a
--    unique provider_call_id index (or the dedupe lookup index).
--    archive_*: external_platform.archive_objects rows; restricted_*: the three
--    columns of control.external_platform_restricted_raw_responses;
--    snapshot_min only counts snapshots still owned by that call (a later call
--    overwrites the row), so it is a lower bound; usage_body is counted once
--    per usage request; ingest_job is mxq.jobs.payload.
--    archive_dup_pct: calls whose response_archives row has the same
--    payload_sha256 as their archive_objects response row (one payload twice).
WITH RECURSIVE providers AS (
  (SELECT provider_key FROM external_platform.provider_calls ORDER BY provider_key LIMIT 1)
  UNION ALL
  SELECT (SELECT c.provider_key FROM external_platform.provider_calls c
           WHERE c.provider_key > p.provider_key ORDER BY c.provider_key LIMIT 1)
    FROM providers p
   WHERE p.provider_key IS NOT NULL
),
gate AS (
  -- Without the lookup index a dedupe_key probe scans every job; skip it.
  SELECT EXISTS (
    SELECT 1 FROM pg_index
     WHERE indexrelid = to_regclass('mxq.jobs_dedupe_lookup_idx') AND indisvalid AND indisready
  ) AS job_lookup_ready
),
windowed AS (
  SELECT p.provider_key,
         (SELECT count(*) FROM external_platform.provider_calls c
           WHERE c.provider_key = p.provider_key AND c.started_at >= now() - interval '24 hours') AS calls_24h
    FROM providers p
   WHERE p.provider_key IS NOT NULL
),
calls AS (
  SELECT w.calls_24h, c.*
    FROM windowed w
    CROSS JOIN LATERAL (
      SELECT c.id, c.provider_key, c.operation, c.outcome, c.item_count, c.usage_request_id,
             c.call_ordinal, c.consumer_id, c.request_fingerprint
        FROM external_platform.provider_calls c
       WHERE c.provider_key = w.provider_key
         AND c.started_at >= now() - interval '24 hours'
       ORDER BY c.started_at DESC
       LIMIT 5000
    ) c
   WHERE w.calls_24h > 0
),
scaled AS (
  SELECT c.*, c.calls_24h::numeric / count(*) OVER (PARTITION BY c.provider_key) AS scale,
         row_number() OVER (PARTITION BY c.usage_request_id ORDER BY c.call_ordinal, c.id) AS request_rank
    FROM calls c
),
sized AS (
  SELECT c.provider_key, c.operation, c.outcome, c.item_count, c.scale,
         (SELECT u.platform FROM public.usage_requests u WHERE u.id = c.usage_request_id) AS platform,
         coalesce((SELECT pg_column_size(ra.raw_payload) FROM external_platform.response_archives ra
                    WHERE ra.provider_call_id = c.id), 0) AS response_archive,
         ao.response_bytes AS archive_response,
         ao.item_bytes AS archive_items,
         coalesce(ao.response_sha = (SELECT ra.payload_sha256 FROM external_platform.response_archives ra
                                      WHERE ra.provider_call_id = c.id), false) AS archive_dup,
         coalesce(rr.body_bytes, 0) AS restricted_bytes,
         coalesce(rr.body_text, 0) AS restricted_text,
         coalesce(rr.parsed_payload, 0) AS restricted_parsed,
         coalesce((SELECT pg_column_size(s.response_body) FROM external_platform.response_snapshots s
                    WHERE s.consumer_id = c.consumer_id AND s.operation = c.operation
                      AND s.request_fingerprint = c.request_fingerprint
                      AND s.last_success_call_id = c.id), 0) AS snapshot_min,
         CASE WHEN c.request_rank = 1
              THEN coalesce((SELECT pg_column_size(u.response_body) FROM public.usage_requests u
                              WHERE u.id = c.usage_request_id), 0)
              ELSE 0 END AS usage_body,
         (SELECT pg_column_size(j.payload)
            FROM mxq.jobs j
           WHERE (SELECT job_lookup_ready FROM gate)
             AND j.queue = 'mx-insight-hub:ingest'
             AND j.dedupe_key = 'external-platform:' || c.provider_key || ':' || c.id::text
           ORDER BY j.created_at DESC
           LIMIT 1) AS job_bytes
    FROM scaled c
    CROSS JOIN LATERAL (
      SELECT coalesce(sum(pg_column_size(a.raw_payload)) FILTER (WHERE a.object_kind = 'response'), 0) AS response_bytes,
             coalesce(sum(pg_column_size(a.raw_payload)) FILTER (WHERE a.object_kind <> 'response'), 0) AS item_bytes,
             min(a.payload_sha256) FILTER (WHERE a.object_kind = 'response') AS response_sha
        FROM external_platform.archive_objects a
       WHERE a.provider_call_id = c.id
    ) ao
    LEFT JOIN LATERAL (
      SELECT pg_column_size(r.body_bytes) AS body_bytes,
             pg_column_size(r.body_text) AS body_text,
             pg_column_size(r.parsed_payload) AS parsed_payload
        FROM control.external_platform_restricted_raw_responses r
       WHERE r.provider_call_id = c.id
      OFFSET 0
    ) rr ON true
),
totals AS (
  SELECT *, coalesce(job_bytes, 0) AS ingest_job,
         response_archive + archive_response + archive_items + restricted_bytes + restricted_text
           + restricted_parsed + snapshot_min + usage_body + coalesce(job_bytes, 0) AS total
    FROM sized
)
SELECT coalesce(provider_key, 'ALL') AS provider_key, platform, operation,
       round(sum(scale)) AS calls_24h,
       count(*) AS measured,
       count(*) FILTER (WHERE outcome = 'succeeded') AS succeeded,
       count(*) FILTER (WHERE job_bytes IS NOT NULL) AS with_job,
       round(avg(item_count), 1) AS items_per_call,
       round(avg(response_archive)) AS response_archive,
       round(avg(archive_response)) AS archive_response,
       round(avg(archive_items)) AS archive_items,
       round(avg(restricted_bytes)) AS restricted_bytes,
       round(avg(restricted_text)) AS restricted_text,
       round(avg(restricted_parsed)) AS restricted_parsed,
       round(avg(snapshot_min)) AS snapshot_min,
       round(avg(usage_body)) AS usage_body,
       round(avg(ingest_job)) AS ingest_job,
       round(avg(total)) AS total_per_call,
       pg_size_pretty(round(sum(total * scale))) AS total_24h,
       round(100.0 * count(*) FILTER (WHERE archive_dup) / count(*), 1) AS archive_dup_pct,
       (SELECT job_lookup_ready FROM gate) AS job_lookup_ready
  FROM totals
 GROUP BY GROUPING SETS ((provider_key, platform, operation), ())
 ORDER BY sum(total * scale) DESC NULLS LAST;

-- 3. The same window summed per copy (scaled to 24h), and each copy's share.
--    Compare the total with wal_per_day from section 1.
WITH RECURSIVE providers AS (
  (SELECT provider_key FROM external_platform.provider_calls ORDER BY provider_key LIMIT 1)
  UNION ALL
  SELECT (SELECT c.provider_key FROM external_platform.provider_calls c
           WHERE c.provider_key > p.provider_key ORDER BY c.provider_key LIMIT 1)
    FROM providers p
   WHERE p.provider_key IS NOT NULL
),
gate AS (
  SELECT EXISTS (
    SELECT 1 FROM pg_index
     WHERE indexrelid = to_regclass('mxq.jobs_dedupe_lookup_idx') AND indisvalid AND indisready
  ) AS job_lookup_ready
),
windowed AS (
  SELECT p.provider_key,
         (SELECT count(*) FROM external_platform.provider_calls c
           WHERE c.provider_key = p.provider_key AND c.started_at >= now() - interval '24 hours') AS calls_24h
    FROM providers p
   WHERE p.provider_key IS NOT NULL
),
calls AS (
  SELECT w.calls_24h, c.*
    FROM windowed w
    CROSS JOIN LATERAL (
      SELECT c.id, c.provider_key, c.operation, c.usage_request_id, c.call_ordinal,
             c.consumer_id, c.request_fingerprint
        FROM external_platform.provider_calls c
       WHERE c.provider_key = w.provider_key
         AND c.started_at >= now() - interval '24 hours'
       ORDER BY c.started_at DESC
       LIMIT 5000
    ) c
   WHERE w.calls_24h > 0
),
scaled AS (
  SELECT c.*, c.calls_24h::numeric / count(*) OVER (PARTITION BY c.provider_key) AS scale,
         row_number() OVER (PARTITION BY c.usage_request_id ORDER BY c.call_ordinal, c.id) AS request_rank
    FROM calls c
),
sized AS (
  SELECT c.scale,
         coalesce((SELECT pg_column_size(ra.raw_payload) FROM external_platform.response_archives ra
                    WHERE ra.provider_call_id = c.id), 0) AS response_archives,
         ao.response_bytes AS archive_objects_response,
         ao.item_bytes AS archive_objects_items,
         coalesce(rr.body_bytes, 0) AS restricted_body_bytes,
         coalesce(rr.body_text, 0) AS restricted_body_text,
         coalesce(rr.parsed_payload, 0) AS restricted_parsed_payload,
         coalesce((SELECT pg_column_size(s.response_body) FROM external_platform.response_snapshots s
                    WHERE s.consumer_id = c.consumer_id AND s.operation = c.operation
                      AND s.request_fingerprint = c.request_fingerprint
                      AND s.last_success_call_id = c.id), 0) AS response_snapshots_min,
         CASE WHEN c.request_rank = 1
              THEN coalesce((SELECT pg_column_size(u.response_body) FROM public.usage_requests u
                              WHERE u.id = c.usage_request_id), 0)
              ELSE 0 END AS usage_requests_body,
         coalesce((SELECT pg_column_size(j.payload)
                     FROM mxq.jobs j
                    WHERE (SELECT job_lookup_ready FROM gate)
                      AND j.queue = 'mx-insight-hub:ingest'
                      AND j.dedupe_key = 'external-platform:' || c.provider_key || ':' || c.id::text
                    ORDER BY j.created_at DESC
                    LIMIT 1), 0) AS mxq_jobs_payload
    FROM scaled c
    CROSS JOIN LATERAL (
      SELECT coalesce(sum(pg_column_size(a.raw_payload)) FILTER (WHERE a.object_kind = 'response'), 0) AS response_bytes,
             coalesce(sum(pg_column_size(a.raw_payload)) FILTER (WHERE a.object_kind <> 'response'), 0) AS item_bytes
        FROM external_platform.archive_objects a
       WHERE a.provider_call_id = c.id
    ) ao
    LEFT JOIN LATERAL (
      SELECT pg_column_size(r.body_bytes) AS body_bytes,
             pg_column_size(r.body_text) AS body_text,
             pg_column_size(r.parsed_payload) AS parsed_payload
        FROM control.external_platform_restricted_raw_responses r
       WHERE r.provider_call_id = c.id
      OFFSET 0
    ) rr ON true
),
unpivoted AS (
  SELECT t.copy, round(sum(t.bytes * s.scale)) AS bytes
    FROM sized s
    CROSS JOIN LATERAL (VALUES
      ('response_archives.raw_payload', s.response_archives),
      ('archive_objects (response rows)', s.archive_objects_response),
      ('archive_objects (item rows)', s.archive_objects_items),
      ('restricted.body_bytes', s.restricted_body_bytes),
      ('restricted.body_text', s.restricted_body_text),
      ('restricted.parsed_payload', s.restricted_parsed_payload),
      ('response_snapshots.response_body (min)', s.response_snapshots_min),
      ('usage_requests.response_body', s.usage_requests_body),
      ('mxq.jobs.payload', s.mxq_jobs_payload)
    ) AS t(copy, bytes)
   GROUP BY t.copy
)
SELECT copy, pg_size_pretty(bytes) AS bytes_24h,
       round(100.0 * bytes / nullif(sum(bytes) OVER (), 0), 1) AS pct
  FROM unpivoted
 ORDER BY bytes DESC NULLS LAST;

-- 4. The 200 newest external-platform ingest jobs: how much of each payload is
--    raw item text, and how much of that is an exact copy of an archive_objects
--    item row of the same call (what a reference could replace). Sizes here
--    are uncompressed text; removable_pct applies to the stored job size.
WITH recent AS (
  SELECT j.id, j.payload
    FROM mxq.jobs j
   WHERE j.queue = 'mx-insight-hub:ingest'
   ORDER BY j.id DESC
   LIMIT 200
),
jobs AS (
  SELECT id,
         payload->>'providerKey' AS provider_key,
         payload->>'platform' AS platform,
         payload->>'datasetId' AS dataset_id,
         CASE WHEN payload->>'providerCallId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN (payload->>'providerCallId')::uuid END AS call_id,
         pg_column_size(payload) AS stored_bytes,
         octet_length(payload::text) AS text_bytes,
         CASE WHEN jsonb_typeof(payload->'records') = 'array' THEN payload->'records' ELSE '[]'::jsonb END AS records
    FROM recent
   WHERE payload->>'kind' = 'external-platform-result'
),
archive AS (
  SELECT a.provider_call_id, md5(a.raw_payload::text) AS digest
    FROM external_platform.archive_objects a
   WHERE a.provider_call_id IN (SELECT call_id FROM jobs WHERE call_id IS NOT NULL)
     AND a.object_kind <> 'response'
),
items AS (
  SELECT j.id,
         coalesce(octet_length((r->'rawItem')::text), 0) AS raw_bytes,
         coalesce(octet_length((r->'extensions'->'sourceItem')::text), 0) AS source_item_bytes,
         coalesce((r->'extensions'->'sourceItem') = (r->'rawItem'), false) AS source_item_is_raw,
         EXISTS (
           SELECT 1 FROM archive a
            WHERE a.provider_call_id = j.call_id AND a.digest = md5((r->'rawItem')::text)
         ) AS raw_in_archive
    FROM jobs j
    CROSS JOIN LATERAL jsonb_array_elements(j.records) AS r
),
per_job AS (
  SELECT j.id, j.provider_key, j.platform, j.dataset_id, j.stored_bytes, j.text_bytes,
         count(i.id) AS records,
         coalesce(sum(i.raw_bytes), 0) AS raw_bytes,
         coalesce(sum(i.source_item_bytes), 0) AS source_item_bytes,
         count(i.id) FILTER (WHERE i.raw_in_archive) AS raw_in_archive,
         coalesce(sum(i.raw_bytes) FILTER (WHERE i.raw_in_archive), 0)
           + coalesce(sum(i.source_item_bytes) FILTER (WHERE i.raw_in_archive AND i.source_item_is_raw), 0)
           AS removable_bytes
    FROM jobs j
    LEFT JOIN items i ON i.id = j.id
   GROUP BY 1, 2, 3, 4, 5, 6
)
SELECT provider_key, platform, dataset_id,
       count(*) AS jobs,
       sum(records) AS records,
       round(avg(stored_bytes)) AS stored_job_bytes,
       round(100.0 * sum(raw_bytes) / nullif(sum(text_bytes), 0), 1) AS raw_item_pct,
       round(100.0 * sum(source_item_bytes) / nullif(sum(text_bytes), 0), 1) AS source_item_pct,
       round(100.0 * sum(raw_in_archive) / nullif(sum(records), 0), 1) AS raw_in_archive_pct,
       round(100.0 * sum(removable_bytes) / nullif(sum(text_bytes), 0), 1) AS removable_pct
  FROM per_job
 GROUP BY 1, 2, 3
 ORDER BY sum(stored_bytes) DESC;

-- 5. Ingest side for the same jobs' objects: what one more sighting rewrites.
--    Every sighting upserts source_objects.raw_payload and the canonical
--    TOAST columns even when unchanged; revisions only grow on a change.
--    observations is a lower bound on sightings (identical metrics dedupe).
WITH recent AS (
  SELECT j.payload
    FROM mxq.jobs j
   WHERE j.queue = 'mx-insight-hub:ingest'
   ORDER BY j.id DESC
   LIMIT 200
),
objects AS (
  SELECT DISTINCT payload->>'providerKey' AS provider_key,
         payload->>'platform' AS platform,
         payload->>'datasetId' AS dataset_id,
         r->>'objectType' AS object_type,
         r->>'externalId' AS external_id
    FROM recent
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(payload->'records') = 'array' THEN payload->'records' ELSE '[]'::jsonb END
    ) AS r
   WHERE payload->>'kind' = 'external-platform-result'
)
SELECT o.provider_key, o.platform, o.dataset_id,
       count(*) AS objects,
       round(avg(pg_column_size(so.raw_payload))) AS source_raw_bytes,
       round(avg(so.current_revision), 2) AS source_revisions,
       round(avg(coalesce(pg_column_size(cr.extensions), 0) + coalesce(pg_column_size(cr.stable_fields), 0)
                 + coalesce(pg_column_size(cr.body), 0))) AS canonical_toast_bytes,
       round(avg(cr.current_revision), 2) AS canonical_revisions,
       round(avg(obs.observations), 1) AS observations
  FROM objects o
  LEFT JOIN ingest.source_objects so
    ON so.connector_id = 'external-platform:' || o.provider_key
   AND so.stream_id = o.platform || '.external-platform.v1'
   AND so.object_type = o.object_type AND so.source_key = o.external_id
  LEFT JOIN core.canonical_records cr
    ON cr.dataset_id = o.dataset_id AND cr.platform = o.platform
   AND cr.object_type = o.object_type AND cr.external_id = o.external_id
  LEFT JOIN LATERAL (
    SELECT count(*) AS observations FROM core.observations ob WHERE ob.record_id = cr.id
  ) obs ON true
 GROUP BY 1, 2, 3
 ORDER BY count(*) DESC;

-- 6. mxq.jobs size, vacuum state, oldest row, and dead jobs (kept forever).
SELECT pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
       pg_size_pretty(pg_relation_size(c.oid)) AS heap,
       pg_size_pretty(coalesce(pg_total_relation_size(nullif(c.reltoastrelid, 0)), 0)) AS toast,
       pg_size_pretty(pg_indexes_size(c.oid)) AS indexes,
       s.n_live_tup, s.n_dead_tup, s.last_autovacuum, s.autovacuum_count,
       (SELECT created_at FROM mxq.jobs ORDER BY id LIMIT 1) AS oldest_created_at
  FROM pg_class c
  LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
 WHERE c.oid = to_regclass('mxq.jobs');

SELECT queue, payload->>'kind' AS kind, payload->>'providerKey' AS provider_key,
       payload->>'platform' AS platform, payload->>'datasetId' AS dataset_id,
       left(last_error, 120) AS last_error, count(*) AS dead, max(updated_at) AS latest
  FROM (SELECT * FROM mxq.jobs WHERE status = 'dead' ORDER BY updated_at DESC LIMIT 5000) d
 GROUP BY 1, 2, 3, 4, 5, 6
 ORDER BY count(*) DESC
 LIMIT 30;

-- 7. Retention sizing: done rows by age. Full heap scan of mxq.jobs; payload
--    sizes come from TOAST pointers, so no TOAST pages are read.
SELECT queue, status, count(*) AS jobs,
       count(*) FILTER (WHERE status = 'done' AND completed_at < now() - interval '7 days') AS done_7d,
       count(*) FILTER (WHERE status = 'done' AND completed_at < now() - interval '14 days') AS done_14d,
       count(*) FILTER (WHERE status = 'done' AND completed_at < now() - interval '30 days') AS done_30d,
       pg_size_pretty(sum(pg_column_size(payload)) FILTER (
         WHERE status = 'done' AND completed_at < now() - interval '14 days')) AS done_14d_payload,
       min(created_at) AS oldest
  FROM mxq.jobs
 GROUP BY 1, 2
 ORDER BY 1, 2;

ROLLBACK;
