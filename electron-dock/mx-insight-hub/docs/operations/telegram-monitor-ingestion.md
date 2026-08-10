# Telegram monitor PostgreSQL ingestion

Last verified against the source metadata and source-contract implementation: 2026-08-11.

This runbook connects the independently written tables below to MX Insight Hub:

```text
night_all.public.tg_monitor_chats
night_all.public.tg_monitor_messages
```

The source is reachable and its shape is now known, but **known schema is not a
safe incremental-change contract**. Keep both registered sources paused until
the source-owner gates in §5 are complete. In particular, do not configure
`message_at` or `collected_at` as a convenient substitute for a change
watermark: doing so permanently skips later edits and deletions.

## 1. Ownership and serving path

```text
collector/writer -> night_all PostgreSQL (authoritative source)
                              |
                              | read-only source connection
                              v
Hub ingest -> source objects -> canonical PostgreSQL -> projection outbox
                                      |                    |
                                      |                    v
                                      |              Elasticsearch
                                      v
                     history/search/entity public APIs
```

- The collector remains the business writer of the two source tables. Hub
  ingestion, schema inspection and progress sessions always set
  `default_transaction_read_only=on`. The sole write exception is the explicit
  Admin-token **prepare source** action in §3.1: it uses a short-lived DDL
  session to install a versioned source-side cursor contract, then closes that
  session before ordinary read-only ingestion can resume. Normal Hub deploys
  never mutate an external database.
- Hub PostgreSQL is authoritative for the data Hub has accepted. Canonical
  identity, revisions, tombstones, mapping version, import evidence and durable
  checkpoints live there.
- Elasticsearch is a rebuildable full-text/fuzzy-search projection. An ES
  outage degrades search to PostgreSQL; it must not stop ingestion or the
  keyset-paginated history API.
- Night-All's current Telegram/TGStat path is useful for live enrichment or a
  separately labelled fallback. It is not a substitute for historical local
  search, username lookup, durable checkpointing or tombstone propagation.
- Public responses may expose logical lineage such as `datasetId` and
  `origin=hub-direct`. They never expose the source host, database, table,
  source connection/password, collector account, raw row or Night-All
  endpoint/provider identifiers.

The fixed Telegram canonical datasets do not contain `tenant_id`. Every
consumer granted `telegram` currently sees the same corpus; tenant boundaries
still protect API-key ownership, grants, policy, quota and usage. Stop and add a
versioned row-scope model before different tenants require different Telegram
subsets.

## 2. Register a direct PostgreSQL source

### 2.1 Access and credential storage

Source management is deliberately simpler than public API-key management: it
has no independent Provider resource and no provider/master key. Only requests
authenticated with `x-mx-insight-admin-token` may list, create, inspect, test or
change a source. Launcher-login sessions and customer API keys are
rejected even if the Launcher identity has an admin role.

PostgreSQL connection fields, including `password`, are stored as plaintext in
`catalog.external_sources.connection` so the Admin-token console can display
and edit one complete source configuration without a deployment. This is an
explicit operational trade-off: anyone with Hub database, WAL, logical-backup
or isolated-restore access can recover source credentials. Encrypt backup
storage and transport, restrict/audit database and backup access, and never
write the connection object to logs, traces, metrics or support bundles.

### 2.2 Least-privilege source role

The existing `mx_data` connection was verified as read-only and has `SELECT` on
both tables. For any replacement role, the source owner grants only:

```sql
GRANT CONNECT ON DATABASE night_all TO <hub_reader>;
GRANT USAGE ON SCHEMA public TO <hub_reader>;
GRANT SELECT ON TABLE
  public.tg_monitor_chats,
  public.tg_monitor_messages
TO <hub_reader>;
ALTER ROLE <hub_reader> SET default_transaction_read_only = on;
```

Do not grant ownership, schema `CREATE`, DML, sequence access, a collector role
or superuser. Network ACLs should allow only the Admin/ingest workload source
addresses; the public API does not connect to `night_all`.

### 2.3 Admin API

