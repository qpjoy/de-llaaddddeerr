# MX Launcher 全量安装包发版操作手册

本文是 Release Center V1 的实际发版手册。V1 只解决一件事：把一个 standalone
launcher 从旧版本升级到新版本，例如 MX-H2I `2.0.1 -> 2.0.3`。客户端检查到版本后
下载完整安装包、校验 sha256，并调用系统打开 DMG/PKG/EXE/MSI；最后一步安装仍由用户
确认。热更新不属于本文的首要交付范围。

同一套流程按 `productId + channel + platform + arch` 隔离，因此也可用于 Luopan 或其他
standalone launcher。

## 1. 发版模型

一个可下载版本由两部分组成：

1. artifact：真实安装包及 `sha256 / size / fileName / platform / arch`；
2. release plan：应用、版本、通道、gate、目标用户以及 artifact URL。

客户端只调用单机决策接口，不读取后台完整计划：

```text
POST /internal/v1/release/check
  product component + currentVersion + channel + platform + arch
                         |
                         v
  只返回该应用、该系统、该 CPU 架构允许获得的一个版本
```

安装包使用通用类型 `app-installer`。历史类型 `mx-h2i-installer` 仍可读取，但新版本不要
再用它发布 Luopan 或其他应用。

不填写目标用户/安装 ID 时，Admin 自动创建 `all / 100%` 全量计划。填写任一目标 ID 时，
自动变为定向计划；不会再出现“manual-ring 0% 且无人命中”的空发布。

## 2. OSS 一次性配置

建议建立私有 bucket。Internal server 持有 OSS 凭据，Admin 浏览器和客户端都不持有
AccessKey。RAM 身份至少需要目标前缀的 PutObject/GetObject 权限。

服务端环境变量：

```bash
MX_RELEASE_ARTIFACT_STORAGE=oss
MX_RELEASE_OSS_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com
MX_RELEASE_OSS_BUCKET=mx-launcher
MX_RELEASE_OSS_ACCESS_KEY_ID=...
MX_RELEASE_OSS_ACCESS_KEY_SECRET=...
MX_RELEASE_OSS_SECURITY_TOKEN=
MX_RELEASE_OSS_PREFIX=mx-launcher/releases
MX_RELEASE_OSS_PUBLIC_BASE_URL=
MX_RELEASE_OSS_SIGNED_URL_TTL_SECONDS=3600
MX_PUBLIC_BASE_URL=http://10.88.88.88:18090
```

私有 bucket 必须让 `MX_RELEASE_OSS_PUBLIC_BASE_URL` 保持为空。计划保存 Internal 下载
地址；客户端下载时先到 Internal，再 302 到一条短期 OSS 签名 URL。只有配置了公开读
CDN 时才填写 public base URL。

k8s 示例：

```bash
kubectl -n mx-internal-shadow create secret generic mx-release-oss \
  --from-literal=MX_RELEASE_OSS_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com \
  --from-literal=MX_RELEASE_OSS_BUCKET=mx-launcher \
  --from-literal=MX_RELEASE_OSS_ACCESS_KEY_ID='<access-key-id>' \
  --from-literal=MX_RELEASE_OSS_ACCESS_KEY_SECRET='<access-key-secret>' \
  --from-literal=MX_RELEASE_OSS_SECURITY_TOKEN='' \
  --from-literal=MX_RELEASE_OSS_PREFIX=mx-launcher/releases \
  --from-literal=MX_RELEASE_OSS_PUBLIC_BASE_URL=''
```

若 Secret 已存在，用当前集群的 Secret 更新流程替换，不要先删除生产 Secret。

## 3. OSS 对象目录

后台上传后使用固定布局：

```text
<prefix>/<productId>/<channel>/<version>/<platform>/<arch>/<releaseId>/<fileName>
```

示例：

```text
mx-launcher/releases/mx-h2i/stable/2.0.3/darwin/universal/
  mx-h2i-darwin-universal-2.0.3-20260722-123456/MX-H2I-2.0.3-mac-universal.dmg

mx-launcher/releases/mx-h2i/stable/2.0.3/win32/x64/
  mx-h2i-win32-x64-2.0.3-20260722-123501/MX-H2I-Setup-2.0.3.exe

mx-launcher/releases/luopan/stable/0.1.1/darwin/arm64/
  luopan-darwin-arm64-0.1.1-20260722-123600/Luopan-0.1.1-arm64.dmg
```

OSS 控制台需要做的操作只有：

1. 创建/确认私有 bucket 和 RAM 权限；
2. 上传后确认对象出现在上述 product/platform/arch 目录；
3. 保留对象，不要在计划创建后重命名或移动；
4. 旧对象设置生命周期前，先确认不再承担回滚或旧客户端升级。

正常发版不要在 OSS 控制台手工上传。Admin 上传会同时完成 digest、metadata 和计划创建，
避免出现“OSS 有文件但 Release Center 无记录”。

## 4. 构建安装包

版本号必须先写入应用自己的 `package.json`，且必须与 Release Center 的 Version 完全相同。
MX-H2I 当前发版目标是 `2.0.3`。

macOS 建议在 macOS 签名机器构建：

```bash
pnpm --dir electron-dock/mx-launcher/demos/mx-h2i check
pnpm --dir electron-dock/mx-launcher/demos/mx-h2i make:mac:dmg
```

当前命令产出 universal DMG，对应：

```text
Platform = macOS (darwin)
Architecture = Universal
```

如果改为分别构建 Intel 与 Apple Silicon，则上传两个记录：`darwin/x64` 和
`darwin/arm64`，不要把单架构包标为 universal。

