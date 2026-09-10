# Open API v1

Base path: `/api/v1`. Authentication uses `Authorization: Bearer <mx key>` or `x-api-key`.

## Capabilities

```http
GET /api/v1/data/capabilities
```

Returns only platforms and generic capabilities granted to the authenticated
consumer. Generic capabilities are returned separately from `platforms`, for
example:

```json
{
  "data": {
    "platforms": [
      {
        "platform": "public_opinion",
        "ready": false,
        "capabilities": [
          "province_feed",
          "province_coverage",
          "region_catalog",
          "region_feed",
          "item_detail",
          "stored_search",
          "diagnostics"
        ],
        "source": "hub",
        "servingMode": "stored"
      },
      {
        "platform": "data_center_saved_records_news",
        "ready": false,
        "capabilities": ["stored_search", "canonical_search"],
        "source": "hub",
        "servingMode": "stored"
      },
      {
        "platform": "xiaohongshu",
        "ready": true,
        "capabilities": ["search_posts", "post_detail"],
        "search": {
          "ready": true,
          "source": "hub",
          "servingMode": "live_with_stored_fallback",
          "contractVersion": "night-all.data-search.v1"
        },
        "postDetail": {
          "ready": true,
          "source": "hub",
          "servingMode": "live_with_stored_fallback",
          "contractVersion": "mx-insight-hub.social-post.v1",
          "input": "official_note_url",
          "deliveryModes": ["cache_only", "cache_first", "refresh"]
        }
      }
    ],
    "capabilities": [
      { "capability": "nlp.tokenize", "ready": true },
      { "capability": "public_opinion.all_ingested.read", "ready": true },
      { "capability": "public_opinion.diagnostics.read", "ready": true },
      { "capability": "social.posts.resolve", "ready": true }
    ]
  }
}
```

Provider names and internal endpoint IDs are omitted.

`platforms` contains only explicitly granted data platforms. For the Hub-owned
`public_opinion` platform, `province_feed`, `province_coverage`,
`region_catalog`, `region_feed`, `item_detail`, `stored_search`, and
`diagnostics` name the
supported serving surfaces. Its `ready` flag is not a second authorization
decision or a freshness guarantee. An initially unconfigured or paused source
may report `ready=false`, while previously indexed records can still be
available through read APIs whose own serving gates are ready. The platform is
local to Hub and is never added to the Night-All legacy dispatch matrix.

Each explicitly granted `data_center_saved_records_<source_type>` entry is also
Hub-owned and stored-only. It advertises `stored_search` and
`canonical_search`; `ready=true` requires that exact fixed leaf source to be
active and the search layer to be configured. A paused leaf may still retain
stored rows, so readiness is neither a publication grant nor a freshness
guarantee. These platform names never enter `data.legacySearch`.

`public_opinion.all_ingested.read` is a separate, non-default step-up
capability. It never grants the `public_opinion` platform by itself. The P1
region feed requires both the platform grant and this capability; a consumer
with only one of them cannot read the all-ingested view. Capability discovery
returns the entry only to a consumer that has explicitly received the grant.

The same rule applies to `public_opinion.diagnostics.read`: it is an explicit,
non-default step-up capability and never grants the `public_opinion` platform
by itself. Funnel and unshown-record diagnostics require both grants. The
`source_catalog` platform is Hub-owned and advertises `catalog_entries`,
`catalog_metadata`, `catalog_detail`, and `filtered_browse` when its stored
serving surface is ready.

An explicitly granted `ecommerce` entry advertises `product_search`,
`contractVersion=mx-insight-hub.ecommerce-products.v1`, the supported
marketplaces, `pagination=opaque_cursor`, `idempotencyKey=optional`, and the
four freshness modes. Its `servingMode=live_with_stored_fallback` distinguishes
it from stored-only products. `ready=true` means the deployed Hub has a usable
adapter; it is not a promise that the external platform, quota or network is
healthy for the next call.

An explicitly granted `xiaohongshu` entry advertises `search_posts` when the
independent first-page rollout gate for the Hub-native external-data search
connector is enabled. Its nested `search`
object reports `ready`, `source=hub`,
`servingMode=live_with_stored_fallback`, and
`contractVersion=night-all.data-search.v1`. This search authorization comes
from the Xiaohongshu platform grant. `post_detail` and the nested `postDetail`
contract appear only when the key also has the independent
`social.posts.resolve` capability grant; search availability never grants the
explicit note-detail API by implication.

If the compatibility capability response already contains the Xiaohongshu
platform row, Hub preserves that row's provider-neutral top-level readiness and
source identity. Do not interpret top-level `ready` as direct readiness or
assume top-level `source=hub`; only nested `search.ready`/`search.source` and
`postDetail.ready`/`postDetail.source` describe the Hub-direct contracts.

For a valid legacy `mih_test_` key whose consumer has that grant, the same
`ecommerce` entry is returned with `ready=false` regardless of adapter readiness.
Test is compatibility metadata, not an ecommerce sandbox; clients must not use
that entry to attempt acquisition. Reading capabilities itself creates no
ecommerce usage reservation and does not call a provider.

The credential is the same Hub Public API key issued through the ordinary API
Keys lifecycle; Hub never issues a supplier key to the caller. A newly issued
key freezes the selected subset of its consumer's current platform and
capability grants together with bounded quota ceilings. Removing a consumer
grant immediately narrows every key, while a later grant never silently expands
an existing snapshot key: issue a replacement key that explicitly selects the
new scope. Grandfathered `legacy_dynamic` keys keep the old dynamic behavior
only during migration and should be rotated. External ecommerce search and
media also require a Live key; this is a route gate, not a second product
credential.

An `Idempotency-Key` is unique within a consumer, but a mutating POST or replay
must use the same Hub API key that created its usage record. Another API key for
the same consumer may perform the documented read-only status lookup, but it
cannot take over, replay or refresh that record; it must use a new
`Idempotency-Key`. This keeps per-key business usage attribution immutable.

## Source catalog

```http
GET /api/v1/data/source-catalog?coverageStatus=covered&deliveryStatus=doing&pageSize=50
GET /api/v1/data/source-catalog/metadata
GET /api/v1/data/source-catalog/{id}
Authorization: Bearer <mx key>
```

All three routes require the explicit `source_catalog` platform grant. They accept
an issued API Key, not an Admin Token or Launcher session. Every safe GET and
retry is independently metered against the platform policy and does not use an
`Idempotency-Key`.

The list returns only active catalog entries under
`contractVersion=source-catalog.public.v1`. It exposes the governed fields
needed to reconstruct the Hub directory and external status reporting:
platform/name and aliases, source kind, major category, scenarios, regions,
representative modules, observable content, extractable clues, tracking fields,
suggested access, compliance boundary, priority, coverage, delivery, field
review, runtime status, owner, tags, notes and access leads. It does not expose
`evidenceRefs`, `customFields`, `importedFrom`, event/revision history,
related-data coordinates, account linkage, connections or credentials.
Ordinary governed business notes remain public. Before filtering, searching or
building facets, the Hub removes high-confidence DSNs, credentialed URLs,
private-network connection coordinates, API keys, tokens, passwords and other
credential material accidentally pasted into free-text fields. Every entry
always includes `redactedFields`; taxonomy and owner projections include it
when one of their fields was removed.

The complete filter allowlist is `query`, `sourceKind`, `majorCategory`,
`scenario`, `region`, `coverageStatus`, `deliveryStatus`, `reviewStatus`,
`runtimeStatus`, `priority`, `ownerId`, `tag`, `pageSize`, and `cursor`.
`pageSize` defaults to 50, is capped at 100, and may be reduced by the
consumer's `source_catalog` policy. `pageInfo` contains `returnedCount`,
`totalCount`, `hasMore`, and `nextCursor`.

Pagination uses an HMAC-signed keyset ordered by
`(legacySequence NULLS LAST, canonicalName, id)`. The cursor is bound to the
complete normalized filter set and page size. Clients return it unchanged;
changing any bound and reusing the cursor returns `400 invalid_cursor`, so the
client must restart without a cursor.

`GET /data/source-catalog/metadata` returns the public field definitions and
enums, current active taxonomy, public owner projections, global summary and
facets. Together with the list it is sufficient to reconstruct filters,
coverage/delivery reports, owner selectors and status dashboards without
exposing management APIs. This route accepts no query fields; any supplied key
returns `400 unsupported_fields`.

The metadata response is strict rather than an open-ended JSON bag. `summary`
always contains active totals, coverage/delivery/review/priority counts,
coverage rate, unassigned-owner count, and category summaries. `facets` always
contains `majorCategories`, `scenarios`, `regions`, `owners`,
`connectorHints`, and `tags`. Both schemas reject additional properties;
adding a field requires an explicit contract-version review.

`GET /data/source-catalog/{id}` accepts an exact UUID returned by the list and
returns `data.contractVersion`, the same safe `data.item` projection, and the
top-level `requestId`. It is active-only, accepts no query fields, does not
expose any extra management fields, and shares the same platform quota. An
invalid UUID returns `400 invalid_source_catalog_id`; any query key returns
`400 unsupported_fields`; an unknown or archived UUID returns
`404 source_catalog_entry_not_found`. Authentication, grant, quota, and storage
failures use `api_key_required` / `invalid_api_key`, `platform_not_granted`,
`quota_exceeded`, and `stored_data_unavailable`, respectively.

## Mobile-commerce captures and virtual supermarket

The existing capture routes remain unchanged:

```http
GET /api/v1/data/mobile-commerce/items
GET /api/v1/data/source-catalog/{id}/items
```

`mobile-commerce-items.v1` is a stored observation contract. Its `id` identifies
a capture row, not necessarily a marketplace product. It retains the
`mobile_commerce` platform grant, filters, response schema and stored-only
semantics. The catalog child route additionally requires `source_catalog` and
uses the reviewed marketplace catalog UUID. Neither route publishes, merges or
places a supermarket product, and this new product surface does not change its
v1 behavior.

The virtual supermarket is a separate Hub-owned publication product:

```http
GET /api/v1/data/virtual-supermarket/metadata
GET /api/v1/data/virtual-supermarket/products
GET /api/v1/data/virtual-supermarket/products/{id}
GET /api/v1/data/virtual-supermarket/search?query=洗衣液
```

All four routes require the explicit `virtual_supermarket` platform grant. A
`mobile_commerce` or `source_catalog` grant does not imply this grant, and the
reverse is also false. Discovery advertises only granted and ready Hub stored
surfaces with capabilities `metadata`, `products`, `product_detail`,
`stored_search`, `category_filter`, `department_filter`, `aisle_filter`,
`shelf_filter`, and `marketplace_filter` when those surfaces are available.
Public API keys never receive management or publish/unpublish capabilities.

The response contract is
`mx-insight-hub.data-products.virtual-supermarket.v1`. Public list and detail
responses are **on-shelf only**. Unpublished, archived and unknown IDs all
return `404 virtual_supermarket_product_not_found`. Unpublishing changes the
Hub storefront overlay; it never deletes or tombstones the referenced canonical
capture.

The public `id` is an independently allocated, stable Hub publication UUID. It
is not the mobile-commerce capture/canonical row UUID, and a capture UUID is not
accepted by the Public detail route. The private reference from publication to
canonical evidence remains an Admin/storage concern.

The Hub console renders the same product snapshot in three modes: 逛超市,
超市全景 and 目录模式. The panorama is a client renderer, not an API
coordinate system. Metadata and items expose stable semantic department,
aisle, shelf and position values; they do not expose WebGL coordinates,
cameras, meshes, materials, lighting or renderer state. An external client can
therefore reproduce an equivalent hierarchy using a 2D, accessible or spatial
renderer of its choice.

`GET /metadata` returns the public department/aisle/shelf/category model and a
`storefrontRevision`. Product list/search pages return the same revision.
`GET /products` and `GET /search` accept the allowlisted filters
`categoryId`, `department`, `aisle`, `shelf`, `marketplace`, `query`, `sort`,
`pageSize`, and `cursor`; search requires a non-blank `query`. `sort` is one of
`newest`, `title_asc`, `price_asc`, or `price_desc`, and defaults to `newest`.
There is no server-side merchandising sort in v1. The consumer policy may reduce
the page-size maximum.

Pagination uses an opaque HMAC-signed cursor bound to the complete
normalized filter set, sort, page size and `storefrontRevision`. Clients return
it unchanged. A changed filter starts a new traversal. Hub must either continue
serving the exact bound revision or reject a stale traversal with
`409 storefront_revision_changed`; the current v1 implementation uses the
latter and never silently combines products from two storefront revisions.

To reproduce the complete storefront, a client first records metadata's
`storefrontRevision`, then traverses products from an empty cursor through
`nextCursor=null` without changing filters, sort or page size. After all pages
have the same revision, it orders department/aisle/shelf/category by metadata
`sortOrder` and products by `placement.position`, using publication `id` as a
stable tie-breaker. A metadata/page revision mismatch or 409 invalidates the
incomplete local snapshot and restarts the traversal from metadata and page one.

The public product projection uses an explicit allowlist: publication ID,
listing status/revision and data version; title and reviewed specification;
decimal price, nullable currency and display with provenance;
semantic category and placement; reviewed marketplace `{id,name}` and shop
display values; a sales signal; field provenance; and collection time. Price is
an observation at the item's outer `collectedAt`, not a real-time marketplace
quote. The fixed source has no currency column, so a source price keeps
`currency=null`; only a human-curated price override carries a reviewed
three-letter ISO currency. Missing specification or typed price remains null;
the API does not invent it. The v1 projection has no brand or media field
because the current source does not support either safely.

The projection excludes capture/source-row identity, marketplace product/shop
source IDs, marketplace raw labels/mapping state/internal source keys, task/run/keyword/campaign
fields, catalog source keys/revisions, raw tags, mixed signals, share/open-app
payloads, arbitrary metadata, device identifiers, `is_reported`, physical
source/profile/table/checkpoint/run details, Admin actors/audit, credentials and
Elasticsearch index/field/DSL controls. Public marketplace is only the approved
directory `{id,name}`; both values are null without an approved mapping, while
full mapping evidence remains Admin-only. Title similarity does not merge rows
when a reviewed marketplace product identity is absent.

## External data platform product search

