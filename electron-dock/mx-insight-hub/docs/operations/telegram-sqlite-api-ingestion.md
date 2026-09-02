# Telegram SQLite read-API ingestion

Last reviewed: 2026-08-28.

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

PostgreSQL retains the losslessly parsed source value, not a byte-for-byte copy
of the HTTP response. At the Hub HTTP boundary, safe integers and ordinary
finite fractional values remain JSON numbers. Bare integer tokens outside
JavaScript's safe range are retained at any nesting depth as their exact
decimal token strings. Large decimal/exponent tokens that cannot be represented
losslessly are rejected rather than rounded. If the runtime cannot provide
primitive `context.source`, Hub fails closed with
`sqlite_api_lossless_json_unsupported` rather than accept a rounded value.
Mapping does not censor terms or filter message text. Unmapped fields remain
available in `extensions` and the parsed raw copy; the customer-facing ES
projection still applies its credential and secret field allowlist. Chinese
index projection strictly waits for the configured backend (production HanLP):
transient failures remain pending and retry after recovery, while permanent or
record-level failures use five durable attempts before dead/quarantine. It never
writes Jieba/CJK fallback into `*Hanlp`; only query analysis remains fail-soft
and reports its actual backend.

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

The previous-day sweep records `daily_window` as its import-run trigger.
Migration `039_import_run_daily_window_trigger.sql` drops and recreates the
`import_runs_trigger_check` constraint on `ingest.import_runs` so both upgraded
and newly installed databases accept that runtime value alongside `manual`,
`schedule`, and `file`.

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

Each committed Telegram SQLite page is handed to its continuation through a
durable queue `runAt` delay. `MX_INSIGHT_TELEGRAM_SQLITE_PAGE_DELAY_MS` defaults
to 1000 ms, accepts 0 to disable pacing, and is capped at 60000 ms. The delay
does not hold a worker, change the fixed 500-row page width, create a new import
run, or reset the checkpoint; it only gives PostgreSQL and asynchronous search
projection a bounded gap before the next source page.

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
two due SQLite tasks. Once a task starts, continuation pages use the configured
short durable delay until that sweep reaches its boundary; they do not sleep
300 seconds between pages. For messages, a normal due run requests only the high-water-mark overlap
window, not all historical rows. The chat directory is currently about 124
rows and is refreshed in one bounded page. The first due run after 02:00
Asia/Shanghai uses the previous-day window once; the cursor records that local
date so later 300-second checks do not repeat it.

An Admin may save an interval-only update while the pair is active, running or
draining. The write is atomic for both child sources, leaves current/queued
work unchanged and is observed on the next scheduler scan. Base URL or token
changes still require both sources to be paused and drained.

## Stalled cursor recovery

The scheduler only considers an `idle` cursor due, and the two SQLite child
sources are scheduled as a pair. Before stalled-task recovery existed, a worker
that disappeared while one cursor remained `running` made that child permanently
not due; the paired `every(isDue)` check then prevented both children from being
scheduled. This is why an orphaned `running` cursor dated 08/25 could block every
later scheduled run even though no worker or queued job still owned it.

Each scheduler pass now calls `TelegramSQLitePipeline.recoverStalledTasks()`
before its normal due check. Automatic recovery is deliberately fail-closed and
is allowed only when all of the following are true:

- both fixed child sources are active;
- the candidate cursor has been silent for at least ten of its configured sync
  intervals, with a 15-minute floor (50 minutes at the default 300-second
  interval);
- `position.importRunId` is still present, so recovery continues the same open
  import run;
- the cursor is either stale `running`, or `failed` with one of the transient
  allowlisted errors: `continuation_enqueue_failed`,
  `sqlite_api_invalid_json`, `sqlite_api_unavailable`,
  `sqlite_api_response_read_failed`, or `sqlite_api_request_failed`;
- the durable queue confirms that neither child has an outstanding
  `external-pull` job (pending or running); and
- both source advisory locks are acquired and the cursor/queue state still
  satisfies the checks after it is re-read under those locks.

If the outstanding-job query is unavailable, either source lock is busy, the
pipeline is inactive, or state changes during the check, recovery is skipped.
Mapping, checkpoint-contract, import-contract, and row-rejection failures remain
operator-gated; examples include `checkpoint_contract_mismatch`,
`import_batch_failed`, and `row_rejections_detected`. If the paired cursor is
still fresh `running` or has one of those deterministic failures, neither child
is auto-recovered or scheduled around it.

A recovered cursor is changed to `idle` at the exact same durable position with
the same `importRunId`; recovery does not reset a checkpoint, fork or close the
run, change mappings, or reprocess already committed batches. The scheduler then
atomically enqueues the chats and messages tasks immediately. On retry, committed
batch evidence is checked before reading the source and its stored `cursor_end`
is authoritative. At most, the current page whose Hub transaction never
committed is requested again.

For a deterministic failure, or whenever automatic recovery does not apply,
first correct and probe the root cause and confirm that no queued/running worker
owns either child. Then perform these actions in order:

1. POST `/internal/v1/admin/pipelines/telegram-sqlite/resume` (the Admin UI action
   is **恢复卡住的任务**).
2. After resume succeeds, POST
   `/internal/v1/admin/pipelines/telegram-sqlite/sync` (the Admin UI action is
   **立即同步**).

Resume preserves each durable cursor position and open import run. It returns
`409 source_recovery_pending` rather than racing an outstanding continuation;
wait for that job to finish or establish that it no longer exists, then retry
resume. Do not use **一次性全量对齐** or any checkpoint reset for ordinary stalled
task recovery.

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
and nested metadata, remain in extensions and the losslessly parsed raw value.
A non-null `deleted_at` selects the same message canonical row, retains its
source/content evidence in PostgreSQL, and emits a current-state tombstone; it
is never discarded during ingestion.

Chat title participates in the normal title + HanLP/CJK search fields; chat
username and media type use typed Elasticsearch fields.

Hub PostgreSQL has dedicated indexes for SQLite chat/time traversal, deleted
record audit, chat-username lookup and media-type filtering. Account
alias/phone and first-seen collector ID remain in raw/canonical storage but are
excluded from the customer-facing ES `extensions` projection; this does not
discard them from PostgreSQL's parsed raw representation.

Telegram identifiers may originate from 64-bit fields. Lossless parsing turns
an integer token beyond JavaScript's safe range into its exact decimal token
string before validation and mapping. This applies to root values, arrays,
nested metadata and future fields, not only `metadata.grouped_id`. Canonical
`externalId`, author IDs and typed relations remain strings, so PostgreSQL raw
values and canonical identities preserve the exact digits. Canonical/ES number
fields accept only exactly representable integers; an out-of-range count remains
in raw PostgreSQL and is not rounded into a metric. This is value fidelity, not
byte fidelity: HTTP whitespace, object-key order and the lexical spelling of
safely representable numbers may be normalized.

The decoder version is part of the source checkpoint contract and of each
record's `parserVersion`. A decoder upgrade therefore cannot continue halfway
through a page sequence under older numeric semantics: pause the pipeline,
reset both checkpoints with **一次性全量对齐**, then start one full sync.

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
