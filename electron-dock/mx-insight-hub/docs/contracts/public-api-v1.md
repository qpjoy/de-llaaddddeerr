# Open API v1

Base path: `/api/v1`. Authentication uses `Authorization: Bearer <mx key>` or `x-api-key`.

## Capabilities

```http
GET /api/v1/data/capabilities
```

Returns only platforms and generic capabilities granted to the authenticated
consumer. Generic capabilities are returned separately from `platforms`, for
example:

```json
{
  "data": {
    "platforms": [],
    "capabilities": [{ "capability": "nlp.tokenize", "ready": true }]
  }
}
```

Provider names and internal endpoint IDs are omitted.

## Tokenize text

```http
POST /api/v1/tools/tokenize
Authorization: Bearer <mx key>
Idempotency-Key: <caller-generated stable key>
Content-Type: application/json

{ "text": "吴恩达与人工智能" }
```

This route requires the consumer's `nlp.tokenize` capability grant; it does not
imply or require any platform grant. New consumers and existing consumers that
have never configured this capability receive it by default, while an
administrator may explicitly disable it. A valid issued API Key is always
required. The default policy is 1,000 requests per rolling 3,600-second window
for each consumer + capability; every API Key belonging to that consumer shares
the same window. The body is a strict object containing only `text`. Text is
trimmed, must contain a Unicode letter or number, may not contain unsafe control
characters, and is limited to 4,096 characters. The complete JSON body is
additionally bounded at 16 KiB.

```json
{
  "data": {
    "capability": "nlp.tokenize",
    "tokens": ["吴恩达", "与", "人工智能"],
    "actualBackend": "hanlp",
    "degraded": false,
    "errorCode": null
  },
  "requestId": "00000000-0000-4000-8000-000000000004"
}
```

`actualBackend` is the backend that produced this response, one of `hanlp`,
`jieba` or `bigram`; it is not inferred from configuration. `degraded=true`
means the preferred backend failed and a lower-quality backend produced the
tokens. `errorCode`, when present, is a bounded category and never contains an
upstream body, URL, credential or stack.

The request uses the same idempotency ledger as search. Replaying the same path
and body with the same key returns the stored bounded response without another
segmenter call or usage charge. Reusing that key with different text returns
`idempotency_conflict`. A successful request consumes one request from the
capability's `maxRequests/windowSeconds` policy and records at least one usage
unit, normally the number of returned tokens. The original input text is not
stored in usage evidence; the bounded public response is retained solely for
idempotent replay.

## Search

```http
POST /api/v1/data/search
Idempotency-Key: <caller-generated stable key>
Content-Type: application/json

{
  "platform": "xiaohongshu",
  "query": "AI Agent",
  "pageSize": 20,
  "cursor": "opaque-if-present"
}
```

This live/upstream-compatible route accepts one explicit platform per request.
Platform names `all` (case-insensitive) and `*` are invalid. Multi-platform live
fan-out still belongs in a bounded job because each provider call has its own
cost, failure and continuation. This does not prevent the separate
`/data/canonical/search` route from searching already-stored Hub data across
granted platforms in one canonical index; that route performs no provider
fan-out.

`query` must be non-blank and at most 500 characters after trimming. `cursor`, when present, must be a non-blank opaque string of at most 8,192 characters. Clients must return the cursor from the previous response unchanged rather than constructing or decoding it.

The server rejects or ignores internal-only fields including `businessId`, `provider`, `endpointId`, `availabilityMode`, `includeRaw`, and arbitrary provider params.

Successful responses preserve the stable Night-All data-search envelope and add:

- `x-request-id`: transport correlation ID;
- `x-mx-insight-request-id`: durable Hub request ID;
- `idempotent-replay: true|false`.

## Night-All legacy compatibility facade

These transitional routes preserve the three existing Night-All request aliases
and standard raw response envelope behind the Hub trust boundary:

| Hub route | Private Night-All operation | Required selector | Complete snapshot window |
| --- | --- | --- | ---: |
| `POST /api/v1/night-all/search/raw` | `/api/v1/search/raw` | `keyword`, `query`, `keywords` or `queries` | 15 minutes |
| `POST /api/v1/night-all/search/crawl` | `/api/v1/search/crawl` | a user/channel identifier | 1 hour |
| `POST /api/v1/night-all/search/user-info` | `/api/v1/search/user-info` | a user identifier | 1 hour |

All three require `Authorization: Bearer <mx key>` (or `x-api-key`), an
`Idempotency-Key` of 8–128 safe characters, one explicit platform, and that
platform's consumer grant. `all` and `*` are invalid. For example:

```http
POST /api/v1/night-all/search/raw
Authorization: Bearer <mx key>
Idempotency-Key: legacy-search-0001
Content-Type: application/json

{
  "platform": "xiaohongshu",
  "query": "AI Agent",
  "count": 20
}
```

The Hub derives Night-All `businessId` from the authenticated consumer. Omitting
it is preferred; a legacy client may send `businessId` or `business_id` only when
the value exactly matches that consumer. It is never an authentication input.
The private-hop service token and provider routing remain server-owned.
An administrator can bind a unique legacy `businessId` (maximum 128 characters)
when creating the Hub consumer; otherwise Hub generates one and the migrating
client must omit its former value. This initial binding has no public update API.

The body has an operation-specific allowlist. `raw` accepts the documented
keyword/query aliases and detail/comment flags; `crawl` accepts documented
user/channel aliases, activity types and `cacheMaxAgeHours`; `user-info` accepts
documented user aliases. Common pagination aliases are retained. `params` may
carry safe platform continuation values, but provider, credential, endpoint,
capability/moduleCode, business identity, availability, billing, token/auth,
timeout, debug and similar controls are rejected recursively. Legacy
`includeRaw:false` is accepted and removed before dispatch; `includeRaw:true` is
rejected. `params` also cannot override count/page size, concurrency, enrichment
or comment work.
Archive/fullArchive/allTweets, archiveLimit/totalCount, max*Pages,
pageCount/chunkSize/budget/crawlDepth and equivalent cost-amplification controls
also require a separate granted capability/policy and are rejected. Unknown
top-level fields are rejected.
The effective page size must not exceed the consumer's platform policy; the
upstream reference contract additionally caps `crawl` and `user-info` at 100.
Raw query count × page size and crawl identity count × page size × activity-type
count must also fit the policy work budget or the Hub returns
`400 work_budget_exceeded`. This bounds processed item work, not the exact number
of paid provider calls.

The response body preserves the Night-All legacy envelope:

```json
{
  "data": {
    "raw_info": "[]",
    "raw_data": "[]",
    "page": {
      "page": 1,
      "pageSize": 20,
      "returnedCount": 0,
      "hasMore": false,
      "nextCursor": null
    },
    "meta": { "resultCount": 0 }
  },
  "requestId": "night-all-request-id",
  "traceId": "night-all-trace-id"
}
```

`raw_info` and `raw_data` intentionally remain JSON strings. For these three
namespaced compatibility routes Hub currently performs no response-field
desensitization: provider, endpoint and other fields returned by Night-All remain
in the outer envelope and in objects encoded in those strings. This is separate
from the request-side rule above, which still rejects caller injection of
provider/token/credential controls. The body retains Night-All's `requestId` and
`traceId`; the current durable Hub request ID is separate:

- `x-mx-insight-request-id: <hub request UUID>`;
- `idempotent-replay: true|false`;
- `x-mx-insight-source-mode: live|stale`;
- `x-mx-insight-captured-at: <RFC3339 capture time>`;
- `Age: 0` for live delivery or the snapshot age for stale delivery;
- `Warning: 110 - "Response is stale"` only for stale delivery.