```http
POST /api/v1/data/ecommerce/products/search
Authorization: Bearer <mih_live_ Hub Public API key>
Idempotency-Key: <caller-generated key for this page>
Content-Type: application/json

{
  "marketplace": "jd",
  "query": "AI recorder"
}
```

This route requires the explicit `ecommerce` platform grant. It is a stable Hub
contract over a governed external data platform, not a transparent proxy. The
public request and response never contain the external platform identity,
credential, endpoint, private continuation value, or raw response.

`ecommerce` is a provider-neutral data authorization domain, not the identity
of a physical supplier. The current release has one private eligible adapter and
no multi-provider runtime router or automatic supplier failover; adding another
verified adapter later does not change the caller contract. A missing, invalid,
or revoked Hub Public API key
returns `401 api_key_required` or `401 invalid_api_key`. An otherwise valid key
with Test environment returns `403 test_key_not_supported` before grant lookup,
usage reservation, cache lookup or provider dispatch. An otherwise valid Live
key whose consumer lacks the `ecommerce` grant returns
`403 platform_not_granted`. Clients must not treat those conditions as
interchangeable. A Test-key rejection creates no usage reservation and makes no
provider call.

An ambiguous request recorded by an older client under a Test key is not a
replay exception. Preserve its exact body and `Idempotency-Key` as evidence. The
treasure-box page uses the current Live key for an automatic consumer-scoped
status GET; it does not ask the user for the old Test secret, a request UUID or
a manual ownership check.

The request is a strict object. Its complete field allowlist is `marketplace`,
`query`, `deliveryMode`, `page`, `cursor`, `sort`, and `price`; any other field returns
`400 unsupported_request_field`. In particular, there is no `pageSize` field:
Hub owns the bounded result-size policy. `marketplace` is one of `taobao`,
`tmall`, `jd`, `xiaohongshu_ec`, or `xianyu`. `query` is NFKC-normalized,
trimmed, required, and limited to 200 characters. `page` is an integer from 1
through 1,000 and defaults to 1.

`deliveryMode` is optional and defaults to `cache_first` for backward
compatibility. It is a delivery intent, never a provider selector:

- `cache_only` reads only an exact same-consumer Hub snapshot. It never creates
  an external provider call. A missing snapshot returns
  `404 stored_snapshot_not_found`; a retained stale snapshot can be returned as
  `stored_fallback`.
- `cache_first` uses an exact fresh snapshot when present, otherwise permits one
  governed acquisition and can fall back to an exact retained snapshot.
- `refresh` bypasses an exact fresh snapshot and permits one new acquisition. It
  requires a caller-supplied `Idempotency-Key`, and can still return
  `stored_fallback` after an attempted acquisition fails.

`X-MX-Insight-Retry-Of: <old requestId>` is a narrow uncertain-repeat signal.
It is accepted only with `deliveryMode=refresh`, a new `Idempotency-Key`, and a
prior same-consumer acquisition whose durable status is positively `unknown`.
Hub verifies ownership, ecommerce operation and the normalized acquisition
fingerprint. The treasure-box page obtains the old UUID from its automatic GET
and adds the header when the operator selects `refresh` and presses the main
button; the user does not enter it or complete a separate confirmation. Sending
the header deliberately accepts that the old request may already have incurred
provider cost. The header never bypasses
`reserved`, a succeeded-but-unusable endpoint quarantine, a status-lookup
network failure, route/version mismatch, quota, circuit or concurrency
protection. Omitting it preserves the default
duplicate-prevention behavior.

Changing only `deliveryMode` does not change the logical snapshot identity.
Reusing an already committed `Idempotency-Key` therefore replays its original
result; it cannot turn an old cache delivery into a new refresh.

The Admin treasure-box choices `3`, `6`, and `9` are browser-local presentation
sizes over the current returned batch. They are not request fields, do not
resize a Hub page, and do not independently dispatch another product search.

`page` and `cursor` are mutually exclusive. Prefer the opaque `nextCursor`
returned by Hub, return it unchanged, and keep `marketplace`, `query`, `sort`,
and `price` identical. The cursor is authenticated-encrypted and consumer/scope
bound; changing a bound field, tampering, or reusing it for another consumer
returns `400 cursor_scope_mismatch` or `400 invalid_cursor`. Some marketplaces
require an opaque continuation after page one, so clients must not synthesize a numeric next page.
If `nextCursor` is null, stop. `hasMore=null` means the external response did not
provide enough evidence for Hub to issue a safe continuation; it is not
permission to guess another page.

Sort and price support are marketplace-specific:

- `taobao` and `tmall` accept `relevance`, `sales_desc`, `price_asc`, and
  `price_desc`; the default is `sales_desc`. They also accept an inclusive
  `price` object with optional non-negative decimal-string `min` and `max`
  values. Numbers, exponent notation, whitespace and leading zeroes are not
  accepted; each value allows at most 12 integer and 8 fractional digits.
- `xianyu` accepts `relevance`, `recent`, `seller_credit`, `price_asc`,
  `price_desc`, `price_drop`, and `newest`; the default is `relevance`.
- `jd` and `xiaohongshu_ec` do not accept `sort`; neither accepts `price`.

`Idempotency-Key` is optional for `cache_only` and `cache_first`, but required
for `refresh`; it remains strongly recommended for auditable replay control.
Use the same `Idempotency-Key` only when retrying the exact same
path and page body. The key permanently binds that request; reusing it with a
different body returns `409 idempotency_conflict`. Every continuation has a
different body and **must use a new Idempotency-Key**. When the header is
omitted, Hub assigns a unique internal key to that HTTP call. It is therefore a
distinct metered usage/charge even if an exact consumer snapshot serves it;
snapshot and provider-dispatch suppression remain independent. Durable replay
requires the caller to supply and explicitly reuse a key.

The response is provider-neutral:

```json
{
  "contractVersion": "mx-insight-hub.ecommerce-products.v1",
  "data": { "item": {
    "items": [{
      "id": "product-id",
      "marketplace": "jd",
      "title": "AI recorder",
      "url": null,
      "pricing": { "current": "399", "original": null, "currency": "CNY" },
      "shop": { "id": null, "name": "Example shop" },
      "images": [],
      "signals": { "sales": null, "reviewCount": "25", "location": null },
      "attributes": { "brand": null, "category": null }
    }],
    "page": {
      "page": 1,
      "returnedCount": 1,
      "discardedCount": 0,
      "hasMore": false,
      "nextCursor": null
    }
  },
  "meta": {
    "capturedAt": "2026-09-03T00:00:00.000Z",
    "servedAt": "2026-09-03T00:00:00.010Z",
    "sourceMode": "live",
    "ageSeconds": 0
  },
  "requestId": "00000000-0000-4000-8000-000000000006"
}
```

`meta.sourceMode` is always one of:

- `live`: Hub completed a new external data call;
- `fresh_cache`: an exact, still-fresh snapshot for the same consumer and
  normalized request was served without another external call;
- `stored_fallback`: an exact last-good snapshot was served because the live
  path was unavailable; the response includes freshness age, a bounded
  `fallbackReason`, and HTTP `Warning: 110 - "Response is stale"`;
- `idempotent_replay`: the committed result for the same caller `Idempotency-Key`, path, and
  body was replayed without another external call.

### `meta.reason`

`sourceMode` says what was served; `meta.reason` says why, and it is present on
every delivery rather than only on the degraded ones. A caller therefore never
has to read "no fallbackReason" as "nothing happened":

| field | meaning |
| --- | --- |
| `code` | stable reason identifier; equal to `fallbackReason` when that field is present, and one of `live`, `fresh_cache_hit`, `idempotent_replay` otherwise |
| `scope` | which subsystem made the decision: `upstream`, `delivery_policy`, `operation_control`, `provider_credential`, `circuit_breaker`, `dispatch_dedup`, `concurrency`, `rate_limit`, `idempotency` |
| `summary` | one-sentence human-readable explanation |
| `degraded` | `true` when the caller received less than a live upstream read |
| `liveAttempted` | `true` when an upstream call was actually started, and therefore possibly billed |
| `detail` | optional structured evidence; for `operation_control` it carries the same `blockers` array the matching `503` publishes |

The reason `code` is also returned in the `x-mx-insight-reason` response header,
and rejections carry the same object at `error.details.reason`, so a degraded
delivery and a hard rejection describe one decision in one vocabulary.

`scope` is the field to route on. `operation_control`, `provider_credential` and
`circuit_breaker` are Hub-side deployment state that an operator fixes;
`upstream` is the provider; `delivery_policy` is the caller's own `deliveryMode`;
`dispatch_dedup`, `concurrency` and `rate_limit` are transient and safe to retry
later. `liveAttempted` separates "no upstream call happened" from "an upstream
call happened and may already be billed" -- the two need different follow-up.

```json
{
  "meta": {
    "sourceMode": "stored_fallback",
    "ageSeconds": 81360,
    "fallbackReason": "external_platform_operation_blocked",
    "reason": {
      "code": "external_platform_operation_blocked",
      "scope": "operation_control",
      "summary": "A deployment prerequisite (release, contract gate, credential or reviewed cost evidence) blocks dispatch. See detail.blockers.",
      "degraded": true,
      "liveAttempted": false,
      "detail": {
        "blockers": [
          {
            "code": "price_control_incomplete",
            "message": "Reviewed upstream price and budget evidence is incomplete",
            "endpointKeys": ["jd.product-search.v1"]
          }
        ]
      }
    }
  }
}
```

If a live acquisition reaches database operation control and no exact fallback
can be delivered, its policy state is exposed without umbrella remapping:

- `503 external_platform_operation_disabled`: the operation is explicitly disabled;
- `503 external_platform_operation_shadow`: it is validation-only and cannot create a customer dispatch;
- `503 external_platform_operation_paused`: new provider calls are incident-paused;
- `503 external_platform_operation_canary`: the consumer is outside the exact canary allowlist;
- `503 external_platform_operation_blocked`: release, contract, credential or reviewed-cost prerequisites block dispatch.

The provider call-rate admission code is `429 external_platform_rate_limited`;
it is distinct from consumer quota, Hub concurrency and provider capacity.

### Ecommerce product media relay

```http
GET /api/v1/data/ecommerce/products/media?requestId=<uuid>&itemId=<id>&imageIndex=0
Authorization: Bearer <mih_live_ Hub Public API key>
```

This route safely relays one image referenced by a previously committed product
search response. `requestId`, `itemId`, and `imageIndex` are required;
`imageIndex` is an integer from 0 through 19. These are the complete query
allowlist; any additional query key returns `400 unsupported_fields`. The route
deliberately accepts no source URL. It resolves the source only from the named Hub response and applies
bounded scheme, address, redirect, content-type, content-signature, timeout,
and byte-size checks before returning JPEG, PNG, or WebP bytes. AVIF and GIF are
not accepted by this contract.

Access requires all of the following:

- a valid `mih_live_` Hub Public API key and a current `ecommerce` platform grant on its owning consumer;
- a request owned by that same consumer;
- `platform=ecommerce`, `status=committed`, and `responseStatus=200` on that
  request;
- an exact item ID and existing image index in its committed response body.

Missing or invalid authentication returns `401 api_key_required` or
`401 invalid_api_key`; a valid Test key returns `403 test_key_not_supported`
before any committed-result lookup, rate/concurrency entry or media-loader call;
a missing grant on a valid Live key returns `403 platform_not_granted`.
Requests that do not exist, belong to another consumer, are not a committed 200
ecommerce result, or do not contain the requested item/image return the same
`404 external_media_not_found` response and do not disclose ownership.
Rejected sources use bounded media 4xx errors; a source that cannot be fetched
safely returns a bounded 502 error and an end-to-end deadline returns
`504 external_media_timeout`. Per-consumer request-window exhaustion
returns `429 external_media_rate_limited`; per-consumer or relay-wide concurrency
exhaustion returns `429 external_media_busy`. If the retained image origin itself
returns 429, Hub reports the non-retryable `502 external_media_source_throttled`
instead of mislabelling it as Hub capacity. Clients do not fan out retries.

The media GET does not reserve or commit Hub usage, does not dispatch product
search, and does not change the source mode or accounting of the original
request. It can perform a bounded image fetch through the relay, so clients
must not poll or fan out. Hub uses a same-consumer bounded short-lived server
cache to avoid duplicate upstream reads. A successful response has
the verified image Content-Type, `Cache-Control: private, no-store`,
`Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff`, `Vary: Authorization`, and an
`x-mx-insight-request-id` for the media request itself. Browser and shared
caches must not retain or collapse different bearer credentials onto the same URL.
A Test-key rejection also performs no stored-result lookup or image fetch.

Starting without a fresh snapshot, two requests with the same normalized body
but two different valid `Idempotency-Key` values produce `live` followed by
`fresh_cache`. They are two distinct committed Hub usage requests, but only the
first performs an external provider call and creates provider-cost evidence.
Repeating the same body with the same `Idempotency-Key` produces `idempotent_replay`: it adds
neither a Hub usage request nor an external call or provider-cost event. The
gateway audit trail may record delivery of the replay, but that delivery is not
a new Hub usage or provider procurement-cost event. That fact does not decide
another customer charge: the current request-priced ledger keys a charge uniquely
to `usage_request_id`, so an idempotent replay is never charged twice.

A `cache_only` hit is still a new authenticated Hub delivery and therefore a
new Hub usage record, while creating no provider call. A `cache_only` miss
releases its usage reservation and returns 404. This distinction is deliberate:
provider procurement cost, Hub operational usage and future customer billing
are separate ledgers.

Hub operational usage, provider cost and customer billing are separate ledgers.
Migration 056's versioned Hub price book can price a new logical live, cached or
fallback delivery by its stable meter; it never prices an idempotent replay twice
and must not infer a customer price by copying provider-call cost. Provider rates,
balances, free quota and procurement evidence remain Internal-only and never
appear in Public capability, search or media responses.

Every success also returns `x-mx-insight-request-id`,
`x-mx-insight-source-mode`, `x-mx-insight-captured-at`, `Age`, and
`idempotent-replay`. `capturedAt` describes the delivered snapshot, while
`servedAt` describes this response; clients should use them and `ageSeconds`
instead of assuming a `200` response is live. A fallback is scoped to the exact
consumer and normalized request. Hub does not substitute a fuzzy query, another
consumer's data, or a canonical-search result.

