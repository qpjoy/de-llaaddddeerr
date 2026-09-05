# External data platform gateway operations

Status: JustOne ecommerce product search implemented; PostgreSQL required for durable analytics, archive,
snapshot and canonical lineage.

Related decision: [ADR-0013](../adr/0013-external-data-platform-gateway.md).

## 1. Operational boundary

This gateway handles paid, realtime external acquisition separately from scheduled cleaning jobs. Its first
provider is JustOne, but public callers use only the Hub-owned
`POST /api/v1/data/ecommerce/products/search` contract and the `ecommerce` grant.

The feature is additive:

- an absent JustOne credential disables only new JustOne dispatches;
- exact last-good snapshots may remain available until their stale deadline;
- Hub stored search, cleaning jobs and canonical data continue independently;
- Launcher, SessionGate, MX-H2I login, WireGuard, DNS and user networking have no dependency on this
  connector's readiness.

Normal health/smoke must not call the paid interface. A live smoke requires an explicit operator decision.

## 2. Activation checklist

1. Run the normal migration workflow and verify migrations `051_external_platform_gateway.sql` and
   `052_external_platform_credentials.sql` are applied.
   Do not create or patch the `external_platform` tables by hand.
2. Use PostgreSQL storage (`MX_INSIGHT_STORE=postgres` with `DATABASE_URL`). Memory mode is acceptable only
   for contract tests; it cannot be accepted as durable archive/lineage evidence.
3. Prefer **数据清洗中心 → 外部数据平台 → JustOne → API Key 管理** for a new or rotated key. The password
   input is never prefilled. Ordinary Admin responses expose only safe credential metadata; reveal/copy
   requires a second Admin Token check and the plaintext exists only in the open modal. Saving a key does
   not bypass the independent `MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED=1` release gate.
4. `MX_INSIGHT_JUSTONE_TOKEN` remains an environment fallback for rolling compatibility. Put it only in the
   public or combined data-plane process. The Admin process receives at most
   `MX_INSIGHT_JUSTONE_CONFIGURED=1`, cannot read that environment value, and therefore cannot reveal it.
   Re-entering the key in the UI deliberately migrates authority to the shared Hub credential store, which
   lets split public listeners resolve rotations on the next dispatch without a restart.
5. Treat PostgreSQL, WAL, logical dumps and restored copies as secret-bearing after UI-managed credentials
   are enabled. The key is isolated from routinely queried analytics tables, never belongs in source catalog
   notes, billing JSON, logs, curl files or browser storage, and is never returned by overview/detail APIs.
6. Review the bounded defaults before rollout:

   | Setting | Default | Purpose |
   | --- | ---: | --- |
   | `MX_INSIGHT_JUSTONE_TIMEOUT_MS` | 120000 | One dispatch deadline; maximum 120000 ms. |
   | `MX_INSIGHT_JUSTONE_FRESH_TTL_MS` | 60000 | Exact successful snapshot can avoid another call. |
   | `MX_INSIGHT_JUSTONE_STALE_TTL_MS` | 604800000 | Exact last-good fallback deadline. Keep at least the fresh TTL. |
   | `MX_INSIGHT_JUSTONE_MAX_CONCURRENCY` | 8 | Global in-process dispatch ceiling. |
   | `MX_INSIGHT_JUSTONE_MAX_CONSUMER_CONCURRENCY` | 2 | Per-consumer dispatch ceiling. |
   | `MX_INSIGHT_JUSTONE_CIRCUIT_FAILURES` | 3 | Consecutive failure threshold. |
   | `MX_INSIGHT_JUSTONE_CIRCUIT_OPEN_MS` | 60000 | Open-circuit cooldown. |

7. Grant `ecommerce` only to the intended consumer and set its request/window/page policy through the
   existing platform administration workflow. A source-catalog entry or API key alone does not grant access.
8. Leave `MX_INSIGHT_JUSTONE_BILLING_JSON` absent until a price book is reviewed. Current configuration
   accepts only `source=manual`; price records require a three-letter currency and `pricingAsOf`. A missing
   price, balance or free quota must remain null/unknown, not zero.
9. Start with one approved marketplace/query and one page. Verify public delivery, provider-call evidence,
   archive objects and the linked canonical ingest before widening grants or concurrency.

## 3. Management views and credential operations

The management page **数据清洗中心 → 外部数据平台** reads these Internal Admin endpoints:

```text
GET /internal/v1/admin/external-platforms?range=24h|7d|30d
GET /internal/v1/admin/external-platforms/justone?range=24h|7d|30d
```

