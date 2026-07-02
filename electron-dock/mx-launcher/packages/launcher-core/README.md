# @qpjoy/mx-launcher-core

`launcher-core` is the shared protocol package for all MX Launcher SDKs. It must
not own Electron runtime state, WireGuard, DNS, downloads, or UI. Its job is to
make standalone and embed packages speak the same language.

## Ownership

Put shared contracts here when they are used by both standalone brokers and
embed clients:

- manifest schemas
- capability names
- event names
- request and response envelopes
- broker handshake payloads
- channel registry record shape
- signed cache metadata
- release artifact metadata
- rollout policy input and output
- protocol and ABI version checks
- shared validation helpers

Do not put role-specific side effects here. Core code should be deterministic
and testable without Electron, network adapters, or privileged host access.

## Compatibility

Same-major packages must be protocol-compatible. Core is the place that defines
what compatibility means:

```ts
export const launcherProtocolMajor = 2;
export const brokerAbiMajor = 2;
```

Future implementation should expose helpers similar to:

```ts
assertCompatibleBroker({
  embedProtocolMajor,
  brokerProtocolMajor,
  minBrokerAbi,
  brokerAbi
});
```

Rules:

- patch and minor versions can add optional fields.
- required field changes, removed events, renamed capabilities, or incompatible
  handshake changes require a new major.
- unknown optional fields must be ignored by older compatible peers.
- incompatible peers must fail closed with a typed reason, not a generic network
  error.

## Manifest Model

All products should use one manifest shape with role-specific sections:

```ts
type LauncherManifest = {
  appId: string;
  productId: string;
  launcherMode: 'standalone' | 'embed';
  sdkAbiVersion: string;
  requiredCapabilities: string[];
  network: {
    scope: 'owner' | 'broker-session';
    serviceVip?: string | null;
  };
  standalone?: {
    ownsNetwork: true;
    brokerEnabled: true;
  };
  embed?: {
    standaloneChannelProductId: string;
    launchWithoutBroker: 'blocked' | 'prompt-open-standalone';
  };
};
```

The same shape lets K8s admin, AppCenter, standalone products, and embed apps
reason about bindings without bespoke per-package schemas.

`createLauncherEmbedManifest()` produces the default embed variant for this
shape. It sets `runtimeContractVersion: 0.1`, `launcherMode: embed`,
`network.scope: broker-session`, and the configured
`embed.standaloneChannelProductId`.

`network.scope` is the important distinction for the embed IP question:
standalone products are `owner` and may allocate peer leases; embed apps are
`broker-session` and inherit network/user/permission/update state from their
selected standalone channel.

## Channel Registry Record

The registry stores running standalone brokers only:

```ts
type LauncherChannelRecord = {
  productId: string;
  instanceId: string;
  pid: number;
  socketPath: string;
  brokerAbiVersion: string;
  protocolVersion: string;
  capabilities: string[];
  heartbeatAt: string;
};
```

The registry is short-lived discovery data. It must not contain WireGuard keys,
DNS state, long-lived user tokens, or release secrets.

## Capability Model

Capabilities are strings owned by core. Examples:

```txt
catalog.read
app.install
app.launch
app.update.manage
user.session
network.proxy
network.status
release.resolve
audit.record
```

Standalone SDKs enforce capabilities. Embed SDKs only request them.

## Test Expectations

Core should own contract fixtures. Standalone and embed packages should consume
the same fixtures in their tests:

- handshake success
- broker ABI mismatch
- missing required capability
- stale binding cache
- release policy match
- rollout bucket stability
- signed artifact verification failure