The public response intentionally contains no billing or quota fields. On
`external_platform_outcome_unknown`, `external_platform_response_unusable`, or
`request_outcome_unknown`, retain the request ID and original `Idempotency-Key`;
do not create a new `Idempotency-Key` for an automatic retry because an external call may
already have occurred. Only an explicit `unknown` status may be followed by a
separate `refresh` acquisition carrying a new key and
`X-MX-Insight-Retry-Of: <old requestId>`. Deliberately sending that combination
accepts that the prior request may already have incurred provider cost. The
treasure-box page derives the old request ID from its automatic status GET when
the operator selects `refresh` and presses the main button; no separate field or
confirmation is shown. The old record remains audit
evidence. That is a new request, not recovery or retry. `reserved` and failed
status lookups cannot use the override. `external_platform_response_unusable` is a known provider
success whose payload failed the Hub normalizer: Hub commits its public 502 as a
stable failure, so the same key replays that 502 without another provider call.
True transport or persistence ambiguity remains `request_outcome_unknown`.
An HTTP 409 `request_outcome_unknown`, `request_in_progress`, or
`external_platform_response_unusable` can instead describe a new request that Hub suppressed before provider dispatch
because an earlier request or endpoint contract is still quarantined. That suppressed attempt is released, not a
committed replay; clients must not treat its idempotency key as proof that a later request cannot dispatch.
An HTTP 200 response with `data.items=[]` is a valid empty delivery, not an API
failure, and does not by itself prove that provider cost was zero.

### External platform Admin credential control

External-platform overview and detail are available only to the break-glass
Admin Token at `GET /internal/v1/admin/external-platforms` and
`GET /internal/v1/admin/external-platforms/{provider}`. Launcher sessions and
public API keys are rejected. Ordinary overview, detail, and update responses
never contain a plaintext key. Detail exposes only the safe credential DTO
`{source, revision, credentialConfigured, revealable, updatedAt}`.

Replace a provider key in database-managed storage with:

```http
PUT /internal/v1/admin/external-platforms/{provider}/credential
X-MX-Insight-Admin-Token: <admin token>
Content-Type: application/json

{
  "apiKey": "<provider API key>",
  "expectedRevision": 3
}
```

`apiKey` is write-only and is not echoed. `expectedRevision` provides
optimistic-concurrency protection. An environment-managed key is never
revealable or copied into database storage by Hub; an operator must submit the
key again to migrate it.

Viewing or copying a database-managed key requires step-up verification with
the Admin Token in both the Admin header and request body:

```http
POST /internal/v1/admin/external-platforms/{provider}/credential/reveal
X-MX-Insight-Admin-Token: <admin token>
Content-Type: application/json

{
  "adminToken": "<admin token>"
}
```

This is the only response allowed to contain `{apiKey}`. It carries
`Cache-Control: no-store`; clients must keep the plaintext only in the local
reveal interaction and clear it when that interaction closes.

## Topic insight reports

`POST /api/v1/data/topic-reports` creates a durable asynchronous report over
the caller's already-synchronized saved-record corpus. The task reads
PostgreSQL canonical truth directly. It never dispatches a source acquisition,
calls HanLP, or starts/requires an Elasticsearch rebuild. The public contract
version is `mx-insight-hub.data-products.topic-report.v1`.

The request requires an 8–128 character `Idempotency-Key` and accepts only:

- `topic`: normalized text, 2–300 characters;
- `language`: `zh-CN` (default) or `en`;
- `range`: `24h|7d|30d|90d|custom`, default `7d`; custom requires RFC3339
  `from` and `to` and cannot exceed 366 days;
- `sourceScope`: `all_granted` (default) or `selected`; selected requires
  `platforms`, and every platform must be in the authenticated caller's current
  `data_center_saved_records_*` grants;
- `sampleLimit`: 20–500, default 240.

The Hub freezes the exact authorized platform set into the task. An accepted
request returns HTTP `202`, consumes one `data.topic-reports` usage unit, and
can be replayed with the same API Key, path, normalized body and idempotency key.
Changing that tuple returns `409 idempotency_conflict`.

```http
POST /api/v1/data/topic-reports
Authorization: Bearer <mx key>
Idempotency-Key: topic-report-0001
Content-Type: application/json

{
  "topic": "东南亚近期选举与外交政策变化",
  "range": "7d",
  "sourceScope": "all_granted",
  "language": "zh-CN"
}
```

`GET /api/v1/data/topic-reports/{id}` returns `queued`, `running`, `succeeded`
or `failed`, plus `phase` and integer `progress`. Only the owning consumer may
read a public task; another Key for the same consumer may continue polling.
Polling does not consume another unit or start any computation. A successful
result contains an executive summary, time series, category/tag/location/author
dimensions, bounded association nodes/edges and at most 80 public-safe evidence
records. Association edges are co-occurrence evidence, not causal claims.

Report results never include raw source payloads, connector credentials or
internal source identities. They reflect the canonical corpus at execution
time and remain immutable; clients create a new task with a new idempotency key
to analyze later synchronized data.

## Tokenize text

```http
POST /api/v1/tools/tokenize
Authorization: Bearer <mx key>
Idempotency-Key: <caller-generated stable key>
Content-Type: application/json

{ "text": "吴恩达与人工智能" }
```

This route requires the consumer's `nlp.tokenize` capability grant; it does not
imply or require any platform grant. New consumers and existing consumers that
have never configured this capability receive it by default, while an
administrator may explicitly disable it. A valid issued API Key is always
required. The default policy is 1,000 requests per rolling 3,600-second window
for each consumer + capability; every API Key belonging to that consumer shares
the same window. The body is a strict object containing only `text`. Text is
trimmed, must contain a Unicode letter or number, may not contain unsafe control
characters, and is limited to 4,096 characters. The complete JSON body is
additionally bounded at 16 KiB.

```json
{
  "data": {
    "capability": "nlp.tokenize",
    "tokens": ["吴恩达", "与", "人工智能"],
    "actualBackend": "hanlp",
    "degraded": false,
    "errorCode": null
  },
  "requestId": "00000000-0000-4000-8000-000000000004"
}
```

`actualBackend` is the backend that produced this response, one of `hanlp`,
`jieba` or `bigram`; it is not inferred from configuration. `degraded=true`
means the preferred backend failed and a lower-quality backend produced the
tokens. `errorCode`, when present, is a bounded category and never contains an
upstream body, URL, credential or stack.

The request uses the same idempotency ledger as search. Replaying the same path
and body with the same `Idempotency-Key` returns the stored bounded response without another
segmenter call or usage charge. Reusing that key with different text returns
`idempotency_conflict`. A successful request consumes one request from the
capability's `maxRequests/windowSeconds` policy and records at least one usage
unit, normally the number of returned tokens. The original input text is not
stored in usage evidence; the bounded public response is retained solely for
idempotent replay.

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

This live/upstream-compatible route accepts one explicit platform per request.
Platform names `all` (case-insensitive) and `*` are invalid. Multi-platform live
fan-out still belongs in a bounded job because each provider call has its own
cost, failure and continuation. This does not prevent the separate
`/data/canonical/search` route from searching already-stored Hub data across
granted platforms in one canonical index; that route performs no provider
fan-out.

`public_opinion` is a Hub-local stored platform and is deliberately unsupported
on this live-compatible route (`400 platform_operation_unsupported`). Use the
province feed, `/data/stored/search`, or `/data/canonical/search` instead.
Every `data_center_saved_records_*` platform is likewise Hub-local and rejected
by this live route; use `/data/stored/search` or `/data/canonical/search`.

`query` must be non-blank and at most 500 characters after trimming. `cursor`, when present, must be a non-blank opaque string of at most 8,192 characters. Clients must return the cursor from the previous response unchanged rather than constructing or decoding it.

For `platform=xiaohongshu`, omitting `pageSize` selects its default of 20, and
the Hub-native direct connector is eligible only when `pageSize` is exactly 20.
Compatible first-page requests switch only after an independent rollout gate;
every cursor previously issued by a direct traversal remains on the same
connector. Existing direct cursors use the `mxec2` domain. A request assigned to
the historical compatibility path receives a Hub-encrypted `mxnc1` cursor rather
than Night-All's provider cursor, and that traversal terminates after page 15.
An older bare provider cursor cannot prove its page and returns
`400 invalid_cursor`; restart without a cursor and use a new `Idempotency-Key`.
Explicit non-20 page sizes remain on the historical compatibility path. The
caller does not select or learn the external provider and must never move a
cursor between routes, queries or page sizes.

The direct Xiaohongshu search detects note bodies at the 60-character provider
preview boundary using UTF-16, Unicode code-point and grapheme counts. It may
perform a bounded internal detail lookup and replaces the search text only
when the detail text is strictly longer. An unresolved boundary is returned as
`status=partial` with `xiaohongshu_detail_incomplete` or
`xiaohongshu_detail_unavailable`; it is not silently promoted to a complete
stored body. This automatic quality step is part of `search_posts` and does not
grant callers the independently authorized note-detail route.

The server rejects or ignores internal-only fields including `businessId`, `provider`, `endpointId`, `availabilityMode`, `includeRaw`, and arbitrary provider params.

Successful responses preserve the stable Night-All data-search envelope and add:

- `x-request-id`: transport correlation ID;
- `x-mx-insight-request-id`: durable Hub request ID;
- `idempotent-replay: true|false`;
- for direct Xiaohongshu delivery, `x-mx-insight-source-mode`,
  `x-mx-insight-captured-at`, `Age`, and `Warning: 110` when a stored fallback
  is returned.

Direct Xiaohongshu errors add `403 test_key_not_supported`,
`400 invalid_page_size|cursor_scope_mismatch`,
`409 external_platform_response_unusable`,
`429 external_platform_busy|external_platform_rate_limited|external_platform_capacity_exceeded|external_platform_cost_budget_exhausted|external_platform_subsidy_budget_exhausted`,
`502 external_platform_response_unusable|external_platform_outcome_unknown|external_platform_rejected`,
and `503 external_platform_unavailable|external_platform_not_configured|external_platform_contract_unverified|external_platform_circuit_open|external_platform_capacity_unavailable|external_platform_cost_control_unavailable|external_platform_cost_evidence_incomplete|external_platform_operation_disabled|external_platform_operation_shadow|external_platform_operation_paused|external_platform_operation_canary|external_platform_operation_blocked`.

When this route uses the historical path, `mxnc1` is authenticated-encrypted and
bound to the consumer, operation (`data-search`), platform, stable query scope
and next page. Each next-page request is a distinct business request and must
use a new `Idempotency-Key`; only a byte-for-byte transport retry of that page
reuses its key. Page 15 returns `hasMore=false`, `nextCursor=null` and
`cursorType=none`. A pre-wrapper bare Night-All/provider cursor returns
`400 invalid_cursor` and must be abandoned; restart from page 1 without a cursor
and with a new key. This rule does not reinterpret an `mxec2` direct cursor,
which remains on the direct Xiaohongshu connector.

## Night-All legacy compatibility facade

These transitional routes preserve the three existing request aliases and
standard raw response envelope behind the Hub trust boundary. Hub selects the
implementation; the caller never selects a provider:

| Hub route | Historical operation | Required selector | Xiaohongshu operation grant | Historical complete snapshot window |
| --- | --- | --- | --- | ---: |
| `POST /api/v1/night-all/search/raw` | `/api/v1/search/raw` | `keyword`, `query`, `keywords` or `queries` | `social.posts.search` | 15 minutes |
| `POST /api/v1/night-all/search/crawl` | `/api/v1/search/crawl` | a user/channel identifier | `social.users.posts` | 1 hour |
| `POST /api/v1/night-all/search/user-info` | `/api/v1/search/user-info` | a user identifier | `social.users.resolve` | 1 hour |

The three historical operation spellings in the second column are also active
Hub route aliases. Each alias and its `/night-all/search/*` spelling enter the
same service and paid-operation fingerprint; changing only the route cannot
authorize or purchase a second upstream dispatch.

All three require `Authorization: Bearer <mx key>` (or `x-api-key`), an
`Idempotency-Key` of 8–128 safe characters, one explicit platform, and that
platform's consumer grant. When the platform is `xiaohongshu`, the key's
immutable scope and the consumer must also include the operation grant in the
table. The same mapping applies before either Hub-native direct execution or
historical compatibility dispatch and to both route spellings. `all` and `*`
are invalid. For example:

```http
POST /api/v1/night-all/search/raw
Authorization: Bearer <mx key>
Idempotency-Key: legacy-search-0001
Content-Type: application/json

{
  "platform": "xiaohongshu",
  "query": "AI Agent",
  "count": 20
}
```

The Hub derives Night-All `businessId` from the authenticated consumer. Omitting
it is preferred; a legacy client may send `businessId` or `business_id` only when
the value exactly matches that consumer. It is never an authentication input.
The private-hop service token and provider routing remain server-owned.
An administrator can bind a unique legacy `businessId` (maximum 128 characters)
when creating the Hub consumer; otherwise Hub generates one and the migrating
client must omit its former value. This initial binding has no public update API.

The body has an operation-specific allowlist. `raw` accepts the documented
keyword/query aliases and detail/comment flags; `crawl` accepts documented
user/channel aliases, activity types and `cacheMaxAgeHours`; `user-info` accepts
documented user aliases. Common pagination aliases are retained. `params` may
carry allowlisted non-continuation platform values, and a composite next page
uses only the Hub-emitted `params.cursor=mxnc1...`; raw provider continuation
values are rejected. Provider, credential, endpoint,
capability/moduleCode, business identity, availability, billing, token/auth,
timeout, debug and similar controls are rejected recursively. Legacy
`includeRaw:false` is accepted and removed before dispatch; `includeRaw:true` is
rejected. `params` also cannot override count/page size, concurrency, enrichment
or comment work.
Archive/fullArchive/allTweets, archiveLimit/totalCount, max*Pages,
pageCount/chunkSize/budget/crawlDepth and equivalent cost-amplification controls
also require a separate granted capability/policy and are rejected. Unknown
top-level fields are rejected.
The effective page size must not exceed the consumer's platform policy; the
upstream reference contract additionally caps `crawl` and `user-info` at 100.
Every compatibility operation rejects a numeric `page` greater than 15.
Raw query count × page size and crawl identity count × page size × activity-type
count must also fit the policy work budget or the Hub returns
`400 work_budget_exceeded`. This bounds processed item work, not the exact number
of provider calls or their procurement cost.

