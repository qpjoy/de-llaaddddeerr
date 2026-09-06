# ADR-0013: Provider-neutral external data platform gateway

- Status: Accepted
- Date: 2026-09-03
- Scope: MX Insight Hub external data acquisition, public product-search contract, evidence and operations

This decision supersedes only the project-wide timing statement about deferred JustOne ingestion in
[ADR-0012](0012-hub-native-agent-studio.md). The Agent Studio boundary in that ADR is unchanged: JustOne is
not an Agent node, credential surface or control plane.

## Context

MX Insight Hub needs fresh external data without becoming a transparent API relay. A direct relay would
couple clients to a provider's endpoint names, response drift, continuation tokens and billing behavior. It
would also make it hard to distinguish Hub demand from provider calls that may incur procurement cost, archive the original evidence,
reuse exact fresh results, or explain why a stored result was returned.

The first native adapter is JustOne product search. The integration must coexist with existing Hub stored
search, Night-All compatibility and cleaning jobs. It does not own, replace or initialize Launcher,
SessionGate, MX-H2I login, WireGuard, DNS or user networking.

This ADR uses “provider-neutral” for the ownership and stability of the Public contract, not as a claim about
the number of deployed suppliers. At the review date, the runtime constructs one ecommerce provider adapter,
JustOne. There is no multi-provider router or cross-provider failover in the released implementation.

## Decision

### 1. Publish one Hub-owned product-search contract

The public surface is:

```text
POST /api/v1/data/ecommerce/products/search
contractVersion = mx-insight-hub.ecommerce-products.v1
authorization platform = ecommerce
```

The request allowlist is exactly `marketplace`, `query`, `deliveryMode`, `page`, `cursor`, `sort` and `price`. There is no
caller-controlled `pageSize`; result size is server policy. `page` and `cursor` are mutually exclusive.
The response contains normalized product, price, shop, image, signal and attribute fields plus
`capturedAt`, `servedAt`, `sourceMode` and `ageSeconds`. It never contains the JustOne identity, token,
endpoint URL, raw continuation or raw response.

JustOne endpoint names and shapes stay behind versioned adapter descriptors. A future external platform may
serve the same public route only when it can satisfy the same semantics and evidence requirements. An
incompatible request, product identity, pagination or freshness model requires a reviewed public contract
version rather than leaking provider-specific fields into v1.

### 1a. Keep authorization, marketplace and provider separate

- `ecommerce` is the Public platform grant, Hub quota and future customer-pricing scope;
- `ecommerce.products.search` is the internal name of the stable Hub operation;
- `taobao`, `tmall`, `jd`, `xiaohongshu_ec` and `xianyu` are caller-visible marketplaces;
- `justone` is the current internal provider and is neither a Public grant nor a request parameter.

A valid provider credential does not grant a consumer access. Conversely, an `ecommerce` grant does not
expose a supplier account or entitle the caller to select a supplier. Source-catalog connector hints record
planning/lineage evidence and do not create an executable route.

### 2. Keep acquisition separate from cleaning, but converge on canonical data

Realtime acquisition is presented under **数据清洗中心 → 外部数据平台** because it feeds the same data
plane, while remaining a separate workload from scheduled ETL/ELT tasks. The processing chain is:

```text
public Hub API
  -> authorization / quota / idempotency / exact cache / lease / circuit
  -> versioned JustOne adapter and response contract
  -> secret-free raw response + item archive
  -> PostgreSQL source objects / canonical records / observations
  -> transactional outbox
  -> Elasticsearch projection
```

The synchronous public response does not wait for Elasticsearch. PostgreSQL canonical state and lineage are
authoritative; Elasticsearch remains a rebuildable serving projection. Adapter or projection failure must
not change the already-committed public delivery evidence.

### 3. Preserve both call-level and item-level evidence

Every actual dispatch receives a `external_platform.provider_calls` row. Even an empty, rejected, malformed
or outcome-unknown response receives one secret-free `response_archives` observation, because item rows
alone cannot prove what happened to the provider call or its procurement cost. Valid items additionally receive `archive_objects` rows.

`archive_path` is a logical taxonomy, not a host filesystem path:

```text
justone/{marketplace}/product-search/{endpointVersion}/{YYYY-MM-DD}/{responses|items}/{sha256}.json
```

