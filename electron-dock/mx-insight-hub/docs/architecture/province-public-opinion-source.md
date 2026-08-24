# Nationwide province public-opinion source

Status: repository contract only; intentionally not connected or deployed.

This document defines the bounded Hub contract for the Night-All
`public.monitor_strategy_results` table. The immediate product goal is to serve
province-specific hot/latest opinion items and item detail without weakening
the existing external-source, lineage or public-authorization boundaries.

It is not an instruction to connect a database, deploy the current branch,
activate a source, grant a consumer or ingest the supplied sample. Those remain
separate operator decisions after the source contract has been proven.

## 1. Ownership and fixed identity

The Hub-owned logical identity is fixed so this source cannot silently merge
with Telegram or another Night-All corpus:

| Concern | Value |
| --- | --- |
| Source key | `province-opinion-results` |
| Upstream table | `public.monitor_strategy_results` |
| Dataset | `public-opinion.province.v1` |
| Hub authorization platform | `public_opinion` |
| Object type | `opinion_item` |
| Cursor order | `updated_at`, then immutable `id` |

`public_opinion` is the Hub grant and serving namespace. It is not the original
content platform. A Weibo, website or other upstream origin remains provenance
on the item and must not replace the Hub authorization platform.

Night-All owns the source table and its writer behavior. MX Insight Hub owns
source registration, reviewed mapping, raw/canonical/revision lineage, public
field filtering and serving APIs. Neither side may infer that ownership of one
layer permits it to mutate the other.

## 2. Safe installation state

Repository installation is fail-closed:

- the source is `paused`;
- only the fixed schema, table, cursor and ID names are present;
- host, database, username and password are absent, so the physical connection
  is unconfigured;
- the built-in mapping is a candidate, not an approved active mapping;
- no consumer receives the `public_opinion` platform grant;
- no scheduler or manual import can run while the source is paused;
- registering metadata performs no upstream network connection or DDL.

These are independent gates. Configuring a connection must not activate the
source. Activating the source must not grant a consumer. Granting a consumer
must not activate or configure ingestion.

Source management stays on the Admin-Token-only surface. Launcher sessions and
public API keys cannot configure, test or activate the source. This pipeline
must not change Launcher, MX-H2I login, Domestic/Internal routing, WireGuard,
DNS or user connectivity.

## 3. `updated_at + id` is a correctness gate

The supplied table contract has an immutable primary-key `id`, but it does not
currently provide a reliable change watermark. `created_at` only describes the
initial insert and cannot reveal a later correction to `province`, source
metadata, heat or LLM output. It must never be used as an incremental cursor.

Activation requires all of the following upstream guarantees:

1. `updated_at` exists, is non-null, uses `timestamp` or `timestamptz` (never
   day-resolution `date`) and has a validated exact
   `CHECK (isfinite(updated_at))` constraint. Infinite watermarks are rejected
   before they can poison the durable checkpoint.
2. Every insert and every relevant update advances `updated_at`. Relevant
   updates include at least `province`, `source_id`, `source_name`,
   `source_type`, `platform`, `published_at`, title/summary/link,
   `heat_score`, LLM classification fields and any supported deletion marker.
3. `id` is immutable and uniquely orders rows that share an `updated_at`.
4. A usable index begins with `(updated_at, id)` in that order.
5. Writer/commit ordering cannot make a later committed change appear at or
   behind a checkpoint the Hub has already acknowledged.
6. Hard deletes are not used. A removal must remain observable through a
   watermarked tombstone/change record. Otherwise an ordered change journal or
   CDC position is required.

A column name and index alone are insufficient: the source owner must attest to
the writer behavior. The Hub's read-only probe verifies the visible schema,
nullability, types and index, but it cannot prove application commit semantics.
If those semantics cannot be guaranteed, the correct adapter is a future
append-only change journal or CDC connector—not a timestamp guess.

Routine Hub ingest must not create the upstream column, trigger or index. The
source remains paused until Night-All has deliberately implemented and tested
the contract and an operator has reviewed the evidence.

The two Hub-local hot/latest serving indexes are deliberately outside migration
033. Building regular indexes inside the transactional migration would retain
the preceding `ALTER TABLE` lock while PostgreSQL scans the shared canonical
table. After a separately approved Hub migration, and before this one pipeline
is activated, install them online as a standalone non-transactional operation:

```bash
cd electron-dock/mx-insight-hub
DATABASE_URL='<Hub PostgreSQL URL>' npm run ops:province-opinion-indexes
```

