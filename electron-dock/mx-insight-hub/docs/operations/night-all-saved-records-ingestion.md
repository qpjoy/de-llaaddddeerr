# Night-All saved-records ingestion

Status: repository implementation, installed paused and unapproved by default.
Migration `066_night_all_saved_records_sources.sql` registers the fixed inputs;
it does not connect to the source database, read a row, approve a mapping,
activate a task or grant a Public API platform.

## 1. Scope and isolation

This pipeline reads the 13 LIST leaf partitions below from the existing
`agent_data_crawler_platform` PostgreSQL database. It deliberately does not
pull from the `public.saved_records` parent: each leaf owns an independent
dataset, authorization platform, checkpoint, run history and failure state.

| `source_type` | Physical table | Source key | Dataset | Authorization platform |
| --- | --- | --- | --- | --- |
| `automotive` | `public.saved_records_automotive` | `night-all-saved-records-automotive` | `data-center.saved-records.automotive.v1` | `data_center_saved_records_automotive` |
| `finance` | `public.saved_records_finance` | `night-all-saved-records-finance` | `data-center.saved-records.finance.v1` | `data_center_saved_records_finance` |
| `forum` | `public.saved_records_forum` | `night-all-saved-records-forum` | `data-center.saved-records.forum.v1` | `data_center_saved_records_forum` |
| `hotspot` | `public.saved_records_hotspot` | `night-all-saved-records-hotspot` | `data-center.saved-records.hotspot.v1` | `data_center_saved_records_hotspot` |
| `local_news` | `public.saved_records_local_news` | `night-all-saved-records-local-news` | `data-center.saved-records.local_news.v1` | `data_center_saved_records_local_news` |
| `media` | `public.saved_records_media` | `night-all-saved-records-media` | `data-center.saved-records.media.v1` | `data_center_saved_records_media` |
| `news` | `public.saved_records_news` | `night-all-saved-records-news` | `data-center.saved-records.news.v1` | `data_center_saved_records_news` |
| `other` | `public.saved_records_other` | `night-all-saved-records-other` | `data-center.saved-records.other.v1` | `data_center_saved_records_other` |
| `recruitment` | `public.saved_records_recruitment` | `night-all-saved-records-recruitment` | `data-center.saved-records.recruitment.v1` | `data_center_saved_records_recruitment` |
| `research` | `public.saved_records_research` | `night-all-saved-records-research` | `data-center.saved-records.research.v1` | `data_center_saved_records_research` |
| `social` | `public.saved_records_social` | `night-all-saved-records-social` | `data-center.saved-records.social.v1` | `data_center_saved_records_social` |
| `technology` | `public.saved_records_technology` | `night-all-saved-records-technology` | `data-center.saved-records.technology.v1` | `data_center_saved_records_technology` |
| `web` | `public.saved_records_web` | `night-all-saved-records-web` | `data-center.saved-records.web.v1` | `data_center_saved_records_web` |

All implementation and state are inside MX Insight Hub. The pipeline neither
imports MX Launcher code nor changes Launcher authentication, Domestic/Internal
routing, DNS, WireGuard, Electron plugins or MX-H2I user sessions. A failure or
pause here affects only these 13 Hub ingestion tasks.

## 2. Registration and credentials

The migration stores only the stable source locator:
`schema`, `table`, `cursorColumn=last_seen_at` and `idColumn=id`. It contains no
host, port, database user, password or DSN. Configure one Admin-managed
PostgreSQL connection profile for all 13 tasks after deployment; the profile
owns transport and secrets while each source continues to own its physical
table, dataset, authorization platform and checkpoint.

The Hub source connection is read-only for its whole PostgreSQL session. Index
installation is a separate, explicitly authorized source-database operation
using a DDL-capable operator identity; never give that identity to the Hub
runtime.

## 3. Source index gate

Every leaf needs one valid, ready, non-partial unique B-tree whose exact keys
are `(last_seen_at, id)`. The parent primary key `(source_type, id)` does not
prove the generic keyset puller's total-order contract.

