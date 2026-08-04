# MX Launcher

MX Launcher is the full-stack Launcher solution for MX products. It includes
the desktop client, server/control plane, product catalog, configuration center,
release/deployment operations, site profiles, admin console plans, and offline
delivery kits. Launcher Network owns HDI/H2I connectivity, and H2O is the first
built-in AppCenter app in this ecosystem.

MX Launcher owns:

- `desktop/` - signed, unelevated Electron desktop shell and product market UI;
- `server/` - MX Launcher Server control-plane API for Internal, Domestic, and
  Oversea site profiles;
- `desktop/products/` - desktop product manifests and install/config/resource
  contracts;
- `desktop/src/` - desktop catalog, config, service, and package contracts;
- `desktop/native/` - privileged launcher/service binaries once implemented;
- `docs/` - delivery, backend, multi-site, and operations architecture;
- future `admin/`, `deploy/`, `kits/`, `migrations/`, and `site-agent/`
  directories under this same project boundary.

The older `electron-server` remains a compatibility/current-production system
while this project grows into the complete Launcher backend and delivery
platform. New Launcher solution design and implementation should happen here.

## Layout

- `desktop/` - complete Electron desktop app packaged by electron-builder.
- `server/` - server/backend package for MX Launcher control plane.
- `desktop/products/hdi/product.json` - product manifest for HDI.
- `desktop/src/catalog.ts` - multi-product catalog helpers.
- `desktop/src/config/` - product config registry helpers.
- `desktop/src/contracts/mx.ts` - platform-level product and config contracts.
- `desktop/src/contracts/hdi.ts` - HDI launcher API types with legacy HDO endpoint compatibility.
- `desktop/src/launcher/` - launcher install/update decision model.
- `desktop/src/service/` - native service IPC contract.
- `desktop/src/security/` - package manifest contracts.
- `desktop/scripts/` - desktop packaging checks, signing, and verification.
- `scripts/manage.sh` - solution-level management entry.

## Documents

- `docs/00-delivery-plan.md` - executable implementation phases.
- `docs/01-windows-uac-service-model.md` - UAC, service, signing, and update
  model.
- `docs/02-backend-contract.md` - backend contract and HDI compatibility policy.
- `docs/03-macos-signing-notarization.md` - macOS signing, notarization, and
  DMG delivery policy.
- `docs/04-product-and-config-contract.md` - platform product and config
  contract.
- `docs/05-hdo-multi-site-platform-architecture.md` - Launcher Network / HDI
  multi-site platform architecture for Internal, Domestic, Oversea, and H
  endpoints.
- `docs/06-server-shadow-control-plane.md` - MX Launcher Server shadow control
  plane.
- `docs/07-end-to-end-delivery-blueprint.md` - complete D/I/O/H delivery
  blueprint, migration, operations, admin, and sales kit plan.
- `docs/08-cdtr-platform-lessons.md` - useful CDTR/DRTC platform lessons folded
  into MX Launcher.
- `docs/09-observable-automation-test-platform.md` - observable automation,
  online E2E, synthetic probes, release gates, and H/D/I/O test-center design.
- `docs/10-mx-3ks-appcenter-launcher-network-h2o-architecture.md` - MX-3ks
  platform, AppCenter protocol, Launcher Network, H2O, Domestic minimization,
  and SDK gateway architecture.
- `docs/11-k8s-deployment-runbook.md` - K8s deployment order, Docker Compose
  concept mapping, migration Job, and Admin action model.
- `docs/12-local-ops-manage-guide.md` - beginner-friendly local operations
  guide for `scripts/manage.sh`, Compose shadow, and K8s shadow.
- `docs/13-platform-ops-and-admin-design-system-roadmap.md` - K8s operations
  platform, AWX execution plane, Ubuntu/CentOS support contract, and Admin
  design system roadmap.
- `docs/14-mx-h2i-standalone-launcher-architecture.md` - MX-H2I standalone
  Launcher, AppCenter/H2O embed boundary, Mesh/IP allocation, deployment, local
  dev, npm release, and desktop packaging design.
- `docs/15-sdk-gateway-api.md` - SDK Gateway external API, token flow,
  User Center, service account, and permission request contracts.
- `docs/26-mx-insight-hub-integration-architecture.md` - HDO V1 / MX-H2I V2
  boundary, federated identity, Hub data-plane routing, lifecycle isolation, and
  non-interference gates for the existing MX-H2I network path.

## Local Checks

```bash
bash electron-dock/mx-launcher/scripts/manage.sh check
pnpm --dir electron-dock/mx-launcher/desktop check
pnpm --dir electron-dock/mx-launcher/server typecheck
```

The package is intentionally standalone until the root workspace decides whether
`electron-dock/*` should join a shared pnpm workspace.
