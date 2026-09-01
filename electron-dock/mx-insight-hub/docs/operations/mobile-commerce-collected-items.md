# Mobile-commerce collected-items ingestion

Status: implemented fixed contract, installed paused by default. This document
records the evidence and activation gates for a PostgreSQL table shaped like
[`spec_docs/mb_collected_items.csv`](../../spec_docs/mb_collected_items.csv).
The Hub migration installs the fixed source and mapping candidate; it does not
seed a public grant or claim that the external mobile collector is connected.

## 1. Scope and ownership

The source is a continuously appended mobile-collection result table containing
items from several commerce applications. The collector performs its own first
classification; MX Insight Hub preserves that evidence, maps the marketplace to
the governed source catalog, normalizes a bounded commerce record and serves
only reviewed stored fields.

Use these stable logical dimensions:

- dataset: `mobile-commerce.collected-items.v1`;
- authorization platform: `mobile_commerce`;
- object type: `commerce_capture`;
- source locator: one reviewed schema/table contract, initially expected to be
  `public.mb_collected_items`;
- identity scope: the fixed source key plus dataset/platform/object contract;
  v1 requires source `id` values never to be reused for that contract's entire
  lifetime.

`mobile_commerce` is the access-control dimension because current public API
keys grant platforms, not individual catalog entries. 快手、抖音、淘宝 and 闲鱼
remain classification/catalog facets and optional query filters; a filter must
never grant access. If marketplace-specific authorization is needed later, it
requires an explicit new grant/capability design.

The source may refer to an optional database-connection profile or keep a
complete inline connection as defined by [ADR-0007](../adr/0007-managed-data-sources-and-change-watermarks.md).
The profile owns only transport and credentials. The external source and its
cleaning plan own the schema/table locator, cursor, mapping, schedule, quality
policy and run evidence. A fixed SQLite or custom HTTP adapter is not forced
through this profile model.

## 2. Evidence from the supplied sample

The CSV contains five rows and 25 columns. It is useful shape evidence, not
proof of production constraints or of a safe incremental writer.

| Source column | Sample evidence | Governed interpretation |
| --- | --- | --- |
| `id` | `4`–`8`, present in 5/5 | Required immutable source-row key and cursor tie-breaker. Under the fixed dataset it is the capture identity, not a marketplace product ID. |
| `platform` | `快手小店`, present in 5/5 | Preserve raw label, then map to a reviewed source-catalog entry. Do not use raw spelling as authorization. |
| `task_run_id` | null in 5/5 | Optional collector-run lineage; private operational field, not canonical identity. |
| `task_id` | `7`, present in 5/5 | Collector task lineage; private by default. |
| `keyword` | `老爸评测`, present in 5/5 | Monitoring query/campaign evidence; not necessarily a product keyword. |
| `brand` | `老爸评测-日常监测`, present in 5/5 | The sample looks like a campaign name, not a verified product brand. Keep as ambiguous extension until separately resolved. |
| `title` | Product-like Chinese text, present in 5/5 | Candidate normalized product title and searchable content. It is not a stable entity key. |
| `product_link` | Share sentence with price and app-opening token, present in 5/5 | Preserve raw restricted text. It is not a URL; parse a share token or URL only into a typed optional field after validation. |
| `shop_name` | Display text, present in 5/5 | Candidate seller display name. Preserve conflicts rather than silently choosing one value. |
| `shop_link` | “复制整段消息…” share text, present in 5/5 | Not a URL. Retain raw text and extract a typed token/URL only when format validation succeeds. |
| `goods_id` | null in 5/5 | Optional marketplace product ID. When nonempty and format-reviewed, it may support product-entity resolution; absence must not trigger title-based merging. |
| `shop_id` | null in 5/5 | Optional marketplace seller ID; typed only after format review. |
| `price` | `10.4`–`38.63`, present in 5/5 | Candidate nonnegative decimal CNY observation. Preserve raw precision and reject invalid/negative values. Currency is a source-contract assumption, not inferred per row. |
| `sales` | `已售181件` in 1/5 | Localized sales text. Preserve raw value and, when grammar is known, extract numeric count plus qualifier; do not turn missing values into zero. |
| `ship_from` | Delivery promises in 3/5 | Semantically drifted: values such as `48小时内发货` are delivery SLA, not geography. Map to `shippingText`, not a location field. |
| `shop_level` | null in 5/5 | Optional source-specific seller level; preserve raw taxonomy until a controlled vocabulary exists. |
| `shop_fans` | `5`–`14000`, present in 5/5 | Candidate nonnegative follower-count observation, not an immutable seller attribute. |
| `shop_reputation` | `销量`, `销量; 好评率98%`, etc., present in 5/5 | Mixed free text containing several concepts. Keep raw; extract typed assertions individually with provenance. |
| `comment_count` | null in 5/5 | Optional exact count. Missing is unknown, not zero. |
| `good_rate` | null in 5/5 | Optional exact normalized rate. Text embedded elsewhere remains a parsed assertion, not this source column. |
| `tags` | Chinese-delimited merchandising text, present in 5/5 | Preserve raw string. Split only by a versioned grammar; punctuation inside product text must not be treated as a universal delimiter. |
| `collected_at` | `2026-07-27 14:58:52` etc., present in 5/5 | Source collection time and proposed watermark. Naive values are interpreted as `Asia/Shanghai` and normalized to UTC internally. |
| `metadata_json` | `{}` in 5/5 | Bounded JSON object for reviewed extensions. Validate size/type and scan for credentials, tokens and personal data before retention/publication. |
| `device_serial` | null in 5/5 | Sensitive collector/device identifier. Restrict to operational evidence when needed; never publish or use as a business identity. |
| `is_reported` | `0` in 5/5 | Upstream delivery state. Keep private; it is neither a Hub checkpoint nor a delete/publication flag. |