Historical Night-All cursor, composite, page and offset pagination is exposed
only through an authenticated-encrypted Hub cursor beginning `mxnc1.`. Its state
binds the authenticated consumer, operation, platform, stable query/account
scope and next page. Provider cursor/`nextParams` material is encrypted inside
that value. Cursor/page responses expose it in `nextCursor` and use public
`paginationMode=cursor`; composite/offset responses expose only
`nextParams.cursor` and use public `paginationMode=composite`. The caller returns
the Hub cursor unchanged in the route's normal `cursor` field, or returns the
emitted `nextParams.cursor` inside `params` for a composite response. Each next
page requires a new `Idempotency-Key`, while an
exact transport retry of the same page reuses that page's key. Page 15 clears all
continuation controls (`nextCursor`, `providerCursor`, `nextParams`, `nextPage`)
and reports `hasMore=false`; `page_limit_reached` is added when the upstream had
advertised more work.

Bare provider cursors and raw provider continuation values inside `params` that
predate this wrapper are deliberately rejected with `400 invalid_cursor`: their
page count cannot be authenticated, so accepting them could bypass the 15-page
limit. Such a client must remove both cursor and continuation params, use a new
`Idempotency-Key`, and restart at page 1. A cursor cannot cross consumers,
operations, platforms or stable query/account scope.

A Xiaohongshu `raw` first-page request uses the Hub-native direct connector only
after an independent rollout gate and when all of the following are true: it
has exactly one scalar `keyword` or `query`; its
effective `count`/`pageSize`/`limit` is exactly 20; it is page one or carries an
opaque cursor issued by the same direct traversal; and it omits plural queries,
`params`, cache-age, request-specific concurrency, comment workload, and comment
continuation controls. Explicit `includeDetails:false` and
`includeComments:false` are accepted as no-op compatibility defaults.
`disableAutoDetails:true` is also accepted and only turns off the automatic
60-character preview-boundary detail lookup. `includeDetails:true` selects full
detail enrichment and `maxEnrichItems=1..20` bounds that existing atomic,
cost-governed Hub-native workflow; `includeDetails` takes precedence over
`disableAutoDetails`. A true comment flag, `commentLimit`, `commentCursor`, `enrichConcurrency`, a
non-20 page or a historical cursor remains on the historical compatibility
path for `raw`. Existing clients keep the same route and body; the switch is
transparent. A previously issued direct cursor remains on the direct connector
even while new first-page cutover is gated.

A separately gated Xiaohongshu user-activity slice is also Hub-native. `crawl`
must resolve to exactly one user identity, page size 20, posts-only activity and
concurrency 1; page 1 has no cursor and subsequent pages accept only the
Hub-issued direct `mxec2` cursor (including its sole `params.cursor` legacy
spelling). `user-info` must resolve to exactly one username, 24-hex user ID or
official profile URL on page 1 and accepts no continuation, custom params or
concurrency control. New first pages use this slice only when the parent
external-platform contract gate and the independent user-activity gate are active. Historical
`mxnc1` cursors, batches/multiple identities, channel forms, non-post activity,
non-20 crawl pages, custom cache/params controls and every unsupported shape
remain on Night-All. An existing direct crawl cursor remains pinned to the
Hub-native connector when the first-page gate is later closed.

On this Hub-native slice, a non-official Xiaohongshu profile URL returns `400
invalid_user_profile_url`, a page conflicting with its direct crawl cursor
returns `400 cursor_page_mismatch`, and a user that cannot be resolved returns
`404 user_not_found`.

Direct routing does not remove Xiaohongshu from `data.legacySearch`. For a key
granted both Xiaohongshu and Twitter, every `raw`, `crawl`, and `user-info`
matrix entry still includes both platforms in `supportedPlatforms` and
`readyPlatforms`; the matrix governs historical/unmigrated Xiaohongshu request
shapes, not the independently gated native raw, crawl or user-info slices. Its
presence is not proof that either native rollout gate is active or ready.

The response body preserves the Night-All legacy envelope:

```json
{
  "data": {
    "raw_info": "[]",
    "raw_data": "[]",
    "page": {
      "page": 1,
      "pageSize": 20,
      "returnedCount": 0,
      "hasMore": false,
      "nextCursor": null
    },
    "meta": { "resultCount": 0 }
  },
  "requestId": "00000000-0000-4000-8000-000000000001"
}
```

`raw_info` and `raw_data` intentionally remain JSON strings for both execution
paths. A Hub-native Xiaohongshu projection puts the durable Hub UUID in the body
`requestId`; it is identical to `x-mx-insight-request-id`, while external
correlation stays private. For a Night-All-owned live response or exact fallback,
the historical application business body remains unchanged, including its
existing `requestId`/`traceId` and unmasked provider/endpoint business fields;
only pagination controls use the `mxnc1` projection described above. The current
durable Hub request ID remains separate in the response header. This is separate
from the request-side rule above, which still rejects caller injection of
provider/token/credential controls.

For a historical Night-All delivery, the pagination controls described above
are the only response fields Hub rewrites. Hub does not desensitize, filter,
truncate or otherwise change business content, including long note text,
`raw_info`, `raw_data`, provider/endpoint business fields or upstream correlation
values. The compatibility snapshot stores the governed body delivered to the
client. The historical Night-All hop retains the complete parsed JSON payload
and legacy raw strings, including the original provider continuation, but does
not claim byte-for-byte HTTP response capture. Hub-native provider calls
separately retain exact upstream response text/bytes plus hash in restricted raw
storage.

- `x-mx-insight-request-id: <hub request UUID>`;
- `idempotent-replay: true|false`;
- `x-mx-insight-source-mode: live|stale`;
- `x-mx-insight-captured-at: <RFC3339 capture time>`;
- `Age`: capture age when available;
- `Warning: 110 - "Response is stale"` for `stale` delivery.

The legacy transport keeps this two-value vocabulary: Hub-native cache and
replay states project to `live`; a stored fallback, or a replay whose origin was
stale, projects to `stale`. `idempotent-replay` and `Age` retain the additional
delivery evidence without expanding `x-mx-insight-source-mode`.

Every actual dispatch records separate Hub call evidence, including operation,
consumer, exact fingerprint, platform, latency, HTTP/business outcome and bounded
failure kind; the historical path also retains Night-All correlation IDs privately.
Night-All HTTP 200 with a substantive
warning or per-result error/`success=false` is a `partial` live success: it is
returned but never creates or replaces a compatibility snapshot. A lone
`STANDARD_PAYLOAD_EMPTY` warning is a deterministic complete empty result and does
replace last-good, preventing an older non-empty snapshot from resurfacing. Only
`complete` responses write last-good.

Each new `Idempotency-Key` may dispatch once; any committed compatibility
delivery is permanently replayed by that key, and a deliberately new live call
needs a new `Idempotency-Key`. On the historical path, after network/timeout
ambiguity, an unusable HTTP 2xx
content-type/JSON/envelope, or a definite upstream `502`, `503` or `504`, Hub may
return HTTP 200 from an unexpired complete snapshot for the exact consumer,
operation and full normalized request fingerprint. The snapshot retains the same
original Night-All application fields as the live response. Hub never uses a
similar query, another cursor/page, another consumer, a partial response,
canonical search records or a separately desensitized projection. The
body—including its Night-All request/trace IDs—is the historical snapshot; the
headers identify the current Hub request and capture age. The failed live attempt
remains separate evidence.

Without that exact snapshot:

| Upstream result | Public result |
| --- | --- |
| bare provider cursor/continuation params, tampered `mxnc1`, or scope mismatch | `400 invalid_cursor`; remove continuation, use a new key and restart page 1 |
| definite `400`, `404`, `409`, `422`, `429` | same HTTP status, safe `night_all_rejected` error |
| other definite non-2xx HTTP rejection | `502 night_all_rejected` |
| network error, Hub timeout, or unusable HTTP 2xx contract after dispatch | `502 upstream_outcome_unknown`; request becomes `unknown` |

For an eligible Hub-native Xiaohongshu raw request, the corresponding safe
errors use the `external_platform_*` codes documented for `/data/search`,
including `external_platform_rate_limited`; they are not relabeled as
`night_all_rejected`.

The five database operation-control rejections retain their exact 503 codes on
Hub-native raw, crawl and user-info paths: `external_platform_operation_disabled`
means explicitly disabled, `external_platform_operation_shadow` means
validation-only, `external_platform_operation_paused` means incident-paused,
`external_platform_operation_canary` means the consumer is outside the recorded
canary allowlist, and `external_platform_operation_blocked` means a release,
contract, credential or reviewed-cost prerequisite is not ready.

An ambiguous request must not be automatically retried with a new `Idempotency-Key`. A
dispatched compatibility error includes the durable Hub ID as
`error.details.requestId`; successful live/stale delivery carries it in
`x-mx-insight-request-id`. Use that ID with
`GET /api/v1/requests/{hub-request-id}`. A replay with the same `Idempotency-Key` reports the
held unknown outcome. Hub does not emit `504` for its own timeout because it cannot
prove that a dispatched upstream did no work or incur no procurement cost.

This facade is distinct from `/api/v1/data/search` and from canonical stored
search. Its complete/partial live payloads also enter the governed
`night-all.compat.v1` ingest dataset asynchronously in their original,
non-desensitized form, but ingest/search state never changes the already-delivered
legacy response. Business fields remain unmasked in response and snapshot;
historical raw lineage retains the complete parsed payload and legacy raw strings
before the sole pagination-control rewrite. Exact upstream response text/bytes
plus hash is an additional restricted-archive guarantee for Hub-native provider
calls, not for the historical Night-All HTTP hop. See
[ADR-0010](../adr/0010-night-all-compatibility-facade.md).

Future Hub desensitization must be a separate versioned processing/projection and
API contract. It cannot mutate or replace this compatibility response/snapshot.
This response-preservation rule applies only to the three namespaced routes and
does not change the `/api/v1/data/search` contract documented above.

## Hub canonical stored search

```http
POST /api/v1/data/stored/search
Idempotency-Key: <caller-generated stable key>
Content-Type: application/json

{
  "platform": "xiaohongshu",
  "query": "AI Agent",
  "datasetId": "night-all.search.v1",
  "objectType": "post",
  "pageSize": 20,
  "cursor": "opaque-if-present"
}
```

This route searches only Hub canonical data and never calls Night-All or another
provider. `platform` and `query` are required. `datasetId` and `objectType` are
optional exact logical filters. The strict body allowlist rejects physical
database/index names, SQL, Elasticsearch DSL/scripts and arbitrary parameters.
The response uses `contractVersion=mx-insight-hub.stored-search.v1` and reports
`source=hub` both for the response and each returned item. Connector lineage,
raw payloads, extensions and provider coordinates are not returned.

The common response shape retains `externalId`. For `public_opinion`, this
field deliberately repeats the Hub canonical `id`; it never exposes the
upstream `monitor_strategy_results.id` or another source-row coordinate.

Authorization is currently **platform-grant only**. `datasetId` narrows results;
it is not a separate authorization grant. A consumer granted a platform can
search the complete Hub canonical corpus for that platform. Dataset-level or
tenant-row grants are not implemented and must not be inferred from this filter.

Elasticsearch is the preferred ranked projection. A transport failure on the
first page uses the existing PostgreSQL substring fallback and reports
`searchMode=postgres` plus `search_projection_degraded`. A reachable cluster
that rejects the request is an error rather than a silent fallback. Pagination
uses an HMAC-signed opaque cursor bound to query, platform, datasetId, objectType
and page size; a later page requires a new idempotency key. Grant, policy, quota,
idempotency replay and usage evidence use the same per-platform ledger as
`POST /api/v1/data/search`.

For every `data_center_saved_records_*` platform, both the Elasticsearch and
PostgreSQL paths return only records whose governed crawler publication
eligibility is exactly `candidate`; internal, missing or malformed eligibility
never passes. Elasticsearch `content-v6` is preferred. A first-page request on
an older projection or after an Elasticsearch transport failure falls back to
PostgreSQL with the same visibility predicate. A crawler cursor signed before
the visibility contract has an obsolete HMAC binding and returns `400
invalid_cursor`; restart without a cursor and use a new `Idempotency-Key`. A
current-contract Elasticsearch cursor never changes backend; if its
`content-v6` projection is unavailable, Hub returns `503
search_cursor_unavailable` and callers retry the same cursor later. The crawler
visibility contract is bound to both the signed cursor and idempotency
fingerprint, so a contract upgrade requires a new `Idempotency-Key`.

## Unified canonical search

```http
POST /api/v1/data/canonical/search
Idempotency-Key: <caller-generated stable key>
Content-Type: application/json

{
  "query": "AI Agent",
  "platform": "telegram",
  "objectType": "message",
  "searchProfile": "canonical.balanced.v1",
  "pageSize": 20,
  "cursor": "opaque-if-present"
}
```

Only `query` is required. Omitting `platform` searches every platform currently
granted to the consumer; specifying it narrows the search and still requires
that grant. `datasetId` and `objectType` are optional exact logical filters.
The server always applies the authorized platform set in addition to those
filters, so a dataset identifier can never expand access.

`searchProfile` selects an immutable, server-owned query policy. It is not an
Elasticsearch analyzer name and the API never accepts arbitrary analyzer,
tokenizer, filter, index or DSL controls:

| Profile | Indexed representation and query rule |
| --- | --- |
| `canonical.balanced.v1` (default) | Raw text phrase **or**, when HanLP is healthy, all HanLP query terms matched with AND against the pre-segmented `*Hanlp` representation. If query segmentation degrades to Jieba/bigram, the server applies `canonical.phrase.v1` instead of comparing incompatible terms with HanLP postings. CJK bigram does not replace HanLP here. |
| `canonical.phrase.v1` | Ordered raw-text phrase only; highest precision. |
| `canonical.terms-all.v1` | Every pre-segmented query term must match; word order may differ. |
| `canonical.zh-recall.v1` | Balanced plus a lower-weight ordered CJK-bigram branch, providing segmentation-independent recall without returning to single-character OR. |
| `canonical.title-prefix.v1` | Bounded prefix lookup over titles, author names, handles, usernames and chat names. |

The current HanLP service loads one coarse model. A future “fine at index time,
coarse at search time” policy requires separately versioned segmenter models and
indexed fields; passing a request parameter cannot manufacture fine-grained
terms that were never indexed.