Every actual dispatch records separate Hub call evidence, including operation,
consumer, exact fingerprint, platform, latency, HTTP/business outcome, bounded
failure kind and Night-All correlation IDs. Night-All HTTP 200 with a substantive
warning or per-result error/`success=false` is a `partial` live success: it is
returned but never creates or replaces a compatibility snapshot. A lone
`STANDARD_PAYLOAD_EMPTY` warning is a deterministic complete empty result and does
replace last-good, preventing an older non-empty snapshot from resurfacing. Only
`complete` responses write last-good.

Each new `Idempotency-Key` may dispatch once; a committed live or stale delivery
is permanently replayed by that key, and a deliberately new live call needs a
new key. After network/timeout ambiguity, an unusable HTTP 2xx
content-type/JSON/envelope, or a definite upstream `502`, `503` or `504`, Hub may
return HTTP 200 from an unexpired complete snapshot for the exact consumer,
operation and full normalized request fingerprint. The snapshot retains the same
original Night-All application fields as the live response. Hub never uses a
similar query, another cursor/page, another consumer, a partial response,
canonical search records or a separately desensitized projection. The
body—including its Night-All request/trace IDs—is the historical snapshot; the
headers identify the current Hub request and capture age. The failed live attempt
remains separate evidence.

Without that exact snapshot:

| Upstream result | Public result |
| --- | --- |
| definite `400`, `404`, `409`, `422`, `429` | same HTTP status, safe `night_all_rejected` error |
| other definite non-2xx HTTP rejection | `502 night_all_rejected` |
| network error, Hub timeout, or unusable HTTP 2xx contract after dispatch | `502 upstream_outcome_unknown`; request becomes `unknown` |

An ambiguous request must not be automatically retried with a new key. A
dispatched compatibility error includes the durable Hub ID as
`error.details.requestId`; successful live/stale delivery carries it in
`x-mx-insight-request-id`. Use that ID with
`GET /api/v1/requests/{hub-request-id}`. A replay with the same key reports the
held unknown outcome. Hub does not emit `504` for its own timeout because it cannot
prove that a paid upstream did no work.

This facade is distinct from `/api/v1/data/search` and from canonical stored
search. Its complete/partial live payloads also enter the governed
`night-all.compat.v1` ingest dataset asynchronously in their original,
non-desensitized form, but ingest/search state never changes the already-delivered
legacy response. Response, exact snapshot and raw ingest therefore retain the same
unmasked source evidence in this compatibility slice. See
[ADR-0010](../adr/0010-night-all-compatibility-facade.md).

Future Hub desensitization must be a separate versioned processing/projection and
API contract. It cannot mutate or replace this compatibility response/snapshot.
This response-preservation rule applies only to the three namespaced routes and
does not change the `/api/v1/data/search` contract documented above.

## Hub canonical stored search

```http
POST /api/v1/data/stored/search
Idempotency-Key: <caller-generated stable key>
Content-Type: application/json

{
  "platform": "xiaohongshu",
  "query": "AI Agent",
  "datasetId": "night-all.search.v1",
  "objectType": "post",
  "pageSize": 20,
  "cursor": "opaque-if-present"
}
```

This route searches only Hub canonical data and never calls Night-All or another
provider. `platform` and `query` are required. `datasetId` and `objectType` are
optional exact logical filters. The strict body allowlist rejects physical
database/index names, SQL, Elasticsearch DSL/scripts and arbitrary parameters.
The response uses `contractVersion=mx-insight-hub.stored-search.v1` and reports
`source=hub` both for the response and each returned item. Connector lineage,
raw payloads, extensions and provider coordinates are not returned.

Authorization is currently **platform-grant only**. `datasetId` narrows results;
it is not a separate authorization grant. A consumer granted a platform can
search the complete Hub canonical corpus for that platform. Dataset-level or
tenant-row grants are not implemented and must not be inferred from this filter.

