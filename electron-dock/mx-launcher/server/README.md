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

## Platform Kernel V1 Shadow

The first coded kernel proves the shared platform contracts without real WG/TUN.
It can run either with the in-memory store for fast local checks or with
PostgreSQL for deployable shadow checks:

- AppCenter registry with built-in `h2o`.
- Permission registry and audit event recording.
- Launcher Network product snapshot with configured user/anonymous lease ranges.
- Release update policy split between platform-critical and app-managed
  components.
- Test Center run, step, and gate verdict.
- User Center V1 shadow records for tenants, orgs, roles, users, service
  accounts, hashed access tokens, token introspection, principal context, and
  RBAC scopes.
- SDK Gateway manifest that exposes the stable integration surface for peer
  systems while internal modules keep their own APIs, plus route access
  evaluation.
- Config Center signed policy snapshots that aggregate AppCenter permissions,
  Launcher Network, DNS, SDK Gateway, release policy, and observability sinks.
- Split DNS policy with Internal CoreDNS routing, signed zone snapshots,
  system/proxy fallback, SDK entrypoints, and optional Internal reverse proxy
  routes.

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
`/internal/v1/user-center/bootstrap`, `/internal/v1/user-center/tokens/issue`,
`/internal/v1/sdk/gateway/manifest`,
`/internal/v1/sdk/identity/introspect`,
`/internal/v1/sdk/gateway/access/evaluate`,
`/internal/v1/sdk/config/snapshot`, `/internal/v1/release-management/plans`,
`/internal/v1/site-slots/plans`, `/internal/v1/site-slots/executions`,
`/internal/v1/site-slots/runner-sessions`,
`/internal/v1/site-slots/worker-jobs`,
`/internal/v1/site-slots/worker-reports`,
`/internal/v1/dns/policies`,
`/internal/v1/sdk/dns/zone`, `/internal/v1/sdk/dns/coredns-configmap`,
`/internal/v1/dns/coredns/configmap/apply`,
`/internal/v1/sdk/dns/evaluate`, or `/internal/v1/platform-kernel/smoke`.