The route runs one query over the shared canonical current-state projection. It
does not call each source API and then concatenate per-source top-N lists. This
gives all matching datasets one BM25 scoring context, one deterministic
`_score/eventTime/id/_shard_doc` ordering and one PIT/search-after cursor. Source identity
is not an implicit relevance boost. Records intentionally preserved in separate
datasets remain separate results even if they share an external ID; the search
layer does not guess a cross-dataset survivor rule.
In a mixed-platform search, only each `data_center_saved_records_*` branch is
restricted to exact `candidate` eligibility; other platform branches keep their
own visibility contract. The same `content-v6`/PostgreSQL first-page fallback,
pre-visibility `400 invalid_cursor` restart, and current-contract Elasticsearch
cursor `503 search_cursor_unavailable` behavior described for stored search
applies here. The resolved crawler visibility contract is part of the cursor
and idempotency fingerprint.
If Elasticsearch is unavailable on the first page, the same authorized filters
are applied to the PostgreSQL canonical table and the response reports
`search_projection_degraded`, `search_profile_degraded`, and
`search.appliedProfile=postgres.substring.v1`.

Responses use `contractVersion=mx-insight-hub.canonical-search.v1` and the same
customer-safe item projection as stored search. `scope.platforms` records the
actual sorted authorization scope. `pageInfo` includes `totalCount`,
`totalRelation`, `totalPages`, and the stable opaque cursor. The `search` object
reports requested/applied profiles and degradation. A cursor is signed over the
query, filters, page size, resolved profile, platform scope and bounded first-page
analysis state. Later pages reuse the same applied profile and tokens rather than
calling HanLP again; if grants or the profile change, restart from the first page.
The operation is metered under the
`data.canonical-search` usage scope. That bucket is independent of the legacy
single-platform search bucket and always uses the strictest request/page limit
and longest window across the consumer's complete current platform-grant set,
even when this request narrows `platform`. This keeps one stable policy on one
shared bucket instead of re-evaluating the same history against different
limits.

## Public-opinion data

The province feed and item-detail routes serve the Hub-owned canonical scope
`platform=public_opinion`, `datasetId=public-opinion.province.v1`, and
`objectType=opinion_item`. They never query the source database directly and
require the API key's consumer to have the explicit `public_opinion` platform
grant.

```http
GET /api/v1/data/public-opinion/provinces/CN-JS/items?sort=hot&pageSize=20
GET /api/v1/data/public-opinion/provinces/CN-JS/items?includeCandidates=qualified&minQualityScore=80&from=2026-08-24T00:00:00Z&to=2026-08-24T23:59:59Z
GET /api/v1/data/public-opinion/province-coverage?from=2026-08-24T00:00:00Z&to=2026-08-24T23:59:59Z&includeCandidates=qualified&targetPerProvince=10
GET /api/v1/data/public-opinion/items/11111111-1111-4111-8111-111111111111
Authorization: Bearer <mx key>
```

The P1 region APIs are additive. They do not change the paths, defaults,
responses, authorization rules or cursor binding of any existing province,
coverage, detail, stored-search or canonical-search API.

### P1 province region catalog

```http
GET /api/v1/data/public-opinion/regions?parentCode=CN&level=province
Authorization: Bearer <mx key>
```

The region catalog requires the `public_opinion` platform grant. P1 accepts
only `parentCode=CN` and `level=province`; omitted fields default to those exact
values, while other values or additional fields are rejected. It returns the
stable 34-entry province-level taxonomy in catalog order, including every
region even when the current corpus has no matching item. The returned region
`code` is the value to pass to the P1 region feed. P1 does not expose a city
catalog, infer city codes, or accept a city as a region selector; city support
is a separate P2 contract.

```json
{
  "data": {
    "contractVersion": "mx-insight-hub.public-opinion.regions.v1",
    "parentCode": "CN",
    "level": "province",
    "regions": [
      {
        "code": "CN-BJ",
        "name": "北京",
        "officialName": "北京市",
        "level": "province",
        "parentCode": "CN"
      },
      {
        "code": "CN-JS",
        "name": "江苏",
        "officialName": "江苏省",
        "level": "province",
        "parentCode": "CN"
      }
    ]
  },
  "requestId": "00000000-0000-4000-8000-000000000006"
}
```

### P1 nationwide and province all-ingested feed

```http
GET /api/v1/data/public-opinion/regions/CN/items?visibility=all_ingested&sort=latest&from=2026-08-24T00:00:00Z&to=2026-08-26T23:59:59Z&pageSize=50
GET /api/v1/data/public-opinion/regions/CN-JS/items?visibility=all_ingested&sort=latest&from=2026-08-24T00:00:00Z&to=2026-08-26T23:59:59Z&pageSize=50
Authorization: Bearer <mx key>
```

The region feed requires both the `public_opinion` platform grant and the
separate `public_opinion.all_ingested.read` capability. P1 accepts `CN` for the
nationwide scope or one of the 34 exact ISO 3166-2:CN codes returned by the
catalog. It does not accept Chinese aliases or city codes.

Capability discovery reports this step-up capability as `ready=true` only when
the dedicated global-latest and revision-fenced display-province serving index
contracts are both valid. Missing or drifted region indexes fail the feed closed
with `503 serving_indexes_unavailable`; the legacy province feed keeps its own
existing hot/latest index gate.

P1 is deliberately one narrow enumeration contract:

| Parameter | P1 contract |
| --- | --- |
| `visibility` | Required and must be exactly `all_ingested`. No quality score, qualification status or geography-verification predicate is applied. |
| `sort` | Optional, defaults to `latest`, and no other value is accepted. P1 does not expose `hot`, so a null heat score cannot remove an otherwise visible record. |
| `from` | Required inclusive RFC3339 effective-sort-time lower bound. |
| `to` | Required inclusive RFC3339 effective-sort-time upper bound; it must not precede `from`. |
| `pageSize` | Optional positive integer, default 20. The effective maximum is the lower of 100 and the consumer's `public_opinion.maxPageSize` policy. |
| `cursor` | Optional signed opaque keyset cursor, at most 8,192 characters. Return `pageInfo.nextCursor` unchanged with every other parameter unchanged. |

Effective sort time is `publishedAt` when available and otherwise
`collectedAt`; the fallback is used for filtering and ordering but is never
rewritten into `publishedAt`. The total order is effective sort time,
`collectedAt`, then canonical `id`, all descending. The cursor is bound to the
normalized region code, fixed visibility and sort, time bounds and page size.
Pagination reads the current projection and is not a frozen multi-page
snapshot. Each request and retry is independently metered and does not take an
`Idempotency-Key`.

`all_ingested` has the bounded public meaning `canonical_current_safe`. It
includes current formal and candidate records in the fixed public-opinion
canonical scope even when a candidate is unscored, pending, rejected or failed.
The nationwide `CN` scope also includes records whose current safe projection
has no assigned province; those items keep `province=null`. A province scope
returns only records assigned to that exact province.

`canonical_current_safe` excludes upstream raw rows, raw payloads, source and
canonical revision history, deleted/tombstoned records, mapping/import failures,
and records without a revision-fenced current publication-state row. It also
continues to omit provider/endpoint identities, credentials, strategy/run IDs,
extensions, quality flags and rejection reasons, model reasoning and internal
lineage. Ignoring publication quality is not permission to bypass the public
field allowlist or expose raw evidence.

```json
{
  "data": {
    "contractVersion": "mx-insight-hub.public-opinion.region-feed.v1",
    "region": {
      "code": "CN",
      "name": "中国",
      "officialName": "中华人民共和国",
      "level": "country",
      "parentCode": null
    },
    "visibility": {
      "mode": "all_ingested",
      "qualityFiltered": false,
      "corpusDefinition": "canonical_current_safe"
    },
    "sort": "latest",
    "timeBasis": "effective",
    "from": "2026-08-23T16:00:00.000Z",
    "to": "2026-08-26T15:59:59.000Z",
    "items": [{
      "id": "11111111-1111-4111-8111-111111111111",
      "title": "全国舆情样例",
      "summary": "公开摘要",
      "url": "https://example.com/items/11111111",
      "publishedAt": null,
      "collectedAt": "2026-08-25T03:01:00.000Z",
      "province": null,
      "heatScore": null,
      "origin": { "name": null, "type": null, "platform": null },
      "quality": {
        "stage": "candidate",
        "status": "rejected",
        "score": null,
        "threshold": 80,
        "geographyVerified": false
      }
    }],
    "pageInfo": {
      "returnedCount": 1,
      "hasMore": false,
      "nextCursor": null
    }
  },
  "requestId": "00000000-0000-4000-8000-000000000007"
}
```

Candidate origin members remain null. Quality and bounded location metadata may
be returned to describe the record, but neither participates in P1 selection.
There is no `minQualityScore` parameter on this endpoint. Item detail remains on
the existing route and retains its existing candidate visibility contract.

### Existing province feed

The province path accepts an ISO 3166-2:CN code, a short Chinese name, or the
official Chinese name, for example `CN-JS`, `江苏`, or `江苏省`. Chinese path
values must be URL-encoded. Unknown names are rejected; unclassified records are
not silently assigned to a province.

The province feed accepts only these query parameters:

| Parameter | Contract |
| --- | --- |
| `sort` | `hot` (default) or `latest`. `hot` excludes null heat scores and orders by `(heatScore, effectiveSortTime, id)` descending. `latest` orders by `(effectiveSortTime, collectedAt, id)` descending. `effectiveSortTime` is `publishedAt` when present, otherwise `collectedAt`; the fallback is never returned as `publishedAt`. |
| `from` | Optional inclusive RFC3339 `publishedAt` lower bound. A bounded request excludes records whose `publishedAt` is null. |
| `to` | Optional inclusive RFC3339 `publishedAt` upper bound; it must not precede `from`. |
| `includeCandidates` | Omitted/`false` preserves the historical formal-only response. `qualified` includes only candidates already in `status=qualified` and above the effective quality floor. `all` includes pending/rejected/failed candidates too and requires both `from` and `to`. Boolean `true` is a compatibility alias for `qualified`. |
| `minQualityScore` | Integer 0–100, valid only with candidate mode. It is an additional request floor, not a reclassification control or an override of the record qualification threshold. It defaults to 80 for `qualified`; `all` has no implicit score floor, and the field must be omitted to retain null/unscored candidates. |
| `pageSize` | Positive integer, default 20. The effective maximum is the lower of 100 and the consumer's `public_opinion.maxPageSize` policy. |
| `cursor` | Optional HMAC-signed opaque cursor, at most 8,192 characters. Return `pageInfo.nextCursor` unchanged. |

The cursor is bound to the normalized province code, sort order, time bounds,
page size and, when explicitly enabled, candidate visibility and quality floor.
Changing any of those values requires restarting without a cursor. The legacy
formal-only binding stays byte-compatible. Pagination is keyset-based over the current canonical projection; it is
not a frozen multi-page snapshot. Each safe `GET`, including a retry or next
page, is independently charged to the consumer's `public_opinion` request and
usage policy. These routes do not take an `Idempotency-Key`.

The list response uses `contractVersion=mx-insight-hub.public-opinion.v1`:

```json
{
  "data": {
    "contractVersion": "mx-insight-hub.public-opinion.v1",
    "province": { "code": "CN-JS", "name": "江苏" },
    "sort": "hot",
    "items": [{
      "id": "11111111-1111-4111-8111-111111111111",
      "title": "江苏舆情样例",
      "summary": "公开摘要",
      "url": "https://example.com/items/11111111",
      "publishedAt": "2026-08-23T03:00:00.000Z",
      "collectedAt": "2026-08-23T03:01:00.000Z",
      "province": { "code": "CN-JS", "name": "江苏" },
      "heatScore": 88.5,
      "origin": {
        "name": "江苏新闻广播",
        "type": "social",
        "platform": "douyin"
      }
    }],
    "pageInfo": { "returnedCount": 1, "hasMore": false, "nextCursor": null }
  },
  "requestId": "00000000-0000-4000-8000-000000000005"
}
```

Every item is a strict public allowlist containing exactly `id`, `title`,
`summary`, `url`, `publishedAt`, `collectedAt`, `province`, `heatScore`, and
`origin={name,type,platform}`. Nullable values remain explicit. `origin.platform`
is a reviewed originating content platform and is distinct from the
`public_opinion` authorization platform. `heatScore` drives only the province
hot order; it is not a relevance score comparable across arbitrary sources.
Raw payloads, target/negative keywords, strategy/run identifiers, source table
coordinates, heat metrics, extensions, LLM label/confidence/reasoning, and
lineage are not public fields.

When and only when candidate visibility is requested, items additionally expose
bounded `quality={stage,status,score,threshold,geographyVerified}` and optional
`location={label,type,country,countryCode,geoScope}`. Candidate `origin` members
are all `null`: a transport engine, provider ID, private endpoint or credential
name is never a public source identity. Quality score is Hub-owned publication
quality, not the Night-All heat score and not province confidence. `formal`
records keep the historical response and serving semantics. A formal record's
display province can only come from a non-empty, accepted event-geography
assertion; proposed event or publisher geography cannot enter the formal province
feed. Explicit candidate reads may display proposed event/publisher geography for
exploration, but `geographyVerified=true` still requires accepted event geography
and never trusts the `quality.geography_verified` proposal by itself.

For formal rows, `from/to` continue to filter real `publishedAt`; an undated
formal row remains excluded from a bounded request. Candidate rows instead use
`publishedAt` when present and otherwise their Hub `collectedAt` as a serving
window so an explicitly requested undated candidate remains reachable. The
fallback is not rewritten into `publishedAt`.

The item-detail route accepts only a Hub canonical UUID returned by the feed or
canonical search. Its lookup remains fixed to the public-opinion dataset and
object type. It is formal-only by default; the same `includeCandidates` and
`minQualityScore` controls can explicitly authorize a candidate detail without
a time-window requirement. A deleted, missing, hidden or out-of-scope record returns
`404 item_not_found`. A legacy unclassified detail may have `province=null`, but
the province feed itself returns only the requested normalized province.

### Province coverage

