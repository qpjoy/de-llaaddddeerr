# External data platform gateway operations

Status: JustOne ecommerce product search implemented; PostgreSQL required for durable analytics, archive,
snapshot and canonical lineage.

Related decision: [ADR-0013](../adr/0013-external-data-platform-gateway.md).

## 1. Operational boundary

This gateway handles provider-backed realtime external acquisition, which may consume quota or incur Hub
procurement cost, separately from scheduled cleaning jobs. Its first
provider is JustOne, but public callers use only the Hub-owned
`POST /api/v1/data/ecommerce/products/search` contract and the `ecommerce` grant.

The current deployed topology is single-provider: JustOne is the only ecommerce adapter and there is no
multi-provider runtime router or automatic supplier failover. “Provider-neutral” describes the Public Hub
contract. `fresh_cache` and `stored_fallback` are exact Hub snapshot delivery modes, not evidence that another
provider was called. Provider candidates shown in a catalog remain planning evidence until released.

The same public search accepts a provider-neutral `deliveryMode`: `cache_only` forbids provider dispatch,
`cache_first` preserves the compatible fresh-cache-first behavior, and `refresh` explicitly permits one new
acquisition and requires a caller-supplied `Idempotency-Key`. This field does not name or route a supplier.

The feature is additive:

- an absent JustOne credential disables only new JustOne dispatches;
- exact last-good snapshots may remain available until their stale deadline;
- Hub stored search, cleaning jobs and canonical data continue independently;
- Launcher, SessionGate, MX-H2I login, WireGuard, DNS and user networking have no dependency on this
  connector's readiness.

Normal health/smoke must not dispatch live acquisition. A live smoke that may incur provider procurement
cost requires an explicit operator decision.

## 2. Activation checklist

1. Run the normal migration workflow and verify migrations `051_external_platform_gateway.sql` and
   `052_external_platform_credentials.sql` are applied.
   Do not create or patch the `external_platform` tables by hand.
2. Use PostgreSQL storage (`MX_INSIGHT_STORE=postgres` with `DATABASE_URL`). Memory mode is acceptable only
   for contract tests; it cannot be accepted as durable archive/lineage evidence.
3. Prefer **数据清洗中心 → 外部数据平台 → JustOne → API Key 管理** for a new or rotated key. The password
   input is never prefilled. Ordinary Admin responses expose only safe credential metadata; reveal/copy
   requires a second Admin Token check and the plaintext exists only in the open modal. Saving a key does
   not open the independent `MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED=1` release gate. Persist that gate in
   `.env.internal` (or the release environment) and run the normal Hub deploy so the Public workload rolls.
   `MX_INSIGHT_JUSTONE_CONFIGURED` is only a derived environment-fallback signal; it is neither a credential
   nor the dispatch gate.
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
   External ecommerce search and media accept only an active `mih_live_` Hub Public API Key; no separate
   product key is issued. Existing Live keys already resolve to that consumer and need no credential-row
   migration: applying the normal migrations is sufficient, and enabling the grant makes all active keys of
   that consumer eligible under the same policy.
8. Leave `MX_INSIGHT_JUSTONE_BILLING_JSON` absent until a price book is reviewed. Current configuration
   accepts only `source=manual`; price records require a three-letter currency and `pricingAsOf`. A missing
   price, balance or free quota must remain null/unknown, not zero.
9. Start with one approved marketplace/query and one page. Verify public delivery, provider-call evidence,
   archive objects and the linked canonical ingest before widening grants or concurrency.

On routine Internal deploys, an omitted/blank `MX_INSIGHT_JUSTONE_TOKEN` and an
omitted `MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED` preserve their current Kubernetes
values. An explicit gate value of `0` disables dispatch. Clearing the retained
environment fallback requires the one-shot command prefix
`MX_INSIGHT_CLEAR_JUSTONE_ENV_TOKEN=1`; never persist that flag in an env file.
A first deployment still defaults to no environment key and a closed gate. The
UI-managed database key is retained independently in PostgreSQL and remains the
preferred credential source. Command-environment values take precedence over
`.env.internal` for an intentional activation or emergency stop.

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

### Authentication and error ownership

Troubleshoot credentials from the outside inward; do not replace one key because a different layer failed:

| Surface | Credential or authority | Stable failure interpretation |
| --- | --- | --- |
| Internal external-platform management | Hub Admin Token only | Missing management auth is `401 admin_auth_required`; a Launcher session or Hub Public API key is `403 admin_token_required`. Provider credential reveal additionally returns `403 admin_token_reauthentication_required` when the re-entered Admin Token is absent or wrong. |
| Public ecommerce with a Live key | Ordinary `mih_live_` Hub Public API Key in bearer or `x-api-key` form | Missing is `401 api_key_required`; invalid, expired or revoked is `401 invalid_api_key`; valid but without `ecommerce` on its owning consumer is `403 platform_not_granted`. No ecommerce-specific key exists. |
| Public ecommerce with a legacy Test key | Ordinary Hub Public API Key carrying compatibility `environment=test` metadata | With an ecommerce grant, capabilities keeps the entry but reports `ready=false`; search and media return `403 test_key_not_supported` before usage reservation, stored-result/media lookup or provider dispatch. It is not a sandbox. |
| Hub request policy | Authenticated and granted consumer | `429 quota_exceeded` is consumer quota; `429 external_platform_busy` is Hub concurrency protection. Neither is a provider-key prompt. |
| Internal provider dispatch | Server-held JustOne API Key | The caller never supplies it. Missing configuration, upstream credential rejection, balance or provider capacity is sanitized as an external-platform availability/capacity error. It must not become Public `invalid_api_key`. |

`502 external_platform_outcome_unknown` and `502 external_platform_response_unusable` are post-dispatch
evidence and may already have consumed provider quota or incurred Hub procurement cost. Preserve the request ID,
normalized body and original `Idempotency-Key`; do not rotate the Hub Public API Key, JustOne API Key or
`Idempotency-Key` merely to force another attempt. For an ambiguous outcome, query only
`GET /api/v1/requests/{requestId}` with the original Hub Public API key. This read creates no usage and cannot
dispatch JustOne. Do not repeat the ecommerce POST until that status is `committed`.

The request-status result is an operational state, not a retry timer:

| Status | Browser / operator action |
| --- | --- |
| `reserved` | The request may still be running. Keep the original lock and query the same Request ID later; do not POST or create another idempotency key. |
| `unknown` | The outcome cannot be proved. Keep the lock and reconcile usage, provider-call and archive evidence; browser replay remains disabled. |
| `committed` | The original outcome is durable. An exact same-body, same-key POST may now retrieve that committed result without another usage or provider dispatch. |
| `released` | Hub proved the reservation was released. Clear the browser lock, but require a new explicit cost confirmation and a new idempotency key for any acquisition. |

Browser ledgers written before Request ID retention can accept a UUID copied from the original response. If a
transport failure returned no Request ID, use the retained `Idempotency-Key` for operator-side, consumer-scoped
ledger lookup. Do not guess a UUID and do not use POST as a lookup mechanism.

An old browser record marked ambiguous under a Test key is different: keep its exact body, original
`Idempotency-Key` and one-way credential fingerprint locked, and transfer the available request identity to
operator reconciliation. The workbench may continue local safe-demo and `cache_only` reads with independently
editable filters because neither can create a provider call. Do not paste the historical Test secret, replace it
with a Live key or start another `cache_first`/`refresh` attempt until retained usage/gateway/provider/archive
evidence has been reviewed.

```bash
(
# Run this on the Internal server. Local Compose uses :18180 instead.
export HUB_ADMIN_URL='http://127.0.0.1:18151'
umask 077
ADMIN_HEADER_FILE="$(mktemp)"
trap 'rm -f "$ADMIN_HEADER_FILE"' EXIT
read -rsp 'Hub Admin Token: ' HUB_ADMIN_TOKEN
printf '\n'
printf 'x-mx-insight-admin-token: %s\n' "$HUB_ADMIN_TOKEN" >"$ADMIN_HEADER_FILE"
unset HUB_ADMIN_TOKEN

curl -fsS \
  -H "@$ADMIN_HEADER_FILE" \
  "$HUB_ADMIN_URL/internal/v1/admin/external-platforms?range=7d" \
  | jq '.data | {range, generatedAt, summary, providers}'

curl -fsS \
  -H "@$ADMIN_HEADER_FILE" \
  "$HUB_ADMIN_URL/internal/v1/admin/external-platforms/justone?range=7d" \
  | jq '.data | {provider: {status: .provider.status, configuration: .provider.configuration}, credential, pipeline, guardrails, costPlan}'
)
```

For an Internal incident, inspect only non-secret state before any live smoke:

```bash
kubectl -n mx-insight-hub get configmap mx-insight-hub-config -o json \
  | jq '.data | {contractVerified: .MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED, configuredSignal: .MX_INSIGHT_JUSTONE_CONFIGURED}'
kubectl -n mx-insight-hub get secret mx-insight-hub-secrets -o json \
  | jq '{envFallbackPresent: (((.data.MX_INSIGHT_JUSTONE_TOKEN // "") | length) > 0)}'
```

Do not print/decode the Secret, call the reveal endpoint, or invoke a product
search while diagnosing configuration. The required control-plane result is
`contractVerified=true`, `credentialConfigured=true` and
`dispatchEligible=true`. If a database credential and gate are both healthy but
Public still reports unavailable, compare Admin/Public image IDs and database
identity, confirm migration `052`, then inspect credential-store errors.

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

