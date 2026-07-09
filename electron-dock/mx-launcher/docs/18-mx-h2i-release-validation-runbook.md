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
pnpm --dir electron-dock/mx-launcher/server smoke:release-center http://10.88.88.88:18090
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
http://192.168.1.4:18090/admin/
```

`192.168.1.4` is the LAN/admin entrance. `10.88.88.88` is the V2 launcher-network
entrance that should be recorded in release artifact URLs through `MX_PUBLIC_BASE_URL`.

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
corepack enable
pnpm --dir electron-dock/mx-launcher install --frozen-lockfile
pnpm --dir electron-dock/mx-launcher ignored-builds
pnpm --dir electron-dock/mx-launcher/demos/mx-h2i make:win
```

`ignored-builds` should print no pending packages. The mx-launcher workspace records the
required pnpm build-script approvals in `package.json` so Windows workers with strict dependency
build policy do not stop on `ERR_PNPM_IGNORED_BUILDS` for Quasar/Vite's `@parcel/watcher`.
Do not use an interactive `pnpm approve-builds` result as the release source of truth.

The Windows package still runs the Electron UI as `asInvoker`. WireGuard, NRPT split DNS, and
route-priority repair are owned by the WireGuard service/UAC path. The launcher keeps Internal
domains on the standalone-owned local PAC edge and suppresses interface DNS when that resolver
policy is prepared, so Clash/mihomo TUN or system proxy can keep owning unmatched traffic. The
Windows UAC wrapper uses the HDO V1 hidden `RunAs` pattern; macOS LaunchDaemon/PAC behavior is
not changed by this packaging gate.

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
  --base-url http://192.168.1.4:18090 \
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

The `--base-url` above is only the admin/control-plane address used by the publish script. When
the server has `MX_PUBLIC_BASE_URL=http://10.88.88.88:18090`, uploaded private OSS/server artifacts
are recorded with the V2-reachable download URL.

## Layer 5.5: Complete Release Gate

An uploaded installer plan is `blocked` until the required E2E gate is completed. This is expected:
the artifact has been registered, but it is not yet eligible for rollout.

From Admin, open the release drawer and click `Complete gate` after the DMG/EXE has passed the
manual smoke checklist. The plan should change from `blocked` to `ready`; the remaining next action
is release approval / rollout selection.

Without the Admin action, create a replacement plan with `--e2e-result passed` after testing the
artifact:

```bash
pnpm --dir electron-dock/mx-launcher/server release:publish -- \
  --base-url http://192.168.1.4:18090 \
  --kind installer \
  --storage oss \
  --platform darwin \
  --artifact electron-dock/mx-launcher/demos/mx-h2i/out/electron-builder/MX-H2I-0.2.0-mac-universal.dmg \
  --current-version 0.1.0 \
  --version 0.2.0 \
  --channel smoke \
  --e2e-result passed
```

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

## Layer 6.5: Update Executor Pipelines

The shared executor lives in `@qpjoy/electron-launcher/release-update-executor` and follows the
docs/17 state machine (`idle -> checking -> downloading -> verifying -> staged -> activating ->
reported`). Validate each artifact class end to end before rolling it out:

1. **Config / feature flag**: publish a `config-snapshot` plan with `hotUpdateAuto=true`; expect
   the client to report `artifact-staged` then `artifact-applied`, the active file to land under
   `<userData>/update-slots/config/`, and `rollback('config')` to restore the previous slot with
   an `artifact-rolled-back` report.
2. **Renderer bundle**: same flow against the `renderer` slot; the product's `applyRenderer`
   callback reloads the window.
3. **npm package**: publish a `launcher-npm` artifact; expect `artifact-staged-pending-restart`,
   a pointer under `<userData>/launcher-packages/<component>.pending.json`, and adoption on next
   start (`adoptPendingElectronLauncherPackages`).
4. **Installer completion**: after the user installs a staged DMG/EXE and the new version starts,
   expect one `installer-completed` report carrying `{ from, to }` — Release Center marks the
   install as upgraded; missing reports count against gray-rollout health.

Stability boundary: while the product is `connecting` / `recovering` / `permission-required`,
activation defers with an `artifact-activation-deferred` report and the staged slot stays intact.
Re-run pipelines 1 and 3 in the dual-standalone coexistence scenarios (C11 in
`scripts/coexist-check.mjs run`) to prove per-channel update schedulers do not interfere.

## Layer 6.6: Ten-Minute Gray Release Sanity Check

Lightest end-to-end proof that targeting + notes + hot pipeline work on a real
deployment. Uses only the Admin form and one dev-run client. Prerequisites: the
redeployed Internal server (has `/release/check`) and an mx-h2i started from
the workspace (`pnpm dev` — the packaged 2.0.0 client predates the executor
wiring and only shows check/download/staged).

1. **发一版只给自己**：Admin → Release Center → `Upload version` → Type
   `Hot update bundle`，随便选一个小文件当 renderer bundle，Version 填一个比
   当前高的号，`目标用户` 只填自己的 userId，Release notes 写两行 → Upload and
   create → 行内 `Open` → `Complete gate`。
2. **被圈中的客户端**：自己的 mx-h2i 点检查更新 → Release/Gray 面板应出现
   目标版本、`Matched by = 指定用户`、Release notes 原文 → 点下载 → 热更自动
   激活（状态 `applied`，历史里有 `hot-apply`）。
3. **未被圈中的客户端**：另一个账号（或把 targets 改掉再查）→ 检查更新显示
   已是最新，看不到任何计划信息。
4. **百分比灰度（可选）**：CLI 发一个 `--rollout-percentage 50 --rollout-strategy
   gray` 不带 targets 的 plan，多台 install 各自检查更新 → 约一半命中，面板
   显示 `灰度命中（bucket N）`；把百分比提到 100 重发同 series，之前命中的
   仍命中（sticky）。
5. **证据链**：服务端每次 check 落 `release-check` report，客户端沿途上报
   `download-started / artifact-staged / artifact-applied`，在 Internal 审计里
   能按 installId 串起来。

Installer 类走同样的目标圈选，但激活永远手动：`ready-to-install` 后由用户确认
打开，新版本首启回报 `installer-completed`。

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

## Appendix: H2O State Snapshot & Restore

客户端在每次持久化 runtime 时，会把 `runtime.apps`（含 H2O 订阅、当前订阅、
分流规则）快照到 `<userData>/state-backups/apps-<timestamp>.json`，按 H2O
客户端自有字段去重，只保留最近 5 份。用途：当 merge/normalize 回归把 H2O
订阅清空并覆写持久化文件时（历史案例：`mergeAppCenterCatalogApps` 回归），
可以从快照恢复。

恢复步骤（任选其一）：

1. **应用内恢复**：打开 mx-h2i 的 DevTools 控制台执行：

   ```js
   await window.mxH2i.listStateBackups()          // 列出快照及订阅/规则数量
   await window.mxH2i.restoreStateBackup('<file>') // 恢复指定快照并持久化
   ```

2. **手工恢复**：关闭应用，把快照文件里的 `apps` 对象覆盖到
   `<userData>/mx-h2i-runtime.json` 的 `apps` 字段后重启。

`<userData>` 位置：macOS `~/Library/Application Support/mx-h2i`，Windows
`%APPDATA%/mx-h2i`（以 Electron `app.getPath('userData')` 实际值为准）。