Elasticsearch is the preferred ranked projection. A transport failure on the
first page uses the existing PostgreSQL substring fallback and reports
`searchMode=postgres` plus `search_projection_degraded`. A reachable cluster
that rejects the request is an error rather than a silent fallback. Pagination
uses an HMAC-signed opaque cursor bound to query, platform, datasetId, objectType
and page size; a later page requires a new idempotency key. Grant, policy, quota,
idempotency replay and usage evidence use the same per-platform ledger as
`POST /api/v1/data/search`.

## Unified canonical search

```http
POST /api/v1/data/canonical/search
Idempotency-Key: <caller-generated stable key>
Content-Type: application/json

{
  "query": "AI Agent",
  "platform": "telegram",
  "objectType": "message",
  "searchProfile": "canonical.balanced.v1",
  "pageSize": 20,
  "cursor": "opaque-if-present"
}
```

Only `query` is required. Omitting `platform` searches every platform currently
granted to the consumer; specifying it narrows the search and still requires
that grant. `datasetId` and `objectType` are optional exact logical filters.
The server always applies the authorized platform set in addition to those
filters, so a dataset identifier can never expand access.

`searchProfile` selects an immutable, server-owned query policy. It is not an
Elasticsearch analyzer name and the API never accepts arbitrary analyzer,
tokenizer, filter, index or DSL controls:

| Profile | Indexed representation and query rule |
| --- | --- |
| `canonical.balanced.v1` (default) | Raw text phrase **or**, when HanLP is healthy, all HanLP query terms matched with AND against the pre-segmented `*Hanlp` representation. If query segmentation degrades to Jieba/bigram, the server applies `canonical.phrase.v1` instead of comparing incompatible terms with HanLP postings. CJK bigram does not replace HanLP here. |
| `canonical.phrase.v1` | Ordered raw-text phrase only; highest precision. |
| `canonical.terms-all.v1` | Every pre-segmented query term must match; word order may differ. |
| `canonical.zh-recall.v1` | Balanced plus a lower-weight ordered CJK-bigram branch, providing segmentation-independent recall without returning to single-character OR. |
| `canonical.title-prefix.v1` | Bounded prefix lookup over titles, author names, handles, usernames and chat names. |

The current HanLP service loads one coarse model. A future “fine at index time,
coarse at search time” policy requires separately versioned segmenter models and
indexed fields; passing a request parameter cannot manufacture fine-grained
terms that were never indexed.

The route runs one query over the shared canonical current-state projection. It
does not call each source API and then concatenate per-source top-N lists. This
gives all matching datasets one BM25 scoring context, one deterministic
`_score/eventTime/id/_shard_doc` ordering and one PIT/search-after cursor. Source identity
is not an implicit relevance boost. Records intentionally preserved in separate
datasets remain separate results even if they share an external ID; the search
layer does not guess a cross-dataset survivor rule.
If Elasticsearch is unavailable on the first page, the same authorized filters
are applied to the PostgreSQL canonical table and the response reports
`search_projection_degraded`, `search_profile_degraded`, and
`search.appliedProfile=postgres.substring.v1`.

Responses use `contractVersion=mx-insight-hub.canonical-search.v1` and the same
customer-safe item projection as stored search. `scope.platforms` records the
actual sorted authorization scope. `pageInfo` includes `totalCount`,
`totalRelation`, `totalPages`, and the stable opaque cursor. The `search` object
reports requested/applied profiles and degradation. A cursor is signed over the
query, filters, page size, resolved profile, platform scope and bounded first-page
analysis state. Later pages reuse the same applied profile and tokens rather than
calling HanLP again; if grants or the profile change, restart from the first page.
The operation is metered under the
`data.canonical-search` usage scope. That bucket is independent of the legacy
single-platform search bucket and always uses the strictest request/page limit
and longest window across the consumer's complete current platform-grant set,
even when this request narrows `platform`. This keeps one stable policy on one
shared bucket instead of re-evaluating the same history against different
limits.

## Telegram stored data

### History

```http
GET /api/v1/data/telegram/chats?pageSize=50&from=2026-08-01T00:00:00Z
GET /api/v1/data/telegram/messages?chatId=-1001234567890&pageSize=50&cursor=<opaque>
```

