# Night-All integration

## Source role

Night-All remains the first-party aggregation and intelligence source on the internal server. It calls TikHub, JustOne, RapidAPI, public feeds and crawlers; normalizes platform records; records source evidence; and owns upstream credentials and provider quotas.

MX Insight Hub does not duplicate or fork this logic. Its adapter calls a versioned private Night-All capability contract and converts it into a stable consumer contract.

For Internal production, keep the host Night-All as the only writer and call it through a workload-authenticated host facade/private Service. A second full Docker Night-All is for isolated local snapshot testing, not a production read shortcut and never shares production PG/Redis or scheduler ownership.

## Versioned data-search adapter

The Hub calls:

```text
POST {NIGHT_ALL_BASE_URL}/api/v1/data/search
```

Server-controlled additions:

- `businessId` is derived from the authenticated consumer.
- readiness/availability policy is selected by the Hub, not the caller.
- the upstream timeout is bounded by `NIGHT_ALL_TIMEOUT_MS`.
- optional `NIGHT_ALL_SERVICE_TOKEN` is injected only on the internal hop.

Caller-controlled fields are currently limited to platform, query, page size and an opaque cursor when the adapter supports it. Provider names, provider endpoint IDs, debug metadata, upstream credentials, and internal accounting fields are stripped.

## Transitional compatibility facade

Three existing Night-All operations are exposed through an explicit Hub namespace:

```text
POST /api/v1/night-all/search/raw
POST /api/v1/night-all/search/crawl
POST /api/v1/night-all/search/user-info
```

These routes are a compatibility facade, not a catch-all proxy and not aliases for
Hub canonical search. They preserve Night-All's standard raw envelope (including
the JSON-string `raw_info` and `raw_data` fields) while applying the Hub boundary:

- authenticate the MX API key and require one explicit granted platform;
- require a stable `Idempotency-Key` and reserve usage before dispatch;
- derive `businessId` from the authenticated consumer; a supplied
  `businessId`/`business_id` must match it exactly;
- reject caller-selected provider, endpoint, credential, capability/moduleCode,
  timeout, availability, billing, debug or other private controls, including
  nested controls; accept and remove legacy `includeRaw:false`, reject
  `includeRaw:true`, and prevent `params` from overriding page size, concurrency,
  enrichment or comment work; archive/fullArchive/allTweets, archiveLimit/totalCount,
  max*Pages, pageCount/chunkSize/budget/crawlDepth and equivalent cost-amplification
  controls require a separate granted capability/policy and are also rejected;
- inject the optional Night-All service token only on the internal hop;
- preserve the complete structurally valid Night-All response, including provider
  or endpoint fields and fields encoded inside `raw_info`/`raw_data`; this
  compatibility response is not currently desensitized by Hub;
- preserve Night-All's top-level `requestId`/`traceId` in the compatibility body,
  return the current durable Hub request ID in `x-mx-insight-request-id` on
  successful live/stale delivery, and
  retain both correlation domains as internal call evidence.

Every dispatch creates a separate connector-call evidence row. HTTP status,
business outcome (`complete`, `partial`, `failed` or `unknown`), failure kind, bounded error
code, latency, delivery source and Night-All correlation IDs are retained even
when the caller ultimately receives a stale snapshot. Substantive warnings or a
per-result error/`success=false` make an HTTP 200 response `partial`; it is returned
and its original, non-desensitized payload is ingested, but it never creates or
replaces a compatibility snapshot. Complete responses use that same unmasked
payload for the live response, exact snapshot and raw ingest evidence. A lone
`STANDARD_PAYLOAD_EMPTY` warning is a deterministic successful empty result, so it
is `complete` and replaces last-good instead of allowing an older non-empty result
to reappear during an outage. Only a structurally valid `complete` response is
snapshot material, and the snapshot keeps the same upstream fields for exact
replay.

The facade always attempts live Night-All first for a new `Idempotency-Key`.
Once a live or stale delivery commits, that key permanently replays the one paid
dispatch; requesting current data requires a new key. On an ambiguous
network/timeout outcome, an unusable HTTP 2xx content-type/JSON/envelope, or a
definite upstream `502`/`503`/`504`, Hub may return the prior complete response
for the exact authenticated consumer, operation and normalized request
fingerprint. The window is 15 minutes for
`raw`, and one hour for `crawl`/`user-info`. Query, platform, identifier, cursor,
page size, filters and contract version are fingerprint inputs; a similar query or
canonical record set is never substituted. Stale HTTP 200 responses carry
`x-mx-insight-source-mode: stale`, capture time, `Age` and `Warning: 110` headers.