`GET /api/v1/data/public-opinion/province-coverage` requires RFC3339 `from` and
`to`, accepts the same candidate controls, and accepts `targetPerProvince=1..100`
(default 10). It always returns all 34 supported province-level regions in stable
catalog order with `formalCount`, `qualifiedCandidateCount`, `candidateCount`,
qualification/verified rates, `availableCount`, `shortfall`, `meetsTarget` and
average quality. `featuredProvinceCodes` ranks at most eight regions for the UI;
the client can pin those cards and collapse the rest without issuing 34 separate
queries. The target is an observability goal, never a promise or a reason to
fabricate records. A province with five verified items returns `shortfall=5`.

`geographyVerified` and the verified count require accepted event geography.
Publisher/dateline fallbacks may provide a display location for candidate
exploration but do not satisfy verified province coverage. Overseas events keep
country/location/geo scope and do not enter a China province bucket.

### Funnel and unshown-record diagnostics

```http
GET /api/v1/data/public-opinion/funnel?from=2026-08-24T00:00:00Z&to=2026-08-25T23:59:59Z
GET /api/v1/data/public-opinion/records?reason=missing_province&from=2026-08-24T00:00:00Z&to=2026-08-25T23:59:59Z&pageSize=50
GET /api/v1/data/public-opinion/records/{id}?from=2026-08-24T00:00:00Z&to=2026-08-25T23:59:59Z
Authorization: Bearer <mx key>
```

These diagnostic resources require both the `public_opinion` platform grant
and the independent `public_opinion.diagnostics.read` capability. The step-up
capability has its own request window; record pagination is also bounded by the
platform's `maxPageSize`. Every GET/retry is independently metered and does not
use an idempotency key. A missing platform grant returns
`403 platform_not_granted`; a missing step-up grant returns
`403 capability_not_granted`.

The funnel reports the explainable inclusion stages from active-current records
through publication state, formal stage/status, event time, selected time
window, province assignment, and heat score. Its contract version is
`mx-insight-hub.data-products.public-opinion-funnel.v1`.

The records route accepts only `cursor`, `from`, `heat`, `pageSize`, `province`,
`query`, `reason`, `scope`, `stage`, `status`, `time`, and `to`. Reasons include
`missing_province`, `missing_publication_state`, `not_formal_stage`,
`not_formal_status`, `missing_event_time`, `outside_window`, and `missing_heat`,
plus the published visibility views in the machine contract. The list uses a
signed opaque keyset cursor bound to the full normalized filter set. The list
and detail contract versions are respectively
`mx-insight-hub.data-products.public-opinion-records.v1` and
`mx-insight-hub.data-products.public-opinion-record.v1`.

Responses reuse the bounded public diagnostic projection. They never return
raw payloads, `extensions`, source connections/credentials, mutable internal
coordinates, model reasoning, or Admin operations. These APIs expose why a row
is absent from a product view; they do not publish the Admin Token funnel or
grant access to catalog/update controls.

For global search across different stored sources, use
`POST /api/v1/data/canonical/search`. Specify `platform=public_opinion`,
`datasetId=public-opinion.province.v1`, and `objectType=opinion_item` to narrow
the result, or omit `platform` to search every platform granted to the consumer.
Those filters only narrow the authorization scope. This addition does not add a
`public_opinion` branch to `POST /api/v1/data/search`; that live/upstream-
compatible route fails closed with `platform_operation_unsupported`.

Both stored and canonical search remain formal-only when the new fields are
omitted. Candidate search requires explicit `platform=public_opinion` and accepts
`includeCandidates=qualified|all`, `minQualityScore`, `province`, `countryCode`,
`location`, `from`, and `to`. `all` additionally requires both time bounds and at
least one exact geography selector (`province`, `countryCode`, or `location`).
These controls are signed into the query/cursor and idempotency contract. A
default public-opinion request also carries the new formal-visibility contract
marker so a stable pre-upgrade cached body cannot bypass the publication gate;
clients must use a new `Idempotency-Key` after this rollout. Searches spanning
other granted platforms apply the publication predicate only to
`public_opinion`; unrelated platforms are not filtered by quality state.

## Telegram stored data

### History

```http
GET /api/v1/data/telegram/chats?sourceScope=all&kind=channel&query=news&pageSize=50
GET /api/v1/data/telegram/messages?sourceScope=all&chatId=<chatKey>&pageSize=50&cursor=<opaque>
```

These two read-only resources are served from Hub-owned canonical datasets, not
from the physical Night-All tables on each request:

| Resource | Hub dataset | Object type |
| --- | --- | --- |
| `chats` | `telegram.monitor.chats.v1` | `chat` |
| `messages` | `telegram.monitor.messages.v1` | `message` |
| `chats` with `sourceScope=sqlite|all` | `telegram.sqlite.chats.v1` | `chat` |
| `messages` with `sourceScope=sqlite|all` | `telegram.sqlite.messages.v1` | `message` |

For backward compatibility, omitting `sourceScope` keeps the historical
monitor-only view. Callers explicitly select `all` to reconstruct the Hub Admin
Monitor + SQLite conversation surface, or `sqlite` to inspect only imported
records. SQLite data is never mixed into an omitted/default scope.

The routes are additive and are not renamed: existing Monitor callers keep the
same `/data/telegram/chats`, `/data/telegram/messages` and
`/data/telegram/search` paths. Omitting `sourceScope` (and, for chats,
`kind/query`) preserves the legacy Monitor response and unsigned v1 history
cursor. Explicit `sourceScope`, chat filters or a qualified
`monitor:<canonical UUID>` / `sqlite:<canonical UUID>` chatKey opts into an
HMAC-signed v2 history cursor bound to the resource, selected source, filters
and page size. `sourceScope=all` with a plain external chat ID is the explicit
two-source merge.

Use the unified endpoint when the caller wants Telegram data regardless of
ingestion source. Omitting `datasetId` is what combines monitor and SQLite
records:

```http
POST /api/v1/data/canonical/search
Idempotency-Key: <stable-key>
Content-Type: application/json

{
  "platform": "telegram",
  "objectType": "message",
  "query": "agent",
  "searchProfile": "canonical.balanced.v1",
  "pageSize": 20
}
```

Use `/api/v1/data/stored/search` with an exact `datasetId` when a caller
deliberately wants just one Telegram source dataset.

The API key's consumer must have the explicit `telegram` platform grant. A
tenant ID, source-table name, provider, connector, database field, endpoint ID
or raw-payload switch is never accepted from the caller. `GET
/api/v1/data/capabilities` advertises `monitor_chats` and
`monitor_messages` under `telegram` when that consumer is granted the platform
and the stored-data runtime is available. Additive discovery names are
`sqlite_chats`, `sqlite_messages`, `multi_source_conversations` and
`conversation_filter`.

The two canonical datasets currently have no `tenant_id` or per-tenant row
scope. Consequently, every consumer with the `telegram` grant reads the same
complete chats/messages corpus; tenant/consumer isolation here covers API-key
ownership, the grant decision, policy, request quota and usage evidence, not a
different row subset. Tenant-specific Telegram delivery is not implemented and
would require a separately versioned dataset or explicit row-scope contract.

The query allowlist is resource-specific:

| Field | Contract |
| --- | --- |
| `sourceScope` | Optional `monitor|sqlite|all`, default `monitor`. Supported by chats, messages and Telegram search. |
| `kind` | Chats only: `all|channel|group|unknown`, default `all`. |
| `query` | Chats only: bounded search across the safe title/username/identifier projection. |
| `chatId` | Messages only: optional non-blank stable chat key/normalized identifier, at most 256 characters. |
| `from` | Messages only: optional complete RFC3339/ISO date-time with `T`, seconds and `Z` or a numeric offset; `eventTime` is inclusive. Date-only and space-separated forms are rejected. |
| `to` | Messages only: same complete date-time form; `eventTime` is inclusive and may not precede `from`. |
| `pageSize` | Positive integer. Default is 50 or the consumer's lower policy limit; the effective maximum is the consumer's `telegram.maxPageSize`, never above the server default of 100. |
| `cursor` | Return `pageInfo.nextCursor` unchanged. Legacy Monitor-only cursors are at most 1,024 characters; additive signed source/filter cursors are at most 2,048. |

Unknown query fields are rejected with `unsupported_fields`. In particular,
there is no free-text `q`, arbitrary sort, SQL, offset, raw export or caller
selected dataset. When all additive filters are omitted, the legacy Monitor
ordering and cursor semantics remain unchanged. Explicit `sourceScope`, `kind`
or `query` enables the source-aware keyset contract, ordered by immutable
`effectiveSortTime` then the internal canonical ID. `effectiveSortTime` falls
back from business event time to `collectedAt` and then `firstSeenAt`; it does
not rewrite nullable `eventTime` or `collectedAt` response fields. Clients must
not decode or construct either cursor version.

The following uses synthetic values to illustrate the contract; it is not a
production row.

