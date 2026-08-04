# Internal Kubernetes deployment

## Layout

Namespace `mx-insight-hub` contains:

- PostgreSQL 16 StatefulSet and 20 GiB retained PVC/PV;
- schema migration Job;
- two-replica public API Deployment/ClusterIP Service on `18150`;
- one-replica Admin/API/UI Deployment/ClusterIP Service on `18151`;
- ingress NetworkPolicies allowing only same-namespace and `mx-platform` traffic.

The image uses `imagePullPolicy: Never`, matching the current single-node internal cluster. `scripts/manage.sh` requires exactly one Kubernetes node, builds with Docker, imports into `k8s.io` containerd through `ctr`, and preloads `postgres:16-bookworm` through the same path. Move to a signed registry and provisioned storage before adding nodes.

On bare kubeadm without a default StorageClass, deployment creates a pre-bound `Retain` hostPath PV at `/var/lib/mx-insight-hub/k8s/postgres`. An existing classless Pending PVC is bound to that PV in place, even if a default StorageClass was installed after the claim was created; this avoids a PVC-protection deadlock with the Pending PostgreSQL Pod. An existing bound PVC is always reused. A released local PV is repaired only after its path, reclaim policy, and claim identity match the Hub contract; the script never deletes the PVC or host data.

## Secret preparation

Create `.env.internal` with mode `0600`:

```bash
MX_INSIGHT_ADMIN_TOKEN=<long-random-token>
MX_INSIGHT_API_KEY_PEPPER=<long-random-pepper>
MX_INSIGHT_POSTGRES_PASSWORD=<url-safe-random-password>
NIGHT_ALL_BASE_URL=http://192.168.1.2:13141
NIGHT_ALL_SERVICE_TOKEN=<night-all-workload-token-when-supported>
```

Generate independent values, for example `openssl rand -hex 32`. The deploy script rejects local example values, short secrets, non-URL-safe PostgreSQL passwords and non-HTTP Night-All URLs.

Do not commit the file. Deployment renders a ConfigMap and Secret with `kubectl create --dry-run=client | kubectl apply`; values are not written into manifests.

## Independent deploy

```bash
bash scripts/manage.sh ops internal-production deploy
```

Order: acquire deploy lock -> build -> containerd import -> PostgreSQL image preload -> namespace -> retained-secret compatibility check -> Secret/ConfigMap -> storage reconciliation -> PostgreSQL ready -> migration complete -> public/admin rollout -> smoke -> scoped temporary-artifact cleanup.

The command is idempotent after an interrupted deploy. It reuses retained PostgreSQL data, recreates the migration Job, and reapplies workloads. PostgreSQL runs explicitly as UID/GID 999 with all Linux capabilities dropped; if an older Pending/CrashLoop Pod still has the historical root security context, deploy deletes only that Pod so the StatefulSet recreates it from the current template. The PVC, PV, and PGDATA are never removed. A changed PostgreSQL password or API-key pepper is rejected before the Secret is overwritten because those values require an explicit rotation procedure. A missing Secret is also rejected when retained PostgreSQL storage exists. The Docker build runs entirely inside its build context and does not create host `dist` directories. Temporary image archives, the managed port-forward, the Hub Docker staging image, and a PostgreSQL Docker image pulled only for this run are removed on both success and failure. Tagged containerd release/runtime images, PVCs, Secrets, and host data are retained as runtime or rollback assets; global Docker/BuildKit caches are outside this command's cleanup scope.

## Launcher delegation

```bash
cd ../mx-launcher
bash scripts/manage.sh ops insight-hub deploy
```

Joint deployment is opt-in:

```bash
MX_INSIGHT_HUB_DEPLOY=1 bash scripts/manage.sh ops internal-production deploy
```

Launcher deploy remains unchanged when the variable is absent. Hub failure in optional mode must be reported clearly; production policy may later add `disabled|optional|required` instead of a boolean.

## DNS/gateway cutover

Do not create a temporary gate route to Night-All. After Services, workload auth and smoke pass:

1. Private Admin route: `insight.mxinfo-inc.cn` -> Admin Service `18151`, MX-H2I only.
2. Private data route: `gate.night-all.mxinfo-inc.cn` -> public Service `18150`, MX-H2I only.
3. Public route, if approved: public TLS edge -> WireGuard -> public Service `18150`, exact method/path allowlist.

The public host must never reach Admin Service or Night-All `13141/18141` directly.

## Production release gates still open

- public/admin currently share the PostgreSQL owner connection; introduce migration/admin/public least-privilege roles (and tenant isolation/RLS or controlled functions) before any public route;
- add operator reconciliation for requests moved to `unknown` after the implemented reservation lease expires;
- add list pagination, bounded usage windows and aggregate projections;
- implement PITR/off-node backup and prove restore;
- wire metrics/traces/log retention and alerting;
- add exact Night-All workload identity and route/TLS review.

Until these gates close, `internal-production` means the internal K8s deployment profile, not approval for internet exposure.

## Data-plane expansion boundary

PostGIS, object storage, ingest workers, Redis/Valkey, Elasticsearch, Kibana and HanLP are target workloads, not part of the current K8s manifests. Add them as Hub-owned, independently scalable workloads only after their migrations, backup and failure tests exist. Elasticsearch/Kibana readiness must never become Launcher or MX-H2I readiness, and search failure must leave PostgreSQL-backed published data available. The local `deploy/compose/search` stack is not a production K8s manifest.
