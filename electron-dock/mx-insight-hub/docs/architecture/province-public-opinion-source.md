# Nationwide province public-opinion source

Status: repository contract plus paused ingest/classification/publication-state
implementation; intentionally not connected or deployed.

This document defines the bounded Hub contract for the Night-All
`public.monitor_strategy_results` table. The immediate product goal is to serve
province-specific hot/latest opinion items and item detail without weakening
the existing external-source, lineage or public-authorization boundaries.

It is not an instruction to connect a database, deploy the current branch,
activate either pipeline, grant a consumer or ingest the supplied sample. Those
remain separate operator decisions after the source contract has been proven.
The corresponding step-by-step procedure is
[Nationwide province public-opinion operations](../operations/province-public-opinion-ingestion.md).

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

Night-All owns collection, normalization, source deduplication and the source
table writer. It uses the existing `monitor_strategy_results` table for both
historical/formal rows and normalized source candidates, distinguished by
`source_stage=formal|candidate`; it does not own candidate scoring or a public
candidate API. MX Insight Hub owns source registration, raw/canonical/revision
lineage, revision-fenced publication state, quality scoring, search indexing,
coverage and all external APIs. Neither side may infer that ownership of one
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

The historical table contract has an immutable primary-key `id`, but did not
provide a reliable change watermark. `created_at` only describes the initial
insert and cannot reveal a later correction to `province`, source metadata,
heat or LLM output. It must never be used as an incremental cursor.

The Night-All repository now contains
`migrations/042_monitor_strategy_results_hub_watermark.sql` as the intended
upstream implementation. It backfills a finite `updated_at`, makes it non-null,
validates the finite-value constraint, creates `(updated_at, id)`, rejects ID
changes, and installs a `BEFORE INSERT OR UPDATE` trigger. The trigger holds a
transaction-scoped advisory lock through commit and atomically advances a
single-row watermark state to at least its previous value plus one microsecond.
That avoids stale `max(updated_at)` reads: a stale REPEATABLE READ/SERIALIZABLE
writer must serialization-fail and retry rather than publish an old watermark.
Night-All's migration baseline also forces 042 to run rather than inferring it
from a partial legacy schema.

Night-All migration `043_monitor_strategy_result_source_stage.sql` is additive:
it adds `source_stage` with `DEFAULT 'formal'`, optional
`source_disposition`, and a stage/cursor index. Existing rows and old Hub
writers therefore remain formal. Candidate writing is separately feature
gated and must stay disabled until the Hub publication gate has been deployed
and every Night-All reader instance understands `source_stage`.

This is repository evidence, not deployment evidence. Before Hub activation,
042 and 043 must be executed on the target Night-All PostgreSQL, checked against real
rows and the normal writer path, and then attested using the contract digest
returned by the current Hub probe. Static/domain tests passed in the Night-All
repository, but no real PostgreSQL execution has yet been evidenced.

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

Migration 042 deliberately does not install a blanket DELETE blocker because
that would also alter the existing parent-table cascade and cleanup behavior.
The deletion guarantee therefore remains an explicit deployment attestation:
operators must audit cleanup jobs, table privileges and cascade paths, and keep
the pipeline paused if they cannot prove this condition.

A column name and index alone are insufficient: the source owner must attest to
the writer behavior. The Hub's read-only probe verifies the visible schema,
nullability, types and index, but it cannot prove application commit semantics.
If those semantics cannot be guaranteed, the correct adapter is a future
append-only change journal or CDC connector—not a timestamp guess.

Routine Hub ingest must not create the upstream column, trigger or index. The
source remains paused until the target Night-All database has deliberately run
042, an operator has reviewed real-database and writer-path evidence, and the
current Hub contract digest has been attested. The presence of a migration file
or a baseline entry cannot satisfy those gates.

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
rows in `(updated_at, id)` order. The batch transaction preserves:

- the exact upstream row as the current source object plus an immutable raw
  source revision;
- the reviewed mapping/import-run identity;
- the canonical record and immutable revision when content changed;
- projection-outbox work;
- source-revision-anchored analysis work; and
- committed batch evidence including its exact cursor end.

Checkpoint acknowledgement is a second durable phase after the batch commit;
the final batch atomically finalizes the import run and cursor. A crash after
the batch commit but before acknowledgement is recovered by reading the stored
batch evidence and advancing to its saved cursor end without trusting a page
that may since have drifted upstream. A failure before commit leaves the last
acknowledged checkpoint intact. Retry resumes the same run/batch evidence; it
does not create a second logical initial import.

This is a current-table alignment, not proof that previously hard-deleted rows
never existed. Deletion history requires the source contract described above.

### 4.2 Later runs: strict change-watermark traversal

After the initial alignment, every scheduled or manual pull reads only rows
strictly greater than the durable `(updated_at, id)` checkpoint. There is no
periodic historical full scan and no overlap window used to hide an unsafe
watermark.

