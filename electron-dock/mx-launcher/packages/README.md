# MX Launcher Packages

This directory contains the SDK package boundary for MX Launcher products. The
design supports both delivery styles:

- unified package: products install `@qpjoy/electron-launcher` and select a role
  during bootstrap.
- split packages: product teams install the role-specific SDK they are allowed
  to use, while shared protocol and contract code stays in core.

The split form is the production-facing contract. The unified package remains a
convenience facade and compatibility entry for Electron products already using
`@qpjoy/electron-launcher`.

## Package Roles

| Package | Audience | Responsibility |
| --- | --- | --- |
| `@qpjoy/mx-launcher-core` | all SDK packages | protocol types, manifests, capability names, transport framing, release contracts, ABI compatibility |
| `@qpjoy/mx-launcher-standalone` | standalone launcher products | broker ownership, channel registration, user/session bridge, network/data-plane owner, embed app installation/update owner |
| `@qpjoy/mx-launcher-embed-sdk` | embed applications | broker discovery, handshake, capability requests, event subscription, app lifecycle requests |
| `@qpjoy/electron-launcher` | Electron products | Electron-specific facade, runtime adapters, compatibility exports, optional unified role bootstrap |

Do not duplicate protocol literals between standalone and embed packages. If an
event name, manifest field, capability string, release field, or wire payload is
shared, it belongs in `launcher-core`.

## Compatibility Rule

Packages with the same major version must be protocol-compatible.

Example:

```txt
@qpjoy/mx-launcher-core       2.x
@qpjoy/mx-launcher-standalone 2.x
@qpjoy/mx-launcher-embed-sdk  2.x
@qpjoy/electron-launcher      2.x
```

Patch and minor versions may add optional fields or capabilities. A breaking
change requires a new major and a new `protocolVersion` or `brokerAbiVersion` in
core. Embed clients must send their SDK and protocol version during handshake,
and standalone brokers must reject incompatible clients with a clear
`BROKER_ABI_INCOMPATIBLE` style error.

## Role Model

Standalone and embed are not two equal networking modes.

- Standalone is the capability owner. It may own WireGuard, DNS, PAC/system
  proxy, users, permission grants, release policy, rollout decisions, download,
  install, and audit.
- Embed is a capability consumer. It has no independent IP, WireGuard, DNS,
  user store, update owner, or rollout decision. It reaches these capabilities
  only through the selected standalone channel.
- The shared contract calls this `networkScope`: standalone products use
  `owner`; embed apps use `broker-session`. An embed app may have app service
  metadata for DNS/gateway routing, but it does not receive a runtime WireGuard
  peer lease IP.

This preserves the existing multi-standalone goal: MX-H2I and Luopan can run on
the same machine without sharing data-plane ownership, while AppCenter, H2O, and
future AppCenter applications can bind to a chosen standalone owner.

## Bootstrap Contract

Standalone bootstrap:

1. Read the local product manifest.
2. Fetch ProductNetwork, release policy, rollout, permissions, and app binding
   data from Internal.
3. Fall back to signed local cache when the server is unavailable.
4. Start the local broker.
5. Register the running channel in the per-user channel registry with
   `productId`, `instanceId`, `pid`, `socketPath`, `brokerAbiVersion`,
   `capabilities`, and heartbeat metadata.
6. Own data-plane apply and diagnostics for its own product only.

Embed bootstrap:

1. Read the local embed app manifest.
2. Prefer the launch envelope if the app was launched by a standalone broker.
3. Otherwise read signed local binding cache to find the configured
   `standaloneChannelProductId`.
4. Discover a running broker through the channel registry.
5. Handshake with the broker and request a scoped capability session.
6. If no compatible broker is running, ask the user to open the required
   standalone product, or invoke a product URL such as `mx-h2i://open`.

Embed apps should not contact Internal directly for privileged bootstrap. They
ask the standalone broker to refresh server policy and return only scoped data.

## Channel Registry And Caches

Use separate local stores for separate concerns:

- channel registry: short-lived records for running standalone brokers.
- binding cache: signed server binding data such as app to standalone channel.
- install cache: downloaded embed app versions and verified artifact metadata.
- grant cache: scoped user permission, feature flag, and rollout decisions with
  a short TTL.

Never write WireGuard, DNS, or system proxy state into the shared embed binding
cache. These remain standalone-owned runtime state.

## Event And Request Surface

Core should define event names and request names. The first stable surface should
cover:

```txt
broker.connected
broker.disconnected
auth.changed
capability.changed
network.ready
network.blocked
release.available
app.install.progress
app.updated
```

And requests:

```txt
capability.grant
capability.revoke
app.install
app.launch
app.update.check
app.update.apply
release.resolve
network.proxy
audit.record
```

Embed packages expose only consumer-safe requests. Standalone packages implement
the broker side and enforce capabilities.

## Release And Update Model

There are three independent version layers:

- Standalone desktop releases: MX-H2I, Luopan, and other standalone products are
  distributed as signed OS artifacts such as dmg, zip, exe, or AppImage through
  OSS/CDN plus signed release metadata.
- Embed app releases: AppCenter, H2O, and AppCenter apps are signed bundles
  downloaded, verified, installed, rolled back, and launched by the selected
  standalone broker.
- SDK npm releases: these packages are build-time dependencies. User machines do
  not update by npm install.

Server release policy is the source of truth for stable, beta, canary, staged
rollout, user/org targeting, platform constraints, and rollback. OSS/CDN is the
immutable artifact store, not the policy authority.

## K8s Admin Operations

K8s admin should expose the package model as an operational surface:

- Launcher Apps: app registration, `standalone` or `embed`, required
  capabilities, access policy, update policy, and `networkScope`.
- Standalone Channels: running owner status, broker ABI, channel registry
  heartbeat, active embed sessions, data-plane health.
- Embed Apps: configured standalone channel, install status, active version,
  granted capabilities, broker compatibility, launch errors.
- Release Center: artifact upload, hash/signature, platform matrix, channel,
  rollout, rollback.
- Operations: sync binding cache, publish catalog, force update, rollback,
  diagnose embed connection, inspect broker events.
- Audit: app install, launch, grant, update, rollback, and policy resolution.

Admin must keep standalone ProductNetwork ownership separate from embed binding.
An embed app may be visible in AppCenter and release management without creating
a WireGuard owner, DNS owner, or runtime IP segment. Service VIP materialization
is checked as app service routing; broker/session readiness is checked on the
selected standalone channel.

## Implementation Order

1. Stabilize the existing standalone data-plane behavior.
2. Move all shared protocol constants and schemas into `launcher-core`.
3. Keep `@qpjoy/electron-launcher` as the current facade and add role-aware
   exports without breaking existing imports.
4. Make `launcher-standalone` expose broker registration and capability owner
   APIs.
5. Make `launcher-embed-sdk` expose broker discovery, handshake, requests, and
   events only.
6. Convert AppCenter into an embed app hosted by MX-H2I, while preserving a
   built-in fallback AppCenter.
7. Convert H2O into the first default AppCenter embed app.
8. Add release artifact, signed manifest, rollout, and install cache support.
9. Add K8s admin management and diagnostics for bindings, sessions, releases,
   and audits.
