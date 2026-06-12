# MX Launcher Delivery Plan

This plan splits the current zip / portable / UAC problem into small, verifiable
phases. Each phase should leave the product shippable or at least testable.

## Phase 0 - Product Boundary

Goal: make MX Launcher a real product platform, separate from HDO Demo.

Deliverables:

- `electron-dock/mx-launcher` package exists.
- HDO is registered as one MX Launcher product, not as the platform itself.
- Product config definitions are declared in each product manifest.
- Existing HDO API compatibility is documented and exposed in the MX Launcher
  Server/admin backend.
- Admin UI has `Launcher > HDO 管理`, distinct from the old `HDO 控制面`.

Checks:

```bash
bash electron-dock/mx-launcher/scripts/manage.sh server-typecheck
pnpm --dir electron-market/packages/admin-ui typecheck
```

## Phase 1 - electron-builder Package Contract

Goal: build signed UI artifacts without privileged install logic in the UI.

Deliverables:

- `desktop/electron-builder.yml` produces `zip`, `portable`, and `dir`.
- Electron app executable runs as `asInvoker`.
- Native `MxService.exe` and `MxLauncher.exe` are copied through
  `extraResources` when present under `desktop/native/win32-x64/`.
- `desktop/scripts/after-sign.mjs` signs every executable and native binary in the
  package when Windows signing env vars are present.
- `mx-launcher.package-manifest.json` records file hashes and expected signer
  thumbprints.
- `desktop/scripts/check-package-contract.mjs` blocks release builds that are missing
  package contract fields.

Checks:

```bash
pnpm --dir electron-dock/mx-launcher/desktop check
pnpm --dir electron-dock/mx-launcher/desktop build
pnpm --dir electron-dock/mx-launcher/desktop package:win:dir
pnpm --dir electron-dock/mx-launcher/desktop verify:signatures
```

Exit criteria: opening the zip never asks for UAC. UAC is requested only by the
launcher when service installation or service repair is required.

## Phase 2 - Launcher Bootstrap

Goal: one elevation per install or repair, never repeated per zip extraction.

Deliverables:

- Launcher detects install state, service version, package hash, and UI version.
- First install elevates once, installs the service, then drops back to normal.
- Normal startup runs unelevated and starts the Electron UI.
- Updates are staged, hash-checked, signature-checked, and atomically swapped.
- Rollback keeps the previous UI, service, and product resources.

Checks:

```bash
pnpm --dir electron-dock/mx-launcher/desktop test:launcher
pnpm --dir electron-dock/mx-launcher/desktop smoke:win
```

Exit criteria: repeated launch from the same installed directory does not show
UAC unless service repair or service upgrade is needed.

## Phase 3 - Windows Service

Goal: move all privileged networking into a stable service boundary.

Deliverables:

- Service owns WireGuard adapter lifecycle.
- Service owns NRPT, DNS, route, and firewall changes.
- Launcher talks to service through a local authenticated IPC channel.
- Service validates requested product operations against installed manifests.
- Service writes structured diagnostics for UI and backend reporting.

Checks:

```bash
pnpm --dir electron-dock/mx-launcher/desktop test:service
pnpm --dir electron-dock/mx-launcher/desktop smoke:network
```

Exit criteria: Electron UI does not directly run privileged network commands.

## Phase 4 - Launcher Network / HDO Product Adapter

Goal: move HDI/H2I network ownership into Launcher Network while keeping the
existing HDO product contract during migration.

Deliverables:

- Anonymous visitor bootstrap remains compatible with
  `/api/v1/hdo/anonymous/bootstrap`.
- Employee login continues to use existing auth and HDO device APIs.
- HDO mesh/profile/DNS/service config comes from `mx-launcher/server`, with
  legacy `electron-server` APIs used only during migration.
- Product resources are updated by Launcher, not by the Electron UI.

Checks:

```bash
pnpm --dir electron-dock/mx-launcher/desktop test:hdo-adapter
pnpm --dir electron-dock/mx-launcher/desktop smoke:hdo
```

Exit criteria: existing HDO backend data can drive the launcher product without
data migration.

## Phase 5 - Server Control Plane

Goal: make launcher configuration and rollout visible in `mx-launcher/server`.

Deliverables:

- `/api/v1/mx-launcher/admin/products` lists all launcher products.
- `/api/v1/mx-launcher/admin/products/hdo` returns HDO product readiness.
- `/api/v1/mx-launcher/admin/products/hdo/config` returns HDO config keys.
- Admin UI displays backend surfaces, package stages, UAC policy, and HDO
  compatibility endpoints.
- Future products can be added without editing old HDO routes.

Checks:

```bash
bash electron-dock/mx-launcher/scripts/manage.sh server-typecheck
pnpm --dir electron-market/packages/admin-ui typecheck
```

## Phase 6 - Release and Update Operations

Goal: make signed updates operationally safe.

Deliverables:

- Release plans cover UI, launcher, service, and product resources separately.
- Hash and signature checks are mandatory before activation.
- Rollback policy is explicit for each component.
- Audit logs record install, update, repair, rollback, and launch decisions.

Checks:

```bash
pnpm --dir electron-dock/mx-launcher/desktop verify:release
bash electron-dock/mx-launcher/scripts/manage.sh server-typecheck
```