These two read-only resources are served from Hub-owned canonical datasets, not
from the physical Night-All tables on each request:

| Resource | Hub dataset | Object type |
| --- | --- | --- |
| `chats` | `telegram.monitor.chats.v1` | `chat` |
| `messages` | `telegram.monitor.messages.v1` | `message` |

They intentionally remain monitor-specific compatibility APIs. SQLite imports
are separate canonical datasets (`telegram.sqlite.chats.v1` and
`telegram.sqlite.messages.v1`) and are not silently mixed into the history or
Telegram-specific search contracts.

Use the unified endpoint when the caller wants Telegram data regardless of
ingestion source. Omitting `datasetId` is what combines monitor and SQLite
records:

```http
POST /api/v1/data/canonical/search
Idempotency-Key: <stable-key>
Content-Type: application/json

{
  "platform": "telegram",
  "objectType": "message",
  "query": "agent",
  "searchProfile": "canonical.balanced.v1",
  "pageSize": 20
}
```

Use `/api/v1/data/stored/search` with an exact `datasetId` when a caller
deliberately wants just one Telegram source dataset.

The API key's consumer must have the explicit `telegram` platform grant. A
tenant ID, source-table name, provider, connector, database field, endpoint ID
or raw-payload switch is never accepted from the caller. `GET
/api/v1/data/capabilities` advertises `monitor_chats` and
`monitor_messages` under `telegram` when that consumer is granted the platform
and the stored-data runtime is available.

The two canonical datasets currently have no `tenant_id` or per-tenant row
scope. Consequently, every consumer with the `telegram` grant reads the same
complete chats/messages corpus; tenant/consumer isolation here covers API-key
ownership, the grant decision, policy, request quota and usage evidence, not a
different row subset. Tenant-specific Telegram delivery is not implemented and
would require a separately versioned dataset or explicit row-scope contract.

The complete query allowlist is:

| Field | Contract |
| --- | --- |
| `chatId` | Optional non-blank string, at most 256 characters. On `messages` it filters the normalized chat relation; on `chats` it matches the chat external ID. |
| `from` | Optional complete RFC3339/ISO date-time with `T`, seconds and `Z` or a numeric offset; `eventTime` is inclusive. Date-only and space-separated forms are rejected. |
| `to` | Same complete date-time form; `eventTime` is inclusive and may not precede `from`. |
| `pageSize` | Positive integer. Default is 50 or the consumer's lower policy limit; the effective maximum is the consumer's `telegram.maxPageSize`, never above the server default of 100. |
| `cursor` | Optional opaque string, at most 1,024 characters. Return `pageInfo.nextCursor` unchanged. |

Unknown query fields are rejected with `unsupported_fields`. In particular,
there is no free-text `q`, arbitrary sort, SQL, offset, raw export or caller
selected dataset. Results use descending `(eventTime, internal canonical ID)`
keyset pagination, so clients must not decode or construct cursors.

The following uses synthetic values to illustrate the contract; it is not a
production row.

```json
{
  "data": {
    "items": [
      {
        "id": "-1001234567890:42",
        "externalId": "-1001234567890:42",
        "platform": "telegram",
        "objectType": "message",
        "contentType": "text",
        "title": null,
        "text": "normalized message text",
        "url": null,
        "author": {
          "id": "12345",
          "name": "Example",
          "username": "example_user"
        },
        "relations": {
          "chatId": "-1001234567890",
          "messageId": "42",
          "replyToMessageId": "41"
        },
        "attributes": { "isOutgoing": false },
        "metrics": { "views": 10 },
        "media": {},
        "entities": [],
        "links": [],
        "eventTime": "2026-08-09T08:00:00.000Z",
        "collectedAt": "2026-08-09T08:01:00.000Z",
        "editedAt": null,
        "lineage": {
          "datasetId": "telegram.monitor.messages.v1",
          "origin": "hub-direct"
        },
        "dataVersion": "2"
      }
    ],
    "pageInfo": {
      "returnedCount": 1,
      "hasMore": true,
      "nextCursor": "opaque"
    }
  },
  "requestId": "transport-correlation-id"
}
```