The SQL uses `CREATE INDEX CONCURRENTLY`, validates the exact table, btree keys,
predicate and ready/valid/live state, and is safe to rerun. Do not wrap it in
`BEGIN`/`COMMIT`. Pipeline activation and the province list API both fail closed
until both exact indexes are ready; item detail remains an indexed canonical-ID
lookup. This command is an operator runbook entry, not authorization to execute
it in the current phase.

## 4. Initial alignment and subsequent incrementals

After connection configuration, schema/index probe, mapping review and writer
attestation all pass, ingestion has exactly two modes.

### 4.1 First run: complete current alignment

An empty, explicitly reviewed checkpoint starts a keyset scan of all current
rows in `(updated_at, id)` order. Each committed batch preserves:

- the exact upstream row as a source object;
- the reviewed mapping/import-run identity;
- the canonical record and immutable revision when content changed;
- projection-outbox work;
- the acknowledged `(updated_at, id)` checkpoint.

Those writes and the checkpoint acknowledgement form one Hub transaction. A
failure leaves the last committed checkpoint intact. Retry resumes the same
run/batch evidence; it does not create a second logical initial import.

This is a current-table alignment, not proof that previously hard-deleted rows
never existed. Deletion history requires the source contract described above.

### 4.2 Later runs: strict change-watermark traversal

After the initial alignment, every scheduled or manual pull reads only rows
strictly greater than the durable `(updated_at, id)` checkpoint. There is no
periodic historical full scan and no overlap window used to hide an unsafe
watermark.

An unchanged replay is absorbed by canonical identity and revision hashes. A
rejected row or ambiguous commit must not advance the checkpoint. Resetting the
checkpoint requires the source to be paused and drained plus an explicit
operator confirmation; reset is a controlled full replay, not a normal retry.

The source state, import-run state and cursor state remain separate. A healthy
connection is not evidence that incremental synchronization is safe:

| Layer | States |
| --- | --- |
| Source | `paused`, `active` |
| Import run | `running`, `succeeded`, `failed`, `skipped` |
| Cursor | `idle`, `running`, `failed` |
| Projection outbox | `pending`, `delivered`, `dead` |

## 5. Field and provenance classification

The source mapping distinguishes facts, serving fields and restricted evidence.

### Province

Only an explicit supported province name/code is normalized to an ISO
3166-2:CN `admin1_code`. The original source value remains available in
restricted lineage. An empty, unsupported, conflicting or not-yet-analysed
province remains SQL `NULL`.

`NULL` means “not classified from accepted evidence”. It must not be rewritten
as `全国`, `其他`, `unknown`, Jiangsu or a best guess. Such a record is excluded
from province-specific feeds until a later source revision or an accepted
future classification assertion supplies a province.

The nationwide province dictionary defines accepted identifiers; it does not
promise that every province currently has data.

### Heat

`heat_score` is a numeric serving field. The province hot feed includes records
with a non-null score, orders it descending and uses an internal effective sort
time plus record identity as stable tie-breakers. The latest feed orders by that
effective time, collection time and identity and does not require a heat score.
Effective sort time is the factual `publishedAt` when present, otherwise
`collectedAt`; the fallback is never returned as `publishedAt`. `from`/`to`
continue to filter factual `publishedAt`, so bounded requests exclude records
whose publication time is unknown.

Heat is meaningful only under the source's declared scoring contract. A global
search must not compare heat values from unrelated sources as if they shared a
scale unless a later reviewed normalization version explicitly defines that
comparison.

### Source and model evidence

Public origin fields are a reviewed subset such as source name, type and
content platform. Internal identifiers, strategy/run linkage, raw JSON,
keywords, LLM reason/confidence and detailed heat metrics remain in raw/revision
lineage or Admin-only views. They are not made public through `extensions`,
highlighting or arbitrary field selection.

`llm_label` is optional enrichment evidence rather than an activation field:
when present the built-in mapping retains it privately, while its absence does
not block province, heat or latest serving. It is never part of the public item
contract.

The upstream row is untrusted data. Its text, raw JSON and LLM fields are never
treated as Agent instructions, tool addresses or authorization metadata.

## 6. Serving and global-search boundaries

Different query intents use different contracts:

