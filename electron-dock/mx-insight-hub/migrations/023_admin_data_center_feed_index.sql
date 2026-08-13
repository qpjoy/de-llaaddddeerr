-- Keep the Admin canonical browser on a narrow ordered index before joining
-- the potentially large current revision payload. The Internal PostgreSQL
-- runtime has a deliberately small /dev/shm, so avoid a parallel index build.
SET LOCAL max_parallel_maintenance_workers = 0;

CREATE INDEX IF NOT EXISTS canonical_records_admin_feed_idx
  ON core.canonical_records (
    (coalesce(event_time, collected_at, last_seen_at, first_seen_at)) DESC,
    id DESC
  );