Both retain the Admin-token-only source-management boundary. A Launcher session, including a platform admin
membership, is not sufficient. Unknown query fields fail with `400 unsupported_fields`; an unsupported range
fails with `400 invalid_range`.

The JustOne detail page also provides the only browser credential workflow:

- save/rotate through `PUT /internal/v1/admin/external-platforms/justone/credential` with `apiKey` and the
  currently displayed `expectedRevision`;
- reveal through `POST /internal/v1/admin/external-platforms/justone/credential/reveal`, re-entering the
  Admin Token in the request body;
- environment-managed keys are marked configured but not revealable; enter the value again to migrate it;
- successful save clears the input, and closing the reveal dialog clears both the reauthentication value and
  revealed key from component state;
- every JSON response uses `Cache-Control: no-store`; overview, detail and write responses never include the
  key. Do not automate the reveal endpoint or store its response.

```bash
export HUB_ADMIN_URL='http://127.0.0.1:18180'
read -rsp 'Hub Admin Token: ' HUB_ADMIN_TOKEN
printf '\n'

curl -sS \
  -H "x-mx-insight-admin-token: $HUB_ADMIN_TOKEN" \
  "$HUB_ADMIN_URL/internal/v1/admin/external-platforms?range=7d" \
  | jq '.data | {range, generatedAt, summary, providers}'

curl -sS \
  -H "x-mx-insight-admin-token: $HUB_ADMIN_TOKEN" \
  "$HUB_ADMIN_URL/internal/v1/admin/external-platforms/justone?range=7d" \
  | jq '.data | {provider, pipeline, capabilities, tenants, guardrails, costPlan}'
```

The overview is not a billing statement. `external_platform.gateway_requests` records Hub demand, while
`external_platform.provider_calls` records actual JustOne dispatches. Read these counters distinctly:

- `hubRequests`: demand accepted by the gateway ledger;
- `upstreamCalls`: actual JustOne dispatches;
- `avoidedUpstreamCalls`: fresh-cache, no-dispatch fallback, idempotent replay, duplicate suppression and
  circuit rejection;
- `billedCalls`: dispatches known to meet the provider's billed-success rule;
- `knownCostMinor` / `grossEstimatedCostMinor`: gross list-price estimate only where a reviewed unit
  price exists; it is not an actual net charge after free quota or discounts;
- `actualCostMinor`: provider-bill-backed net charge; remains `null` until such billing evidence is
  integrated;
- `unknownCostCalls`: billed calls whose monetary cost is not known.

`usage_requests` is the separate Hub-side operational meter. A `fresh_cache` request with a new
Idempotency-Key creates a new committed Hub usage record even though provider cost does not increase; an
`idempotent_replay` reuses the original request and creates neither. Customer monetary charging is a later,
append-only price-book/ledger layer and must not copy `provider_calls.cost_minor` as a customer price.

Success rates with no denominator are `null`. Quota, balance, reset time, cost forecast and recommendation
may also be null/unknown. The UI must preserve that state rather than rendering `0`, `100%`, “free” or an
estimated recharge amount.

## 4. Intentional public smoke

Use a dedicated test consumer with an `ecommerce` grant, a low quota and an approved non-production query.
Read the Hub API key without writing it to shell history. The first call below intentionally permits exactly
one paid upstream dispatch; do not put it in readiness, CI or a retry loop:

```bash
# Local Compose uses the combined listener on :18180. Internal Kubernetes uses
# the public listener on :18150; override this value there.
export HUB_PUBLIC_URL='http://127.0.0.1:18180'
read -rsp 'MX Insight API Key: ' HUB_API_KEY
printf '\n'
LIVE_KEY="external-live-$(uuidgen)"
CACHE_KEY="external-cache-$(uuidgen)"
REQUEST_BODY='{"marketplace":"jd","query":"approved smoke query"}'

LIVE_RESPONSE=$(curl -sS -D /tmp/mxih-external-live.headers -X POST \
  -H "Authorization: Bearer $HUB_API_KEY" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $LIVE_KEY" \
  -d "$REQUEST_BODY" \
  "$HUB_PUBLIC_URL/api/v1/data/ecommerce/products/search")

printf '%s\n' "$LIVE_RESPONSE" \
  | jq '{contractVersion, page: .data.page, freshness: .meta, requestId}'
sed -n '/^x-mx-insight-/Ip;/^idempotent-replay:/Ip;/^age:/Ip;/^warning:/Ip' \
  /tmp/mxih-external-live.headers

# Run before MX_INSIGHT_JUSTONE_FRESH_TTL_MS expires. A new key makes this a
# separately metered Hub request; the identical normalized body reuses Hub data.
CACHE_RESPONSE=$(curl -sS -D /tmp/mxih-external-cache.headers -X POST \
  -H "Authorization: Bearer $HUB_API_KEY" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $CACHE_KEY" \
  -d "$REQUEST_BODY" \
  "$HUB_PUBLIC_URL/api/v1/data/ecommerce/products/search")

printf '%s\n' "$CACHE_RESPONSE" \
  | jq '{contractVersion, page: .data.page, freshness: .meta, requestId}'
sed -n '/^x-mx-insight-/Ip;/^idempotent-replay:/Ip;/^age:/Ip;/^warning:/Ip' \
  /tmp/mxih-external-cache.headers
```