This is a strict projection. The server may omit unpopulated keys inside
`relations`, `attributes`, `metrics`, `media` and `entities`; it never returns
`extensions`, raw source rows, DSNs, physical host/database/table/provider
identity, provider credentials, collector accounts, `businessId`, Night-All
endpoint IDs or availability policy. `lineage` is a Hub-owned logical
dataset/origin label, not a path back to the physical source. `links` is always
the empty array in this contract version: the source probe established only
that it is an array, not an allowlist-safe schema for each member. Link objects
remain internal until a field-level review explicitly versions their public
projection. Each validated read reserves one request against the consumer's
`telegram.maxRequests` window and commits
`max(1, returnedCount)` units to `/api/v1/usage`. The evidence retains counts
and latency but not a second copy of the response body. A failed local read is
released; an ambiguous usage commit remains `unknown` for reconciliation. The
client does not send an idempotency key for these safe `GET` requests, so a
retry is a new request and may consume another quota slot.

Mapped source tombstones remain in canonical/revision evidence but are excluded
from history, content search and entity search.

### Telegram chronological context (planned versioned projection)

Some upstream records contain `prev_message`, `current_message` and
`next_message`. These mean “observed chronological neighbor” only. They are not a
reply chain, thread/topic or media-album relation. Current compatibility ingest
indexes the top-level record and retains embedded neighbors as raw lineage; the
current v1 history/search projections above do **not** expose a `contextWindow` and
do not index the embedded objects as duplicate messages.

The target projector will upsert conversation nodes by the internal identity
`(platform, conversationKey, messageId)` and create explicit directed
`chronological_next` edges `prev -> current -> next`. A context-only node is a
stub, later promotable by a full observation. An edge is accepted only when both
stable message IDs resolve to the same conversation; reply/thread fields remain
independent. Missing prev/next means “not observed”, not first/last message, and
the Hub never guesses a neighbor from numeric message-ID adjacency.

A future public contract may project verified edges as a generalized window:

```json
{
  "contextWindow": {
    "before": [],
    "current": { "id": "opaque-message-id" },
    "after": [],
    "completeness": { "before": "unknown", "after": "unknown" }
  }
}
```

That field requires a new version; this example is a design direction, not a v1
response promise. Importers remove at most one leading UTF-8 BOM (`U+FEFF`) before
parsing while retaining the original bytes/hash as lineage. `groupName="私人群组"`
is display text and cannot identify a conversation: multiple private groups share
it. Prefer a normalized Telegram chat ID, then a validated public handle. A
private `t.me/c/<chat-id>` or `rawGroupName` is source-scoped internal key material
and must be exposed, if ever authorized, only as an opaque Hub conversation ID.
Unstable/conflicting keys keep neighbor data as raw evidence and create no edge.

### Night-All-v1-compatible stored search

The standard search route recognizes `platform=telegram` and serves stored Hub
messages locally; it does not call Night-All or TGStat:

```http
POST /api/v1/data/search
Idempotency-Key: <stable-key>
Content-Type: application/json

{ "platform": "telegram", "query": "agent", "pageSize": 20, "cursor": "<opaque>" }
```

For Telegram-specific filters use:

```http
POST /api/v1/data/telegram/search
Idempotency-Key: <stable-key>
Content-Type: application/json

{
  "query": "agent",
  "scope": "messages",
  "chatId": "-1001234567890",
  "authorId": "12345",
  "from": "2026-08-01T00:00:00Z",
  "to": "2026-08-10T00:00:00Z",
  "matchMode": "full_text",
  "pageSize": 20,
  "cursor": "<opaque>"
}
```

`query` is required and limited to 500 characters. `scope` is
`messages` (default), `chats` or `all`. `chatId` and `authorId` are exact
normalized identities. Time bounds are inclusive complete RFC3339 values.
Only `full_text` is implemented; callers cannot send ES DSL, SQL, arbitrary
fields, provider parameters or a physical dataset/source name.

