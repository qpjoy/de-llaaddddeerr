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
would also make it hard to distinguish Hub demand from paid provider calls, archive the original evidence,
reuse exact fresh results, or explain why a stored result was returned.

The first native adapter is JustOne product search. The integration must coexist with existing Hub stored
search, Night-All compatibility and cleaning jobs. It does not own, replace or initialize Launcher,
SessionGate, MX-H2I login, WireGuard, DNS or user networking.

## Decision

### 1. Publish one Hub-owned product-search contract

The public surface is:

```text
POST /api/v1/data/ecommerce/products/search
contractVersion = mx-insight-hub.ecommerce-products.v1
authorization platform = ecommerce
```

The request allowlist is exactly `marketplace`, `query`, `page`, `cursor`, `sort` and `price`. There is no
caller-controlled `pageSize`; result size is server policy. `page` and `cursor` are mutually exclusive.
The response contains normalized product, price, shop, image, signal and attribute fields plus
`capturedAt`, `servedAt`, `sourceMode` and `ageSeconds`. It never contains the JustOne identity, token,
endpoint URL, raw continuation or raw response.

JustOne endpoint names and shapes stay behind versioned adapter descriptors. A future external platform may
serve the same public route only when it can satisfy the same semantics and evidence requirements. An
incompatible request, product identity, pagination or freshness model requires a reviewed public contract
version rather than leaking provider-specific fields into v1.

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
alone cannot prove what happened to the paid call. Valid items additionally receive `archive_objects` rows.

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
key.

When a caller omits the key, Hub derives a short-lived freshness-bucket key. This is a convenience and
duplicate guard, not a durable client replay contract. The gateway additionally holds an exact
consumer/operation/fingerprint dispatch lease so two concurrent requests with different keys cannot both
launch the same paid call. Quota, global concurrency, per-consumer concurrency and the provider circuit
bound faulty-client amplification.

The Hub cursor is consumer-scoped, authenticated-encrypted and bound to marketplace, query, sort and price.
Provider continuation state such as the JustOne Xiaohongshu EC `searchId` exists only inside that opaque
ciphertext. A client never sees, decodes or supplies it directly. Tampering or reuse by another consumer
fails closed. `nextCursor=null` ends traversal. `hasMore=null` means Hub cannot prove a safe next step and
the client must stop rather than incrementing `page`.

### 5. Use exact fresh cache and exact stale fallback

Snapshots are keyed by consumer, operation and the complete normalized request fingerprint:

- `live` records a new successful provider call;
- `fresh_cache` serves an unexpired exact snapshot without a provider call;
- `stored_fallback` serves an exact last-good snapshot within the configured stale window when dispatch is
  unavailable, rejected, unusable, concurrency-guarded or circuit-open;
- `idempotent_replay` serves the immutable result already committed to the same caller key.

There is no fuzzy-query, cross-consumer, cross-marketplace, cross-page, canonical-search or “similar item”
fallback. A stored delivery always exposes capture/serve time, age and source mode; stale fallback also
emits HTTP Warning 110. The failed attempt and delivered snapshot remain separate evidence.

An unusable successful response or an ambiguous network outcome may already have consumed provider quota.
Without a valid exact snapshot the request returns an outcome-unknown error and is never blindly
redispatched. Operators and clients retain the same request ID and idempotency key while investigating.

### 6. Separate Hub demand, actual calls and money

`gateway_requests` counts Hub demand. `provider_calls` counts actual dispatches. Cache hits, replay, fallback
without dispatch, duplicate suppression and circuit rejection are therefore measurable avoided calls rather
than fictitious provider traffic.

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

## Compatibility and isolation

- Existing `/api/v1/data/search`, canonical search, stored data products and three namespaced Night-All
  compatibility routes retain their contracts.
- External-platform readiness is independent from Hub, Launcher and MX-H2I login/network readiness.
- Public API keys require the explicit `ecommerce` grant. Management analytics stay on the Internal Admin
  listener and retain the existing Hub Admin Token-only source-management boundary; Launcher sessions do
  not gain access from a membership alone.
- Provider secrets are process configuration only. They never enter public documents, cursors, archives,
  canonical records, logs, management responses or UI state.
- The external-platform worker and ingest job use bounded queues and quotas; failure cannot block login or
  the serving of already-stored Hub data.

## Consequences

Positive:

- clients receive one stable, provider-neutral contract and observable freshness;
- retries, page navigation and concurrent duplicates do not silently multiply paid calls;
- raw evidence, canonical data and actual cost/demand measurements remain connected;
- additional external platforms can be compared without making their schemas public API contracts.

Costs:

- every provider shape change needs a fixture and adapter review;
- exact caching deliberately misses semantically similar requests;
- money and quota forecasts remain unavailable until price evidence is reviewed;
- raw evidence and canonical projections add storage, retention and operational work.

## Acceptance gates

- Public OpenAPI and narrative docs contain no JustOne identity, secret or upstream URL.
- Request schema rejects unknown fields and `page + cursor`; it contains no `pageSize`.
- Every next-page example uses a new `Idempotency-Key` and returns only the opaque Hub cursor.
- Every success reports `sourceMode`, `capturedAt`, `servedAt` and `ageSeconds`.
- Hub requests and actual provider calls can be reconciled without counting avoided calls as spend.
- Unknown cost, balance, free quota and forecast values remain null/unknown, never zero.
- Raw response evidence and each normalized item have a queryable logical archive path and call lineage.
- Launcher, SessionGate, MX-H2I login, WireGuard, DNS and networking code have no diff from this feature.
