# MX-H2I Release Validation Runbook

This runbook is for validating Release Center before giving MX-H2I packages to other users.
It separates the current control-plane validation from the future client updater executor.

## Current State

Ready now:

- Internal/Postgres owns release decisions.
- Admin Release Center can list plans and create hot-update or MX-H2I installer plans.
- Release policy can distinguish hot updates from full installer updates.
- Release plans can carry artifact URL, digest, rollout, gate, and activation metadata.
- Release Center can host uploaded artifacts in OSS or the Internal artifact store.

Not complete yet:

- MX-H2I client does not yet hot-swap renderer/asar/config artifacts or restart itself after
  applying a full installer.
- Real OSS credentials still need to be supplied and verified in the target k8s environment.

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

## Layer 5: Publish Artifact

By default, the publish script uploads the local file to the Internal Release Center artifact
store, receives a download URL, then creates the release plan with that URL, sha256 digest, and
size. The default store path is:

```text
artifacts/release-center/
```

Storage behavior:

- k8s Admin upload defaults to `storage=oss`; choose `Internal server` in the drawer to store
  the artifact under the server.
- CLI publish defaults to `storage=auto`: use OSS when configured, otherwise server storage.
- Local server runs can put these values in `electron-dock/mx-launcher/server/.env`. Runtime
  environment variables and k8s Secrets take precedence over `.env` values.
- Set `MX_RELEASE_ARTIFACT_STORE_DIR` on the server if Internal server storage needs a
  persistent mounted volume.
- Set `MX_RELEASE_ARTIFACT_MAX_BYTES` to override the default 2 GiB upload limit.

OSS server-side configuration:

```bash
MX_RELEASE_OSS_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com
MX_RELEASE_OSS_BUCKET=mx-release
MX_RELEASE_OSS_ACCESS_KEY_ID=...
MX_RELEASE_OSS_ACCESS_KEY_SECRET=...
MX_RELEASE_OSS_SECURITY_TOKEN=
MX_RELEASE_OSS_PREFIX=mx-h2i/releases
MX_RELEASE_OSS_PUBLIC_BASE_URL=
```

In k8s, create an optional `mx-release-oss` secret in `mx-internal-shadow` with the same keys.
The Internal API deployment already imports that secret when present:

```bash
kubectl -n mx-internal-shadow create secret generic mx-release-oss \
  --from-literal=MX_RELEASE_OSS_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com \
  --from-literal=MX_RELEASE_OSS_BUCKET=mx-release \
  --from-literal=MX_RELEASE_OSS_ACCESS_KEY_ID=... \
  --from-literal=MX_RELEASE_OSS_ACCESS_KEY_SECRET=... \
  --from-literal=MX_RELEASE_OSS_SECURITY_TOKEN= \
  --from-literal=MX_RELEASE_OSS_PREFIX=mx-h2i/releases \
  --from-literal=MX_RELEASE_OSS_PUBLIC_BASE_URL=
```

If `MX_RELEASE_OSS_PUBLIC_BASE_URL` is set, release plans use the direct OSS/CDN URL. Without
it, the plan uses the Internal download endpoint, which redirects to a short-lived OSS signed
URL. Keep the bucket private unless a separate CDN/public-read release channel is intentionally
configured.

`MX_RELEASE_OSS_ENDPOINT` can be either the region endpoint (`https://oss-cn-hangzhou.aliyuncs.com`)
or the bucket host (`https://mx-launcher.oss-cn-hangzhou.aliyuncs.com`). Keep
`MX_RELEASE_OSS_BUCKET=mx-launcher` in both cases.

For temporary STS credentials, fill `MX_RELEASE_OSS_ACCESS_KEY_ID`,
`MX_RELEASE_OSS_ACCESS_KEY_SECRET`, and `MX_RELEASE_OSS_SECURITY_TOKEN` with the STS values. This is
useful for short-lived server runs; production should prefer a RAM role / Secret that can be rotated.

Register and upload the artifact:

```bash
pnpm --dir electron-dock/mx-launcher/server release:publish -- \
  --base-url http://100.89.0.12:18090 \
  --kind installer \
  --storage oss \
  --platform darwin \
  --artifact electron-dock/mx-launcher/demos/mx-h2i/out/electron-builder/MX-H2I-0.2.0-mac-universal.dmg \
  --current-version 0.1.0 \
  --version 0.2.0 \
  --channel stable \
  --e2e-result running
```

For Windows, use `--platform win32` and point `--artifact` at the EXE/MSI. If an external object
store or CDN URL is already available, pass `--artifact-url <url>` to skip upload. Pass
`--upload=internal` to force upload even when an external URL is provided.

The script computes `sha256:<digest>` from the local file and creates an MX-H2I installer
release plan with:

- `launcherUpdatePolicy=mx-h2i-installer`
- `artifactKind=mx-h2i-installer`
- `activationMode=installer-manual`
- `artifactUrl=<download-url>`
- `artifactDigest=sha256:<digest>`
- `artifactSizeBytes=<bytes>`
- `artifactPlatform=darwin|win32|linux`
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
