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
5. Results emerge as keyboard-focusable product spheres around the mascot. The Admin surface uses a neutral
   product icon by default: it does not automatically fetch an upstream image URL. A future explicit operator
   preview may load a normalized HTTPS image, but that external request and its privacy boundary must be clear.
6. Selecting a sphere shows the exact normalized ID, price, shop, brand, category and signal fields.
7. The evidence panel names the real `sourceMode`, request ID, data age, Hub usage implication and whether a
   new provider call happened.
8. The operator can open the external-platform command center, API Keys, source catalog or public docs.

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
Hub consumer key. The surrounding Admin application may still refresh its own authenticated session or other
Admin data, so “safe” must not be described as a blanket browser-offline mode.

### Live Hub API

Live mode accepts a **Hub consumer API Key**, not a JustOne key. The value:

- remains only in React component memory;
- is rendered as a password field;
- uses `autocomplete=off`;
- is not written to localStorage, sessionStorage, a URL or an Admin API;
- is sent only as `Authorization: Bearer …` to the existing public Hub path.

The operator must check a per-request confirmation before a new logical request. This protects against an
accidental repeated paid action. The confirmation clears after a completed request. Exact replay uses the
previous request body and previous idempotency key, so it cannot silently become a new dispatch.

The workbench stores only the secret-free exact request ledger and a one-way consumer fingerprint for replay.
An ambiguous result -- including a transport interruption or an accepted response that cannot be normalized --
must be retried, if at all, with the same path, normalized body and `Idempotency-Key`. Creating a new key can
turn an uncertain paid attempt into a second dispatch. Editing or replacing the Hub consumer API Key invalidates
the workbench's local replay state because the browser cannot prove that the replacement represents the same
consumer. On submit after a reload, a fingerprint mismatch also rejects and clears the replay. The caller must
then resolve the old request operationally before explicitly confirming a new logical request.

The upstream JustOne key remains in **数据清洗中心 → 外部数据平台 → JustOne → API Key 管理**. Reveal/copy
requires a second Admin Token check; it never belongs in this product, source-catalog metadata or public docs.

Production keeps the browser route aligned with the listener boundary:

- `MX_INSIGHT_PUBLIC_URL` is an HTTP(S) **origin** configured on the Admin deployment. It must not contain
  credentials, a path, query or fragment. After management authentication, the Admin session returns it as
  `publicApiBaseUrl`, and the SPA uses that runtime value for Public data calls and Public docs links;
- this value is routing metadata delivered only inside the authenticated management session. It is not an API
  key, does not authorize a data request and must not be placed in `Authorization`; live calls still require a
  separately issued Hub consumer API Key;
- a direct Admin SPA visit on `:18151` sends bearer-key data calls and docs navigation to the same host on
  Public `:18150` only as the compatibility fallback when no runtime Public origin was delivered;
- combined local mode and an edge that routes `/admin`, `/api` and `/docs` on one origin stay same-origin;
- build-time `VITE_MX_INSIGHT_PUBLIC_API_BASE` and `VITE_MX_INSIGHT_PUBLIC_DOCS_URL` values are fallback hints,
  not the preferred production configuration and not credentials;
- the Public listener returns wildcard CORS only for `/api/v1/*` bearer-key routes and exposes only the
  delivery/evidence headers used by this workbench. The Admin listener still returns 404 for every public API
  path, and public CORS never applies to `/internal/v1/admin/*`.

## 6. Stable API contract

### Request

```http
POST /api/v1/data/ecommerce/products/search
Authorization: Bearer <Hub consumer API Key>
Content-Type: application/json
Idempotency-Key: <8-128 safe characters>
```

Allowed body keys are exactly:

| Field | Required | Rule |
| --- | --- | --- |
| `marketplace` | yes | `taobao`, `tmall`, `jd`, `xiaohongshu_ec` or `xianyu`. |
| `query` | yes | NFKC-normalized non-empty text, maximum 200 characters. |
| `page` | no | 1–1000; mutually exclusive with `cursor`. |
| `cursor` | no | Opaque signed Hub cursor; maximum 4096 characters. |
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

## 7. Source mode and billing interpretation

Hub customer metering and provider procurement cost are independent evidence domains.

| sourceMode | New Hub usage row | New provider dispatch | Cost interpretation |
| --- | --- | --- | --- |
| `live` | yes | yes | A business-success response is billed upstream; monetary amount remains unknown unless a reviewed price book is configured. |
| `fresh_cache` | yes | no | A new customer request consumed Hub service while reusing a fresh exact snapshot. |
| `stored_fallback` | yes | maybe | Fallback can happen before dispatch, or after a failed/ambiguous dispatch; it cannot be labelled universally free. |
| `idempotent_replay` | no | no | The exact committed request is replayed with the original request ID. |

Future Hub pricing must price the service independently from provider cost. A customer charge may include
normalization, durable archive, search projection, freshness SLA and reliability even when the current request
uses cache. Provider price/free quota/balance remain null unless obtained from a verified API or a dated manual
price book; unknown is never zero.

## 8. Idempotency and pagination

- Same path + same normalized body + same key means one exact logical request.
- Same key + different body returns `409 idempotency_conflict`.
- Every ambiguous retry reuses the exact original path, normalized body and key. This includes transport
  failures and accepted-but-unusable provider responses; a new key is never a recovery mechanism.
- Replay is consumer-scoped. The workbench invalidates replay when its Hub key input changes and rejects a
  stored replay when the submitted key's consumer fingerprint differs.
- A next cursor is a new request and uses a new key.
- Returning to page one is explicit: replay the original key for the original result, or use a new key to ask
  for a new first-page observation.
- `hasMore=false` stops normally.
- `hasMore=null` also stops. It means the provider response did not prove a safe continuation.
- Provider continuation data is signed inside the Hub cursor and never exposed separately.
- `request_in_progress`, unknown outcome and unusable response must never be bypassed by swapping keys in an
  automatic retry loop.

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

## 13. Acceptance criteria

- Safe demo search completes with no Public product-search request, Hub usage or provider request; ordinary
  authenticated Admin bootstrap traffic is not part of this assertion.
- Live mode cannot submit without a Hub key and explicit cost confirmation.
- The provider key cannot appear in browser storage, URL, source catalog or public output.
- `live`, `fresh_cache`, `stored_fallback` and `idempotent_replay` are visibly distinct.
- Selecting a sphere is keyboard accessible and exposes normalized product attributes.
- Upstream product images are not auto-loaded in Admin; a neutral icon is the default.
- The page is usable at desktop, tablet and 320 px width.
- `prefers-reduced-motion` yields a static but complete state transition.
- The five connected catalog rows and two evidence-only rows are distinguishable.
- Public docs continue to pass the provider-identity boundary tests.