All endpoints in this section require the platform Admin Token specifically.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET, PUT` | `/internal/v1/admin/pipelines/telegram-monitor` | Read or atomically configure the one shared TG connection and interval. |
| `POST` | `/internal/v1/admin/pipelines/telegram-monitor/status` | Activate or safely pause both fixed inputs. |
| `POST` | `/internal/v1/admin/pipelines/telegram-monitor/sync` | Enqueue both active inputs with one operator action. |
| `GET` | `/internal/v1/admin/pipelines/telegram-monitor/progress` | Explicit exact source counts/checkpoint-relative progress and blockers. |
| `GET, POST` | `/internal/v1/admin/pipelines/telegram-monitor/source/prepare` | Inspect, then explicitly install/repair the fixed source-side watermark, triggers, guards and indexes. |
| `POST` | `/internal/v1/admin/pipelines/telegram-monitor/checkpoints/reset` | Confirm and atomically reset both paused TG checkpoints against the fixed mapping contract. |
| `GET` | `/internal/v1/admin/sources` | List sources and their Admin-visible connection fields. |
| `POST` | `/internal/v1/admin/sources` | Create a PostgreSQL or file source. |
| `GET` | `/internal/v1/admin/sources/:key` | Read one Admin-visible source configuration. |
| `PUT` | `/internal/v1/admin/sources/:key` | Change a generic source connection/status/schedule; fixed TG child keys return `409 pipeline_managed_source`. |
| `POST` | `/internal/v1/admin/sources/:key/test` | Test the saved PostgreSQL connection read-only. |
| `GET` | `/internal/v1/admin/sources/:key/schema` | Probe columns/indexes/constraints/triggers and activation issues. |
| `GET, POST` | `/internal/v1/admin/sources/:key/mappings` | List mapping versions; POST is generic-source only and fixed TG child keys return 409. |
| `POST` | `/internal/v1/admin/sources/:key/mappings/:version/approve` | Approve a generic source mapping; fixed TG mappings are activated only by the business pipeline. |
| `GET` | `/internal/v1/admin/sources/:key/preview?limit=3` | Return value-free database row shapes. |
| `POST` | `/internal/v1/admin/sources/:key/preview?filename=...&agent=false` | Preview raw file bytes locally; Agent opt-in receives column names only. |
| `GET, POST` | `/internal/v1/admin/sources/:key/sync` | Inspect sync state; POST is generic-source only for fixed TG child keys. |
| `POST` | `/internal/v1/admin/sources/:key/checkpoint/reset` | Reset a generic paused/drained source; TG uses the paired pipeline reset. |
| `POST` | `/internal/v1/admin/sources/:key/import?filename=...` | Import raw file bytes through the approved mapping. |
| `GET` | `/internal/v1/admin/sources/:key/imports` | List durable import-run evidence. |

Creation validates a complete database candidate with a bounded
`default_transaction_read_only=on` session before it is accepted; a failed
probe leaves no source record. The Telegram keys below are already seeded by
migration 010, so configure them with `PUT` in §3 instead of attempting a
duplicate `POST`.

Use `sslMode=disable` only for a reviewed host-local/trusted transport where the
server does not offer TLS. `require` encrypts transport but does not validate a
CA; use `verify-ca` or `verify-full` when the deployment supplies a trusted
certificate path.

Verify the saved session:

```http
POST /internal/v1/admin/sources/telegram-monitor-chats/test
x-mx-insight-admin-token: <admin-token>
```

The response contains safe connection evidence such as database/user/server
version, `readOnly: true`, health status, check time and a bounded machine error
code. The saved source response is Admin-token-only and can include its
plaintext connection fields; public responses never do.

A connection-changing generic-source `PUT` requires that source to be `paused` and its cursor
to be no longer `running`. It tests the merged candidate before replacing the
last-known-good connection. Draining returns `409 source_draining`; advisory
lock contention returns `409 source_busy`.

## 3. Configure the Telegram Monitor business task

Migration 010 created stable source/dataset identities:

| Source key | Dataset | Object type |
| --- | --- | --- |
| `telegram-monitor-chats` | `telegram.monitor.chats.v1` | `chat` |
| `telegram-monitor-messages` | `telegram.monitor.messages.v1` | `message` |

Do not register two replacement sources and do not enter table/mapping settings
twice. The Admin UI presents these seeded inputs as one **Telegram Monitor 清洗任务**.
Its business definition owns both tables, datasets, object types, cursor/id
candidates and mapping v2; the operator supplies only one shared database
connection and schedule.

```http
PUT /internal/v1/admin/pipelines/telegram-monitor
Content-Type: application/json
x-mx-insight-admin-token: <admin-token>

