# 电商数据百宝箱：产品、交互与外部调用设计

Status: implemented Admin demo and public documentation; live acquisition remains governed by the existing ecommerce contract.

Last reviewed: 2026-09-06.

Related documents:

- [External data platform gateway ADR](../adr/0013-external-data-platform-gateway.md)
- [JustOne capability map](../integrations/justone-capability-map.md)
- [External platform operations](../operations/external-data-platforms.md)
- [Public API v1](../contracts/public-api-v1.md)
- [Public curl guide](../public-api-curl.md)

## 1. Decision and naming

The data product is named **电商数据百宝箱**. Its Admin page may disclose that the current realtime adapter is
JustOne, but the product identity is not `JustOne data`:

- Hub owns the public contract, authorization, normalized schema, request idempotency, cache/fallback policy,
  usage evidence and future customer pricing;
- JustOne is one physical upstream provider and may later be complemented or replaced;
- callers continue to use `POST /api/v1/data/ecommerce/products/search` and
  `mx-insight-hub.ecommerce-products.v1`;
- the existing `/docs/search`, OpenAPI and every old public URL remain compatible.

“Provider-neutral” describes ownership of the Public contract; it does not claim that the deployed runtime
already routes across several suppliers. The current release constructs exactly one verified realtime adapter,
JustOne. It has no multi-provider router and never changes supplier after a dispatch that may incur provider
procurement cost has started. Exact Hub
cache/fallback is the current availability mechanism. A provider shown elsewhere in the source catalog is only
planning or lineage evidence until its adapter, route and contract tests have been released.

The names are deliberately kept on separate axes:

| Axis | Released value | Meaning |
| --- | --- | --- |
| Public authorization product | `ecommerce` | The grant, request quota and future Hub customer-pricing scope. |
| Hub operation | `ecommerce.products.search` | The stable business operation behind the Public path. |
| Marketplace | `taobao`, `tmall`, `jd`, `xiaohongshu_ec`, `xianyu` | The business source selected by the caller. |
| Internal provider | `justone` | The current acquisition supplier; never a Public request parameter or grant. |

The visual companion is the original **数据百宝猫“小聚”**. It is not an imitation of any commercial
character. Two transparent raster poses are maintained as product assets:

- `assets/ecommerce-treasure-box/data-cat-searching.webp`: reaches into the data pouch while a request is in
  progress;
- `assets/ecommerce-treasure-box/data-cat-presenting.webp`: smiles and opens both paws after a usable result is
  returned.

The “Here you are” copy is accessible DOM text, not embedded in the image.

## 2. Information architecture

### Admin console

The entry is under **数据产品 → 电商数据百宝箱**. This is separate from:

- **数据清洗中心 → 外部数据平台**, which manages provider credentials, dispatch health, costs, tenants,
  quota forecasts and failure evidence;
- **数据产品 → 虚拟超市**, which publishes reviewed, stored, on-shelf Hub inventory;
- **数据源目录**, which governs platform coverage and records reviewed connector evidence.

The treasure box is a client workbench for understanding the existing Hub contract. It does not create a
second public API, own an upstream credential or run a cleaning plan.

### Public documentation

The public `/docs` navigation has second-level headings:

- 基础;
- 数据目录;
- 数据产品;
- 通用能力;
- 运维契约.

`/docs/ecommerce-treasure-box` appears under 数据产品. It is provider-neutral by design: it teaches another
system how to authenticate, search, paginate, replay, interpret source modes and handle errors. Upstream names,
URLs, tokens, endpoint IDs, raw envelopes, archive keys and internal costs are never public contract fields.

## 3. Primary user journey

1. The operator opens the product and sees the stable contract, five verified marketplaces and archive flow.
2. The default **安全演示** mode uses clearly labelled in-browser examples. Its search action does not call the
   Public product-search API, create Hub usage or dispatch a provider request. Normal Admin session/bootstrap
   traffic is outside this promise.
3. The operator chooses a marketplace, sort mode and query.
4. The searching pose appears while the request is pending.
5. Results emerge as keyboard-focusable product spheres around the mascot. A visible live item may load its
   first retained image only through the authenticated Hub media relay. The browser never assigns an upstream
   URL to `img src`; safe-demo items, missing images and rejected relay reads use the neutral local icon.
6. Selecting a sphere shows the exact normalized ID, price, shop, brand, category and signal fields.
7. The evidence panel names the real `sourceMode`, request ID, data age, Hub usage implication and whether a
   new provider call happened.
