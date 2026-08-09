# Public API v1

Base path: `/api/v1`. Authentication uses `Authorization: Bearer <mx key>` or `x-api-key`.

## Capabilities

```http
GET /api/v1/data/capabilities
```

Returns only platforms/capabilities granted to the authenticated consumer. Provider names and internal endpoint IDs are omitted.

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

Current v1 accepts one explicit platform per request. Platform names `all` (case-insensitive) and `*` are invalid; cross-platform fan-out will be a job API so one slow platform cannot hold an unbounded synchronous request.

`query` must be non-blank and at most 500 characters after trimming. `cursor`, when present, must be a non-blank opaque string of at most 1,024 characters. Clients must return the cursor from the previous response unchanged rather than constructing or decoding it.

The server rejects or ignores internal-only fields including `businessId`, `provider`, `endpointId`, `availabilityMode`, `includeRaw`, and arbitrary provider params.

Successful responses preserve the stable Night-All data-search envelope and add:

- `x-request-id`: transport correlation ID;
- `x-mx-insight-request-id`: durable Hub request ID;
- `idempotent-replay: true|false`.

## Telegram monitor history

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

The following is a **contract illustration, not a production sample**. The real
`tg_monitor_*` schema/rows were not available when this contract was written;
none of these identifiers, values or populated optional fields should be read
as evidence about production data.

```json
{
  "data": {
    "items": [
      {
        "id": "-1001234567890:42",
        "platform": "telegram",
        "objectType": "message",
        "contentType": "text",
        "title": null,
        "text": "normalized message text",
        "url": null,
        "author": { "id": "12345", "name": "Example" },
        "relations": {
          "chatId": "-1001234567890",
          "messageId": "42",
          "replyToMessageId": "41"
        },
        "attributes": {},
        "metrics": { "views": 10 },
        "eventTime": "2026-08-09T08:00:00.000Z",
        "collectedAt": "2026-08-09T08:01:00.000Z",
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
`relations`, `attributes` and `metrics`; it never returns `extensions`, raw
source rows, DSNs, connector/source lineage, provider credentials,
`businessId`, endpoint IDs or availability policy. Each validated read reserves
one request against the consumer's `telegram.maxRequests` window and commits
`max(1, returnedCount)` units to `/api/v1/usage`. The evidence retains counts
and latency but not a second copy of the response body. A failed local read is
released; an ambiguous usage commit remains `unknown` for reconciliation. The
client does not send an idempotency key for these safe `GET` requests, so a
retry is a new request and may consume another quota slot.

## Planned capabilities

Not implemented. Recorded here so the client-facing shape stays stable once the upstream capabilities land. Each keeps the same auth (`Authorization: Bearer <API key>`), grant checks, quota accounting and freshness envelope as `search`.

```http
POST /api/v1/data/post          { "platform": "...", "postId": "..." }
POST /api/v1/data/comments      { "platform": "...", "postId": "...", "pageSize": 20, "cursor": "..." }
POST /api/v1/data/entities/search  { "platform": "...", "query": "...", "mode": "match|prefix", "pageSize": 20 }
```

`post` and `comments` depend on upstream `post_detail`/`post_comments` capabilities that the versioned Night-All data contract does not yet expose; see [Night-All integration](../architecture/night-all-integration.md). Until they exist under readiness governance these routes stay unpublished rather than silently proxying an ungoverned legacy route.

`entities/search` is served from the Hub's own entity projection and does not call Night-All, so it carries no provider cost but is rate limited independently; see §4.4 of [Data platform storage and serving](../architecture/data-platform-storage-and-serving.md). Identifier lookups take `postId` as the caller-facing name; platform-specific aliases such as `noteId`, `awemeId` or `tweetId` are normalized internally and are not part of this contract.

## Request status

```http
GET /api/v1/requests/{requestId}
```

Only the owning consumer can read the record. An `unknown` state means the upstream outcome is ambiguous; the caller must not automatically repeat the request with a new key.

## Usage

```http
GET /api/v1/usage?from=2026-08-01T00:00:00Z&to=2026-08-04T00:00:00Z
```

Returns only the authenticated consumer’s usage.

## Error semantics

| Status | Meaning |
| --- | --- |
| `400` | Invalid field, missing idempotency key, or page limit exceeded. |
| `401` | Missing, invalid or revoked API key. |
| `402` | Reserved for insufficient production credit. |
| `403` | Platform/capability is not explicitly granted. |
| `404` | Resource or caller-owned request does not exist. |
| `409` | Idempotency conflict, in-progress request, or unknown prior outcome. |
| `429` | Request/concurrency/period quota exhausted. |
| `502` | Definite Night-All rejection or ambiguous upstream outcome. |
| `503` | A required stored-data runtime is unavailable. |

Clients should retry only safe `GET` operations and documented pre-dispatch failures. Costly `POST` retry always reuses the same idempotency key.

For Telegram history, `400` includes `invalid_request`, `invalid_cursor`,
`page_size_exceeded` and `unsupported_fields`; `401` is `api_key_required` or
`invalid_api_key`; `403` is `platform_not_granted`; `429` is
`quota_exceeded`; and `503` is `stored_data_unavailable`. A retry must reuse the
same cursor but is separately metered. A page is a view of the current
canonical dataset, not a frozen snapshot across a long multi-page traversal.
