# Telegram SQLite read-API ingestion

Last reviewed: 2026-08-15.

This runbook covers the fixed `telegram-sqlite` pipeline that reads the
Telegram collector's SQLite fallback through its GET-only HTTP API. It is a
separate source contract from the PostgreSQL `telegram-monitor` pipeline. It
does not change MX-H2I login, Launcher identity, DNS, WireGuard, routes, or
client networking.

## Scope and storage

One server-side connection controls two fixed child sources:

| Child source | Upstream resource | Canonical dataset | Identity |
| --- | --- | --- | --- |
| `telegram-sqlite-api-chats` | `GET /v1/chats` | `telegram.sqlite.chats.v1` | `chat_id` |
| `telegram-sqlite-api-messages` | `GET /v1/messages?include_deleted=true` | `telegram.sqlite.messages.v1` | `chat_id:message_id` |

The dedicated datasets are intentional. SQLite is a fallback snapshot and may
overlap the PostgreSQL feed while carrying a different payload shape. Keeping
the datasets separate prevents two collectors from alternately overwriting one
canonical record and generating false revisions.

Every accepted row follows the normal Hub write path:

```text
read-only HTTP row
  -> ingest.source_objects.raw_payload
  -> core.canonical_records + core.record_revisions
  -> outbox.projection_events
  -> Elasticsearch projector
```

The exact source JSON is retained in PostgreSQL. Mapping does not censor terms
or filter message text. Unmapped fields remain available in `extensions` and
the raw copy; the customer-facing ES projection still applies its credential
and secret field allowlist. Chinese search continues through the shared
HanLP-first segmenter, with Jieba and CJK bigrams as degradation fallbacks.

Rows with a non-null `deleted_at` are ingested rather than discarded. Their
source object, canonical row, deletion timestamp and content revision remain in
PostgreSQL for Admin/Data Center audit and replay. The customer-facing
Elasticsearch index is a rebuildable **current-state** projection, so its
tombstone removes the public search document while PostgreSQL retains the full
record. This is projection policy, not source filtering.

## Append-only incremental contract

The current upstream API provides page-number pagination ordered by
`message_at DESC`. It does not provide a monotonic `change_seq`, row
`updated_at`, or opaque `next_cursor` that covers inserts, edits, soft deletes,
and late history. Therefore the Hub must not describe it as the same exact
keyset incremental contract used by PostgreSQL.

The fixed operating policy is:

- chats: an initial scan, followed by a compact refresh of the current chat
  directory (the observed source fits in one 500-row page);
- messages: one initial full alignment;
- messages after alignment: a 2-hour inclusive event-time overlap from the
  durable `lastMessageAt` high-water mark;
- after 02:00 Asia/Shanghai, once per day: re-read only the previous Shanghai
  calendar day by `message_at` (00:00 through the next 00:00 boundary);
- no scheduled historical full scan or daily whole-database reconciliation;
- changing/replacing the SQLite database requires the operator to pause and
  use **一次性全量对齐**, which resets both checkpoints together;
- each sweep fixes `end_at` to its start time so new head rows do not keep
  moving the page window;
- a missing row is never interpreted as deletion; only explicit `deleted_at`
  creates a canonical tombstone, and that row still remains in Hub PostgreSQL;
- every page is idempotently upserted and checkpointed after its Hub
  transaction commits, so retries do not duplicate canonical records.

The upstream `end_at` predicate is inclusive. The daily sweep intentionally
uses the next midnight as its fixed upper bound, so a record exactly on that
boundary can be read again by adjacent windows; canonical identity absorbs the
duplicate. Subtracting a millisecond would risk losing timestamps with finer
precision.

This is reliable for the stated append-only business contract when newly
appended messages do not move backwards beyond the overlap in `message_at`.
The bounded nightly window repairs late observations and lifecycle changes for
messages whose original `message_at` belongs to the previous day; it is not a
full scan and does not discover changes to older history.
For an exact, unbounded change stream, add an upstream endpoint ordered by a
monotonic `change_seq` (or `captured_at` plus immutable SQLite `id`) and include
both upserts and tombstones.

The list response also needs a documented stable order for equal timestamps.
`message_at DESC` without an immutable secondary key cannot prove that offset
pages are gap-free while the source changes. The Hub therefore reports this as
append-only eventual consistency, never as exact CDC. Old-message edits,
deletion marks, or late history outside the overlap require the manual full
alignment action unless the upstream change cursor is added.

## Admin workflow

Open `/admin/#sources`, then open **Telegram SQLite API 清洗任务**.

1. Safely pause the pipeline and wait for running pages to drain.
2. Enter the reachable base URL, for example
   `http://54.151.151.135:8780`, and the Bearer token. `0.0.0.0` is a remote
   listen address and is never a valid Hub destination.
3. Save. Hub calls `/v1/health`, requires JSON `status=ok`, authenticates
   `/v1/stats`, and probes both fixed resources without writing upstream.
4. Enable the pipeline. The built-in mappings and checkpoint contract are
   verified before both child sources become active.
5. Use **立即同步** for an operator-triggered run, or wait for the configured
   schedule.

