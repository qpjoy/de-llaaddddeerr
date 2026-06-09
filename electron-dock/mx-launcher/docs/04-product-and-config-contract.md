# Product and Config Contract

MX Launcher is an internal platform. Desktop is one Launcher form factor.
Products are listed, installed, launched, configured, and updated through
AppCenter and Launcher contracts.

Launcher Network owns HDI/H2I connectivity and privileged network execution.
H2O is the first built-in AppCenter app. During migration the platform keeps
the legacy `hdo` product id and HDO-compatible backend contract.

## Platform Layers

| Layer | Responsibility |
| --- | --- |
| Launcher Desktop | install, start, update, rollback, guard daemon, local permissions, AppCenter host |
| AppCenter | app catalog, install state, user context, app launch, app permissions |
| Launcher Network | HDI/H2I, WireGuard, DNS/PAC, TUN, system proxy, and network coordination |
| AppCenter App | product UI and business logic, such as H2O |
| Launcher Daemon / Service | privileged install, update, permissions, network execution, and repair operations |
| MX-3ks Server | user center, config, release, artifact, test, observability, audit, runner |

Launcher Shell should stay stable. AppCenter and app protocols should absorb
most feature evolution.

## Product Manifest

Each desktop product has a manifest under
`desktop/products/<productId>/product.json`.

Required fields:

- `id` - stable product id, for example `hdo`.
- `displayName` - user-facing product name.
- `category` - grouping in the MX Launcher market UI.
- `channels` - release channels such as `stable`, `beta`, `internal`.
- `platforms` - supported platforms.
- `capabilities` - requested runtime capabilities.
- `backend.mxLauncherAdminApi` - product admin endpoint in `mx-launcher/server`.
- `backend.configApi` - product config endpoint.
- `artifacts.resourcesDirectory` - product resource directory copied into the
  packaged app.
- `artifacts.serviceProfile` - privileged service profile, if the product needs
  Windows Service or macOS helper operations.
- `config` - product config definitions.

For AppCenter applications, the same product definition should also declare:

- `builtin` - whether the app is bundled with AppCenter, such as H2O.
- `permissions` - requested auth, network, observability, and service scopes.
- `entrypoints` - desktop, settings, background, or deep-link entrypoints.
- `protocol.appCenter` - AppCenter protocol version.
- `protocol.launcher` - Launcher host protocol version.
- `legacyProductId` - compatibility id, for example `hdo`.

## Launcher and AppCenter Protocol

Launcher exposes a stable host protocol to AppCenter:

| API | Meaning |
| --- | --- |
| `launcher.getRuntimeContext()` | install, device, platform, environment, channel |
| `launcher.getAuthContext()` | anonymous/user context and JWT status |
| `launcher.getNetworkContext()` | Launcher Network status, overlay IP, DNS/PAC/TUN status |
| `launcher.installApp(appId, version)` | install app package |
| `launcher.updateApp(appId, version)` | update app package |
| `launcher.rollbackApp(appId)` | rollback to previous slot |
| `launcher.openApp(appId, params)` | launch AppCenter app |
| `launcher.requestPermission(appId, scopes)` | request system-backed permissions declared by an app |
| `launcher.emitTelemetry(event)` | unified telemetry event |

AppCenter exposes a stable runtime protocol to apps:

| API | Meaning |
| --- | --- |
| `appCenter.getUser()` | guest or logged-in user context |
| `appCenter.requestToken(audience, scopes)` | short-lived app token from User Center |
| `appCenter.getConfig(appId)` | final app config snapshot |
| `appCenter.getNetworkStatus()` | Launcher Network state and network context |
| `appCenter.requestNetworkMode(appId, mode)` | request app/global/tun network mode |
| `appCenter.requestInternalAccess(appId, target)` | request access to Internal service |
| `appCenter.reportHealth(status)` | app health |
| `appCenter.log(event)` | app observability event |

## Config Scopes

`appCenter.getConfig(appId)` reads from the Config Center policy snapshot. The
snapshot aggregates identity, AppCenter manifest, declared permissions,
Launcher Network policy, DNS policy, release policy, and observability sinks.
Apps should not call each control-plane module directly to build their own
runtime config.

MX Launcher separates config ownership by scope:

- `global` - applies to the whole platform.
- `product` - applies to all users of one product.
- `user` - follows the logged-in user.
- `device` - attached to a registered device.
- `install` - local machine install state, such as server URL.

## Config Value Types

Supported value types:

- `string`
- `boolean`
- `number`
- `json`
- `secret`

Secrets must be redacted from admin overview payloads unless an endpoint is
explicitly designed for secret rotation.

## Backend Namespace

Canonical platform APIs:

```text
GET /api/v1/mx-launcher/admin/products
GET /api/v1/mx-launcher/admin/products/hdo
GET /api/v1/mx-launcher/admin/products/hdo/config
```

Legacy HDO APIs remain available only as the Launcher Network / HDO
compatibility surface.
