-- Platform-level intake for Telegram monitor tables written by an independent
-- server-side collector.
--
-- The physical database remains private. Only the NAME of the environment
-- variable holding its read-only DSN is catalogued here; credentials and hosts
-- never enter Hub rows or admin responses. The schema probe must be checked on
-- the target server before the first sync because these tables are not owned by
-- the Night-All repository migrations.

INSERT INTO catalog.external_sources
  (id, source_key, display_name, source_kind, dataset_id, platform, object_type, status, connection)
VALUES
  (
    '26423756-9c23-4e0d-8537-65b4a1cc9d88',
    'telegram-monitor-chats',
    'Telegram monitor chats',
    'database',
    'telegram.monitor.chats.v1',
    'telegram',
    'chat',
    'paused',
    '{"dsnEnv":"MX_INSIGHT_TG_MONITOR_DATABASE_URL","schema":"public","table":"tg_monitor_chats"}'::jsonb
  ),
  (
    '8cf587a0-58ac-4013-9b80-8051f87d29dd',
    'telegram-monitor-messages',
    'Telegram monitor messages',
    'database',
    'telegram.monitor.messages.v1',
    'telegram',
    'message',
    'paused',
    '{"dsnEnv":"MX_INSIGHT_TG_MONITOR_DATABASE_URL","schema":"public","table":"tg_monitor_messages"}'::jsonb
  )
ON CONFLICT (source_key) DO NOTHING;

-- Alias lists intentionally tolerate nullable/renamed presentation fields.
-- Identity and watermark fields are stricter: chats need chat_id (or a stable
-- source id), while messages use chat_id + message_id because Telegram message
-- ids are unique only inside one chat.
INSERT INTO catalog.source_mappings
  (id, source_id, version, field_map, origin, notes)
SELECT
  '8af74caf-e05c-4eb2-b75e-83f90eb6931a',
  id,
  1,
  '{
    "externalId":{"from":["chat_id","external_id","id"]},
    "contentType":{"from":["chat_type","type","kind"]},
    "url":{"from":["url","invite_link","link"]},
    "title":{"from":["title","name","display_name","username"]},
    "body":{"from":["description","about","bio"]},
    "eventTime":{"from":["created_at","first_seen_at"]},
    "collectedAt":{"from":["updated_at","last_seen_at","created_at"]},
    "attributes.username":{"from":["username","handle"]},
    "attributes.chatType":{"from":["chat_type","type","kind"]},
    "metrics.members":{"from":["member_count","participants_count","members_count"]}
  }'::jsonb,
  'inferred',
  'Unapproved candidate only: verify identity, watermark and field aliases against the production schema probe.'
FROM catalog.external_sources
WHERE source_key = 'telegram-monitor-chats'
ON CONFLICT (source_id, version) DO NOTHING;

INSERT INTO catalog.source_mappings
  (id, source_id, version, field_map, origin, notes)
SELECT
  '87080894-095c-4908-8732-43ef84221adc',
  id,
  1,
  '{
    "externalId":{"from":["chat_id","message_id"],"type":"composite","separator":":"},
    "contentType":{"from":["content_type","message_type","media_type","type"]},
    "url":{"from":["url","message_url","link"]},
    "title":{"from":["title","caption"]},
    "body":{"from":["text","message","content","body","caption"]},
    "authorExternalId":{"from":["sender_id","author_id","user_id"]},
    "authorName":{"from":["sender_name","author_name","username"]},
    "eventTime":{"from":["message_at","sent_at","date","published_at","created_at"]},
    "collectedAt":{"from":["updated_at","collected_at","created_at"]},
    "relations.chatId":{"from":["chat_id"]},
    "relations.messageId":{"from":["message_id"]},
    "relations.replyToMessageId":{"from":["reply_to_message_id","reply_to_id"]},
    "metrics.views":{"from":["view_count","views"]},
    "metrics.shares":{"from":["forward_count","forwards","share_count"]},
    "metrics.comments":{"from":["reply_count","replies","comment_count"]},
    "metrics.likes":{"from":["like_count","likes"]}
  }'::jsonb,
  'inferred',
  'Unapproved candidate only: Telegram message identity must be verified as chat_id + message_id before approval.'
FROM catalog.external_sources
WHERE source_key = 'telegram-monitor-messages'
ON CONFLICT (source_id, version) DO NOTHING;

-- Do not build Telegram serving indexes in this transactional migration. On a
-- populated canonical table a regular CREATE INDEX can hold a disruptive lock;
-- the runbook installs the optional chat-filter index CONCURRENTLY after the
-- source mapping and query plan have been verified. Migration 005's generic
-- canonical_records_feed_idx covers the initial fixed-dataset feed scan.
