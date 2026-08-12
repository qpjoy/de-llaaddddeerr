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

This route requires the consumer's explicit `nlp.tokenize` capability grant;
it does not imply or require any platform grant. The body is a strict object
containing only `text`. Text is trimmed, must contain a Unicode letter or
number, may not contain unsafe control characters, and is limited to 4,096
characters. The complete JSON body is additionally bounded at 16 KiB.

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

Current Hub v1 accepts one explicit platform per request. Platform names `all`
(case-insensitive) and `*` are invalid. Night-All already has a grouped
multi-platform response, but the Hub does not expose it yet because its grants,
policies, idempotency and usage ledger are enforced per platform. A future
bounded endpoint may return per-platform `results[]` and independent cursors;
large/`all` fan-out belongs in a job API. It must not be represented as one
fictional `multi` platform or one globally mixed cursor.

`query` must be non-blank and at most 500 characters after trimming. `cursor`, when present, must be a non-blank opaque string of at most 8,192 characters. Clients must return the cursor from the previous response unchanged rather than constructing or decoding it.

The server rejects or ignores internal-only fields including `businessId`, `provider`, `endpointId`, `availabilityMode`, `includeRaw`, and arbitrary provider params.

Successful responses preserve the stable Night-All data-search envelope and add:

- `x-request-id`: transport correlation ID;
- `x-mx-insight-request-id`: durable Hub request ID;
- `idempotent-replay: true|false`.

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

Search pagination uses a version-2, HMAC-signed opaque cursor, limited to 8,192
characters. The signature binds the cursor to the normalized query, scope,
filters, match mode and page size. Do not decode or construct it, and do not
change those inputs while paging. Each distinct page request needs its own
stable idempotency key; replay that exact page body with the same key.

Elasticsearch supplies ranked full-text results when available. It opens a PIT
whose keep-alive is renewed for two minutes on each page, orders by
`_score`, `eventTime`, then `id`, and advances with `search_after`. Hub requests
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
| `502` | Definite Night-All rejection or ambiguous upstream outcome. |
| `503` | A required stored-data or tokenizer runtime is unavailable. |

Clients should retry only safe `GET` operations and documented pre-dispatch failures. Costly `POST` retry always reuses the same idempotency key.

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
