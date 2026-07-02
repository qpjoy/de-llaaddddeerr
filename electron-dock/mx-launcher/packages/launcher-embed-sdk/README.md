# @qpjoy/mx-launcher-embed-sdk

`launcher-embed-sdk` is the role SDK for applications hosted by a standalone
launcher. Embed apps are consumers. They do not own local networking, users,
permissions, release policy, downloads, or rollout decisions.

## Allowed Responsibilities

Embed SDK may:

- discover a running standalone broker.
- connect and handshake with the broker.
- request scoped capabilities.
- subscribe to broker events.
- request app install, launch, update check, or update apply when granted.
- expose a safe preload bridge to renderer code.
- read signed local binding cache only to find the required standalone channel.

Embed SDK must not:

- apply WireGuard.
- write DNS, PAC, system proxy, or resolver state.
- allocate or claim a ProductNetwork IP.
- store long-lived Internal tokens.
- make independent rollout decisions.
- install or update itself without broker approval.

## Bootstrap

Embed app startup:

1. Read the embed manifest.
2. If launched by a standalone broker, trust the launch envelope after signature
   and nonce validation.
3. Otherwise read signed local binding cache to find
   `standaloneChannelProductId`.
4. Find a compatible running broker in the channel registry.
5. Handshake and request capabilities.
6. If no broker is available, return a typed state such as
   `standalone-required`, with enough metadata for UI to prompt the user to open
   MX-H2I or the configured standalone.

Embed should not directly fetch privileged server policy before broker
connection. The broker refreshes Internal policy and returns scoped results.

## Minimal API Shape

Future implementation should keep the public API small:

```ts
import { createEmbedLauncher } from '@qpjoy/mx-launcher-embed-sdk';

const launcher = createEmbedLauncher({
  productId: 'h2o',
  standaloneChannelProductId: 'mx-h2i',
  requiredCapabilities: ['user.session', 'network.proxy', 'network.status']
});

const connection = await launcher.connect();
if (!connection.ok) {
  console.warn(connection.state, connection.message);
}

launcher.on('auth.changed', (event) => {});
launcher.on('release.available', (event) => {});

await launcher.request('network.proxy', {
  url: '/internal/v1/h2o/tasks'
});
```

Renderer APIs should be exposed through preload with explicit allowlists. Do not
expose a raw IPC or transport object to untrusted renderer code.

## Runtime Contract v0.1

The shared core package exposes `createLauncherEmbedManifest()` and
`launcherEmbedRuntimeContractVersion`. AppCenter records, admin records, and
embed apps should use this shape for the first product-grade contract:

- `runtimeContractVersion`: `0.1`
- `launcherMode`: `embed`
- `network.scope`: `broker-session`
- `embed.standaloneChannelProductId`: the owning standalone channel, for
  example `mx-h2i`
- `requiredCapabilities`: the broker-scoped API surface the app needs

The first event vocabulary is intentionally small:

- `embed.init`, `embed.ready`, `embed.error`, `embed.logs`
- `auth.changed`, `network.changed`, `permission.changed`
- `app.open`, `app.close`

The first request vocabulary is also broker-owned:

- `user.session`
- `network.status`
- `network.proxy`
- `network.dns.policy`
- `network.pac.policy`
- `app.open`, `app.close`, `app.logs`, `app.update.check`

An embed app receives state through the broker session or through a preload
bridge owned by its Electron main process. It should not read WireGuard keys,
touch routes, apply PAC, or write DNS directly.

The high-level embed API is broker-session based. The package still exposes a
`legacyNetwork` object for migration tests that need to call the old
Internal lease APIs explicitly, but production embed apps should not allocate a
runtime lease or apply WireGuard through that path.

## State Model

Use explicit states instead of a single `connected` boolean:

```txt
idle
discovering-broker
standalone-required
broker-incompatible
capability-denied
connected
network-ready
blocked
disconnected
```

`connected` means the broker handshake succeeded. It does not mean every
capability is ready. For example, an embed app may be connected while
`network.proxy` is blocked by policy or by standalone data-plane repair.

## AppCenter And H2O

AppCenter is an embed app with elevated capabilities such as `catalog.read`,
`app.install`, `app.launch`, and `app.update.manage`. It still depends on the
MX-H2I standalone broker for execution.

H2O is **Home To Oversea**, an AppCenter built-in embed network plugin. It is a
Clash-like user surface for proxy mode, PAC, Split DNS, and Internal/oversea
status, but it should still use the same broker-session contract as other
AppCenter applications. H2O should only request the capabilities it needs and
should not know whether MX-H2I uses WireGuard, PAC, system proxy, or another
future data-plane implementation.

## Release Behavior

Embed apps are distributed as signed bundles. The embed SDK can ask for update
status, but installation and rollback are broker-owned:

```txt
embed app -> app.update.check -> standalone broker -> release policy -> OSS/CDN
standalone broker -> verify signature/hash -> install cache -> launch envelope
```

The SDK npm version is not the user-facing app version. Embed manifests should
record both:

- `sdkVersion`: build-time SDK package version.
- `appVersion`: user-facing embed application version.

## K8s Admin Expectations

K8s admin should show, for every embed app:

- configured standalone channel.
- required capabilities.
- granted capabilities.
- broker compatibility.
- active install version.
- latest eligible release.
- rollout decision.
- last launch error.
- audit history.

Admin operations should target the standalone broker, not the embed process, for
privileged work such as install, update, rollback, and cache refresh.