Exit criteria: a bad update can be blocked before activation or rolled back
without reinstalling the product.

## Phase 7 - Observable Automation Test Platform

Goal: make smoke, online E2E, synthetic probes, release gates, and evidence
traceable inside the Launcher platform.

Deliverables:

- Internal profile enables `test-center` beside release, runner, audit, and
  observability.
- Test runs record environment, site, product, release, config snapshot,
  runner job, trace, logs, and evidence.
- Shadow HDOI E2E validates H Endpoint -> Domestic -> Internal -> Oversea
  flows before beta/stable release expansion.
- Release Center can block, pass, or waive a gate with audit.
- Admin UI has Test Center views for runs, gates, synthetic probes, and
  evidence.

Checks:

```bash
bash electron-dock/mx-launcher/scripts/manage.sh test e2e --suite hdo-shadow-e2e --topology h-d-i-o-shadow
bash electron-dock/mx-launcher/scripts/manage.sh test gate --release rel_shadow
```

Exit criteria: every release decision can point to a test verdict and evidence
bundle, not only a human memory of a smoke test.

## Phase 8 - MX-3ks AppCenter, Launcher Network, and H2O Platform

Goal: make MX Launcher a stable platform shell with Launcher Network as the
single network runtime and H2O as the first AppCenter app, while Internal MX-3ks
owns users, config, release, tests, observability, and SDK gateway capabilities.

Deliverables:

- Launcher Desktop is documented as installer, updater, rollback executor,
  AppCenter host, and daemon/service coordinator.
- Launcher Network owns HDI/H2I, WireGuard, DNS/PAC, TUN, system proxy, and
  network coordination.
- AppCenter protocol defines app catalog, install/update/rollback, auth
  context, network context, app permissions, telemetry, and health reporting.
- H2O is the first built-in AppCenter app, compatible with legacy HDO routes
  during migration through Launcher Network.
- User Center in Internal owns OAuth, JWT, RBAC, anonymous-to-user linking, and
  app token exchange.
- Domestic can run minimal relay/proxy mode: public API proxy, WG relay, H2I
  route, snapshot cache, and observability forwarder.
- MX-3ks SDK Gateway exposes user, permission, audit, observability, release,
  and config capabilities to other internal systems.
- Internal shadow can run with PostgreSQL store; TypeORM migrations execute on
  service startup and preserve current API payloads in JSONB compatibility
  records while the data model matures.

Checks:

```bash
bash electron-dock/mx-launcher/scripts/manage.sh server-typecheck
bash electron-dock/mx-launcher/scripts/manage.sh smoke platform-kernel
bash electron-dock/mx-launcher/scripts/manage.sh shadow build
bash electron-dock/mx-launcher/scripts/manage.sh shadow up
bash electron-dock/mx-launcher/scripts/manage.sh shadow smoke
bash electron-dock/mx-launcher/scripts/manage.sh shadow down
bash electron-dock/mx-launcher/scripts/manage.sh k8s plan internal-shadow
bash electron-dock/mx-launcher/scripts/manage.sh k8s explain internal-shadow
bash electron-dock/mx-launcher/scripts/manage.sh k8s render internal-shadow
bash electron-dock/mx-launcher/scripts/manage.sh profile internal
bash electron-dock/mx-launcher/scripts/manage.sh profile domestic
```

Exit criteria: future AppCenter apps can be added through manifests and runtime
protocols without changing Launcher Shell or creating separate privileged
network owners for ordinary product changes.

## Phase 9 - Platform Operations and MX Console Design System

Goal: turn Internal from a shadow control plane into an operations platform that
uses mature K8s ecosystem capabilities while keeping MX as the source of truth.

Deliverables:

- AWX is introduced as an execution provider behind Worker Contract V1, not as a
  replacement for Internal state, RBAC, gates, evidence, or release truth.
- K8s ecosystem adoption is planned around GitOps, observability, secrets,
  certificates, policy, backup, artifact storage, and optional workflow engines.
- Config Center remains backed by Internal PostgreSQL; etcd is used only through
  Kubernetes APIs such as ConfigMap, Secret, Lease, CRD, and watch projections.
- Domestic and Oversea slot execution gains a Linux support contract for Ubuntu
  and CentOS / RHEL-family hosts, including OS preflight, package manager
  branching, firewall/security module detection, container runtime checks, and
  rollback evidence.
- Admin UI gets an MX Console design system: deep editor shell, Three.js
  topology stage, action gates, inspector panels, evidence drawer, command
  console, status tokens, and shared components.
- shadcn/ui is the preferred basis for the future Admin component library if the
  Admin surface moves to React; Quasar remains an option only if the Admin stack
  deliberately moves to Vue.

Checks:

```bash
bash electron-dock/mx-launcher/scripts/manage.sh check
bash electron-dock/mx-launcher/scripts/manage.sh k8s explain internal-shadow
bash electron-dock/mx-launcher/scripts/manage.sh ops admin dashboard
```

Exit criteria: platform operators can plan a Domestic/Oversea change from MX
Admin, execute it through a provider such as AWX or the fallback runner, and
inspect OS support, gates, logs, traces, task evidence, and rollback hints in a
single MX Console experience.
