# MX App H2O

`@qpjoy/electron-launcher-app-h2o` is the first MX-H2I embed launcher app demo.
It is intentionally a normal npm-style Electron package: AppCenter can record
the package name and version in Internal, cache the installed package locally,
then open its entrypoint through the MX-H2I broker-session.

The default screen is user-facing: connection health, proxy mode, DNS/PAC
status, and recent activity are visible without exposing launcher internals.
Developers and support users can click `Debug` to inspect inherited MX-H2I
context such as broker session, socket path, package metadata, network scope,
local IP, and capability bridge state.

## Development Test

From `electron-dock/mx-launcher`:

```sh
pnpm --filter @qpjoy/electron-launcher-app-h2o check
pnpm --filter @qpjoy/electron-launcher-app-h2o dev
```

The demo starts with a development broker registry so UI and broker-session states can be tested without a production socket. To verify the blocked embed path:

```sh
MX_H2O_BROKER_MODE=off pnpm --filter @qpjoy/electron-launcher-app-h2o dev
```

## AppCenter Link

MX-H2I ships H2O in its default AppCenter catalog:

- `appId`: `h2o`
- `packageName`: `@qpjoy/electron-launcher-app-h2o`
- `launcherMode`: `embed`
- `standaloneChannelProductId`: `mx-h2i`
- `networkScope`: `broker-session`
- `entrypoints.dev`: `workspace:demos/mx-app-h2o`

In development, open MX-H2I, connect as guest or employee, install AppCenter,
then install H2O from AppCenter. MX-H2I resolves `entrypoints.dev` to this
workspace package, records the installed version and path in its local cache,
and keeps operational details available from AppCenter's `Debug` button. Run
this package with `pnpm --filter @qpjoy/electron-launcher-app-h2o dev` to test
the embed UI directly.

In production, Internal admin should upsert the AppCenter record with the same
package name and the release version. The client-side AppCenter cache stores
`installedVersion`, `latestVersion`, `installSource`, `entrypoints`, install
path, last action, and recent logs; the remote DB keeps the authoritative latest
package/version and access policy.
