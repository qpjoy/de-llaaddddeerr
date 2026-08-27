-- Independently governed source-catalog owners/stewards.
--
-- source_catalog_entries.owner remains a compatibility display projection.
-- owner_id is the stable relationship. linked_account_id is deliberately an
-- opaque nullable placeholder: this migration has no Launcher identity FK.

CREATE TABLE IF NOT EXISTS catalog.source_catalog_owners (
  id uuid PRIMARY KEY,
  owner_key text NOT NULL UNIQUE
    CHECK (owner_key ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  display_name text NOT NULL
    CHECK (length(btrim(display_name)) BETWEEN 1 AND 160),
  normalized_name text NOT NULL UNIQUE
    CHECK (length(btrim(normalized_name)) BETWEEN 1 AND 160),
  description text,
  linked_account_id text
    CHECK (linked_account_id IS NULL OR length(btrim(linked_account_id)) BETWEEN 1 AND 160),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS source_catalog_owners_linked_account_idx
  ON catalog.source_catalog_owners (linked_account_id)
  WHERE linked_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS source_catalog_owners_active_name_idx
  ON catalog.source_catalog_owners (display_name, id)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS catalog.source_catalog_owner_events (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL
    REFERENCES catalog.source_catalog_owners(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  actor text NOT NULL CHECK (length(btrim(actor)) BETWEEN 1 AND 160),
  from_revision integer CHECK (from_revision IS NULL OR from_revision > 0),
  to_revision integer NOT NULL CHECK (to_revision > 0),
  changes jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(changes) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_revision IS NULL OR to_revision > from_revision)
);

CREATE INDEX IF NOT EXISTS source_catalog_owner_events_owner_idx
  ON catalog.source_catalog_owner_events (owner_id, created_at DESC, id DESC);

-- Preserve any free-text owners that existed before managed owners were added.
WITH normalized_owners AS (
  SELECT min(btrim(normalize(owner, NFKC))) AS display_name,
         lower(btrim(normalize(owner, NFKC))) AS normalized_name,
         md5('owner:' || lower(btrim(normalize(owner, NFKC)))) AS digest
    FROM catalog.source_catalog_entries
   WHERE owner IS NOT NULL AND btrim(normalize(owner, NFKC)) <> ''
   GROUP BY lower(btrim(normalize(owner, NFKC)))
), seeded_owners AS (
  SELECT (
           substr(digest, 1, 8) || '-' ||
           substr(digest, 9, 4) || '-5' ||
           substr(digest, 14, 3) || '-a' ||
           substr(digest, 18, 3) || '-' ||
           substr(digest, 21, 12)
         )::uuid AS id,
         'owner-' || digest AS owner_key,
         display_name,
         normalized_name
    FROM normalized_owners
)
INSERT INTO catalog.source_catalog_owners
  (id, owner_key, display_name, normalized_name)
SELECT id, owner_key, display_name, normalized_name
  FROM seeded_owners
ON CONFLICT (normalized_name) DO NOTHING;

INSERT INTO catalog.source_catalog_owner_events
  (id, owner_id, event_type, actor, from_revision, to_revision, changes)
SELECT (
         substr(seed.digest, 1, 8) || '-' ||
         substr(seed.digest, 9, 4) || '-5' ||
         substr(seed.digest, 14, 3) || '-b' ||
         substr(seed.digest, 18, 3) || '-' ||
         substr(seed.digest, 21, 12)
       )::uuid,
       owner.id,
       'seed_import',
       'migration-038',
       NULL,
       owner.revision,
       jsonb_build_object('after', jsonb_build_object(
         'id', owner.id,
         'ownerKey', owner.owner_key,
         'displayName', owner.display_name,
         'revision', owner.revision
       ))
  FROM catalog.source_catalog_owners owner
 CROSS JOIN LATERAL (
   SELECT md5('event:' || owner.owner_key) AS digest
 ) seed
 WHERE owner.owner_key LIKE 'owner-%'
ON CONFLICT (id) DO NOTHING;

ALTER TABLE catalog.source_catalog_entries
  ADD COLUMN IF NOT EXISTS owner_id uuid
    REFERENCES catalog.source_catalog_owners(id) ON DELETE RESTRICT;

UPDATE catalog.source_catalog_entries entry
   SET owner_id = owner.id
  FROM catalog.source_catalog_owners owner
 WHERE entry.owner_id IS NULL
   AND entry.owner IS NOT NULL
   AND lower(btrim(normalize(entry.owner, NFKC))) = owner.normalized_name;

CREATE INDEX IF NOT EXISTS source_catalog_entries_owner_id_idx
  ON catalog.source_catalog_entries (owner_id, updated_at DESC)
  WHERE owner_id IS NOT NULL;

COMMENT ON TABLE catalog.source_catalog_owners IS
  'Managed source-catalog owners/stewards, independent from login identities.';

COMMENT ON COLUMN catalog.source_catalog_owners.linked_account_id IS
  'Reserved opaque login-account reference; intentionally has no Launcher identity foreign key.';

COMMENT ON COLUMN catalog.source_catalog_entries.owner IS
  'Compatibility display projection; managed assignments use owner_id as authority.';