8. The operator can open the external-platform command center, API Keys, source catalog or public docs.

### Display paging and media boundary

Product-sphere paging is presentation state over the items already returned in one Hub response. Moving between
those display groups, reopening an item or returning to the first display group must not call product search,
create Hub usage or dispatch a provider request. It may perform bounded media reads for newly visible live
items; those reads retain the same search `requestId` and are not acquisition pages. An acquisition next page
is different: it exists only when the response supplies `nextCursor`, requires an explicit action, sends that
cursor with a new `Idempotency-Key` and may consume Hub quota and one provider call. The UI must label those two
actions differently and keep the original `requestId`, `sourceMode` and capture time on every display group
derived from the same response.

The released **Hub safe media relay** is:

```http
GET /api/v1/data/ecommerce/products/media?requestId=<search-request-id>&itemId=<product-id>&imageIndex=0
Authorization: Bearer <mih_live_ Hub Public API Key for the same consumer>
```

It creates no Hub usage record and dispatches no product-search/provider request. `requestId` must identify a
committed HTTP-200 ecommerce response owned by the same consumer; `itemId` and `imageIndex` can select only a
retained image from that response. The endpoint never accepts a URL. It permits bounded public HTTPS raster
images in JPEG, PNG or WebP only, pins validated DNS answers, repeats private/loopback/link-local rejection on
redirects, sends no provider credential or browser cookie, checks declared type and file signature, and limits
redirects, time and body size. The three named parameters are the complete query allowlist; extra keys fail
with `400 unsupported_fields`. Consumer window or concurrency protection returns
`429 external_media_rate_limited` or `429 external_media_busy`; an end-to-end deadline returns
`504 external_media_timeout`. The response is private Hub-origin media with
`Cache-Control: private, no-store` and `Vary: Authorization`; browsers and shared caches must not retain it. The SPA
renders a Blob object URL and revokes it when the sphere unmounts. A relay failure is presentation-only and
falls back to the neutral local icon without changing search delivery evidence.

## 4. Interaction state machine

| State | Trigger | Mascot and products | Truthful system meaning |
| --- | --- | --- | --- |
| `idle` | Page open, mode/platform changed, or failed request | Presenting pose is subdued; no product spheres | No result is claimed. |
| `searching` | Safe demo timer or real HTTP request begins | Searching pose gently rummages in the pouch | Authorization/cache/provider checks may be running. It does not claim an upstream dispatch. |
| `presenting` | A usable demo or API result arrives | Presenting pose, speech bubble and product spheres | Speech changes for cache or stored fallback; delivery evidence is the authority. |

Reduced-motion mode removes mascot movement, particle pulsing, sphere entrance and sphere floating while
preserving state text and focus order.

## 5. Search modes and credentials

### Safe demo

Safe demo is the default and is deliberately obvious. Example IDs start with `demo-`, use generic product
names and are never written to Hub storage. It exists to demonstrate the interaction without consuming
customer quota or provider budget. Pressing its search button stays entirely in the browser: it does not invoke
`POST /api/v1/data/ecommerce/products/search`, does not consult `MX_INSIGHT_PUBLIC_URL` and does not require a
Hub Public API key. The surrounding Admin application may still refresh its own authenticated session or other
Admin data, so “safe” must not be described as a blanket browser-offline mode.

### Live Hub API

Live mode uses the same **Hub Public API Key** already issued through **API Keys**. There is no ecommerce-specific
or second “consumer key”: enabling `ecommerce` on the key's owning consumer immediately applies to every active
key for that consumer, including a replacement key during zero-downtime rotation. The value:

- remains only in React component memory;
- is rendered as a password field;
- uses `autocomplete=off`;
- is not written to localStorage, sessionStorage, a URL or an Admin API;
- is sent only as `Authorization: Bearer …` to the existing public Hub path.

The Admin workbench requires a per-request confirmation before a new logical request. This is only a demo-page
anti-misclick guard, not another client authorization step. Direct API callers send their one Hub Public API key
and the request. The confirmation clears after a completed request. Exact replay uses the previous request body
and previous `Idempotency-Key`, so it cannot silently become a new dispatch.

External ecommerce acquisition accepts only `mih_live_` keys. A legacy `mih_test_` value is compatibility
metadata, not an isolated sandbox: for a consumer with the `ecommerce` grant, capabilities reports that platform
with `ready=false`, while product search and media return `403 test_key_not_supported`. Search rejects before
grant lookup, usage reservation, cache lookup or provider dispatch; media rejects before a committed-result lookup
or image-loader call. Neither rejection creates usage or provider-cost evidence.

