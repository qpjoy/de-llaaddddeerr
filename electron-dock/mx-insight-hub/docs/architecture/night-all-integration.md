# Night-All integration

## Source role

Night-All remains the first-party aggregation and intelligence source on the internal server. It calls TikHub, JustOne, RapidAPI, public feeds and crawlers; normalizes platform records; records source evidence; and owns upstream credentials and provider quotas.

MX Insight Hub does not duplicate or fork this logic. Its adapter calls a versioned private Night-All capability contract and converts it into a stable consumer contract.

For Internal production, keep the host Night-All as the only writer and call it through a workload-authenticated host facade/private Service. A second full Docker Night-All is for isolated local snapshot testing, not a production read shortcut and never shares production PG/Redis or scheduler ownership.

## Current adapter

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

## Idempotency and unknown outcomes

Night-All’s current search facade is not guaranteed to be end-to-end idempotent: a search may call a paid provider and write audit/cache/observation records. Therefore:

1. Hub stores the caller idempotency key and request fingerprint before dispatch.
2. Same key + same fingerprint replays a committed response.
3. Same key + different fingerprint returns `409 idempotency_conflict`.
4. Definite Night-All HTTP rejection releases the reservation.
5. A connection loss/timeout after dispatch is marked `unknown` immediately; the reservation stays held and clients must query request status instead of retrying automatically.
6. If the Hub process exits while a request is still `reserved`, its lease expires and a later reaper pass marks it `unknown` with `reservation_lease_expired`. Lease expiry is not evidence that Night-All did no work, so it does not release or retry the request.

The long-term fix is to pass a Hub request ID into Night-All and make Night-All persist a unique dispatch/result record.

The current Hub also has no durable same-query cache or request coalescing. The target fresh/stale/live decision, per-capability TTL, singleflight lease and historical fallback are defined in [Ingestion, cache and fallback](ingestion-cache-and-fallback.md). A stale response must include its age/source mode; a semantically different historical query must never be returned as if it were live.

## Platform readiness

Night-All exposes a broad 15-platform catalog, but catalog presence is not proof of a live production contract. Grant only platforms that have passed a real credential/endpoint/pagination verification. Automated deploy smoke must not call all paid platforms.

Before deployment, probe the actual Internal revision and route. The local Night-All checkout contains the new `/api/v1/data/search` and durable-cursor work, but repository presence is not proof that the host has that commit/migration. The adapter must also validate the response business status because Night-All can report a failed/partial platform result inside an HTTP 200 envelope, and readiness must inspect dependency sub-status rather than a top-level `ok` alone.

The Hub stores explicit grants such as `xhs` and `weibo`. A future “all platforms” action creates a versioned snapshot of currently approved platforms; it is not a wildcard.

Observed on Internal (2026-08-06): every platform in `/api/v1/data/capabilities` reports `degraded` with reason `endpoint_degraded`, so `ready_only` search fails closed with `503 DATA_PLATFORM_NOT_READY`. Per the upstream spec a platform is promoted to `ready` only when a successful live call is recorded no earlier than the contract version it belongs to (`last_success_at >= contract_updated_at`); re-verification is required whenever the endpoint path/params/schema change. Hub-side grants and the Admin "platform enabled" view are authorization state and say nothing about upstream readiness, so the Admin console must surface the upstream capability status separately instead of implying a granted platform can serve data.

## Upstream capability coverage

The versioned `/api/v1/data/*` contract currently fixes `capability` to `search_posts`. Item lookup, profile lookup and comments exist only on the older `/api/v1/search/post-detail`, `/api/v1/search/post-comments` and `/api/v1/search/user-info` routes, which are outside the readiness/contract-freshness governance that `ready_only` depends on.

Therefore the Hub cannot yet offer detail/comments through the same stability guarantees as search. The target is to extend the upstream data contract with `post_detail`, `post_comments` and `profile` capabilities so they inherit catalog readiness, opaque cursors and stable fields. Proxying the legacy routes is acceptable only as an explicitly labelled transitional path, and such responses must be marked as coming from an ungoverned capability rather than presented as contract-stable.

## Night-All work that stays outside this repository

- internal service authentication middleware;
- provider credential encryption, rotation and redaction;
- the `CH` (Switzerland) versus `CN` (China) classification fix and historical reclassification;
- TikHub endpoint/capability contract fixtures and per-platform live verification;
- Night-All PostgreSQL PITR, artifact snapshot and restore drills;
- collection scheduler/worker ownership and single-writer cutover.

See the Night-All repository `specs/README.md`, `NIGHT_ALL_RUNTIME_AND_BOUNDARIES.md`, and `NIGHT_ALL_DATA_SEARCH_API_V1.md` for their current implementation status.