{
  "connection": {
    "host": "<internal-host-or-dns>",
    "port": 5432,
    "database": "night_all",
    "username": "mx_data",
    "password": "<provided-out-of-band>",
    "sslMode": "require"
  },
  "syncIntervalSeconds": 300
}
```

The server tests a bounded read-only session, then atomically writes that shared
connection to both paused/drained inputs while injecting these immutable
contracts:

| Role | Physical input | Cursor / ID candidate | Mapping |
| --- | --- | --- | --- |
| chats | `public.tg_monitor_chats` | `updated_at, chat_id` | built-in v2 |
| messages | `public.tg_monitor_messages` | `updated_at, id` | built-in v2 |

The messages `updated_at` entry is the **required source contract**, not a claim
that the probed table already has that column. The current production sample
does not. Saving the connection therefore succeeds, exact progress can report
the current total row count, but activation remains blocked until §5 is fixed.
The UI shows this as a source-watermark blocker instead of inventing completed/
remaining percentages.

The old seeded `dsnEnv` form remains readable until the first unified direct
configuration. New TG operations use the pipeline route above. Generic child
mutations are deliberately rejected with `409 pipeline_managed_source`, so a
single-table edit/sync/reset cannot split the business contract. The child GET,
test, schema, value-shape, mapping-list, sync-state and import-run endpoints stay
available as a read-only diagnostic surface.

Use each task's advanced view for metadata and value-free shapes before looking
at business values:

```http
GET /internal/v1/admin/sources/{sourceKey}/schema
GET /internal/v1/admin/sources/{sourceKey}/preview?limit=3
```

`schema` returns columns, constraints, indexes, triggers and estimated
rows/bytes. `preview` returns at most three rows of
`jsonType/isNull/serializedLength`, not text, usernames, URLs or raw JSON. A
real-value sample remains a separately authorized data-review activity; do not
weaken the Admin preview route into a data-export endpoint.

### 3.1 Prepare or repair the source-side cursor contract

Saving the connection does not grant the long-lived `mx_data` reader DDL
rights and does not silently alter `night_all`. With both child tasks paused
and drained, open **一键准备 / 修复 TG 源库**, inspect the current evidence, type
`telegram-monitor`, and execute the explicit preparation action. Stop the
upstream collector for this short maintenance window: the core migration takes
an `ACCESS EXCLUSIVE` lock on both fixed tables with a bounded lock timeout and
fails safely instead of racing an active writer.

If the saved account owns both tables and can create the private contract
schema, leave the optional migration fields empty. The recommended production
arrangement keeps `mx_data` read-only and supplies a source owner/DDL username
and password only in this request. Those one-time credentials replace only the
connection username/password in memory; they are not written to Hub
PostgreSQL, returned by the API or placed in logs. Revoke or rotate the DDL
credential after the operation.

```http
POST /internal/v1/admin/pipelines/telegram-monitor/source/prepare
Content-Type: application/json
x-mx-insight-admin-token: <admin-token>