The response uses `contractVersion: night-all.data-search.v1`, including the
familiar `platform`, `query`, `items`, `pageInfo`, `status`, `warnings` and
`meta` fields. Item fields remain
`id/externalId/platform/contentType/url/title/text/publishedAt/collectedAt/
author/metrics/media/source`. Every item reports
`source={provider:null, endpointId:"hub-canonical-search"}`. Response metadata
reports `sourceProvider="mx-insight-hub"` and
`endpointId="hub-canonical-search"`. These are fixed serving-plane labels; they
never identify the registered PostgreSQL provider. Night-All-v1 metric keys are
non-negative numbers or `null`; invalid/negative source sentinels are normalized
to `null` instead of leaking a response that fails the compatibility schema.

Search pagination uses a version-3, HMAC-signed opaque cursor, limited to 8,192
characters. The signature binds the cursor to the normalized query, scope,
filters, match mode, page size and bounded first-page analysis state. Later
pages reuse the same applied profile, tokens and backend instead of calling the
segmenter again. Do not decode or construct it, and do not change those inputs
while paging. Each distinct page request needs its own stable idempotency key;
replay that exact page body with the same key.

Elasticsearch supplies ranked full-text results when available. It opens a PIT
whose keep-alive is renewed for two minutes on each page, orders by
`_score`, `eventTime`, then `id`, plus the PIT-provided `_shard_doc` tiebreaker,
and advances with `search_after`. Hub requests
`pageSize + 1` rows to determine `hasMore`; traversal neither uses a result
`total` nor stops at the Elasticsearch 10,000-hit window. Clients should page
promptly because an expired PIT returns `410 search_cursor_expired`; restart
from a cursor-less first page with a new idempotency key.

If Elasticsearch is disabled or unreachable on the first page, Hub uses
PostgreSQL substring search and includes a `search_projection_degraded`
warning. PostgreSQL orders by `event_time DESC NULLS LAST, id DESC` and uses a
NULL-aware keyset predicate, never `OFFSET`. The chosen mode is fixed in the
cursor: a PostgreSQL cursor stays on PostgreSQL, while an existing Elasticsearch
cursor never silently falls back. Temporary Elasticsearch unavailability for
that cursor returns `503 search_cursor_unavailable`; retry the same page and
cursor later. The response deliberately has no `meta.searchMode`; degradation
is communicated only through `warnings`. Canonical availability and history
are unchanged. This local search makes zero Night-All/provider calls, but it is
still grant/policy/usage controlled and stores its response for idempotent
replay.

If Elasticsearch remains available but HanLP query analysis degrades, the
server applies raw phrase instead of comparing fallback tokens with the
pre-segmented field and includes `search_profile_degraded`. Telegram's public
envelope intentionally reports only the warning; detailed tokens/backend stay
on the Admin Data Center Search Lab.

### Fuzzy Telegram entities

```http
GET /api/v1/data/telegram/entities/search?query=example&pageSize=20
```

This searches author names/usernames and chat titles/usernames and returns a
ranked union of `{entityType: author|chat, ...}` items plus `pageInfo` and
`searchMode`. ES uses the governed name/prefix/CJK projection; PostgreSQL uses
trigram/substring fallback. The endpoint accepts only `query` (required, at
most 200 characters) and `pageSize` (at most the consumer policy/server limit).
It is a metered safe `GET`, so it does not take an idempotency key and each
retry is a new request.

## Planned capabilities

Not implemented. Recorded here so the client-facing shape stays stable once the upstream capabilities land. Each keeps the same auth (`Authorization: Bearer <API key>`), grant checks, quota accounting and freshness envelope as `search`.

```http
POST /api/v1/data/post          { "platform": "...", "postId": "..." }
POST /api/v1/data/comments      { "platform": "...", "postId": "...", "pageSize": 20, "cursor": "..." }
```

