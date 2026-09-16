\set ON_ERROR_STOP on
-- Run outside a transaction. Build online: do not block canonical ingestion.
SET lock_timeout = '2s';
SET statement_timeout = '15min';
SET max_parallel_maintenance_workers = 0;

-- Repair interrupted concurrent builds of these owned index names.
SELECT format('DROP INDEX CONCURRENTLY %I.%I', n.nspname, c.relname)
FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'core' AND NOT i.indisvalid
AND c.relname IN ('canonical_browser_accounts_v1_idx', 'canonical_browser_event_v1_idx', 'canonical_browser_profiles_v1_idx')
\gexec

CREATE INDEX CONCURRENTLY IF NOT EXISTS canonical_browser_accounts_v1_idx
ON core.canonical_records (
  platform,
  (CASE WHEN object_type IN ('user','account','profile') THEN NULLIF(external_id, '') ELSE NULLIF(author_external_id, '') END),
  collected_at DESC NULLS LAST,
  id DESC
) INCLUDE (object_type)
WHERE deleted_at IS NULL
AND (CASE WHEN object_type IN ('user','account','profile') THEN NULLIF(external_id, '') ELSE NULLIF(author_external_id, '') END) IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS canonical_browser_event_v1_idx
ON core.canonical_records (event_time DESC, id DESC)
WHERE deleted_at IS NULL;

-- Profile lookup must not scan every content row of prolific accounts.
CREATE INDEX CONCURRENTLY IF NOT EXISTS canonical_browser_profiles_v1_idx
ON core.canonical_records (
  platform,
  (CASE WHEN object_type IN ('user','account','profile') THEN NULLIF(external_id, '') ELSE NULLIF(author_external_id, '') END),
  collected_at DESC NULLS LAST, id DESC
)
WHERE deleted_at IS NULL AND object_type IN ('user','account','profile');

DO $$ BEGIN
  IF (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'core' AND i.indisvalid AND i.indisready
      AND i.indrelid = 'core.canonical_records'::regclass
      AND c.relname IN ('canonical_browser_accounts_v1_idx', 'canonical_browser_event_v1_idx', 'canonical_browser_profiles_v1_idx')) <> 3 THEN
    RAISE EXCEPTION 'Data browser serving indexes are not ready';
  END IF;
END $$;
