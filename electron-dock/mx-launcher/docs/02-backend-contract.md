# MX Launcher Backend Contract

MX Launcher has its own backend namespace and keeps HDO compatibility by
adapting existing HDO control-plane data instead of moving old HDO APIs.

Launcher Network owns the Home -> Domestic -> Internal HDI/H2I network flow.
H2O is the intended first AppCenter display app for proxy, tunnel, and
Clash-like modes. During migration the platform remains compatible with the
legacy `hdo` product id and routes.

## Admin Endpoints

```text
GET /api/v1/mx-launcher/admin/products
GET /api/v1/mx-launcher/admin/products/hdo
GET /api/v1/mx-launcher/admin/products/hdo/config
```

The first endpoint returns every launcher product. The second returns the HDO
product payload with compatibility metadata and readiness metrics.

## HDO Compatibility

The HDO launcher product remains compatible with:

```text
POST /api/v1/hdo/anonymous/bootstrap
GET  /api/v1/hdo/readiness
GET  /api/v1/hdo/devices
POST /api/v1/hdo/devices/register
GET  /api/v1/hdo/device-tasks
GET  /api/v1/hdo/subscriptions/:deviceId/manifest.json
GET  /api/v1/hdo/subscriptions/:deviceId/mihomo.yaml
```

Admin compatibility remains backed by:

```text
GET  /api/v1/hdo/admin/overview
GET  /api/v1/hdo/admin/deployments
POST /api/v1/hdo/admin/deployments
```

## Product Payload

Launcher product payloads expose:

- product identity: `id`, `name`, `legacyProductId`;
- product config definitions and config scopes;
- compatibility: legacy API base, legacy endpoints, bootstrap fields;
- metrics: users, mesh grants, devices, DNS, services, tasks;
- backend surfaces: auth, DNS, config distribution, runner, releases;
- delivery stages: builder, launcher, service, product adapter, backend;
- UAC policy: when elevation is allowed or forbidden.
- AppCenter protocol: entrypoints, permissions, builtin app metadata, and app
  runtime API versions.
- Launcher Network contract: overlay leases, DNS/PAC/TUN state, system proxy
  state, and app-requested network modes.
- release/update policy: release notes, gray rollout, rollback slots, and
  required test gates.

## User Center

MX-3ks owns the canonical user center:

- OAuth login and token issuance.
- JWT validation and token introspection for AppCenter apps and other systems.
- RBAC, organizations, service accounts, and app permission grants.
- Anonymous principal linking to logged-in users.

Domestic should proxy login and enrollment requests to Internal instead of
keeping username/password or permission truth.

## Domestic Edge Contract

Domestic can run in minimal mode:

```text
public API proxy + WireGuard relay + H2I route + snapshot cache + observability forwarder
```

Internal creates signed relay leases and config snapshots. Domestic applies the
lease to the relay and caches snapshots, but does not decide user permissions or
generate long-lived product config.

## Data Ownership

- `mx-launcher/server` owns product configuration, DNS records, mesh membership,
  release state, and runner orchestration.
- MX Launcher owns install state, component hashes, rollback slots, and local
  service compatibility.
- Service owns privileged Windows networking state.
- Electron UI owns only presentation and user interaction.

## Future Products

New products should add a product manifest and an adapter payload under the MX
Launcher namespace. They should not add new behavior into the legacy HDO route
unless they are actually extending HDO.
