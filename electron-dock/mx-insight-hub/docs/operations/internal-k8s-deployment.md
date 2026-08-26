# Internal Kubernetes deployment

## Layout

The `mx-insight-hub` namespace contains only Hub workloads and their runtime
configuration:

- schema migration Job;
- one-replica public API Deployment/ClusterIP Service on `18150` (the current
  host-network profile cannot place two pods on the same node/port);
- one-replica Admin/API/UI Deployment/ClusterIP Service on `18151`;
- independent projector and ingest worker Deployments;
- ServiceAccount and ingress NetworkPolicies.

PostgreSQL, Elasticsearch and Redis are not Hub-local StatefulSets. They live in
the shared `mx-common` data plane. `mx-common provision mx-insight-hub` creates
and retains a dedicated `mx_insight_hub` database and product role in the shared
PostgreSQL instance; sharing an instance does not mean sharing another product's
database or credentials. Elasticsearch/Redis are accelerators/queue services
owned by the same shared plane.

Elasticsearch endpoint resolution is runtime-scoped. A non-empty
`MX_COMMON_ELASTICSEARCH_URL` is always authoritative, including external/TLS
clusters. If it is missing or empty inside Kubernetes, the Hub uses the owned
Service DNS `mx-common-elasticsearch.mx-common.svc.cluster.local:9200`; DNS keeps
resolving the current Service endpoint if Elasticsearch becomes healthy after
the Hub was deployed. This fallback is not enabled for Compose or manual Node
runtimes, where the endpoint must remain explicit. Physical endpoint values are
never returned by the Admin or public APIs.

The current profile still uses local images with `imagePullPolicy: Never`, so
`scripts/manage.sh` requires one Kubernetes node, builds with Docker and imports
the Hub image into `k8s.io` containerd. Move to a signed registry and reviewed
multi-node storage/networking before adding nodes.

## Secret preparation

Create `.env.internal` with mode `0600`:

```bash
MX_INSIGHT_ADMIN_TOKEN=<long-random-token>
MX_INSIGHT_API_KEY_PEPPER=<long-random-pepper>
NIGHT_ALL_BASE_URL=http://192.168.1.2:13141
NIGHT_ALL_SERVICE_TOKEN=<night-all-workload-token-when-supported>

# Optional: mx-common otherwise generates and retains the Hub database password.
MX_INSIGHT_POSTGRES_PASSWORD=<explicit-url-safe-password-if-pinning-is-required>

# Legacy source compatibility only. New source credentials are saved directly
# on the data source through the Admin-token-only Hub console/API.
MX_INSIGHT_TG_MONITOR_DATABASE_URL=<night-all-readonly-postgres-dsn>
```

Generate independent values (for example, `openssl rand -hex 32`). Do not reuse
the Admin Token as an API key, database password or source credential. The
deploy script renders a ConfigMap and Secrets with `kubectl create
--dry-run=client | kubectl apply`; values are not written into manifests or the
Hub source catalog. New PostgreSQL source coordinates and passwords are instead
written to `catalog.external_sources.connection` by the Admin Token and take
effect without a deployment. This intentional plaintext storage makes the Hub
database, WAL/logical backups and Admin source responses secret-bearing; restrict
database/backup access and never print connection objects in deploy logs.

The Hub database DSN is returned by `mx-common provision` and stored in the Hub
runtime Secret. Repeated deploys reuse the credential. Source management is
available only to the Admin Token; Launcher login sessions and public API keys
cannot create, inspect, test or change source connections. Pull sessions are
still forced read-only. The optional legacy Telegram DSN remains a Secret for
old `dsnEnv` source records only.

The explicit Telegram **prepare source** action is the only external-DDL
exception. It runs in the Admin workload (which has the Internal host-network
path needed by a saved `127.0.0.1` source), only while the fixed pipeline is
paused/drained, and may receive a one-request source-owner credential that is
not stored in a ConfigMap, Secret or catalog row. The ordinary migration Job
has only the Hub `DATABASE_URL`; it never connects to or migrates `night_all`.
Thus an unavailable external source cannot make a routine Hub deploy fail.

## Independent deploy

```bash
bash scripts/manage.sh ops internal-production deploy
```

Order:

1. acquire the deploy lock and validate the single-node target;
2. reconcile `mx-common` and provision the Hub database/role (database failure
   is fatal; optional search degradation is not unless
   `MX_INSIGHT_REQUIRE_SEARCH=1`);
3. discover the optional Launcher introspection endpoint;
4. build/import the Hub image;
5. apply namespace, ServiceAccount, ConfigMap and Secrets;
6. run the migration Job against shared PostgreSQL;
7. roll out public, Admin, projector and ingest workloads, apply NetworkPolicy,
   and run smoke checks;
8. remove scoped temporary build/import artifacts.

Only the Admin Pod receives the read-only `/shared_dir` hostPath. The current
Internal host owns that directory with numeric group `10` (`wheel`), so the Pod
adds GID 10 and does not chmod/chown operator files. The current node runtime
does not support `supplementalGroupsPolicy: Strict`; enable it only after the
runtime is upgraded and verified. Confirm the host group before moving this
manifest to another node. Public, projector and ingest workloads receive
neither the mount nor the supplemental group.

The command is idempotent after an interrupted deployment. A migration Job is
recreated; data and credentials remain in `mx-common`. The Hub deploy neither
recreates nor deletes shared PVCs. Tagged containerd runtime/release images,
Hub Secrets and shared data-plane assets are retained for runtime or rollback.
If shared search was unhealthy during deployment, the projector is deliberately
scaled to zero even though API/Admin Pods can later discover the recovered
Service. After a successful Admin reindex, verify or restore the projector
replica so subsequent outbox events continue to project.

### Province-opinion serving indexes