An unchanged replay is absorbed by canonical identity and revision hashes. For
this fixed source the raw identity excludes transport/run coordinates such as
`updated_at`, `run_id`, the candidate envelope's Agent run ID and province
recall retrieval timestamps. Those values remain in current raw/lineage, but a
coordinate-only upsert does not create a new evidence revision or paid analysis
task. Candidate stage, disposition, content, evidence and scores remain
semantic. A rejected row or
ambiguous commit must not advance the checkpoint. Resetting the
checkpoint requires the source to be paused and drained plus an explicit
operator confirmation; reset is a controlled full replay, not a normal retry.

The source state, import-run state and cursor state remain separate. A healthy
connection is not evidence that incremental synchronization is safe:

| Layer | States |
| --- | --- |
| Source | `paused`, `active` |
| Import run | `running`, `succeeded`, `failed`, `skipped` |
| Cursor | `idle`, `running`, `failed` |
| Raw source revision | current pointer plus append-only semantic-payload-change revisions |
| Projection outbox | `pending`, `delivered`, `dead` |
| Analysis task | `pending`, `running`, `succeeded`, `dead`, `superseded` |
| Classification assertion | `proposed`, `accepted`, `rejected`, `superseded` |
| Publication state | `formal`, `pending`, `qualified`, `rejected`, `failed` |

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
promise that every province currently has data. Event province, publisher or
dateline province and display province remain separate. A trusted China News
Beijing dateline may provide a low-confidence display fallback only when no
better event location exists; it is not counted as verified event geography.
Foreign events keep `province=NULL` and use bounded country/location/geo-scope
fields instead of being forced into a Chinese province.

### Heat

`heat_score` is a numeric serving field. The province hot feed includes records
with a non-null score, orders it descending and uses an internal effective sort
time plus record identity as stable tie-breakers. The latest feed orders by that
effective time, collection time and identity and does not require a heat score.
Effective sort time is the factual `publishedAt` when present, otherwise
`collectedAt`; the fallback is never returned as `publishedAt`. Formal-only
`from`/`to` requests retain the historical factual `publishedAt` semantics.
Only an explicitly requested candidate view uses `collectedAt` when a candidate
has no publication time, so an undated audit item remains reachable inside a
bounded window.

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
| Province hot/latest feed | `GET /api/v1/data/public-opinion/provinces/:province/items?sort=hot\|latest` | Requires an explicit supported province and the `public_opinion` grant. Defaults to formal-only; `includeCandidates=qualified|all` is explicit and cursor-bound. |
| Province coverage | `GET /api/v1/data/public-opinion/province-coverage` | Requires `from` and `to`; returns all 34 province-level regions, up to eight featured codes, quality/verified counts and a target shortfall. The default target of 10 is a coverage goal, never fabricated data. |
| Click-through detail | `GET /api/v1/data/public-opinion/items/:id` | Same grant; defaults formal-only. Candidate detail requires an explicit candidate mode and returns only bounded Hub-owned quality/location metadata. |
| Text retrieval in this corpus | `POST /api/v1/data/stored/search` with explicit `platform=public_opinion` | Defaults formal-only. Explicit candidate filters support province/country/location and bounded time; upstream providers remain private. |
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

Candidate-aware stored/canonical search adds only allowlisted
`includeCandidates`, `minQualityScore`, `province`, `countryCode`, `location`,
`from` and `to` controls. PostgreSQL and Elasticsearch use the same publication
predicate and typed projection. Cross-platform search applies that predicate
only to `public_opinion` records. Candidate `all` requires a bounded time range
plus an exact geography selector. No mode exposes raw `extensions`, arbitrary
search DSL, upstream provider identity or unreviewed model reasoning.

## 7. Derived classification/archive plane

“Archive” here means a versioned derived classification attached to preserved
source/revision evidence. It does not mean moving, deleting or rewriting the
raw source object, and it is not a cold-storage or retention feature.

Migrations 034 and 035 implement the evidence and current-publication halves of
this contract:

- `ingest.source_object_revisions` keeps each semantic raw payload-change
  revision independently from canonical revisions, including A→B→A reversions;
  the fixed source's transport-only `updated_at` is retained but excluded from
  that digest so writer watermark churn does not re-run the Agent;
- pre-034 rows carry hash version 0 because their old digest represented
  canonical content. The first new pull compares old/new semantic JSONB before
  adopting hash version 1, so an unchanged legacy row is not fabricated as a
  second raw revision or paid task;
- `control.agent_analysis_pipelines` registers the default-paused
  `province-geography-v1` pipeline and its immutable analysis/taxonomy/rule/
  prompt versions;
- `agent_center.analysis_tasks` anchors work to raw source revision, canonical
  revision and input hash, with a single global in-flight claim, lease,
  generation fence, bounded retry and stale-input supersession;
- `agent_center.classification_assertions` keeps append-only source/rule/Agent/
  manual evidence.
- `core.public_opinion_current_state` keeps one revision-fenced serving decision
  per canonical record. Historical rows initialize as formal; candidates start
  pending, then become qualified, rejected or failed. The default qualification
  threshold is 80 and is independent from province-verification confidence.