`POST /internal/v1/config-center/snapshots/effective` and
`POST /internal/v1/sdk/config/snapshot` issue the V1 signed policy snapshot.
This is separate from the lightweight enrollment config snapshot: enrollment
bootstraps the install, while Config Center aggregates platform policy after
identity, DNS, AppCenter, release, and Launcher Network decisions are known.
`POST /internal/v1/dns/zones/build` and `POST /internal/v1/sdk/dns/zone`
build a signed DNS zone snapshot from the split DNS policy. The snapshot
contains CoreDNS server blocks, records, fallback order, reverse proxy routes,
and a digest. `POST /internal/v1/dns/coredns/configmap/sync` and
`POST /internal/v1/sdk/dns/coredns-configmap` render the `mx-dns/coredns`
ConfigMap manifest and record a dry-run or shadow-apply sync result without
mutating the Kubernetes API. `POST /internal/v1/dns/coredns/configmap/apply`
is the Internal/Admin mutation path: it requires `confirmApply=true`, checks
`COREDNS_K8S_APPLY_ENABLED` and the allowed target namespace/name, then updates
the pre-created `mx-dns/coredns` ConfigMap with the pod ServiceAccount. The SDK
Gateway intentionally exposes render/sync, not K8s mutation.
`POST /internal/v1/release-management/plans` creates the V1 Internal/Admin
release management view. It evaluates Launcher and App update policy, creates
or links an E2E test run, evaluates the release gate, and returns whether the
release is ready for a shadow/canary rollout. It is a management plan, not the
rollout executor.
`POST /internal/v1/site-slots/plans` creates the V1 Internal-owned Domestic or
Oversea slot plan. It turns a host into a pluggable execution slot with remote
preflight checks, host-service requirements, Docker stacks, network bootstrap
mode, and deployment phases. `POST /internal/v1/site-slots/plans/:planId/preflight`
and `POST /internal/v1/site-slots/plans/:planId/apply` create the V1 execution
manifest. Preflight emits check commands; apply emits deployment commands and
requires `confirmApply=true` before it becomes ready. The current boundary is
manifest-only: no SSH/SCP/root mutation is performed by this API.
`POST /internal/v1/site-slots/executions/:runId/runner-sessions` creates a
Runner V1.1 session. `simulate` mode records every step as simulated evidence.
`remote-ssh` mode is disabled by default and requires both
`SITE_SLOT_RUNNER_REMOTE_EXECUTION_ENABLED=true` and
`confirmRemoteExecution=true`; otherwise it is blocked before any remote work is
queued. `awx-shadow` mode records a queued provider session without opening SSH
or calling AWX; it lets Admin and CLI map Worker Contract V1 steps to AWX
inventory, credential, job template, extra vars, and task-event evidence before
real launch. `site-slot.worker-run.awx-launch` is the gated real provider action:
Internal calls AWX, waits for the job when requested, pulls job events, maps them
back into the existing worker report shape, and leaves `remote-ssh` as the
fallback execution path.
`GET /internal/v1/config-center/awx-providers`,
`GET /internal/v1/config-center/awx-providers/:providerId`, and
`POST /internal/v1/config-center/awx-providers` manage the Config Center AWX
provider registry. The registry stores Internal-owned endpoint metadata,
organization/project names, inventory/credential/job-template naming prefixes,
slot kind scope, status, TLS policy, and request timeout; secrets stay outside
this record and are referenced by later credential/Vault integration.
`POST /internal/v1/config-center/awx-providers/:providerId/check` performs a
readonly AWX API gate against `/api/v2/ping/`, organization, project, inventory,
and job template list endpoints. A bearer token may be supplied for that single
request, but it is never persisted in Config Center.
`site-slot.worker-run.awx-launch` additionally requires
`AWX_API_LAUNCH_ENABLED=true`, `confirmAwxLaunch=true`, an active provider, and a
bearer token supplied either as the action body `awxToken` or the server process
environment `AWX_API_TOKEN`. Tokens are not stored in Config Center or worker
reports.
`POST /internal/v1/admin/oversea/:siteId/shadow-setup` is the current one-shot
Oversea setup path for Admin. It upserts the Internal SSH Profile, issues the
Internal mihomo/access-account record, creates a fresh site-slot plan, preflight,
apply execution, `awx-shadow` runner session, AWX worker job, and worker report
without calling AWX launch, opening SSH, or mutating Oversea. If an AWX provider
is configured, the endpoint also runs the readonly provider check and includes
that result in the returned setup evidence. Use the resulting ready AWX worker job
with the `Launch AWX Job` Admin action, or CLI
`SITE_SLOT_CONFIRM_AWX_LAUNCH=1 bash scripts/manage.sh ops site-slot worker-run <job-id> awx-launch`,
when the slot is ready for real AWX execution.
`POST /internal/v1/site-slots/runner-sessions/:sessionId/worker-jobs` creates
the Worker Contract V1 job package consumed by a runner worker or site-agent.
It carries approval, change-window, retry, rollback, step timeout, redaction,
and stop-on-failure policy. `POST /internal/v1/site-slots/worker-jobs/:jobId/reports`
records worker output including step status, exit code, stdout/stderr, attempt,
and timestamps. Reports drive the Worker State Machine V1: `running` keeps the
job/session open, `passed` advances both to passed, `failed` preserves evidence
and creates a rollback plan, and `blocked` holds the change for manual review.
Rollback Contract V1 then turns that failed report into
`POST /internal/v1/site-slots/worker-reports/:reportId/rollback-executions`,
and records recovery evidence through
`POST /internal/v1/site-slots/rollback-executions/:rollbackExecutionId/reports`.
Admin Management API V1 exposes those records as operator views:
`GET /internal/v1/admin/dashboard` returns overview, release plans, and recent
site-slot pipeline summaries; `GET /internal/v1/admin/site-slots/pipelines`
lists pipeline timelines; `GET /internal/v1/admin/site-slots/pipelines/:planId`
returns one full plan/execution/runner/worker/rollback chain.
`GET /internal/v1/admin/actions` returns the shadow RBAC action policy for the
current principal, including required scopes, risk, gate, confirmation fields,
and request templates. Dashboard and pipeline responses also include action
hints so the desktop Admin UI can show which preflight, apply, runner, worker,
rollback, DNS, release, or RBAC actions are visible without bypassing the
existing execution APIs.
`POST /internal/v1/admin/actions/execute` is the V1 execution bridge for those
UI actions. It validates the selected action, required scopes, and confirmation
fields, then dispatches to the existing site-slot execution, runner session,
worker job, provider-shadow report, or rollback execution store contract.

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
`/internal/v1/user-center/bootstrap`, `/internal/v1/user-center/tokens/issue`,
`/internal/v1/sdk/gateway/manifest`, `/internal/v1/sdk/identity/introspect`,
`/internal/v1/sdk/gateway/access/evaluate`, `/internal/v1/sdk/config/snapshot`,
`/internal/v1/release-management/plans`,
`/internal/v1/site-slots/plans`, `/internal/v1/site-slots/executions`,
`/internal/v1/site-slots/runner-sessions`,
`/internal/v1/site-slots/worker-jobs`,
`/internal/v1/site-slots/worker-reports`,
`/internal/v1/dns/policies`, `/internal/v1/sdk/dns/zone`,
`/internal/v1/sdk/dns/coredns-configmap`,
`/internal/v1/dns/coredns/configmap/apply`,
`/internal/v1/sdk/dns/evaluate`, and
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