Routine deploy reconciles the two curated province-feed indexes and the two
all-ingested region-feed indexes after the transactional migration Job and
before API rollout. They are kept out of migrations because they scan populated
Hub tables and use `CREATE INDEX CONCURRENTLY`. For an independently managed
environment, run the same idempotent online operation with the Hub database URL
(not the Night-All source URL):

```bash
cd electron-dock/mx-insight-hub
DATABASE_URL='<Hub PostgreSQL URL>' npm run ops:province-opinion-indexes
```

Do not wrap the command in a transaction. It uses `CREATE INDEX CONCURRENTLY`,
repairs a stale same-name definition, prints both indexes' ready/valid state,
and is idempotent. Reopen the Admin pipeline panel afterward; activation stays
disabled unless the runtime catalog check recognizes both exact definitions.
Running this operation does not configure a source, grant `public_opinion`,
reset a checkpoint or start an import.

### Retired Hub-local PostgreSQL

Older releases may have left `statefulset/mx-insight-hub-postgres` and its PVC.
Routine deploy only warns: silently deleting a database during upgrade is not a
safe migration strategy. After the shared database has been verified and the
legacy copy is no longer needed, remove it explicitly:

```bash
MX_INSIGHT_CONFIRM_DESTROY=mx-insight-hub \
  bash scripts/manage.sh ops internal-production decommission-local-postgres
```

This action is destructive and removes the old StatefulSet, claim, retained PV
and host path. It is never part of `deploy` or `down`.

`down` scales Hub workloads to zero. It does not stop `mx-common`, delete the
Hub database, remove shared PVCs or remove Hub Secrets.

## Optional HanLP tokenizer

Deploy HanLP from the shared plane first, then run the ordinary Hub deploy:

```bash
cd ../mx-common
bash scripts/manage.sh deploy hanlp

cd ../mx-insight-hub
bash scripts/manage.sh deploy
```

The HanLP command builds a model-preloaded local image, imports it into the
single node's `k8s.io` containerd, seeds and verifies the retained model PVC,
and requires both `/health` and `/tokenize` to pass. The Hub deploy discovers
the service only when Kubernetes has a ready Endpoint and writes its stable DNS
URL into `mx-insight-hub-config`, then verifies `/tokenize` through a real Hub
projector pod so DNS and namespace NetworkPolicy are covered. If no ready
Endpoint is found while the existing ConfigMap still has a non-empty HanLP URL,
deploy fails before rewriting runtime configuration or rolling workloads; the
known production backend is retained instead of being silently downgraded.
On a first/unconfigured install with no retained URL, Hub can still be configured
for the local backend. An explicitly configured `MX_COMMON_HANLP_URL` wins; an
explicitly empty value disables discovery and is the operator-controlled
downgrade path. Regardless of backend choice, content/chunk index writers require
that configured backend and leave work pending on transient failure; canonical
PostgreSQL ingest continues.

This independent path leaves `MX_INSIGHT_SYNC_LAUNCHER` at its default `0` and
does not modify or roll out Launcher.

## Launcher delegation

```bash
cd ../mx-launcher
bash scripts/manage.sh ops insight-hub deploy
```

Joint deployment is opt-in:

```bash
MX_INSIGHT_HUB_DEPLOY=1 bash scripts/manage.sh ops internal-production deploy
```

Launcher deploy remains unchanged when the variable is absent. Only the managed
delegation path sets `MX_INSIGHT_SYNC_LAUNCHER=1` to synchronize the bounded Hub
Admin integration; an independent Hub deployment does not roll out Launcher.

## DNS/gateway cutover

Do not create a temporary gate route to Night-All. After Services, workload auth
and smoke pass:

1. Private Admin route: `insight.mxinfo-inc.cn` -> Admin Service `18151`,
   MX-H2I only.
2. Private data route: reviewed exact host -> public Service `18150`, MX-H2I
   only.
3. Public route, if approved: public TLS edge -> WireGuard -> public Service
   `18150`, exact method/path allowlist.

The public host must never reach Admin Service, shared store Admin endpoints or
Night-All `13141/18141` directly. Host-network Hub workloads reach shared stores
through the explicit node-IP client rule reconciled by `mx-common`; a Pod
namespace selector alone cannot identify host-network traffic.

## Production release gates still open

- public/Admin/projector/ingest currently use the same Hub product database
  role; split migration/admin/public/worker privileges and add row isolation or
  controlled functions before broad internet exposure;
- prove PITR/off-node backup and restore for the Hub database inside
  `mx-common`;
- add bounded list/usage windows and aggregate projections where still absent;
- complete metrics/traces/log retention, alerting and request reconciliation;
- complete exact Night-All workload identity plus route/TLS review;
- for Telegram monitor, use the dedicated preparation action to install and
  verify the source-side watermark/trigger/index contract, then prove the
  long-lived external reader, shape preview, rejection/replay and rollback
  using the dedicated
  [ingestion runbook](telegram-monitor-ingestion.md).

Until these gates close, `internal-production` means the Internal K8s deployment
profile, not approval for public internet exposure.

## Data-plane expansion boundary

Canonical PostgreSQL storage/tombstones, Admin-managed direct PostgreSQL/file
sources, queues, ingest/projector workers, shared
Elasticsearch/Redis integration and optional HanLP are implemented. Immutable
raw object/cloud storage, `/shared_dir` watcher, freshness-aware live fallback,
generic CDC, non-PostgreSQL sources, BI datasets and governed Text2SQL remain
separate future capabilities. A mapped source tombstone is propagated today;
the open Telegram issue is obtaining a watermark that reliably observes every
edit/delete. A shared search outage may degrade retrieval but
must not stop authoritative PostgreSQL ingest, billing evidence, Launcher or
MX-H2I networking.
