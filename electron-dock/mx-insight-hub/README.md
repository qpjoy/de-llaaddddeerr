# MX Insight Hub

MX Insight Hub is an independently deployed data control plane and data center.
It turns Hub-managed provider connectors and stored datasets into stable,
key-scoped APIs with tenant-scoped identities, consumers, grants, quotas,
request/usage evidence, idempotency, raw/canonical storage and an operator
console. Night-All is a transitional compatibility dependency for explicitly
unmigrated request shapes, not the Hub's long-term control plane or primary
provider layer.

The runtime now includes Admin-managed PostgreSQL and file sources, versioned
source objects/mappings, canonical records/revisions/tombstones, transactional
projection outbox, direct file import, durable pull workers and customer-safe
Telegram history/full-text/entity APIs. Migrated Xiaohongshu search/detail and
narrow single-user crawl/user-info shapes are served by Hub-owned TikHub workflows,
and ecommerce product search is served by the Hub-owned provider-neutral JustOne
gateway. Explicitly unmigrated platforms and request shapes may still traverse the
Night-All compatibility path while each operation is retired from that path after
contract-parity and rollback gates pass. Requests carrying historical `mxnc1`
continuations, batch/channel/non-post and other unsupported Xiaohongshu shapes
remain compatibility-only; repository code alone does not prove a particular
rollout gate is active. Telegram stored search is locally
served in the same `night-all.data-search.v1` envelope. `/shared_dir` watching, immutable
object/cloud adapters, a generic CDC connector, freshness-aware live fallback,
BI datasets and governed Text2SQL/Data Agent tools remain later delivery gates
rather than implied capabilities.

The Internal Admin console now also contains one versioned [Agent Market
advanced-search dry-run](docs/architecture/agent-market-advanced-search.md)
example. It exposes editable stage prompts/parameters, Zod contracts, return
examples, trace/evaluation and a recoverable stage trash while reading the
current PG/ES search plane without writing business data. It is a learning and
shadow-experiment surface, not a replacement for public search or the
production analysis pipeline.

It is an independently deployed product module and a sibling of `mx-launcher`, not a Night-All fork and not an embedded Launcher database/service:

- **Night-All** temporarily owns only its explicitly legacy/unmigrated connector
  behavior, source evidence and credentials until each operation is cut over.
- **MX Insight Hub** owns the product control plane and data center: tenants,
  consumers, API keys, grants, limits, request state, customer usage/billing,
  direct TikHub/JustOne provider gateways, raw observations and canonical/search
  projections.
- **MX Launcher / MX-H2I** owns deployment orchestration, private/public connectivity, DNS, TLS edge, and the operator entrypoint.

Compatibility acquisition preserves upstream business content, tags, engagement,
author and media fields without Hub desensitization, filtering or field-level
truncation. Only governed pagination controls may be rewritten. Historical
Night-All lineage retains complete parsed JSON and legacy raw strings; Hub-native
provider calls additionally archive exact bounded response bytes in restricted
storage. API keys, Authorization/Cookie material and other request secrets are
kept out of business responses, ordinary UI and logs.

## Current authorization and delivery model

The provider layer and the data-product layer are deliberately separate. A
provider connector such as TikHub or JustOne owns upstream request/response
adaptation, credentials, health, procurement evidence and technical protection.
A data product such as the Xiaohongshu note scroll composes stable Hub operations
over those connectors and/or stored Hub data. Granting a product does not expose
provider credentials or make its provider selectable by the caller; changing a
provider does not change the product's public meter or response contract.

A newly issued snapshot API key starts with **no access**. An operator grants a
deliberate intersection of three dimensions:

1. **data domain/source scope**, for example `xiaohongshu` or `ecommerce`;
2. **business operation**, for example `social.posts.resolve` or
   `ecommerce.products.search`; and
3. **compatible interface contract**, when a provider-shaped surface is required,
   for example `compat.xiaohongshu.app_v2`.

