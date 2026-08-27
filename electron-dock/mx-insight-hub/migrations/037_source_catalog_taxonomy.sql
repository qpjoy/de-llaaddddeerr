-- Governed taxonomy terms for the source catalog.
--
-- Catalog entries keep their migration-036 text fields for API compatibility.
-- Terms provide a separately managed dictionary. Archiving is guarded by the
-- service when any catalog entry (including an archived entry) still uses the
-- term; no entry data is ever cascaded from a taxonomy mutation.

CREATE TABLE IF NOT EXISTS catalog.source_catalog_terms (
  id uuid PRIMARY KEY,
  term_key text NOT NULL UNIQUE
    CHECK (term_key ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  kind text NOT NULL
    CHECK (kind IN ('major_category', 'scenario', 'region', 'tag')),
  display_name text NOT NULL
    CHECK (length(btrim(display_name)) BETWEEN 1 AND 160),
  normalized_name text NOT NULL
    CHECK (length(btrim(normalized_name)) BETWEEN 1 AND 160),
  description text,
  color text CHECK (color IS NULL OR color ~ '^#[0-9a-f]{6}$'),
  sort_order integer NOT NULL DEFAULT 0
    CHECK (sort_order BETWEEN 0 AND 100000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, normalized_name)
);

CREATE TABLE IF NOT EXISTS catalog.source_catalog_term_events (
  id uuid PRIMARY KEY,
  term_id uuid NOT NULL
    REFERENCES catalog.source_catalog_terms(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  actor text NOT NULL CHECK (length(btrim(actor)) BETWEEN 1 AND 160),
  from_revision integer CHECK (from_revision IS NULL OR from_revision > 0),
  to_revision integer NOT NULL CHECK (to_revision > 0),
  changes jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(changes) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_revision IS NULL OR to_revision > from_revision)
);

-- Canonical names and aliases are also the phase-1 related-data join keys.
-- Owning each normalized key once prevents one canonical record from appearing
-- under two directory entries. Archived entries retain ownership so restore is
-- always safe and deterministic.
CREATE TABLE IF NOT EXISTS catalog.source_catalog_entry_names (
  normalized_name text PRIMARY KEY
    CHECK (length(btrim(normalized_name)) BETWEEN 1 AND 160),
  entry_id uuid NOT NULL
    REFERENCES catalog.source_catalog_entries(id) ON DELETE RESTRICT,
  display_name text NOT NULL
    CHECK (length(btrim(display_name)) BETWEEN 1 AND 160),
  name_kind text NOT NULL CHECK (name_kind IN ('canonical', 'alias')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_id, normalized_name)
);

CREATE INDEX IF NOT EXISTS source_catalog_entry_names_entry_idx
  ON catalog.source_catalog_entry_names (entry_id, name_kind, normalized_name);

CREATE INDEX IF NOT EXISTS source_catalog_terms_active_kind_idx
  ON catalog.source_catalog_terms (kind, sort_order, display_name, id)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS source_catalog_term_events_term_idx
  ON catalog.source_catalog_term_events (term_id, created_at DESC, id DESC);

DO $$
BEGIN
  IF EXISTS (
    SELECT normalized_name
      FROM (
        SELECT id AS entry_id,
               lower(btrim(normalize(canonical_name, NFKC))) AS normalized_name
          FROM catalog.source_catalog_entries
        UNION ALL
        SELECT entry.id,
               lower(btrim(normalize(alias.display_name, NFKC)))
          FROM catalog.source_catalog_entries entry
         CROSS JOIN LATERAL unnest(entry.aliases) AS alias(display_name)
      ) names
     WHERE normalized_name <> ''
     GROUP BY normalized_name
    HAVING count(DISTINCT entry_id) > 1
  ) THEN
    RAISE EXCEPTION 'source catalog canonical-name/alias ownership conflict';
  END IF;
END
$$;

WITH entry_names AS (
  SELECT id AS entry_id,
         canonical_name AS display_name,
         'canonical'::text AS name_kind
    FROM catalog.source_catalog_entries
  UNION ALL
  SELECT entry.id,
         alias.display_name,
         'alias'::text
    FROM catalog.source_catalog_entries entry
   CROSS JOIN LATERAL unnest(entry.aliases) AS alias(display_name)
), ranked_names AS (
  SELECT lower(btrim(normalize(display_name, NFKC))) AS normalized_name,
         entry_id,
         btrim(normalize(display_name, NFKC)) AS display_name,
         name_kind,
         row_number() OVER (
           PARTITION BY lower(btrim(normalize(display_name, NFKC)))
           ORDER BY CASE name_kind WHEN 'canonical' THEN 0 ELSE 1 END
         ) AS position
    FROM entry_names
   WHERE btrim(normalize(display_name, NFKC)) <> ''
)
INSERT INTO catalog.source_catalog_entry_names
  (normalized_name, entry_id, display_name, name_kind)
SELECT normalized_name, entry_id, display_name, name_kind
  FROM ranked_names
 WHERE position = 1
ON CONFLICT (normalized_name) DO NOTHING;

WITH raw_terms(kind, display_name) AS (
  SELECT 'major_category'::text, major_category
    FROM catalog.source_catalog_entries
  UNION
  SELECT 'scenario'::text, unnest(scenarios)
    FROM catalog.source_catalog_entries
  UNION
  SELECT 'region'::text, unnest(regions)
    FROM catalog.source_catalog_entries
  UNION
  SELECT 'tag'::text, unnest(tags)
    FROM catalog.source_catalog_entries
), normalized_terms AS (
  SELECT kind,
         min(btrim(normalize(display_name, NFKC))) AS display_name,
         lower(btrim(normalize(display_name, NFKC))) AS normalized_name,
         md5(kind || ':' || lower(btrim(normalize(display_name, NFKC)))) AS digest
    FROM raw_terms
   WHERE btrim(normalize(display_name, NFKC)) <> ''
   GROUP BY kind, lower(btrim(normalize(display_name, NFKC)))
), seeded_terms AS (
  SELECT (
           substr(digest, 1, 8) || '-' ||
           substr(digest, 9, 4) || '-5' ||
           substr(digest, 14, 3) || '-a' ||
           substr(digest, 18, 3) || '-' ||
           substr(digest, 21, 12)
         )::uuid AS id,
         kind || '-' || digest AS term_key,
         kind,
         display_name,
         normalized_name
    FROM normalized_terms
)
INSERT INTO catalog.source_catalog_terms
  (id, term_key, kind, display_name, normalized_name)
SELECT id, term_key, kind, display_name, normalized_name
  FROM seeded_terms
ON CONFLICT (kind, normalized_name) DO NOTHING;

INSERT INTO catalog.source_catalog_term_events
  (id, term_id, event_type, actor, from_revision, to_revision, changes)
SELECT (
         substr(digest, 1, 8) || '-' ||
         substr(digest, 9, 4) || '-5' ||
         substr(digest, 14, 3) || '-b' ||
         substr(digest, 18, 3) || '-' ||
         substr(digest, 21, 12)
       )::uuid,
       term.id,
       'seed_import',
       'migration-037',
       NULL,
       term.revision,
       jsonb_build_object('after', jsonb_build_object(
         'id', term.id,
         'termKey', term.term_key,
         'kind', term.kind,
         'displayName', term.display_name,
         'revision', term.revision
       ))
  FROM catalog.source_catalog_terms term
 CROSS JOIN LATERAL (
   SELECT md5('event:' || term.term_key) AS digest
 ) seed
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE catalog.source_catalog_terms IS
  'Managed major-category, scenario, region and tag dictionary for source catalog entries.';

COMMENT ON TABLE catalog.source_catalog_term_events IS
  'Append-only audit events for source catalog taxonomy term revisions.';
