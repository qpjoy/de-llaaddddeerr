# Night-All integration

## Source role

Night-All remains the first-party aggregation and intelligence source on the internal server. It calls TikHub, JustOne, RapidAPI, public feeds and crawlers; normalizes platform records; records source evidence; and owns upstream credentials and provider quotas.

MX Insight Hub does not duplicate or fork this logic. Its adapter calls a versioned private Night-All capability contract and converts it into a stable consumer contract.

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

## Platform readiness

Night-All exposes a broad 15-platform catalog, but catalog presence is not proof of a live production contract. Grant only platforms that have passed a real credential/endpoint/pagination verification. Automated deploy smoke must not call all paid platforms.

The Hub stores explicit grants such as `xhs` and `weibo`. A future “all platforms” action creates a versioned snapshot of currently approved platforms; it is not a wildcard.

## Night-All work that stays outside this repository

- internal service authentication middleware;
- provider credential encryption, rotation and redaction;
- the `CH` (Switzerland) versus `CN` (China) classification fix and historical reclassification;
- TikHub endpoint/capability contract fixtures and per-platform live verification;
- Night-All PostgreSQL PITR, artifact snapshot and restore drills;
- collection scheduler/worker ownership and single-writer cutover.

See the Night-All repository `specs/README.md`, `NIGHT_ALL_RUNTIME_AND_BOUNDARIES.md`, and `NIGHT_ALL_DATA_SEARCH_API_V1.md` for their current implementation status.