The sample also exposes concrete quality risks:

- seven columns are entirely null: `task_run_id`, `goods_id`, `shop_id`,
  `shop_level`, `comment_count`, `good_rate` and `device_serial`;
- `sales` is populated in one of five rows and `ship_from` in three of five;
- row `id=5` says `shop_name=烧烤解馋零食`, while its share text and tags name
  `泰酷辣食品`; this must produce conflict evidence, not an arbitrary overwrite;
- `product_link` and `shop_link` are share payloads rather than navigable URLs;
- `shop_reputation` mixes sales, good-rate and fulfillment claims, while tags
  mix names, option text, prices, promotions and fulfillment;
- the current five-row sample contains only 快手小店, so it does not validate
  schemas or extraction grammars for 抖音、淘宝 or 闲鱼.

Activation needs a larger structural sample, per-column null/type/length/cardinality
profiles, representative rows for every marketplace, malformed/oversized JSON
cases and a reviewed drift policy. The v1 runtime fails closed on any change to
the exact 25-column set and on incompatible identity/watermark types. For the
fixed mobile adapter only, legacy nullable declarations on writer-required
columns follow the guarded `mobile-commerce.writer.v3` exception described
below; actual NULL values still fail closed. Writer v3 also has one narrow
physical-type compatibility path for this fixed adapter: `collected_at` may be
`text` or `varchar` only when every value is exactly
`YYYY-MM-DD HH:mm:ss`. Other column-type profiles remain reviewed activation
evidence until a full schema digest is persisted; an operator must pause
promotion when those types change. No drift flows automatically into public
extensions.

## 3. Identity, cursor and writer contract

### 3.1 Capture identity

The immutable captured observation identity is `id` under the fixed
`mobile-commerce.collected-items.v1` dataset/platform/object namespace. The v1
pipeline does not expose an operator-selectable generation field, so the writer
must never reuse an ID for the lifetime of that contract. A server/database/table
replacement, truncate-and-reload, ID-sequence reuse or correctness-contract
replacement must provision a new source/dataset contract (or first add a
durable source-generation design) and requires explicit checkpoint review; it
must not silently continue the prior checkpoint.

This identity deliberately represents one captured row, not a deduplicated
product. `goods_id`, when stable and nonempty, can link captures to a separate
marketplace product entity. `shop_id` can similarly link a seller entity.
Title, price, shop display name, task position and page position are not safe
entity keys. Probabilistic/Agent matches are reviewable assertions and may not
change the capture's identity.

### 3.2 Proposed append-only cursor

The first plan may use keyset pagination on `(collected_at, id)` only after all
of the following are proved:

1. `id` is non-null, unique, immutable and never reused for the lifetime of the
   fixed dataset contract.