The workbench rejects a Test prefix before calling capabilities. If an older workbench version left an
`ambiguous` Test-key request in browser recovery state, the current page preserves its exact body, original
`Idempotency-Key` and one-way credential fingerprint as a locked operational record, but sends no capabilities,
search or media request. It instructs the operator to reconcile the historical attempt; pasting the old Test
secret or replacing it with a Live key is not an in-page recovery path.

For Live requests, the workbench stores only the secret-free exact request ledger and a one-way API-key-secret
fingerprint for replay. An ambiguous result -- including a transport interruption or an accepted response that
cannot be normalized -- must be retried, if at all, with the same path, normalized body and `Idempotency-Key`.
Creating a new `Idempotency-Key` can turn an uncertain live attempt into a second dispatch and another
provider-cost event.
Editing or rotating the Hub Public API key may discard a resolved local replay shortcut, but it never clears an
ambiguous request lock. For an ambiguous Live request, a credential-fingerprint mismatch rejects the action and
requires the original Live secret or operator reconciliation; the workbench does not guess that a replacement
belongs to the same consumer and does not unlock a new request. A historical Test-key record always follows the
operator-only path above. Backend authorization and idempotency scope remain consumer-scoped.

The upstream JustOne key remains in **数据清洗中心 → 外部数据平台 → JustOne → API Key 管理**. Reveal/copy
requires a second Admin Token check; it never belongs in this product, source-catalog metadata or public docs.

Production keeps the browser route aligned with the listener boundary:

- `MX_INSIGHT_PUBLIC_URL` is an HTTP(S) **origin** configured on the Admin deployment. It must not contain
  credentials, a path, query or fragment. After management authentication, the Admin session returns it as
  `publicApiBaseUrl`, and the SPA uses that runtime value for Public data calls and Public docs links;
- this value is routing metadata delivered only inside the authenticated management session. It is not an API
  key, does not authorize a data request and must not be placed in `Authorization`; live calls use the ordinary,
  already-issued `mih_live_` Hub Public API Key whose consumer has the `ecommerce` grant;
- a direct Admin SPA visit on `:18151` sends bearer-key data calls and docs navigation to the same host on
  Public `:18150` only as the compatibility fallback when no runtime Public origin was delivered;
- combined local mode and an edge that routes `/admin`, `/api` and `/docs` on one origin stay same-origin;
- build-time `VITE_MX_INSIGHT_PUBLIC_API_BASE` and `VITE_MX_INSIGHT_PUBLIC_DOCS_URL` values are fallback hints,
  not the preferred production configuration and not credentials;
- the Public listener returns wildcard CORS only for `/api/v1/*` bearer-key routes and exposes only the
  delivery/evidence headers used by this workbench. The Admin listener still returns 404 for every public API
  path, and public CORS never applies to `/internal/v1/admin/*`.

### Authentication and error ownership

Three credentials have different authorities and are never interchangeable:

| Credential | Accepted surface | Failure meaning |
| --- | --- | --- |
| Hub Admin Token | External-platform Internal management APIs | Required for provider configuration. Revealing a provider credential additionally requires the same Admin Token to be re-entered. |
| Launcher Admin session | Only Internal routes allowed by its scopes | Does not authorize provider credential management or reveal; those routes return `403 admin_token_required`. |
| `mih_live_` Hub Public API Key (ordinary API Keys lifecycle) | `/api/v1/data/ecommerce/products/search` and `/api/v1/data/ecommerce/products/media` | Missing key returns `401 api_key_required`; an invalid, expired or revoked key returns `401 invalid_api_key`; a valid Live key whose consumer lacks the `ecommerce` grant returns `403 platform_not_granted`. No product-specific key is issued. |
| Legacy `mih_test_` Hub Public API Key | Other Public routes only as their contracts permit | Ecommerce capabilities reports `ready=false`; search and media return `403 test_key_not_supported` before usage reservation, stored-result/media lookup or provider dispatch. The workbench sends no request with it. |
| JustOne API Key | Server-side JustOne adapter only | Never accepted from the browser or Public caller. Missing provider configuration or provider authentication/capacity problems are returned as provider-neutral external-platform availability errors, not as `invalid_api_key`. |