Use a dedicated smoke consumer with an `ecommerce` grant, a low quota, an active `mih_live_` Hub Public API Key
and an approved non-production query.
Read the Hub API key without writing it to shell history. The first call below intentionally permits exactly
one live upstream dispatch that may incur provider procurement cost; do not put it in readiness, CI or a
retry loop. Prefer `scripts/justone-apicall.sh`: it performs the zero-cost preflight first, prints the
non-secret recovery `Idempotency-Key` and body before dispatch, then verifies an exact replay only after a
completed first response. If a transport or outcome error is ambiguous, do not rerun the POST. Query the returned
Request ID through the read-only status endpoint; if no Request ID was received, stop and reconcile the printed
`HUB_IDEMPOTENCY_KEY` and `HUB_ECOMMERCE_QUERY` operationally. Never create a new key or query to probe the result.

```bash
# Local Compose uses the combined listener on :18180. Internal Kubernetes uses
# the public listener on :18150; override this value there.
export HUB_PUBLIC_URL='http://127.0.0.1:18180'
read -rsp 'MX Insight API Key: ' HUB_API_KEY
printf '\n'
LIVE_KEY="external-live-$(uuidgen)"
CACHE_KEY="external-cache-$(uuidgen)"
REQUEST_BODY='{"marketplace":"jd","query":"approved smoke query","deliveryMode":"refresh"}'

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

# This request is a separately metered Hub delivery but forbids another provider call.
CACHE_BODY='{"marketplace":"jd","query":"approved smoke query","deliveryMode":"cache_only"}'
CACHE_RESPONSE=$(curl -sS -D /tmp/mxih-external-cache.headers -X POST \
  -H "Authorization: Bearer $HUB_API_KEY" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $CACHE_KEY" \
  -d "$CACHE_BODY" \
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
- a successful first response is `live`, adding one `provider_calls` row and one Hub usage request; a failed
  refresh may return an exact `stored_fallback`, so verify Internal evidence rather than assuming a charge;
- the second response is `fresh_cache`, has a different request ID but the same `capturedAt` and item payload,
  adds a second Hub usage request, and adds no provider call or provider cost;
- Admin metrics increase by `hubRequests=2`, `upstreamCalls=1`, `freshCache=1` and
  `avoidedUpstreamCalls=1`; `billedCalls=1` when the provider returns its documented charged-success result.

Reusing `LIVE_KEY` with the exact body is a third, different case: it returns `idempotent_replay` and adds
neither a new Hub usage reservation nor a provider call. If the first page returns `nextCursor`, request that
cursor with a **new** key. Never combine `page` and `cursor`, never expose/decode the cursor and never use a
live smoke loop.

The current cursor state is implicitly JustOne. Before a second provider is enabled, the cursor contract must
be versioned to carry the selected provider and adapter contract inside its authenticated-encrypted payload;
legacy cursors remain pinned to JustOne. A route-order change must never move a next-page continuation to a
different supplier.

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
projection through the existing outbox workflow rather than replaying a provider call that may incur procurement cost.

## 6. Freshness, paging and anomaly checks

The exact response snapshot key is consumer + operation + normalized request fingerprint. It includes
contract version, marketplace, normalized query, page, sort, price and a fingerprint of private continuation
state. Never use a cache hit as evidence that a different query or consumer is fresh.

For a client returning from page two to page one:

- the same page-one `Idempotency-Key` replays the original committed result indefinitely;
- a new page-one `Idempotency-Key` may receive `fresh_cache` while the exact snapshot is fresh;
- after the fresh TTL, a new `Idempotency-Key` may create a new provider dispatch and procurement cost;
- every next-page request uses a new `Idempotency-Key` and the prior response's opaque cursor.

Do not confuse acquisition pagination with the treasure-box product's visual “shelf” paging. Moving among
already-returned product groups or reopening a product is browser presentation only and must preserve the same
request ID/source mode without another product-search call. It may issue bounded media reads for newly visible
items; those reads create no Hub usage or provider dispatch. Only an explicit `nextCursor` action starts a new
Hub search request and possible provider charge.

This makes transport retry and user navigation predictable. It does not promise that repeatedly changing `Idempotency-Key` values
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
admin workflow. Do not change global login/network settings and do not add an automatic provider retry that may multiply procurement cost.

The Admin product never loads an upstream `images[]` URL directly. Visible live items use
`GET /api/v1/data/ecommerce/products/media` with the same `mih_live_` Hub Public API Key plus the committed search `requestId`,
returned `itemId` and bounded `imageIndex`. The endpoint accepts no URL, verifies same-consumer committed
evidence, accepts only those three query keys, restricts public HTTPS content to JPEG/PNG/WebP, pins DNS,
revalidates every redirect and bounds type, signature, time and body size. It creates no Hub usage or
product-search/provider dispatch. Per-consumer rate/concurrency exhaustion returns
`external_media_rate_limited`/`external_media_busy` with 429; global relay concurrency also fails as busy.
Responses are `private, no-store` and vary on Authorization, so browsers and proxies must not retain or mix
consumer credentials. Hub's bounded same-consumer server cache absorbs repeat reads. Rejection is a presentation failure and must fall back to the neutral local icon; operators must
not work around it with a direct provider URL or an ad-hoc proxy.
A Test key is rejected before the committed-result store or media loader is touched and does not create usage.

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
| `api_key_required` / `invalid_api_key` | The ordinary Hub Public API credential is missing, invalid, expired or revoked. | Verify/reissue that Hub key and its expiry. Do not paste or rotate the JustOne key. |
| `test_key_not_supported` | A valid legacy Test key reached an external ecommerce search or media route. | Use a Live key only for a deliberately new request. For a historical ambiguous Test record, keep its body/`Idempotency-Key` lock and reconcile it operationally; do not replay it from the page. No usage reservation or provider/media call occurred for this rejection. |
| `platform_not_granted` | The Hub key is valid, but its consumer lacks the `ecommerce` grant. | Grant the product through the governed Hub authorization workflow; a source-catalog/provider credential does not grant it. |
| `stored_snapshot_not_found` | A `cache_only` request found no exact retained snapshot. No provider call was made. | Change the business filters, use the clearly marked local safe demo, or explicitly authorize one `refresh` request with a new Idempotency-Key. |
| `quota_exceeded` | The authenticated consumer exhausted its Hub ecommerce policy window. | Inspect the consumer policy and demand. Do not treat it as JustOne balance or free-quota evidence. |
| `external_platform_not_configured` | The provider-neutral Public path cannot dispatch: the contract gate may be closed, no DB/environment credential may be usable, or the credential store may be unavailable. | Check the JustOne page's safe `provider.configuration` and `credential` fields, then the Public Pod's non-secret gate state. Do not reveal/decode the key or restart/reconfigure Launcher/MX-H2I. |
| `external_platform_circuit_open` | Consecutive provider failures opened the circuit. | Inspect the latest bounded error and archives, wait for the cooldown, then perform one intentional probe. Do not bypass the circuit with retries. |
| `external_platform_busy` | Hub global/per-consumer concurrency is full. | Find the dominant tenant/request pattern; reduce client concurrency or policy before raising the global ceiling. |
| `external_platform_capacity_exceeded` | Provider rate/quota capacity rejected the dispatch. | Stop retry amplification, verify quota evidence and wait for the known reset; unknown reset stays unknown. |
| `external_platform_response_unusable` | A successful external response did not match the reviewed shape. | Treat provider quota/cost as possibly consumed, without inferring a Hub customer charge. Inspect secret-free response evidence, add a fixture and review the adapter before any change. |
| `external_platform_outcome_unknown` / `request_outcome_unknown` | Dispatch or durable outcome cannot be proved. | Keep request ID and original `Idempotency-Key`; use only `GET /api/v1/requests/{requestId}` from the browser. `reserved`/`unknown` must not POST. Reconcile call, usage and archive evidence; never issue a new-key automatic retry. |
| rising `stored_fallback` | Live path is failing while exact snapshots still satisfy clients. | Check capture age, fallback reason, provider state and stale deadline. Do not report the response as live. |
| provider calls exceed Hub requests | Ledger reconciliation failure. | Freeze connector rollout and inspect transactions; do not estimate spend from incomplete counters. |
| canonical/ES count lags calls | Ingest or projection backlog, not necessarily acquisition loss. | Verify response/item archives and ingest-run linkage, then repair queue/outbox. Do not repeat the provider-backed search. |

## 9. Safe disable and rollback

To stop one consumer immediately, remove its `ecommerce` grant or set a restrictive policy through the
existing authorization workflow. To stop all new JustOne dispatches, set
`MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED=0` and roll only the Hub public process; this disables dispatch even when
a database-managed key exists. If the deployment still uses the environment fallback, remove it at the
same time by prefixing that deploy with
`MX_INSIGHT_CLEAR_JUSTONE_ENV_TOKEN=1`. Exact stored fallback may continue until `staleUntil`; afterward
Public API returns unavailable.

Keep the prior release's environment secret available for the whole rollback window before migrating source
authority to the database; an older binary cannot read migration 052's credential row. Conversely, rolling
back application code does not delete a database-managed key. The contract-verification gate stops dispatch;
it is not credential revocation.

Do not drop `external_platform` tables, delete archives, clear usage rows or reset idempotency records during
rollback. They are audit and cost evidence. Removing the connector must not roll back migrations or any
Launcher/MX-H2I component. Re-enable only after one reviewed adapter fixture, one bounded live smoke and
call/archive/ingest reconciliation succeed.
