-- Curated virtual-supermarket publication state.
--
-- Mobile-commerce canonical rows remain immutable source evidence. A capture is
-- not public in this product until it has an explicit on_shelf listing. Manual
-- edits live only in this serving overlay and every change appends audit
-- evidence plus advances the storefront revision used by public cursors.

CREATE SCHEMA IF NOT EXISTS serving;

CREATE TABLE IF NOT EXISTS serving.virtual_supermarket_storefront (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  inventory_revision bigint NOT NULL DEFAULT 1 CHECK (inventory_revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO serving.virtual_supermarket_storefront (id, revision)
VALUES (true, 1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS serving.virtual_supermarket_categories (
  id uuid PRIMARY KEY,
  category_key text NOT NULL UNIQUE
    CHECK (category_key ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  display_name text NOT NULL
    CHECK (length(btrim(display_name)) BETWEEN 1 AND 160),
  department_key text NOT NULL
    CHECK (department_key ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  department_name text NOT NULL
    CHECK (length(btrim(department_name)) BETWEEN 1 AND 160),
  department_sort_order integer NOT NULL DEFAULT 0
    CHECK (department_sort_order BETWEEN 0 AND 1000000),
  aisle_key text NOT NULL
    CHECK (aisle_key ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  aisle_name text NOT NULL
    CHECK (length(btrim(aisle_name)) BETWEEN 1 AND 160),
  aisle_sort_order integer NOT NULL DEFAULT 0
    CHECK (aisle_sort_order BETWEEN 0 AND 1000000),
  shelf_key text NOT NULL
    CHECK (shelf_key ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  shelf_name text NOT NULL
    CHECK (length(btrim(shelf_name)) BETWEEN 1 AND 160),
  shelf_sort_order integer NOT NULL DEFAULT 0
    CHECK (shelf_sort_order BETWEEN 0 AND 1000000),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 1000000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS virtual_supermarket_categories_placement_idx
  ON serving.virtual_supermarket_categories
    (department_sort_order, department_key,
     aisle_sort_order, aisle_key,
     shelf_sort_order, shelf_key,
     sort_order, category_key)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS serving.virtual_supermarket_listing_state (
  record_id uuid PRIMARY KEY
    REFERENCES core.canonical_records(id) ON DELETE RESTRICT,
  publication_id uuid UNIQUE,
  status text NOT NULL CHECK (status IN ('on_shelf', 'off_shelf')),
  category_id uuid NOT NULL
    REFERENCES serving.virtual_supermarket_categories(id) ON DELETE RESTRICT,
  display_title text
    CHECK (display_title IS NULL OR length(btrim(display_title)) BETWEEN 1 AND 512),
  specification text
    CHECK (specification IS NULL OR length(btrim(specification)) BETWEEN 1 AND 1000),
  price_amount numeric(20,2) CHECK (price_amount IS NULL OR price_amount >= 0),
  currency char(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  shelf_position integer CHECK (shelf_position IS NULL OR shelf_position BETWEEN 0 AND 1000000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by text NOT NULL CHECK (length(btrim(created_by)) BETWEEN 1 AND 160),
  updated_by text NOT NULL CHECK (length(btrim(updated_by)) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((price_amount IS NULL) = (currency IS NULL)),
  CHECK (publication_id IS NULL OR publication_id <> record_id),
  CHECK (status <> 'on_shelf' OR publication_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS virtual_supermarket_listing_status_idx
  ON serving.virtual_supermarket_listing_state (status, category_id, shelf_position, record_id);

CREATE TABLE IF NOT EXISTS serving.virtual_supermarket_events (
  id uuid PRIMARY KEY,
  aggregate_type text NOT NULL CHECK (aggregate_type IN ('category', 'product')),
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  actor text NOT NULL CHECK (length(btrim(actor)) BETWEEN 1 AND 160),
  from_revision integer CHECK (from_revision IS NULL OR from_revision >= 0),
  to_revision integer NOT NULL CHECK (to_revision > 0),
  storefront_revision bigint NOT NULL CHECK (storefront_revision > 0),
  reason text CHECK (reason IS NULL OR length(reason) <= 500),
  changes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(changes) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (aggregate_type, aggregate_id, to_revision),
  CHECK (from_revision IS NULL OR to_revision > from_revision)
);

CREATE INDEX IF NOT EXISTS virtual_supermarket_events_aggregate_idx
  ON serving.virtual_supermarket_events
    (aggregate_type, aggregate_id, created_at DESC, id DESC);

-- A listed product may change when its canonical source revision advances.
-- Keep the public snapshot fence monotonic without writing any publication
-- state back into the canonical row.
CREATE OR REPLACE FUNCTION serving.bump_virtual_supermarket_on_canonical_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM serving.virtual_supermarket_listing_state listing
     WHERE listing.record_id = NEW.id
       AND listing.status = 'on_shelf'
  ) THEN
    UPDATE serving.virtual_supermarket_storefront
       SET revision = revision + 1,
           updated_at = now()
     WHERE id = true;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS virtual_supermarket_canonical_change
  ON core.canonical_records;

CREATE TRIGGER virtual_supermarket_canonical_change
AFTER UPDATE OF current_revision, deleted_at, stable_fields, title, author_name, collected_at
ON core.canonical_records
FOR EACH ROW
WHEN (
  OLD.current_revision IS DISTINCT FROM NEW.current_revision
  OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
  OR OLD.stable_fields IS DISTINCT FROM NEW.stable_fields
  OR OLD.title IS DISTINCT FROM NEW.title
  OR OLD.author_name IS DISTINCT FROM NEW.author_name
  OR OLD.collected_at IS DISTINCT FROM NEW.collected_at
)
EXECUTE FUNCTION serving.bump_virtual_supermarket_on_canonical_change();

-- Admin inventory pagination is fenced independently from the public
-- storefront. Advance this counter once per source write statement, not once
-- per row, so continuously appended mobile captures do not require hashing the
-- complete canonical dataset on every Admin page.
CREATE OR REPLACE FUNCTION serving.bump_virtual_supermarket_inventory_on_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM inserted_rows changed
     WHERE changed.dataset_id = 'mobile-commerce.collected-items.v1'
       AND changed.platform = 'mobile_commerce'
       AND changed.object_type = 'commerce_capture'
  ) THEN
    UPDATE serving.virtual_supermarket_storefront
       SET inventory_revision = inventory_revision + 1,
           updated_at = now()
     WHERE id = true;
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION serving.bump_virtual_supermarket_inventory_on_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM old_rows changed
     WHERE changed.dataset_id = 'mobile-commerce.collected-items.v1'
       AND changed.platform = 'mobile_commerce'
       AND changed.object_type = 'commerce_capture'
  ) OR EXISTS (
    SELECT 1
      FROM new_rows changed
     WHERE changed.dataset_id = 'mobile-commerce.collected-items.v1'
       AND changed.platform = 'mobile_commerce'
       AND changed.object_type = 'commerce_capture'
  ) THEN
    UPDATE serving.virtual_supermarket_storefront
       SET inventory_revision = inventory_revision + 1,
           updated_at = now()
     WHERE id = true;
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION serving.bump_virtual_supermarket_inventory_on_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM deleted_rows changed
     WHERE changed.dataset_id = 'mobile-commerce.collected-items.v1'
       AND changed.platform = 'mobile_commerce'
       AND changed.object_type = 'commerce_capture'
  ) THEN
    UPDATE serving.virtual_supermarket_storefront
       SET inventory_revision = inventory_revision + 1,
           updated_at = now()
     WHERE id = true;
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS virtual_supermarket_inventory_insert
  ON core.canonical_records;

CREATE TRIGGER virtual_supermarket_inventory_insert
AFTER INSERT ON core.canonical_records
REFERENCING NEW TABLE AS inserted_rows
FOR EACH STATEMENT
EXECUTE FUNCTION serving.bump_virtual_supermarket_inventory_on_insert();

DROP TRIGGER IF EXISTS virtual_supermarket_inventory_update
  ON core.canonical_records;

CREATE TRIGGER virtual_supermarket_inventory_update
AFTER UPDATE ON core.canonical_records
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION serving.bump_virtual_supermarket_inventory_on_update();

DROP TRIGGER IF EXISTS virtual_supermarket_inventory_delete
  ON core.canonical_records;

CREATE TRIGGER virtual_supermarket_inventory_delete
AFTER DELETE ON core.canonical_records
REFERENCING OLD TABLE AS deleted_rows
FOR EACH STATEMENT
EXECUTE FUNCTION serving.bump_virtual_supermarket_inventory_on_delete();

INSERT INTO serving.virtual_supermarket_categories
  (id, category_key, display_name,
   department_key, department_name, department_sort_order,
   aisle_key, aisle_name, aisle_sort_order,
   shelf_key, shelf_name, shelf_sort_order, sort_order)
VALUES
  ('50000000-0000-4000-8000-000000000001', 'uncategorized', '待分类',
   'uncategorized', '待分类区', 1000000,
   'uncategorized', '待整理通道', 1000000,
   'uncategorized', '待整理货架', 1000000, 1000000)
ON CONFLICT (id) DO NOTHING;

INSERT INTO serving.virtual_supermarket_events
  (id, aggregate_type, aggregate_id, event_type, actor,
   from_revision, to_revision, storefront_revision, changes)
VALUES
  ('50000000-0000-4000-8000-000000000002', 'category',
   '50000000-0000-4000-8000-000000000001', 'seed_import', 'migration-050',
   NULL, 1, 1, '{"seed":"uncategorized"}'::jsonb)
ON CONFLICT (aggregate_type, aggregate_id, to_revision) DO NOTHING;

CREATE OR REPLACE FUNCTION serving.reject_virtual_supermarket_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'serving.virtual_supermarket_events is append-only'
    USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS virtual_supermarket_events_no_row_mutation
  ON serving.virtual_supermarket_events;

CREATE TRIGGER virtual_supermarket_events_no_row_mutation
BEFORE UPDATE OR DELETE ON serving.virtual_supermarket_events
FOR EACH ROW
EXECUTE FUNCTION serving.reject_virtual_supermarket_event_mutation();

DROP TRIGGER IF EXISTS virtual_supermarket_events_no_truncate
  ON serving.virtual_supermarket_events;

CREATE TRIGGER virtual_supermarket_events_no_truncate
BEFORE TRUNCATE ON serving.virtual_supermarket_events
FOR EACH STATEMENT
EXECUTE FUNCTION serving.reject_virtual_supermarket_event_mutation();

COMMENT ON TABLE serving.virtual_supermarket_listing_state IS
  'Curated virtual-supermarket publication and display overrides; absence means off_shelf and never mutates canonical source truth.';

COMMENT ON TABLE serving.virtual_supermarket_events IS
  'Append-only operator audit for category and product publication changes.';