After authentication, `429 quota_exceeded` is Hub consumer policy; `429 external_platform_busy` is Hub
dispatch protection; `429 external_platform_capacity_exceeded` is sanitized upstream capacity. A
`502 external_platform_outcome_unknown` or `502 external_platform_response_unusable` may already have consumed
provider quota or incurred Hub procurement cost and
must not be retried with a new `Idempotency-Key`. This ordering prevents a provider credential incident from being mistaken
for a customer-key problem.

### Product-page failure presentation

The Admin data-product page translates provider-neutral API errors into an operator-facing state while retaining the
stable `error.code` and `requestId` as evidence. It does not expose the upstream response, provider credential or internal
price ledger.

| Category | Product-page guidance | Safe next action |
| --- | --- | --- |
| HTTP 502 `external_platform_response_unusable` | External data returned but could not be mapped to the stable Hub product contract. The page does not display partially trusted products. | Do not create a new idempotency key. Preserve the request evidence and inspect the archived response. The same key replays the committed 502 without another provider dispatch. |
| HTTP 502 `external_platform_outcome_unknown` | The page cannot prove whether this external dispatch completed. | Keep the original body and `Idempotency-Key`; use only the exact recovery path or operator reconciliation. |
| HTTP 409 `request_outcome_unknown`, `external_platform_response_unusable` | This browser attempt was suppressed before provider dispatch by an earlier unresolved request or endpoint contract quarantine. The earlier call may still have incurred procurement cost. | The page does not turn this released attempt into a no-confirmation replay. Stop automatic retries, inspect the operator evidence, and explicitly reconfirm any later Live request. |
| HTTP 409 `request_in_progress` | An equal request is still being handled; this browser attempt did not add a provider dispatch. | Wait for the active request. Do not create a parallel request or automatically replay this released attempt. |
| provider configuration, availability or capacity | The current exact request has neither a deliverable live result nor an eligible snapshot. | Check **External data platforms**, provider availability and quota. Do not rotate the customer Hub key. |
| `quota_exceeded` | The Hub consumer policy rejected the request. | Wait for the Hub window or change the consumer's ecommerce policy. |
| HTTP 200 with `items=[]` | A valid delivery found no matching items; this is not an interface failure. | Adjust the query or marketplace. Keep the returned source mode and request evidence; an empty result does not prove zero provider cost. |

An unresolved Live request never disables **Safe demo**. Safe demo remains a browser-only fixture path with zero Hub
usage and zero provider dispatch. Switching to it does not delete or alter the unresolved Live ledger. When the operator
switches back to Live, the page restores the original marketplace, query and sort before allowing an exact replay.
A fresh HTTP 409 suppression is different: it is released rather than stored as an ambiguous browser request, so a
later Live submission must pass the explicit acquisition confirmation again.

## 6. Stable API contract

### Request

```http
POST /api/v1/data/ecommerce/products/search
Authorization: Bearer <mih_live_ Hub Public API Key>
Content-Type: application/json
Idempotency-Key: <8-128 safe characters>
```

Allowed body keys are exactly:

| Field | Required | Rule |
| --- | --- | --- |
| `marketplace` | yes | `taobao`, `tmall`, `jd`, `xiaohongshu_ec` or `xianyu`. |
| `query` | yes | NFKC-normalized non-empty text, maximum 200 characters. |
| `page` | no | 1–1000; mutually exclusive with `cursor`. |
| `cursor` | no | Opaque authenticated-encrypted Hub cursor; maximum 4096 characters. |
| `sort` | no | Marketplace-specific allowlist below. |
| `price` | no | `{min,max}` decimal strings; only Taobao/Tmall. |

`pageSize`, provider routing, endpoint selection, upstream parameters and arbitrary passthrough fields are
rejected.

Marketplace options:

| Marketplace | Sort values | Price |
| --- | --- | --- |
| Taobao / Tmall | `relevance`, `sales_desc`, `price_asc`, `price_desc` | supported |
| JD | none | unsupported |
| Xiaohongshu ecommerce | none | unsupported |
| Xianyu | `relevance`, `recent`, `seller_credit`, `price_asc`, `price_desc`, `price_drop`, `newest` | unsupported |

### Response

The public response is always `mx-insight-hub.ecommerce-products.v1`. Each item contains only the normalized
allowlist:

- `id`, `marketplace`, `title`, `url`;
- `pricing.current`, `pricing.original`, `pricing.currency`;
- `shop.id`, `shop.name`;
- `images[]`;
- `signals.sales`, `signals.reviewCount`, `signals.location`;
- `attributes.brand`, `attributes.category`.

