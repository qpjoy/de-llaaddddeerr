-- Shared PostgreSQL transport profiles.
--
-- A profile owns only database transport/credentials. Physical source
-- locators (schema/table/cursor/id) remain on catalog.external_sources so one
-- database can serve multiple independently checkpointed sources. Existing
-- inline source connections remain valid while sources migrate explicitly.

CREATE TABLE IF NOT EXISTS catalog.database_connections (
  id uuid PRIMARY KEY,
  connection_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  engine text NOT NULL DEFAULT 'postgresql'
    CHECK (engine IN ('postgresql')),
  connection jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(connection) = 'object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE catalog.external_sources
  ADD COLUMN IF NOT EXISTS database_connection_id uuid
    REFERENCES catalog.database_connections(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS external_sources_database_connection_idx
  ON catalog.external_sources (database_connection_id)
  WHERE database_connection_id IS NOT NULL;

COMMENT ON TABLE catalog.database_connections IS
  'Admin-managed shared PostgreSQL transport profiles. Source table/cursor locators remain in catalog.external_sources.connection.';

COMMENT ON COLUMN catalog.external_sources.database_connection_id IS
  'Optional shared transport profile. NULL preserves the legacy complete inline connection contract.';
