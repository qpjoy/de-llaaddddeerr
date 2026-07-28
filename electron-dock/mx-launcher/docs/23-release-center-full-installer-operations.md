# MX Launcher 全量安装包发版操作手册

本文是 Release Center V1 的实际发版手册。V1 只解决一件事：把一个 standalone
launcher 从旧版本升级到新版本，例如 MX-H2I `2.0.1 -> 2.0.3`。客户端检查到版本后
下载完整安装包、校验 sha256，并调用系统打开 DMG/PKG/EXE/MSI；最后一步安装仍由用户
确认。热更新不属于本文的首要交付范围。

同一套流程按 `productId + channel + platform + arch` 隔离，因此也可用于 Luopan 或其他
standalone launcher。

本文的 Admin/CLI 路径面向平台操作员。Luopan 或其他产品 CI 应使用产品隔离的
[Release Center 开发者 API](./25-release-center-developer-api.md)：service account
只获得 release scopes 和自己的 `allowedProductIds`，用户端仍使用既有 Consumer
check/history/report/download 接口。

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
MX_RELEASE_OSS_SECRET_SOURCE=env
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

把这些值写入 Internal 服务器上的 `electron-dock/mx-launcher/server/.env`。文件已被
gitignore，不要提交；AccessKey 轮换后只更新该文件并重新运行部署命令。

私有 bucket 必须让 `MX_RELEASE_OSS_PUBLIC_BASE_URL` 保持为空。计划保存 Internal 下载
地址；客户端下载时先到 Internal，再 302 到一条短期 OSS 签名 URL。只有配置了公开读
CDN 时才填写 public base URL。

`internal-production deploy` 会在构建镜像前先完成 Secret 预检，并在应用 workload 前执行：

1. 统一预检 `server/.env` 的 Secret 白名单；OSS materializer 只管理
   `mx-release-oss` 中 8 个 `MX_RELEASE_OSS_*` key，不会混入其他凭据；
2. 与已有 Secret 按显式 key 合并，保留省略项和 unknown data key，再校验 endpoint、
   bucket、必填凭据和 signed URL TTL；
3. 首次原子创建，更新时携带已观察到的 `resourceVersion` replace；并发修改会安全失败，
   修复或确认后重跑；
4. Secret 的非敏感 `resourceVersion` 变化时触发 Internal Deployment rollout；
5. 全新集群中 Secret 不存在时也会由同一条 deploy 命令重新创建。

正式部署仍只需：

```bash
TMPDIR=/data/tmp \
MX_K8S_OS_HOSTNAME=mx-internal-server \
MX_K8S_APISERVER_ADVERTISE_ADDRESS=192.168.1.2 \
MX_SHADOW_BUILDKIT_KEEP_STORAGE=2GB \
MX_SHADOW_BUILDKIT_PRUNE_UNTIL=24h \
bash scripts/manage.sh ops internal-production deploy
```

`MX_RELEASE_OSS_SECRET_SOURCE` 支持：

- `env`：声明式合并显式值；已有 Secret 时可只轮换一个 key。空的
  `SECURITY_TOKEN/PUBLIC_BASE_URL` 表示显式清空；首次创建仍须提供四个必填值；
- `auto`：非破坏性合并非空值，空白占位符和省略项保留集群现值；
- `external`：等待 KMS/Vault controller 生成 `mx-release-oss`，部署脚本不覆盖，但会严格
  校验 8 个已知 key；
- `disabled`：部署脚本不创建、更新或删除 OSS Secret；若集群已有 Secret，Pod 仍可读取它。

## 2.1 Config Center / Secret Center 边界

Config Center 提供 `secret-providers`、`secret-references` 和 runtime readiness API。Postgres
只保存 provider、remote ref、consumer、exposure、rotation 和 K8s target；接口主动拒绝
AccessKey、token、password、private key、`data`/`stringData` 等明文字段。

内置引用为：

```text
secretref_release_oss
  provider: secretprov_kubernetes_runtime
  consumer: release-center
  target: mx-internal-shadow/mx-release-oss
  exposure: signed-url
```

后续切换 Alibaba KMS 时，在 Admin / Config Center / Secret Center 登记 KMS provider 和
remote ref，再把 `MX_RELEASE_OSS_SECRET_SOURCE` 改为 `external`。KMS/ExternalSecret 的实际
认证和 materializer 必须先部署并能生成同名 K8s Secret；MX 不在 Postgres 中保存 KMS
明文。

其他应用的 Key 按“一应用、一用途、一引用”规划，不要继续追加到 `mx-release-oss`：

```text
KMS remote ref:  mx-launcher/<environment>/<appId>/<purpose>
Config ref ID:   secretref_<appId>_<purpose>
K8s Secret:      mx-app-<appId>-<purpose>
Consumers:       只列实际读取它的 server/worker/app service account
```

例如 Luopan 的第三方 API Key 使用 `secretref_luopan_partner_api`，MX-H2I 的独立签名服务
使用 `secretref_mx_h2i_signing`。应用客户端不能读取 K8s Secret；需要外部访问时只允许
`signed-url` 或受限、短期的 `temporary-sts`，不设计 raw-secret 下发模式。`server/.env`
当前只承担 Internal 基础设施的 bootstrap；应用 Key 最终都应迁入 KMS/Vault provider。