```json
{
  "data": {
    "items": [
      {
        "id": "-1001234567890:42",
        "canonicalId": "11111111-1111-4111-8111-111111111111",
        "sourceScope": "monitor",
        "externalId": "-1001234567890:42",
        "platform": "telegram",
        "objectType": "message",
        "contentType": "text",
        "title": null,
        "text": "normalized message text",
        "url": null,
        "author": {
          "id": "12345",
          "name": "Example",
          "username": "example_user"
        },
        "relations": {
          "chatId": "-1001234567890",
          "messageId": "42",
          "replyToMessageId": "41"
        },
        "attributes": { "isOutgoing": false },
        "metrics": { "views": 10 },
        "media": {},
        "entities": [],
        "links": [],
        "eventTime": "2026-08-09T08:00:00.000Z",
        "collectedAt": "2026-08-09T08:01:00.000Z",
        "editedAt": null,
        "lineage": {
          "datasetId": "telegram.monitor.messages.v1",
          "origin": "hub-direct"
        },
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
`relations`, `attributes`, `metrics`, `media` and `entities`; it never returns
`extensions`, raw source rows, DSNs, physical host/database/table/provider
identity, provider credentials, collector accounts, `businessId`, Night-All
endpoint IDs or availability policy. `lineage` is a Hub-owned logical
dataset/origin label, not a path back to the physical source. `links` is always
the empty array in this contract version: the source probe established only
that it is an array, not an allowlist-safe schema for each member. Link objects
remain internal until a field-level review explicitly versions their public
projection. Each validated read reserves one request against the consumer's
`telegram.maxRequests` window and commits
`max(1, returnedCount)` units to `/api/v1/usage`. The evidence retains counts
and latency but not a second copy of the response body. A failed local read is
released; an ambiguous usage commit remains `unknown` for reconciliation. The
client does not send an idempotency key for these safe `GET` requests, so a
retry is a new request and may consume another quota slot.

Mapped source tombstones remain in canonical/revision evidence but are excluded
from history, content search and entity search.

### Telegram canonical message context

Canonical search remains a compact ranked result set. It does not expand every
hit into 21 messages. A client that needs the chat window calls the separate safe
GET route with the canonical UUID from the search item:

```http
GET /api/v1/data/canonical/items/{id}/context?before=10&after=10
Authorization: Bearer <api-key>
```

`before` and `after` default to 10, accept `0..50` independently and do not use
the consumer's search page-size limit. The caller needs the `telegram` platform
grant. Every call/retry is independently metered; there is no idempotency key.
The Hub fails closed with `503 serving_indexes_unavailable` until both advertised
Telegram message-dataset serving indexes are valid. An unknown or future dataset
is not silently treated as an empty chat: it returns `409 context_not_supported`
until that dataset is explicitly added to the context capability registry.

The response is one ascending safe-item list. `items[anchorIndex].id` equals
`anchorId`. Neighbors are restricted to the anchor's exact `platform`,
`datasetId`, `objectType=message` and normalized chat ID, and use the declared
total order `(eventTime, canonicalId)`. This is a deterministic stored-message
order, not an assertion about reply chains, topics, media albums, numeric
Telegram ID adjacency or upstream collector sequence.

```json
{
  "data": {
    "contractVersion": "mx-insight-hub.canonical-context.v1",
    "source": "hub",
    "anchorId": "33333333-3333-4333-8333-333333333333",
    "anchorIndex": 0,
    "stream": {
      "platform": "telegram",
      "datasetId": "telegram.monitor.messages.v1",
      "objectType": "message",
      "type": "chat",
      "id": "-1001234567890"
    },
    "items": [{
      "id": "33333333-3333-4333-8333-333333333333",
      "datasetId": "telegram.monitor.messages.v1",
      "platform": "telegram",
      "objectType": "message",
      "text": "example message",
      "source": "hub"
    }],
    "storedWindow": {
      "beforeRequested": 10,
      "afterRequested": 10,
      "beforeReturned": 0,
      "afterReturned": 0,
      "returnedCount": 1,
      "hasMoreStoredBefore": false,
      "hasMoreStoredAfter": false
    },
    "ordering": {
      "fields": ["eventTime", "canonicalId"],
      "direction": "ascending",
      "quality": "deterministic"
    },
    "upstreamCompleteness": {
      "status": "unknown",
      "basis": null,
      "through": null
    },
    "warnings": [{
      "code": "upstream_completeness_unknown",
      "message": "No public upstream-capture completeness attestation is available for this dataset."
    }]
  },
  "requestId": "transport-correlation-id"
}
```

`storedWindow.hasMoreStoredBefore/After` means only that the current Hub
PostgreSQL projection contains another row beyond the returned window. It never
proves an upstream first/last message. `upstreamCompleteness` is deliberately
separate and changes only from persisted source-capture evidence. Current
`telegram.monitor.messages.v1` is `unknown`; current
`telegram.sqlite.messages.v1` is `bounded` with basis
`append_only_overlap`. Source active/idle state, a successful checkpoint, a
failed continuation cursor, or `hasMoreStored*=false` cannot upgrade either
status.

`GET /api/v1/data/capabilities` advertises `message_context` and a dataset-level
`context` object with readiness, limits, ordering and completeness. A future
source becomes compatible by adding an explicit dataset registry entry, a stable
conversation key, a declared total order, a matching bounded serving index and
contract tests. Platform name alone is insufficient. Context items reuse the
strict canonical public allowlist; raw rows, `extensions`, source coordinates,
credentials and internal lineage are never returned. The original canonical
search item retains its ranked-match/score semantics. The public allowlist does
not forward raw Elasticsearch highlight fragments; a UI may highlight the
original hit from the query text and use `anchorIndex` to mark that same message
inside the context list. Neighbor items remain an unhighlighted chronological
reading view.

### Telegram canonical bidirectional timeline

The formal external contract for “search, open one hit, then keep scrolling in
both directions” is additive and does not change the bounded context route:

```http
GET /api/v1/data/canonical/items/{id}/timeline?before=10&after=10
Authorization: Bearer <api-key>
```

The initial call omits `cursor`. `before` and `after` default independently to
10 and accept `0..50`; each side is also subject to the current `telegram`
grant's `maxPageSize`. It returns a single ascending `items` list and a numeric
`anchorIndex`; `items[anchorIndex].id` equals `anchorId`. It is restricted to the
anchor's exact registered dataset and normalized chat stream. Current support is
limited to `telegram.monitor.messages.v1` and
`telegram.sqlite.messages.v1`, the same two explicit dataset entries exposed by
`data.platforms[].timeline.datasets`.

A zero window suppresses that side only on the initial page. If Hub returns a
continuation cursor for that side, the cursor uses the default continuation
page size (`min(10, current grant maxPageSize)`), not a zero-sized page. This is
particularly useful for opening only the search hit and retaining the newer
cursor for polling.

```json
{
  "data": {
    "contractVersion": "mx-insight-hub.canonical-timeline.v1",
    "consistency": "live-keyset",
    "source": "hub",
    "anchorId": "33333333-3333-4333-8333-333333333333",
    "anchorIndex": 1,
    "stream": {
      "platform": "telegram",
      "datasetId": "telegram.monitor.messages.v1",
      "objectType": "message",
      "type": "chat",
      "id": "-1001234567890"
    },
    "items": [
      {
        "id": "22222222-2222-4222-8222-222222222222",
        "datasetId": "telegram.monitor.messages.v1",
        "platform": "telegram",
        "objectType": "message",
        "text": "previous message",
        "source": "hub"
      },
      {
        "id": "33333333-3333-4333-8333-333333333333",
        "datasetId": "telegram.monitor.messages.v1",
        "platform": "telegram",
        "objectType": "message",
        "text": "search hit",
        "source": "hub"
      }
    ],
    "pageInfo": {
      "mode": "initial",
      "direction": null,
      "returnedCount": 2,
      "older": { "hasMore": true, "cursor": "opaque-older-token" },
      "newer": { "hasMore": false, "cursor": "opaque-newer-token" }
    },
    "ordering": {
      "fields": ["eventTime", "canonicalId"],
      "direction": "ascending",
      "quality": "deterministic"
    },
    "upstreamCompleteness": {
      "status": "unknown",
      "basis": null,
      "through": null
    },
    "warnings": [{
      "code": "upstream_completeness_unknown",
      "message": "No public upstream-capture completeness attestation is available for this dataset."
    }]
  },
  "requestId": "transport-correlation-id"
}
```

For continuation, send exactly one cursor from the side being extended and keep
the original path `id`:

```http
GET /api/v1/data/canonical/items/{id}/timeline?cursor=<opaque-older-or-newer-token>
Authorization: Bearer <api-key>
```

`cursor` cannot be combined with `before` or `after`. `olderCursor` and
`newerCursor` are not request fields. Direction is inside the signed token, so
clients do not send or change it. A continuation response has
`pageInfo.mode=continuation`, `pageInfo.direction=older|newer`,
`anchorIndex=null`, and only the requested side of `pageInfo` is non-null. Items
remain ascending for both directions: prepend an older page and append a newer
page, deduplicating by canonical `id`.

For timeline and context rows, `eventTime` preserves the exact six-digit UTC
microsecond value used by the `(eventTime, canonicalId)` ordering and exclusive
cursor boundary. Clients can therefore observe the same total-order key that
the server pages on.

Timeline cursors are a distinct domain from canonical-search, Telegram-search,
chat-history and product-list cursors. The HMAC payload binds at least the
cursor/contract version, original path anchor, exact dataset and normalized chat
stream, `older|newer` direction, exclusive `(eventTime, canonicalId)` boundary,
page size, tenant, consumer and `telegram` authorization scope. Tampering,
cross-consumer reuse, cross-anchor replay or any other scope mismatch returns
`400 invalid_cursor`. Continuation uses the signed stream and boundary and does
not need to reread the anchor row, so deleting the original anchor after the
initial page does not invalidate an otherwise valid cursor.

The newer cursor is intentionally present when `newer.hasMore=false`. It
advances to the newest returned item when a page is non-empty and remains
unchanged on an empty page; a client may poll with that cursor for rows
committed later. An exhausted older side returns `older.cursor=null`. This behavior is
`live-keyset`, not snapshot isolation: concurrent writes, late arrivals and
deletes can change boundary-external rows that have not yet been returned. v1
does not promise a frozen view, gap-free change capture, update/delete events or
a changes feed. A future change stream must use a separate monotonic revision
contract rather than changing timeline-cursor semantics.

`hasMore` describes only active rows currently stored by Hub. It never proves
the first or last Telegram upstream message, and
`upstreamCompleteness` retains the independent evidence semantics of the context
contract. The route never calls Telegram, Night-All, a mobile platform or
another upstream collector. It is a safe, independently metered GET requiring
the `telegram` platform grant. Unknown items return `404 item_not_found`;
unregistered datasets return `409 context_not_supported`; invalid windows or
cursor/window mixing return `400 invalid_request`; the grant/hard window limit
returns `400 page_size_exceeded`; unavailable serving indexes return
`503 serving_indexes_unavailable`.

Capability discovery adds `message_timeline` without removing
`message_context`. The Telegram platform entry includes:

```json
{
  "timeline": {
    "contractVersion": "mx-insight-hub.canonical-timeline.v1",
    "ready": true,
    "consistency": "live-keyset",
    "defaultBefore": 10,
    "defaultAfter": 10,
    "maxBefore": 50,
    "maxAfter": 50,
    "cursor": {
      "opaque": true,
      "directions": ["older", "newer"],
      "newerPolling": true
    },
    "datasets": []
  }
}
```

### Night-All-v1-compatible stored search

The standard search route recognizes `platform=telegram` and serves stored Hub
messages locally; it does not call Night-All or TGStat:

```http
POST /api/v1/data/search
Idempotency-Key: <stable-key>
Content-Type: application/json

{ "platform": "telegram", "query": "agent", "pageSize": 20, "cursor": "<opaque>" }
```

For Telegram-specific filters use:

```http
POST /api/v1/data/telegram/search
Idempotency-Key: <stable-key>
Content-Type: application/json

{
  "query": "agent",
  "sourceScope": "all",
  "scope": "messages",
  "chatId": "-1001234567890",
  "authorId": "12345",
  "from": "2026-08-01T00:00:00Z",
  "to": "2026-08-10T00:00:00Z",
  "matchMode": "full_text",
  "pageSize": 20,
  "cursor": "<opaque>"
}
```

`query` is required and limited to 500 characters. `sourceScope` is
`monitor` (default), `sqlite`, or `all`; the default preserves the existing
monitor-only contract. `scope` is
`messages` (default), `chats` or `all`. `chatId` and `authorId` are exact
normalized identities; omitting `chatId` searches globally in the selected
source scope, while setting it searches one conversation. Time bounds are inclusive complete RFC3339 values.
Only `full_text` is implemented; callers cannot send ES DSL, SQL, arbitrary
fields, provider parameters or a physical dataset/source name.

The response uses `contractVersion: night-all.data-search.v1`, including the
familiar `platform`, `query`, `items`, `pageInfo`, `status`, `warnings` and
`meta` fields. Item fields remain
`id/externalId/platform/contentType/url/title/text/publishedAt/collectedAt/
author/metrics/media/source` and additionally report the Hub `canonicalId` and
selected `sourceScope`. Every item reports
`source={provider:null, endpointId:"hub-canonical-search"}`. Response metadata
reports `sourceProvider="mx-insight-hub"` and
`endpointId="hub-canonical-search"`. These are fixed serving-plane labels; they
never identify the registered PostgreSQL provider. Night-All-v1 metric keys are
non-negative numbers or `null`; invalid/negative source sentinels are normalized
to `null` instead of leaking a response that fails the compatibility schema.

Search pagination uses an HMAC-signed opaque cursor, limited to 8,192
characters. The signature binds the cursor to the normalized query, source scope, result scope,
filters, match mode, page size and bounded first-page analysis state. Later
pages reuse the same applied profile, tokens and backend instead of calling the
segmenter again. Do not decode or construct it, and do not change those inputs
while paging. Each distinct page request needs its own stable idempotency key;
replay that exact page body with the same `Idempotency-Key`.

Elasticsearch supplies ranked full-text results when available. It opens a PIT
whose keep-alive is renewed for two minutes on each page, orders by
`_score`, `eventTime`, then `id`, plus the PIT-provided `_shard_doc` tiebreaker,
and advances with `search_after`. Hub requests
`pageSize + 1` rows to determine `hasMore`; traversal neither uses a result
`total` nor stops at the Elasticsearch 10,000-hit window. Clients should page
promptly because an expired PIT returns `410 search_cursor_expired`; restart
from a cursor-less first page with a new idempotency key.

If Elasticsearch is disabled or unreachable on the first page, Hub uses
PostgreSQL substring search and includes a `search_projection_degraded`
warning. PostgreSQL orders by `event_time DESC NULLS LAST, id DESC` and uses a
NULL-aware keyset predicate, never `OFFSET`. The chosen mode is fixed in the
cursor: a PostgreSQL cursor stays on PostgreSQL, while an existing Elasticsearch
cursor never silently falls back. Temporary Elasticsearch unavailability for
that cursor returns `503 search_cursor_unavailable`; retry the same page and
cursor later. The response deliberately has no `meta.searchMode`; degradation
is communicated only through `warnings`. Canonical availability and history
are unchanged. This local search makes zero Night-All/provider calls, but it is
still grant/policy/usage controlled and stores its response for idempotent
replay.

If Elasticsearch remains available but HanLP query analysis degrades, the
server applies raw phrase instead of comparing fallback tokens with the
pre-segmented field and includes `search_profile_degraded`. Telegram's public
envelope intentionally reports only the warning; detailed tokens/backend stay
on the Admin Data Center Search Lab.

### Fuzzy Telegram entities

```http
GET /api/v1/data/telegram/entities/search?query=example&pageSize=20
```

This searches author names/usernames and chat titles/usernames and returns a
ranked union of `{entityType: author|chat, ...}` items plus `pageInfo` and
`searchMode`. ES uses the governed name/prefix/CJK projection; PostgreSQL uses
trigram/substring fallback. The endpoint accepts only `query` (required, at
most 200 characters) and `pageSize` (at most the consumer policy/server limit).
It is a metered safe `GET`, so it does not take an idempotency key and each
retry is a new request.

## Xiaohongshu note detail

The first implemented social-post resolver accepts an official Xiaohongshu note
link and returns a provider-neutral Hub contract. The recommended
platform-shaped, Hub-owned link-input entry point is:

```http
POST /api/v1/xiaohongshu/app/get_note_info
Authorization: Bearer <Hub Public API key>
Content-Type: application/json
Idempotency-Key: xhs-note-20260907-0001

{
  "url": "https://www.xiaohongshu.com/explore/0123456789abcdef01234567",
  "deliveryMode": "cache_first"
}
```

The JSON body accepts `url` directly and defaults a missing `platform` to
`xiaohongshu`. The legacy allowlisted GET spelling
`/api/v1/xiaohongshu/app/get_note_info` accepts `share_text` or `note_id` and
returns the same stable Hub projection. Its optional `delivery_mode` is
`cache_only|cache_first|refresh` and defaults to `cache_first`.

Because GET places `share_text` in the request target, links containing
temporary query parameters such as `xsec_token` can be retained by client,
reverse-proxy, ingress, or APM access logs. Prefer `note_id`, or use either JSON
POST form below for such links. Never publish the temporary parameters in URLs,
screenshots, or logs.

The provider-neutral Hub data-product form remains available:

```http
POST /api/v1/data/post
Authorization: Bearer <Hub Public API key>
Content-Type: application/json
Idempotency-Key: xhs-note-20260907-0001

