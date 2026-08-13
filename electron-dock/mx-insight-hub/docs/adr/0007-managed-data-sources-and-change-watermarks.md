# ADR-0007: Managed data sources and change watermarks

Status: accepted, with source-specific activation gates.

## Context

External data used to identify a PostgreSQL DSN only by environment-variable
name. That kept credentials out of catalog rows, but every source change
required a Secret update and workload rollout. It also mixed five different
concerns—connection, table, mapping, schedule and execution evidence—into one
source record.

Telegram makes the distinction correctness-critical. One database connection
serves multiple tables; their identities and mappings are known, but their
change-watermark guarantees differ. A successful connection is not proof that a
table can be incrementally synchronized without missing edits/deletions.

## Decision

Use one explicit source resource:

```text
external_source 1 ── N immutable mapping versions
        |
        ├── direct PostgreSQL connection or file configuration
        ├── durable cursor / queued continuation
        └── N import runs / rejection evidence
```

### External source

A PostgreSQL source owns its Hub dataset/platform/object type, polling policy,
table/cursor mapping and its complete allowlisted connection:
`host`, `port`, `database`, `username`, `password`, `sslMode`, `schema`, `table`,
`cursorColumn` and `idColumn`. There is no separate Provider resource or
credential master key. This keeps onboarding and changes on one Admin page.

Only the platform Admin Token can list, create, view, test or update
these sources. Launcher-login sessions and public API keys cannot access source
management. The password is intentionally stored as plaintext inside
`catalog.external_sources.connection` and may be returned to that Admin-token
surface for management. Consequently Hub database readers, base/WAL/logical
backups and any isolated restore can recover source credentials; those assets
must be access-controlled, encrypted in storage/transit, audited and excluded
from logs/support bundles.

Create/update tests the complete candidate in a bounded read-only session.
Connection coordinates can change only while that source is paused and drained.
Activation requires an approved mapping and a successful schema/index probe.

`PUT {status:"paused"}` stops new scheduling immediately but does not abort a
transaction already reading/writing a batch. That batch is allowed to commit and
ack its checkpoint, then the run closes at the batch boundary. During this
`source.status=paused` + `cursor.status=running` interval the source is draining:
connection changes, mapping approval and reactivation return
`409 source_draining`. Operators must observe the cursor becoming idle before a
topology or mapping change.

The legacy `dsnEnv` form remains read-only compatibility for existing sources.
New source configuration stores connection fields directly, so changing a
password or host does not require a Hub deployment. No physical connection
field or credential is part of a public data response.

### Explicit source-contract preparation

Ordinary ingest, inspection and progress connections remain read-only by
construction. External DDL is not coupled to the Hub migration Job or routine
deploy: an unavailable/locked source must not block the Hub, and the normal
runtime credential should stay a least-privilege reader.

The fixed Telegram business pipeline has one explicit Admin-token preparation
action. It requires both children paused and drained, a destructive
confirmation, and either the saved table-owner credential or one-request
migration credentials that are never persisted. A bounded source transaction
locks both fixed tables, installs a versioned shared watermark and
`ENABLE ALWAYS` INSERT/UPDATE plus hard-delete triggers, then online index
steps create/repair the two composite cursor indexes. A final read-only probe
accepts only exact trigger semantics and indexes whose `indisvalid` and
`indisready` flags are true. Any failure leaves the pipeline paused.

The shared watermark is advanced once per write statement while its singleton
row remains locked until transaction end; the last row trigger overwrites
application-provided `updated_at`. Rows in one statement may share a timestamp,
with the immutable ID providing total order. This deliberately serializes TG
write statements. A high-volume source should use an ordered change journal or
logical CDC instead of silently weakening this contract.

The source stores an installation generation tied to both physical table
identities, and Hub binds that generation into its checkpoint contract hash.
Table replacement, server/database replacement, or repair of a broken
correctness contract therefore makes an existing checkpoint incompatible.
Preparation never resets it automatically: the operator must review evidence
and invoke the separately confirmed paired reset/full replay. Re-running
preparation against an already-ready installation preserves the generation.

### Mapping and data minimization

Mappings are immutable reviewed versions. They define canonical identity,
business/event time, collection/change metadata, public structured fields and
explicit `_drop` fields. Unknown columns may be retained internally for future
remapping, but secrets, collector accounts and operational metadata must be
consumed/dropped rather than allowed into public extensions.

### Checkpoint and run evidence

The source checkpoint, including its prepared-source generation, advances only after source-object/canonical/revision/
outbox writes commit. A rejected database row fails its batch and leaves the
prior checkpoint intact. Replay is safe because canonical identity has a
database uniqueness constraint and unchanged revision hashes do not create a
new logical record.

