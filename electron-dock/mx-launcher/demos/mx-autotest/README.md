# MX AutoTest Desktop

MX AutoTest is an independent Quasar/Electron product registered through MX
Launcher in `standalone` mode. It uses Launcher for product-scoped networking
and User Center identity, while test projects, tasks, runs and evidence live in
the separately deployed `electron-dock/mx-auto-server` service.

The implementation is intentionally a small client, not a copy of MX-H2I. It
owns only its `mx-autotest` lease CIDR, service-VIP host route, WireGuard
profile, encrypted credential vault and daemon identity. It never manages
system DNS/PAC, an Oversea tunnel, or another product's lifecycle.

Start with the [product and architecture docs](docs/README.md). The first
evidence-based acceptance contract is
[Luopan / Compass Web and Electron](docs/03-luopan-compass-acceptance.md).

## Platform prerequisite

Before a formal build can connect, create an enabled AppCenter app and
ProductNetwork through the Launcher Admin workflow with these identities:

| Field | Required value |
| --- | --- |
| appId / productId / productNetworkId | `mx-autotest` |
| launcherMode | `standalone` |
| networkScope | `owner` |
| standaloneChannelProductId | `mx-autotest` |
| requiredCapabilities | `launcher-network`, `launcher-standalone` |

Let the platform allocate a new, unique lease CIDR and service VIP; do not copy
Luopan or MX-H2I addresses. Reconcile the ProductNetwork through Launcher Admin
before testing its VIP. This repository deliberately does not mutate a running
Launcher installation or seed production registration data.

Current Launcher server code rejects a duplicate service VIP for any two
enabled ProductNetworks and backs that preflight with the global, enabled-only
PostgreSQL unique index and IPv4 check installed by
`LauncherProductServiceVipConstraint1760000000400`.
Disabled records may retain a duplicate only until activation. A target
environment is not considered ready until that migration has actually run and
its historical-conflict preflight succeeds. The migration compares IPv4 octets
numerically, so legacy leading-zero aliases collide, while missing or invalid
enabled VIPs stop the migration for explicit repair. The implementation here
is not evidence that a deployed environment has passed that gate.

## Develop and build

From `electron-dock/mx-launcher`:

```sh
cp demos/mx-autotest/.env.example demos/mx-autotest/.env
pnpm install
pnpm autotest:check
pnpm autotest:dev
```

The local `MX_AUTOTEST_SERVER_URL` can point to `mx-auto-server` on loopback.
Formal bearer transport is restricted to HTTPS, loopback, or the currently
verified product VIP. Account passwords, Launcher access tokens, lease
capabilities and the WireGuard private key never cross the main/preload boundary
into the renderer.

Build the unpackaged Electron application with:

```sh
pnpm autotest:build
```

For an installer-ready host, run `pnpm --filter @qpjoy/mx-autotest package`.
That single command verifies and installs the exact published Launcher/UI
packages, checks the app, packages it, and restores local-workspace mode even
when packaging fails. `mode:local`, `mode:npm` and `mode:status` expose the same
switch explicitly for diagnosis.

## Independent service and Compass seed

From the repository root, the control plane has its own lifecycle:

```sh
bash electron-dock/mx-auto-server/scripts/manage.sh test
bash electron-dock/mx-auto-server/scripts/manage.sh dev
```

After the service is ready, `mx-auto-server/scripts/onboard-compass.mjs`
idempotently registers the existing Compass `public` Cypress baseline. It does
not start a test. The demo/video task is always manual; an Electron suite is
created only when a real QA Git source is explicitly supplied.

The bundled [Compass Electron Playwright pack](test-packs/compass-electron/README.md)
is an initial QA-owned spike. A missing packaged executable exits as `blocked`
rather than becoming a false pass.

## Current scope

This first slice proves the standalone/login boundary, presents current apps,
tasks, runs and runners, and dispatches an existing task. Project authoring,
rich run views, toolchain caching and resumable large-artifact upload remain in
the staged roadmap; their absence must not be described as completed acceptance.
