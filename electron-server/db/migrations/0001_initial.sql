-- Postgres counterpart to @qpjoy/marketplace-db's SQLite v1 schema.
-- Mirrors the *concepts* but uses Postgres-native types (jsonb, timestamptz).
-- Run with any standard migration tool (sqitch, goose, raw psql, etc.) once
-- DATABASE_URL is wired into electron-server.

CREATE TABLE marketplace_entries (
  id              text PRIMARY KEY,
  npm             text NOT NULL,
  name            text NOT NULL,
  description     text,
  latest_version  text NOT NULL,
  manifest_url    text,
  tarball_url     text,
  homepage        text,
  author          text,
  category        text,
  verified        boolean NOT NULL DEFAULT false,
  bootstrap       boolean NOT NULL DEFAULT false,
  visibility      text NOT NULL DEFAULT 'public'
                  CHECK (visibility IN ('public', 'free', 'paid', 'private')),
  spec_version    integer NOT NULL DEFAULT 1,
  metadata_json   jsonb,
  -- Server-only: which user owns this entry (for `private` + future author flows).
  owner_user_id   uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE marketplace_versions (
  entry_id          text NOT NULL REFERENCES marketplace_entries(id) ON DELETE CASCADE,
  version           text NOT NULL,
  changelog         text,
  released_at       timestamptz,
  min_host_version  text,
  max_host_version  text,
  deprecated        boolean NOT NULL DEFAULT false,
  yanked            boolean NOT NULL DEFAULT false,
  manifest_checksum text,
  tarball_checksum  text,
  tarball_url       text,
  PRIMARY KEY (entry_id, version)
);

CREATE TABLE plugin_manifests (
  entry_id     text NOT NULL,
  version      text NOT NULL,
  manifest     jsonb NOT NULL,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entry_id, version),
  FOREIGN KEY (entry_id, version) REFERENCES marketplace_versions(entry_id, version) ON DELETE CASCADE
);

CREATE TABLE audit_logs (
  id            bigserial PRIMARY KEY,
  actor_user_id uuid,
  actor_ip      inet,
  action        text NOT NULL,
  target_kind   text,
  target_id     text,
  meta          jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_actor_idx  ON audit_logs(actor_user_id, id DESC);
CREATE INDEX audit_logs_target_idx ON audit_logs(target_kind, target_id, id DESC);
