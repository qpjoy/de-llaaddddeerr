# MX-H2I Release Validation Runbook

This runbook is for validating Release Center before giving MX-H2I packages to other users.
It separates the current control-plane validation from the future client updater executor.

## Current State

Ready now:

- Internal/Postgres owns release decisions.
- Admin Release Center can list plans and create hot-update or MX-H2I installer plans.
- Release policy can distinguish hot updates from full installer updates.
- Release plans can carry artifact URL, digest, rollout, gate, and activation metadata.

Not complete yet:

- MX-H2I client does not yet hot-swap renderer/asar/config artifacts or restart itself after
  applying a full installer.
- Release Center does not yet host uploaded MX-H2I installers itself; use an internal HTTP
  object store, nginx/Caddy path, OSS, or CDN URL as `artifactUrl` for now.

## Layer 1: Server Smoke

Run this against the updated Internal server:

```bash
pnpm --dir electron-dock/mx-launcher/server smoke:release-center http://100.89.0.12:18090
```

Expected result:

- health check passes;
- `renderer-ui` policy returns `automatic`;
- `mx-h2i-installer` policy returns `mandatory`;
- one hot-update plan is created with `hotUpdateAuto=true`;
- one installer plan is created with `majorUpdateRequiresInstaller=true`;
- both plans appear in `/internal/v1/release-management/plans`.

This smoke creates `rel_smoke_*` plans. It does not download, install, restart, or touch
WireGuard/PAC/DNS.

## Layer 2: Admin UI Check

Open:

```text
http://100.89.0.12:18090/admin/
```

Verify:

- Internal -> Release Center opens the registry table.
- `Refresh plans` reloads without error.
- `Plan hot update` creates a hot plan and opens the drawer.
- `Plan MX-H2I` creates an installer plan and opens the drawer.
- Drawer shows artifact, rollout, gate, client behavior, and next actions.
- Status is `ready` only when E2E gate is passed.

## Layer 3: MX-H2I Client Check

On an MX-H2I client pointed at the same Internal server:

- open `高级选项` or the footer update entry;
- click `检查更新`;
- verify the Release / Gray panel shows `Status`, `Release`, `Artifact`, and `Activation`;
- for hot plans, expect `Policy=automatic` and `Activation=hot-auto`;
- for major plans, expect `Policy=mandatory` and `Activation=installer-manual`;
- no WireGuard/PAC/DNS permission prompt should appear during this check.

Then validate the updater executor:

- click `下载并打开` for an installer plan;
- confirm the native dialog;
- expect `Status=ready-to-install` after the file downloads and sha256 matches;
- the installer should open through the OS, but MX-H2I should not restart by itself;
- for hot artifacts, expect `Status=staged`; hot replacement is intentionally still deferred.

Downloaded files are staged under the MX-H2I user data directory:

```text
<userData>/updates/<releaseId>/<artifact-file>
```

The client reports `download-started`, `installer-downloaded` or `artifact-staged`, and
`installer-opened` or `download-failed` to `/internal/v1/release/reports`.

## Layer 4: Build A Test Package

For the MX-H2I demo package:

```bash
pnpm --dir electron-dock/mx-launcher/demos/mx-h2i check
pnpm --dir electron-dock/mx-launcher/demos/mx-h2i make:mac:dmg
```

The output is under:

```text
electron-dock/mx-launcher/demos/mx-h2i/out/electron-builder/
```

Generate a digest:

```bash
shasum -a 256 electron-dock/mx-launcher/demos/mx-h2i/out/electron-builder/*.dmg
```

For Windows, build on Windows or a configured CI worker:

```bash
pnpm --dir electron-dock/mx-launcher/demos/mx-h2i make:win
```

## Layer 5: Publish Artifact URL

Until the Release Center artifact upload endpoint exists, put the installer somewhere users can
download from the H2I network path, for example:

- Internal nginx/Caddy static directory;
- OSS/CDN with private token or signed URL;
- a Domestic cache URL reachable before/after H2I connection.

Register the artifact in Release Center:

```bash
pnpm --dir electron-dock/mx-launcher/server release:publish -- \
  --base-url http://100.89.0.12:18090 \
  --kind installer \
  --artifact electron-dock/mx-launcher/demos/mx-h2i/out/electron-builder/MX-H2I-0.2.0-mac-universal.dmg \
  --artifact-url https://release.example.internal/mx-h2i/MX-H2I-0.2.0-mac-universal.dmg \
  --current-version 0.1.0 \
  --version 0.2.0 \
  --channel stable \
  --e2e-result running
```

The script computes `sha256:<digest>` from the local file and creates an MX-H2I installer
release plan with:

- `launcherUpdatePolicy=mx-h2i-installer`
- `artifactKind=mx-h2i-installer`
- `activationMode=installer-manual`
- `artifactUrl=<download-url>`
- `artifactDigest=sha256:<digest>`
- `rolloutStrategy=manual-ring` for first testers.

## Layer 6: First External Tester

Give the first tester only the signed DMG/EXE link.

Checklist:

- app opens on a clean machine;
- guest connect succeeds with one permission flow;
- employee login succeeds without repeated permission prompts;
- AppCenter entry opens;
- Release Center plan can target the tester `installId` or channel;
- disconnect/reconnect does not remove other standalone products' routes;
- logs/reporting show the tester install id.

## Layer 7: Toward No Manual Distribution

To stop manually sending files completely, finish the remaining updater executor work:

1. Add Release Center artifact upload or OSS-backed signed URL issuance.
2. Poll periodically or on app startup, with backoff and quiet hours.
3. Verify artifact signatures in addition to sha256 digests.
4. Apply hot renderer/config/asar artifacts from the staged slot when
   `activation.hotUpdateAuto=true`, then show a dismissible toast.
5. For `installer-manual`, keep the current explicit prompt and OS-open flow; add a clear
   restart/install completion report after the new app version starts.
6. Defer activation while MX-H2I is connecting, recovering, or asking for network permission.

After that executor exists, normal releases become:

```text
build -> upload artifact -> create Release Center plan -> gate -> gray rollout -> auto client update
```
