# External data platform gateway operations

Status: JustOne ecommerce product search and direct TikHub Xiaohongshu note acquisition implemented;
direct TikHub search/raw routing is a staged migration and is not proved active by repository presence.
PostgreSQL is required for durable analytics, archive, snapshot, quota and canonical lineage.

Related decision: [ADR-0013](../adr/0013-external-data-platform-gateway.md).

Staged Xiaohongshu search eligibility, Night-All retention, multi-call accounting and rollback are governed by
the [direct TikHub migration boundary](../integrations/xiaohongshu-direct-tikhub-migration.md). That document does
not claim that all Night-All traffic has moved.

## 1. Operational boundary

This gateway handles provider-backed realtime external acquisition, which may consume quota or incur Hub
procurement cost, separately from scheduled cleaning jobs. Public callers use only Hub-owned contracts:

- `POST /api/v1/data/ecommerce/products/search` with the `ecommerce` platform entitlement;
- `POST /api/v1/xiaohongshu/app/get_note_info` with a JSON note link, plus both the `xiaohongshu` platform
  entitlement and `social.posts.resolve` capability entitlement. Hub also retains GET `share_text`/`note_id`
  and the provider-neutral `POST /api/v1/data/post`; all three share one canonical operation, note identity,
  snapshots and external-dispatch suppression rather than being purchased or metered independently. Exact
  idempotency additionally binds the delivery mode;
- `POST /api/v1/data/search` for an eligible Xiaohongshu page, with the `xiaohongshu` platform entitlement;
- the eligible Xiaohongshu subset of `POST /api/v1/night-all/search/raw`, projected back into the existing
  compatibility envelope so callers do not select or learn a physical provider.

The current topology has one provider per released operation: JustOne for ecommerce search and TikHub for
Xiaohongshu note detail. TikHub-backed Xiaohongshu search/raw is implemented behind its narrower rollout gate;
until that gate is enabled it is staged rather than a released traffic claim. There is no multi-provider runtime
router or automatic supplier failover.
“Provider-neutral” describes the Public Hub contract. `fresh_cache` and `stored_fallback` are exact Hub snapshot
delivery modes, not evidence that another provider was called. Provider candidates shown in a catalog remain
planning evidence until released.

The Hub-owned public spelling `/xiaohongshu/app/get_note_info` does **not** call TikHub App V1. That provider
operation was permanently retired; the adapter remains pinned to the reviewed App V2 image-note-detail contract,
which can return both image-note and video-note metadata without promising a video playback URL. The public
spelling is only a customer migration surface and always returns the Hub stable schema.

The same public search accepts a provider-neutral `deliveryMode`: `cache_only` forbids provider dispatch,
`cache_first` preserves the compatible fresh-cache-first behavior, and `refresh` explicitly permits one new
acquisition and requires a caller-supplied `Idempotency-Key`. This field does not name or route a supplier.

The feature is additive:

- an absent JustOne credential disables only new JustOne dispatches;
- an absent TikHub credential disables only new Xiaohongshu note dispatches;
- exact last-good snapshots may remain available until their stale deadline;
- Hub stored search, cleaning jobs and canonical data continue independently;
- Launcher, SessionGate, MX-H2I login, WireGuard, DNS and user networking have no dependency on this
  connector's readiness.

Normal health/smoke must not dispatch live acquisition. A live smoke that may incur provider procurement
cost requires an explicit operator decision.

## 2. Activation checklist

1. Run the normal migration workflow and verify migrations `051_external_platform_gateway.sql`,
   `052_external_platform_credentials.sql`, `053_external_platform_uncertain_retry.sql` and
   `054_api_key_entitlements_plans_and_tikhub.sql` are applied. Install
   `scripts/api-key-quota-indexes.sql` through the documented concurrent-index phase after migration 054.
   Do not create or patch the `external_platform` tables by hand.
   Before enabling direct Xiaohongshu search or bounded detail enrichment, also verify
   `055_external_platform_multi_call_rate_limit.sql` in the same database used by every Public replica. If
   `external_platform.provider_calls` is larger than 128 MiB or the installation has latency-sensitive writers,
   use the reviewed online preparation below before running the normal migration; migration 055 deliberately
   fails closed when the required concurrent indexes are absent or invalid on a large table.
