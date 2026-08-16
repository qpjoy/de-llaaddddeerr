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
   one PIT and `_score`, event time, canonical ID, plus the PIT-provided
   `_shard_doc` tiebreaker as the stable sort. The
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
7. Query behavior is named by an immutable, versioned server-side profile. The
   current strict behavior becomes `canonical.balanced.v1`; a logical default
   resolves to one concrete version before the query starts. Callers may only select names
   in the public allowlist and can never submit an index, field list, analyzer,
   boost, Elasticsearch DSL, script, or raw `_explain`/profile request.
8. The resolved profile version is part of cursor and idempotency binding. The
   signed cursor also carries the first page's bounded query-analysis state
   (applied profile, tokens, backend and degradation), so later pages do not
   re-segment and change `_score` order inside one PIT traversal.
9. A content v4 projection is the bounded index capability set for profile
   experiments: raw `standard`, HanLP coarse pre-segmented fields, title/body
   CJK bigram multi-fields, and a title-only edge-prefix field. It is a new
   schema-versioned index rebuilt from PostgreSQL, not an in-place
   reinterpretation of content v3.
10. Diagnostics expose stable query-token provenance, named match branches and
    highlights. CJK-only and historical loose-OR profiles are Admin Search Lab
    controls; they cannot be promoted to the public allowlist or logical default.

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

## Search profiles and analysis lifecycle

Profiles describe product-level search intent, not Elasticsearch configuration:

| Profile | Visibility | Semantics |
| --- | --- | --- |
| `canonical.balanced.v1` | Public/Admin default | raw phrase or HanLP coarse terms-all; preserves the current strict result boundary |
| `canonical.phrase.v1` | Public/Admin | raw phrase only |
| `canonical.terms-all.v1` | Public/Admin | every coarse query token must match the pre-segmented field |
| `canonical.zh-recall.v1` | Public/Admin on content v4 | phrase + terms-all + lower-boost ordered CJK-bigram phrase; never unigram OR |
| `canonical.title-prefix.v1` | Public/Admin on content v4 | title and bounded name/handle/username prefixes; edge-ngram at index time and a plain analyzer at search time |
| `canonical.cjk-bigram.v1` | Admin Search Lab | isolates CJK tokens and ranking for evaluation |
| `canonical.legacy-or.v1` | Admin Search Lab | reproduces the former loose OR behavior only for controlled comparison |

`canonical.balanced.v1` invokes the configured query segmenter on the first page.
When HanLP is healthy it sends the whitespace-joined tokens to the `*Hanlp`
pre-segmented fields with `operator=AND`; the raw phrase branch is the other
alternative. Query-analysis metadata distinguishes
`backendUsed=hanlp|jieba|bigram`, degradation and a bounded error code. A
degraded fallback is not compared with HanLP postings: the applied profile is
`canonical.phrase.v1`, and later pages reuse that exact signed analysis state.
CJK bigrams are not part of balanced: a healthy `canonical.zh-recall.v1` adds
their ordered phrase branch at lower weight, while the Admin profile isolates
it for diagnostics.

This carries forward the useful idea behind IK `max_word` at index time and
`smart` at search time without adding an ES plugin. MX stores separate raw,
HanLP coarse and CJK views, then lets a narrower profile choose among them.
The target model keeps coarse, fine and bigram tokens out of the same field
because mixing them makes term frequency, positions and phrase evidence
ambiguous. The current legacy-named `*Hanlp` field is only a pre-segmented
channel: live fail-soft projection may still place Jieba/bigram fallback terms
there, while strict full reconciliation rejects them. A future immutable HanLP
view therefore requires a dedicated versioned field plus model digest/pending
state. The current HanLP service has one fixed coarse model; a future
fine/max-word field requires a real model and enrichment migration, not a
request flag.

Phrase/slop, AND/minimum-should-match, boosts, filters, rescore and selection
among already-indexed compatible search analyzers are query-time changes and do
not rewrite documents. Any index-time term change does: changing an existing
field analyzer or adding CJK, edge-ngram, delimiter, html-strip, stemming or a
new HanLP token view requires a schema-versioned blue/green rebuild from PG.
Although Elasticsearch can add a multi-field mapping in place, historical
documents do not gain its postings until replayed; a mixed-capability corpus is
not an accepted migration state.

Analyzer scope remains deliberately narrow:

- `word_delimiter_graph` is for bounded identifiers such as handles, product
  numbers or file names and uses a keyword/whitespace tokenizer. It is neither
  Chinese segmentation nor a body analyzer; catenated/preserved graph tokens
  require explicit phrase-position validation.
- `html_strip` is only for datasets/content types known to contain markup. It
  must not globally reinterpret Telegram text, code, or literal angle brackets.
- Snowball/stemming belongs to a language-confirmed English field/profile, not
  multilingual body text, names, or identifiers.
- edge-ngram is index-time and title-only in content v4. Search uses the plain
  query token; applying ngrams to both sides recreates broad, low-quality recall.

The v4 migration uses the strict `reindex-search` reconciler: it requires exactly
one ready projector, verifies the configured tokenizer for every field with
bounded retry, fails on degraded/fallback output or mapping conflict, fills the
new `v4-current` from PG, atomically switches aliases only after the first full
pass, and runs the second pass to close the concurrent-write window. Public/Admin
APIs, ingest, Launcher, MX-H2I login and networking are not restarted by this
command. The prior v3 index remains the rollback target until count/hash,
relevance, disk and latency checks pass.

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
- Most future relevance experiments become a new immutable query profile and
  require no corpus rebuild. A genuinely new token representation still incurs
  one controlled PG-to-ES rebuild; bounded pre-indexing reduces that frequency
  but does not promise that Elasticsearch schemas never change.