Missing evidence remains null or empty. Hub never guesses a field solely to make the demo look complete.
Page evidence includes `page`, `returnedCount`, `discardedCount`, `hasMore` and `nextCursor`. Delivery evidence
includes `capturedAt`, `servedAt`, `sourceMode`, `ageSeconds` and `requestId`.

### Media read

The optional media endpoint uses the same Public Hub authentication boundary:

```http
GET /api/v1/data/ecommerce/products/media?requestId=<uuid>&itemId=<returned-id>&imageIndex=<0-19>
Authorization: Bearer <mih_live_ Hub Public API Key>
```

The Live key must still have the `ecommerce` grant. A valid Test key returns `403 test_key_not_supported` before
Hub reads the committed result or invokes the image loader. `requestId`, `itemId` and `imageIndex` are all required;
`itemId` is bounded to 512 characters. Any other query key returns `400 unsupported_fields`. Success returns
JPEG, PNG or WebP bytes rather than a JSON envelope; AVIF and GIF are not accepted. The read has no
`Idempotency-Key`, creates no usage row and never invokes product search. It is an authenticated view of an
image reference already retained in the same consumer's committed search response, not a generic fetch-by-URL
service. Per-consumer rate/concurrency and relay-wide concurrency exhaustion return
`429 external_media_rate_limited` or `429 external_media_busy`; timeout returns
`504 external_media_timeout`. Responses include `Cache-Control: private, no-store` and
`Vary: Authorization`, so caches cannot retain or reuse bytes across consumer credentials.

## 7. Source mode and billing interpretation

Hub usage, provider procurement cost and customer pricing are three independent domains.

| sourceMode | New Hub usage row | New provider dispatch | Cost interpretation |
| --- | --- | --- | --- |
| `live` | yes | yes | A business-success response is recorded as provider-billed under the reviewed provider rule; that is internal procurement evidence, not a Hub customer charge. Monetary amount remains unknown unless a reviewed provider price book is configured. |
| `fresh_cache` | yes | no | A new customer request consumed Hub service while reusing a fresh exact snapshot. |
| `stored_fallback` | yes | maybe | Fallback can happen before dispatch, or after a failed/ambiguous dispatch; it cannot be labelled universally free. |
| `idempotent_replay` | no | no | The exact committed request is replayed with the original request ID. |

Future Hub pricing must price the service independently from provider cost. A customer charge may include
normalization, durable archive, search projection, freshness SLA and reliability even when the current request
uses cache. Provider price/free quota/balance remain null unless obtained from a verified API or a dated manual
price book; unknown is never zero. Provider rates, balances, free quota and procurement evidence stay Internal.
The Public capability, search and media responses never expose them. A separately versioned Hub price book will
apply customer rates through the same consumer identity, without issuing a second Hub API key or changing this API contract.

## 8. Idempotency and pagination

- Same path + same normalized body + same `Idempotency-Key` means one exact logical request.
- Same `Idempotency-Key` + different body returns `409 idempotency_conflict`.
- Every Live ambiguous retry reuses the exact original path, normalized body and `Idempotency-Key`. This includes transport
  failures and accepted-but-unusable provider responses; a new `Idempotency-Key` is never a recovery mechanism.
- Replay is consumer-scoped in the backend. The browser workbench stores only a one-way fingerprint of the
  exact API-key secret and requires that same secret for conservative ambiguous-outcome recovery; rotating a
  key does not reveal whether two secrets belong to the same consumer in browser memory.
- A historical ambiguous Test-key record remains locked to its stored body, `Idempotency-Key` and fingerprint for
  operator reconciliation. The page neither validates nor replays it and does not convert it into a Live request.
- A next cursor is a new request and uses a new `Idempotency-Key`.
- Returning to page one is explicit: replay the original `Idempotency-Key` for the original result, or use a new `Idempotency-Key` to ask
  for a new first-page observation.
- `hasMore=false` stops normally.
- `hasMore=null` also stops. It means the provider response did not prove a safe continuation.
- Provider continuation data is authenticated-encrypted inside the Hub cursor and never exposed separately.
- `request_in_progress`, unknown outcome and unusable response must never be bypassed by swapping
  `Idempotency-Key` values in an
  automatic retry loop.

