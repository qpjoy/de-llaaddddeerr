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

## Why this is reconciliation, not an exact change cursor

The current upstream API provides page-number pagination ordered by
`message_at DESC`. It does not provide a monotonic `change_seq`, row
`updated_at`, or opaque `next_cursor` that covers inserts, edits, soft deletes,
and late history. Therefore the Hub must not describe it as the same exact
keyset incremental contract used by PostgreSQL.

The fixed safe policy is:

- chats: full reconciliation each due run;
- messages: initial full reconciliation;
- messages between reconciliations: a 24-hour inclusive event-time overlap;
- messages: full reconciliation at least daily;
- each sweep fixes `end_at` to its start time so new head rows do not keep
  moving the page window;
- a missing row is never interpreted as deletion; only explicit `deleted_at`
  creates a tombstone;
- every page is idempotently upserted and checkpointed after its Hub
  transaction commits, so retries do not duplicate canonical records.

This gives eventual reconciliation under the current contract. For an exact,
unbounded change stream, add an upstream endpoint ordered by a monotonic
`change_seq` plus an immutable tie-breaker and include both upserts and
tombstones.

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

The token is submitted only to the Hub Admin listener and used only by the
server-side ingest worker. It must not be placed in browser code, URLs, source
control, logs, or documentation.

## What the 300-second setting means

`syncIntervalSeconds=300` is the minimum interval between completed source
checks. The ingest scheduler wakes every 60 seconds by default, compares the
durable cursor update time with each source interval, and atomically queues the
two due SQLite tasks. Once a task starts, continuation pages run back-to-back
until that sweep reaches its boundary; they do not sleep 300 seconds between
pages.

## Mapping

Chats map title, type, username, participant count, URL, last-message time, and
snapshot time. Messages map text without modification, sender identity,
message/capture/edit/delete times, message URL, outgoing state, chat/reply/thread
relations, and nested `metadata.views`, `metadata.forwards`, and
`metadata.grouped_id`. Account alias/phone and other source-only fields remain
in raw/extension storage and are not automatically made public.

## Failure diagnosis

The source is not part of Hub readiness and cannot block login or the public
API. A source timeout fails only its ingest job and leaves the previous durable
checkpoint unchanged.

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

