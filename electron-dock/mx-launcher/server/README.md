# MX Launcher Server

MX Launcher Server is the platform backend for the MX Launcher solution. The
same codebase can run different module profiles per site: Internal starts most
or all control-plane modules, Domestic starts edge/relay/proxy/cache modules,
and Oversea starts only access/site-agent modules.

This directory is the server/backend part of `electron-dock/mx-launcher`.
It starts with a minimal API skeleton and grows into the control plane for:

- Domestic lightweight edge/proxy/cache/runner services;
- Internal full control plane with PostgreSQL, Elastic, K8s, IAM, config,
  release, artifact, audit, and observability;
- Oversea access/site-agent services next to `hysteria2-mihomo-stack`;
- H endpoints using MX Launcher desktop and signed config snapshots;
- shared platform capabilities such as IAM, audit, config, release, rollout,
  artifact, runner, test-center, and observability.

The server now starts as a NestJS modular monolith. It is intentionally not a
fleet of microservices yet: modules are split by domain, while runtime remains
one stateless HTTP API that is easy to run in Docker and later in K8s.

Do not copy the whole `electron-server` implementation into this project. The
preferred path is to extract shared platform modules or call existing
compatibility APIs until the new boundaries are stable.

## Platform Kernel V0

The first coded kernel proves the shared platform contracts without real WG/TUN.
It can run either with the in-memory store for fast local checks or with
PostgreSQL for deployable shadow checks:

- AppCenter registry with built-in `h2o`.
- Permission registry and audit event recording.
- Launcher Network guest snapshot with `100.91.0.0/16` policy.
- Release update policy split between platform-critical and app-managed
  components.
- Test Center run, step, and gate verdict.
- User Center shadow contract for token introspection, principal context, RBAC
  scopes, and service accounts.
- SDK Gateway manifest that exposes the stable integration surface for peer
  systems while internal modules keep their own APIs.
- Split DNS policy with Internal CoreDNS routing, system/proxy fallback, SDK
  entrypoints, and optional Internal reverse proxy routes.

Checks:

```bash
bash ../scripts/manage.sh server-typecheck
bash ../scripts/manage.sh smoke platform-kernel
```

For local HTTP checks:

```bash
HOST=127.0.0.1 pnpm start
```

Then call `/healthz`, `/internal/v1/app-center/apps`,
`/internal/v1/sdk/gateway/manifest`,
`/internal/v1/sdk/identity/introspect`, `/internal/v1/dns/policies`,
`/internal/v1/sdk/dns/evaluate`, or `/internal/v1/platform-kernel/smoke`.

## Shadow Docker Compose

The first deployable backend target is a local shadow environment:

```bash
bash ../scripts/manage.sh shadow build
bash ../scripts/manage.sh shadow up
bash ../scripts/manage.sh shadow smoke
bash ../scripts/manage.sh shadow logs
bash ../scripts/manage.sh shadow down
```

`server/docker-compose.shadow.yml` starts:

- `postgres`: a local PostgreSQL 16 instance for the future durable store.
- `internal`: the NestJS Internal API image, exposed on `127.0.0.1:18090`.

The current smoke checks `/healthz`, `/internal/v1/app-center/apps`,
`/internal/v1/sdk/gateway/manifest`, `/internal/v1/sdk/identity/introspect`,
`/internal/v1/dns/policies`, `/internal/v1/sdk/dns/evaluate`, and
`/internal/v1/platform-kernel/smoke`.

## Data and Migrations

`INTERNAL_STORE_DRIVER` selects the storage backend:

- `memory`: fast local development and script smoke checks.
- `postgres`: TypeORM-backed durable store. `DATABASE_URL` is required.

When `postgres` is selected, the Nest provider initializes TypeORM and runs
pending migrations during service startup. Migration files live under
`src/db/migrations/`; the first migration creates:

- `mx_schema_migrations`: TypeORM's migration history table.
- `mx_platform_records`: a compatibility-first platform record table.
- `mx_overlay_ip_seq`, `mx_guest_ip_seq`, `mx_user_ip_seq`: persistent IP lease
  counters.

`mx_platform_records` stores `kind`, `id`, `environment`, `site_id`, and `data`
as JSONB. This preserves the current API object shape while we are still
settling the platform contracts. Later migrations can promote hot fields into
dedicated columns or normalized tables without breaking old records because the
original JSON payload remains available.

K8s translation:

- `internal` becomes a Deployment using the same image.
- `postgres` becomes either a managed PostgreSQL service or a StatefulSet with
  a PVC for shadow/dev only.
- Compose environment variables become ConfigMaps for non-secret settings and
  Secrets for credentials such as `DATABASE_URL`.
- Docker `HEALTHCHECK` maps to liveness/readiness probes. Use `/healthz` for
  process health and `/readyz` when downstream dependencies are required.
- `MX_SITE_ROLE` and `MX_ENABLED_MODULES` select the same image's Internal,
  Domestic, or Oversea profile without changing code.

The first K8s script target is `internal-shadow`:

```bash
bash ../scripts/manage.sh k8s plan internal-shadow
bash ../scripts/manage.sh k8s explain internal-shadow
bash ../scripts/manage.sh k8s render internal-shadow
bash ../scripts/manage.sh k8s apply internal-shadow
bash ../scripts/manage.sh k8s smoke internal-shadow
bash ../scripts/manage.sh k8s down internal-shadow
```

K8s uses a migration Job before rolling the API Deployment. The API still keeps
startup migration as a safety net for shadow/dev, but deployment orchestration
should treat migration as its own observable step.

## Documents

- `../docs/06-server-shadow-control-plane.md` - shadow deployment design for a parallel
  `mx-launcher/server` backend, with site profiles for Domestic, Internal,
  Oversea, WireGuard, anonymous enrollment, audit, ELK, config center, release,
  and rollout modules.
- `../docs/07-end-to-end-delivery-blueprint.md` - complete D/I/O/H delivery
  blueprint: server deployment, Internal enrollment with `@qpjoy/tunnel-cli`,
  Oversea stack management, admin console, migration, client packaging, and
  sales USB kit.
- `../docs/09-observable-automation-test-platform.md` - test-center design for
  observable automation, online E2E, synthetic probes, evidence, and release
  gates across H/D/I/O.
- `../docs/10-mx-3ks-appcenter-launcher-network-h2o-architecture.md` - MX-3ks
  platform boundary, AppCenter protocol, Launcher Network, H2O, Domestic
  minimization, Jenkins/release integration, and SDK gateway design.
- `../docs/11-k8s-deployment-runbook.md` - K8s deployment order, Docker Compose
  concept mapping, migration Job, smoke, and Admin action model.
- `../docs/12-local-ops-manage-guide.md` - beginner-friendly local operations
  guide for `scripts/manage.sh`, Compose shadow, and K8s shadow.

## Delivery Goal

Operators should eventually be able to copy only `electron-dock/mx-launcher` to Domestic,
Internal, or Oversea and run the right profile. Internal runs the full platform,
Domestic runs lightweight edge services, and Oversea runs access/site-agent
services. The same operational actions must be available through both
`scripts/manage.sh` and the admin console.
