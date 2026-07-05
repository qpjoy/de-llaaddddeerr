# MX-H2I Release Center and Update System

This document defines the MX-H2I update system for standalone and embed launcher evolution.
The goal is to support hot updates, full installer updates, rollback, gray rollout, feature
gates, and admin management without touching the already-stable connection path.

## Decision

- The client checks Internal Release Center, backed by PostgreSQL records.
- npm is an input source for Release Center, not the client-side source of truth.
- CI or an admin sync imports npm/package metadata, asar bundles, renderer bundles, config
  snapshots, installer artifacts, digests, signatures, release notes, and gate evidence into
  Internal.
- MX-H2I clients only consume signed Internal release decisions and artifact refs.
- Update checks must not restart WireGuard, PAC, DNS, lease refresh, or the employee/guest
  connect flow.

## Artifact Classes

| Class | Examples | Default mode | Activation | Notes |
| --- | --- | --- | --- | --- |
| Config snapshot | DNS, PAC, route policy, feature flags | automatic | hot | Signed snapshot, no app restart. |
| Renderer UI | MX-H2I screens, AppCenter shell UI | automatic | hot/reload | Toast after apply; rollback to previous bundle. |
| Launcher npm | `@qpjoy/mx-launcher-*` package build output | automatic | hot or restart | Client does not run npm install; Release Center serves a built artifact. |
| asar | renderer/app asar | automatic | restart when needed | Main/preload changes require restart; renderer-only can reload. |
| AppCenter app | embed apps and app-scoped assets | manual/automatic by policy | hot/reload | App owner policy can allow skip, defer, or app-only rollback. |
| MX-H2I installer | DMG/EXE/MSI full app package | mandatory/manual confirm | installer restart | Required for Electron/runtime/native helper/main-process breaking changes. |
| Native helper | WireGuard helper, privileged service, launch daemon | mandatory/manual confirm | privileged restart | Must pass gate and never run inside active connect. |

## Client Flow

1. Client sends `installId`, `userId`, `channel`, current component versions, platform, and
   capability summary to Internal.
2. Internal evaluates Release Center plans, rollout rules, feature gates, and E2E evidence.
3. Internal returns a decision with artifact refs, digest/signature, activation mode, and
   update mode.
4. Client downloads through Internal/Domestic cache when needed, verifies digest/signature,
   stages atomically, and reports progress.
5. Hot updates apply automatically when allowed, then show a dismissible toast.
6. Full installer updates prompt the user, download the signed package, install, and restart
   only after explicit confirmation.
7. If the client is connecting or reconnecting, update activation is deferred until the
   network session is stable.

## Stability Boundary

Update checks are read-only. They may fetch Release Center JSON and artifact metadata, but they
must not:

- reinstall or restart WireGuard,
- rewrite PAC/DNS during connect,
- release or renew the H2I lease,
- change route preference while employee login is in progress,
- request privileged permission unless a staged artifact explicitly requires activation.

The update executor should keep a small local state machine:

`idle -> checking -> downloading -> verifying -> staged -> activating -> reported`

Activation is blocked when MX-H2I is in `connecting`, `recovering`, or `permission-required`
network states. Full installer activation is always manual.

## Release Center Data Model

`ReleaseManagementPlan` is the admin-facing unit:

- `components`: launcher/app decisions with current and target versions.
- `artifacts`: signed artifact refs with kind, source, URL, digest, activation mode, and
  restart requirement.
- `rollout`: channel, percentage, rings, segment, feature keys, and canary metric gate.
- `activation`: whether hot auto apply, toast, restart, full installer, and manual confirm
  are required.
- `test`: E2E run and gate verdict.
- `decisions`: promote/approval/canary/rollback next actions.

`ReleaseTask` remains the client execution unit. Future tasks should include:

- `config-refresh`
- `artifact-update`
- `npm-package-update`
- `asar-update`
- `installer-update`
- `feature-flag-update`
- `service-repair`

## Admin UX

The k8s admin Release Center should follow the User Center pattern:

- top operation group for search, channel/status/artifact filters, refresh, hot update plan,
  and MX-H2I major plan;
- table rows for release id, components, artifacts, rollout, gate, status, and quick actions;
- right drawer for release state, artifact refs, rollout/gate, client behavior, and next
  actions;
- per-row quick actions for open/evaluate first, later promote/pause/rollback after Action
  Gate is wired;
- no flat panel sprawl.

## Gray Rollout and Feature Gates

Rollout targeting should be additive and explainable:

- channel: `shadow`, `internal`, `canary`, `stable`;
- ring: `internal-dogfood`, `canary`, `stable`;
- percentage hash by install id or user id;
- scope filters: site, OS, app version, capability, role, user group;
- feature keys for partial functional opening;
- E2E gate and metric gate before auto promotion.

Feature opening is a config/feature-flag artifact. It can be hot-applied and rolled back
without shipping a new installer.

## Rollback

Every automatic artifact keeps a previous active slot:

- renderer/UI bundle: previous bundle directory;
- asar: previous staged asar;
- config snapshot: previous signed snapshot;
- feature flags: previous flag snapshot;
- AppCenter app: previous app artifact;
- installer/native helper: rollback requires explicit admin plan and may require a previous
  installer package.

Rollback is a Release Center action with evidence. The client reports rollback result back to
Internal.

## Practical Rule

Use hot updates for UI, config, feature flags, renderer-only assets, and safe package outputs.
Use full installer updates for Electron runtime, main/preload breaking changes, native helpers,
privileged services, dependency ABI changes, and anything that changes the connection substrate.