It is queryable today in PostgreSQL and may later become an object-store prefix without changing lineage.
The SHA-256 content key supports duplicate detection; `provider_call_id`, response pointer, marketplace,
endpoint version, source-catalog key and capture date preserve provenance. Raw observations are redacted of
tokens, credential-bearing fields and private URL parameters before persistence, but remain sensitive
internal evidence and are never a Public API response.

Canonical identity is `marketplace + native product id`, not query, page or rank. Repeating a search can add
an observation or revision without manufacturing a second product identity. The canonical dataset is
`ecommerce.products.v1`; source-catalog mappings provide the governed marketplace classification.

### 4. Make retry, pagination and duplicate suppression explicit

A caller-supplied `Idempotency-Key` names one immutable `path + normalized body` dispatch. The client reuses
the key for transport retries of that exact page. Reusing it with a changed request returns
`409 idempotency_conflict`. Every next-page request has a changed cursor/body and therefore must use a new
`Idempotency-Key`.

`deliveryMode` is deliberately excluded from the logical data fingerprint: it controls whether Hub may refresh
the same query snapshot, not which data was requested. Consequently, reusing a committed Idempotency-Key with a
different delivery preference replays the original result instead of converting it into a new dispatch.

When a caller omits the key, Hub derives a short-lived freshness-bucket key. This is a convenience and
duplicate guard, not a durable client replay contract. The gateway additionally holds an exact
consumer/operation/fingerprint dispatch lease so two concurrent requests with different `Idempotency-Key` values cannot both
launch the same provider call and multiply procurement cost. Quota, global concurrency, per-consumer concurrency and the provider circuit
bound faulty-client amplification.

The Hub cursor is consumer-scoped, authenticated-encrypted and bound to marketplace, query, sort and price.
Provider continuation state such as the JustOne Xiaohongshu EC `searchId` exists only inside that opaque
ciphertext. A client never sees, decodes or supplies it directly. Tampering or reuse by another consumer
fails closed. `nextCursor=null` ends traversal. `hasMore=null` means Hub cannot prove a safe next step and
the client must stop rather than incrementing `page`.

The current cursor state is implicitly JustOne because it is the sole provider. Before a second provider is
released, the next cursor-state version must also bind the internal provider key and adapter contract version.
Existing cursor state remains JustOne-compatible. Route-priority changes must not move an in-progress
pagination chain: if its pinned provider is unavailable, Hub serves an exact eligible snapshot or returns a
stable error rather than disclosing or forwarding its continuation to another supplier.

### 4a. Select future providers only before dispatch

A future router is deterministic for an `operation + marketplace` and chooses from a code-owned provider
registry. Provider hosts, paths and response contracts remain reviewed code; only secret-free enablement,
priority and revision may be operational configuration. Disabled, unverified, uncredentialed, unsupported or
circuit-open candidates may be skipped before a provider-call row or network request exists.

The first multi-provider phase retains one actual provider dispatch per Hub usage request. Once dispatch
begins, Hub must not change supplier after `billed=true`, `billed=null`, an unknown outcome or a successful but
unusable response. It uses exact stored fallback when permitted or returns the stable error. Cross-provider
retry after a definite unbilled rejection is a later decision requiring an ordered attempt ledger, an explicit
attempt/cost ceiling and new reconciliation tests; it is not inferred from an HTTP status alone.

### 5. Use exact fresh cache and exact stale fallback

Snapshots are keyed by consumer, operation and the complete normalized request fingerprint:

- `live` records a new successful provider call;
- `fresh_cache` serves an unexpired exact snapshot without a provider call;
- `stored_fallback` serves an exact last-good snapshot within the configured stale window when dispatch is
  unavailable, rejected, unusable, concurrency-guarded or circuit-open;
- `idempotent_replay` serves the immutable result already committed to the same caller-supplied `Idempotency-Key`.

The caller can constrain that state machine without naming a provider:

- `cache_only` returns only the exact retained snapshot, never enters provider readiness/concurrency/lease or
  dispatch, and returns `404 stored_snapshot_not_found` after releasing its usage reservation on a miss;
- `cache_first` is the backward-compatible default and follows the fresh-cache-first path above;
- `refresh` bypasses a pre-existing fresh snapshot, requires a caller-supplied Idempotency-Key, and attempts one
  governed dispatch; an exact retained snapshot may still be the fallback after pre-dispatch unavailability or
  dispatch failure.