2. `collected_at` is non-null and immutable. A PostgreSQL `timestamp` or
   `timestamptz` is supported. The fixed mobile adapter additionally accepts
   `text`/`varchar` only when the source value itself is exactly 19 characters
   in `YYYY-MM-DD HH:mm:ss`: no `T`, UTC offset, fractional seconds or
   surrounding whitespace. Naive values are interpreted in `Asia/Shanghai`;
   Hub stores/serves the normalized UTC instant and retains the exact textual
   value as its source checkpoint.
3. Rows are append-only: no relevant update, hard delete or backfill occurs
   after the cursor passes. Absence from a page is never a delete.
4. The writer assigns or attests `collected_at` so commit ordering cannot place
   a later commit at or behind the acknowledged cursor. A mobile-device event
   time alone does not satisfy this rule.
5. PostgreSQL has a ready and valid unique index on `id` that supports both the
   capture-identity claim and the total ordering of `(collected_at, id)`.

A ready B-tree index beginning with `(collected_at, id)` is strongly
recommended for timestamp source-query performance. Text/varchar mode instead
uses C-collation ordering and recommends
`((collected_at COLLATE "C"), id)`. These indexes are not correctness
prerequisites when a unique `id` index already proves the total order. Their
absence is reported as an activation warning because PostgreSQL may otherwise
scan or sort the source table. Likewise, the fixed source may declare `id`,
`platform`, `title` or `collected_at` nullable in DDL only after an operator
accepts the current `mobile-commerce.writer.v3` contract that commits to
non-null values. The Hub reports that DDL mismatch as a warning and applies a
runtime NULL/format guard inside every pull statement. If a required value is
NULL, or a textual timestamp is not exactly valid, that batch fails closed
before canonical import or checkpoint advancement, even when the bad row is
behind the current checkpoint. The guarded compatibility branch can add source
scan/sort work; the upstream owner should ultimately migrate `collected_at` to
`timestamp without time zone NOT NULL` and add a ready, valid
`(collected_at, id)` index when practical.

For timestamp columns, the reader orders and resumes strictly with:

```sql
WHERE (collected_at, id) > ($1, $2)
ORDER BY collected_at ASC, id ASC
LIMIT $3
```

For text/varchar columns, the equivalent tuple comparison and ordering use
`collected_at COLLATE "C"`. Because Writer v3 permits only one fixed-width
representation, this bytewise text order is identical to source-local
chronological order and to the order after applying the fixed `+08:00` offset.
The generic database-source connector does not inherit this textual-cursor
exception.

It advances the durable checkpoint only after raw/source-object, canonical,
revision and projection-outbox writes commit in Hub PostgreSQL. Replays reuse
the same run/batch evidence. The upstream `is_reported` column is ignored for
checkpointing and is never modified by Hub.

If the collector can update/delete rows, reuse IDs, backfill an earlier
`collected_at`, or commit out of order, the plan must stay paused. The remedy is
an ordered source-side change journal/CDC position or an immutable writer-owned
ingestion sequence—not a polling overlap that only makes data loss less likely.
Generation changes and any reset/full alignment require the standard
pause/drain/probe/explicit-confirmation gates from ADR-0007.

## 4. Catalog and classification mapping

Normalize a source platform label with Unicode NFKC plus trimmed whitespace,
then resolve only an exact canonical name or reviewed alias from the active
catalog revision. Unknown/ambiguous labels are quarantined or proposed for
review; an Agent must not create a catalog entry or silently choose one.
Each pull page reads one authoritative PostgreSQL catalog snapshot; the
compiled seed is only a bootstrap/default for isolated mapping tools. A catalog
mapping change requires a governed replay before older canonical/ES rows can
carry the new entry revision.

| Raw or accepted label | Governed catalog entry | Major category / scenario | Notes |
| --- | --- | --- | --- |
| `快手小店` | `source-catalog-0063` / 快手小店 | 国内电商与本地生活 / 内容电商 | Exact canonical name. |
| `抖音小店` | `source-catalog-0062` / 抖音电商 | 国内电商与本地生活 / 内容电商 | `抖音小店` is the reviewed alias; retain the original label. |
| `淘宝` | `source-catalog-0058` / 淘宝 | 国内电商与本地生活 / 综合电商 | Do not infer 天猫 without source evidence. |
| `闲鱼` | `source-catalog-0073` / 闲鱼 | 国内电商与本地生活 / 二手交易 | Chat/order/private seller data require separate authorization and are outside this public product-item plan. |

