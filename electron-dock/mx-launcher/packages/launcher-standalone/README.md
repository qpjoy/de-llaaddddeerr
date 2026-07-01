# @qpjoy/mx-launcher-standalone

`launcher-standalone` is the role SDK for capability owners such as MX-H2I and
Luopan. A standalone launcher owns the local capability plane for one product
channel. It can host embed apps, but it must not merge its runtime ownership
with another standalone channel.

## Responsibilities

Standalone owns:

- local broker lifecycle
- channel registry registration and heartbeat
- user/session bridge
- permission grant enforcement
- ProductNetwork and route policy application for its own product
- WireGuard, DNS, PAC, system proxy, and data-plane diagnostics
- release policy resolution for itself and hosted embed apps
- embed app download, verification, install, rollback, and launch
- AppCenter catalog operations when AppCenter is hosted by this channel
- audit events for privileged operations

Standalone does not own another standalone product. If MX-H2I and Luopan are
both running, each keeps its own network owner, user context, permission grants,
release policy, and data-plane state.

## Bootstrap

Standalone bootstrap should follow this sequence:

1. Load the product manifest and local install identity.
2. Fetch ProductNetwork, release policy, rollout, AppCenter catalog, and
   capability policy from Internal.
3. Use signed local cache when Internal is unavailable.
4. Start the broker listener.
5. Register the channel record in the per-user registry.
6. Apply or repair local data plane for this product only.
7. Start built-in embed apps such as AppCenter when configured.

The broker may run in the Electron main process or a local helper, but it must
present the same protocol to embed clients.

## Broker Handshake

Embed clients connect with:

```ts
{
  appId: 'appcenter',
  launcherMode: 'embed',
  sdkVersion: '2.3.4',
  protocolVersion: '2',
  minBrokerAbiVersion: '2',
  requestedCapabilities: ['catalog.read', 'app.install']
}
```

The standalone broker must:

1. verify protocol and ABI compatibility.
2. verify the embed app is allowed to bind to this standalone channel.
3. resolve server policy or signed local cache.
4. issue a scoped capability session.
5. return only the data the embed app is permitted to see.

Do not send WireGuard keys, DNS ownership state, long-lived user tokens, or
system proxy handles to embed apps.

The issued session should report `networkScope: 'broker-session'`. The
standalone channel keeps `networkScope: 'owner'` and remains the only runtime
peer lease owner for that app group.

## AppCenter And Hosted Apps

AppCenter is a privileged embed app hosted by MX-H2I. It is not a standalone
owner. AppCenter may request catalog, install, launch, and update actions, but
the MX-H2I standalone broker performs the actual download, verification,
installation, launch, and audit.

H2O and future AppCenter applications are normal embed apps. They should not get
their own IP, WireGuard interface, DNS owner, or system proxy owner unless they
are explicitly converted into standalone products.

## Release And Install Owner

Standalone release:

- downloaded as signed OS artifacts from OSS/CDN.
- resolved by server release policy.
- applied by the standalone updater.

Hosted embed release:

- downloaded as signed embed bundles from OSS/CDN.
- resolved by the same server release policy.
- verified and installed by the standalone broker.
- launched through the broker with a scoped session.

NPM package versions are build-time SDK versions. User machines update from
signed artifacts, not from npm.

## K8s Admin Integration

K8s admin should be able to inspect and operate standalone channels:

- broker status and ABI version
- channel registry heartbeat
- active embed sessions
- data-plane health
- ProductNetwork and Domestic materialization status
- release and rollout status
- hosted embed app install state
- audit trail for grants, launches, installs, updates, and rollbacks

Operational actions should be idempotent:

- refresh policy cache
- sync AppCenter catalog
- force hosted app update
- rollback hosted app
- diagnose embed connection
- reapply standalone data plane
