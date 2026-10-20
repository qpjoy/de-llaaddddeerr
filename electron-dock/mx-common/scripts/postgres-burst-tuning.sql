-- Reload-only PostgreSQL settings for burst writes on the shared mx-common
-- instance (Hub's database). No restart and no durability change: fsync,
-- synchronous_commit and full_page_writes stay as they are.
--
--   kubectl -n mx-common exec -i mx-common-postgres-0 -- \
--     psql -U mx_common -d mx_common -v ON_ERROR_STOP=1 < scripts/postgres-burst-tuning.sql
--
-- Values persist in PGDATA/postgresql.auto.conf. Roll back one setting with
--   ALTER SYSTEM RESET <name>; SELECT pg_reload_conf();
--
-- Why each one (all trade CPU or disk space for fewer/smaller device writes):
--   max_wal_size/checkpoint_timeout  fewer forced checkpoints during bursts, so
--     fewer full-page images in WAL and fewer dirty-page flush storms next to
--     etcd. Costs WAL disk space and a longer crash recovery.
--   wal_compression                  compress those full-page images (CPU).
--   default_toast_compression        lz4 for new large JSON values: much less
--     CPU per raw-response INSERT than pglz, similar size.
--   track_io_timing / log_lock_waits evidence for the next incident: I/O time
--     per statement/database and any lock wait longer than deadlock_timeout.

\set ON_ERROR_STOP on

-- Settings passed with -c in 10-postgres.yaml cannot be overridden here.
-- Refuse loudly instead of reporting a change that never takes effect.
SELECT CASE WHEN count(*) > 0 THEN 'true' ELSE 'false' END AS forced
  FROM pg_settings
 WHERE source = 'command line'
   AND name IN ('max_wal_size', 'min_wal_size', 'checkpoint_timeout', 'wal_compression',
                'default_toast_compression', 'track_io_timing', 'log_lock_waits') \gset
\if :forced
  -- ON_ERROR_STOP turns this into a non-zero psql exit before any change.
  DO $$ BEGIN RAISE EXCEPTION 'a burst-tuning setting is forced on the postgres command line; change 10-postgres.yaml instead'; END $$;
\endif

-- lz4 only when this build supports it.
SELECT CASE WHEN 'lz4' = ANY(enumvals) THEN 'lz4' ELSE 'pglz' END AS wal_codec
  FROM pg_settings WHERE name = 'wal_compression' \gset
SELECT CASE WHEN 'lz4' = ANY(enumvals) THEN 'lz4' ELSE 'pglz' END AS toast_codec
  FROM pg_settings WHERE name = 'default_toast_compression' \gset

\echo 'before:'
SELECT name, setting, unit, source FROM pg_settings
 WHERE name IN ('max_wal_size', 'min_wal_size', 'checkpoint_timeout', 'checkpoint_completion_target',
                'wal_compression', 'default_toast_compression', 'track_io_timing', 'log_lock_waits')
 ORDER BY name;

ALTER SYSTEM SET max_wal_size = '8GB';
ALTER SYSTEM SET min_wal_size = '2GB';
ALTER SYSTEM SET checkpoint_timeout = '15min';
ALTER SYSTEM SET checkpoint_completion_target = 0.9;
ALTER SYSTEM SET wal_compression = :'wal_codec';
ALTER SYSTEM SET default_toast_compression = :'toast_codec';
ALTER SYSTEM SET track_io_timing = on;
ALTER SYSTEM SET log_lock_waits = on;
SELECT pg_reload_conf();

-- pg_reload_conf only signals; give the postmaster a moment before reading back.
SELECT pg_sleep(1);
\echo 'after (pending_restart must be false for every row):'
SELECT name, setting, unit, source, pending_restart FROM pg_settings
 WHERE name IN ('max_wal_size', 'min_wal_size', 'checkpoint_timeout', 'checkpoint_completion_target',
                'wal_compression', 'default_toast_compression', 'track_io_timing', 'log_lock_waits')
 ORDER BY name;