There is no fuzzy-query, cross-consumer, cross-marketplace, cross-page, canonical-search or “similar item”
fallback. A stored delivery always exposes capture/serve time, age and source mode; stale fallback also
emits HTTP Warning 110. The failed attempt and delivered snapshot remain separate evidence.

An unusable successful response or an ambiguous network outcome may already have consumed provider quota.
Without a valid exact snapshot the request returns an outcome-unknown error and is never blindly
redispatched. Operators and clients retain the same request ID and `Idempotency-Key` while investigating.

Stored fallback is not provider failover. It reuses one exact Hub-owned response snapshot and preserves its
capture time and lineage; it never synthesizes a fresh-looking response by querying a second supplier after an
uncertain provider attempt that may have consumed quota or incurred procurement cost.

### 6. Separate Hub demand, actual calls and money

`gateway_requests` counts Hub demand. `provider_calls` counts actual dispatches. Cache hits, replay, fallback
without dispatch, duplicate suppression and circuit rejection are therefore measurable avoided calls rather
than fictitious provider traffic.

When more than one provider exists, Hub demand and cache/replay remain product-level metrics. A cache hit has
no honestly “avoided provider” unless an actual routing decision was durably made; it must not be attributed to
whichever supplier happens to be first today. Provider success, billing and cost use only real provider-call
evidence, and monetary totals remain grouped by currency.

Successful JustOne business code `0` is recorded as billed according to its documented usage semantics, but
money remains `costKind=unknown`, `costMinor=null` and `currency=null` unless an operator installs a reviewed
price book. Provider balance, free quota, reset time and price API availability are also unknown until
verified evidence exists. Unknown is never displayed or aggregated as zero.

Cost forecasts are permitted only when the reporting window has both measured actual-call volume and a
reviewed unit price/quota snapshot. “Stay inside free quota”, “recharge after daily free use” and monthly
recharge comparisons remain unavailable otherwise. Manual quota snapshots must record capture time and
source; a future provider quota API must write the same evidence model rather than bypass it.

### 7. Treat Figure 4 as a capability-gap inventory

The four “无等价接口” rows in Figure 4 do not all describe a JustOne defect and do not prove a Hub runtime
failure:

| Figure 4 capability | Decision |
| --- | --- |
| `search_intent` | This is an aggregation/orchestration intent, not necessarily a one-hop provider endpoint. Implement it only as a bounded Hub workflow over separately supported search contracts, with its own version and budget. |
| `search_post_detail` | A cross-platform capability gap. Each platform needs a reviewed adapter, identity rule and fixture before Hub can publish one stable detail contract. It is not YouTube-only and is outside ecommerce product-search v1. |
| `search_post_comments` | A cross-platform capability gap with independent pagination and amplification risk. Do not infer support from product search or a similarly named upstream route. |
| `youtube_channel_comments` | YouTube-specific composite semantics. A safe implementation needs channel-video traversal plus per-video comment pagination, checkpoints, dedupe and a strict work/cost budget; it is not expected to have a single equivalent endpoint. |

Until those contracts are implemented and tested, capability discovery and the console must report them as
unsupported or unknown. They must not be simulated from partial data or presented as JustOne coverage.

### 8. Promote governed data—not a provider relay—into Data Products

The **外部数据平台** page is the acquisition and operations view. A future entry under **数据产品** should
read the governed `ecommerce.products.v1` canonical dataset and present product coverage, marketplace,
freshness, quality and provenance filters. It must not call JustOne from the browser or define product
identity as “JustOne data”. Provider identity remains internal lineage so another verified platform can
contribute to the same product without changing the public product contract. If an Internal operator needs
a provider-specific slice, it is a lineage filter over the canonical product—not a second raw-provider
API or a duplicate dataset.

Product display paging is client presentation over one already-returned response and creates no Hub usage or
provider call. It may issue bounded media reads for newly visible products, but acquisition paging occurs only
through an explicit `nextCursor` request with a new `Idempotency-Key`. The two controls must not share a label or
silently trigger one another.

