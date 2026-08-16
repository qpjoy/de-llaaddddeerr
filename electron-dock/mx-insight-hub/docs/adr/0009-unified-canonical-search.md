# ADR-0009: Unified canonical search

Status: accepted

## Context

The Hub deliberately keeps source-shaped APIs where their contract is useful:

- `GET /api/v1/data/telegram/messages` and
  `POST /api/v1/data/telegram/search` serve the fixed
  `telegram.monitor.*` datasets;
- `POST /api/v1/data/stored/search` searches one explicitly granted platform
  and may be narrowed to one logical dataset;
- `POST /api/v1/data/search` keeps the live Night-All-compatible, single-platform
  contract.

Those boundaries are useful for source-specific workflows, but they are not a
good primary contract for a data consumer that wants relevant Hub-owned data
without knowing whether it arrived through Telegram monitor, SQLite import,
Night-All backfill, or another connector.

Querying each source endpoint in sequence and concatenating the responses would
also create unstable semantics. A slow or failed source would change the page,
top-N truncation would favour small sources, raw relevance scores from separate
queries would not be comparable, and a single opaque cursor could not describe
the mixed result set.

## Decision

Add `POST /api/v1/data/canonical/search` as the source-independent stored-data
contract. It performs one query against the Hub's shared canonical current-state
search projection:

1. The caller's current platform grants form the mandatory authorization
   filter. An optional `platform` may narrow that set, but cannot expand it.
2. Optional `datasetId` and `objectType` values are logical filters only. The
   caller cannot select a database, cluster, index, provider, SQL, or
   Elasticsearch DSL.
3. All matching datasets compete in one ranked result set. Elasticsearch uses
   one PIT and `_score`, event time, and canonical ID as the stable sort. The
   PostgreSQL degradation path searches the same authorized canonical rows.
4. The response uses the existing public canonical item allowlist. Raw payloads,
   extensions, credentials, connector coordinates, and provider metadata stay
   private.
5. The signed cursor is bound to the normalized query, filters, page size, and
   sorted granted-platform scope. A grant change therefore invalidates an old
   cursor instead of silently widening or narrowing a later page.
6. The operation has its own stable usage-ledger scope. Every canonical-search
   request, including an explicitly narrowed platform request, uses the
   strictest request/page limit and longest window across the consumer's
   complete current platform-grant set. This is deliberately conservative: a
   looser platform cannot refill or widen the shared canonical-search bucket.

The existing source-shaped and compatibility endpoints remain unchanged. In
particular, the unified stored search is not a replacement for a live Night-All
provider call and does not make the fixed Telegram monitor endpoints read
SQLite-import datasets.

## Ranking strategy

The first implementation uses one lexical query over one index, so BM25 scores
are produced in a single scoring context and can be sorted directly. We do not
run one query per source, assign hand-tuned source weights, or reserve a fixed
number of slots per dataset. Those approaches encode ingestion topology into
customer-visible relevance and make pagination dependent on source count.

The returned unit is still a canonical record. Two datasets that intentionally
retain separate records with the same platform/object/external identity remain
two results; this endpoint must not silently invent a cross-dataset survivor
rule. A future identity-resolution projection may publish a versioned group key
and provenance-aware representative, but that is a data-model decision rather
than a search-score heuristic.

If vector retrieval is later added to this public contract, lexical and vector
candidate lists should be fused inside the same authorized corpus with
rank-based fusion such as RRF. Raw BM25 and cosine scores must not be added
directly, and source identity must not become an implicit relevance boost.

## Consequences

- A Telegram consumer can search monitor and SQLite-import messages together by
  sending `platform=telegram` and omitting `datasetId`.
- A consumer with several platform grants may omit `platform` and receive one
  globally ranked page across those grants. Canonical identity is deduplicated
  within each dataset; records intentionally separated across datasets remain
  separately visible.
- Source-specific APIs remain predictable and independently callable.
- Elasticsearch remains a rebuildable projection; PostgreSQL canonical current
  state remains authoritative.
- Total hits describe the authorized, filtered result set. They are metadata;
  cursor pagination remains the stable way to traverse deep or changing result
  sets.
