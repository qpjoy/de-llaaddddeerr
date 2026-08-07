# AppCenter 插件包投递与更新机制

适用范围：AppCenter 里以 npm 包形式发布的插件（H2O、Diagnostics、MX Insight Hub…）。
与 MX-H2I 本体的 asar 热更新 / 全量安装包 / 灰度发布并行，不替代它们。

## Decision

插件的**身份**是 npm 包（`name` + semver + dist-tag），插件的**投递**是带完整性校验的
tarball 下载，客户端不 spawn `npm` / `pnpm`。

理由：

- 打包后的 Electron 里没有可靠的包管理器。Windows 上 `spawn npm` 长期失败
  （`ENOENT` / 不是内部或外部命令），而内置应用不应该要求用户先装 Node.js。
- `npm install` 会拉整棵依赖树，产物不确定，无法对「这次装了什么」做完整性校验。
- 走 CLI 就没有原子性：装到一半失败会留下半个 `node_modules`，没有回滚点。
- 复用 launcher 自己的网络栈（Host Resolve + SNI 覆写 + bootstrap DNS + system-only
  回退）意味着**公司网络里能取到 Internal API，就一定能取到插件包**，不需要为
  npm 单独配代理或改系统 registry。

保留 npm CLI 作为最后兜底：开发机上仍然可用，且不改变已有行为。

## 来源链

有序，第一个通过完整性校验的来源获胜。实现见
[`plugin-package-source.cjs`](../demos/mx-h2i/src/plugin-package-source.cjs)。

| 顺序 | id | kind | 默认值 | 覆盖方式 |
| --- | --- | --- | --- | --- |
| 1 | `registry` | registry | `https://registry.npmjs.org` | `MX_H2I_APPCENTER_REGISTRY` |
| 2 | `mirror` | registry | `https://registry.npmmirror.com` | `MX_H2I_APPCENTER_REGISTRY_MIRROR` |
| 3 | `oss` | tarball | 未配置则跳过 | `MX_H2I_APPCENTER_TARBALL_BASE` |

规则：

- `baseUrl` 相同的来源会被折叠，主源和镜像配成同一个地址不会白试一次。
- 非 http/https 的配置直接忽略并回落到默认值，避免把坏配置拨出去。
- registry 来源先取 packument（`{base}/{name 里的 / 转义成 %2f}`），再取
  `dist.tarball`；如果 packument 里的 tarball 指向公网 CDN，会被改写回**当前来源的
  host** —— 否则「配了镜像但仍然去 npmjs 下载」。
- OSS 来源按 npm pack 的文件名约定直接拼地址：
  `{base}/{qpjoy-electron-launcher-app-h2o}/{qpjoy-electron-launcher-app-h2o}-{version}.tgz`，
  CI 可以把 `npm pack` 的产物原样上传。

### OSS sidecar

OSS 直链没有 packument，完整性信息放在同名 `.json` sidecar 里：

```json
{ "version": "2.3.15", "integrity": "sha512-CrNq7eydS3XOk...", "shasum": "…" }
```

Release Center 上传 tarball 时一并生成。sidecar 取不到时该来源失败并继续下一个，
不会退化成「不校验直接装」。

## 完整性

- `dist.integrity`（`sha512-<base64>`）优先，回退 `dist.shasum`（sha1 hex）。
- 两者都没有时返回 `missing-integrity` 并判定失败。**未校验的 tarball 永远不算可安装产物。**
- 未知哈希算法同样判定为 `missing-integrity`，不会被静默接受。

## 解包

自带最小 ustar 解包器，不引入运行时原生依赖：

- 只处理普通文件，跳过目录/符号链接条目；支持 GNU long name。
- 剥掉 npm 的 `package/` 顶层前缀。
- 丢弃含 `..`、空段、以及绝对路径（`/x`、`C:\x`）的条目 —— tarball 是远端产物，
  必须假设它想写到 slot 之外。
- 落盘前再确认一次目标路径仍在 staging 目录内（防御性双检）。

## 安装 slot 与回滚

```
{userData}/appcenter-plugins/{appId}/
  v2.3.14/          <- 上一版，保留用于回滚
  v2.3.15/          <- 当前版
  v2.3.15.staging/  <- 仅在写入过程中存在
```

- 先写 `*.staging`，全部条目落盘后 `rename` 成正式 slot —— 中途失败不会污染已装版本。
- 只保留当前版 + 上一版，回滚够用又不会让缓存无限长大。
- `installPath` 指向 slot 目录，AppCenter 记录 `installedVersion` / `installSource` /
  `installedAt`，与既有 AppCenter 缓存字段一致。

## 与现有更新体系的关系

| 通道 | 载体 | 触发 | 激活 |
| --- | --- | --- | --- |
| MX-H2I asar 热更新 | asar | Release Center 计划 | 重启或 reload |
| MX-H2I 全量安装包 | DMG/EXE | Release Center 计划 | 用户确认后安装重启 |
| **AppCenter 插件** | **npm tarball** | **AppCenter 检查更新 / 灰度 dist-tag** | **重开插件窗口** |

插件更新**不触碰**网络会话：不重装 WireGuard、不改 PAC/DNS、不动 H2I lease。
插件正在运行时更新只写新 slot，下次打开生效。这和 `17-mx-h2i-release-center-update-system.md`
的 Stability Boundary 一致。

### 灰度

用 dist-tag 做灰度，不需要另一套版本表：

- `latest` — 全量用户
- `next` — 灰度组

AppCenter 记录里的 `latestVersion` 可以直接写 dist-tag（`selectPackumentVersion`
支持 tag 解析），Internal 按 rolloutGroup 决定给某台机器下发哪个 tag。
请求了不存在的版本时会回落到 `latest` 而不是让安装整体失败。

## 发布方清单

1. `npm version <x.y.z>` + `npm publish`（scoped 包需要 `--access public`）。
2. 可选：`npm pack` 产物上传到 OSS，并生成 `.json` sidecar。
3. Internal admin 更新 AppCenter 记录的 `packageName` / `latestVersion`（或 dist-tag）。
4. 灰度先发 `next`，验证通过后 `npm dist-tag add <pkg>@<ver> latest`。

## 覆盖的失败模式

| 场景 | 行为 |
| --- | --- |
| 本机没有 npm/pnpm | 直连路径不受影响，正常安装 |
| npmjs 不可达 | 自动降级到 mirror；仍不可达则走 OSS |
| 内网完全隔离 | 只配 `MX_H2I_APPCENTER_TARBALL_BASE` 指向 Internal 反代即可 |
| tarball 被篡改 | `integrity-mismatch`，该来源失败并继续下一个 |
| 下载中断 / 磁盘写一半 | staging 目录被丢弃，已装版本不受影响 |
| 新版插件起不来 | 上一版 slot 仍在，可切回 |

## 测试

`demos/mx-h2i/scripts/plugin-package-source.test.mjs`（已接入 `pnpm run check`）覆盖：
来源链折叠与降级、scoped 包 URL 转义、镜像 tarball 改写、dist-tag 与未知版本解析、
sha512/sha1 校验与缺失校验拒绝、`package/` 前缀剥离、路径穿越与绝对路径拦截。
