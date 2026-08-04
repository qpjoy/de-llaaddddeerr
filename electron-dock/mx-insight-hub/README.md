# MX Insight Hub

MX Insight Hub is the governed data-access layer between callers and private data systems such as Night-All. It turns internal platform capabilities into stable, key-scoped APIs with tenant isolation, explicit platform grants, quotas, idempotency, usage evidence, and an operator console.

The target data platform adds versioned ingestion, canonical customer-safe data, `/shared_dir` file intake, PostgreSQL/PostGIS serving, immutable raw objects, rebuildable Elasticsearch search, freshness-aware cache/fallback, BI datasets and governed Data Agent tools. Those data-plane capabilities are designed but are not yet implemented by the current MVP; the existing API still dispatches search to Night-All.

It is an independently deployed product module and a sibling of `mx-launcher`, not a Night-All fork and not an embedded Launcher database/service:

- **Night-All** owns providers, collection, normalization, source evidence, and upstream credentials.
- **MX Insight Hub** owns tenants, consumers, API keys, grants, limits, request state, and customer usage.
- **MX Launcher / MX-H2I** owns deployment orchestration, private/public connectivity, DNS, TLS edge, and the operator entrypoint.

Launcher is the target authority for human login and organization identity; Hub keeps its own tenant membership, consumer applications, API keys, product grants, quotas, usage and billing semantics. They will federate through a verified `issuer + subject + audience + organization` identity rather than sharing a user table. The current release implements lifecycle delegation and an offline-safe ops summary only; Launcher SSO/JWKS federation is intentionally documented as future work.

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

`down` preserves PostgreSQL, PVCs, Secrets, and the namespace. Removing data is deliberately not part of the routine lifecycle command.

## Public API v1

```text
GET  /api/v1/data/capabilities
POST /api/v1/data/search
GET  /api/v1/requests/:requestId
GET  /api/v1/usage
```

Every costly `POST` requires `Idempotency-Key`. Public callers can choose only documented platform and query fields. Night-All `businessId`, provider, endpoint, credentials, raw response switches, and availability policy are server-owned and never accepted as public parameters.

Start with [docs/README.md](docs/README.md) for architecture, security, operations, and roadmap decisions.

The detailed data-platform decisions start at [data-platform storage and serving](docs/architecture/data-platform-storage-and-serving.md), [ingestion/cache/fallback](docs/architecture/ingestion-cache-and-fallback.md), and the [`/shared_dir` ingestion runbook](docs/operations/shared-directory-ingestion.md).