The schema is:

```text
assertion_id
task_id
record_id
source_object_revision_id
canonical_revision
input_sha256
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

The dedicated classifier worker entrypoint runs deterministic rules first and
calls a bounded Chat Agent only for ambiguous geography. Event province,
publisher province and geographic scope are separate fields. Agent evidence
must quote the bounded input and its province/prefecture/adcode semantics must
match the returned code; a quote that merely exists cannot validate a different
province. Agent output always remains a proposal. The pipeline is
installed paused; adding records creates a durable backlog but never invokes a
model in the ingest transaction.

Mentions and physical event locations are also separate. A phrase such as
`部署台湾一线` creates a versioned, proposed
`geography.related_admin1_codes=[{admin1Code:"CN-TW",relation:"mentioned_area"}]`
assertion with source-text evidence; it does not deterministically create an
event province. A source name such as `人民网福建` may independently create
proposed publisher/report attribution `CN-FJ` with `basis=publisher_name`.
Neither proposal changes formal serving. Only a typed source
`report_attribution` with `basis=publisher_registry` plus a non-empty,
auditable `registryRef` or `sourceRef` is accepted as trusted report
attribution; merely putting the basis string in content is insufficient. A
later Agent result is not allowed to replace accepted report attribution.
Every deterministic attribution assertion records its rule version; changing a
pattern, confidence or relationship requires a new version. Because the
pipeline is paused by default, these assertions appear only after the pipeline
is explicitly enabled or its backlog is run.

An assertion is anchored to the source revision it classified. A new raw or
canonical revision supersedes stale pending/running work instead of inheriting
a conclusion invisibly. A correction appends a new source revision and new
assertion rather than rewriting raw history. The schema can represent a prior
assertion as `superseded`, but the current writer does not automatically decide
or update previously completed assertions.

Preferred ownership remains upstream: when Night-All later identifies a
province or source, it writes the factual field and advances `updated_at`, and
the Hub ingests a new revision. A Hub Agent may create a reviewable proposal
only. It cannot write the upstream row, approve its own proposal, alter
canonical identity/deduplication, advance/reset an ingest checkpoint, activate
a source or grant a consumer.

The repository currently has pipeline status/update/materialize/retry-dead and
read-only assertion APIs, plus a dedicated package script, Compose service and
K8s classifier Deployment with no Service or ingress. The pipeline is still
installed paused, and repository wiring is not evidence that any environment
has rolled it out. Completion materializes only a bounded, revision-fenced
publication decision and queues a fresh search projection; raw assertions and
provider evidence remain private and no model mutates canonical truth or the
Night-All row. `unknown` is a valid outcome and is never a prompt to guess.

The full activation, rate, recovery, review and HanLP boundaries are in the
[operations runbook](../operations/province-public-opinion-ingestion.md).

## 8. Explicit non-actions for this phase

Completing the repository work does not authorize any of the following:

- deploy Hub services or run a migration Job in an environment;
- run the online Hub serving-index operation against any environment;
- enter or retrieve upstream database credentials;
- test or connect to the Night-All database;
- alter `monitor_strategy_results` or install upstream DDL;
- activate the source, schedule a pull, reset a checkpoint or import data;
- create a `public_opinion` consumer grant;
- activate the analysis pipeline, start/deploy its classifier, configure a
  provider, retry dead analysis tasks or treat a proposal as approved;
- change MX-H2I login/networking or restart Launcher components.

The operator may consider onboarding only after Hub migration 035 and the
formal-only list/detail/search gates are deployed, content-v5 is rebuilt, then
Night-All 042/043 are executed and
verified in the target database, the source owner supplies writer-path evidence,
the current Hub contract digest is attested, the public field allowlist is
reviewed, the online Hub indexes are separately installed and a deployment is
separately approved. Classification additionally requires a
successful classifier rollout, provider/cost approval, raw-revision acceptance
tests and explicit pipeline activation; none is implied by applying migrations
034/035. Candidate writing must be enabled only after all Night-All readers have
been upgraded; a rolling old/new reader mix or a direct code rollback can expose
candidate rows as legacy formal results.

## Related decisions

- [Managed data sources and change watermarks](../adr/0007-managed-data-sources-and-change-watermarks.md)
- [Open capabilities, file rules and bounded classification cost](../adr/0008-open-capabilities-file-rules-and-classification.md)
- [Authoritative data and rebuildable search projections](../adr/0005-authoritative-data-and-search-projections.md)
- [Idempotent ingestion and independent checkpoints](../adr/0006-idempotent-ingestion-and-checkpoints.md)
- [Unified canonical search](../adr/0009-unified-canonical-search.md)
- [Shared data plane and search](shared-data-plane-and-search.md)
- [BI and Data Agent evolution](bi-and-data-agent-evolution.md)
- [Nationwide province public-opinion operations](../operations/province-public-opinion-ingestion.md)
- [Agent provider settings](../operations/agent-provider-settings.md)