| Intent | Contract | Boundary |
| --- | --- | --- |
| Province hot/latest feed | `GET /api/v1/data/public-opinion/provinces/:province/items?sort=hot\|latest` | Requires an explicit supported province and the `public_opinion` grant. Returns only records with accepted explicit province data. |
| Click-through detail | `GET /api/v1/data/public-opinion/items/:id` | Same grant; returns the allowlisted title, summary, URL, time, province, heat and origin fields. |
| Text retrieval in this corpus | `POST /api/v1/data/stored/search` with explicit `platform=public_opinion` | Uses the common search shape, but remains one authorized platform per request. It is not a province-hot ranking API. |
| Admin audit | Data Center/import evidence | Admin Token only; may show raw, revision and lineage that public APIs cannot expose. |
| Cross-source global search | Existing `POST /api/v1/data/canonical/search` | Searches one shared canonical projection constrained by the caller's platform grants. Results are classified by existing platform/dataset/objectType fields; it does not compare source-specific heat scores. |

The dedicated province endpoint is the initial product API because its ranking
and missing-province behavior are well-defined. The common stored-search API is
for text retrieval, not for silently merging heterogeneous heat scores.

The existing canonical global-search contract keeps the authorization platform,
dataset and object type separate. A future geography/classification extension
must additionally keep these dimensions separate:

- Hub authorization platform (`public_opinion`, `telegram`, and so on);
- logical dataset and object type;
- original content source/platform/type;
- factual geography such as `admin1_code`;
- derived content taxonomy plus its version and evidence.

The first phase does not add `provinceCode` or heat to the canonical-search
request/response shape. Clients use the returned canonical `id` with the
dedicated item-detail route. A later geography filter must be allowlisted,
cursor-bound and applied identically in PostgreSQL and Elasticsearch. It must
not expose raw `extensions`, accept arbitrary search DSL, infer access from a
source tag, or turn an unreviewed Agent label into a public filter.

## 7. Future classification/archive extension point

“Archive” here means a versioned derived classification attached to preserved
source/revision evidence. It does not mean moving, deleting or rewriting the
raw source object, and it is not a cold-storage or retention feature.

The current phase deliberately adds **no classification-assertion migration,
Agent writer, classification job, scheduler, route or projector**. It only
reserves the following future append-only assertion contract in the design:

```text
assertion_id
record_id
source_revision
field_key                 # initially province or source classification
proposed_value
method                    # source, rule, agent or manual
confidence
evidence_refs
taxonomy_version
rule/model/prompt_version
status                    # proposed, accepted, rejected or superseded
created_at / decided_at / decided_by
```

An assertion is anchored to the source revision it classified. A new source
revision never inherits a stale assertion invisibly. Corrections append a new
assertion and supersede the old one; they do not update history in place.

Preferred ownership remains upstream: when Night-All later identifies a
province or source, it writes the factual field and advances `updated_at`, and
the Hub ingests a new revision. If a future Hub Agent assists, it may create a
reviewable proposal only. It cannot write the upstream row, approve its own
proposal, alter canonical identity/deduplication, advance/reset an ingest
checkpoint, activate a source or grant a consumer.

Only accepted assertions may later feed a separate governed classification
projection. Until that projection has a migration, writer, review workflow and
rebuild tests, canonical `admin1_code` remains `NULL`. `unknown` is a valid
outcome and is never a prompt to guess.

## 8. Explicit non-actions for this phase

Completing the repository work does not authorize any of the following:

- deploy Hub services or run a migration Job in an environment;
- run the online Hub serving-index operation against any environment;
- enter or retrieve upstream database credentials;
- test or connect to the Night-All database;
- alter `monitor_strategy_results` or install upstream DDL;
- activate the source, schedule a pull, reset a checkpoint or import data;
- create a `public_opinion` consumer grant;
- add an Agent classification table, writer, queue, model call or background
  task;
- change MX-H2I login/networking or restart Launcher components.

The operator may consider onboarding only after the upstream watermark/writer
contract is implemented, the source owner supplies evidence, the public field
allowlist is reviewed, the online Hub indexes are separately installed and a
deployment is separately approved.

## Related decisions

- [Managed data sources and change watermarks](../adr/0007-managed-data-sources-and-change-watermarks.md)
- [Open capabilities, file rules and bounded classification cost](../adr/0008-open-capabilities-file-rules-and-classification.md)
- [Authoritative data and rebuildable search projections](../adr/0005-authoritative-data-and-search-projections.md)
- [Idempotent ingestion and independent checkpoints](../adr/0006-idempotent-ingestion-and-checkpoints.md)
- [Unified canonical search](../adr/0009-unified-canonical-search.md)
- [Shared data plane and search](shared-data-plane-and-search.md)
- [BI and Data Agent evolution](bi-and-data-agent-evolution.md)