Each normalized record retains the raw platform label, resolved catalog entry
ID/source key, catalog revision, resolution method and confidence. Catalog
classification does not automatically change catalog coverage/delivery status,
activate a connector or grant a consumer. Product category is a separate facet
derived from reviewed source fields/taxonomy; it must not be confused with the
marketplace catalog entry.

## 5. Data layers and mapping policy

Use four explicit layers instead of forcing every uncertain source value into a
flat public schema:

1. **Restricted raw** keeps the exact approved source row and import lineage for
   replay, drift investigation and later remapping. Access is Admin/worker only.
2. **Bounded internal evidence** retains ambiguous but useful fields such as
   the producer's `brand`, raw share payloads, mixed reputation text and
   versioned parsing assertions. It is schema/size allowlisted, not a public
   dumping ground; share payloads are consumed before generic extensions or ES
   text projection.
3. **Typed commerce** stores stable observations: marketplace catalog entry,
   title, validated product/seller IDs, decimal price and currency, seller
   display name, parsed sales/comments/follower/good-rate values with raw text,
   shipping text, campaign keyword/task lineage, capture time and parsing
   provenance.
4. **Canonical/public** represents the immutable commerce capture and only its
   reviewed allowlisted fields. Optional product/seller entities and temporal
   product observations are separately resolved; they never replace raw capture
   lineage.

Prefer deterministic mapping and parsers for this fixed source. Every parsed
value carries the raw value, parser/mapping version and confidence/error state.
Unknown values remain unknown; do not manufacture zeroes, URLs, product IDs,
brands or locations. A public projection must exclude connection/profile data,
raw rows, `metadata_json`, device identifiers, task/run internals, upstream
delivery flags, share tokens and unreviewed extensions.

## 6. Privacy, secrets and retention

Treat source credentials and profile records as secrets under ADR-0007. Also
treat `device_serial`, task/run identifiers, share/open-app tokens and arbitrary
`metadata_json` contents as restricted operational data. URLs or text may embed
account IDs, tracking tokens, phone numbers or collector/session material even
when the sample does not show them.

Before activation, define raw/evidence retention, deletion/legal-hold policy,
field-level log redaction and support-bundle exclusions. Publish only public
product/shop facts allowed by the source-catalog handling boundary. 闲鱼 chat,
orders, settlement, real-name data, private seller information and any
customer-supplied screenshots require a separately documented lawful purpose,
authorization and data-minimization review; they are not admitted by this plan.

## 7. Public stored-only surface and future refresh

The first external capability is **stored-only**. This describes the absence of
a remote mobile-collector command and does not disable PostgreSQL table
cleaning. After activation and an
explicit `mobile_commerce` platform grant, callers use
`GET /api/v1/data/mobile-commerce/items`. The dedicated response contract is
`mx-insight-hub.data-products.mobile-commerce-items.v1`; it exposes only the
reviewed capture/product/shop/signals allowlist and the governed marketplace
facet. `catalogEntryId`, source label, collector task labels and collection-time
filters only narrow results and never grant access.

Callers that also have the `source_catalog` grant may use
`GET /api/v1/data/source-catalog/{id}/items`. P1 dispatches that catalog UUID to
the same mobile-commerce data product, so the 快手、抖音、淘宝 or 闲鱼 directory
entry can show its classified stored rows without changing the top-level
authorization platform. The Admin catalog related-data view uses the same
stable catalog-entry relationship rather than comparing `mobile_commerce` to a
marketplace display name.

Every accepted row is committed through canonical/revision/outbox storage. The
ordinary projector then sends current truth to Elasticsearch, so
`POST /api/v1/data/canonical/search` can search the dataset with
`platform=mobile_commerce`, `datasetId=mobile-commerce.collected-items.v1` and
`objectType=commerce_capture`. PostgreSQL remains authoritative and ES remains
rebuildable. Public requests never name a profile, table, SQL, index or DSL.
Empty/stale stored results are reported truthfully, and a public read never
contacts the collector as an implicit side effect.