The Internal deploy reads only the 13 effective transport shapes from the Hub
catalog. Once all 13 are configured consistently for
`127.0.0.1:5432/agent_data_crawler_platform`, it runs the versioned script as a
standalone `psql` operation through the host `postgres` peer identity, but only
after matching the Unix-socket postmaster PID to the real IPv4 5432 listener.
No source password is exported from the Hub catalog. A non-local or legacy
`dsnEnv` source uses the root-managed libpq service named by
`MX_INSIGHT_NIGHT_ALL_DDL_SERVICE`. Both paths disable password prompting and
bound connection setup to 10 seconds; partial 13-task transport configuration
is drift and stops deployment rather than being treated as unconfigured.

An independently managed deployment can run the same operation directly,
outside any surrounding transaction:

```sh
cd electron-dock/mx-insight-hub
psql -X "service=night_all_ddl dbname=agent_data_crawler_platform" \
  -f scripts/night-all-saved-records-source-indexes.sql
```

The script uses `CREATE UNIQUE INDEX CONCURRENTLY`, checks the complete catalog
contract for all 13 indexes and exits non-zero if any result is absent, invalid,
not ready, partial, non-unique, incorrectly ordered or bound to the wrong leaf.
Rerunning repairs an interrupted invalid build. A uniqueness failure is source
contract evidence; investigate it rather than weakening the index.

## 4. Mapping and fixed cleaning

Migration 066 seeds mapping version 1 for each source but leaves every mapping
unapproved. The declarative mapping intentionally has a narrow role:

- canonical `externalId` is `record_key`; identity is therefore stable within
  the dataset for one `source_type`, without assuming global cross-type
  uniqueness;
- `record_type`, URL, title and text map to bounded canonical scalar fields;
- `first_seen_at` becomes collection time;
- `raw`, `evidence`, `author`, `metrics`, `media`, `attributes` and other large
  or source-private values are consumed by `_drop`, so they do not spill into
  canonical extensions or the public Elasticsearch projection;
- `_drop` does not delete source evidence: the exact source row remains in the
  restricted raw-ingestion lineage;
- `published_at` is not interpreted by the generic mapper. The fixed cleaner
  parses supported explicit offsets deterministically, interprets supported
  naive date-times as `Asia/Shanghai`, preserves source precision and error
  evidence, and does not invent a midnight instant for a date-only value.

The fixed cleaner also keeps collector and publisher separate. It classifies
both only against one active PostgreSQL source-catalog snapshot, records the
catalog entry ID/revision in `stable_fields.sourceCatalog`, and leaves unknown
or ambiguous values unresolved. It never infers a provider from a title.
After migration 066, the Internal deploy automatically streams the Hub-side
online index script into the shared Hub database before Public rollout. An
independently managed deployment can run the same operation directly (not
against the source database and not inside a transaction):

```sh
cd electron-dock/mx-insight-hub
psql -X "$DATABASE_URL" \
  -f scripts/night-all-saved-records-hub-indexes.sql
```

It contract-checks and builds four one-key expression indexes for the
independently planned source-catalog match paths:

- `stable_fields #>> '{sourceCatalog,publisher,entryId}'`;
- `stable_fields #>> '{sourceCatalog,collector,entryId}'`;
- `stable_fields #>> '{commerce,marketplace,entryId}'`;
- `lower(btrim(normalize(platform, NFKC)))`.

The three entry-ID indexes include soft-deleted records because catalog
governance reports both active and deleted counts. The related-data query uses
four `UNION` arms so one match path cannot make PostgreSQL discard the other
indexes and scan the entire canonical table. These Hub-local indexes are
distinct from the 13 source-database cursor indexes above.

## 5. Identity, cursor, writer and delete contract

Activation requires a human attestation of all of the following for every leaf:

1. The source keeps its reviewed declarations: only `run_id`, `source_family`,
   `collection_mode`, `published_at` and `raw` may be nullable; the other 18
   fixed columns are non-null. `id` is immutable and never reused within that
   fixed leaf/dataset lifetime. `record_key` is the stable canonical source
   identity.
2. Each leaf contains only its declared `source_type`. Rebinding, replacing,
   truncating or restoring a table cannot silently continue the old checkpoint.
3. `last_seen_at` is a finite PostgreSQL timestamp. Every insert and every
   material update—including content, quality, metadata and a visible removal
   state—sets it to a value strictly suitable for the ordered cursor.
4. Commit ordering cannot expose a later transaction at or behind a
   `(last_seen_at, id)` checkpoint already acknowledged by Hub. If the writer
   cannot guarantee that property, use an ordered change journal or CDC before
   activation.