Delete the temporary header file after review according to the local workstation policy. It contains no API
key, but may contain request identifiers and timing evidence.

Acceptance for the pair:

- contract version is `mx-insight-hub.ecommerce-products.v1`;
- every item has only the provider-neutral product allowlist;
- `meta.sourceMode` and `x-mx-insight-source-mode` agree;
- capture/serve timestamps and non-negative age are present;
- `requestId` equals `x-mx-insight-request-id`.
- the first response is `live`, adding one `provider_calls` row and one Hub usage request;
- the second response is `fresh_cache`, has a different request ID but the same `capturedAt` and item payload,
  adds a second Hub usage request, and adds no provider call or provider cost;
- Admin metrics increase by `hubRequests=2`, `upstreamCalls=1`, `freshCache=1` and
  `avoidedUpstreamCalls=1`; `billedCalls=1` when the provider returns its documented charged-success result.

Reusing `LIVE_KEY` with the exact body is a third, different case: it returns `idempotent_replay` and adds
neither a new Hub usage reservation nor a provider call. If the first page returns `nextCursor`, request that
cursor with a **new** key. Never combine `page` and `cursor`, never expose/decode the cursor and never use a
live smoke loop.

## 5. Archive and lineage verification

The logical source directory is stored in `external_platform.archive_objects.archive_path`; it is not a host
directory:

```text
justone/{marketplace}/product-search/{endpointVersion}/{YYYY-MM-DD}/{responses|items}/{sha256}.json
```

Use read-only SQL from an approved operator workstation. Do not copy `raw_payload` into tickets or chat:

```sql
SELECT id,
       marketplace,
       outcome,
       billed,
       cost_kind,
       cost_minor,
       currency,
       item_count,
       error_code,
       started_at,
       completed_at
FROM external_platform.provider_calls
ORDER BY started_at DESC
LIMIT 20;

SELECT provider_call_id,
       object_kind,
       marketplace,
       endpoint_version,
       captured_date,
       archive_path,
       response_pointer,
       source_key,
       payload_sha256
FROM external_platform.archive_objects
ORDER BY created_at DESC
LIMIT 50;

SELECT external_platform_call_id, count(*)
FROM ingest.ingest_runs
WHERE external_platform_call_id IS NOT NULL
GROUP BY external_platform_call_id
ORDER BY external_platform_call_id DESC
LIMIT 20;
```

For each actual call expect one response archive/object even when the page is empty or unusable. Item archive
count may be zero. `payload_sha256` is content evidence, while `(provider_call_id, item_ordinal)` is the
per-call uniqueness boundary. Do not infer missing data from a zero item count without inspecting the
response contract state and call outcome.

Canonical ingestion for a successful normalized call uses dataset `ecommerce.products.v1`, platform
`ecommerce`, object type `product`, and identity `{marketplace}:{nativeProductId}`. It queues an ingest job
bound to the provider call; the database uniqueness fence permits at most one linked ingest run. Expect that
run only after the worker accepts the job—rejected/unknown calls are call evidence, not canonical product
input. Repeated query, page and rank do not create a new product identity. PostgreSQL is authoritative.
Elasticsearch lag or outage does not invalidate the committed call/archive/canonical evidence; repair
projection through the existing outbox workflow rather than replaying a paid call.

## 6. Freshness, paging and anomaly checks

The exact response snapshot key is consumer + operation + normalized request fingerprint. It includes
contract version, marketplace, normalized query, page, sort, price and a fingerprint of private continuation
state. Never use a cache hit as evidence that a different query or consumer is fresh.

For a client returning from page two to page one:

- the same page-one key replays the original committed result indefinitely;
- a new page-one key may receive `fresh_cache` while the exact snapshot is fresh;
- after the fresh TTL, a new key may create a new paid dispatch;
- every next-page request uses a new key and the prior response's opaque cursor.