When the endpoint starts serving a different SQLite database, keep the
pipeline paused, save and validate the connection, then use **一次性全量对齐**.
That action clears both durable high-water marks; after enabling the pipeline,
the next sync performs one complete idempotent scan. Ordinary append-only
syncs, pauses and restarts do not use this action.

The replacement must represent the same logical Telegram corpus. Full
alignment re-reads everything present in the replacement but deliberately does
not treat absence as deletion, so previously retained Hub records remain unless
the source sends an explicit `deleted_at`. An unrelated SQLite corpus needs a
new dataset/source generation rather than reusing these fixed dataset IDs.

The token is submitted only to the Hub Admin listener and used only by the
server-side ingest worker. It must not be placed in browser code, URLs, source
control, logs, or documentation.

## What the 300-second setting means

`syncIntervalSeconds=300` is the minimum interval between completed source
checks. The ingest scheduler wakes every 60 seconds by default, compares the
durable cursor update time with each source interval, and atomically queues the
two due SQLite tasks. Once a task starts, continuation pages run back-to-back
until that sweep reaches its boundary; they do not sleep 300 seconds between
pages. For messages, a normal due run requests only the high-water-mark overlap
window, not all historical rows. The chat directory is currently about 124
rows and is refreshed in one bounded page. The first due run after 02:00
Asia/Shanghai uses the previous-day window once; the cursor records that local
date so later 300-second checks do not repeat it.

## Mapping and indexes

The canonical destination row is selected by
`(dataset_id, platform, object_type, external_id)`. Re-reading the same
`chat_id` or `(chat_id,message_id)` therefore updates that row instead of
creating a duplicate; a content-hash change adds a revision/outbox event, while
an identical replay is absorbed.

| Chat source | Canonical destination |
| --- | --- |
| `chat_id` | `externalId` |
| `chat_type` | `contentType`, `attributes.chatType` |
| `title`, `primary_url`, `username` | `title`, `url`, `attributes.username` |
| `participant_count` | `metrics.members` |
| `last_message_at` (fallback `updated_at`) | `eventTime` |
| `updated_at` | `collectedAt` |

| Message source | Canonical destination |
| --- | --- |
| `chat_id` + `message_id` | composite `externalId`, plus typed relations |
| `text` | unmodified `body` |
| `chat_title`, `chat_username` | `title`, `attributes.chatUsername` |
| `media_type` (fallback `message_kind`) | `contentType`; also `attributes.mediaType` |
| `sender_id`, `sender_name`/`sender_username` | canonical author identity/name |
| `message_at`, `captured_at`, `edited_at`, `deleted_at` | event/collection/edit/delete times |
| `message_url`, `is_outgoing` | `url`, `attributes.isOutgoing` |
| reply/thread/grouped IDs | typed relations |
| `metadata.views`, `metadata.forwards` | `metrics.views`, `metrics.shares` |

All remaining source fields, including `message_count`, media/account context
and nested metadata, remain in extensions and the exact raw JSON. A non-null
`deleted_at` selects the same message canonical row, retains its source/content
evidence in PostgreSQL, and emits a current-state tombstone; it is never
discarded during ingestion.

Chat title participates in the normal title + HanLP/CJK search fields; chat
username and media type use typed Elasticsearch fields.

Hub PostgreSQL has dedicated indexes for SQLite chat/time traversal, deleted
record audit, chat-username lookup and media-type filtering. Account
alias/phone and first-seen collector ID remain in raw/canonical storage but are
excluded from the customer-facing ES `extensions` projection; this does not
modify or discard the source JSON.

Telegram identifiers may originate from 64-bit fields. Numeric IDs must fit
JavaScript's safe-integer range; larger values, especially `grouped_id`, must be
serialized by the upstream API as decimal strings. Hub rejects an unsafe
numeric representation instead of silently rounding the identity or raw JSON.

The 2-hour overlap is deliberate for the observed source size: the source had
more than 620,000 messages and roughly 48,000 captures in 24 hours during the
2026-08-15 read-only contract check. With a 300-second schedule it still
re-reads about 24 scheduling intervals, while avoiding a complete 24-hour
window on every run. There is no automatic historical full scan: older edits, deletion
marks and late historical captures require the explicit full-alignment action,
or preferably an upstream monotonic change cursor.

## Failure diagnosis

The source is not part of Hub readiness and cannot block login or the public
API. A temporary source timeout fails only that job attempt, keeps the running
import/checkpoint on the same page, and is safe to retry. After the queue's
retry budget is exhausted the resumable checkpoint is marked failed for Admin
inspection; it is never advanced past an uncommitted page.

Check the source host first:

```bash
curl http://127.0.0.1:8780/v1/health
```

It must return HTTP 200 and `{"status":"ok",...}`. A TCP connection alone is
not sufficient. Then verify process binding, host firewall/NAT/port forwarding,
and the cloud security group before retrying from Hub. The current example URL
uses plaintext HTTP; production should use HTTPS or a private network plus a
strict source-IP allowlist so the Bearer token and Telegram content are not
exposed in transit.