{
  "confirmPipelineKey": "telegram-monitor",
  "migrationCredentials": {
    "username": "<source-owner>",
    "password": "<one-time-password>"
  }
}
```

The versioned, idempotent source script performs and verifies all of these
steps:

1. validate the two fixed tables and stable primary keys;
2. add/backfill `messages.updated_at`, validate `chats.updated_at`, require
   finite `timestamptz` values, and make both non-null;
3. install a private singleton watermark plus a `BEFORE STATEMENT` trigger
   that advances and locks it once per write statement;
4. install a last-running `BEFORE ROW` trigger on both tables that overwrites
   any application-supplied `updated_at` with that statement watermark;
5. install `ENABLE ALWAYS` guards that reject hard `DELETE` and `TRUNCATE`;
6. create or repair `(updated_at, chat_id)` and `(updated_at, id)` indexes
   outside the DDL transaction, then require `indisvalid` and `indisready`;
7. record a source installation generation tied to the physical table
   identities and bind that generation into Hub checkpoint compatibility.

The shared watermark row remains locked until the writer transaction commits.
This serializes TG write statements so a later-visible commit cannot carry a
cursor behind one already exposed to Hub; multiple rows in one statement may
share a timestamp and the stable ID remains the deterministic tie-breaker.
The trade-off is deliberate write serialization. Test collector throughput and
transaction duration before enabling a high-volume writer.

Adding the trailing column is normally transparent to writers that name their
columns. Before preparation, audit `COPY table FROM` without a column list,
binary/fixed-shape row decoders, `SELECT *`/`RETURNING *` assumptions and
logical-replication subscribers; those integrations can require a coordinated
schema update. A table owner or superuser can still disable/drop triggers or
replace tables, so such roles must not be used by the ordinary collector.

Preparation always leaves the Hub pipeline paused. It never starts a pull,
attests the business writer contract or resets a checkpoint. On the first
installation with no checkpoint, proceed to the probe and activation gates
without reset. If a server/database changes, either table is recreated, or a
broken source contract is repaired after syncing may have occurred, the source
generation changes and the old checkpoint becomes incompatible. Review the
incident, then use the separate confirmed **统一重置双表 Checkpoint** action to
perform a full replay. An already-ready idempotent recheck keeps the same
generation and does not require replay.

## 4. Verified source schema and canonical mapping

### 4.1 Chats

Observed shape:

- primary key: `chat_id bigint NOT NULL`;
- presentation: `chat_type`, `title`, `username`, `primary_url`, `links`;
- state/metrics: `monitor_enabled`, `collection_status`,
  `participant_count`, `last_message_id`, `last_error`;
- times: `first_seen_at`, `last_seen_at`, `updated_at` (non-null), plus nullable
  collection/link verification times;
- approximately 100 rows / 256 KiB at the probe time.

`first_seen_at` is the collector's first observation time, not evidence of the
Telegram chat's creation time. The current canonical `eventTime` mapping keeps
that source meaning; clients must not reinterpret it as platform creation.

Migration 012 seeds this reviewed mapping as version 2, deliberately
**unapproved**. It also preconfigures the chat cursor candidate
`(updated_at, chat_id)` so `/schema` visibly reports the missing source index;
it does not activate the source.

Reviewed canonical mapping:

```json
{
  "externalId": { "from": "chat_id" },
  "contentType": { "from": "chat_type" },
  "url": { "from": "primary_url" },
  "title": { "from": "title" },
  "eventTime": { "from": "first_seen_at", "type": "timestamp" },
  "collectedAt": { "from": "updated_at", "type": "timestamp" },
  "attributes.username": { "from": "username" },
  "attributes.chatType": { "from": "chat_type" },
  "metrics.members": { "from": "participant_count", "type": "number" },
  "links": { "from": "links" },
  "_drop": {
    "from": [
      "owner_account_id", "monitor_enabled", "collection_status",
      "last_message_id", "last_collected_at", "last_link_verified_at",
      "last_error", "metadata", "last_seen_at"
    ]
  }
}
```

Operational/private collector fields are deliberately consumed by `_drop`
instead of being copied into public extensions.

The reviewed mapping retains source `links` only inside the governed canonical
record. Its member-object fields have not yet been proved by a safe production
shape sample, so public Telegram history always projects `links: []`. Publishing
link members requires a field allowlist, schema/version review and contract
update; it is not enabled by merely adding data upstream.

### 4.2 Messages

Observed shape:

- physical primary key: `id bigint NOT NULL`;
- business uniqueness: `UNIQUE (chat_id, message_id)`;
- content/author: sender ID/name/username, `message_text`, `message_type`,
  `message_url`;
- relations: reply/thread/group IDs;
- engagement: view/forward counts and outgoing flag;
- structured payloads: `media jsonb`, `entities jsonb`, private `metadata`;
- time/state: `message_at`, `collected_at`, nullable `edited_at` and
  `deleted_at`;
- 163,401 exact rows at the semantic probe time (the planner estimate was
  lower), approximately 168 MiB.

Migration 012 also seeds this reviewed messages mapping as version 2 and leaves
it unapproved because no safe continuous watermark exists.

Reviewed canonical mapping:

```json
{
  "externalId": {
    "from": ["chat_id", "message_id"],
    "type": "composite",
    "separator": ":"
  },
  "contentType": { "from": "message_type" },
  "url": { "from": "message_url" },
  "body": { "from": "message_text" },
  "authorExternalId": { "from": "sender_id" },
  "authorName": { "from": ["sender_name", "sender_username"] },
  "eventTime": { "from": "message_at", "type": "timestamp" },
  "collectedAt": { "from": "collected_at", "type": "timestamp" },
  "editedAt": { "from": "edited_at", "type": "timestamp" },
  "deletedAt": { "from": "deleted_at", "type": "timestamp" },
  "attributes.username": { "from": "sender_username" },
  "attributes.isOutgoing": { "from": "is_outgoing", "type": "boolean" },
  "relations.chatId": { "from": "chat_id" },
  "relations.messageId": { "from": "message_id" },
  "relations.replyToMessageId": { "from": "reply_to_message_id" },
  "relations.threadId": { "from": "thread_id" },
  "relations.groupedId": { "from": "grouped_id" },
  "metrics.views": { "from": "view_count", "type": "number" },
  "metrics.shares": { "from": "forward_count", "type": "number" },
  "media": { "from": "media" },
  "entities": { "from": "entities" },
  "_drop": { "from": ["id", "metadata", "collected_by_account_id"] }
}
```

This mapping preserves the public media/entity allowlist and tombstone time
while deliberately omitting collector account and arbitrary metadata. Current
message types include text, image, other, video, document, service and audio;
blank text is valid for media/service rows and is not by itself a rejection.

The structured-value probe supports only these current public member fields:

- `media`: `media_kind`, `status`, `telegram_id`, `file_name`, `extension`,
  `mime_type`, `size_bytes`; duplicated `chat_id`/`message_id` stay in canonical
  relations instead;
- `entities[]`: `type`, `offset`, `length`, optional `url` and `user_id`;
- `metadata`: no public fields. Observed forward/view/grouping/post-author
  members remain private and the entire object is consumed by `_drop`.

Anything added inside these JSON values is ignored by the public projector
until a new allowlist review; it does not become an API field automatically.

Mappings are immutable versions. The fixed pipeline accepts only the seeded v2
mapping IDs, not merely an arbitrary row whose version happens to be `2`; an
upgrade-time collision fails closed as `builtin_mapping_conflict`. It never
invents a mapping from live rows. A TG mapping correction is a reviewed business
code/migration version applied to both inputs, not an ad-hoc child-source edit.
Mapping approval selects a transform; it still does not prove the incremental
watermark or activate the pipeline.

For a direct file source, `POST .../preview?filename=...` is deterministic and
local by default: parsing, field inference and sample rendering do not call a
model. Agent assistance is opt-in with `agent=true`; even then the model receives
only the column-name array and `sampleRows: []`, never file values. The response
records `agentDataScope=column_names_only`. This direct file path is implemented
for CSV/TSV, JSONL/NDJSON, TXT/MD and XLSX/XLSM uploads; it is not a watched directory, cloud bucket or cloud
warehouse adapter.

### 4.3 Fixed cleaning and search projection

The built-in transform is deterministic:

```text
read-only source row
  -> ingest.source_objects raw evidence
  -> core.canonical_records + revision (idempotent business identity)
  -> outbox.projection_events
  -> Elasticsearch current-state projection
