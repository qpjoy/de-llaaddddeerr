# Telegram monitor PostgreSQL ingestion

Status: implemented connector and serving path; production activation is
blocked until the real source schema and watermark contract pass this runbook.

This runbook covers the two tables written by an independent server-side
program:

```text
night_all.public.tg_monitor_chats
night_all.public.tg_monitor_messages
```

At the time this path was added, those tables were not defined by the Night-All
repository migrations or the available local database snapshot. Their names
are known; their columns, types, constraints, update behavior, delete behavior
and production indexes are not Hub-owned facts. Migration
`010_tg_monitor_sources.sql` therefore registers both sources as **paused** and
adds only **unapproved inferred mappings**. A candidate alias in that migration
is a review aid, never evidence that the production column exists.

## 1. Runtime boundary

```text
external collector/writer(s) -> night_all public tables
                       |
                       | read-only PostgreSQL session
                       v
Hub external-pull worker -> source_objects -> canonical_records/revisions
                                             |
                                             v
                         GET /api/v1/data/telegram/{chats|messages}
```

- Hub never writes these source tables; the existing external program(s) retain
  writer ownership. The number of writers and their transaction contract must
  be verified rather than inferred here.
- Hub stores only the environment-variable **name**
  `MX_INSIGHT_TG_MONITOR_DATABASE_URL`; a DSN never enters the catalog or an
  Admin response.
- The connector supports PostgreSQL only and opens every source session with
  `default_transaction_read_only=on`.
- Source management, schema, preview and sync endpoints require a Hub platform
  administrator. A tenant owner cannot register or inspect a global source.
- The public route reads Hub PostgreSQL. It does not expose a database route or
  query the source database on behalf of each caller.

## 2. Create the least-privilege source credential

The Night-All database owner, not the Hub deployment, creates the reader. The
exact role and Secret names are deployment choices; the privilege set is not:

```sql
GRANT CONNECT ON DATABASE night_all TO mx_insight_tg_reader;
GRANT USAGE ON SCHEMA public TO mx_insight_tg_reader;
GRANT SELECT ON TABLE
  public.tg_monitor_chats,
  public.tg_monitor_messages
TO mx_insight_tg_reader;
ALTER ROLE mx_insight_tg_reader SET default_transaction_read_only = on;
```

Do not grant table ownership, schema `CREATE`, DML, sequence access, a Night-All
writer role or superuser. Put the resulting DSN in the Hub Admin/ingest workload
Secret as `MX_INSIGHT_TG_MONITOR_DATABASE_URL`. The public listener does not
need this Secret.

Before continuing, connect as that reader and record the output of:

```sql
SELECT current_database(), current_user,
       has_table_privilege(current_user, 'public.tg_monitor_chats', 'SELECT') AS chats_select,
       has_table_privilege(current_user, 'public.tg_monitor_messages', 'SELECT') AS messages_select;
SHOW default_transaction_read_only;
```

Both privileges and read-only mode must be true. A failed write probe should be
performed only in an explicit transaction that is rolled back; do not mutate a
production row to prove the role is read-only.

## 3. Schema gate: metadata before row values

The Hub endpoint reports columns and whether the configured cursor, ID and
mapping aliases exist. It deliberately does not return row values:

```http
GET /internal/v1/admin/sources/telegram-monitor-chats/schema
GET /internal/v1/admin/sources/telegram-monitor-messages/schema
x-mx-insight-admin-token: <admin token>
```

Capture the initial `issues` and `warnings`; the final probe immediately before
activation must have no `issues`. The schema probe evaluates only the currently
approved mapping. Migration 010's candidate is deliberately unapproved, so the
initial probe reports `mappingVersion: null` and does not treat candidate aliases
as warnings; inspect that candidate through the mappings list instead. Once a
mapping is approved, absent optional aliases appear as `warnings`. The migration
also leaves `cursorColumn` and `idColumn` unconfigured, so the initial probe is
expected to report both until they are selected from evidence. There are no
implicit `updated_at`/`id` defaults.

The schema endpoint also reports estimated rows/bytes, indexes, constraints and
triggers without returning row values. Cross-check its evidence with these
read-only metadata queries when reviewing the source contract:

```sql
SELECT table_name, ordinal_position, column_name, data_type, udt_name, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('tg_monitor_chats', 'tg_monitor_messages')
ORDER BY table_name, ordinal_position;

SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('tg_monitor_chats', 'tg_monitor_messages')
ORDER BY tablename, indexname;

SELECT conrelid::regclass AS source_table, conname,
       pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid IN (
  'public.tg_monitor_chats'::regclass,
  'public.tg_monitor_messages'::regclass
)
ORDER BY source_table, conname;

SELECT relname, reltuples::bigint AS estimated_rows
FROM pg_class
WHERE oid IN (
  'public.tg_monitor_chats'::regclass,
  'public.tg_monitor_messages'::regclass
);
```

For each table, approve all of the following before configuring it:

1. One non-null source identity maps deterministically to Hub `externalId`.
   Telegram message IDs may be chat-scoped, but that must be proved from the
   writer contract or a uniqueness constraint; do not assume it from Telegram
   conventions alone.
2. `cursorColumn` is a non-null, monotonically non-decreasing date/timestamp
   that changes when a row changes. The current connector accepts PostgreSQL
   `date`, `timestamp` and `timestamptz`; integer/LSN watermarks are not
   supported. A day-only `date` still needs proof that the ID tie-breaker cannot
   make later inserts sort behind an advanced cursor.
3. `idColumn` is one non-null, immutable physical small/int/big integer, UUID or
   text-like column used as the tie-breaker. The current connector cannot use a
   SQL expression or a two-column composite as its pull tie-breaker.
4. The ordered pair `(cursorColumn, idColumn)` forms a provable total order: a
   full-table (non-partial) btree index begins with those two native columns,
   and a full-table unique index covers either `idColumn` alone or exactly the
   pair. Partial indexes are rejected even when their predicate looks
   equivalent to the non-null gate. Ask the source owner to
   review `EXPLAIN` and create the production index if needed; Hub does not
   create indexes in Night-All.
5. The writer's transaction/update behavior guarantees that advancing the
   watermark cannot hide a later commit with an older timestamp.

If any item fails, stop. The safe fix is a writer-owned stable key/watermark (or
a reviewed source view) or a new connector cursor strategy. Choosing a nearby
column name is not a workaround.

## 4. Configure physical names without storing a DSN

While the source is paused, use the platform-admin source update after
substituting only names verified in the schema gate. The example values below
are placeholders, not production column claims:

```http
PUT /internal/v1/admin/sources/telegram-monitor-messages
Content-Type: application/json

{
  "connection": {
    "dsnEnv": "MX_INSIGHT_TG_MONITOR_DATABASE_URL",
    "schema": "public",
    "table": "tg_monitor_messages",
    "cursorColumn": "<verified timestamp watermark>",
    "idColumn": "<verified stable physical id>"
  }
}
```

Repeat for chats with its independently verified cursor/ID columns. The seeded
dataset/platform/object type are not caller-editable on this update. Literal
`dsn`, host, user, password and arbitrary connection properties are rejected;
connection metadata cannot change while a source is active or in the same call
that activates it.

Re-run both `/schema` endpoints. A source stays paused through this operation.

## 5. Shape-preview three rows, then approve a mapping

While the source is paused, request the bounded value-free preview:

```http
GET /internal/v1/admin/sources/{sourceKey}/preview?limit=3
```

The response includes columns and `sampleShapes`. For each row/column it exposes
only `jsonType`, `isNull` and the `serializedLength` of its JSON representation;
it never returns the source value, message text, username, raw object or mapped
record. `serializedLength` is the UTF-8 byte length of the runtime JSON
serialization (or its JSON-string fallback); it is not PostgreSQL storage size
or the original binary payload length. The server maximum is three. This is
sufficient to spot obvious type/null/size drift without
turning an Admin diagnostic into a data-export API. Inspecting actual sample
values requires a separately authorized data-review process outside this
endpoint; do not weaken the shape preview to obtain demo content.
The preview intentionally uses `SELECT * ... LIMIT 3` with no `ORDER BY`; it
is row-bounded, not byte-bounded, and is not a promise to show the newest rows.
A table with very large values can still make those three rows expensive, so
run the preview inside the reviewed source load/timeout budget.

List `/internal/v1/admin/sources/{sourceKey}/mappings`. Version 1 from migration
010 is `origin=inferred`, unapproved, and may contain aliases that do not exist.
Use the schema and writer contract to create a corrected immutable version:

```http
POST /internal/v1/admin/sources/{sourceKey}/mappings
Content-Type: application/json

{
  "origin": "manual",
  "notes": "Verified against production schema and writer contract on <date>",
  "fieldMap": {
    "externalId": { "from": "<verified identity column>" },
    "eventTime": { "from": "<verified business event timestamp>" },
    "collectedAt": { "from": "<verified collection/update timestamp>" }
  }
}
```

The messages mapping may use
`{"from":["<verified chat id>","<verified message id>"],"type":"composite"}`
for `externalId` only after that identity rule is proven.

For the public messages contract, also map the verified chat/message identities
to `relations.chatId` and `relations.messageId`; otherwise exact `chatId`
filtering and response relations cannot work even though an ingest row is
technically valid. `eventTime` is required for both datasets because serving
orders and bounds pages by that value.

Approve the exact new version with:

```http
POST /internal/v1/admin/sources/{sourceKey}/mappings/{version}/approve
```

Approval changes which mapping is active; it does not start a pull. Compare the
field map to the schema, writer contract and value-free shapes. Reject it if
identity/watermark evidence is incomplete, composite collisions are possible,
a time/numeric type is incompatible, or chat/message relations are ambiguous.
Create and approve a new version; never edit an approved version in place.

## 6. Activation and full pull

After all gates are signed off, activate only the reviewed source:

```http
PUT /internal/v1/admin/sources/{sourceKey}
Content-Type: application/json

{ "status": "active" }
```

Activation is not a blind flag flip: the route requires an approved mapping,
runs the schema/index probe, and rejects any non-empty `issues`. Connection
metadata must have been updated in an earlier paused-state call.

Start one table at a time:

```http
POST /internal/v1/admin/sources/{sourceKey}/sync
Content-Type: application/json

{ "batchSize": 1000 }
```

This `POST` is the immediate first-run/operator trigger, not the only mechanism
for continuous intake. The ingest worker also runs a periodic scheduler:

- `MX_INSIGHT_EXTERNAL_PULL_INTERVAL_MS` controls the scan interval (default
  60,000 ms), and `MX_INSIGHT_EXTERNAL_PULL_BATCH_SIZE` controls the scheduled
  batch size (default 1,000; the puller still caps a batch at 5,000);
- only active database sources whose durable cursor is absent or `idle` are
  scheduled;
- a `running` cursor owns its continuation chain, and pending/running jobs are
  additionally protected by the queue dedupe key;
- a `failed` cursor is deliberately not retried on every scheduler tick. Fix
  and probe the cause (pausing/updating/reactivating the source when required),
  then explicitly `POST .../sync` to resume from the unchanged checkpoint.

Each database-pull job sends a lease heartbeat immediately and every 30
seconds while its batch runs, then once more before continuation. An unfinished
batch persists its continuation even during graceful shutdown, so a `running`
cursor is not orphaned across a rollout. This reduces
duplicate lease reclamation during a slow query/ingest transaction; the
checkpoint and canonical uniqueness constraints remain the correctness layer
if a worker still dies. The scheduler scans immediately at worker startup.
Internal K8s supplies its settings through the ConfigMap; local Compose runs a
separate `ingest` service after the API is healthy, so both profiles consume
manual and periodically scheduled jobs.

The current Internal ingest Deployment deliberately has one replica and a
`Recreate` rollout. Do not scale it horizontally until each source has a
cross-worker mutex or cursor compare-and-swap; queue dedupe alone is not a
complete source-level lease for future multi-worker scheduling.

`batchSize` is bounded to 1–5,000 rows **per transaction**. It is not a total
canary limit: when a full batch completes, the worker schedules a distinct
continuation and drains forward until it reaches the current end. Therefore the
only built-in bounded inspection is `/preview?limit=3`, and it is not an ingest
canary. Do not enqueue sync until a full-table pull is acceptable. If a bounded
ingest canary is mandatory, the source owner must provide a reviewed limited
view and it must use a separate temporary Hub source/dataset. Do not pretend
`batchSize: 3` imports only three rows.

Monitor:

```http
GET /internal/v1/admin/sources/{sourceKey}/sync
```

This reports the durable `external:{sourceKey}` cursor and `external-pull`
queue counts. Also monitor worker logs for `pulled`, `ingested`, `changed` and
`rejected`. A batch advances the cursor only after the canonical transaction
commits. A crash before that point replays the batch; uniqueness on
`(dataset_id, platform, object_type, external_id)` and revision hashes makes the
replay idempotent. A database batch with any rejected row fails before accepted
rows are ingested, so the checkpoint never advances past data that needs a
mapping correction. Each batch has an `ingest.import_runs` audit record and
rejected rows/reasons enter the existing bounded `ingest.rejected_rows` evidence
store. Other pull/ingest failures also keep the prior checkpoint. Import/cursor
failures retain only a safe error code, never a driver message that might contain
a host, schema detail or credential. Correct and approve a new mapping while the
source is paused, then reschedule from the unchanged checkpoint.

