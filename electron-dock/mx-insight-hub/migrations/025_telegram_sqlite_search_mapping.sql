-- Promote SQLite API chat context and media type without changing the raw
-- source contract. Version 1 remains immutable history; activation of version
-- 2 requires the normal pause/checkpoint reset/probe workflow.

INSERT INTO catalog.source_mappings
  (id, source_id, version, field_map, origin, notes)
SELECT
  '4362f414-75dc-4e81-bff9-29b58dab458a',
  id,
  2,
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
  'Built-in GET /v1/chats mapping v2. Canonical shape is unchanged; exact HTTP rows remain in raw_payload.'
FROM catalog.external_sources
WHERE source_key = 'telegram-sqlite-api-chats'
ON CONFLICT (source_id, version) DO NOTHING;

INSERT INTO catalog.source_mappings
  (id, source_id, version, field_map, origin, notes)
SELECT
  'd8150365-aebb-4291-80b0-436d83684026',
  id,
  2,
  '{
    "externalId":{"from":["chat_id","message_id"],"type":"composite","separator":":"},
    "contentType":{"from":["media_type","message_kind"]},
    "url":{"from":"message_url"},
    "title":{"from":"chat_title"},
    "body":{"from":"text"},
    "authorExternalId":{"from":"sender_id"},
    "authorName":{"from":["sender_name","sender_username"]},
    "eventTime":{"from":"message_at","type":"timestamp"},
    "collectedAt":{"from":"captured_at","type":"timestamp"},
    "editedAt":{"from":"edited_at","type":"timestamp"},
    "deletedAt":{"from":"deleted_at","type":"timestamp"},
    "attributes.username":{"from":"sender_username"},
    "attributes.chatUsername":{"from":"chat_username"},
    "attributes.mediaType":{"from":"media_type"},
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
  'Built-in GET /v1/messages mapping v2. Deleted rows and exact uncensored HTTP payloads remain in PostgreSQL; customer ES keeps current-state tombstone semantics.'
FROM catalog.external_sources
WHERE source_key = 'telegram-sqlite-api-messages'
ON CONFLICT (source_id, version) DO NOTHING;

SET LOCAL max_parallel_maintenance_workers = 0;

CREATE INDEX IF NOT EXISTS canonical_sqlite_tg_messages_chat_time_idx
  ON core.canonical_records (
    (stable_fields #>> '{relations,chatId}'),
    event_time DESC,
    id DESC
  )
  WHERE dataset_id = 'telegram.sqlite.messages.v1'
    AND platform = 'telegram'
    AND object_type = 'message'
    AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS canonical_sqlite_tg_messages_deleted_idx
  ON core.canonical_records (deleted_at DESC, event_time DESC, id DESC)
  WHERE dataset_id = 'telegram.sqlite.messages.v1'
    AND platform = 'telegram'
    AND object_type = 'message'
    AND deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS canonical_sqlite_tg_messages_chat_username_trgm_idx
  ON core.canonical_records USING gin (
    (stable_fields #>> '{attributes,chatUsername}') gin_trgm_ops
  )
  WHERE dataset_id = 'telegram.sqlite.messages.v1'
    AND platform = 'telegram'
    AND object_type = 'message'
    AND deleted_at IS NULL
    AND (stable_fields #>> '{attributes,chatUsername}') IS NOT NULL;

CREATE INDEX IF NOT EXISTS canonical_sqlite_tg_messages_media_type_idx
  ON core.canonical_records (
    (stable_fields #>> '{attributes,mediaType}'),
    event_time DESC,
    id DESC
  )
  WHERE dataset_id = 'telegram.sqlite.messages.v1'
    AND platform = 'telegram'
    AND object_type = 'message'
    AND deleted_at IS NULL
    AND (stable_fields #>> '{attributes,mediaType}') IS NOT NULL;