5. The source does not hard-delete rows already visible to Hub. A disappearing
   row is not a tombstone and is never inferred as deletion. Use a watermarked
   soft-delete/change event, CDC, or a separately reviewed reconciliation
   design.
6. The exact unique cursor index from section 3 remains valid and ready.

Each leaf has its own durable checkpoint. One leaf's schema drift, malformed
cursor or failed run must fail that task closed without resetting or blocking
the other 12. A checkpoint reset is a reviewed full-rescan action, not a repair
for an invalid writer contract.

The activation probe is not the runtime trust boundary. Every manual or
scheduled database page pull reloads this evidence from the source and fails
with `source_contract_mismatch` before canonical ingest when any item differs:

- the persisted source still has the fixed dataset, platform, object type and
  leaf locator;
- the leaf still has exactly the reviewed 23 columns and nullability. The
  PostgreSQL types are exact: `id`/`run_id` are `int4`; source descriptors and
  `published_at` use their reviewed `varchar` fields; `source_url` and `text`
  are `text`; evidence/author/metrics/media/attributes/raw are `jsonb`; and the
  three seen/created timestamps are `timestamptz`;
- the relation is an ordinary leaf directly under
  `public.saved_records`, whose key remains `LIST (source_type)`, and its bound
  is the one fixed value for that task;
- a valid, ready and live unique B-tree remains on exactly
  `(last_seen_at, id)`, with no expression, predicate, included column or
  non-default ordering;
- every returned row's `source_type` equals the leaf value.

A saved checkpoint containing `infinity` or `-infinity` is rejected before a
source connection opens. After the exact unique B-tree passes, every real pull
also reads the first and last `(last_seen_at, id)` endpoints through that index;
this catches both infinities in logarithmic index probes, including a newly
inserted `-infinity` row that sorts behind an already advanced checkpoint. The
exact `last_seen_at::text` values returned by a page are checked before an
import run starts, and committed-batch replay evidence is checked again before
acknowledgement. Therefore neither source rows nor retry evidence can advance a
Night-All checkpoint to a non-finite watermark. These checks are scoped by the
exact Night-All source-key set; generic database, Telegram, province-opinion
and mobile-commerce pulls retain their existing contracts.

The activation `describe` probe derives the same strict partition and index
issues from its existing catalog metadata query, and the progress view applies
the same source, column and physical checks before counting. Progress also
counts non-finite watermarks and mismatched `source_type` values in its one
aggregate query, returning a blocked result instead of a plausible percentage
when either is present.

## 6. Public-authorization preflight

Migration 066 aborts before registering a source when any of the 13 reserved
platforms already has a consumer grant, or when an active, unexpired snapshot
key retains a latent entitlement for one. This prevents a grandfathered
`legacy_dynamic` key from inheriting a newly reserved corpus and prevents a
later grant from silently reactivating an old snapshot scope.
The migration runner executes the file in one transaction and takes bounded
`SHARE` locks on the grant and entitlement tables, so an Admin write cannot
cross the probe/commit boundary. A busy writer makes the migration fail on its
lock timeout; drain that writer and retry rather than bypassing the gate.

Run this read-only report before migration. Any nonzero count requires an
explicit grant/key audit and remediation; do not weaken or remove the migration
gate:

```sql
WITH reserved(platform) AS (
  SELECT unnest(ARRAY[
    'data_center_saved_records_automotive',
    'data_center_saved_records_finance',
    'data_center_saved_records_forum',
    'data_center_saved_records_hotspot',
    'data_center_saved_records_local_news',
    'data_center_saved_records_media',
    'data_center_saved_records_news',
    'data_center_saved_records_other',
    'data_center_saved_records_recruitment',
    'data_center_saved_records_research',
    'data_center_saved_records_social',
    'data_center_saved_records_technology',
    'data_center_saved_records_web'
  ]::text[])
), scope_counts AS (
  SELECT 'platform_grant'::text AS scope_kind, count(*) AS row_count
    FROM platform_grants grant_record
    JOIN reserved
      ON lower(btrim(normalize(grant_record.platform, NFKC))) = reserved.platform
  UNION ALL
  SELECT 'live_snapshot_entitlement', count(*)
    FROM api_key_platform_entitlements entitlement
    JOIN reserved
      ON lower(btrim(normalize(entitlement.platform, NFKC))) = reserved.platform
    JOIN api_keys api_key_record ON api_key_record.id = entitlement.api_key_id
   WHERE api_key_record.scope_mode = 'snapshot'
     AND api_key_record.status = 'active'
     AND api_key_record.expires_at > now()
)
SELECT scope_kind, row_count
  FROM scope_counts
 ORDER BY scope_kind;
```

