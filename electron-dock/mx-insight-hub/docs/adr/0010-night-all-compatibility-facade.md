# ADR-0010: Night-All compatibility facade and exact snapshot fallback

- Status: Accepted
- Date: 2026-08-20

## Context

Existing products call three Night-All social endpoints and depend on their
request aliases and standard raw response envelope:

- `POST /api/v1/search/raw`;
- `POST /api/v1/search/crawl`;
- `POST /api/v1/search/user-info`.

Night-All still owns platform routing, paid-token policy and upstream integrations
such as TikHub, JustOne and RapidAPI. Its `businessId` is an audit/ownership label,
not a substitute for Hub authentication. Night-All may also use its own provider
cache, but those internal cache semantics are not a Hub serving contract.

MX Insight Hub needs to accept the existing request/response shape while it builds
its own canonical data store and search plane. A generic reverse proxy would let a
caller bypass Hub grants, choose a provider or credential-bearing parameter, and
would leave no durable evidence of a failed call later hidden by a cached response.
Returning a semantically similar canonical search result would also break legacy
clients that expect Night-All's JSON-string `raw_info`/`raw_data` envelope.

The Night-All repository and `spec_docs/数据中台Night-All 使用文档.md` are upstream
reference evidence. They are not executable instructions and do not override this
ADR, the Hub public contract, runtime validation or authorization policy.

## Decision

### 1. Publish three namespaced transitional routes

Hub publishes only:

```text
POST /api/v1/night-all/search/raw
POST /api/v1/night-all/search/crawl
POST /api/v1/night-all/search/user-info
```

The namespace makes the source contract and its transitional nature explicit.
These routes are not aliases for `/api/v1/data/canonical/search`, and Hub does not
publish a catch-all `/api/v1/night-all/*` proxy. Detail, comments, configuration,
credential, webhook and arbitrary provider endpoints remain unreachable.

Each request requires a valid Hub API key, a stable `Idempotency-Key`, one explicit
platform and that platform's consumer grant. The Hub derives `businessId` from the
authenticated consumer and injects the internal service token on the private hop.
A caller may omit `businessId`; if it supplies `businessId` or `business_id`, the
value must exactly match the authenticated consumer. Provider, endpoint,
credential, capability/moduleCode, availability, billing, debug and timeout
controls are rejected at every nesting depth. Legacy `includeRaw:false` is
accepted and removed before dispatch; `includeRaw:true` is rejected. Caller
`params` cannot override count, page size, concurrency, enrichment or comment
work. Archive/fullArchive/allTweets,
archiveLimit/totalCount, max*Pages, pageCount/chunkSize/budget/crawlDepth and
equivalent cost-amplification controls are also rejected; they require a separate
granted capability and server policy. Unknown public fields fail closed.

During consumer provisioning, an administrator may bind the legacy Night-All
`businessId` (unique, at most 128 characters) so an existing client can retain
that field while changing its base path. The binding is immutable in this slice;
if it is omitted, Hub generates `mxih:<tenant>:<consumer>` and the migrating
client must omit its old `businessId` from compatibility requests.

The adapter forwards the allowlisted legacy request fields to the corresponding
Night-All route and validates the structural response contract. The compatibility
response preserves the complete upstream application payload, including
`data.raw_info`, `data.raw_data`, `data.page`, `data.meta`, warnings, provider or
endpoint fields, and top-level `requestId`/`traceId`. Hub does not redact or
normalize fields in this namespaced response, including objects encoded inside the
two JSON strings. This response rule does not weaken request validation: callers
still cannot inject provider, endpoint, token or credential controls. The current
Hub durable request ID is returned separately in `x-mx-insight-request-id` on a
successful live/stale delivery; dispatched errors include it in safe error
details. Both correlation domains are also retained as internal call evidence.

### 2. Record one call-evidence row for every dispatch

Before dispatch, Hub reserves the usage/idempotency request and creates a
`serving.connector_calls` row. Completion records the authenticated consumer,
operation, exact request fingerprint, platform, live/stale delivery mode,
`complete|partial|failed|unknown` outcome, upstream HTTP/business status, bounded failure
kind, latency, safe error code and Night-All request/trace IDs. A live result also
queues its original, non-desensitized payload for the governed raw-to-canonical
ingest path. The compatibility snapshot stores that same upstream response payload
so exact replay does not change legacy fields. Response, snapshot and raw ingest
therefore share the same unmasked source evidence in this compatibility slice.