2. Use PostgreSQL storage (`MX_INSIGHT_STORE=postgres` with `DATABASE_URL`). Memory mode is acceptable only
   for contract tests; it cannot be accepted as durable archive/lineage evidence.
   When bootstrap explicitly includes `xiaohongshu`, keep
   `MX_INSIGHT_BOOTSTRAP_PLAN_KEY=launch-1m` (the default). Provisioning resolves that key to the current
   active published version and CAS-reconciles an existing consumer before any API key is minted. Reusing a
   retained snapshot key reconciles the declared plan first as well. A missing version, stale revision, failed
   assignment or failed scope grant aborts an explicitly configured deploy before it can report the key ready;
   it never falls through to a legacy-unmetered Xiaohongshu key. Deployments with no explicit bootstrap plan,
   platform or capability retain the historical best-effort behavior.
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
   | `MX_INSIGHT_JUSTONE_MAX_CONCURRENCY` | 32 | Global in-process **live provider dispatch** ceiling. This is not a Hub cache-read QPS limit. |
   | `MX_INSIGHT_JUSTONE_MAX_CONSUMER_CONCURRENCY` | 8 | Per-consumer live provider dispatch ceiling; it must not exceed the global ceiling. |
   | `MX_INSIGHT_JUSTONE_CIRCUIT_FAILURES` | 3 | Consecutive failure threshold. |
   | `MX_INSIGHT_JUSTONE_CIRCUIT_OPEN_MS` | 60000 | Open-circuit cooldown. |

7. Grant `ecommerce` only to the intended consumer and set its request/window/page policy through the
   existing platform administration workflow. A source-catalog entry or API key alone does not grant access.
   External ecommerce search and media accept only an active `mih_live_` Hub Public API Key; no separate
   product key is issued. For a new key, grant the intended platform/capability first and then issue the key:
   its entitlement snapshot is immutable and a later consumer grant does not widen it. Consumer revocation or
   plan reduction still narrows effective access immediately. Keys migrated as `legacy_dynamic` retain only
   bounded compatibility behavior and should be replaced deliberately, not treated as the model for new keys.
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

### Direct TikHub / Xiaohongshu activation

The Hub adapter is pinned to TikHub's App V2 note-detail operation and accepts only an official Xiaohongshu note
or share URL. Mainland deployments use `https://api.tikhub.dev`; deployments outside mainland China retain
`https://api.tikhub.io`. Arbitrary provider origins fail at startup. Keep
`MX_INSIGHT_TIKHUB_CONTRACT_VERIFIED=0` until a redacted fixture from the actual account verifies the note-detail
response shape, billing classification and one bounded live smoke. Keep the narrower
`MX_INSIGHT_TIKHUB_SEARCH_CONTRACT_VERIFIED=0` until the search response, continuation and 60-boundary enrichment
fixtures are independently verified. The search gate cannot be enabled unless the parent gate is also `1`. An
HTTP/business success with unusable content is quarantined and must not be retried automatically because the
upstream call may already have been charged.

Direct search caches are controlled by `MX_INSIGHT_TIKHUB_SEARCH_FRESH_TTL_MS` and
`MX_INSIGHT_TIKHUB_SEARCH_STALE_TTL_MS`. Known 60-character previews are repaired for the full 20-item page by
default (`MX_INSIGHT_TIKHUB_SEARCH_MAX_ENRICH_ITEMS=20`) with two detail workers
(`MX_INSIGHT_TIKHUB_SEARCH_ENRICH_CONCURRENCY=2`). The shared RPM bucket and request deadline remain authoritative;
capacity exhaustion returns explicit partial-completeness metadata instead of labelling a preview as full text.

Prefer the Hub Admin credential UI for a new key. To copy the existing Night-All credential without printing it,
run the checked migration helper on the Internal host. It reads only
`crawlerProviders.tikhub.apiKey`, rejects symlinks or group/world-readable configuration, uses optimistic
credential revision, never logs plaintext and never removes or rewrites the Night-All source file:

```bash
cd electron-dock/mx-insight-hub
export NIGHT_ALL_CONFIG_PATH='/Users/qpjoy/workspace/mingxi/Night-All/config.json'
export MX_INSIGHT_ADMIN_BASE_URL='http://127.0.0.1:18151'
read -rsp 'Hub Admin Token: ' MX_INSIGHT_ADMIN_TOKEN
printf '\n'
export MX_INSIGHT_ADMIN_TOKEN

MX_INSIGHT_TIKHUB_MIGRATION_DRY_RUN=1 npm run migrate:tikhub-credential
npm run migrate:tikhub-credential

unset MX_INSIGHT_ADMIN_TOKEN NIGHT_ALL_CONFIG_PATH MX_INSIGHT_ADMIN_BASE_URL
```

Dry-run validates the source and target revision but performs no write. After the real migration, inspect only
safe credential metadata. Deploy migration 055 and the new Hub data plane with the search gate still `0`; only
after every Public replica is compatible should a recorded canary set both the reviewed parent gate and the
search gate to `1`. A Live key needs an immutable `xiaohongshu` platform entitlement for direct search; the
separate explicit note-detail API additionally requires `social.posts.resolve`. Never delete the Night-All
credential until the Hub rollback window has closed.

#### Online preparation for migration 055

The normal migration owns this schema. Use the following preparation only when the table-size/latency rule above
requires concurrent indexes, and only while migration 055 is still absent from `schema_migrations`. Run it from
an approved Internal PostgreSQL operator session. Each `CREATE INDEX CONCURRENTLY` or `DROP INDEX CONCURRENTLY`
must be a top-level statement; do not wrap those statements in a transaction or copy them into the migration
file.

```sql
\set ON_ERROR_STOP on

-- Must return zero rows before preparation.
SELECT filename
FROM schema_migrations
WHERE filename = '055_external_platform_multi_call_rate_limit.sql';

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
ALTER TABLE external_platform.provider_calls
  ADD COLUMN IF NOT EXISTS call_ordinal integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS call_role text NOT NULL DEFAULT 'primary',
  ADD COLUMN IF NOT EXISTS dispatch_fingerprint char(64);
CREATE OR REPLACE FUNCTION external_platform.default_provider_call_dispatch_fingerprint()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.dispatch_fingerprint IS NULL THEN
    NEW.dispatch_fingerprint := NEW.request_fingerprint;
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS provider_calls_default_dispatch_fingerprint
  ON external_platform.provider_calls;
CREATE TRIGGER provider_calls_default_dispatch_fingerprint
BEFORE INSERT ON external_platform.provider_calls
FOR EACH ROW
EXECUTE FUNCTION external_platform.default_provider_call_dispatch_fingerprint();
COMMIT;

-- Must return zero rows before creating the unique index.
SELECT usage_request_id, call_ordinal, count(*)
FROM external_platform.provider_calls
GROUP BY usage_request_id, call_ordinal
HAVING count(*) > 1
LIMIT 1;

-- A failed concurrent build leaves an invalid same-name object. Remove it and
-- retry; migration 055 will not accept name-only evidence.
DROP INDEX CONCURRENTLY IF EXISTS
  external_platform.external_platform_provider_calls_usage_ordinal_idx;
DROP INDEX CONCURRENTLY IF EXISTS
  external_platform.external_platform_provider_calls_dispatch_fingerprint_idx;
CREATE UNIQUE INDEX CONCURRENTLY external_platform_provider_calls_usage_ordinal_idx
  ON external_platform.provider_calls (usage_request_id, call_ordinal);
CREATE INDEX CONCURRENTLY external_platform_provider_calls_dispatch_fingerprint_idx
  ON external_platform.provider_calls
    (provider_key, consumer_id, operation, dispatch_fingerprint, completed_at DESC);

SELECT index_relation.relname,
       index_state.indisunique,
       index_state.indisvalid,
       index_state.indisready,
       index_state.indislive,
       pg_get_indexdef(index_state.indexrelid)
FROM pg_index index_state
JOIN pg_class index_relation ON index_relation.oid = index_state.indexrelid
WHERE index_state.indexrelid IN (
  to_regclass('external_platform.external_platform_provider_calls_usage_ordinal_idx'),
  to_regclass('external_platform.external_platform_provider_calls_dispatch_fingerprint_idx')
)
ORDER BY index_relation.relname;

-- Continue only after the query above returns exactly two valid/ready/live
-- indexes, the usage index is unique, and both definitions match exactly.
DROP INDEX CONCURRENTLY IF EXISTS
  external_platform.external_platform_provider_calls_usage_idx;
```