The future remote service is a separate, unpublished adapter contract executed
by an external mobile-collector machine/platform, not by the Hub process. Hub
will own only the asynchronous command, job status, ingest and data APIs. Reserve
an asynchronous refresh capability such as
`mobile_commerce.remote_refresh.create`, protected by a non-default grant,
idempotency key, quota, audit and bounded job status. The server owns the
allowlisted endpoint and secret; callers cannot supply a URL, token, Provider or
arbitrary remote parameters. A refresh returns `202`/job evidence, ingests
through restricted raw and the same approved mapping/quality gates, commits the
new canonical revision, and only then makes it visible to stored reads. Define
timeouts, retry/backoff, upstream pagination/cursor, deduplication, rate limits,
last-good behavior and cancellation before exposing that capability. Until the
remote team supplies and passes this contract, no remote route is advertised.

## 8. Agent use and experience capture

An Agent may propose mappings for ambiguous source values, marketplace/product
taxonomy, brand candidates, share-text parsing and field-drift explanations. It
must work from a source-revision-fenced batch, return structured assertions with
evidence/confidence and route low-confidence or novel cases to review. Batch or
cluster repeated shapes; do not spend one model call per row when a deterministic
rule is available.

The Agent may not decide source identity, cursor advancement, deletion,
authorization, catalog status, mapping approval or public publication. Those are
deterministic control-plane decisions. Promotion requires a reviewed gold set
covering each marketplace, precision/coverage/error thresholds, cost/latency
evidence, prompt/model/parser versions and a reversible release.

For this and later sources, the durable Agent Studio/source-experience record
should capture:

- producer and physical-source contract, generation rules, writer guarantees,
  cursor/index/delete semantics, timezone and sample window;
- field dictionary, null/type/length/cardinality profiles, sensitive fields,
  raw examples, drift history and unresolved conflicts;
- deterministic mapping/parser versions, catalog/taxonomy revisions and the
  boundary between raw, extensions, typed fields and public allowlist;
- Agent inputs/outputs, evidence anchors, confidence, review decisions, gold-set
  metrics, failures, cost/latency and release/rollback version;
- run/checkpoint/rejection/page-fingerprint evidence, freshness/SLO, replay and
  incident outcomes;
- public authorization/filter/response contracts, retention and audit policy,
  plus any future remote endpoint's pagination, idempotency and last-good
  behavior.

These records turn source-specific work into reusable evidence without assuming
that a future generic Agent can safely infer identity or incremental semantics
from field names alone.

Agent Studio now publishes the authoring-only template
`mobile-commerce-data-processing`. It encodes these identity, timezone,
classification, minimization, lineage and human-review boundaries in a
compile-only mapping-proposal graph. The fixed deterministic mapping and normal
canonical/ES projection remain the production path; the template cannot import,
publish, approve mappings or run remote acquisition.

## 9. Activation and isolation checklist

Keep the source paused until all of these are complete:

- connection/profile candidate is read-only-probed without logging secrets;
- the fixed v1 source uses an explicit host/database transport (inline or
  shared profile), not `dsnEnv`, whose target could change without checkpoint
  identity evidence;
- table shape, exact 25-field mapping, fixed source/dataset identity,
  no-ID-reuse guarantee and larger samples are reviewed;
- append-only writer attestation, `Asia/Shanghai` interpretation and unique
  `id` identity index pass, or an ordered journal replaces that cursor; legacy
  nullable DDL and the narrow exact-text cursor are accepted only with the v3
  attestation and per-statement NULL/format guard, while any actual required
  NULL or malformed timestamp fails closed; the recommended timestamp
  `(collected_at, id)` or text/varchar
  `((collected_at COLLATE "C"), id)` pull index and upstream `NOT NULL`
  constraints may be added later to remove the explicit source-query
  performance warnings and guarded-scan overhead;
- mapping version, public allowlist, catalog revision, quality thresholds,
  retention and grants are approved;
- replay/idempotency, malformed rows, timestamp ties, late commits, table
  replacement/ID reuse rejection, pause/drain/reset and stale stored reads are
  tested;
- public route documentation advertises only what is actually deployed.

This pipeline is owned by MX Insight Hub's data plane. It must not change MX
Launcher/MX-H2I authentication or existing user connectivity, including
Domestic/Internal routing, WireGuard and DNS. Source/profile management remains
Admin-only and does not broaden Launcher-login session authority.

`syncIntervalSeconds` is runtime scheduling policy for every cleaning plan.
Saving only that field is allowed while a plan is active, running or draining;
it does not cancel the current/queued batch. The scheduler rereads the stored
value on its next scan and recalculates whether the source is due. Connection,
table, mapping and checkpoint-contract changes retain their pause/drain/probe
gates.
