# MX Insight Hub

MX Insight Hub is the governed data-access layer between callers and private data systems such as Night-All. It turns internal platform capabilities into stable, key-scoped APIs with tenant-scoped identities, consumers, grants, quotas and usage evidence, plus idempotency and an operator console.

The runtime now includes versioned source objects, canonical records/revisions,
transactional projection outbox, external file/PostgreSQL source mappings,
durable pull workers and a customer-safe stored Telegram history API. The
existing search API still dispatches to Night-All. `/shared_dir` watching,
immutable object storage, freshness-aware cache/fallback, production delete/CDC
semantics, BI datasets and governed Text2SQL/Data Agent tools remain later
delivery gates rather than implied capabilities.

It is an independently deployed product module and a sibling of `mx-launcher`, not a Night-All fork and not an embedded Launcher database/service:

- **Night-All** owns providers, collection, normalization, source evidence, and upstream credentials.
- **MX Insight Hub** owns tenants, consumers, API keys, grants, limits, request state, and customer usage.
- **MX Launcher / MX-H2I** owns deployment orchestration, private/public connectivity, DNS, TLS edge, and the operator entrypoint.

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

## Quick start

```bash
cd /Users/qpjoy/workspace/qpjoy/de/de-llaaddddeerr/electron-dock/mx-insight-hub
bash scripts/manage.sh up
```

The Admin UI and combined local API listen on `http://127.0.0.1:18180`. The first run creates a local tenant, consumer, `xiaohongshu`/`weibo` grants, and a one-time development API key at `.runtime/local-api-key` with mode `0600`.

Run the non-billable control-plane smoke:

```bash
bash scripts/manage.sh smoke
```

Run one real Night-All-backed request only when local Night-All is available on `18141` and real upstream usage is acceptable:

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
GET  /api/v1/requests/:requestId
GET  /api/v1/usage
```

Every costly `POST` requires `Idempotency-Key`. Public callers can choose only documented platform and query fields. Night-All `businessId`, provider, endpoint, credentials, raw response switches, and availability policy are server-owned and never accepted as public parameters.

The Telegram endpoints require the consumer's explicit `telegram` grant and
serve fixed, currently shared Hub datasets with opaque keyset cursors. They do
not apply a tenant row filter; all granted consumers read the same canonical
Telegram corpus while authorization, quota and usage remain consumer/tenant
scoped. Their complete field,
pagination, privacy and current metering semantics are in the [Public API v1
contract](docs/contracts/public-api-v1.md). Production source activation starts
with the [Telegram monitor ingestion
runbook](docs/operations/telegram-monitor-ingestion.md); the registered sources
remain paused until the real external schema and watermark contract are
verified.

Start with [docs/README.md](docs/README.md) for architecture, security, operations, and roadmap decisions.

The detailed data-platform decisions start at [data-platform storage and serving](docs/architecture/data-platform-storage-and-serving.md), [ingestion/cache/fallback](docs/architecture/ingestion-cache-and-fallback.md), and the [`/shared_dir` ingestion runbook](docs/operations/shared-directory-ingestion.md).