Then run the normal Hub migration command. It installs the constraints and shared rate-bucket table, revalidates
both index definitions from PostgreSQL catalogs, and records the migration checksum. Do not deploy a binary that
can create enrichment ordinals until that normal migration succeeds. Historical rows intentionally keep a null
`dispatch_fingerprint`; rolling writers receive one from the trigger, while current readers match historical
rows through their original `request_fingerprint` without rewriting the table.

Defaults are deliberately cache-heavy and bounded: exact successful note results remain fresh for 24 hours and
eligible for stored fallback for 30 days; request-local confirmed missing notes receive a negative cache. The
provider acquisition ceiling defaults to eight globally and eight per consumer. This limit governs paid note
acquisition, not image reads. The authenticated media relay separately allows 16 in-flight reads per consumer
and 32 globally, while browser clients default to 12 concurrent image loads with duplicate coalescing and a
bounded in-process cache.

## 3. Management views and credential operations

The management page **数据清洗中心 → 外部数据平台** reads these Internal Admin endpoints:

```text
GET /internal/v1/admin/external-platforms?range=24h|7d|30d
GET /internal/v1/admin/external-platforms/justone?range=24h|7d|30d
GET /internal/v1/admin/external-platforms/tikhub?range=24h|7d|30d
```

All retain the Admin-token-only source-management boundary. A Launcher session, including a platform admin
membership, is not sufficient. Unknown query fields fail with `400 unsupported_fields`; an unsupported range
fails with `400 invalid_range`.

Each provider detail page provides the corresponding browser credential workflow. Replace `{provider}` with
`justone` or `tikhub`:

- save/rotate through `PUT /internal/v1/admin/external-platforms/{provider}/credential` with `apiKey` and the
  currently displayed `expectedRevision`;
- reveal through `POST /internal/v1/admin/external-platforms/{provider}/credential/reveal`, re-entering the
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
| Public Xiaohongshu note with a Live key | Ordinary `mih_live_` Hub Public API Key in bearer or `x-api-key` form | The immutable key snapshot and current consumer authorization must both include `xiaohongshu` and `social.posts.resolve`. Missing platform is `403 platform_not_granted`; missing capability is `403 capability_not_granted`. |
| Public ecommerce with a legacy Test key | Ordinary Hub Public API Key carrying compatibility `environment=test` metadata | With an ecommerce grant, capabilities keeps the entry but reports `ready=false`; search and media return `403 test_key_not_supported` before usage reservation, stored-result/media lookup or provider dispatch. It is not a sandbox. |
| Hub request policy | Authenticated and granted consumer | `429 quota_exceeded` is consumer quota; `429 external_platform_busy` is Hub concurrency protection. Neither is a provider-key prompt. |
| Internal provider dispatch | Server-held JustOne API Key | The caller never supplies it. Missing configuration, upstream credential rejection, balance or provider capacity is sanitized as an external-platform availability/capacity error. It must not become Public `invalid_api_key`. |

`502 external_platform_outcome_unknown` and `502 external_platform_response_unusable` are post-dispatch
evidence and may already have consumed provider quota or incurred Hub procurement cost. Preserve the normalized
body and original `Idempotency-Key`; do not rotate the Hub Public API Key, JustOne API Key or idempotency key merely
to force another attempt. For an ambiguous outcome, query `GET /api/v1/requests/{requestId}` when the UUID was
received. When an older client retained only its idempotency key, call
`GET /api/v1/requests/by-idempotency-key` with that value in the `Idempotency-Key` header. Either lookup may use
any current active Hub Public API key belonging to the same consumer; both create no usage and cannot dispatch
JustOne. Do not repeat the old ecommerce POST or silently rotate its key while the returned state is `reserved` or
`unknown`. Only after its automatic GET explicitly returns `unknown` may the treasure-box workbench issue one
intentionally new acquisition: selecting `refresh` and pressing the main button explicitly accepts that the prior
request may already have incurred provider cost, and the page sends a new key plus
`X-MX-Insight-Retry-Of: <old requestId>`. The page gets that UUID from the GET; the operator never enters it.
`reserved` or a failed status lookup cannot use this path.

The request-status result is an operational state, not a retry timer:

| Status | Browser / operator action |
| --- | --- |
| `reserved` | The request may still be running. Never replay or override it; keep the evidence and let the main action check status again. |
| `unknown` | The outcome cannot be proved. Browser replay stays disabled and the evidence is retained. One intentionally new acquisition is allowed only when `refresh` is selected and the main button is pressed; the page automatically supplies the retry-of header. A retry loop cannot use this path. |
| `committed` | The original outcome is durable. An exact same-body, same-key POST may now retrieve that committed result without another usage or provider dispatch. |
| `released` | Hub proved the reservation was released. Close the prior ledger entry. A later acquisition is a new action and receives a new idempotency key; the page exposes no separate confirmation control. |

Browser ledger v1 records are migrated to v2 without asking for a UUID. After the current Hub Public API key passes
the zero-cost capability check, the workbench automatically uses the retained `Idempotency-Key` header for a
consumer-scoped lookup and stores the returned request identity. Corrupt browser-only entries are removed;
server-side usage/provider/archive evidence is retained. Do not put an idempotency key in a URL and do not use
POST as a lookup mechanism. The page exposes no separate status button or manual consumer-ownership check: its
single main action performs the GET first, then follows the selected delivery mode.

An old browser record marked ambiguous under a Test key keeps its exact body, original `Idempotency-Key` and
one-way credential fingerprint as migration evidence. The Test secret is never sent to ecommerce. After a current
Live key passes the zero-cost capability check, the workbench may use that key for the header-based status lookup;
the backend resolves consumer ownership. A same-consumer `committed` or `released` result follows the normal
recovery rules. An explicit `unknown` remains retained audit evidence and is never replayed or guessed; it does
not disable the filters or main action. Selecting `refresh` and pressing the main button creates one new `Idempotency-Key`, adds the
old request ID through `X-MX-Insight-Retry-Of` and may incur another provider cost. `reserved`, a foreign record or an unavailable lookup
remains blocked, and the workbench never overrides it silently. Local safe-demo and `cache_only` reads remain
independently available because neither can create a provider call.

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

### Capacity boundary and the 1000-QPS target

The paid acquisition path and the Hub data-egress path have different capacity contracts. An exact fresh
`cache_first` hit, `cache_only` delivery and idempotent replay complete before the JustOne concurrency guard and
never create a provider call. A cold, distinct query is live acquisition and is deliberately bounded to 32
in-process calls globally and 8 per consumer by default. The shared dispatch lease is acquired before a local
slot, so an equal suppressed request cannot consume a slot needed by an unrelated query.

`external_platform_busy` therefore means the Hub rejected a request before provider dispatch. A client may
retry that same request and Idempotency-Key with bounded backoff. It must not treat
`external_platform_capacity_exceeded` or an unknown outcome the same way: those errors follow an attempted
provider call and must not be automatically retried. Raising live-acquisition limits requires provider contract,
cost and error-rate evidence; never set them to 1000 merely because Hub-owned reads target 1000 QPS.

