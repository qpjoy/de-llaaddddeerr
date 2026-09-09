# Xiaohongshu direct TikHub migration boundary

Status: staged release contract. This document defines the traffic that may move from Night-All to the
Hub-owned TikHub connector and the controls required before activation. Repository code, a database migration,
or this document alone is not proof that a target environment has enabled direct routing.

Last reviewed: 2026-09-09.

Related documents:

- [External data platform gateway ADR](../adr/0013-external-data-platform-gateway.md)
- [Night-All compatibility facade ADR](../adr/0010-night-all-compatibility-facade.md)
- [Night-All integration](../architecture/night-all-integration.md)
- [External platform operations](../operations/external-data-platforms.md)
- [JustOne capability map](justone-capability-map.md)

## 1. Ownership and non-goals

The migration adds one Hub-native physical provider path behind existing Hub contracts. It does not remove
Night-All, rename historical evidence, or make TikHub part of Launcher identity or networking.

The reserved identities for the staged direct Xiaohongshu search are:

```text
Public platform:          xiaohongshu
Hub operation:            social.posts.search
TikHub endpoint contract: xiaohongshu.app-v2.search-notes.v1
Canonical dataset:        social.posts.v1
Canonical connector:      external-platform:tikhub
```

The released note-detail mapping is intentionally separate:

```text
Hub-owned public path:    POST /api/v1/xiaohongshu/app/get_note_info (JSON link input)
Compatibility read path: GET /api/v1/xiaohongshu/app/get_note_info (note_id/share_text)
Official-shaped read path: GET /api/v1/xiaohongshu/app_v2/get_image_note_detail (note_id/share_text)
Hub operation:            social.posts.resolve
TikHub endpoint contract: xiaohongshu.image-note-detail.v2
TikHub physical path:     /api/v1/xiaohongshu/app_v2/get_image_note_detail
Canonical dataset:        social.posts.v1
```

