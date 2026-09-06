# JustOne capability map and Hub adoption plan

Status: five marketplace product-search mappings verified on the current single-provider JustOne runtime;
every other listed capability is inventory only.

Last reviewed: 2026-09-06.

Primary upstream references:

- [JustOne API catalog](https://docs.justoneapi.com/zh/api/)
- [JustOne usage and billing semantics](https://docs.justoneapi.com/zh/usage)

Related Hub documents:

- [External data platform gateway ADR](../adr/0013-external-data-platform-gateway.md)
- [External platform operations](../operations/external-data-platforms.md)
- [Ecommerce treasure-box product](../product/ecommerce-data-treasure-box.md)

## 1. Status vocabulary

| Status | Meaning |
| --- | --- |
| `verified` | Executable through a released Hub contract, backed by reviewed fixtures and adapter tests. |
| `candidate` | The provider documents an endpoint, but Hub has not fixed its request, response, archive, billing or compatibility contract. |
| `composite` | The desired Hub feature needs aggregation, storage or multiple upstream calls; there is no safe one-to-one proxy. |
| `historical` | Previously referenced or deprecated. It is retained as gap evidence and is not advertised as available. |

An upstream endpoint appearing in this document does not grant a Hub consumer access and does not prove the
deployed credential, provider balance or route health.

## 2. Released Hub operation

Public operation:

```text
POST /api/v1/data/ecommerce/products/search
Hub contract: mx-insight-hub.ecommerce-products.v1
Internal operation: ecommerce.products.search
Provider adapter contract: justone.product-search.v1
Canonical dataset: ecommerce.products.v1
```

The four identifiers above are not synonyms. `ecommerce` is the Public authorization and Hub usage scope;
`ecommerce.products.search` is the Hub business operation; the marketplace is a caller-visible business source;
and `justone` is an internal supplier. Granting `ecommerce` does not grant or reveal a provider account, and a
provider name is never accepted in the Public request.

| Hub marketplace | Provider endpoint descriptor | Method | Accepted item paths | Marketplace-specific request behavior | Catalog source |
| --- | --- | --- | --- | --- | --- |
| `taobao` | `taobao-tmall.product-search.v1` | GET | `data.items`, `data.itemList` | sort + price; default `sales_desc` | `source-catalog-0058` |
| `tmall` | `taobao-tmall.product-search.v1` | GET | `data.items`, `data.itemList` | same endpoint with Tmall flag; sort + price | `source-catalog-0059` |
| `jd` | `jd.product-search.v1` | GET | `data.items`, `data.list`, `data.products` | provider default ordering | `source-catalog-0060` |
| `xiaohongshu_ec` | `xiaohongshu-ec.product-search.v1` | GET | `data.items`, `data.products` | continuation remains inside opaque Hub cursor | `source-catalog-0064` |
| `xianyu` | `xianyu.product-search.v1` | GET | `data.items`, `data.list` | seven reviewed sort values | `source-catalog-0073` |

The provider API documents response `data` broadly. Hub accepts only the item-container paths above. A new
shape is a contract change: capture a redacted fixture, add a narrow path, run adapter/contract/ingest tests,
and review discarded-item behavior. A permissive recursive search is not allowed.

### Current topology and future provider routing

The Public contract is provider-neutral, but the released runtime is not yet multi-provider: JustOne is the
only constructed ecommerce provider adapter, and there is no automatic supplier failover. `fresh_cache` and
`stored_fallback` mean exact Hub snapshot reuse; they do not mean that Hub called another supplier. Candidate
providers in this or the source-catalog inventory are not runtime routes.

Before a second supplier is released, Hub must add a code-owned provider registry and a deterministic route for
each `operation + marketplace`. Hosts, endpoint paths and response contracts remain compiled and reviewed; only
secret-free enablement, priority and revision may be operator configuration. Selection happens before a
`provider_calls` row or network request. A candidate that is disabled, unverified, uncredentialed, unsupported
for the request or already circuit-open may be skipped without cost.

The first multi-provider release must still permit at most one actual provider dispatch per Hub usage request.
Once dispatch begins, Hub does not change supplier after an outcome with `billed=true`, `billed=null`,
`unknown` or `succeeded_unusable`; it serves an exact stored snapshot when allowed or returns the stable Public
error. Even a definite unbilled rejection is not a cross-provider retry until the call ledger supports ordered
attempt evidence and a reviewed total attempt/cost budget. This prevents a timeout or unparseable paid response
from becoming two supplier charges hidden behind one customer request.

### Admin workbench runtime boundary

The released Public path remains provider-neutral. In a split production deployment, `MX_INSIGHT_PUBLIC_URL`
configures the Public HTTP(S) origin on the Admin server. A successful authenticated Admin session exposes that
origin as `publicApiBaseUrl`, allowing the SPA to route bearer-key calls to the Public listener at runtime. The
value is routing metadata, not a credential or grant; it contains no credentials/path/query/fragment and never
replaces the ordinary Hub Public API Key. Build-time Public URLs and the same-host `:18150` convention are fallbacks.

The workbench's safe-demo search is browser-local and never calls the Public product-search operation or the
provider. Admin session/bootstrap traffic can still occur. The management browser never assigns a provider
image URL to `img src`. For a visible live item it may call the authenticated Hub media endpoint with the same
consumer's committed search `requestId`, normalized `itemId` and bounded `imageIndex`; missing or rejected media
uses the neutral local icon.

`images[]` in the Public product result remains normalized data, not permission to build an arbitrary proxy.
`GET /api/v1/data/ecommerce/products/media` accepts no URL, reads only a retained image belonging to a committed
HTTP-200 ecommerce response for the authenticated consumer, permits bounded public HTTPS JPEG/PNG/WebP content
and validates DNS plus every redirect against private-network targets. Its three query keys are a strict
allowlist. It sends no browser cookie or provider credential and validates media type/signature, time and body
size. Per-consumer rate/concurrency and global relay concurrency have explicit 429 failures. This media read
creates no Hub usage record and dispatches no product-search request; `private` caching varies on Authorization,
and failure changes only presentation rather than the original search evidence.

External ecommerce search and media accept only the ordinary `mih_live_` Hub Public API Key; there is no
JustOne-product credential. A valid legacy Test key with the ecommerce grant sees `ready=false` in capabilities,
and search/media return `403 test_key_not_supported` before usage reservation, committed-result/media lookup or
external I/O. If an older workbench left an ambiguous Test-key record, it preserves the exact body,
`Idempotency-Key` and credential fingerprint only for operator reconciliation and sends no request.

For an ambiguous Live outcome, recovery preserves the exact Public path, normalized body and
`Idempotency-Key`. A different `Idempotency-Key` can create a second live dispatch and another provider-cost
event. Replacing the Hub Public API key may clear only a resolved local replay shortcut. An ambiguous lock is
retained; an API-key-secret fingerprint mismatch rejects replay and requires the original Live secret or operator
reconciliation, without guessing that a replacement belongs to the same consumer or unlocking a new request.
Backend authorization and idempotency remain consumer-scoped.
None of this exposes the JustOne credential or provider endpoint identity through the Public contract.

The Public authentication order is also independent of JustOne: a missing Hub Public API key is
`401 api_key_required`; an invalid, expired or revoked Hub key is `401 invalid_api_key`; a valid Test key is
`403 test_key_not_supported`; a valid Live key without the `ecommerce` grant is `403 platform_not_granted`.
The upstream JustOne key is accepted only inside the server
adapter. Its absence or rejection becomes a sanitized external-platform availability/capacity error and never
an `invalid_api_key` response, so callers are not instructed to replace a valid Hub credential.

## 3. Provider business codes and billing evidence

The reviewed provider usage guide says a business code `0` response is successful and billed. The currently
mapped non-zero codes are recorded as not billed:

| Code | Hub category | Public behavior |
| ---: | --- | --- |
| 100 | authentication | capacity unavailable; upstream identity hidden |
| 301 | collection failure | rejected or stored fallback |
| 302 | rate limit | capacity exceeded or stored fallback |
| 303 | daily quota | capacity exceeded or stored fallback |
| 400 | request | invalid/rejected request |
| 500 | provider internal | rejected or stored fallback |
| 600 | authorization | capacity unavailable |
| 601 | balance exhausted | capacity unavailable |
| 602 | token limit | capacity unavailable |

Transport timeout or malformed content can have an unknown billing outcome. Hub records `billed=null`, blocks
blind redispatch for the fingerprint cooldown and tells the public client not to retry automatically. It never
converts unknown to zero.

This no-redispatch rule is provider-neutral. Adding another provider must not turn `unknown`, billed success or
billed-but-unusable evidence from JustOne into permission to call the next supplier for the same logical
request.

## 4. Ecommerce candidates

The provider catalog contains more ecommerce coverage than Hub currently exposes. The following inventory is
grouped by the likely Hub product contract, not by raw route count.

| Provider family | Candidate abilities | Hub adoption note |
| --- | --- | --- |
| Taobao / Tmall | V2 search, product detail versions, comments, questions/answers, shop product lists, historical/deprecated sales | Version search separately; detail/comments must not be folded into a search item. |
| JD | V2 search, detail versions, price, comments, shop lists | Price freshness and product/detail identity need explicit tests. |
| Xianyu | product detail | Second-hand seller/privacy fields need a stricter public allowlist. |
| Xiaohongshu ecommerce | search and product-oriented store data | Keep ecommerce identity separate from social-note identity. |
| Douyin ecommerce | product search, detail, SKU, comments, shop data | Catalog row exists, but no Hub runtime marketplace is released. |
| Dewu | search/detail commerce data | Candidate; no Hub contract. |
| 1688 | wholesale search/detail | Candidate; business-price and company fields need a new schema. |
| AliExpress | cross-border search/detail | Candidate; currencies, locale and region must be explicit. |
| Temu | search/detail | Candidate; no Hub contract. |
| Shopee | regional search/detail | Candidate; marketplace region must be part of request scope. |
| TikTok Shop | regional commerce data | Candidate; do not merge with Douyin commerce. |
| Amazon | regional search/detail | Candidate; region, currency and seller identity need explicit contracts. |

“All product search” must not become an unbounded provider passthrough. The preferred expansion sequence is:

1. add a provider fixture and version descriptor;
2. define the provider-neutral Hub business operation;
3. define canonical identity, freshness and merge policy;
4. define response-level and item-level archive objects;
5. define pagination/idempotency and ambiguous-outcome handling;
6. add catalog evidence and capability advertisement only after tests pass.

## 5. Content, creator and non-commerce candidates

These provider families should become separate Hub products and datasets. They are visible in the Admin
capability atlas so planning can compare platform breadth, but they are not callable through ecommerce search.

| Product family | Provider catalog examples | Likely Hub product boundary |
| --- | --- | --- |
| Social content | Xiaohongshu notes/users/comments, Douyin videos/users/comments, Kuaishou, Weibo | governed post/search/detail/comment datasets |
| Creator marketing | Xiaohongshu Pugongying, Douyin Xingtu | creator/brand cooperation metrics with dated snapshots |
| Messaging/publishing | WeChat public accounts, WeChat Channels | content and account datasets; separate authorization/compliance |
| Video | Bilibili, YouTube | video/channel/comment product; no inference from generic post search |
| International social | Reddit, X/Twitter, LinkedIn, Instagram, Facebook | region- and policy-specific connectors with stable canonical identities |
| Knowledge/news | Zhihu, Toutiao | question/article/comment products and citation provenance |
| Entertainment | Douban, IMDb | title/review/catalog products |
| Property | Beike | listing/community products with time-sensitive price evidence |
| Model aggregation | LLM-related provider routes | belongs in Agent Center, not external business-data search |

This list is a reviewed product-family snapshot, not a promise that every current provider route has been
copied into Hub. Consult the linked official catalog for route-level discovery, then pin only the routes
selected for a concrete Hub contract.

## 6. Composite gaps from the historical Figure 4

The rows `search_intent`, `search_post_comments`, `search_post_detail` and `youtube_channel_comments` marked
“无等价接口” do not identify one common defect:

| Gap | Scope | Recommended implementation |
| --- | --- | --- |
| `search_intent` | Hub composite retrieval intent | Build a Hub orchestration contract over search + detail + stored evidence. It is not one provider route. |
| `search_post_comments` | Platform-specific post comments | Add a versioned post-comment operation only for platforms with verified list/continuation semantics. |
| `search_post_detail` | Platform-specific post detail | Add detail adapters with stable post identity and merge policy; do not synthesize from search snippets. |
| `youtube_channel_comments` | YouTube-specific channel/video relationship | Model channel → video → comment traversal explicitly. It is not evidence that all Hub or ecommerce APIs are incomplete. |

Only the last gap is inherently YouTube-specific. The other three are generic capability-modeling gaps whose
actual support varies by provider family.

## 7. Archive and canonicalization checklist

Every new endpoint must answer these questions before release:

- What exact provider request shape and version are pinned?
- What response-level envelope proves a paid attempt, including an empty page?
- Which paths contain items and how are malformed items counted?
- Which private fields are deleted before persistence?
- What is the canonical identity and how is a changed observation revised?
- What makes a snapshot fresh or stale?
- Does an upstream continuation need to remain private inside an opaque cursor?
- Which outcomes are billed, not billed or unknown?
- Which failures may serve a last-good snapshot?
- Which error tells clients not to retry automatically?
- Which source-catalog row is reviewed evidence, and which platform grant authorizes the Hub product?

The current product-search archive convention is:

```text
justone/{marketplace}/product-search/v1/{yyyy-mm-dd}/responses/{sha256}.json
justone/{marketplace}/product-search/v1/{yyyy-mm-dd}/items/{sha256}.json
```

The current encrypted cursor state is implicitly JustOne because it is the only provider. Before another
provider can serve the same Public operation, the next cursor-state version must carry the selected provider
key and provider contract version inside the consumer-scoped ciphertext. Existing cursors continue to resolve
as JustOne. A next page stays with its pinned provider even after route priority changes; Hub never passes one
provider's private continuation to another.

## 8. Quota, price and free-credit roadmap

No verified provider balance, price or free-credit API is wired into this release. Until one is verified:

- `billing.source` remains `manual`;
- currency, per-endpoint unit cost and `pricingAsOf` are entered only from a reviewed price book;
- free daily calls and monthly budget remain optional/unknown;
- cost forecasts show a range or unknown, never a fabricated exact amount.

When a verified provider billing API becomes available, add an internal read-only adapter and immutable
snapshots. Do not call it from public requests. The cost planner may then show:

- remaining free units and expiry;
- daily burn trend and month-end forecast;
- cost by operation, tenant and consumer;
- “consume free units daily” versus prepaid tier scenarios;
- confidence and last refresh time;
- threshold alerts without automatic purchase or recharge.

Customer billing is a separate Hub policy: the provider invoice is an input, not the customer price.

## 9. Review procedure

At every provider catalog review:

1. record the official-catalog review date;
2. diff route names, versions, required parameters and response examples;
3. classify each change as compatible shape, new fixture path, new operation, deprecation or removal;
4. keep released Hub paths stable;
5. add a new Hub contract version only when the normalized public schema or semantics must change;
6. leave the old version callable for its published support window;
7. update the Admin atlas and source-catalog marker only after runtime tests pass.