## 3. OSS 对象目录

后台上传后使用固定布局：

```text
<prefix>/<productId>/<channel>/<version>/<platform>/<arch>/<releaseId>/<sha256hex>/<fileName>
```

示例：

```text
mx-launcher/releases/mx-h2i/stable/2.0.3/darwin/universal/
  mx-h2i-darwin-universal-2.0.3-20260722-123456/<sha256hex>/MX-H2I-2.0.3-mac-universal.dmg

mx-launcher/releases/mx-h2i/stable/2.0.3/win32/x64/
  mx-h2i-win32-x64-2.0.3-20260722-123501/<sha256hex>/MX-H2I-Setup-2.0.3.exe

mx-launcher/releases/luopan/shadow/0.1.1/darwin/arm64/
  luopan-darwin-arm64-0.1.1-20260722-123600/<sha256hex>/Luopan-0.1.1-arm64.dmg
```

`sha256hex` 由服务端读取上传内容后计算，使用完整 64 位十六进制摘要。这样同一
product/version/releaseId/fileName 的不同内容会落到不同对象，不能覆盖已经通过 gate 的
artifact；相同摘要对应相同内容寻址路径。

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

electron-builder 会调用 Windows PowerShell 5.1 收集 pnpm 生产依赖。构建脚本会自动补入
`%SystemRoot%\System32\WindowsPowerShell\v1.0`；若预检仍失败，执行：

```powershell
$env:Path = "$env:SystemRoot\System32\WindowsPowerShell\v1.0;$env:SystemRoot\System32;$env:Path"
where.exe powershell.exe
powershell.exe -NoProfile -Command '$PSVersionTable.PSVersion'
```

如果最后一条仍无法运行，需要先恢复该 Windows 主机自带的 PowerShell 5.1，再重新执行
`make:win`。

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

下面两个 MX-H2I 示例走平台 Admin 兼容路由，执行 shell 必须由 Secret Manager 注入
`MX_INTERNAL_OPS_TOKEN`；脚本只把它放入 `x-mx-ops-token`，不会打印。产品开发者不要
获得这个 token，应使用后面的 scoped client credentials。

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

Luopan 当前固定使用 `channel=shadow`，而不是 MX-H2I 示例中的 `stable`。产品开发者
应在受保护的 Internal CI 使用账号独立的 `client_credentials`；完整的 artifactId、
定向验证、gate 和全量流程见 [docs/25](./25-release-center-developer-api.md)：

```bash
export MX_RELEASE_CLIENT_ID=svc_luopan_release_ci
# MX_RELEASE_CLIENT_SECRET 由 CI secret store 注入。
pnpm --dir electron-dock/mx-launcher/server release:publish -- \
  --base-url http://10.88.100.3:18090 \
  --product luopan --kind installer \
  --platform darwin --arch arm64 \
  --artifact <Luopan-arm64.dmg> \
  --current-version 0.1.0 --version 0.1.1 \
  --channel shadow --e2e-result running
```

先由 CI/受控验证机完成 digest、签名、安装与启动 smoke，再用 approve scope 过定向
gate；新 plan 的 gate 对外为 blocked（内部 E2E run 仍在 running），Consumer 也返回
blocked。gate passed 后才让圈定的 Luopan 客户端真机升级并回报，再按 docs/25 建立
全量计划。

脚本默认只创建待验证 plan。若自动加 `--approve`，必须提供结构化
`--approval-evidence <json-file>`；全量计划还必须加 `--confirm-full-rollout`。不要把
client secret 放进命令行，CI 只通过 `MX_RELEASE_CLIENT_SECRET` 注入。

## 7. 客户端验收

1. 启动旧版本，确认 Channel 与发布通道一致；
2. 点击“检查更新”；
3. 应显示目标版本、`app-installer`、正确的 platform/arch 和 release notes；
4. 点击“下载更新”；
5. 客户端下载、校验 size + sha256，并以原始 `.dmg/.exe` 文件名保存；
6. 系统打开安装器，用户完成覆盖安装；
7. 新版本首次启动上报 `installer-completed {from,to}`；
8. 再次检查应显示“已经是最新版本”。

客户端版本高于后台目标版本时，Release Center 不会自动降级。“大版本与回退”只展示同
channel、同 platform/arch、Gate passed 且全量发布的安装包；可选择旧版本执行明确的
“回退”，也可打开已经下载的安装包所在文件夹。需要回退到某个旧版本时，该版本必须仍有
Release Plan 和可下载 artifact。

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
- 下载后文件无扩展名：新版 Server 会把原始文件名放入 download URL，新版客户端还会按
  platform 补 `.dmg/.exe`。旧的无扩展名文件可以打开文件夹后按原始安装包名补扩展名。
- 安装包打开失败：客户端保持 `ready-to-install`，显示真实错误并允许“重新打开”或“打开
  文件夹”，不会再误报 `installer-opened` 或提示重启。
- OSS 403：检查 Internal server 的 RAM GetObject 权限和系统时间；私有桶不要把裸 OSS URL
  手填进计划，使用 Internal artifact download URL。
- 历史出现 `release / UNKNOWN`：升级 Internal server 和客户端后，旧空行会在状态迁移时
  自动移除，客户端使用 `/internal/v1/releases/history` 的平台过滤结果。
