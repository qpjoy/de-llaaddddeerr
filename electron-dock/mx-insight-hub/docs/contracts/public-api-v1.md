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
    "platforms": [{
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
    }],
    "capabilities": [
      { "capability": "nlp.tokenize", "ready": true },
      { "capability": "public_opinion.all_ingested.read", "ready": true },
      { "capability": "public_opinion.diagnostics.read", "ready": true }
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
and body with the same key returns the stored bounded response without another
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

`query` must be non-blank and at most 500 characters after trimming. `cursor`, when present, must be a non-blank opaque string of at most 8,192 characters. Clients must return the cursor from the previous response unchanged rather than constructing or decoding it.

The server rejects or ignores internal-only fields including `businessId`, `provider`, `endpointId`, `availabilityMode`, `includeRaw`, and arbitrary provider params.

Successful responses preserve the stable Night-All data-search envelope and add:

- `x-request-id`: transport correlation ID;
- `x-mx-insight-request-id`: durable Hub request ID;
- `idempotent-replay: true|false`.

## Night-All legacy compatibility facade

These transitional routes preserve the three existing Night-All request aliases
and standard raw response envelope behind the Hub trust boundary:

| Hub route | Private Night-All operation | Required selector | Complete snapshot window |
| --- | --- | --- | ---: |
| `POST /api/v1/night-all/search/raw` | `/api/v1/search/raw` | `keyword`, `query`, `keywords` or `queries` | 15 minutes |
| `POST /api/v1/night-all/search/crawl` | `/api/v1/search/crawl` | a user/channel identifier | 1 hour |
| `POST /api/v1/night-all/search/user-info` | `/api/v1/search/user-info` | a user identifier | 1 hour |

All three require `Authorization: Bearer <mx key>` (or `x-api-key`), an
`Idempotency-Key` of 8–128 safe characters, one explicit platform, and that
platform's consumer grant. `all` and `*` are invalid. For example:

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
carry safe platform continuation values, but provider, credential, endpoint,
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
Raw query count × page size and crawl identity count × page size × activity-type
count must also fit the policy work budget or the Hub returns
`400 work_budget_exceeded`. This bounds processed item work, not the exact number
of paid provider calls.

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
  "requestId": "night-all-request-id",
  "traceId": "night-all-trace-id"
}
```

`raw_info` and `raw_data` intentionally remain JSON strings. For these three
namespaced compatibility routes Hub currently performs no response-field
desensitization: provider, endpoint and other fields returned by Night-All remain
in the outer envelope and in objects encoded in those strings. This is separate
from the request-side rule above, which still rejects caller injection of
provider/token/credential controls. The body retains Night-All's `requestId` and
`traceId`; the current durable Hub request ID is separate:

- `x-mx-insight-request-id: <hub request UUID>`;
- `idempotent-replay: true|false`;
- `x-mx-insight-source-mode: live|stale`;
- `x-mx-insight-captured-at: <RFC3339 capture time>`;
- `Age: 0` for live delivery or the snapshot age for stale delivery;
- `Warning: 110 - "Response is stale"` only for stale delivery.

Every actual dispatch records separate Hub call evidence, including operation,
consumer, exact fingerprint, platform, latency, HTTP/business outcome, bounded
failure kind and Night-All correlation IDs. Night-All HTTP 200 with a substantive
warning or per-result error/`success=false` is a `partial` live success: it is
returned but never creates or replaces a compatibility snapshot. A lone
`STANDARD_PAYLOAD_EMPTY` warning is a deterministic complete empty result and does
replace last-good, preventing an older non-empty snapshot from resurfacing. Only
`complete` responses write last-good.

Each new `Idempotency-Key` may dispatch once; a committed live or stale delivery
is permanently replayed by that key, and a deliberately new live call needs a
new key. After network/timeout ambiguity, an unusable HTTP 2xx
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
| definite `400`, `404`, `409`, `422`, `429` | same HTTP status, safe `night_all_rejected` error |
| other definite non-2xx HTTP rejection | `502 night_all_rejected` |
| network error, Hub timeout, or unusable HTTP 2xx contract after dispatch | `502 upstream_outcome_unknown`; request becomes `unknown` |

An ambiguous request must not be automatically retried with a new key. A
dispatched compatibility error includes the durable Hub ID as
`error.details.requestId`; successful live/stale delivery carries it in
`x-mx-insight-request-id`. Use that ID with
`GET /api/v1/requests/{hub-request-id}`. A replay with the same key reports the
held unknown outcome. Hub does not emit `504` for its own timeout because it cannot
prove that a paid upstream did no work.

This facade is distinct from `/api/v1/data/search` and from canonical stored
search. Its complete/partial live payloads also enter the governed
`night-all.compat.v1` ingest dataset asynchronously in their original,
non-desensitized form, but ingest/search state never changes the already-delivered
legacy response. Response, exact snapshot and raw ingest therefore retain the same
unmasked source evidence in this compatibility slice. See
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
replay that exact page body with the same key.

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

## Planned capabilities

Not implemented. Recorded here so the client-facing shape stays stable once the upstream capabilities land. Each keeps the same auth (`Authorization: Bearer <API key>`), grant checks, quota accounting and freshness envelope as `search`.

```http
POST /api/v1/data/post          { "platform": "...", "postId": "..." }
POST /api/v1/data/comments      { "platform": "...", "postId": "...", "pageSize": 20, "cursor": "..." }
```

`post` and `comments` depend on upstream `post_detail`/`post_comments` capabilities that the versioned Night-All data contract does not yet expose; see [Night-All integration](../architecture/night-all-integration.md). Until they exist under readiness governance these routes stay unpublished rather than silently proxying an ungoverned legacy route.

Identifier lookups take `postId` as the caller-facing name; platform-specific
aliases such as `noteId`, `awemeId` or `tweetId` are normalized internally and
are not part of this contract. Cross-platform generic entity search remains a
future capability; the Telegram-specific entity route above is implemented.

## Request status

```http
GET /api/v1/requests/{requestId}
```

Only the owning consumer can read the record. Data calls identify their
`platform`; generic tools identify their `capability`. Exactly one is present.
An `unknown` state means the outcome is ambiguous; the caller must not
automatically repeat the request with a new key.

## Usage

```http
GET /api/v1/usage?from=2026-08-01T00:00:00Z&to=2026-08-04T00:00:00Z
```

Returns only the authenticated consumer’s usage. Existing data usage remains
under `byPlatform`; generic tools are reported separately under `byCapability`.

## Error semantics

| Status | Meaning |
| --- | --- |
| `400` | Invalid field, missing idempotency key, or page limit exceeded. |
| `401` | Missing, invalid or revoked API key. |
| `402` | Reserved for insufficient production credit. |
| `403` | Platform/capability is not explicitly granted. |
| `404` | Resource or caller-owned request does not exist. |
| `409` | Idempotency conflict, in-progress request, or unknown prior outcome. |
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
returned live and never replaced by stale.

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
