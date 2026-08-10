# ADR-0007: Managed source providers and change watermarks

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

Use distinct, explicit resources:

```text
source_provider 1 ── N external_source 1 ── N immutable mapping versions
                              |
                              ├── durable cursor / queued continuation
                              └── N import runs / rejection evidence
```

### Source provider

A provider is a reusable connection/security boundary. The first implemented
type is PostgreSQL. Only allowlisted coordinates (`host`, `port`, `database`,
`username`, `sslMode`) are stored as readable configuration. Its password is
encrypted with AES-256-GCM under `MX_INSIGHT_PROVIDER_MASTER_KEY`; list/update/test
responses contain only `secretConfigured` and safe health evidence.

Provider creation and every update that changes coordinates or password test
the complete candidate connection in a read-only session **before** saving
configuration or encrypted secret. A failed candidate leaves no new provider
and does not replace the last-known-good provider. A display-name-only update is
not a connection change. Sensitive update acquires the Provider lock plus every
currently referencing source lock, rechecks the reference topology, and requires
all referenced sources to be both `paused` and drained. A newly attached source
causes `provider_topology_changed`; an active/running reference causes
`provider_pause_required`.

The master key is a platform Secret injected into Admin/combined and ingest
workloads, not the public listener. Hub database backups contain ciphertext but
not the key. Key drift is blocked; rotation requires re-encryption. Physical
provider identity and credentials never enter the public data contract.

### External source

A source binds one provider to a schema/table plus Hub dataset/platform/object
type and polling policy. Connection coordinates can change only while the
source is paused. Activation requires an approved mapping and a successful
schema/index probe. A provider may serve many sources, but cannot be deleted
while referenced.

`PUT {status:"paused"}` stops new scheduling immediately but does not abort a
transaction already reading/writing a batch. That batch is allowed to commit and
ack its checkpoint, then the run closes at the batch boundary. During this
`source.status=paused` + `cursor.status=running` interval the source is draining:
connection changes, mapping approval and reactivation return
`409 source_draining`. Operators must observe the cursor becoming idle before a
topology or mapping change.

The legacy `dsnEnv` form remains read-only compatibility for existing sources;
new source configuration uses `providerKey` so changing a password/host does
not require a Hub deployment.

The catalog persists the binding as an internal `provider_id` foreign key.
Admin source responses expose both the stable operator-facing `providerKey`
and opaque `providerId`; neither field is part of a public data response.

### Mapping and data minimization

Mappings are immutable reviewed versions. They define canonical identity,
business/event time, collection/change metadata, public structured fields and
explicit `_drop` fields. Unknown columns may be retained internally for future
remapping, but secrets, collector accounts and operational metadata must be
consumed/dropped rather than allowed into public extensions.

### Checkpoint and run evidence

The source checkpoint advances only after source-object/canonical/revision/
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

Source and Provider topology operations use sorted PostgreSQL session advisory
try-locks. Pull/reset share the source lock; Provider test/update/delete and
source attach/change also take the relevant `provider:<key>` and source locks.
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

- PostgreSQL managed providers and direct CSV/JSON/XLSX file upload are
  implemented.
- A direct file source uses file-content hash, mapping version and import-run
  evidence; it is not a continuously watched directory or cloud bucket.
- `/shared_dir`, S3/object storage, cloud warehouses and non-PostgreSQL engines
  are future adapters. Each requires its own credentials allowlist, read-only
  test, pagination/checkpoint/delete semantics and driver tests. They are not
  represented as arbitrary PostgreSQL config and are not currently advertised
  as available provider types.

## Consequences

- Operators can create/test/rotate a PostgreSQL provider and attach multiple
  sources without redeploying Hub.
- A healthy provider can coexist with a deliberately paused unsafe source.
- PostgreSQL canonical state remains authoritative; Elasticsearch is rebuildable
  and a search outage cannot stop ingest/history.
- Source onboarding takes an explicit schema/mapping/watermark review. This is
  intentional: silently skipped changes are more damaging than a visible paused
  source.
- MX-H2I login/networking is outside this data-plane path. Hub deployment gives
  the source master key only to Hub Admin/ingest workloads and does not alter
  Launcher, Domestic/Internal routing, WireGuard, DNS or user connectivity.