When either count is nonzero, enumerate currently effective live keys before
changing any grant:

```sql
WITH reserved(platform) AS (
  SELECT unnest(ARRAY[
    'data_center_saved_records_automotive',
    'data_center_saved_records_finance',
    'data_center_saved_records_forum',
    'data_center_saved_records_hotspot',
    'data_center_saved_records_local_news',
    'data_center_saved_records_media',
    'data_center_saved_records_news',
    'data_center_saved_records_other',
    'data_center_saved_records_recruitment',
    'data_center_saved_records_research',
    'data_center_saved_records_social',
    'data_center_saved_records_technology',
    'data_center_saved_records_web'
  ]::text[])
)
SELECT tenant.id AS tenant_id,
       tenant.name AS tenant_name,
       consumer.id AS consumer_id,
       consumer.name AS consumer_name,
       api_key_record.id AS api_key_id,
       api_key_record.name AS api_key_name,
       api_key_record.key_prefix,
       api_key_record.last_four,
       grant_record.platform,
       api_key_record.scope_mode,
       api_key_record.expires_at,
       CASE api_key_record.scope_mode
         WHEN 'legacy_dynamic' THEN 'legacy_dynamic_inherited'
         ELSE 'snapshot_entitled'
       END AS entitlement_path
  FROM platform_grants grant_record
  JOIN reserved
    ON lower(btrim(normalize(grant_record.platform, NFKC))) = reserved.platform
  JOIN api_keys api_key_record
    ON api_key_record.consumer_id = grant_record.consumer_id
  JOIN consumers consumer
    ON consumer.id = api_key_record.consumer_id
   AND consumer.status = 'active'
  JOIN tenants tenant
    ON tenant.id = api_key_record.tenant_id
   AND tenant.status = 'active'
  LEFT JOIN api_key_platform_entitlements entitlement
    ON entitlement.api_key_id = api_key_record.id
   AND entitlement.platform = grant_record.platform
 WHERE api_key_record.status = 'active'
   AND api_key_record.expires_at > now()
   AND (
     api_key_record.scope_mode = 'legacy_dynamic'
     OR (
       api_key_record.scope_mode = 'snapshot'
       AND entitlement.api_key_id IS NOT NULL
     )
   )
 ORDER BY grant_record.platform, tenant.name, consumer.name, api_key_record.name;
```

The effective-key report starts from an existing grant and intentionally shows
only authority that works now. Independently enumerate every snapshot blocker
below, including suspended owners and entitlements with or without an exact or
normalized-equivalent consumer grant:

