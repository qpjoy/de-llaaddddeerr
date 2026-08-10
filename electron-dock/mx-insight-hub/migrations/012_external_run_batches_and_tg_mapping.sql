-- Durable evidence for a complete, multi-batch external pull.
--
-- The queue may replay a batch after a worker dies between committing data and
-- acknowledging the job. A batch key bound to the cursor window lets the Hub
-- absorb that replay without inflating run counters, while canonical identity
-- remains the ultimate row-level deduplication boundary.

ALTER TABLE ingest.import_runs
  ADD COLUMN IF NOT EXISTS trigger text NOT NULL DEFAULT 'manual'
    CHECK (trigger IN ('manual', 'schedule', 'file')),
  ADD COLUMN IF NOT EXISTS run_key char(64);

-- A database job can be reclaimed after canonical rows commit but before its
-- queue cursor is acknowledged.  The stable boundary key makes that retry
-- resume the same logical run instead of creating a second run with duplicate
-- counters and split lineage.
CREATE UNIQUE INDEX IF NOT EXISTS import_runs_active_run_key_idx
  ON ingest.import_runs (source_id, run_key)
  WHERE run_key IS NOT NULL AND status = 'running';

-- A database source has one logical import at a time. This also makes an
-- orphan created before the checkpoint write visible: the same boundary can
-- resume it, while a reset must first terminalize it.
CREATE UNIQUE INDEX IF NOT EXISTS import_runs_one_active_database_source_idx
  ON ingest.import_runs (source_id)
  WHERE run_key IS NOT NULL AND status = 'running';