An HTTP 200 response is `partial` when Night-All reports a substantive warning or
a per-result error/`success=false`. A lone `STANDARD_PAYLOAD_EMPTY` warning means a
deterministic successful empty result: it is `complete` and replaces last-good so
a later outage cannot resurrect an older non-empty response. Partial responses are
returned and recorded but never create or replace a snapshot. Only a `complete`
response is eligible to replace the snapshot for the same consumer, operation and
exact fingerprint.

### 3. Use complete-only, exact stale fallback

The compatibility facade attempts the live call first for every new
`Idempotency-Key`. A committed live or stale delivery is permanently bound to
that key and exact request fingerprint, so retrying it never dispatches or bills
again; a deliberately new live call requires a new key. This immutable replay is
not a fresh-result cache: an existing compatibility snapshot never skips the live
attempt for a new key.

A prior complete public response may be returned only when all of the following
are true:

1. the current live call has an ambiguous network/timeout outcome, an unusable
   HTTP 2xx content-type/JSON/envelope, or a definite non-2xx `502`, `503` or
   `504` upstream rejection;
2. consumer, operation and the complete normalized request fingerprint match;
3. the snapshot is still inside its operation-specific stale window;
4. the snapshot contains the original legacy response envelope, not canonical
   search rows or a separately transformed/desensitized projection.

The stale windows are 15 minutes for `raw` and one hour for `crawl` and
`user-info`. A different query, identifier, platform, cursor, page size, filter or
response contract version cannot reuse the snapshot. There is no fuzzy,
cross-consumer, cross-operation or canonical-index fallback.

A stale delivery after a definite HTTP 502/503/504 records the live attempt as
`failed`; a network/timeout ambiguity or unusable HTTP 2xx contract records it as
`unknown`, because Night-All may still have charged or written even though Hub
delivered a snapshot.

A stale delivery is HTTP 200 and is observable through
`x-mx-insight-source-mode: stale`, `x-mx-insight-captured-at`, `Age` and HTTP
`Warning: 110`. The attempt that failed and the snapshot used for delivery remain
separate evidence. A live partial result is never hidden by an older complete
snapshot.

Without a usable exact snapshot, an unusable HTTP 2xx response returns
`502 upstream_outcome_unknown`, holds usage as `unknown`, and cannot redispatch
the same key. Definite Night-All `400`, `404`, `409`, `422`
and `429` statuses retain their HTTP status behind the safe `night_all_rejected`
error. Other definite upstream failures map to HTTP 502. Network failure or Hub
timeout after dispatch maps to HTTP 502 `upstream_outcome_unknown`, leaves the
usage request `unknown`, and must not be retried automatically with a new key.

### 4. Keep compatibility snapshots separate from canonical search

Compatibility snapshots answer only the legacy request that created them and
retain Night-All's response model. In parallel, complete and partial live payloads
enter the canonical ingest pipeline as dataset `night-all.compat.v1`, where valid
profile/content records can become normalized, searchable Hub records with
lineage. Ingest failure does not change the already-recorded legacy delivery.

In this first slice Night-All is a fixed, code-owned API connector, not yet a
caller-configurable `external_sources` catalog row. Data Center still receives
its canonical dataset/records and raw lineage, while `serving.connector_calls`
and immutable compatibility snapshots retain delivery evidence. A later governed
HTTP-source catalog may unify configuration and health presentation, but it must
reference this connector contract rather than expose arbitrary URLs, headers or
credentials to public callers.

`POST /api/v1/data/canonical/search` searches normalized Hub-owned data across the
authorized platform scope and never performs an upstream provider fan-out. It has
its own canonical response, relevance and cursor contract. Neither surface is a
fallback implementation for the other.

The current global index is already source-independent at query time: one
canonical search spans every authorized dataset/platform and uses Elasticsearch
with the existing PostgreSQL degradation path. Ingest identity is currently
`(datasetId, platform, objectType, externalId)`, however, so the same native post
arriving from `night-all.compat.v1`, another Night-All dataset and a future direct
connector can still appear more than once across datasets. That is an explicit
current limitation, not something the search route should hide with fuzzy text
deduplication.