{
  "platform": "xiaohongshu",
  "url": "https://www.xiaohongshu.com/explore/0123456789abcdef01234567",
  "deliveryMode": "cache_first"
}
```

The platform-shaped JSON-body form shown above defaults a missing `platform` to
`xiaohongshu`:

```http
POST /api/v1/xiaohongshu/app/get_note_info
```

The legacy GET and both POST forms are one logical paid operation and use the
same canonical note identity, snapshot and dispatch-suppression namespace. The
idempotency binding additionally includes the delivery mode, so reusing one
`Idempotency-Key` after changing `cache_first` to `refresh` returns a conflict.
Equivalent `note_id` and long-link inputs still normalize to the same note
identity, so switching route, method or parameter spelling cannot create a
second dispatch for an otherwise identical request. This compatibility name is
owned by Hub; the public result remains the stable Hub schema.

Five separate App V2-compatible GET surfaces preserve the acquired business
envelope instead of returning that Hub projection. Every row requires the
`xiaohongshu` platform grant, `compat.xiaohongshu.app_v2` compatibility grant,
and the listed operation grant in both the key snapshot and current consumer
authorization:

| GET path | Input | Operation grant |
| --- | --- | --- |
| `/api/v1/xiaohongshu/app_v2/get_image_note_detail` | `note_id|share_text` | `social.posts.resolve` |
| `/api/v1/xiaohongshu/app_v2/search_notes` | `keyword`, `page`, `sort_type`, `note_type`, `time_filter`, `search_id`, `search_session_id`, `source`, `ai_mode` | `social.posts.search` |
| `/api/v1/xiaohongshu/app_v2/search_users` | `keyword`, `page`, `search_id`, `source` | `social.users.resolve` |
| `/api/v1/xiaohongshu/app_v2/get_user_info` | `user_id|share_text` | `social.users.resolve` |
| `/api/v1/xiaohongshu/app_v2/get_user_posted_notes` | `user_id|share_text`, plus the preceding Hub-issued opaque `cursor` | `social.users.posts` |

Each identity-shaped route requires at least one selector from its documented
`ID|share_text` pair. When both are present, `note_id` or `user_id` takes
precedence respectively; that same normalized selector binds idempotency and
snapshot identity.

Each App V2 endpoint is its own compatibility contract and uses an exact
endpoint-plus-normalized-query idempotency namespace. These GETs are not a
fourth alias of canonical `/api/v1/data/post`; an `Idempotency-Key` must not be
carried across App V2 endpoints or between an App V2 GET and the three Hub
projection entries.

`search_notes` accepts only the documented App V2 filters: `sort_type` is one of
`general|time_descending|popularity_descending|comment_descending|collect_descending|english_preferred`;
`note_type` is one of `不限|视频笔记|普通笔记|直播笔记`; and `time_filter` is
one of `不限|一天内|一周内|半年内`. Invalid values fail before any paid
provider dispatch.

These routes still enforce Hub Live-Key authorization, immutable grants, quota,
provider cost admission, idempotency, exact restricted archive and canonical
ingest/outbox. `page` is limited to `1..15`; user-post traversal terminates at
page 15. The response preserves text, tags, interactions, signed media URLs,
`params`, `search_id` and `search_session_id`; only the user-post provider
pagination controls are replaced by the governed opaque Hub cursor/has-more
state. Hub applies no field-level text
ceiling. Search may contain an official preview, so callers use the detail route
for complete note text. Only an exact active Hub-to-upstream credential is
removed if echoed; request Authorization, Cookie and API-key headers are never
copied into the response. `Idempotency-Key` is optional on these GETs; when it
is absent, every HTTP call receives a unique internal key and is metered
separately. Only exact caller-supplied key reuse is an idempotent replay.

The POST body accepts only `platform`, `url`, and `deliveryMode`. `platform` must be
`xiaohongshu` on the canonical path. `url` must be an official
`xiaohongshu.com` explore/discovery link containing a 24-character note ID, or
an `xhslink.com` / `xhslink.cn` share link. Arbitrary URLs, credentials, ports,
fragments, provider routing and raw upstream parameters are rejected.
`deliveryMode` is `cache_only`, `cache_first` (default), or `refresh` with the
same delivery semantics as ecommerce. `refresh` requires a caller-supplied
`Idempotency-Key`; transport retries reuse the exact body/key and are never
automatically converted into a second external call. A supplied key is scoped
to the consumer and remains bound to the API key that first used it, so another
API key gets `409 idempotency_conflict`. If `cache_only` or `cache_first` omits
the header, Hub assigns a unique internal key to every HTTP call, including
successes served from cache. Each call has separate usage/charge attribution,
while consumer-scoped snapshots and the dispatch lease still suppress duplicate
external acquisition.

Authorization requires all of the following:

- an active Live Hub Public API key;
- the key's immutable platform entitlement includes `xiaohongshu`, and the
  consumer still has that grant;
- the key's immutable capability entitlement includes
  `social.posts.resolve`, and the consumer still has that capability;
- the active plan, key ceilings, platform policy, and capability policy all
  allow the request. The most restrictive applicable limit wins.

The end-to-end onboarding boundary is: the platform operator creates the
tenant and consumer, grants `xiaohongshu` plus `social.posts.resolve`, and adds
the tenant membership; the member signs in to Internal Hub with the Launcher
session and issues a scoped Live Key whose complete secret is shown once; the
customer backend sends the note link in the platform-shaped JSON POST; and the tenant reviews
its balance, charges and request usage in the plan/usage surfaces. Provider
credentials and procurement evidence never enter that tenant workflow or this
Public contract.

The success contract is `mx-insight-hub.social-post.v1`:

```json
{
  "contractVersion": "mx-insight-hub.social-post.v1",
  "data": { "item": {
    "id": "xiaohongshu:0123456789abcdef01234567",
    "externalId": "0123456789abcdef01234567",
    "platform": "xiaohongshu",
    "contentType": "post",
    "url": "https://www.xiaohongshu.com/explore/0123456789abcdef01234567",
    "title": "示例标题",
    "text": "示例正文",
    "tags": ["旅行", "杭州"],
    "author": { "id": "author-id", "name": "作者", "avatarUrl": "https://sns-avatar.example/avatar.webp" },
    "metrics": { "liked": 12, "collected": 3, "comments": 4, "shared": 1 },
    "media": [{
      "type": "image",
      "url": "https://sns-img.example/note.webp?signature=source-value",
      "hubRelayUrl": "/api/v1/data/posts/media?requestId=00000000-0000-4000-8000-000000000001&mediaIndex=0"
    }],
    "publishedAt": "2026-09-07T00:00:00.000Z",
    "collectedAt": "2026-09-07T00:00:01.000Z"
  } },
  "meta": {
    "capturedAt": "2026-09-07T00:00:01.000Z",
    "servedAt": "2026-09-07T00:00:01.010Z",
    "sourceMode": "live",
    "ageSeconds": 0
  },
  "requestId": "00000000-0000-4000-8000-000000000001"
}
```

Provider credential, endpoint, raw envelope, diagnostic cache URL, procurement
price and customer invoice are intentionally absent. Business payload is not
desensitized or filtered: `author.avatarUrl` and each `media[].url` preserve the
accepted source value. Media indexes `0..19` also have an additive
`media[].hubRelayUrl` bound to the owning consumer, committed response and media
index; later source media remain intact without a relay locator. Fetch an
available locator with the same consumer's Live Key (then render the returned
bytes as a Blob):

```http
GET /api/v1/data/posts/media?requestId=<response requestId>&mediaIndex=0
Authorization: Bearer <same consumer's Live Hub Public API key>
```

The locator expands to the following route contract. Only `requestId` and `mediaIndex` are accepted, each exactly once;
`mediaIndex` is `0..19`. The relay never accepts an arbitrary source URL,
creates no new Hub usage record, and never dispatches another note request. It
applies the common public-HTTPS/DNS/redirect/content/size/time/rate/concurrency
guards and returns JPEG, PNG, or WebP bytes with `Cache-Control: private,
no-store`. Clients may request multiple retained images concurrently within the
advertised tenant and global safeguards and should show a local placeholder for
an individual rejected image.

Stable errors include `400 invalid_post_url|invalid_platform|unsupported_fields`,
`403 platform_not_granted|capability_not_granted|test_key_not_supported`,
`404 post_not_found|stored_snapshot_not_found`, `409 request_in_progress|`
`idempotency_conflict|request_outcome_unknown|uncertain_retry_not_allowed`,
`429 quota_exceeded|external_platform_busy|external_platform_rate_limited|external_platform_capacity_exceeded|external_platform_cost_budget_exhausted|external_platform_subsidy_budget_exhausted`,
`502 external_platform_response_unusable|external_platform_outcome_unknown|`
`external_platform_rejected`, and `503 external_platform_unavailable|external_platform_not_configured|`
`external_platform_contract_unverified|external_platform_circuit_open|external_platform_capacity_unavailable|`
`external_platform_cost_control_unavailable|external_platform_cost_evidence_incomplete|`
`external_platform_operation_disabled|external_platform_operation_shadow|external_platform_operation_paused|`
`external_platform_operation_canary|external_platform_operation_blocked`.
An accepted but missing/invalid note can still consume external capacity, so
the Hub negative-caches only the narrowly verified request-local miss and does
not automatically retry it.

## Planned social capabilities

`POST /api/v1/data/comments`, other platform-specific post resolvers, and
cross-platform generic entity search remain unpublished until each adapter has
a reviewed identity rule, bounded pagination/work budget, sanitized fixture and
readiness gate. They must not be inferred from the implemented Xiaohongshu note
route or silently proxied through the Night-All compatibility facade.

## Request status

```http
GET /api/v1/requests/{requestId}
```

Only the owning consumer can read the record. Data calls identify their
`platform`; generic tools identify their `capability`. Exactly one is present.
This read creates no usage and cannot dispatch an upstream call. `reserved`
means the request may still be running and `unknown` means the outcome remains
ambiguous; neither state permits the caller to repeat the original POST or treat
a new `Idempotency-Key` as a retry. `committed` permits an exact same-body,
same-key replay. Only `unknown` may support one intentionally separate
`refresh` acquisition: it requires a new key, `X-MX-Insight-Retry-Of` and
the caller's deliberate acceptance that the unresolved request may already have
incurred provider cost, while retaining the old record for audit. In the
treasure-box workbench, selecting `refresh` and pressing the main button supplies
that intent; there is no separate checkbox, UUID field or ownership-review action.
`reserved`, lookup failure and contract-version mismatch never qualify.
`released` proves that reservation is no longer holding an outcome; a later
provider-capable acquisition is a new intent and requires a fresh key.

If the client persisted its original idempotency key but did not receive the
request UUID, use the consumer-scoped lookup instead:

```http
GET /api/v1/requests/by-idempotency-key
Authorization: Bearer <current active Hub Public API key>
Idempotency-Key: <original caller-generated key>
```

This lookup has the same read-only guarantees as the UUID route: it creates no
usage, never calls an external platform and returns neither the stored response
body nor the idempotency key. `data.id` is the original durable request UUID;
the top-level `requestId` remains the correlation ID of the lookup itself. Any
active key for the same consumer may perform the lookup, including a rotated
replacement key. A key owned by another consumer receives `404
request_not_found`, so callers cannot probe another consumer's ledger. Clients
must not place the idempotency key in a URL query or path.

## Acquisition exact-delivery evidence

```http
GET /api/v1/acquisitions/{requestId}
Authorization: Bearer <the same active Hub Public API key that created the request>
```

This read-only route reproduces the exact committed JSON body previously
delivered for the durable request UUID. A successful result uses
`mx-insight-hub.acquisition-query-run.v1`; `data.delivered.responseBody` is the
delivered body, and `responseHash` with
`responseHashContract=sha256-canonical-json-v1` provides stable semantic
verification. The same object records the response status, source mode,
capture/completion times and bounded gateway events. `customerCharge` is the
downstream charge evidence, while `items[]` preserves the safe canonical
lineage in delivery order.

The query creates no usage, provider call or upstream dispatch and never
re-runs the original request. Unlike the consumer-scoped status lookup, full
delivery evidence is key-bound: a rotated key for the same consumer, a
zero-scope key, a foreign key or an unknown UUID receives `404
acquisition_query_run_not_found`. The management recovery path remains
available after key rotation. A request without a provably committed response
body returns `409`; clients must not treat this evidence lookup as a retry.

## Usage

```http
GET /api/v1/usage?from=2026-08-01T00:00:00Z&to=2026-08-04T00:00:00Z
```

Returns only the authenticated consumer’s usage. Existing data usage remains
under `byPlatform`; generic tools are reported separately under `byCapability`.
`requestMetering.byMeter` counts accepted logical Hub requests by stable meter
even when no customer price is published. It separates committed, reserved,
released and unknown states. A same-key idempotent replay does not create another
logical usage row or charge; one logical request may still fan out to several
Internal-only provider calls.

`customerBilling` separately reports pricing-record counts and positive enforced
`capturedRequests`, `heldRequests` (reserved plus unknown), `releasedRequests` and
`shadowRequests`. `byCurrency` is the authoritative money view. If more than one
currency is present, top-level money fields are `null`; Hub never adds different
minor units or applies an implicit exchange rate. A current request with a strictly
matched positive enforced wallet hold is not rejected by Hub monthly procurement
or subsidy financial thresholds. Current endpoint/request cost evidence and all
quota, provider-rate, concurrency, circuit, contract, credential, idempotency and
pagination protections still apply.

## Error semantics

| Status | Meaning |
| --- | --- |
| `400` | Invalid field, missing idempotency key, page limit exceeded, or malformed/inapplicable retry-of header (`invalid_uncertain_retry`). |
| `401` | Missing, invalid or revoked API key. |
| `402` | Reserved for insufficient production credit. |
| `403` | Platform/capability is not explicitly granted. |
| `404` | Resource or caller-owned request does not exist. |
| `409` | Idempotency conflict, in-progress request, unknown prior outcome, or a retry-of request whose referenced record is not eligible (`uncertain_retry_not_allowed`). |
| `410` | A search cursor's Elasticsearch PIT has expired; restart from the first page. |
| `429` | Request/concurrency/period quota exhausted. |
| `502` | Safe Night-All 5xx/contract rejection, or ambiguous upstream outcome. |
| `503` | A required stored-data or tokenizer runtime is unavailable. |

Clients should retry only safe `GET` operations and documented pre-dispatch failures. Costly `POST` retry always reuses the same idempotency key.

For the Night-All compatibility facade specifically, upstream
`400/404/409/422/429` keeps its status, while other definite upstream errors map to
`502 night_all_rejected`. A network error, Hub timeout, or unusable HTTP 2xx
content-type/JSON/envelope maps to `502 upstream_outcome_unknown`, not `504`; the
request becomes `unknown`. When an unexpired exact complete snapshot exists, those
ambiguous outcomes or a real non-2xx `502/503/504` instead return a successful
stale response with the source/age headers documented above. Partial HTTP 200 is
returned live and never replaced by stale. These compatibility routes do not
return `410 search_cursor_expired`; that error remains on PIT-backed Hub search
operations such as `/data/search`, `/data/stored/search`, and
`/data/canonical/search`.

Tokenizer errors add `capability_not_granted`, `tokenizer_unavailable` and
`tokenizer_invalid_response`. Any segmenter exception is mapped to a fixed safe
message; upstream response bodies and credentials are never copied into the
client error.

For Telegram history, `400` includes `invalid_request`, `invalid_cursor`,
`page_size_exceeded` and `unsupported_fields`; `401` is `api_key_required` or
`invalid_api_key`; `403` is `platform_not_granted`; `429` is
`quota_exceeded`; and `503` is `stored_data_unavailable`. A retry must reuse the
same cursor but is separately metered. A page is a view of the current
canonical dataset, not a frozen snapshot across a long multi-page traversal.

Telegram stored search adds `idempotency_key_required`,
`invalid_idempotency_key`, `unsupported_match_mode`, `request_in_progress`,
`idempotency_conflict`, `request_outcome_unknown` and
`stored_search_unavailable`. It also returns `search_cursor_expired` with `410`
when an Elasticsearch PIT no longer exists, or `search_cursor_unavailable` with
`503` when an existing Elasticsearch cursor cannot currently be served. The
latter is retryable with the same cursor and page idempotency key; neither case
silently switches that cursor to PostgreSQL. Entity search uses the history
authentication and quota errors plus `stored_search_unavailable`. A first-page
PostgreSQL search fallback is a successful degraded response with an explicit
warning, not a `503`.