The explicit `legacy_all` issuance preset exists only for controlled migration,
and pre-migration `legacy_dynamic` keys remain a rotation target. A data product is
a reviewed combination of these permissions and workflows, not a fourth upstream
platform grant. Provider credentials and connector activation remain Admin-managed.

Compatibility delivery preserves upstream business fields and values as received:
Hub does not desensitize, filter or truncate the content. The 15-page acquisition
boundary and opaque continuation are technical controls, not content filtering.
Credentials, tokens, cookies and other secrets remain isolated from public
responses, ordinary UI, logs and search projections. Derived data products may
publish a separately versioned projection, but must not silently rewrite a
compatibility response.

Downstream billing counts successful logical Hub service deliveries, not the
number of internal provider calls. A committed delivery captures at most one
customer charge; an idempotent replay does not create another. Once a request is
explicitly customer-funded/billed, Hub monthly procurement or subsidy thresholds
are observability warnings rather than an availability gate. Provider rate limits,
concurrency, circuit breakers, contract/readiness checks, pagination limits and
unknown-outcome/idempotency protections still apply.

Launcher is the authority for human login and organization identity; Hub keeps
its own tenant membership, consumer applications, API keys, product grants,
quotas, usage and billing semantics. The current release can introspect
Launcher-issued opaque user tokens and bind the verified `issuer + subject +
audience` principal to Hub-local memberships; it does not share a user table or
claim that gateway admission is product authorization.

Hub is genuinely multi-tenant:

- a Hub tenant is an independent product/authorization namespace;
- each consumer belongs to exactly one tenant, and its API keys, grants,
  policies and usage follow that consumer;
- one Launcher person may hold separate roles in multiple tenants; permissions
  are checked from the role in the target tenant, not from a cross-tenant union;
- creating tenants is platform-admin-only, while an owner may rename and manage
  only a tenant where that membership is `owner`;
- the Admin Token is an unscoped platform-wide break-glass credential. It can
  create/list/rename all tenants and is not the model for a normal tenant user.

This multi-tenant boundary currently protects control-plane ownership and
accounting; it does not imply row-level partitioning of every canonical
dataset. In particular, Telegram canonical records have no `tenant_id`: every
consumer with the `telegram` grant can read the same complete chats/messages
datasets, subject to that consumer's own quota and usage ledger. A future
tenant-specific Telegram subset requires an explicit dataset/row-scope model
and migration; it must not be inferred from membership alone.

The Admin data-source plane also includes a separate fixed Telegram SQLite
read-API pipeline. It stores the fallback snapshot in
`telegram.sqlite.chats.v1` / `telegram.sqlite.messages.v1`, keeps every HTTP row
as raw evidence, and uses an initial/manual full alignment followed by
append-oriented overlap polling plus a bounded previous-day window because the
upstream page API does not expose an exact change cursor. It never schedules an automatic historical full scan
and does not silently merge into the PostgreSQL-backed public Telegram datasets. Rows
carrying `deleted_at` remain in Hub PostgreSQL with their raw payload and
revision history; deletion only retires them from the rebuildable public
current-state search projection.

## Quick start

```bash
cd /Users/qpjoy/workspace/qpjoy/de/de-llaaddddeerr/electron-dock/mx-insight-hub
bash scripts/manage.sh up
```

The Admin UI and combined local API listen on `http://127.0.0.1:18180`. The first
run creates a local tenant, consumer and a one-time bootstrap API key at
`.runtime/local-api-key` with mode `0600`. This development bootstrap is an
explicitly provisioned exception; ordinary Admin UI/API key issuance defaults to
an empty platform/capability snapshot.

Run the non-billable control-plane smoke:

```bash
bash scripts/manage.sh smoke
```

Run one real legacy-compatibility request only when local Night-All is available
on `18141` and real upstream usage is acceptable:

```bash
bash scripts/manage.sh data-smoke
```

## Lifecycle

