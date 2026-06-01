# Release Policy & Rollout

QPJoy treats npm as the immutable artifact store and `electron-server` as the
release decision layer. A package can be published to npm without becoming the
version every client should run.

## Concepts

- **Package version**: the npm tarball plus manifest/package metadata captured
  by the server sync job.
- **Release plan**: server-side policy for one target version. It controls
  channel, mode, rollout percentage, restart policy, and whether first-party
  plugins may auto-grant permissions.
- **Stable rollout bucket**: clients are assigned by
  `sha256(seed:targetId:installId) % 10000`, so increasing a rollout keeps the
  existing cohort and only adds new clients.
- **Client report**: every seen/applied/failed/restart-required action is sent
  back to `/api/v1/updates/report`.

## Modes

| Mode | Behavior |
| --- | --- |
| `manual` | Server exposes the available version; UI/manual flow applies it. |
| `notify` | Same as manual, but intended for stronger user-facing messaging. |
| `auto` | Client applies only when the target plugin is already installed. |
| `force` | Client may install or switch even when the plugin is missing. |
| `silent` | First-party/core path; same execution lane as force, but UI can hide it. |

## Restart policy

| Policy | Behavior |
| --- | --- |
| `none` | Apply without extra restart semantics. |
| `plugin` | Deactivate, install/switch, reactivate if grants still satisfy the manifest. |
| `app` | Active plugins are marked restart-required; inactive plugins can be staged. |
| `system` | Same as app, reserved for TUN/WireGuard/system-service changes. |

`@qpjoy/electron-market` itself is a host runtime. Current clients report
`restart_required` for market self updates; a future bootstrap loader can apply
the selected market version on next app boot.

Standalone Electron apps, such as the packaged HDO client, use
`targetKind: "game"` with a target id derived from the app name
(`QPJoy HDO` → `qpjoy-hdo`). These plans participate in the same canary bucket
and report `restart_required`, so the app can show an update prompt while the
installer/update-loader remains app-specific.

## Admin API

Server admin SPA exposes **发版** under `/admin/#/server/releases`.

Equivalent API:

```http
GET  /api/v1/admin/release-plans
POST /api/v1/admin/release-plans
POST /api/v1/admin/release-plans/:id/state
GET  /api/v1/admin/release-reports
```

Minimal release plan payload:

```json
{
  "name": "HDO 0.1.34 canary",
  "targetKind": "plugin",
  "targetId": "qpjoy.electron-plugin-hdo",
  "npm": "@qpjoy/electron-plugin-hdo",
  "targetVersion": "0.1.34",
  "channel": "canary",
  "mode": "auto",
  "restartPolicy": "plugin",
  "rollout": { "percentage": 1, "platforms": ["darwin"] },
  "autoGrant": "manifest",
  "autoActivate": true
}
```

Rollback is a new release plan whose `targetVersion` is the previous stable
version. Use `mode: "force"` for emergency rollback, or `mode: "auto"` for a
softer staged rollback.

## Client API

Clients call:

```http
POST /api/v1/updates/check
POST /api/v1/updates/report
```

`@qpjoy/electron-market` now starts an update agent when `serverBaseUrl` is
configured. It reports `installId`, platform, arch, host app version, market
version, and installed plugin states, then applies supported actions.

Current safe default:

- public/manual marketplace updates keep working as before;
- official installed plugins can be remotely switched between versions;
- active plugins with `restartPolicy: app|system` are not hot-swapped and are
  recorded as restart-required;
- market self updates are recorded as restart-required;
- standalone app updates are matched by app id/name and recorded as
  restart-required.
