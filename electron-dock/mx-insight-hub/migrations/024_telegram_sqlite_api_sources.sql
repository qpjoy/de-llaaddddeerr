-- Fixed Telegram SQLite read-API intake.
--
-- This is intentionally not modelled as PostgreSQL. The upstream exposes a
-- small, GET-only HTTP contract rather than SQL, and its page API has no
-- monotonic change cursor. The runtime therefore uses overlap polling plus
-- periodic full reconciliation and never treats absence from a page as a
-- deletion. Only an explicit deleted_at value creates a tombstone.

ALTER TABLE catalog.external_sources
  DROP CONSTRAINT IF EXISTS external_sources_source_kind_check;

ALTER TABLE catalog.external_sources
  ADD CONSTRAINT external_sources_source_kind_check
  CHECK (source_kind IN ('file', 'database', 'sqlite_api'));

INSERT INTO catalog.external_sources
  (id, source_key, display_name, source_kind, dataset_id, platform, object_type,
   status, connection, sync_interval_seconds)
VALUES
  (
    '747ebba9-85b6-4310-9d65-eb432b638214',
    'telegram-sqlite-api-chats',
    'Telegram SQLite API chats',
    'sqlite_api',
    'telegram.sqlite.chats.v1',
    'telegram',
    'chat',
    'paused',
    '{"baseUrl":"http://54.151.151.135:8780","resource":"chats","pageSize":500}'::jsonb,
    300
  ),
  (
    'b26cbdb5-5909-44e7-a635-e55f6bda1698',
    'telegram-sqlite-api-messages',
    'Telegram SQLite API messages',
    'sqlite_api',
    'telegram.sqlite.messages.v1',
    'telegram',
    'message',
    'paused',
    '{"baseUrl":"http://54.151.151.135:8780","resource":"messages","pageSize":500}'::jsonb,
    300
  )
ON CONFLICT (source_key) DO NOTHING;

-- Keep the SQLite fallback corpus in dedicated logical datasets. It may overlap
-- the PostgreSQL feed but exposes a different snapshot contract; merging both
-- into one canonical key would make their differing payload shapes overwrite
-- each other and emit a fresh ES revision on every reconciliation.
INSERT INTO catalog.source_mappings
  (id, source_id, version, field_map, origin, notes)
SELECT
  'e360ebf5-f353-4338-a16f-087a29290959',
  id,
  1,
  '{
    "externalId":{"from":"chat_id"},
    "contentType":{"from":"chat_type"},
    "url":{"from":"primary_url"},
    "title":{"from":"title"},
    "eventTime":{"from":["last_message_at","updated_at"],"type":"timestamp"},
    "collectedAt":{"from":"updated_at","type":"timestamp"},
    "attributes.username":{"from":"username"},
    "attributes.chatType":{"from":"chat_type"},
    "metrics.members":{"from":"participant_count","type":"number"}
  }'::jsonb,
  'manual',
  'Built-in GET /v1/chats mapping. Unmapped fields stay in extensions and the exact HTTP row remains in raw_payload.'
FROM catalog.external_sources
WHERE source_key = 'telegram-sqlite-api-chats'
ON CONFLICT (source_id, version) DO NOTHING;

INSERT INTO catalog.source_mappings
  (id, source_id, version, field_map, origin, notes)
SELECT
  'a89be04c-4a9c-4f75-b234-f9b75e89e56f',
  id,
  1,
  '{
    "externalId":{"from":["chat_id","message_id"],"type":"composite","separator":":"},
    "contentType":{"from":"message_kind"},
    "url":{"from":"message_url"},
    "body":{"from":"text"},
    "authorExternalId":{"from":"sender_id"},
    "authorName":{"from":["sender_name","sender_username"]},
    "eventTime":{"from":"message_at","type":"timestamp"},
    "collectedAt":{"from":"captured_at","type":"timestamp"},
    "editedAt":{"from":"edited_at","type":"timestamp"},
    "deletedAt":{"from":"deleted_at","type":"timestamp"},
    "attributes.username":{"from":"sender_username"},
    "attributes.isOutgoing":{"from":"is_outgoing","type":"boolean"},
    "relations.chatId":{"from":"chat_id"},
    "relations.messageId":{"from":"message_id"},
    "relations.replyToMessageId":{"from":"reply_to_message_id"},
    "relations.threadId":{"from":"thread_id"},
    "relations.groupedId":{"from":"metadata.grouped_id"},
    "metrics.views":{"from":"metadata.views","type":"number"},
    "metrics.shares":{"from":"metadata.forwards","type":"number"}
  }'::jsonb,
  'manual',
  'Built-in GET /v1/messages mapping. include_deleted=true is mandatory; no term filtering is applied and the exact HTTP row remains in raw_payload.'
FROM catalog.external_sources
WHERE source_key = 'telegram-sqlite-api-messages'
ON CONFLICT (source_id, version) DO NOTHING;
