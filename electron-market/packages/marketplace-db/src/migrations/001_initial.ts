/**
 * Migration v1 — initial schema.
 *
 * Every migration exports an object that the Migrator picks up. SQL lives
 * inline as a tagged template so we can:
 *   - bundle into a single JS file (no extra .sql copying at build time)
 *   - hash it for drift detection
 *   - ship the same shape over the wire when fetched from a remote release
 *     (the server returns the same `{ version, name, up, down }` object).
 */
import type { Migration } from '../Migrator';

const up = `
CREATE TABLE marketplace_entries (
  id TEXT PRIMARY KEY,
  npm TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  latest_version TEXT NOT NULL,
  manifest_url TEXT,
  tarball_url TEXT,
  homepage TEXT,
  author TEXT,
  category TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  bootstrap INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'public',
  spec_version INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT,
  source TEXT NOT NULL DEFAULT 'remote',
  fetched_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE marketplace_versions (
  entry_id TEXT NOT NULL,
  version TEXT NOT NULL,
  changelog TEXT,
  released_at TEXT,
  min_host_version TEXT,
  max_host_version TEXT,
  deprecated INTEGER NOT NULL DEFAULT 0,
  yanked INTEGER NOT NULL DEFAULT 0,
  manifest_checksum TEXT,
  tarball_checksum TEXT,
  PRIMARY KEY (entry_id, version),
  FOREIGN KEY (entry_id) REFERENCES marketplace_entries(id) ON DELETE CASCADE
);

CREATE TABLE installed_plugins (
  id TEXT PRIMARY KEY,
  npm TEXT NOT NULL,
  version TEXT NOT NULL,
  install_path TEXT NOT NULL,
  install_source TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  granted_permissions_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL,
  error_message TEXT,
  marketplace_entry_id TEXT,
  installed_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (marketplace_entry_id) REFERENCES marketplace_entries(id) ON DELETE SET NULL
);

CREATE TABLE plugin_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  meta_json TEXT,
  correlation_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX plugin_logs_plugin_idx ON plugin_logs(plugin_id, id DESC);

CREATE TABLE remote_sync (
  scope TEXT PRIMARY KEY,
  last_release TEXT,
  last_fetched_at TEXT,
  next_check_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  data_json TEXT
);

CREATE TABLE auth_session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  access_token TEXT,
  refresh_token TEXT,
  expires_at TEXT,
  user_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE meta_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const down = `
DROP TABLE IF EXISTS meta_kv;
DROP TABLE IF EXISTS auth_session;
DROP TABLE IF EXISTS remote_sync;
DROP INDEX IF EXISTS plugin_logs_plugin_idx;
DROP TABLE IF EXISTS plugin_logs;
DROP TABLE IF EXISTS installed_plugins;
DROP TABLE IF EXISTS marketplace_versions;
DROP TABLE IF EXISTS marketplace_entries;
`;

const migration: Migration = {
  version: 1,
  name: 'initial schema',
  up,
  down
};

export default migration;
