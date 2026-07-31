# Release Center 开发者 API：Luopan 与其他产品接入

本文面向需要把自己的 standalone launcher 接入 MX Release Center 的开发者。它描述两条
边界不同的链路：

- **Consumer**：安装在用户电脑上的应用只检查、下载、执行并上报更新；
- **Publisher**：受信任的 Internal CI/发版作业上传产物、创建计划和完成 gate。

Publisher API 是 SDK Gateway 下的产品隔离 facade。它不是 Admin 全量接口的别名，也不向
Domestic 公网 bootstrap 开放。Luopan 桌面客户端里不得保存 `client_secret` 或 Publisher
access token。

完整安装包的人工操作与 OSS 配置见
[23-release-center-full-installer-operations.md](./23-release-center-full-installer-operations.md)；
客户端执行器接线见
[20-luopan-standalone-development-guide.md](./20-luopan-standalone-development-guide.md#5-更新执行器接线逐段讲解)。

## 1. Consumer 与 Publisher 的边界

| 角色 | 运行位置 | 接口 | 凭据与权限 |
| --- | --- | --- | --- |
| Consumer | Luopan/MX-H2I 用户端 | `GET /internal/v1/releases/products/resolve`、`POST /internal/v1/release/check`、`GET /internal/v1/releases/history`、`POST /internal/v1/release/reports`、响应中的 download URL | 走应用自己的隧道内 VIP；不得持有 Publisher 凭据 |
| Publisher | 受保护的 Internal CI 或发版主机 | `POST /internal/v1/sdk/releases/artifacts`、`GET /internal/v1/sdk/releases/artifacts/{artifactId}`、`POST/GET /internal/v1/sdk/releases`、`GET /internal/v1/sdk/releases/{planId}` | service account + `sdk.release.publish/read` |
| Approver | 受保护的审批作业或发布负责人 | `POST /internal/v1/sdk/releases/{planId}/gate` | service account + `sdk.release.approve` |

Consumer 仍使用现有接口，SDK facade 不要求现有 Luopan 更新器迁移，也不会把全量 plan、
服务账号或 OSS 凭据下发给客户端。客户端下载只使用 `release/check` 返回的 artifact URL，
不要自己拼 OSS 地址。新 plan 的 gate 会处于 `blocked`（等待验证/审批）；gate 为
`failed/blocked` 时，Consumer 的 check 返回 `blocked`；只有 `passed` plan 才会向
圈定客户端提供可执行更新。

Publisher 必须从以下任一入口调用：

- 应用隧道已经 ready 后的产品 VIP；Luopan 是 `http://10.88.100.3:18090`；
- Internal 网络中的 server/Service 地址。

不要从 `h2i.minsight-ai.com`、`116.62.51.154:18090` 等 Domestic 公网 bootstrap 调
`client_credentials` 或 Publisher API。Domestic edge 会拒绝
`client_credentials`；把 Publisher 路由加入公网 allowlist 也不属于本接入方案。

## 2. 发布身份归属与 Luopan 示例

`productId` 是平台分配并登记在 AppCenter 的稳定发布身份，不是让所有客户端复制
`luopan`。用户端应从自己的构建元数据读取 `packageName`，通过
`GET /internal/v1/releases/products/resolve` 取得 `productId`、安装包/renderer 组件名和
channel。不能先拉取所有应用再按名称猜测。

旧版本继续显式发送本地声明的 `productId/componentId/channel`，接口与计划选择逻辑不变；
新版解析只服务于 Release Center，不会改写 ProductNetwork、WireGuard、DNS 或现有连接。
Luopan 的历史 AppCenter 记录早于 `packageName` 字段，服务端保留
`@qpjoy/luopan-demo → luopan` 兼容映射。其他新产品没有这种隐式回退，必须在注册时写入真实
`packageName`。

Luopan 当前代码中的发布身份如下，发版作业必须与它一致：

| 内容 | 值 |
| --- | --- |
| `packageName` | `@qpjoy/luopan-demo` |
| `productId` | `luopan` |
| 完整安装包 `componentId` | `luopan` |
| ASAR 应用热更 `componentId` | `luopan` |
| renderer 热更新 `componentId` | `luopan-renderer` |
| channel | `shadow` |
| macOS 安装包 | DMG，`platform=darwin`，`arch` 按实际包填写 |
| Windows 安装包 | NSIS EXE，`platform=win32`，`arch` 按实际包填写 |
| Linux 安装包 | AppImage，`platform=linux`，`arch` 按实际包填写 |

产品与组件共用一个全局命名空间。平台开通其他产品时，`productId` 必须是 1–120
字符的小写 ID，匹配 `[a-z0-9][a-z0-9._-]*`，并保留 `-renderer`、`-config` 两个
后缀，不得把它们用作产品 ID 的结尾。Release Center 会派生
`${productId}-renderer` 和 `${productId}-config`；这两个 ID 也不能已经是另一个启用的
AppCenter 产品。平台必须在发放 service account 前完成冲突检查，不能靠产品 CI 自行约定
前缀来规避冲突。

当前 Luopan builder 的三个目标就是 DMG、NSIS EXE 和 AppImage。每个
`platform + arch` 文件都是独立 artifact，也应建立独立 plan。单架构包不得标成
`universal`；同一个版本可为不同平台重复以下流程。

Luopan 从 `0.1.1` 起、MX-H2I 从 `2.1.3` 起在完整安装包入口内置通用
`@qpjoy/electron-launcher/asar-bootstrap`。生产 ASAR 基座还必须包含 2026-07-31 的
Electron 物理 `.asar` 校验修复；较早基座虽然有 bootstrap API，但会把外部 `.asar`
虚拟根误判为目录并删除更新指针，必须先全量升级到包含该修复的安装包（MX-H2I 建议
`2.1.10+`）。bootstrap 在产品主进程
加载前选择 pending/current 包，记录 launching/healthy 状态，并在新 ASAR 未完成首次
启动时自动回滚 previous。它只做本地文件选择，不建立网络连接，也不会改变
WireGuard、PAC 或 DNS。旧 MX-H2I 安装仍可运行原产品 bootstrap；新 ASAR 同时保留旧
环境变量兼容，滚动部署不会断开现有在线连接。未包含 bootstrap 的旧 Luopan 必须先完成
一次 DMG/EXE 全量升级，之后才能接收 ASAR。

完整安装包统一使用 `kind=app-installer`，应用代码 ASAR 使用 `kind=app-asar`，两者
都以产品 `productId` 为 `componentId`。不要使用兼容旧 MX-H2I 的
`mx-h2i-installer`。renderer bundle 使用 `kind=renderer-ui` 和
`componentId=luopan-renderer`；本文 curl 以完整安装包为例。

## 3. 平台方一次性开通

### 3.1 创建应用并领取一次性 Publisher credential

这一步由平台管理员执行，Luopan 开发者不需要、也不应获得
`MX_INTERNAL_OPS_TOKEN`。首次创建应用，或对尚无 credential 的旧应用执行一次幂等
upsert，会自动 ensure 产品受限的 Publisher：

```bash
PROVISION_JSON="$(
  curl -fsS "$INTERNAL_BASE/internal/v1/app-center/apps/luopan" \
  -H "x-mx-ops-token: $MX_INTERNAL_OPS_TOKEN" \
  -H 'content-type: application/json' \
  --data-binary '{
    "displayName": "Luopan",
    "packageName": "@qpjoy/luopan-demo",
    "launcherMode": "standalone",
    "requestedBy": "internal-release-admin"
  }'
)"
```

不要 `echo` 整个 `PROVISION_JSON`。首次签发时响应结构为：

```json
{
  "app": {},
  "publisher": {
    "serviceAccount": {
      "serviceAccountId": "svc_luopan_release_publisher",
      "roleIds": ["mx-release-publisher"],
      "scopes": ["sdk.release.read", "sdk.release.publish"],
      "allowedProductIds": ["luopan"]
    },
    "credential": {
      "clientId": "svc_luopan_release_publisher",
      "clientSecret": "mxsa1.<仅本次响应可见>",
      "credential": {
        "credentialId": "<credential-id>",
        "serviceAccountId": "svc_luopan_release_publisher",
        "version": 1,
        "source": "issued",
        "issuedAt": "<timestamp>",
        "updatedAt": "<timestamp>"
      }
    }
  }
}
```

立即把 `publisher.credential.clientSecret` 写入 Luopan 自己的 CI/Vault，然后清理本地
响应和 shell 变量。后续重复相同 upsert 时 `publisher.credential` 为 `null`，不会查询
或轮换现有 secret。若首次响应丢失，直接走下文显式轮换，原值无法恢复。

平台先把应用 ID 转成小写，保留字母、数字、`.`、`_`、`-`，仅把其他字符归一为 `_`，
再生成 `svc_<normalizedAppId>_release_publisher`。若最终 ID 会超过 160 字符，平台会
稳定截断并附加 12 位 SHA-256 摘要，避免不同长 ID 冲突。例如 `mx-h2i` 对应
`svc_mx-h2i_release_publisher`。Publisher 固定只获得：

| scope | 能力 |
| --- | --- |
| `sdk.release.read` | 列出/读取本账号允许产品的 plan 和 artifact metadata |
| `sdk.release.publish` | 上传允许产品的 artifact，并从该 artifact 创建 gate 为 `blocked`（待验证）的 plan |

`allowedProductIds` 是第二层资源边界。只有 scope、产品 allowlist **同时**满足才允许操作。
例如上面的账号即使把请求 body 改成 `productId=mx-h2i` 也会得到 `403`。旧 service
account 没有 `allowedProductIds` 时默认无产品权限，必须由管理员显式补齐。
`release.manage` 仅作为平台管理员的全局逃生 scope，可跨产品；不要授予产品 CI。

审批默认使用独立账号，避免构建作业上传后自行批准：

```bash
APPROVER_PROVISION_JSON="$(
  curl -fsS "$INTERNAL_BASE/internal/v1/sdk/service-accounts" \
    -H 'content-type: application/json' \
    -H "x-mx-ops-token: $MX_INTERNAL_OPS_TOKEN" \
    --data-binary '{
      "serviceAccountId": "svc_luopan_release_approver",
      "displayName": "Luopan Release Approver",
      "roleIds": ["mx-release-approver"],
      "scopes": ["sdk.release.read", "sdk.release.approve"],
      "allowedProductIds": ["luopan"],
      "requestId": "luopan-release-approver-provision-v1"
    }'
)"
```

该接口返回 `{serviceAccount, credential}`，其中 `credential.clientSecret` 也只出现一次。
把它写入与 Publisher 分离的审批 Secret Store。默认不要创建同时拥有
`sdk.release.publish + sdk.release.approve` 的产品账号。

### 3.2 数据库存储、轮换与旧 Secret 迁移

Publisher/Approver 都不复用平台级 Internal ops token。服务端只在首次签发或显式轮换时
返回 `mxsa1.<32-byte-base64url>` 明文；PostgreSQL credential record 只保存不可逆 scrypt
hash、版本、来源和时间戳。列表、查询、应用幂等 upsert 都只返回安全摘要，不返回 hash 或
旧明文。因此，增加新应用不需要编辑 `server/.env`、K8s Secret 或重启 Internal API。

显式轮换单个账号：

```bash
ROTATE_JSON="$(
  curl -fsS -X POST \
    "$INTERNAL_BASE/internal/v1/sdk/service-accounts/svc_luopan_release_publisher/credentials/rotate" \
    -H "x-mx-ops-token: $MX_INTERNAL_OPS_TOKEN"
)"
```

`ROTATE_JSON.credential.clientSecret` 只在这次响应可见。先更新对应 CI/Vault，再让 CI
重新获取短期 token；其他应用 credential、`mx-internal-ops` 和 API Deployment 都不需要
改变。

旧 `mx-sdk-service-account-secrets/secrets.json` 与
`MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON` / `MX_SDK_SERVICE_ACCOUNT_SECRETS_FILE` 只保留
一版迁移兼容。已有旧集成首次升级时，仍可把**完整旧 map**临时写入被 gitignore 的
`server/.env`：

```json
{
  "svc_existing_integration": "<保留现有账号的原 secret>"
}
```

```dotenv
MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON='{"svc_existing_integration":"<保留现有账号的原 secret>"}'
```

随后只运行一次正常部署：

```bash
chmod 600 server/.env
bash scripts/manage.sh ops internal-production deploy
```

启动导入只处理数据库尚无 credential 的账号：旧明文会转成 hash；数据库已有任何
credential 时保留数据库值，绝不覆盖或把明文写进日志。OAuth 优先校验数据库 credential；
数据库已有记录后不会回退接受 map 中的另一个旧值。确认旧 CI 能正常取 token 后，先从
`server/.env` 删除该变量，再显式删除只用于迁移的旧 K8s Secret：

```bash
kubectl -n mx-internal-shadow delete secret mx-sdk-service-account-secrets
```

仅从 `.env` 删除变量不会删除已有 Secret，因为日常 deploy 默认保留未配置的集群值。完成
上述清理后，后续 deploy 才会完全不再物化旧 map。不要用该兼容入口添加新应用，也不要把
secret 提交到 Git、写进 Luopan 应用 `.env`、打进 Electron 包或粘贴到发版日志。

部署启动还会为已有的 enabled App 幂等补齐 Publisher service account 元数据，但不会在
后台生成无人能接收的明文 secret。旧应用尚无 credential 时，由管理员对该 App 执行一次
上节的幂等 upsert，领取一次性值即可。

应用临时更新为 `enabled=false` 时，平台禁用自动 Publisher 并撤销其 active token，但保留
credential；重新启用后原 CI secret 可换取新 token，旧 token 不会复活。删除非内置应用
则会在同一数据库事务中禁用 Publisher、撤销 token 并删除 credential verifier；以后重建
同一 `appId` 会签发全新 secret，旧 secret 与旧 token 都永久失效。

### 3.3 首次上线与数据库迁移

首次上线 Publisher API 不能只对旧 Deployment 执行 `rollout restart`。应从
`electron-dock/mx-launcher` 目录执行完整 Internal 部署，让新镜像中的 TypeORM migration
Job 在 API rollout 前完成：

```bash
bash scripts/manage.sh ops internal-production deploy
```

新迁移会为 Publisher 的 `environment + productId + requestId` 建立部分唯一索引。建索引
会扫描共享记录表，并可能短时阻塞写入；生产首次上线应安排维护窗口、先备份 PostgreSQL，
并暂停 Publisher/管理面写操作。若 migration 报历史 Publisher request key 重复，先用
以下只读 SQL 找出冲突，不要直接删除 plan：

```sql
SELECT
  environment,
  data->>'productId' AS product_id,
  data->>'requestId' AS request_id,
  count(*) AS duplicate_count,
  array_agg(id ORDER BY created_at) AS plan_ids
FROM mx_platform_records
WHERE kind = 'release-management-plan'
  AND NULLIF(data->>'publisherRequestFingerprint', '') IS NOT NULL
  AND NULLIF(data->>'productId', '') IS NOT NULL
  AND NULLIF(data->>'requestId', '') IS NOT NULL
GROUP BY environment, data->>'productId', data->>'requestId'
HAVING count(*) > 1;
```

在备份基础上逐组核对 artifact、audience、gate 和 Consumer 证据，由平台负责人决定保留
哪条记录并通过受审计的维护流程修复；migration 不会静默合并或删除计划。修复后重新运行
完整 deploy。后续新增应用、签发或轮换账号 secret 都通过 API 完成，不需要编辑
`server/.env`、更新完整 map 或 rollout API。

## 4. 获取短期 Publisher token

下面示例都在受保护的 Internal CI shell 中执行：

```bash
export BASE='http://10.88.100.3:18090'
export RELEASE_CLIENT_ID='svc_luopan_release_publisher'
# RELEASE_CLIENT_SECRET 必须由 CI secret store 作为已 export 的环境变量注入。

PUBLISHER_TOKEN="$(
  jq -n '{
      grant_type: "client_credentials",
      client_id: env.RELEASE_CLIENT_ID,
      client_secret: env.RELEASE_CLIENT_SECRET,
      audience: "mx-sdk",
      scope: "sdk.release.read sdk.release.publish"
    }' |
  curl -fsS "$BASE/internal/v1/sdk/oauth/token" \
    -H 'content-type: application/json' \
    --data-binary @- |
  jq -er '.token.access_token // .access_token'
)"
```

token 默认且硬上限为 1 小时；即使请求更长的 `expires_in` 也会被截断。长作业应在
过期后重新执行 `client_credentials`，不要持久化 access token。服务端会把请求 scope
与 service account 实际 scope 取交集，不能通过 token 请求临时扩大权限。

可先做只读探测：

```bash
curl -fsS "$BASE/internal/v1/sdk/releases?productId=luopan" \
  -H "authorization: Bearer $PUBLISHER_TOKEN" |
  jq
```

`productId` 是 list 请求的必填 query，且必须在 `allowedProductIds` 中；返回只包含该产品
的计划。

## 5. 上传 artifact

上传接口接收 raw binary，不接收 multipart：

```text
POST /internal/v1/sdk/releases/artifacts
Content-Type: application/octet-stream
Authorization: Bearer <token>
```

query 字段：

| 字段 | 要求 |
| --- | --- |
| `productId` | 必填；1–120 字符的小写 `[a-z0-9][a-z0-9._-]*`；不得以保留的 `-renderer` / `-config` 结尾；必须命中 service account 的 `allowedProductIds` |
| `releaseId` | 必填；1–160 字符；首字符必须是字母或数字，其余只允许 `[A-Za-z0-9._-]`；由产品 CI 生成的稳定、可审计 ID |
| `kind` | 必填；支持 `app-installer`、`app-asar`、`renderer-ui` |
| `version` | 必填；必须与安装包内应用版本一致 |
| `componentId` | 必填且精确绑定产品；`app-installer` / `app-asar` 必须等于 `productId`，`renderer-ui` 必须等于 `${productId}-renderer` |
| `fileName` | 必填；保留正确扩展名，建议只用安全 ASCII 文件名 |
| `digest` | 必填；文件 sha256，可传 hex 或 `sha256:<hex>` |
| `platform` / `arch` | 一般可选，但 `app-installer` / `app-asar` 两者都必填 |
| `channel` | 可选，默认 `stable`；1–64 字符；首字符必须是小写字母或数字，其余只允许 `[a-z0-9._-]`；服务端会规范为小写，Luopan 应显式传 `shadow` |

`storage` 不对开发者开放：Internal 根据服务端配置选择本地或 OSS，调用方不得传
AccessKey、bucket、外部 artifact URL 或 `storage=oss` 来绕过服务端策略。
OSS object key 包含完整 SHA-256；相同版本、文件名但不同内容不会覆盖已经审批过的
artifact。

macOS arm64 DMG 示例：

```bash
ARTIFACT='dist/electron/Packaged/Luopan-0.1.1-arm64.dmg'
FILE_NAME='Luopan-0.1.1-arm64.dmg'
VERSION='0.1.1'
RELEASE_ID='luopan-darwin-arm64-0.1.1-20260728-001'
DIGEST="sha256:$(shasum -a 256 "$ARTIFACT" | awk '{print $1}')"

UPLOAD_JSON="$(
  curl -fsS -X POST \
    "$BASE/internal/v1/sdk/releases/artifacts?productId=luopan&releaseId=$RELEASE_ID&kind=app-installer&version=$VERSION&componentId=luopan&fileName=$FILE_NAME&digest=$DIGEST&platform=darwin&arch=arm64&channel=shadow" \
    -H "authorization: Bearer $PUBLISHER_TOKEN" \
    -H 'content-type: application/octet-stream' \
    --data-binary "@$ARTIFACT"
)"

ARTIFACT_ID="$(jq -er '.artifact.artifactId' <<<"$UPLOAD_JSON")"
printf 'artifactId=%s\n' "$ARTIFACT_ID"
```

Linux CI 可把 `shasum -a 256` 换成 `sha256sum`。Windows/EXE 使用
`platform=win32&arch=x64`，Linux/AppImage 使用
`platform=linux&arch=<实际架构>`。文件内容、digest 或扩展名不一致时上传直接失败，
不会生成可供 plan 引用的 artifact。

`app-asar` 的文件名必须以 `.asar` 结尾，计划会派生
`updatePolicy=app-asar`、`activation=restart-auto`。它只应包含应用 JavaScript、HTML
和静态资源；native module、WireGuard/Mihomo 引擎、Electron/Node ABI 或 entitlements
变化必须发布 DMG/EXE。客户端检查时按用户配置分别发送
`artifactKinds:["app-asar"]` 或 `["app-installer"]`，所以两类计划可以共享同一
`componentId`，无需给 ASAR 另造或写死应用 ID。省略 `artifactKinds` 的旧客户端继续按
原有计划匹配。

仓库内的 ASAR 构建入口：

```bash
# Luopan；macOS 默认 universal，Windows 默认 x64
pnpm --dir demos/luopan run make:asar:mac -- 0.1.2 universal
pnpm --dir demos/luopan run make:asar:win -- 0.1.2 x64

# MX-H2I
pnpm --dir demos/mx-h2i run make:asar:mac -- 2.1.4 universal
pnpm --dir demos/mx-h2i run make:asar:win -- 2.1.4 x64
```

两个命令都会生成 `.asar` 和相邻的 `.asar.json` manifest，manifest 包含
`productId/componentId/version/platform/arch/digest/sizeBytes`。`platform/arch` 描述
目标客户端，不表示 ASAR 内含平台原生二进制；原生依赖仍继承完整安装包。Admin
上传只选择 `.asar`；相邻 JSON 是本地构建/自动化发布的核对清单，不作为第二个 artifact
上传。服务端会对收到的 `.asar` 重新计算 digest 和 size，并以 Release Center 表单中的
发布元数据为准。

读取服务端登记的 metadata（不会返回 OSS 凭据）：

```bash
curl -fsS "$BASE/internal/v1/sdk/releases/artifacts/$ARTIFACT_ID" \
  -H "authorization: Bearer $PUBLISHER_TOKEN" |
  jq '.artifact'
```

## 6. 从 artifact 创建定向计划

Publisher 只能用已上传且属于自己产品范围的 `artifactId` 创建 plan：

```bash
PLAN_JSON="$(
  jq -n \
    --arg artifactId "$ARTIFACT_ID" \
    --arg targetInstallId 'inst_luopan_validation_mac_01' \
    '{
      artifactId: $artifactId,
      currentVersion: "0.1.0",
      deliveryMode: "prompt-download-restart",
      releaseNotes: "Luopan 0.1.1 macOS arm64 validation",
      targetInstallIds: [$targetInstallId],
      rolloutStrategy: "manual-ring",
      rolloutPercentage: 0,
      suiteId: "luopan-installer-e2e",
      topology: "luopan-darwin-arm64",
      sites: ["internal-main"],
      requestId: "luopan-0.1.1-targeted-plan-001"
    }' |
  curl -fsS "$BASE/internal/v1/sdk/releases" \
    -H "authorization: Bearer $PUBLISHER_TOKEN" \
    -H 'content-type: application/json' \
    --data-binary @-
)"

PLAN_ID="$(jq -er '.plan.planId // .release.planId' <<<"$PLAN_JSON")"
printf 'planId=%s\n' "$PLAN_ID"
```

`artifactId`、`currentVersion` 和 `requestId` 是必填项。还可传：

- `channel`，但只能省略或与 artifact channel 完全一致；
- `releaseNotes`；
- `deliveryMode`：`prompt-download-restart`（默认，提示用户下载并可立即重启）或
  `silent-download-next-start`（仅 `app-asar`，后台下载并在下一次自然启动生效）；
- `targetUserIds` / `targetInstallIds`；
- `rolloutStrategy` / `rolloutPercentage` / `rolloutRings`；
- `featureKeys`；
- `suiteId` / `topology` / `sites`。

`productId`、`releaseId`、`componentId`、目标版本、URL、digest、size、platform、arch
都从服务端保存的 artifact 派生。create body 即使伪造这些字段也不能覆盖 artifact
metadata。`createdBy/requestedBy` 同样不由调用方决定，审计身份强制使用 Bearer token
对应的 service account。

完整安装包始终强制 `prompt-download-restart`，不会被静默打开或安装。旧 plan 没有
`deliveryMode` 字段时，新客户端也按提示模式处理；旧客户端会忽略新字段，因此服务端与
K8s 可以先滚动升级，再逐步发新版完整安装包。

新 plan 内部的 E2E run 从 `running` 开始；因为尚无通过证据，对外计算出的
`test.gate.verdict` 是 `blocked`。Publisher 不能在 create body 中直接声称 `passed`。

create 的幂等键是 `productId + requestId + canonical request fingerprint`。同一个
`requestId` 重试完全相同的 body 会返回原 plan 和 `idempotent=true`；复用同一个
`requestId` 但修改 audience、rollout 或其他字段会返回 `400`。定向与全量 plan 因此必须
使用不同 `requestId`，即使它们复用同一个 `artifactId`。
Memory Store 在同一事件循环内原子执行，Postgres 在事务 advisory lock 内检查并创建，
并用部分唯一索引兜底跨 Pod/滚动升级竞态。部署迁移若发现历史重复 Publisher key 会
明确失败，要求人工核对，不会静默删除 plan。

读取单个计划：

```bash
curl -fsS "$BASE/internal/v1/sdk/releases/$PLAN_ID" \
  -H "authorization: Bearer $PUBLISHER_TOKEN" |
  jq '.plan // .release'
```

## 7. 定向验证、gate 与全量

推荐的生产顺序：

1. 上传每个 `platform + arch` artifact；
2. 用测试 userId/installId 创建 gate 为 `blocked`（待验证）的定向 plan；
3. CI/受控验证机对同一 artifact 做 digest、OS 签名/公证、安装和启动 smoke；此时
   Consumer check 返回 `blocked` 是正确行为；
4. Approver 根据离线/CI 证据将定向 plan gate 设为 `passed`；
5. 圈定的 Luopan 客户端通过 Consumer `release/check` 真机升级，并回报
   `installer-completed`；
6. 复核定向 Consumer report 后，复用同一个 `artifactId` 创建一个没有目标 ID、
   `all / 100%`、新 `requestId` 的 plan；
7. Approver 在全量 gate evidence 中引用定向 plan 与客户端 report，将全量 plan 设为
   `passed`；
8. 其他 Luopan 客户端下一次 check 才会命中全量版本。

`targetUserIds`、`targetInstallIds` 和 percentage 只是更新分发 selector，不是安全鉴权
或数据授权边界。不要借 Release Center audience 给未授权用户开放业务数据；业务权限仍由
User Center/AppCenter/Permission Center 决定。

Consumer report 是来自客户端的 telemetry，不是可信的审批证明。Internal 网络里的调用方
可能伪造或重放 report；Approver 必须把它与 CI 产物 digest、OS 签名/公证、受控验证机
结果和对应 plan/artifactId 交叉核对，不能只看到一条 `installer-completed` 就批准全量。

running 阶段的验证由受控 CI/验证机使用刚构建的文件，或读取 upload/metadata 返回的
artifact URL 完成；不要为了让验证机调用 Publisher API 而把 service account secret
复制过去。

审批环境从自己的 Vault 注入独立凭据，并获取 Approver token：

```bash
export RELEASE_APPROVER_CLIENT_ID='svc_luopan_release_approver'
# RELEASE_APPROVER_CLIENT_SECRET 只由审批环境的 Secret Store 注入。

APPROVER_TOKEN="$(
  jq -n '{
      grant_type: "client_credentials",
      client_id: env.RELEASE_APPROVER_CLIENT_ID,
      client_secret: env.RELEASE_APPROVER_CLIENT_SECRET,
      audience: "mx-sdk",
      scope: "sdk.release.read sdk.release.approve"
    }' |
  curl -fsS "$BASE/internal/v1/sdk/oauth/token" \
    -H 'content-type: application/json' \
    --data-binary @- |
  jq -er '.token.access_token // .access_token'
)"
```

完成定向 gate：

```bash
curl -fsS "$BASE/internal/v1/sdk/releases/$PLAN_ID/gate" \
  -H "authorization: Bearer $APPROVER_TOKEN" \
  -H 'content-type: application/json' \
  --data-binary @- <<JSON
{
  "status": "passed",
  "message": "Luopan 0.1.1 passed macOS arm64 offline artifact validation",
  "evidence": {
    "validationHost": "luopan-mac-arm64-ci-01",
    "digestVerified": true,
    "signatureVerified": true,
    "installLaunchSmoke": "passed"
  },
  "requestId": "luopan-0.1.1-targeted-gate-001"
}
JSON
```

`status` 和 `requestId` 必填，`status` 只接受 `passed`、`failed` 或 `blocked`；
`message/evidence` 可选。调用方即使发送 `requestedBy` 也不会改变审计 actor。
`passed`、`failed` 都是终态；显式提交 `blocked` 也会终止本次验证。相同终态重试会
直接返回原 plan，不重复追加测试步骤；若要从 `failed/blocked` 改成另一结果，必须使用
新 `requestId` 创建新 plan。Postgres 会同时串行化 plan 与对应 test run，并禁止通用
Test Center step 接口改写 Publisher 所属 run，避免并发审批或旁路步骤互相覆盖。

`evidence` 只应保存结构化结论、外部证据 ID/URL 和摘要；服务端限制为 32 KiB、最多
4 层嵌套，并拒绝常见敏感字段名。禁止放入
Authorization、client secret、用户/上游 token、K8s Secret、完整环境变量转储、原始日志
或带签名 query 的 OSS URL；原始日志放到权限受控的日志系统，在 evidence 中只记录
不可变引用和 sha256。

默认的分权流程不要给 Publisher 使用 `release-center-publish.mjs --approve`，而是按上面
的 gate 调用交给 Approver。兼容旧的合并式 CI 确需使用 `--approve` 时，其账号必须显式
同时拥有 publish/approve；并且必须提供
`--approval-evidence <json-file>`，且 JSON 中
`artifactDigestVerified`、`osSignatureVerified`、`installSmokePassed` 都为 `true`。
非定向（全量）计划还必须显式传 `--confirm-full-rollout`。client secret 只从
`MX_RELEASE_CLIENT_SECRET` 读取；脚本拒绝 `--client-secret`，也拒绝携带凭据跟随 HTTP
重定向。

创建全量 plan 时不传 `targetUserIds/targetInstallIds`：

```bash
FULL_PLAN_JSON="$(
  jq -n \
    --arg artifactId "$ARTIFACT_ID" \
    --arg targetedPlanId "$PLAN_ID" \
    '{
      artifactId: $artifactId,
      currentVersion: "0.1.0",
      releaseNotes: "Luopan 0.1.1 macOS arm64",
      rolloutStrategy: "all",
      rolloutPercentage: 100,
      suiteId: "luopan-installer-e2e",
      topology: "luopan-darwin-arm64",
      sites: ["internal-main"],
      requestId: ("luopan-0.1.1-full-after-" + $targetedPlanId)
    }' |
  curl -fsS "$BASE/internal/v1/sdk/releases" \
    -H "authorization: Bearer $PUBLISHER_TOKEN" \
    -H 'content-type: application/json' \
    --data-binary @-
)"

FULL_PLAN_ID="$(jq -er '.plan.planId // .release.planId' <<<"$FULL_PLAN_JSON")"
```

全量 plan 同样先得到 `blocked` gate；它复用同一个 `artifactId`，但必须使用新的
`requestId`。审批人复核定向 plan 后，再调用同一个 gate endpoint
并使用 `$APPROVER_TOKEN` 把 `$FULL_PLAN_ID` 设为 `passed`，把定向 `$PLAN_ID` 写入
`evidence`。产品 Publisher 仍应通过新 plan 完成 canary → full promotion；Internal
Admin 可用 `PATCH /internal/v1/release-management/plans/{planId}` 修正 release notes、
提示/静默方式和灰度参数，但不能改 artifact、digest、平台、架构或目标版本。

`release-center-publish.mjs` 是“上传本地文件并创建一个 plan”的 one-shot 包装，不提供
`--artifact-id` 或 `--plan-id` 复用模式。CI 使用它时必须显式传稳定的
`--release-id` 与 `--request-id`，否则默认随机 ID 不适合超时重试。canary → full
promotion 和对既有 plan 的延后审批应使用本章 curl：复用服务端返回的同一个
`artifactId`，为全量 create 使用新的稳定 `requestId`，不要再次运行 CLI 并误以为它会
自动复用旧 artifact。

ASAR 的 one-shot 发布可追加：

```bash
--kind asar \
--delivery-mode prompt-download-restart
```

如需后台下载并等待用户下一次自然启动，改为
`--delivery-mode silent-download-next-start`。该值也可通过
`MX_RELEASE_DELIVERY_MODE` 提供；非 ASAR 制品传 silent 会被 CLI 拒绝。

## 8. Consumer 的兼容接法

新版主进程通过 `@qpjoy/electron-launcher` 的 release updater 按 package 解析发布身份；
旧版显式 `productId` 的调用继续有效：

```ts
const updater = createElectronLauncherReleaseUpdater({
  baseUrl: internalBaseUrl,
  packageName: '@example/my-desktop-app',
  channel: 'stable',
  reportInstallId: installId
});

const result = await updater.check({
  componentKind: 'app-asar',
  currentVersion: app.getVersion(),
  installId,
  platform: process.platform,
  arch: process.arch
});
```

产品应依次检查 `app-asar`、`app-installer`（以及需要时的 `renderer-ui`），但只执行服务端
返回的单个匹配决策。提示模式显示更新说明和“下载并应用”；ASAR 下载校验后写入 pending，
用户点击“立即重启”生效。静默模式不弹提示，下载完成后等下一次正常启动生效。启动成功后
调用 `confirmElectronLauncherAsarLaunch`；若主入口导入失败或上次启动未到 healthy，
bootstrap 会自动回滚。

`releaseNotes` 使用受限 Markdown。MX-H2I 与 Luopan 的更新面板和“发现更新”应用内弹窗
支持 1–4 级标题、段落、无序/有序列表、引用、粗体、斜体、删除线、行内代码、围栏代码块
以及 HTTP(S) 链接。客户端会先转义原始 HTML；脚本、事件属性、`javascript:` 链接和其他
原始 HTML 不会执行。发布者不应依赖 HTML 排版。系统原生的“下载完成/立即重启”确认框仍为
纯文本，因为 Electron 原生 message box 不提供富文本渲染。

只有正处于服务端滚动升级期的历史应用，才可同时提供原 `productId` 并显式设置
`allowLegacyProductFallback: true`；该回退只处理旧服务端返回的 404/405。新应用不要开启，
否则注册遗漏可能被掩盖。

下面的 Luopan curl 只用于排障，不应替代包内 updater。先验证解析结果：

```bash
curl -fsS -G "$BASE/internal/v1/releases/products/resolve" \
  --data-urlencode 'packageName=@qpjoy/luopan-demo' \
  --data-urlencode 'channel=shadow' |
  jq
```

定向 plan 的 gate 为 `blocked` 时预期得到
`status=blocked`；gate 变为 `passed` 后，只有圈定的 user/install 才会得到
`update-available`：

```bash
curl -fsS "$BASE/internal/v1/release/check" \
  -H 'content-type: application/json' \
  --data-binary '{
    "installId": "inst_luopan_validation_mac_01",
    "userId": "usr_luopan_tester",
    "productId": "luopan",
    "channel": "shadow",
    "platform": "darwin",
    "arch": "arm64",
    "components": {
      "luopan": "0.1.0",
      "luopan-renderer": "0.1.0"
    }
  }' |
  jq
```

历史记录：

```bash
curl -fsS \
  "$BASE/internal/v1/releases/history?componentId=luopan&channel=shadow&platform=darwin&arch=arm64" |
  jq
```

证据上报：

```bash
curl -fsS "$BASE/internal/v1/release/reports" \
  -H 'content-type: application/json' \
  --data-binary '{
    "installId": "inst_luopan_validation_mac_01",
    "status": "installer-completed",
    "metadata": {
      "componentId": "luopan",
      "from": "0.1.0",
      "to": "0.1.1"
    }
  }'
```

Consumer 端不要附加 Publisher Bearer，不要调用 `/internal/v1/sdk/releases*`，也不要把
download URL 缓存成永久 OSS 地址。私有 OSS URL 可能是短期签名 URL。

## 9. 常见错误

| 现象 | 检查项 |
| --- | --- |
| token 返回 `401 invalid service account credentials` | service account 是否 active；client ID 是否正确；CI/Vault 是否保存了首次签发或最近轮换的完整 `mxsa1.*` 值；旧账号是否已完成 DB credential 导入 |
| token 提示仅限 Internal | 请求是否经过 Domestic 公网 edge；改为 Internal 地址或已 ready 的 Luopan 产品 VIP |
| Publisher 返回 `401` | Bearer 是否缺失/过期、audience 是否为 `mx-sdk` |
| Publisher/Approver 返回 `403` | token 是否分别有 read+publish 或 read+approve；`allowedProductIds` 是否含 `luopan`；artifact/plan 是否属于 Luopan |
| upload 返回 `400` | required query 是否完整；ID 长度/字符是否合法；product 是否使用了保留后缀或派生组件是否撞到已启用产品；digest 是否匹配；`app-installer` 是否有 platform/arch；DMG/EXE/AppImage 扩展名与 platform 是否匹配 |
| create 返回 artifact/channel 错误 | artifactId 是否来自本账号可访问的上传；不要覆盖 artifact 元数据；channel 省略或保持 `shadow` |
| gate 是 `blocked` | 新 plan 等待验证时这是预期行为；先完成 CI/离线验证，再用带 `sdk.release.approve` 的 token 调 gate endpoint |
| 客户端显示 up-to-date | 依次检查 `channel=shadow`、component、platform/arch、当前版本、gate 是否 passed、定向 user/install 是否命中 |
| 客户端能看到版本但不能下载 | 检查 artifact metadata 的 URL/digest/size/fileName 和 Internal 到 OSS 的权限；不要给客户端裸 OSS AccessKey |
| Windows 收到 macOS 包 | 每个平台单独 artifact/plan，并确认 `win32/x64` 与 `darwin/arm64|x64|universal` 没有混填 |

排障日志必须脱敏 `Authorization`、`client_secret`、access token 和 OSS 签名 query。
upload 用稳定 `releaseId` 串联 artifact 证据；create/gate 使用可追踪且不包含秘密的
`requestId`。不要在定向与全量 create 中复用同一个 `requestId`。

## 10. 其他产品接入清单

Luopan 之外的开发者按相同模型接入：

1. 平台先注册 ProductNetwork/AppCenter，写入应用真实且唯一的 `packageName`，并确定唯一 `productId` 和小写 channel；检查
   `productId` 不使用保留的 `-renderer/-config` 后缀，两个派生组件也不与启用产品冲突；
2. 用 `/internal/v1/releases/products/resolve?packageName=...` 验证返回的发布身份与 channel；重复 package 必须先清理，不能让客户端任选其一；
3. 平台 upsert AppCenter 应用并把一次性 Publisher secret 写入该应用 CI/Vault；另建独立 Approver credential；
4. 产品 CI 构建并完成 OS 签名/公证；Release Center 不替代构建、签名或 notarization；
5. CI 计算 sha256，通过 scoped artifact endpoint 上传；
6. CI 只用 `artifactId` 创建 `blocked`（待验证）定向 plan，并先做离线/CI artifact 验证；
7. Approver 过定向 gate 后，圈定 Consumer 才使用现有 updater 真机升级并 report；
8. Approver 依据定向客户端证据建立并审批全量 plan；
9. 每个平台/架构独立验证；回退版本必须仍有 gate-passed 全量 plan 和可下载 artifact；
10. 首个支持 ASAR 的版本必须先走完整安装，之后才把 ASAR 设为产品默认热更新方案。

接入方不需要访问 Admin 全量 Release Management API、K8s、数据库或 OSS 凭据。若需求超出
上述 SDK facade，应先扩展受 scope 和 product allowlist 约束的契约，不要把 Internal ops
token 或 Admin endpoint 暴露给产品 CI。