Before canonical ingest, the puller persists the active import-run ID in the
checkpoint. A deterministic active `run_key` (source, contract/mapping and
starting checkpoint) resumes that same run after a hard crash. If canonical
COMMIT succeeds but cursor acknowledgement does not, the reclaimed job reuses
the same run and batch key, so lineage and counters are not split or inflated.

Inside the canonical transaction the run is locked and the durable batch key is
looked up before any source-object/canonical write. A succeeded match returns its
stored counts and `cursor_end`; a failed match requires operator correction and
reset. Each batch also records a source-page fingerprint. A normal hard-crash
resume checks this evidence before opening the upstream connection, so a later
mutated page cannot replace the committed page. A lower-level replay that sees a
different fingerprint reports `pageDrifted`; the stored batch remains the
authoritative commit evidence and the source contract must be investigated.

Completing/failing an import run and saving the terminal durable cursor happen in
one PostgreSQL transaction. A lost connection during batch or finalization
COMMIT yields an explicit outcome-unknown error. The safe recovery is to retry
the same run/batch or same finalization: if the first COMMIT won, durable evidence
absorbs the replay; if it did not, the retry performs it. Resetting or creating a
new run before resolving that ambiguity can split lineage or acknowledge the
wrong position and is forbidden.

Source topology operations use PostgreSQL session advisory try-locks.
Pull/reset/test/connection change share the source lock.
A conflict returns `409 source_busy` instead of waiting behind source I/O. Reset
still requires a paused, drained source; it atomically marks every active
database run for that source failed with `checkpoint_reset` and stores a fresh
idle checkpoint without the active run ID.

Import runs expose row, ingested, rejected, changed and deleted counts, cursor
start/end, status, timestamps and a bounded safe error code. Rejected raw rows
are restricted incident evidence, not Admin preview or public API output.

Mapped tombstones set canonical `deleted_at` and are excluded from every public
history/search/entity read. For each claimed aggregate, the projector reloads
PostgreSQL current truth and emits one externally versioned delete when the row
is missing/tombstoned, or one externally versioned index when it is active.
Thus a stale upsert cannot resurrect a tombstone; ES `409 version_conflict`
means an equal/newer state already won and is treated as successful delivery.
Absence from an incremental page is never interpreted as deletion.

Both full-content and semantic-chunk Elasticsearch indices are mutable
current-state projections backed by PostgreSQL, not append-only rollover truth.
When content shortens, a chunker changes, or a record is tombstoned, the same PG
transaction first queues deterministic old chunk document IDs in
`core.chunk_projection_deletes` and then removes/replaces authoritative chunks.
The embedding loop projects those durable externally-versioned deletes before
new embeddings. This delete path continues even when no model provider is
available, and both indices can be rebuilt from current PG records/chunks.

### Watermark gate

Each database source needs a non-null change watermark plus an immutable
tie-breaker and a supporting full index. The watermark must advance for every
insert, relevant update and soft delete. The source owner must also prove that
commit ordering cannot place a late commit behind an already advanced cursor.

A column named `updated_at` is evidence only after its writer behavior and index
are verified. Event time, initial collection time and nullable edit/delete times
are not substitutes. Where commit ordering cannot be proved, add a source
change journal/CDC connector with an ordered commit position instead of making a
timestamp assumption.

## Source-type boundary

- Admin-managed PostgreSQL sources and direct CSV/TSV, JSON/JSONL/NDJSON, TXT/MD and
  XLSX/XLSM file upload are
  implemented.
- A direct file source uses file-content hash, mapping version and import-run
  evidence; it is not a continuously watched directory or cloud bucket.
- `/shared_dir`, S3/object storage, cloud warehouses and non-PostgreSQL engines
  are future adapters. Each requires its own credentials allowlist, read-only
  test, pagination/checkpoint/delete semantics and driver tests. They are not
  represented as arbitrary PostgreSQL config and are not currently advertised
  as available source types.

## Consequences

- Operators can create/test/update each PostgreSQL source without redeploying
  Hub; repeated tables on one database currently repeat their connection fields.
- A healthy connection can coexist with a deliberately paused unsafe source.
- PostgreSQL canonical state remains authoritative; Elasticsearch is rebuildable
  and a search outage cannot stop ingest/history.
- Source onboarding takes an explicit schema/mapping/watermark review. This is
  intentional: silently skipped changes are more damaging than a visible paused
  source.
- MX-H2I login/networking is outside this data-plane path. Source management is
  restricted to Hub's Admin Token and does not alter Launcher,
  Domestic/Internal routing, WireGuard, DNS or user connectivity.