Normalized `images[]` are data references and are never assigned directly to `img src` in Admin. The Hub
safe-media relay accepts an authenticated consumer's committed search `requestId`, returned `itemId` and bounded
`imageIndex`, not an arbitrary URL. It retrieves only the recorded public HTTPS raster reference with pinned
validated DNS, redirect-by-redirect private-network rejection, no browser/provider credentials, and strict
redirect/time/body/content-type/signature limits. A media read creates no ecommerce usage record or
product-search/provider dispatch. It returns private Hub-origin bytes with defensive headers; failure falls
back to a neutral local icon without changing the original search evidence.

## Compatibility and isolation

- Existing `/api/v1/data/search`, canonical search, stored data products and three namespaced Night-All
  compatibility routes retain their contracts.
- External-platform readiness is independent from Hub, Launcher and MX-H2I login/network readiness.
- External ecommerce search and media require an ordinary `mih_live_` Hub Public API key plus the explicit
  `ecommerce` grant; this is not a second product key. A valid legacy Test key with that grant sees
  `ecommerce.ready=false` in capabilities, and both routes return `403 test_key_not_supported` before usage
  reservation, committed-result/media lookup or provider dispatch. Management analytics stay on the Internal Admin
  listener and retain the existing Hub Admin Token-only source-management boundary; Launcher sessions do
  not gain access from a membership alone.
- A missing ordinary Hub Public API key is `401 api_key_required`; invalid, expired or revoked is `401 invalid_api_key`;
  a valid key lacking `ecommerce` is `403 platform_not_granted`. The server-only provider key never enters
  Public authentication. Its absence or rejection becomes a sanitized external-platform availability or
  capacity error rather than instructing the caller to replace a valid Hub key.
- Provider secrets are either a public-process environment fallback or an isolated Admin-managed credential
  record. The public listener reads only the active JustOne credential required for dispatch. Ordinary
  management responses expose metadata only; plaintext can enter transient reveal-modal state solely after
  Admin Token reauthentication. Secrets never enter public documents, cursors, archives, canonical records
  or logs.
- The external-platform worker and ingest job use bounded queues and quotas; failure cannot block login or
  the serving of already-stored Hub data.
- A browser ledger left ambiguous by an older Test-key workbench is retained only as a locked body,
  `Idempotency-Key` and credential fingerprint for operator reconciliation. The current page does not validate or
  replay it and never substitutes a Live key. The record does not freeze business filters or block local safe-demo
  and `cache_only` reads; it blocks only another provider-capable request until exact recovery or reconciliation.

## Consequences

Positive:

- clients receive one stable, provider-neutral contract and observable freshness;
- retries, page navigation and concurrent duplicates do not silently multiply provider calls or procurement cost;
- raw evidence, canonical data and actual cost/demand measurements remain connected;
- additional external platforms can be compared without making their schemas public API contracts.

Costs:

- every provider shape change needs a fixture and adapter review;
- exact caching deliberately misses semantically similar requests;
- money and quota forecasts remain unavailable until price evidence is reviewed;
- raw evidence and canonical projections add storage, retention and operational work.

## Acceptance gates

- Public OpenAPI and narrative docs contain no JustOne identity, secret or upstream URL.
- Test-key ecommerce capability discovery is not ready, and search/media reject before usage, store/media or
  external I/O; the Admin workbench sends no Test-key request.
- Runtime/UI copy identifies the current topology as one JustOne provider and does not advertise automatic
  provider failover.
- Request schema rejects unknown fields and `page + cursor`; it contains no `pageSize`.
- Every next-page example uses a new `Idempotency-Key` and returns only the opaque Hub cursor.
- Before another provider is enabled, cursor compatibility pins its provider and adapter contract; ambiguous,
  billed or unusable dispatches never switch supplier.
- Every success reports `sourceMode`, `capturedAt`, `servedAt` and `ageSeconds`.
- Hub requests and actual provider calls can be reconciled without counting avoided calls as spend.
- Unknown cost, balance, free quota and forecast values remain null/unknown, never zero.
- Raw response evidence and each normalized item have a queryable logical archive path and call lineage.
- Client-only display paging causes no acquisition request. Live media is loaded only through the tested,
  reference-based Hub relay and never through a caller-supplied or direct provider URL.
- Launcher, SessionGate, MX-H2I login, WireGuard, DNS and networking code have no diff from this feature.