The current cursor state is implicitly bound to the only released provider, JustOne. Before a second provider
can serve this operation, a new authenticated-encrypted cursor state must carry the selected `providerKey` and
provider contract version. Existing cursor state remains JustOne-compatible. A next-page request must stay on
that pinned provider even if route priority changes; if it is unavailable, Hub may serve the exact stored page
or return a stable error, but must not hand its private continuation to another supplier.

## 9. Storage and lineage

Every accepted provider dispatch has one response-level evidence object, including an empty or unusable page.
Usable items add per-item archive objects. The deterministic object-key family is:

```text
justone/{marketplace}/product-search/v1/{yyyy-mm-dd}/responses/{sha256}.json
justone/{marketplace}/product-search/v1/{yyyy-mm-dd}/items/{sha256}.json
```

The API key and private fields are removed before archive construction. Normalized rows then flow through:

```text
immutable external archive
  -> ecommerce.products.v1 canonical record/revision
  -> transactional outbox
  -> rebuildable Elasticsearch projection
```

Canonical identity is `marketplace:nativeProductId`. PostgreSQL remains authoritative; Elasticsearch is never
the only copy and is not dual-written from the request handler.

## 10. Source-catalog marking

Catalog coverage and provider execution are separate facts. The Admin table therefore renders JustOne hints as:

| Catalog rows | Marker | Meaning |
| --- | --- | --- |
| 淘宝、天猫、京东、小红书店铺、闲鱼 | `JustOne · 商品搜索已接` | Runtime marketplace exists in the reviewed Hub contract. |
| 抖音电商、快手小店 | `JustOne · 接入线索` | Historical catalog evidence exists, but there is no callable JustOne product-search contract. |

Douyin ecommerce and Kuaishou Shop can still have Hub mobile-collector data. That is a different ingestion
path and must not be presented as JustOne runtime support. The built-in `JustOne 已接` view contains only the
five reviewed runtime rows.

## 11. Capability-atlas rules

The Admin demo groups the provider catalog into:

1. **Hub 已接入并核验** — executable today through the stable contract;
2. **官方电商能力 · 待 Hub 契约** — documented upstream but still needs a pinned request/response contract,
   fixtures, normalization, archival, idempotency and cost review;
3. **官方内容与平台族 · 待产品化** — should become separate Hub products instead of stretching product search.

No static catalog chip grants access or proves runtime health. Deleted/deprecated provider routes remain only
historical evidence and are not simulated from other endpoints.

## 12. Compatibility and release gates

- The change adds one Admin-only route and one public documentation route.
- It does not rename or remove an existing Admin or public route.
- It does not alter SessionGate, Launcher identity, MX-H2I login, Domestic/Internal routing, WireGuard or DNS.
- It does not make provider readiness a Hub readiness or login dependency.
- A new upstream response shape requires a reviewed fixture and an explicit adapter item path.
- A new marketplace/operation requires a new capability-map entry, tests and release approval; a UI label is
  never enough.
- A future multi-provider router selects one eligible provider deterministically before dispatch. Credential,
  contract, circuit or route failures discovered before dispatch may select the next candidate; once a provider
  call begins, `billed=true`, `billed=null`, unknown outcome or unusable success always stops provider switching.

## 13. Acceptance criteria

- Safe demo search completes with no Public product-search request, Hub usage or provider request; ordinary
  authenticated Admin bootstrap traffic is not part of this assertion.
- Live mode cannot submit without a `mih_live_` Hub Public API Key and explicit cost confirmation.
- A Test key makes no capabilities, search or media request from the workbench; a historical ambiguous Test
  record stays locked for operator reconciliation.
- The provider key cannot appear in browser storage, URL, source catalog or public output.
- `live`, `fresh_cache`, `stored_fallback` and `idempotent_replay` are visibly distinct.
- Selecting a sphere is keyboard accessible and exposes normalized product attributes.
- Upstream product images are not auto-loaded in Admin; a neutral icon is the default.
- The page is usable at desktop, tablet and 320 px width.
- `prefers-reduced-motion` yields a static but complete state transition.
- The five connected catalog rows and two evidence-only rows are distinguishable.
- Public docs continue to pass the provider-identity boundary tests.
- The page identifies the current runtime as single-provider JustOne and does not claim cross-provider failover.
- Changing product-sphere display groups performs no acquisition request; requesting `nextCursor` is explicit.
- Live product images are read only through the authenticated, reference-based Hub media relay; display/media
  reads neither create ecommerce usage nor dispatch product search, and callers cannot supply a URL.