CREATE TABLE IF NOT EXISTS ingest.import_run_batches (
  import_run_id uuid NOT NULL REFERENCES ingest.import_runs(id) ON DELETE CASCADE,
  batch_key char(64) NOT NULL,
  cursor_start jsonb,
  cursor_end jsonb,
  row_count integer NOT NULL CHECK (row_count >= 0),
  ingested_count integer NOT NULL CHECK (ingested_count >= 0),
  changed_count integer NOT NULL CHECK (changed_count >= 0),
  deleted_count integer NOT NULL CHECK (deleted_count >= 0),
  rejected_count integer NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  status text NOT NULL CHECK (status IN ('succeeded', 'failed')),
  error_code text,
  page_fingerprint char(64),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (import_run_id, batch_key),
  CHECK (cursor_start IS NULL OR jsonb_typeof(cursor_start) = 'object'),
  CHECK (cursor_end IS NULL OR jsonb_typeof(cursor_end) = 'object'),
  CHECK (page_fingerprint IS NULL OR page_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS import_run_batches_run_idx
  ON ingest.import_run_batches (import_run_id, started_at);

ALTER TABLE ingest.source_objects
  ADD COLUMN IF NOT EXISTS external_import_run_id uuid
    REFERENCES ingest.import_runs(id) ON DELETE SET NULL;

ALTER TABLE core.record_revisions
  ADD COLUMN IF NOT EXISTS external_import_run_id uuid
    REFERENCES ingest.import_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS source_objects_external_import_run_idx
  ON ingest.source_objects (external_import_run_id)
  WHERE external_import_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS record_revisions_external_import_run_idx
  ON core.record_revisions (external_import_run_id)
  WHERE external_import_run_id IS NOT NULL;

-- These indexes are installed before the first TG import in a normal rollout.
-- They keep PostgreSQL a real fallback when Elasticsearch is unavailable;
-- without them a 160k-message corpus would turn fuzzy/entity lookup into a
-- sequential scan. Existing very large Hub deployments should rehearse this
-- migration or pre-create the same indexes CONCURRENTLY during a maintenance
-- window.
CREATE INDEX IF NOT EXISTS canonical_records_body_trgm_idx
  ON core.canonical_records USING gin (body gin_trgm_ops)
  WHERE body IS NOT NULL;

CREATE INDEX IF NOT EXISTS canonical_records_author_handle_trgm_idx
  ON core.canonical_records USING gin ((stable_fields #>> '{author,handle}') gin_trgm_ops)
  WHERE (stable_fields #>> '{author,handle}') IS NOT NULL;

CREATE INDEX IF NOT EXISTS canonical_records_chat_username_trgm_idx
  ON core.canonical_records USING gin ((stable_fields #>> '{attributes,username}') gin_trgm_ops)
  WHERE (stable_fields #>> '{attributes,username}') IS NOT NULL;

-- Production-schema mapping v2. It remains deliberately unapproved: identity
-- is proven by source constraints, but continuous activation additionally
-- requires the source-side cursor/index contract documented in the runbook.
INSERT INTO catalog.source_mappings
  (id, source_id, version, field_map, origin, notes)
SELECT
  'f52f00f6-4326-4d0a-87ae-06b239450a1f',
  id,
  2,
  '{
    "externalId":{"from":"chat_id"},
    "contentType":{"from":"chat_type"},
    "url":{"from":"primary_url"},
    "title":{"from":"title"},
    "eventTime":{"from":"first_seen_at","type":"timestamp"},
    "collectedAt":{"from":"updated_at","type":"timestamp"},
    "attributes.username":{"from":"username"},
    "attributes.chatType":{"from":"chat_type"},
    "metrics.members":{"from":"participant_count","type":"number"},
    "links":{"from":"links"},
    "_drop":{"from":["owner_account_id","monitor_enabled","collection_status","last_message_id","last_collected_at","last_link_verified_at","last_error","metadata","last_seen_at"]}
  }'::jsonb,
  'manual',
  'Verified against night_all.public.tg_monitor_chats. Approve only after (updated_at, chat_id) index and writer/commit-order guarantees are verified.'
FROM catalog.external_sources
WHERE source_key = 'telegram-monitor-chats'
ON CONFLICT (source_id, version) DO NOTHING;

INSERT INTO catalog.source_mappings
  (id, source_id, version, field_map, origin, notes)
SELECT
  '32ac88ac-0c89-46c0-b22e-7885814ebd56',
  id,
  2,
  '{
    "externalId":{"from":["chat_id","message_id"],"type":"composite","separator":":"},
    "contentType":{"from":"message_type"},
    "url":{"from":"message_url"},
    "body":{"from":"message_text"},
    "authorExternalId":{"from":"sender_id"},
    "authorName":{"from":["sender_name","sender_username"]},
    "eventTime":{"from":"message_at","type":"timestamp"},
    "collectedAt":{"from":"collected_at","type":"timestamp"},
    "editedAt":{"from":"edited_at","type":"timestamp"},
    "deletedAt":{"from":"deleted_at","type":"timestamp"},
    "attributes.username":{"from":"sender_username"},
    "attributes.isOutgoing":{"from":"is_outgoing","type":"boolean"},
    "media":{"from":"media"},
    "entities":{"from":"entities"},
    "relations.chatId":{"from":"chat_id"},
    "relations.messageId":{"from":"message_id"},
    "relations.replyToMessageId":{"from":"reply_to_message_id"},
    "relations.threadId":{"from":"thread_id"},
    "relations.groupedId":{"from":"grouped_id"},
    "metrics.views":{"from":"view_count","type":"number"},
    "metrics.shares":{"from":"forward_count","type":"number"},
    "_drop":{"from":["id","metadata","collected_by_account_id"]}
  }'::jsonb,
  'manual',
  'Verified against night_all.public.tg_monitor_messages. Do not approve for continuous sync until a non-null edit/delete-aware watermark and (watermark, id) index exist.'
FROM catalog.external_sources
WHERE source_key = 'telegram-monitor-messages'
ON CONFLICT (source_id, version) DO NOTHING;

-- The chat cursor candidate is useful to the schema probe, but does not make
-- the source active: the probe will keep reporting the missing source index.
UPDATE catalog.external_sources
   SET connection = connection || '{"cursorColumn":"updated_at","idColumn":"chat_id"}'::jsonb,
       updated_at = now()
 WHERE source_key = 'telegram-monitor-chats'
   AND NOT (connection ? 'cursorColumn')
   AND NOT (connection ? 'idColumn');