```bash
# Independent local lifecycle
bash scripts/manage.sh local up
bash scripts/manage.sh local status
bash scripts/manage.sh local logs
bash scripts/manage.sh local down

# Optional local Elasticsearch/Kibana; independent from Hub startup
bash scripts/manage.sh search plan
bash scripts/manage.sh search up
bash scripts/manage.sh search status
bash scripts/manage.sh search down

# Independent internal K8s lifecycle
bash scripts/manage.sh ops internal-production deploy
bash scripts/manage.sh ops internal-production status
bash scripts/manage.sh ops internal-production smoke
bash scripts/manage.sh ops internal-production down

# Delegated from mx-launcher
cd ../mx-launcher
bash scripts/manage.sh ops insight-hub deploy

# Optional joint deployment; the existing Launcher path remains unchanged by default
MX_INSIGHT_HUB_DEPLOY=1 bash scripts/manage.sh ops internal-production deploy
```

`down` scales Hub workloads to zero and preserves the namespace/Secrets. The
authoritative Hub database, Elasticsearch and Redis live in the shared
`mx-common` data plane and are not stopped or deleted by Hub lifecycle commands.
Removing a retired legacy Hub-local PostgreSQL requires the separate,
confirmation-gated `decommission-local-postgres` action.

The Internal `deploy` command is self-contained for the current single-node
kubeadm host: it reconciles `mx-common`, provisions the Hub's dedicated database
and role inside shared PostgreSQL, builds/imports the Hub image, runs migrations,
rolls out separate public/Admin/projector/ingest workloads, prints diagnostics
on timeout, and removes temporary build/import artifacts. Re-running the same
command after an interrupted deployment is supported.

## Public API v1

```text
GET  /api/v1/data/capabilities
POST /api/v1/data/search
GET  /api/v1/data/telegram/chats
GET  /api/v1/data/telegram/messages
POST /api/v1/data/telegram/search
GET  /api/v1/data/telegram/entities/search
GET  /api/v1/requests/:requestId
GET  /api/v1/usage
```

Every costly `POST` requires `Idempotency-Key`. Public callers can choose only
documented platform and query fields. Provider identity, endpoint, credentials,
raw-response switches and availability policy are server-owned on both direct and
legacy compatibility connectors. A compatibility `businessId`, when accepted, is
derived from and must match the authenticated consumer.

The Telegram endpoints require the consumer's explicit `telegram` grant and
serve fixed, currently shared Hub datasets with opaque keyset cursors. They do
not apply a tenant row filter; all granted consumers read the same canonical
Telegram corpus while authorization, quota and usage remain consumer/tenant
scoped. Their complete field,
pagination, privacy and current metering semantics are in the [Public API v1
contract](docs/contracts/public-api-v1.md). Production source registration and activation starts
with the [Telegram monitor ingestion
runbook](docs/operations/telegram-monitor-ingestion.md). PostgreSQL connection
fields are managed directly on each source by the Admin Token; they are stored
in the Hub catalog and can change without a deployment. Catalog/database dumps
therefore contain sensitive credentials and require restricted access. The
Admin-token TG task now has an explicit, repeatable **prepare source** action
that installs and verifies the missing source-side watermark triggers,
hard-delete guards and cursor indexes using one-request DDL credentials; normal
ingestion and deploys remain read-only. The task stays paused until preparation,
schema probing and writer attestation pass. `message_at` and `collected_at`
remain invalid substitutes for the unified source watermark.

Start with [docs/README.md](docs/README.md) for architecture, security, operations, and roadmap decisions.

The SQLite source setup and its explicit append-only/manual-alignment semantics are
documented in the [Telegram SQLite read-API ingestion
runbook](docs/operations/telegram-sqlite-api-ingestion.md).

The detailed data-platform decisions start at [data-platform storage and serving](docs/architecture/data-platform-storage-and-serving.md), [ingestion/cache/fallback](docs/architecture/ingestion-cache-and-fallback.md), and the [`/shared_dir` ingestion runbook](docs/operations/shared-directory-ingestion.md).