TikHub App V1 and its old physical `/app/get_note_info` operation were permanently retired on 2026-06-17
per the [TikHub Xiaohongshu App V2 migration guide](https://blog.tikhub.io/zh/article/7).
The Hub public path keeps a useful customer-facing spelling but never dispatches to that retired operation.
The JSON POST is preferred for links so temporary link parameters do not enter request-target logs; GET
`share_text`/`note_id` inputs remain compatible. Both GET spellings enter the canonical `/data/post` pipeline;
they do not expose the upstream envelope or create separate paid-operation fingerprints. All are normalized and the current adapter calls only the
reviewed App V2 detail contract.
The Public response remains Hub-owned and provider-neutral.

`social.posts.search` is distinct from the existing `social.posts.resolve` note-detail capability. A direct
search requires the effective `xiaohongshu` platform grant and an active Live Hub Public API key; it does not
grant callers the independent `/api/v1/data/post` operation. Bounded detail enrichment performed internally as
part of a search does not add `social.posts.resolve` as a second public grant requirement.

JustOne remains the physical provider only for the provider-neutral ecommerce product-search product. Its
`xiaohongshu_ec` marketplace means Xiaohongshu shop/product data, not social notes. Search, detail, cache or
failure handling for a Xiaohongshu note must never silently route to JustOne.

This work is confined to the Hub data plane. It must not change MX Launcher or MX-H2I login, Domestic/Internal
routing, WireGuard, DNS, user records or existing user connectivity. A missing TikHub credential or an open
TikHub circuit degrades only the direct external-data operation.

## 2. Deterministic route eligibility

Provider selection is server-owned and happens before provider admission or network dispatch. Public requests
never accept a provider name, endpoint path, credential, rate override or arbitrary TikHub parameter.

### Modern `/api/v1/data/search`

A request may use direct TikHub only when all of the following are true:

- the requested platform is exactly `xiaohongshu`;
- it contains one scalar `query` and `pageSize=20` (the existing default);
- it has no continuation, or its continuation is a Hub-signed cursor issued by the direct TikHub search
  contract for the same consumer, query and page size;
- it carries a valid non-Test Hub Public API key, the effective `xiaohongshu` grant and a valid
  `Idempotency-Key`;
- when `MX_INSIGHT_TIKHUB_SEARCH_CANARY_CONSUMER_IDS` is non-empty, its consumer UUID is in that
  allowlist; an empty value preserves the global search-gate behavior;
- the direct contract gate, TikHub credential, PostgreSQL ledger and provider admission controls are ready in
  that environment.

A Hub-encrypted historical cursor beginning `mxnc1.` remains pinned to the
Night-All path. Hub must not decode it as a TikHub cursor, copy provider
continuation fields out of it, or restart the search on TikHub. A bare
Night-All/provider cursor issued before this wrapper is not accepted: it returns
`400 invalid_cursor`, and the client must remove it, use a new
`Idempotency-Key`, and restart from page 1. Other platforms continue to use their
existing Night-All or Hub-stored ownership path.

### Compatibility `/api/v1/night-all/search/{raw,crawl,user-info}`

The route name remains for client compatibility; it is not a claim that every response was acquired by
Night-All. A request may use the direct TikHub compatibility projection only for this narrow slice:

`/api/v1/search/raw` is an exact public alias of this route. The same applies to the `crawl` and `user-info`
operation pairs. The app canonicalizes each pair before the paid request fingerprint is computed, so changing
only the route spelling never creates a second provider dispatch.

- operation `raw` and platform exactly `xiaohongshu`;
- one scalar `query` or `keyword`, never the `keywords` or `queries` batch forms;
- `count`/`pageSize`/`limit`, when present, resolves to exactly 20 so one Hub page maps to one provider page
  without dropping or skipping results;
- first page, or a Hub-signed direct cursor returned by an earlier direct response;
- no comments request and no comment cursor/limit;
- it has no comment fan-out or request-specific concurrency controls;
- `includeDetails=true` and `maxEnrichItems=1..20` use the existing cost-governed Hub-native detail workflow,
  while `includeDetails=false`, `includeComments=false`, and `disableAutoDetails=true` remain safe inputs.

A separate Hub-native user-activity slice is eligible only when the parent TikHub gate and
`MX_INSIGHT_TIKHUB_USER_ACTIVITY_CONTRACT_VERIFIED=1` are both active and the credential, durable ledger and
cost controls are ready:

- `crawl` accepts exactly one Xiaohongshu user identity, only `activityTypes=["posts"]` (or the omitted
  equivalent), effective page size 20 and concurrency 1. Page 1 may omit a cursor; continuation must use the
  Hub-issued direct `mxec2` cursor, including the legacy `params.cursor` spelling when no other custom param is
  present;
- `user-info` accepts exactly one Xiaohongshu username, 24-hex user ID or official profile URL on page 1, with
  no continuation, custom params or concurrency control.

These are compatibility projections over Hub-native TikHub workflows, not proof that either rollout gate is
enabled in a particular deployment. An already-issued direct crawl cursor stays pinned to that connector even
if new first-page cutover is closed.

The following remain owned by Night-All and must not be translated into a direct TikHub request:

- Hub-issued historical `mxnc1` traversals;
- `keywords`/`queries`, multi-query fan-out and other batch work;
- comments, subcomments and comment pagination;
- multi-identifier or channel crawl/user-info forms, non-post activity, non-20 crawl pages, custom cache/params
  controls and every other crawl/user-info shape outside the narrow rules above;
- Night-All provider routing, scheduled collection, historical export/backfill and unmigrated platform
  normalization.

An invalid or unauthorized request is still rejected. “Not direct eligible” does not bypass validation, grants
or work-budget checks. For valid legacy-only shapes, selecting Night-All is an ownership decision made before
dispatch, not a provider fallback after a failed TikHub call.

Direct compatibility responses preserve the reviewed JSON-string `raw_data`/`raw_info` envelope, but their
provenance is Hub direct TikHub. They use `source=mx-insight-hub`; the top-level `requestId` is the durable Hub
request ID also returned in `x-mx-insight-request-id`. TikHub correlation IDs, endpoint identity and provider
calls remain private lineage/archive evidence and are never relabelled as Night-All. Historical Night-All
responses retain their business body and correlation identifiers unchanged;
only pagination-control fields are projected to `mxnc1` and the 15-page
terminal state. The historical hop retains complete parsed JSON and legacy raw
strings, but byte-exact upstream response text plus hash is guaranteed only by
Hub-native provider restricted storage.

## 3. Cursor, idempotency and fallback invariants

- The modern and compatibility routes keep separate request fingerprints and `Idempotency-Key` histories.
  Replaying one route cannot rebind the other route's customer usage request.
- Their direct projections may share an exact provider snapshot through a provider-query fingerprint, avoiding
  another paid search for the same consumer and page. The stored projection selected for delivery must still
  match the caller's route contract.
- A direct cursor binds the contract version, consumer, platform, query, page size, page and bounded upstream
  continuation. It is consumer-scoped and protected with authenticated AES-256-GCM encryption. Changing any
  bound request field requires a new first page.
- A historical `mxnc1` cursor encrypts Night-All cursor, composite/offset params,
  or page-number continuation state and binds consumer, operation, platform,
  stable query scope and next page. Page mode is exposed as Hub cursor mode and
  offset mode as Hub composite mode; neither raw `nextPage` nor offset escapes.
  The same rule governs every non-Telegram Night-All-backed
  `/api/v1/data/search` traversal. Every next page requires a new `Idempotency-Key`; page
  15 clears continuation and reports `hasMore=false`.
- Bare provider cursors/continuation params, tampered `mxnc1` values and scope
  mismatches return `400 invalid_cursor`; restart from page 1 without a cursor
  and with a new key. This pagination-control rewrite does not filter, redact or
  truncate long content, `raw_info`, `raw_data` or correlation fields.
- An `mxnc1` cursor always stays on Night-All. An `mxec2` direct cursor always
  stays on TikHub. Rollback may stop issuing new direct first pages, but it must
  either continue already-issued direct cursors or fail them explicitly; it
  must never pass them to Night-All.
- Once a TikHub provider token is admitted, a provider-call row is opened, or network dispatch begins, the same
  Hub request must not call Night-All or JustOne. A timeout, `unknown`, billed-but-unusable response, rate limit
  or open circuit is not permission for a second provider charge.
- Before dispatch, an exact fresh/stale TikHub snapshot may be served according to its delivery policy. That is
  cache/fallback within one physical provider lineage, not cross-provider fallback.

There are no automatic paid-provider retries. A transport timeout or persistence ambiguity remains `unknown`;
operators and clients preserve the original body, request ID and idempotency key instead of silently creating a
new acquisition.

## 4. Detail enrichment and content completeness

TikHub search cards can contain a 60-character/code-point/grapheme preview. Direct search detects that boundary
and may perform bounded note-detail calls so that a preview is not silently presented as confirmed full text.

The direct enrichment policy is:

- normal search automatically selects only 60-boundary candidates;
- compatibility raw may set `disableAutoDetails=true` to make zero automatic detail calls;
- explicit `includeDetails=true` selects all candidates and `maxEnrichItems=1..20` bounds the existing
  Hub-native detail workflow; the gateway reserves the complete remaining detail cost before the first detail call;
- `enrichConcurrency`, comment controls and comment fan-out remain on the historical Night-All route;
- the default covers all 20 candidates in one search page and the hard limit is also 20;
- comments are never folded into this enrichment budget;
- an exact fresh detail snapshot is used before provider admission and creates no provider-call row;
- every actual search or detail dispatch consumes the common TikHub provider-rate budget.

The response and canonical mapping retain one of these body states per item:

| State | Meaning |
| --- | --- |
| `detail_enriched` | A longer, usable detail response replaced the search preview. |
| `provider_preview` | The item still matches the preview boundary and no usable detail was obtained. |
| `unverified_complete` | The body did not match the known preview boundary; this is not proof of upstream completeness. |

An unresolved `provider_preview` must remain visible as partial/incomplete evidence and must not be labelled
complete. Hub does not apply a field-level body ceiling; the adapter's bounded whole-response policy remains the transport safety boundary.

Search snapshots use `MX_INSIGHT_TIKHUB_SEARCH_FRESH_TTL_MS` (5 minutes by default) and
`MX_INSIGHT_TIKHUB_SEARCH_STALE_TTL_MS` (24 hours by default). Automatic preview repair uses
`MX_INSIGHT_TIKHUB_SEARCH_MAX_ENRICH_ITEMS=20` and
`MX_INSIGHT_TIKHUB_SEARCH_ENRICH_CONCURRENCY=2`. The former closes the known 60-character gap for an entire
20-item page when detail evidence is available; the shared provider token bucket, bounded workers and request
deadline still protect QPS and may return an explicitly partial result instead of silently claiming complete
text. Existing note-detail snapshots continue to use `MX_INSIGHT_TIKHUB_FRESH_TTL_MS` (24 hours by default) and
`MX_INSIGHT_TIKHUB_STALE_TTL_MS` (30 days by default).

## 5. Multi-call ledger and provider admission

One Public request remains one customer usage request even when acquisition contains one primary search and
several details. Migrations `055_external_platform_multi_call_rate_limit.sql` and
`057_external_platform_cost_reservations.sql` are therefore direct-routing prerequisites. Migration 055
changes provider-call identity from one row per usage request to:

```text
UNIQUE (usage_request_id, call_ordinal)
call_ordinal = 0                 primary search
call_ordinal = 1..N              bounded enrichment calls
call_role    = primary|enrichment
```

Each real dispatch independently records operation, endpoint/contract version, dispatch fingerprint, outcome,
billed state, estimated cost, latency and archive evidence. A cache hit does not create a fake provider call.
The customer usage reservation is committed once with the final delivery; pre-dispatch failure can release it,
but an ambiguous or possibly billed provider step cannot be erased by releasing or relabelling the group.

Migration 057 adds a separate short-lived procurement forecast/hold; it is not call evidence. After exact
detail-cache lookup and before the first live enrichment call, Hub atomically records the sum of every remaining
detail cost and its uncovered subsidy exposure. With `N <= 20` uncached candidates, gross page procurement is
the already-admitted search cost plus `N × detail endpoint cost`. For traffic without a positive `enforced`
per-request wallet hold, a workflow that does not fit the provider monthly/subsidy thresholds sends zero detail
calls and returns the paid primary search as explicitly partial. A paid-ready request records the same cost
forecast but does not stop at those Hub financial thresholds. Two subsidized workflows cannot spend the same
remaining headroom.

Every enabled endpoint cost must be a positive reviewed amount in the provider billing currency. `0` cannot
stand for unknown, and `billed=false` or an unknown billed result does not erase the admitted gross estimate.
Legacy-unpriced, shadow and zero-price deliveries consume explicit subsidy. A strictly matched positive
`enforced` wallet hold makes the Hub financial thresholds warning-only even when provider and customer ledgers
use different currencies; amounts remain separate and Hub does not assume an exchange rate. Downstream prices
remain operator-entered immutable price-book versions and are never derived from TikHub cost or desired margin.

Provider admission is separate from the customer plan's request/RPS quota:

| Control | Repository default / bound | Scope |
| --- | ---: | --- |
| `MX_INSIGHT_TIKHUB_SEARCH_CANARY_CONSUMER_IDS` | empty | Optional comma-separated consumer UUID allowlist for new direct first pages and capability advertisement. Empty means the search contract gate is global. |
| `MX_INSIGHT_TIKHUB_MAX_REQUESTS_PER_MINUTE` | 120 | PostgreSQL-clock token bucket shared by all Hub replicas and all TikHub search/detail dispatches. |
| `MX_INSIGHT_TIKHUB_SEARCH_MAX_ENRICH_ITEMS` | 20, maximum 20 | Maximum known preview-boundary notes considered per search page. |
| `MX_INSIGHT_TIKHUB_SEARCH_ENRICH_CONCURRENCY` | 2, maximum 5 | Detail workers within one search request. |
| `MX_INSIGHT_TIKHUB_MAX_CONCURRENCY` | 8 | In-process live TikHub dispatch ceiling. |
| `MX_INSIGHT_TIKHUB_MAX_CONSUMER_CONCURRENCY` | 8 | In-process per-consumer live TikHub dispatch ceiling. |
| `MX_INSIGHT_TIKHUB_TIMEOUT_MS` | 30000 ms | Per-provider-call deadline; configured value cannot exceed 120000 ms. |
| detail candidates | 20 default / 20 hard maximum | Per search request, after exact detail-cache lookup. |

The PostgreSQL token bucket is the cross-replica authority. A token admitted immediately before a later local or
persistence failure is not refunded, because refunding could recreate capacity after a request may have left the
process. In-process concurrency remains a second bound, not a substitute for QPS/RPM admission. The durable
circuit breaker and exact-fingerprint dispatch lease remain active in addition to these limits.

The 120-per-minute token bucket is not a promise of an evenly spaced two requests per second. Available tokens
can permit a bounded burst, so a provider contract that requires a stricter instantaneous QPS ceiling needs a
separately implemented and reviewed limiter before traffic is widened.

Before activation, verify that the target deployment actually passes the RPM configuration to the public data
plane and that migration 055 exists in the same PostgreSQL database used by every replica. A source-tree default
or ConfigMap key that is not consumed by the running image is not operational evidence.

## 6. Archive, cache and canonical lineage

Every bounded UTF-8 provider response is persisted unchanged in
`control.external_platform_restricted_raw_responses`, with its exact response-text SHA-256 and lossless JSON
parse when available. This restricted source layer deliberately keeps business fields such as body text,
`params`, `search_id`, `search_session_id`, profile data, metrics and signed media URLs. It never stores the
request URL, Authorization header or provider credential and is never selected by Public, tenant, ordinary
Admin, UI, log or search-projection paths.

A separately redacted, secret-free operational envelope receives a content-addressed logical response path.
Every normalized item receives a separate logical item path:

```text
external/tikhub/xiaohongshu/<YYYY-MM-DD>/responses/<sha256>.json
external/tikhub/xiaohongshu/<YYYY-MM-DD>/items/<sha256>.json
```

The date is the UTC capture date. These are currently logical taxonomy paths backed by PostgreSQL JSONB rows;
they do not prove that an object exists in S3/MinIO or another durable object store. Retention, partitioning and
capacity alerts must be reviewed before widening traffic because one customer request can now create several
provider-call and archive rows.

Direct search and detail records enter:

```text
datasetId:   social.posts.v1
connectorId: external-platform:tikhub
lineage:     the exact successful external_platform.provider_calls.id
```

Search and detail calls remain separate observations even when they share an `externalId`. A later detail may
improve the canonical current representation, but it does not delete the earlier ranked-search observation or
change its metrics retrospectively. Canonical ingestion is asynchronous and must never delay or mutate the
already committed Public response.

The existing Night-All datasets are historical evidence and remain immutable in origin:

```text
night-all.search.v1  -> connector night-all
night-all.compat.v1  -> connector night-all-legacy
```

Do not backfill, relabel or copy those rows as `external-platform:tikhub`. A federated reader may deduplicate a
current view by platform and external identity while retaining both observations and their original lineage.

## 7. Activation, observation and rollback

Direct traffic may be enabled only after all of the following are true in the target environment:

1. migrations 055, 057 and 058 are applied and the application image understands multi-call ordinals,
   provider RPM admission, atomic cost/subsidy holds and restricted exact-response storage;
2. the pinned TikHub search response has redacted fixture coverage, including continuation, empty, partial,
   60-boundary, detail, oversized and unusable responses;
3. `MX_INSIGHT_TIKHUB_CONTRACT_VERIFIED=1` and the narrower gate for the traffic being enabled—
   `MX_INSIGHT_TIKHUB_SEARCH_CONTRACT_VERIFIED=1` for search/raw or
   `MX_INSIGHT_TIKHUB_USER_ACTIVITY_CONTRACT_VERIFIED=1` for crawl/user-info—a current credential is resolvable,
   and the Public process—not the Admin listener—owns the credentialed adapter. Either narrower gate is rejected
   at startup unless the parent contract gate is also enabled. Before opening a paid gate, a reviewed manual billing config must
   define currency, effective date, positive costs for every enabled endpoint, gross monthly provider budget,
   and explicit monthly subsidy budget;
4. `mxec2` direct and `mxnc1` historical cursors are classified before dispatch and cannot cross routes;
5. modern and legacy projection tests prove schema compatibility without fabricating Night-All provenance;
6. metrics distinguish Hub requests from actual provider calls, primary from enrichment calls, cache avoidance,
   billed/unknown outcomes, rate rejection, incomplete previews and canonical-ingest lag;
7. the deployment's parent and operation-specific contract-verification gates are changed through a recorded canary/rollback change
   with an owner. Fixture tests are preferred; a live shadow or smoke can double provider cost and requires
   explicit authorization.

Roll out the application and migration first with
`MX_INSIGHT_TIKHUB_SEARCH_CONTRACT_VERIFIED=0`. Confirm that every Public replica understands direct cursors,
multi-call evidence, atomic cost reservations and the shared provider-rate bucket before changing the search
gate to `1` for a canary. Apply and preflight the reviewed billing JSON while both gates are still closed; do
not combine an unverified price/config change with first traffic activation.
For the first live request, set `MX_INSIGHT_TIKHUB_SEARCH_CANARY_CONSUMER_IDS` to one dedicated consumer UUID
before opening the search gate. A non-empty allowlist sends every other eligible first page to Night-All and
hides direct-search capability advertisement from those consumers. Removing a consumer from the allowlist or
closing the gate does not reroute a previously issued direct cursor; its continuation stays on TikHub so a
single pagination chain cannot change providers midstream.
The parent gate may remain enabled for the already released explicit note-detail operation while the narrower
search gate stays closed. Do not infer search activation from the presence of a credential, migration or
`search_posts` source code alone; the running capability response must advertise nested `search.ready=true`.

Roll out crawl/user-info independently with `MX_INSIGHT_TIKHUB_USER_ACTIVITY_CONTRACT_VERIFIED=0`, then open it
only after its single-identity projections, multi-call cost reservations and direct-cursor fixtures pass in the
target environment. Closing that gate stops new direct first pages; it does not turn an existing `mxec2` crawl
continuation into a Night-All request. Public capability presence, source code and a stored credential do not
prove this gate is live-ready.

Rollback sets `MX_INSIGHT_TIKHUB_SEARCH_CONTRACT_VERIFIED=0` first, which stops new direct first pages. Preserve
the TikHub credential, parent contract gate, direct snapshots, provider-call ledger, archives, canonical
observations and signed cursor support through the rollback window so already-issued direct cursors remain on
their original connector. Night-All credentials, routes and historical datasets stay available throughout
migration. Rollback changes future route ownership; it never rewrites completed evidence.