`post` and `comments` depend on upstream `post_detail`/`post_comments` capabilities that the versioned Night-All data contract does not yet expose; see [Night-All integration](../architecture/night-all-integration.md). Until they exist under readiness governance these routes stay unpublished rather than silently proxying an ungoverned legacy route.

Identifier lookups take `postId` as the caller-facing name; platform-specific
aliases such as `noteId`, `awemeId` or `tweetId` are normalized internally and
are not part of this contract. Cross-platform generic entity search remains a
future capability; the Telegram-specific entity route above is implemented.

## Request status

```http
GET /api/v1/requests/{requestId}
```

Only the owning consumer can read the record. Data calls identify their
`platform`; generic tools identify their `capability`. Exactly one is present.
An `unknown` state means the outcome is ambiguous; the caller must not
automatically repeat the request with a new key.

## Usage

```http
GET /api/v1/usage?from=2026-08-01T00:00:00Z&to=2026-08-04T00:00:00Z
```

Returns only the authenticated consumer’s usage. Existing data usage remains
under `byPlatform`; generic tools are reported separately under `byCapability`.

## Error semantics

| Status | Meaning |
| --- | --- |
| `400` | Invalid field, missing idempotency key, or page limit exceeded. |
| `401` | Missing, invalid or revoked API key. |
| `402` | Reserved for insufficient production credit. |
| `403` | Platform/capability is not explicitly granted. |
| `404` | Resource or caller-owned request does not exist. |
| `409` | Idempotency conflict, in-progress request, or unknown prior outcome. |
| `410` | A search cursor's Elasticsearch PIT has expired; restart from the first page. |
| `429` | Request/concurrency/period quota exhausted. |
| `502` | Safe Night-All 5xx/contract rejection, or ambiguous upstream outcome. |
| `503` | A required stored-data or tokenizer runtime is unavailable. |

Clients should retry only safe `GET` operations and documented pre-dispatch failures. Costly `POST` retry always reuses the same idempotency key.

For the Night-All compatibility facade specifically, upstream
`400/404/409/422/429` keeps its status, while other definite upstream errors map to
`502 night_all_rejected`. A network error, Hub timeout, or unusable HTTP 2xx
content-type/JSON/envelope maps to `502 upstream_outcome_unknown`, not `504`; the
request becomes `unknown`. When an unexpired exact complete snapshot exists, those
ambiguous outcomes or a real non-2xx `502/503/504` instead return a successful
stale response with the source/age headers documented above. Partial HTTP 200 is
returned live and never replaced by stale.

Tokenizer errors add `capability_not_granted`, `tokenizer_unavailable` and
`tokenizer_invalid_response`. Any segmenter exception is mapped to a fixed safe
message; upstream response bodies and credentials are never copied into the
client error.

For Telegram history, `400` includes `invalid_request`, `invalid_cursor`,
`page_size_exceeded` and `unsupported_fields`; `401` is `api_key_required` or
`invalid_api_key`; `403` is `platform_not_granted`; `429` is
`quota_exceeded`; and `503` is `stored_data_unavailable`. A retry must reuse the
same cursor but is separately metered. A page is a view of the current
canonical dataset, not a frozen snapshot across a long multi-page traversal.

Telegram stored search adds `idempotency_key_required`,
`invalid_idempotency_key`, `unsupported_match_mode`, `request_in_progress`,
`idempotency_conflict`, `request_outcome_unknown` and
`stored_search_unavailable`. It also returns `search_cursor_expired` with `410`
when an Elasticsearch PIT no longer exists, or `search_cursor_unavailable` with
`503` when an existing Elasticsearch cursor cannot currently be served. The
latter is retryable with the same cursor and page idempotency key; neither case
silently switches that cursor to PostgreSQL. Entity search uses the history
authentication and quota errors plus `stored_search_unavailable`. A first-page
PostgreSQL search fallback is a successful degraded response with an explicit
warning, not a `503`.