`ingest.import_runs` is currently batch-level evidence: it records counts,
status/error and rejected rows. Accepted `source_objects` and
`record_revisions` do not yet store the corresponding `import_run_id`, so do
not claim row-to-import-run lineage. Add a reviewed schema link before that is
a compliance requirement. An idle periodic poll also creates a succeeded
zero-row import run; include that expected audit noise in retention/monitoring
budgets rather than alerting on the row count alone.

`ingest.rejected_rows.raw_row` is bounded to the first 1,000 rejections per run
but can contain source business content. It is internal incident evidence, not
a public/Admin preview response; apply database access control and retention
policy before production activation.

After the first source reaches `idle`, compare source and Hub counts/time bounds
using the verified mapping and investigate every rejection before starting the
second source. The release evidence must include:

- source row estimate/exact count and min/max verified watermark;
- Hub canonical count and min/max `event_time` for the fixed dataset;
- zero unresolved rejected rows, plus correction/successful-replay evidence for
  every earlier rejection, and the mapping version;
- cursor position, duration, average batch rate and source DB load;
- a public `pageSize=3` response checked against the strict field allowlist.

Only after that evidence passes should a consumer receive the `telegram` grant
and call `/api/v1/data/telegram/chats` or `/messages`.

The grant exposes the complete fixed dataset. Canonical Telegram records do
not currently carry `tenant_id`, so this rollout cannot use tenant membership
as a row filter. If consumers require different subsets, stop and design a
versioned dataset/row-scope contract before granting access.

Before enabling message `chatId` traffic at scale, review `EXPLAIN` on the Hub
query and install the expression index outside the transactional migration
runner. Use a direct maintenance connection and monitor build progress:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS canonical_records_tg_monitor_chat_idx
  ON core.canonical_records
    (dataset_id, (stable_fields #>> '{relations,chatId}'), event_time DESC, id DESC)
  WHERE platform = 'telegram'
    AND object_type = 'message'
    AND deleted_at IS NULL
    AND dataset_id = 'telegram.monitor.messages.v1';
```

Migration 005's generic feed index supports the initial fixed-dataset scan.
Migration 010 deliberately does not create indexes on an already-populated Hub
table because the migration runner wraps each file in a transaction, where
`CREATE INDEX CONCURRENTLY` is forbidden.

## 7. Updates, deletions and rollback

- An unchanged replay refreshes `ingest.source_objects.last_seen_at` and the
  canonical record's `last_seen_at`, but does not create a new content revision
  or a `core.observations` row. A changed row is seen only when the verified
  source watermark also advances. Projected metrics are part of the external
  content hash, so a metrics-only change increments the revision and refreshes
  search/AI projections rather than leaving them stale.
- Hard-deleted source rows are invisible to an incremental forward cursor.
  Absence is **not deletion**. The current mapping has no public tombstone field
  and this connector does not set `canonical_records.deleted_at` from a source
  soft-delete flag. Do not promise delete propagation. Define a writer-owned
  tombstone/CDC contract and implement/test it before deletion becomes part of
  the dataset SLA.
- To stop delivery, first disable the `telegram` grant for affected consumers.
  To stop ingestion, call `PUT /internal/v1/admin/sources/{sourceKey}` with
  `{ "status": "paused" }`. The already-running transaction may finish; the
  next pull observes the paused state. There is no queue-cancel endpoint in this
  release.
- Do not delete canonical rows or rewind a cursor as a routine rollback. Keep
  source objects, revisions and projection evidence; correct the mapping with a
  new version and run a reviewed replay/backfill procedure.

The current public Telegram `GET` route enforces API-key authentication,
explicit consumer grant, strict fields, keyset pagination, page-size policy and
the consumer's `telegram.maxRequests` window. Each successful page commits
`max(1, returnedCount)` usage units without retaining its response body. Failed
local reads release their reservation and ambiguous usage commits remain
`unknown` for reconciliation. Delete propagation and a bounded-sync canary are
explicit follow-up gates, not implicit behavior.