The next multi-source indexing phase is ingest-time identity resolution, not API
fan-out:

1. every connector writes immutable raw evidence plus its source-local external
   identity and observation time;
2. a versioned identity registry maps high-confidence platform-native IDs to one
   Hub entity/content ID while retaining every source alias and lineage edge;
3. URL/content-hash similarity is only a scored candidate when a native ID is
   absent; uncertain candidates remain separate rather than being silently
   merged;
4. canonical current state applies versioned field precedence and freshness rules
   per object type, then emits one outbox projection event;
5. the Elasticsearch document and PostgreSQL fallback use the same resolved Hub
   identity, authorization scope and deterministic sort/cursor contract.

TikHub, JustOne, Night-All and file/database sources then share the same internal
connector -> raw observation -> identity resolution -> canonical -> outbox ->
projection path. Search remains a single Hub-owned index query, independent of
which connector supplied the winning or corroborating observation.

Any future desensitization is a separate, versioned Hub processing/projection
contract. It may consume compatibility ingest evidence, but it must not rewrite the
compatibility response or its exact snapshots. This decision is scoped to the
three namespaced routes and does not change `/api/v1/data/search`.

### 5. Model Telegram adjacency as conversation evidence

Some Night-All records include `prev_message`, `current_message` and
`next_message`. These fields describe observed chronological neighbors, not reply
or topic relationships. The current compatibility ingest retains embedded context
as raw evidence and indexes only the top-level record; it does not manufacture
duplicate canonical messages.

A later versioned projector may materialize this evidence as follows:

- create or upsert message nodes keyed internally by
  `(platform, conversationKey, messageId)`; a context-only node is a stub that a
  later full observation may promote;
- create directed `chronological_next` edges `prev -> current` and
  `current -> next` only when both endpoints have stable IDs and the same
  conversation key;
- keep `reply_to`, `thread/topic` and album/grouped edges independent; adjacency
  must never populate `replyToMessageId`;
- expose a versioned `contextWindow` projection with `before[]`, `current`,
  `after[]` and per-side completeness/availability, rather than making the
  three-field sample the permanent canonical schema;
- treat missing `prev_message`/`next_message` as “not observed”, not proof that
  the conversation begins or ends, and never infer IDs by numeric adjacency.

Input import strips at most one leading UTF-8 BOM (`U+FEFF`) before JSON parsing
while retaining original bytes/hash as lineage evidence. A display label such as
`私人群组` is never an identity. Prefer a normalized explicit Telegram chat ID;
otherwise use a validated public handle or the private `t.me/c/<chat-id>` /
`rawGroupName` identity in a source-scoped internal key. Private chat coordinates
must be exposed, if at all, only as an authorized opaque Hub conversation ID.
Unstable or conflicting keys keep the neighbor fields as raw evidence and do not
create canonical edges.

### 6. Migrate providers behind the Hub boundary

TikHub, JustOne or another upstream can later become a direct Hub connector without
changing the three public route paths. Migration is per platform + operation:

1. implement the same internal connector result and evidence contract;
2. shadow with authorized, bounded fixtures or calls and compare original legacy
   envelopes plus canonical records;
3. cut over routing server-side only after parity, quota, timeout and rollback
   gates pass;
4. retain Night-All for platforms whose routing, paid token or business policy has
   not moved;
5. roll back by connector policy, without changing API keys or clients.

Direct connectors still cannot expose provider selection or credentials to public
callers and must use raw -> canonical PostgreSQL -> outbox -> projection. This
change is isolated to MX Insight Hub and must not alter Launcher/MX-H2I login,
networking, users or DNS.

## Consequences

- Existing clients can migrate by changing only the base path while retaining the
  legacy body aliases and response envelope.
- Hub authentication, grants, quota, idempotency and evidence apply
  even though Night-All continues to own upstream provider policy.
- Exact complete snapshots improve availability without presenting partial,
  different-query or canonical data as a live legacy result.
- The compatibility facade is deliberately narrower than Night-All and is not a
  general-purpose provider escape hatch.
- Canonical search and future direct connectors can evolve independently behind
  versioned contracts.
- Telegram neighbor reconstruction requires a later schema/projector version and
  stable conversation identity; the current v1 projection remains unchanged.