```

Messages preserve `relations.chatId`, so callers can relate the two datasets
without copying a mutable chat object into every message. The current ingest
does **not** materialize a chat/message join or denormalize chat title/username
onto every message; such a design would also need fan-out reprojection whenever
a chat changes. Public history/search expose the two fixed datasets and message
chat IDs; a future join/enrichment must be an explicit versioned contract.

Before the first full TG projection, content schema v3 fixes the fields that
need real ES types:

- title/body raw text plus `titleHanlp/bodyHanlp`;
- author/username raw values with exact, prefix and CJK-bigram subfields,
  dedicated ES `wildcard` typed fields for Latin mid-string handle lookup, plus
  `authorNameHanlp/usernameHanlp` for pre-segmented relevance;
- chat/message/reply/thread/group IDs, chat type and outgoing flag;
- media kind/MIME/extension/file name/size and bounded entity type/user/url
  arrays;
- metrics and event/edited/collection times.

The mapping stays `dynamic: strict`; extra source JSON remains in PostgreSQL
raw/canonical extensions instead of creating arbitrary ES fields. On rollout,
the projector creates `mx-insight-hub-content-v3-current`, rebuilds it from PG
current truth under an advisory lock, atomically switches read/compatible write
aliases, then runs a second reconciliation pass. PG remains authoritative and
the old index is never used as the reindex source.

The fixed TG v2 path does not call an LLM per row. Today Agent is used only for
explicit `agent=true` file-column mapping suggestions (column names only), while
embedding is a separate retrieval worker. Future drift/quarantine enrichment
may call Agent with audited model/prompt/data scope and cost, but it must not
choose identity, watermark or tombstone semantics and cannot block the
deterministic raw/canonical path.

## 5. Continuous-sync gate

### 5.1 Why the unprepared messages table must remain paused

The semantic probe found:

```text
rows                         163401
edited rows                    1530
deleted rows                   7480
edits after collection          203
deletions after collection     7480
collected before event           35
blank text                     2023
```

`message_at` is event time and does not change on edit/delete.
`collected_at` is the original collection observation; at least 203 edits and
all 7,480 observed deletions occurred after it. Advancing a cursor on either
column would therefore skip real changes forever. `edited_at` and `deleted_at`
are nullable and each covers only one change kind, so neither is a unified
watermark.

Before activation, provide one of these reviewed contracts:

1. run the explicit source preparation in §3.1. Its database-enforced shared
   watermark, triggers, hard-delete guard and composite indexes implement the
   fixed v1 writer contract; or
2. provide an append-only change journal/CDC stream with an ordered commit
   position and extend the Hub connector to consume that position.

An ordinary trigger assigning `now()` and an index are not, by themselves,
proof of commit order: overlapping transactions can commit in the opposite
order. A serialized single-writer protocol may satisfy option 1 if it is part of
the enforced writer contract. Otherwise prefer CDC/WAL semantics.

### 5.2 The unprepared chats table is not safe either

The original probe found a plausible non-null `updated_at` and stable `chat_id`
but no full `(updated_at, chat_id)` index and no enforceable writer/commit
contract. The source preparation action installs both-table enforcement and
the missing index as one versioned operation; do not manually mark this gate
complete merely because the column name exists.

### 5.3 Activation checklist

For each table independently:

- stable non-null canonical identity is proved;
- the change watermark covers insert/update/delete and is non-null;
- the physical tie-breaker is immutable and supported by the connector;
- a non-partial btree begins `(cursorColumn, idColumn)`;
- a full unique index proves the ID/pair forms a total order;
- writer commit ordering or CDC position semantics are documented and tested;
- approved mapping matches current column types;
- source connection test and schema probe return no issues;
- source preparation reports the current generation ready and no later
  competing row trigger can overwrite its stamp;
- both source and singleton-watermark timestamps are finite and protected by
  database CHECK constraints;
- initial full-table load and source impact are accepted.

There is no safe bounded snapshot/canary mode in the current database puller:
`batchSize` limits each transaction, not total rows, and continuations drain to
the current end. Do not set `batchSize=3` expecting only three records. A
one-time exported CSV/TSV, JSONL/NDJSON, TXT/MD or XLSX/XLSM can use the existing direct file importer, but
that is a separately evidenced snapshot, not continuous database synchronization
or a cloud/object-storage connector.

## 6. Run, monitor and recover

Only after both §5 gates pass, use the unified business controls. Read
`writerContract.version` and `writerContract.digest` from the pipeline GET,
verify the listed writer guarantees with the source owner, then send that exact
pair back. The Hub first probes both fixed source contracts and checkpoint
compatibility; only then does one Hub transaction approve both exact built-in
mappings, persist the immutable attestation, and activate both children:

```http
POST /internal/v1/admin/pipelines/telegram-monitor/status
{
  "status": "active",
  "writerContractAttestation": {
    "confirmed": true,
    "contractVersion": "<writerContract.version>",
    "contractDigest": "<writerContract.digest>"
  }
}
POST /internal/v1/admin/pipelines/telegram-monitor/sync    { "batchSize": 1000 }
GET  /internal/v1/admin/pipelines/telegram-monitor
GET  /internal/v1/admin/pipelines/telegram-monitor/progress
```

`progress` performs explicit source `COUNT` queries only when the task console is
opened/refreshed; it is not part of the scheduler loop. With a safe saved
composite checkpoint it reports exact `totalRows/completedRows/remainingRows`
for that `checkedAt` snapshot. Before the first checkpoint those progress fields
are null. When a column/index/order gate is unsafe it still returns exact
`totalRows` plus `blocker/issues`, but deliberately leaves completed, remaining
and percent null. Per-child `/sources/{sourceKey}/sync` GET and `/imports` stay
available under “只读诊断”; their mutation routes cannot bypass the pipeline.

The ingest worker scans on `MX_INSIGHT_EXTERNAL_PULL_INTERVAL_MS` (global scan
granularity). Generic sources are scheduled independently. TG is excluded from
that loop: it becomes due only when both fixed children are active, idle, due,
and covered by the current writer-contract digest; both jobs are inserted in
one PostgreSQL queue transaction. Values are bounded to 60–86,400 seconds. This
is polling rather than event-driven CDC: expected detection delay is the source
interval plus up to one global scan interval. A failed child intentionally holds
the pair until an operator resolves it instead of creating a split retry storm.

Pull and checkpoint reset for the same source share a PostgreSQL session
advisory try-lock across Admin/ingest workers. They never overlap: a concurrent
operation returns `409 source_busy` immediately. Pause first, let the current
pull leave the critical section, then retry reset; do not loop aggressively.

Pausing is deliberately a batch-boundary drain, not a transaction kill. The
`PUT {"status":"paused"}` prevents another scheduled/continuation batch from
starting, while a batch already holding the source lock may finish its canonical
COMMIT and checkpoint acknowledgement. During this interval source status is
paused but cursor status is still running. Connection changes, mapping approval
and reactivation return `409 source_draining`. Wait until `GET .../sync` shows a
non-running cursor before changing topology, approving a mapping or resetting.

The durable queue/cursor and import runs expose status, trigger
(`manual|schedule|file`), row/ingested/rejected/changed/deleted counts, cursor
start/end, safe error code, next due time and timestamps. One database import
run spans its complete multi-batch continuation chain; batch keys absorb a
replayed committed page without inflating counters. Accepted source objects and
new revisions link back to that import run. The Admin UI is the normal operator
view for these records.

The puller writes an active `importRunId` into the durable checkpoint before
canonical ingest. Its deterministic active `run_key` is derived from the
source, contract/mapping and starting checkpoint. If the process dies after the
canonical transaction commits but before cursor acknowledgement, lease reclaim
reuses that same run and batch key: the committed page is replayed safely,
counts remain single, and lineage does not move to a second run.

The canonical transaction locks that run and checks `(import_run_id,batch_key)`
before writing any source object, canonical row, revision, outbox event or
counter. A previously succeeded batch returns its stored counts and
`cursor_end`; the ordinary pull path performs this check before it even opens the
source connection. Each committed/failed batch also stores a SHA-256 fingerprint
of its ordered source-page identity. If a lower-level duplicate call presents a
different page for the same batch key, the store reports `pageDrifted=true` and
the stored fingerprint/batch remains incident evidence. The already committed
batch stays authoritative—the new page is not a reason to overwrite its cursor
or counters.

Run terminal state and its terminal durable cursor are committed together in one
Hub PostgreSQL transaction. A transport failure during COMMIT can therefore mean
“committed, reply lost” or “not committed”. Errors
`external_commit_outcome_unknown`, `external_finalize_outcome_unknown` and
`external_reset_outcome_unknown` explicitly represent that ambiguity; they are
not proof of rollback.

Correctness rules:

- canonical uniqueness is
  `(dataset_id, platform, object_type, external_id)`; replays update/skip rather
  than creating another logical record;
- revision hashes avoid a new revision for unchanged content; metrics/edit/
  tombstone changes do produce projection work;
- a mapped `deletedAt` sets the canonical tombstone and all
  history/search/entity queries exclude that row while retaining
  source/revision evidence. The projector groups claimed events per aggregate,
  reloads PostgreSQL current truth, and issues one externally versioned delete
  for missing/tombstoned state or index for active state. A stale upsert cannot
  resurrect a deleted document; ES version conflicts are successful stale
  delivery;
- the source cursor advances only after canonical writes and outbox evidence
  commit;
- any rejected database row fails the batch, preserves rejection evidence and
  leaves the previous checkpoint unchanged;
- failed cursors do not auto-retry every scheduler tick. Pause/fix/probe,
  approve a new mapping when required, then explicitly resume;
- the checkpoint carries a hash of source coordinates, prepared-source
  generation, table, cursor, dataset/object identity and mapping version. A
  changed server or recreated/repaired source contract therefore returns
  `checkpoint_contract_mismatch` instead of continuing from an unrelated
  position. A generic reset is an explicit paused-source action. TG instead
  requires both children paused/drained and exact
  `confirmPipelineKey=telegram-monitor` through
  `POST /internal/v1/admin/pipelines/telegram-monitor/checkpoints/reset`. It
  writes both checkpoints against the fixed v2 mapping contract in one action,
  so a legacy v1 checkpoint cannot deadlock the next activation. It returns
  `409 source_busy` while a pull holds the source lock; after acquiring the
  lock, it marks a checkpoint-owned active run failed with
  `error=checkpoint_reset`, removes that run from the new idle checkpoint and
  records `resetAt`;
- a crash before commit replays normally. A crash after canonical COMMIT but
  before cursor ack resumes the checkpoint-owned run and reuses its batch key;
  neither path may skip forward or double-count the run.

### 6.1 Safe manual recovery

1. Capture `GET .../sync`, the latest import run/counts/error, queue attempt and
   request ID. Never edit `mxq.cursors`, `ingest.import_runs` or batch rows by
   hand.
2. For batch/finalize outcome-unknown, **leave the source active and do not
   reset, rotate, remap or create another run**. Allow the same queued payload to
   retry; if attempts are exhausted, issue one explicit `POST .../sync` while the
   checkpoint still owns the same `importRunId`. The batch-first lookup or stale
   continuation check resolves either COMMIT outcome safely.
3. For reset outcome-unknown, keep the source paused and retry the same confirmed
   reset request. Do not reactivate until the response and `GET .../sync` agree
   on an idle checkpoint with no active run.
4. For `source_busy`/`source_lock_lost`, do not infer whether a batch committed.
   Wait for the owner/lease and retry the same operation. Do not turn contention
   into a reset loop.
5. For `row_rejections_detected` or `import_batch_failed`, preserve the failed
   batch/rejection evidence. Pause and drain, correct the source contract or
   create/review/approve a new mapping, probe again, then use the explicit
   confirmed reset before a full replay. A failed batch never advances the old
   checkpoint.
6. A `pageDrifted` observation means the source changed what the same keyset page
   represents. Preserve the committed batch, pause at the next boundary and
   audit watermark/index/commit-order guarantees with the source owner; blindly
   rewinding can hide the exact correctness defect.

Do not expose `ingest.rejected_rows.raw_row` through Admin preview or the public
API. It may contain source content and needs restricted database access and a
retention policy.

Before granting consumers, reconcile source and Hub exact counts/time bounds,
account for tombstones, resolve every rejection, record mapping version and
cursor, and verify a customer-safe three-item response. Then validate:

- `GET /api/v1/data/telegram/chats|messages` for deterministic history;
- `POST /api/v1/data/telegram/search` for Night-All-v1-compatible stored
  full-text search, including more than one page with each returned cursor sent
  back unchanged and a separate stable idempotency key per distinct page body;
- `GET /api/v1/data/telegram/entities/search` for fuzzy author/chat lookup;
- first-page ES outage fallback to PostgreSQL without loss of canonical
  availability. Confirm the warning and verify from query evidence that its
  NULL-aware `(event_time, id)` keyset does not use `OFFSET`;
- an established ES cursor during a temporary ES outage returns
  `503 search_cursor_unavailable` and never silently changes to PostgreSQL;
- an expired two-minute PIT returns `410 search_cursor_expired`; discard that
  cursor and restart at a cursor-less first page. Do not confuse this public
  search cursor with the source ingestion checkpoint or manually edit either.

To stop delivery, remove/disable the affected consumer grant. To stop intake,
pause the source. A transaction already in flight may finish; the next pull
observes the paused state. Do not delete canonical rows or manually rewind a
cursor as routine rollback—preserve evidence and use a reviewed replay plan.

Migration 012 also adds PostgreSQL trigram indexes for body, author handle and
chat username so the ES degradation path is viable for the current corpus. On
an already large Hub canonical table, rehearse this migration or create the
equivalent indexes concurrently in a maintenance window before running the
transactional migration; ordinary index creation can hold a disruptive lock.