The aggregate 1000-QPS number is a future production acceptance target for retained/cache delivery, not a
claim made by this release. The current Internal Public deployment is one host-network Pod and the PostgreSQL
usage path still performs synchronous accounting. Certify the target only in an isolated production-like test
with multiple consumers, shared PostgreSQL/cache/object storage, at least two ordinary-network Public replicas,
and measured p95/p99 latency, zero quota overshoot, database lock/pool pressure and one-Pod failure. Do not run
that load test on the node serving Launcher or MX-H2I. The published `launch-1m` plan currently bounds one
consumer at 100 requests per second, so 1000 QPS is an aggregate multi-consumer target unless a separately
reviewed plan revision explicitly changes that customer boundary.

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
| `test_key_not_supported` | A valid legacy Test key reached an external ecommerce search or media route. | Use a Live key only for a deliberately new request. A historical ambiguous Test record is retained for audit and checked automatically; it does not require the old secret, UUID or manual consumer review. No usage reservation or provider/media call occurred for this rejection. |
| `platform_not_granted` | The Hub key is valid, but its consumer lacks the `ecommerce` grant. | Grant the product through the governed Hub authorization workflow; a source-catalog/provider credential does not grant it. |
| `stored_snapshot_not_found` | A `cache_only` request found no exact retained snapshot. No provider call was made. | Change the business filters, use the clearly marked local safe demo, or explicitly authorize one `refresh` request with a new Idempotency-Key. |
| `quota_exceeded` | The authenticated consumer exhausted its Hub ecommerce policy window. | Inspect the consumer policy and demand. Do not treat it as JustOne balance or free-quota evidence. |
| `external_platform_not_configured` | The provider-neutral Public path cannot dispatch: the contract gate may be closed, no DB/environment credential may be usable, or the credential store may be unavailable. | Check the JustOne page's safe `provider.configuration` and `credential` fields, then the Public Pod's non-secret gate state. Do not reveal/decode the key or restart/reconfigure Launcher/MX-H2I. |
| `external_platform_circuit_open` | Consecutive provider failures opened the circuit. | Inspect the latest bounded error and archives, wait for the cooldown, then perform one intentional probe. Do not bypass the circuit with retries. |
| `external_platform_busy` | Hub global/per-consumer concurrency is full. | Find the dominant tenant/request pattern; reduce client concurrency or policy before raising the global ceiling. |
| `external_platform_capacity_exceeded` | Provider rate/quota capacity rejected the dispatch. | Stop retry amplification, verify quota evidence and wait for the known reset; unknown reset stays unknown. |
| `external_platform_response_unusable` | A successful external response did not match the reviewed shape. | Treat provider quota/cost as possibly consumed, without inferring a Hub customer charge. Inspect secret-free response evidence, add a fixture and review the adapter before any change. |
| `external_media_source_throttled` | The retained image origin/CDN returned HTTP 429; this is not a Hub consumer quota or relay-concurrency limit. | Do not retry automatically or run another paid data request. Inspect the retained host and origin policy, then wait or serve a durable Hub-owned asset once materialization is enabled. |
| `external_media_unavailable` | A retained product image reached the media relay, but its upstream host returned a non-200 response or the TLS/transport request failed. | Reuse the committed search request while checking the retained image hostname and CDN response; do not run another paid search. Known legacy Alibaba `g.search[1-3].alicdn.com` names are mapped to their TLS-valid `g-search1-3.alicdn.com` aliases without disabling certificate validation. |
| `invalid_uncertain_retry` | Retry-of is malformed or is not paired with `refresh`. | Do not hand-edit the UUID. Let the workbench obtain it through the status GET and construct the header. |
| `uncertain_retry_not_allowed` | The old idempotency key was reused, or the referenced record is absent, already consumed, not eligible `unknown`, or does not match the same consumer/ecommerce fingerprint. The same response hides cross-consumer records. | Keep the old evidence. Do not retry or probe another identifier; `reserved` and succeeded-unusable quarantine are not overrideable. |
| `external_platform_outcome_unknown` / `request_outcome_unknown` | Dispatch or durable outcome cannot be proved. | Keep the original `Idempotency-Key` and Request ID when available. The workbench automatically uses the applicable status GET with the current active Public API key. Only an explicit `unknown` permits the already-selected `refresh` and main-button action to send one new key with an automatically populated `X-MX-Insight-Retry-Of: <old requestId>`; that click accepts possible duplicate provider cost. `reserved` or a failed lookup stays blocked; never issue a new-key automatic retry. |
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

TikHub is independently disabled with `MX_INSIGHT_TIKHUB_CONTRACT_VERIFIED=0`; remove a retained environment
fallback only with the one-shot `MX_INSIGHT_CLEAR_TIKHUB_ENV_KEY=1` deploy flag. This does not disable JustOne,
cached/stored Hub data, Launcher or MX-H2I. A 429 from `external_platform_capacity_exceeded` means the upstream
response was classified as rate/quota capacity exhaustion; it is not evidence by itself of an IP or domain
block. `quota_exceeded`, `external_platform_busy` and `external_media_rate_limited` are separate Hub-owned 429
classes. Preserve request ID and sanitized provider evidence before changing concurrency or credentials.

Keep the prior release's environment secret available for the whole rollback window before migrating source
authority to the database; an older binary cannot read migration 052's credential row. Conversely, rolling
back application code does not delete a database-managed key. The contract-verification gate stops dispatch;
it is not credential revocation.

Do not drop `external_platform` tables, delete archives, clear usage rows or reset idempotency records during
rollback. They are audit and cost evidence. Removing the connector must not roll back migrations or any
Launcher/MX-H2I component. Re-enable only after one reviewed adapter fixture, one bounded live smoke and
call/archive/ingest reconciliation succeed.