```sql
SELECT tenant.id AS tenant_id,
       tenant.name AS tenant_name,
       tenant.status AS tenant_status,
       consumer.id AS consumer_id,
       consumer.name AS consumer_name,
       consumer.status AS consumer_status,
       api_key_record.id AS api_key_id,
       api_key_record.name AS api_key_name,
       entitlement.platform,
       api_key_record.expires_at,
       EXISTS (
         SELECT 1
           FROM platform_grants exact_grant
          WHERE exact_grant.consumer_id = api_key_record.consumer_id
            AND exact_grant.platform = entitlement.platform
       ) AS has_exact_consumer_grant,
       EXISTS (
         SELECT 1
           FROM platform_grants normalized_grant
          WHERE normalized_grant.consumer_id = api_key_record.consumer_id
            AND lower(btrim(normalize(normalized_grant.platform, NFKC)))
                = lower(btrim(normalize(entitlement.platform, NFKC)))
       ) AS has_normalized_consumer_grant,
       CASE
         WHEN EXISTS (
           SELECT 1
             FROM platform_grants exact_grant
            WHERE exact_grant.consumer_id = api_key_record.consumer_id
              AND exact_grant.platform = entitlement.platform
         ) THEN 'snapshot_with_exact_consumer_grant'
         WHEN EXISTS (
           SELECT 1
             FROM platform_grants normalized_grant
            WHERE normalized_grant.consumer_id = api_key_record.consumer_id
              AND lower(btrim(normalize(normalized_grant.platform, NFKC)))
                  = lower(btrim(normalize(entitlement.platform, NFKC)))
         ) THEN 'snapshot_with_normalized_consumer_grant'
         ELSE 'latent_snapshot_without_consumer_grant'
       END AS entitlement_path
  FROM api_key_platform_entitlements entitlement
  JOIN api_keys api_key_record ON api_key_record.id = entitlement.api_key_id
  JOIN consumers consumer
    ON consumer.id = api_key_record.consumer_id
  JOIN tenants tenant
    ON tenant.id = api_key_record.tenant_id
 WHERE lower(btrim(normalize(entitlement.platform, NFKC)))
       ~ '^data_center_saved_records_(automotive|finance|forum|hotspot|local_news|media|news|other|recruitment|research|social|technology|web)$'
   AND api_key_record.scope_mode = 'snapshot'
   AND api_key_record.status = 'active'
   AND api_key_record.expires_at > now()
 ORDER BY entitlement.platform, tenant.name, consumer.name, api_key_record.name;
```

Neither this latent report nor the target-consumer report below filters tenant
or consumer status. The status columns are diagnostic: an active, unexpired
snapshot key remains a migration-066 blocker even when its owner is suspended.

Before any future crawler platform grant, use the following report instead of
the grant-based query above. Replace both values in `target`; it deliberately
does not depend on a grant already existing:

```sql
WITH target(consumer_id, platform) AS (
  VALUES (
    '00000000-0000-4000-8000-000000000000'::uuid,
    'data_center_saved_records_news'::text
  )
)
SELECT tenant.id AS tenant_id,
       tenant.status AS tenant_status,
       consumer.id AS consumer_id,
       consumer.name AS consumer_name,
       consumer.status AS consumer_status,
       api_key_record.id AS api_key_id,
       api_key_record.name AS api_key_name,
       api_key_record.key_prefix,
       api_key_record.last_four,
       target.platform AS proposed_platform,
       api_key_record.scope_mode,
       api_key_record.expires_at,
       CASE
         WHEN api_key_record.scope_mode = 'legacy_dynamic'
           THEN 'would_inherit_new_grant'
         WHEN EXISTS (
           SELECT 1
             FROM api_key_platform_entitlements entitlement
            WHERE entitlement.api_key_id = api_key_record.id
              AND lower(btrim(normalize(entitlement.platform, NFKC)))
                  = target.platform
         ) THEN 'snapshot_entitled_if_granted'
         ELSE 'snapshot_not_entitled'
       END AS proposed_effect
  FROM target
  JOIN consumers consumer ON consumer.id = target.consumer_id
  JOIN tenants tenant
    ON tenant.id = consumer.tenant_id
  JOIN api_keys api_key_record
    ON api_key_record.consumer_id = consumer.id
 WHERE api_key_record.status = 'active'
   AND api_key_record.expires_at > now()
 ORDER BY api_key_record.name, api_key_record.id;
```

Adding a consumer grant immediately widens every row marked
`would_inherit_new_grant`. Prefer rotating those keys to an explicitly selected
snapshot scope, and explicitly review any `snapshot_entitled_if_granted` row,
before granting the new data product.

## 7. Activation and publication gates

Keep every task paused until this sequence is complete:

1. run the Internal deploy, which applies Hub migration 066 and the four Hub
   indexes, and verify exactly 13 sources are `paused`, exactly
   13 version-1 mappings have no `approved_at`, every source has no connection
   profile yet, and both authorization preflight counts remain zero;
2. configure the shared read-only PostgreSQL connection without changing the
   fixed locators;
3. rerun deploy so it reconciles the 13 source indexes, then use **重新核对** to
   preserve the ready result as rollout evidence;
4. probe all leaves and review exact columns, nullability, types, constraints,
   source-type membership, `record_type` distributions and representative JSON
   shapes;
5. review the fixed published-time and source-catalog classifications;
6. accept the writer/delete/commit-order attestation, then approve only the
   fixed version-1 mappings and activate the selected tasks;
