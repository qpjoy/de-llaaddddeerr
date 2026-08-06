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
| `409` | Idempotency conflict, in-progress request, or unknown prior outcome. |
| `429` | Request/concurrency/period quota exhausted. |
| `502` | Definite Night-All rejection or ambiguous upstream outcome. |

Clients should retry only safe `GET` operations and documented pre-dispatch failures. Costly `POST` retry always reuses the same idempotency key.