Windows 应在 Windows 或 Windows CI worker 构建并签名：

```powershell
corepack enable
pnpm --dir electron-dock/mx-launcher install --frozen-lockfile
pnpm --dir electron-dock/mx-launcher/demos/mx-h2i make:win
```

当前命令产出 x64 安装器，对应：

```text
Platform = Windows (win32)
Architecture = x64
```

Windows ARM64、x86 如果以后提供，必须分别上传 `win32/arm64`、`win32/ia32`。macOS
和 Windows 是两个独立 artifact/plan，可以使用相同目标版本，但不能共用文件。

## 5. Admin 发版步骤

打开 `Admin -> Release Center -> Upload installer`（`Upload version` 也进入同一表单）。

以 MX-H2I `2.0.1 -> 2.0.3` 的 macOS 包为例：

```text
Product       mx-h2i
File          MX-H2I-2.0.3-mac-universal.dmg
Type          Full installer
Platform      macOS
Architecture  Universal
Storage       OSS direct
Version       2.0.3
Current       2.0.1
Channel       stable
Gate          passed（已完成安装验证）
目标用户       留空（全量）
目标安装       留空（全量）
Release notes 本次更新说明
```

点击 `Upload and create`。成功后打开新行并检查：

- Product 是 `mx-h2i`；
- Artifact 是 `app-installer`；
- Platform/Arch 与文件一致；
- Gate 是 `passed`，Status 是 `ready`；
- Rollout 是 `all 100%`；
- URL、digest、size 和 fileName 都存在。

Windows 再重复一次，只替换：

```text
File          MX-H2I-Setup-2.0.3.exe
Platform      Windows
Architecture  x64
```

若安装包尚未完成验证，把 Gate 选为 `running`。验证完后在计划抽屉点击
`Complete gate`，再让正式客户端检查更新。

只给一名测试者时，在“目标用户”填该用户的 userId；只给一台机器时填 installId。
定向计划不影响未被圈中的客户端。

## 6. CLI 等价操作

macOS universal：

```bash
pnpm --dir electron-dock/mx-launcher/server release:publish -- \
  --base-url http://192.168.1.4:18090 \
  --product mx-h2i \
  --kind installer \
  --storage oss \
  --platform darwin \
  --arch universal \
  --artifact electron-dock/mx-launcher/demos/mx-h2i/out/electron-builder/MX-H2I-2.0.3-mac-universal.dmg \
  --current-version 2.0.1 \
  --version 2.0.3 \
  --channel stable \
  --e2e-result passed \
  --notes 'MX-H2I 2.0.3 full installer'
```

Windows x64：

```powershell
pnpm --dir electron-dock/mx-launcher/server release:publish -- `
  --base-url http://192.168.1.4:18090 `
  --product mx-h2i `
  --kind installer `
  --storage oss `
  --platform win32 `
  --arch x64 `
  --artifact electron-dock/mx-launcher/demos/mx-h2i/out/electron-builder/MX-H2I-Setup-2.0.3.exe `
  --current-version 2.0.1 `
  --version 2.0.3 `
  --channel stable `
  --e2e-result passed
```

Luopan 只需把 `--product` 和文件/版本替换为 Luopan：

```bash
pnpm --dir electron-dock/mx-launcher/server release:publish -- \
  --base-url http://192.168.1.4:18090 \
  --product luopan --kind installer --storage oss \
  --platform darwin --arch arm64 \
  --artifact <Luopan-arm64.dmg> \
  --current-version 0.1.0 --version 0.1.1 \
  --channel stable --e2e-result passed
```

## 7. 客户端验收

1. 启动旧版本，确认 Channel 与发布通道一致；
2. 点击“检查更新”；
3. 应显示目标版本、`app-installer`、正确的 platform/arch 和 release notes；
4. 点击“下载更新”；
5. 客户端下载、校验 size + sha256，并以原始 `.dmg/.exe` 文件名保存；
6. 系统打开安装器，用户完成覆盖安装；
7. 新版本首次启动上报 `installer-completed {from,to}`；
8. 再次检查应显示“已经是最新版本”。

客户端版本高于后台目标版本时，Release Center 不会自动降级。回滚使用客户端保留的历史
安装包手工打开，或发布一个版本号更高的修复版。

运行服务端 smoke 可同时验证 macOS/Windows 选包、架构隔离、下载文件名、历史记录以及
禁止自动降级：

```bash
pnpm --dir electron-dock/mx-launcher/server smoke:release-center http://10.88.88.88:18090
```

## 8. 常见问题

- 客户端仍显示最新：先检查 channel；再检查 plan 是否 `passed/ready`；最后检查是否错误
  填了目标用户。全量计划应是 `all 100%`。
- 下载按钮不可用：plan 中通常缺 artifact URL，删除空计划并用 Upload installer 重发。
- macOS 拿不到包：检查 `darwin + process.arch`；单架构包不要标 universal 以外的错误架构。
- Windows 拿到 macOS 包：这是旧计划缺少 platform/arch；用新 Admin 分平台重发。
- 下载后文件无扩展名：新计划必须带 `artifactFileName`；使用 Upload installer 或新版 CLI。
- OSS 403：检查 Internal server 的 RAM GetObject 权限和系统时间；私有桶不要把裸 OSS URL
  手填进计划，使用 Internal artifact download URL。
- 历史出现 `release / UNKNOWN`：升级 Internal server 和客户端后，客户端使用
  `/internal/v1/releases/history` 的过滤结果，不再读取后台完整计划列表。