7. run a bounded first import, compare source/canonical counts and rejection
   evidence, then allow scheduled increments;
8. before any Public API grant, rerun the authorization counts and the
   target-consumer key report above, run a strict full `content-v6` rebuild from
   PostgreSQL current truth, switch the content aliases only after that build
   succeeds, and compare the PostgreSQL and Elasticsearch publication gates.

Deploy never accepts the writer/delete/commit-order attestation, activates a
task, schedules a pull, grants a Public capability, or starts an Elasticsearch
full rebuild. Those remain explicit Admin UI decisions. If the persistent
**projector 重启时自动全量重建** setting is still enabled, deploy idempotently
turns it off before building/importing the image and verifies it again before
the projector rollout. The change is logged; deploy does not start, cancel or
wait for a full replay. A strict rebuild must still be started separately by an
operator in Data Center.

Immediately after migration 066, this read-only acceptance query must return
`13, 13, 13, 13, 13` in column order:

```sql
WITH fixed_sources AS (
  SELECT id, status, database_connection_id
    FROM catalog.external_sources
   WHERE source_key ~ '^night-all-saved-records-(automotive|finance|forum|hotspot|local-news|media|news|other|recruitment|research|social|technology|web)$'
)
SELECT count(*) AS source_count,
       count(*) FILTER (WHERE status = 'paused') AS paused_count,
       count(*) FILTER (WHERE database_connection_id IS NULL) AS no_profile_count,
       (
         SELECT count(*)
           FROM catalog.source_mappings mapping
           JOIN fixed_sources source ON source.id = mapping.source_id
          WHERE mapping.version = 1
       ) AS mapping_count,
       (
         SELECT count(*)
           FROM catalog.source_mappings mapping
           JOIN fixed_sources source ON source.id = mapping.source_id
          WHERE mapping.version = 1
            AND mapping.approved_at IS NULL
       ) AS unapproved_count
  FROM fixed_sources;
```

Public delivery needs a separate decision. Existing
`POST /api/v1/data/stored/search` and
`POST /api/v1/data/canonical/search` are the reusable stored-data interfaces;
no Night-All-specific public endpoint is required. Each `source_type` has a
unique platform precisely so an API key may be granted one reviewed class
without receiving all 13. These Public API dataset and platform identifiers
are provider-neutral; `Night-All` remains only an internal source/pipeline
name. Migration 066 creates no grant.

The fixed cleaner marks a row as a publication candidate only when
`record_type IN ('news', 'news.article')` and at least one canonical title or
body is nonempty after trimming. A URL alone is not publishable;
empty-content rows and other observed types—including account checks, feed
responses and operational result records—remain `internal`. The cleaner writes
that decision to
`stable_fields.crawler.publication.eligibility` (camel-case API form:
`stableFields.crawler.publication.eligibility`).

Both public stored search and public canonical search enforce the same rule:
for every `data_center_saved_records_*` platform, only records whose eligibility
is exactly `candidate` may be returned. The predicate is applied in both the
PostgreSQL page/count path and the Elasticsearch `content-v6` path. A mixed
platform query applies it only to the `data_center_saved_records_*` crawler branches;
visibility for all other platforms is unchanged. Admin and other internal
searches do not inherit this public filter.

Candidate is not approval: do not issue a public key for any
`data_center_saved_records_*` platform until the record-type review, the strict
full `content-v6` rebuild and the PostgreSQL/Elasticsearch serving comparison
are complete. During a rollout, an un-cursored request that still encounters a
`content-v5` index falls back to PostgreSQL; a cursor tied to an old v5 PIT is
rejected with `503 search_cursor_unavailable` instead of continuing against an
index without the crawler visibility field. That fallback is a deployment
safety measure, not permission to serve crawler data indefinitely from v5.
Restricted raw/evidence and internal connector/provider identity remain
unavailable through public stored search.

## 8. Pause and recovery

Pause before changing a connection profile, table binding, mapping, writer
semantics or checkpoint. Let in-flight jobs reach their durable boundary before
repair. Resume from the existing leaf checkpoint after correcting a transient
failure; reset only when an explicitly reviewed full alignment is intended.
Pausing or repairing this pipeline does not require restarting Launcher,
changing MX-H2I networking or modifying Domestic/Internal services.