With no usable exact snapshot, an unusable HTTP 2xx response is
`502 upstream_outcome_unknown` and leaves usage `unknown`; the same key cannot
dispatch again. A definite upstream `400`, `404`, `409`, `422` or
`429` retains that public HTTP status behind a safe error; other definite failures
map to `502`. A Hub timeout or network loss after dispatch is
`502 upstream_outcome_unknown`, leaves the request ledger `unknown`, and must not
be retried automatically with a new idempotency key. See
[ADR-0010](../adr/0010-night-all-compatibility-facade.md) and the
[cache/fallback design](ingestion-cache-and-fallback.md).

### Telegram is a stored-data exception

Telegram monitor history is not proxied through Night-All on every request.
The two externally written `night_all.public.tg_monitor_*` tables enter Hub
through an Admin-managed read-only PostgreSQL source, then become canonical Hub
records and an Elasticsearch projection:

```text
source PostgreSQL -> Hub canonical PostgreSQL -> ES projection
                              |
                              +-> history/search/entity APIs
```

`POST /api/v1/data/search` with `platform=telegram` and the richer
`POST /api/v1/data/telegram/search` both search stored Hub data. Their response
uses `night-all.data-search.v1` so existing clients retain the stable item and
pagination envelope. Each item fixes `source.provider=null` and
`source.endpointId=hub-canonical-search`; response metadata fixes
`sourceProvider=mx-insight-hub` and `endpointId=hub-canonical-search`. These are
logical serving-plane labels. PostgreSQL search degradation appears only in
`warnings`, never as `meta.searchMode`. No physical source key, host,
database/table name, collector account, credential or TGStat endpoint crosses
the public boundary.

Night-All's present Telegram implementation is TGStat live crawling. It remains
useful for separately labelled live enrichment or fallback after its Telegram
capability has passed readiness governance, but it does not provide the local
history, fuzzy username/chat search, durable change checkpoint or tombstone
semantics required by the Hub dataset. The current Hub Telegram search does not
silently call TGStat when ES is down; it falls back to authoritative Hub
PostgreSQL. An automatic historical-to-live fallback needs an explicit
freshness/source-mode contract so live results are never represented as the
same snapshot.

The source table and continuous-sync safety gates are documented in the
[Telegram ingestion runbook](../operations/telegram-monitor-ingestion.md).

### Telegram conversation context

Night-All sample data may embed `prev_message`, `current_message` and
`next_message`. They are observations of chronological adjacency, not proof of a
reply, topic/thread or album relationship. The current compatibility normalizer
indexes the top-level profile/content row and retains these embedded objects as raw
evidence; it does not index them as duplicate canonical messages.

The target versioned projector models each reliable observation as conversation
nodes plus directed edges:

```text
(platform, internal conversationKey, messageId) -> message node
prev --chronological_next--> current --chronological_next--> next
```

A neighbor with only contextual fields is a stub that can be promoted when a full
observation arrives. An edge is emitted only when both message IDs are stable and
the endpoints resolve to the same conversation. Missing neighbors mean “not
observed”, not start/end of chat; numeric ID adjacency is never inferred. Conflicts
or time inversions remain lineage/quality evidence rather than silently overwriting
an edge. A later public contract can project this as
`contextWindow={before[],current,after[],completeness}` while keeping reply and
thread relations independent.

Importers strip at most one leading UTF-8 BOM before JSON parsing and retain the
original byte hash. A display value such as `私人群组` is not a key. Prefer an
explicit normalized Telegram chat ID, then a validated public handle; a private
`t.me/c/<chat-id>` or `rawGroupName` may form a source-scoped **internal** key but
must not leak through the public API. If none is stable, keep the neighbor objects
as raw evidence and do not create canonical edges.

## Idempotency and unknown outcomes

Night-All’s current search facade is not guaranteed to be end-to-end idempotent: a search may call a paid provider and write audit/cache/observation records. Therefore:

1. Hub stores the caller idempotency key and request fingerprint before dispatch.
2. Same key + same fingerprint replays a committed response.
3. Same key + different fingerprint returns `409 idempotency_conflict`.
4. Definite Night-All HTTP rejection releases the reservation unless an exact
   complete compatibility snapshot is delivered and the request is committed as
   a stale delivery.
5. A connection loss/timeout or unusable HTTP 2xx content-type/JSON/envelope after dispatch is marked `unknown` immediately; the reservation stays held and clients must query request status instead of retrying automatically.
6. If the Hub process exits while a request is still `reserved`, its lease expires and a later reaper pass marks it `unknown` with `reservation_lease_expired`. Lease expiry is not evidence that Night-All did no work, so it does not release or retry the request.

The long-term fix is to pass a Hub request ID into Night-All and make Night-All persist a unique dispatch/result record.

The current Hub still has no general durable same-query cache or cross-key request
coalescing. The compatibility facade's narrow complete-only exact snapshot is the
implemented exception; it is consulted only after a failed live attempt. The
broader target fresh/stale/live decision, per-capability TTL, singleflight lease
and historical fallback are defined in [Ingestion, cache and fallback](ingestion-cache-and-fallback.md).
A stale response must include its age/source mode; a semantically different
historical query must never be returned as if it were live.

## Platform readiness

Night-All exposes a broad 15-platform catalog, but catalog presence is not proof of a live production contract. Grant only platforms that have passed a real credential/endpoint/pagination verification. Automated deploy smoke must not call all paid platforms.

Before deployment, probe the actual Internal revision and route. The local Night-All checkout contains the new `/api/v1/data/search` and durable-cursor work, but repository presence is not proof that the host has that commit/migration. The adapter must also validate the response business status because Night-All can report a failed/partial platform result inside an HTTP 200 envelope, and readiness must inspect dependency sub-status rather than a top-level `ok` alone.

The Hub stores explicit grants such as `xhs` and `weibo`. A future “all platforms” action creates a versioned snapshot of currently approved platforms; it is not a wildcard.

Observed on Internal (2026-08-06): every platform in `/api/v1/data/capabilities` reports `degraded` with reason `endpoint_degraded`, so `ready_only` search fails closed with `503 DATA_PLATFORM_NOT_READY`. Per the upstream spec a platform is promoted to `ready` only when a successful live call is recorded no earlier than the contract version it belongs to (`last_success_at >= contract_updated_at`); re-verification is required whenever the endpoint path/params/schema change. Hub-side grants and the Admin "platform enabled" view are authorization state and say nothing about upstream readiness, so the Admin console must surface the upstream capability status separately instead of implying a granted platform can serve data.

## Upstream capability coverage

The versioned `/api/v1/data/*` contract currently fixes `capability` to
`search_posts`. Hub therefore exposes `raw`, `crawl` and `user-info` only through
the namespaced transitional facade above; they retain the legacy request/envelope
and Hub safeguards but remain outside Night-All's `ready_only` capability-freshness
governance. A compatibility success is not evidence that the platform has passed
the versioned data-contract readiness gate.

Item detail and comments still exist only on the older
`/api/v1/search/post-detail` and `/api/v1/search/post-comments` routes and are not
proxied by Hub. The target is to extend the upstream data contract with
`post_detail`, `post_comments` and `profile` capabilities so they inherit catalog
readiness, opaque cursors and stable fields.

Night-All remains the connector while it owns upstream routing and paid-token
business policy. Direct TikHub/JustOne connectors may later replace it per
platform + operation behind the same Hub boundary: shadow against bounded approved
calls/fixtures, compare both original legacy envelopes and canonical records, then
cut over with an explicit rollback policy. Provider selection stays server-side,
and the public compatibility paths, consumer API keys and canonical search
contract do not change.

## Night-All work that stays outside this repository

- internal service authentication middleware;
- provider credential encryption, rotation and redaction;
- the `CH` (Switzerland) versus `CN` (China) classification fix and historical reclassification;
- TikHub endpoint/capability contract fixtures and per-platform live verification;
- Night-All PostgreSQL PITR, artifact snapshot and restore drills;
- collection scheduler/worker ownership and single-writer cutover.

See the Night-All repository `specs/README.md`, `NIGHT_ALL_RUNTIME_AND_BOUNDARIES.md`, and `NIGHT_ALL_DATA_SEARCH_API_V1.md` for their current implementation status.