This makes transport retry and user navigation predictable. It does not promise that repeatedly changing keys
will never spend: quotas, exact fresh cache, the cross-key dispatch lease, concurrency and circuit breaker are
the bounded protection layers.

Monitor per tenant and endpoint for:

- Hub-request growth without user/tenant growth;
- low cache/replay ratio for identical request fingerprints;
- repeated `request_in_progress` or duplicate suppression;
- rapid page-one calls after the fresh TTL;
- high `stored_fallback`, unknown outcome or unusable-success counts;
- one tenant dominating Hub requests or actual calls;
- billed calls with unknown cost.

Do not invent a universal alert threshold before observing a normal baseline. When abuse is credible, first
reduce the affected consumer's `ecommerce` quota/concurrency policy or revoke its grant through the governed
admin workflow. Do not change global login/network settings and do not add an automatic paid retry.

## 7. Cost and free-quota planning

The current release has no verified JustOne balance/price/free-quota API integration. The
`external_platform.quota_snapshots` table reserves the future evidence model, but the UI uses only reviewed
configuration today. Do not scrape a browser dashboard or copy an undocumented value into production.

Keep billing unknown unless all required evidence exists:

1. reviewed source and `pricingAsOf`;
2. currency;
3. unit price for every endpoint included in the forecast;
4. explicit free daily calls and reset basis when free quota is claimed;
5. enough measured actual-call history for the selected range.

Only then compare actual calls per day, free-call consumption and the configured monthly budget. The current
conservative projection produces no precise monetary forecast when endpoint prices differ without a safe
weighted calculation. An unknown forecast is preferable to telling operators to recharge based on false
precision. Cost optimization order is: stop faulty demand, improve exact reuse, keep pagination bounded,
then evaluate quota plan or recharge.

## 8. Incident matrix

| Symptom / code | Meaning | Operator action |
| --- | --- | --- |
| `external_platform_not_configured` | Public data plane has no usable credential. | Check the JustOne page's safe credential status. For an environment fallback, verify secret injection on the public process only. Do not restart or reconfigure Launcher/MX-H2I. |
| `external_platform_circuit_open` | Consecutive provider failures opened the circuit. | Inspect the latest bounded error and archives, wait for the cooldown, then perform one intentional probe. Do not bypass the circuit with retries. |
| `external_platform_busy` | Hub global/per-consumer concurrency is full. | Find the dominant tenant/request pattern; reduce client concurrency or policy before raising the global ceiling. |
| `external_platform_capacity_exceeded` | Provider rate/quota capacity rejected the dispatch. | Stop retry amplification, verify quota evidence and wait for the known reset; unknown reset stays unknown. |
| `external_platform_response_unusable` | A successful external response did not match the reviewed shape. | Treat it as possibly billed. Inspect secret-free response evidence, add a fixture and review the adapter before any change. |
| `external_platform_outcome_unknown` / `request_outcome_unknown` | Dispatch or durable outcome cannot be proved. | Keep request ID and original key; never issue a new-key automatic retry. Reconcile call, usage and archive evidence. |
| rising `stored_fallback` | Live path is failing while exact snapshots still satisfy clients. | Check capture age, fallback reason, provider state and stale deadline. Do not report the response as live. |
| provider calls exceed Hub requests | Ledger reconciliation failure. | Freeze connector rollout and inspect transactions; do not estimate spend from incomplete counters. |
| canonical/ES count lags calls | Ingest or projection backlog, not necessarily acquisition loss. | Verify response/item archives and ingest-run linkage, then repair queue/outbox. Do not repeat the paid search. |

## 9. Safe disable and rollback

To stop one consumer immediately, remove its `ecommerce` grant or set a restrictive policy through the
existing authorization workflow. To stop all new JustOne dispatches, set
`MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED=0` and roll only the Hub public process; this disables dispatch even when
a database-managed key exists. If the deployment still uses the environment fallback, remove
`MX_INSIGHT_JUSTONE_TOKEN` at the same time. Exact stored fallback may continue until `staleUntil`; afterward
Public API returns unavailable.

Keep the prior release's environment secret available for the whole rollback window before migrating source
authority to the database; an older binary cannot read migration 052's credential row. Conversely, rolling
back application code does not delete a database-managed key. The contract-verification gate stops dispatch;
it is not credential revocation.

Do not drop `external_platform` tables, delete archives, clear usage rows or reset idempotency records during
rollback. They are audit and cost evidence. Removing the connector must not roll back migrations or any
Launcher/MX-H2I component. Re-enable only after one reviewed adapter fixture, one bounded live smoke and
call/archive/ingest reconciliation succeed.
