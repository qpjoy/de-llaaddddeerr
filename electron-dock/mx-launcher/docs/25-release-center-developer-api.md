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
| Consumer | Luopan/MX-H2I 用户端 | `POST /internal/v1/release/check`、`GET /internal/v1/releases/history`、`POST /internal/v1/release/reports`、响应中的 download URL | 走应用自己的隧道内 VIP；不得持有 Publisher 凭据 |
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

## 2. Luopan 的固定发布身份

Luopan 当前代码中的发布身份如下，发版作业必须与它一致：

| 内容 | 值 |
| --- | --- |
| `productId` | `luopan` |
| 完整安装包 `componentId` | `luopan` |
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

完整安装包统一使用 `kind=app-installer`。不要使用兼容旧 MX-H2I 的
`mx-h2i-installer`。renderer bundle 使用 `kind=renderer-ui` 和
`componentId=luopan-renderer`；本文 curl 以完整安装包为例。

## 3. 平台方一次性开通

### 3.1 创建产品受限 service account

这一步由平台管理员执行，Luopan 开发者不需要、也不应获得
`MX_INTERNAL_OPS_TOKEN`：

```bash
curl -fsS "$INTERNAL_BASE/internal/v1/sdk/service-accounts" \
  -H 'content-type: application/json' \
  -H "x-mx-ops-token: $MX_INTERNAL_OPS_TOKEN" \
  --data-binary '{
    "serviceAccountId": "svc_luopan_release_ci",
    "displayName": "Luopan Release CI",
    "roleIds": ["mx-service-account"],
    "scopes": [
      "sdk.release.read",
      "sdk.release.publish",
      "sdk.release.approve"
    ],
    "allowedProductIds": ["luopan"],
    "requestId": "luopan-release-ci-provision-v1"
  }'
```

三个 scope 的含义：

| scope | 能力 |
| --- | --- |
| `sdk.release.read` | 列出/读取本账号允许产品的 plan 和 artifact metadata |
| `sdk.release.publish` | 上传允许产品的 artifact，并从该 artifact 创建 gate 为 `blocked`（待验证）的 plan |
| `sdk.release.approve` | 将允许产品的待验证 plan gate 完成为 `passed/failed/blocked` |

`allowedProductIds` 是第二层资源边界。只有 scope、产品 allowlist **同时**满足才允许操作。
例如上面的账号即使把请求 body 改成 `productId=mx-h2i` 也会得到 `403`。旧 service
account 没有 `allowedProductIds` 时默认无产品权限，必须由管理员显式补齐。
`release.manage` 仅作为平台管理员的全局逃生 scope，可跨产品；不要授予产品 CI。

简单团队可以把三个 scope 放在同一个 CI 账号；需要职责分离时，可以建立
`svc_luopan_release_publisher`（read + publish）和
`svc_luopan_release_approver`（read + approve），两者都只允许 `luopan`。

### 3.2 配置账号独立的 client secret

Publisher 账号使用独立 secret，不复用平台级 Internal ops token。Internal API 当前从
以下 K8s Secret 读取 service-account-to-secret JSON：

```text
namespace: mx-internal-shadow
Secret:    mx-sdk-service-account-secrets
key:       secrets.json
```

内容模型如下。`secrets.json` 是所有 SDK service account 的**完整 canonical map**，不是
只包含本次新增账号的增量 patch：

```json
{
  "svc_existing_integration": "<保留现有账号的 secret>",
  "svc_luopan_release_ci": "<至少 32 字符的随机 secret>"
}
```

若暂未接 ExternalSecret，平台管理员在受控编辑器中把完整 map 写入被 gitignore 的
`server/.env`。单引号只是 `.env` 的值边界，不会进入 JSON：

```dotenv
MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON='{"svc_existing_integration":"<保留现有账号的 secret>","svc_luopan_release_ci":"<至少 32 字符的随机 secret>"}'
```

先在 Secret Manager 或受限工作区合并并验证所有现有账号，再写入这个值。绝不能用只含
Luopan 的示例覆盖线上 map。随后只运行正常部署：

```bash
chmod 600 server/.env
bash scripts/manage.sh ops internal-production deploy
```

deploy 会在修改任何 Internal workload 前严格解析整个 JSON，拒绝数组、空账号 ID、非字符
串或少于 32 字符的 secret；通过后幂等 ensure
`mx-sdk-service-account-secrets/secrets.json` 并自动触发 rollout。文件和进程 env 都没有
该变量时保留集群现有 key；变量存在时把它视为完整 canonical map，绝不与旧 JSON 按账号
merge。部署日志、命令参数和状态摘要不会输出 secret。

Config Center 中对应的内置引用是
`secretref_sdk_service_account_credentials`，目标为
`mx-internal-shadow/mx-sdk-service-account-secrets`；它只登记 provider、remote ref、
consumer 和 K8s target，不在 Postgres 保存 secret 明文。生产上应由
Secret Center/KMS/ExternalSecret 或受控部署流程根据这条引用物化 Secret。不要把 secret
提交到 Git、写进 Luopan `.env`、打进 Electron 包或粘贴到发版日志。Secret 更新后让
Internal API rollout，再由 CI 的 secret store 注入同一值；标准 deploy 已自动完成前一个
rollout。

内置 `svc_sdk_gateway` 暂时保留旧 Internal ops secret 的兼容路径；第三方产品不得依赖
这个兼容行为。

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
完整 deploy。后续仅轮换账号 secret 时才只需要更新完整 canonical map 并 rollout API。

## 4. 获取短期 Publisher token

下面示例都在受保护的 Internal CI shell 中执行：

```bash
export BASE='http://10.88.100.3:18090'
export RELEASE_CLIENT_ID='svc_luopan_release_ci'
# RELEASE_CLIENT_SECRET 必须由 CI secret store 作为已 export 的环境变量注入。

TOKEN="$(
  jq -n '{
      grant_type: "client_credentials",
      client_id: env.RELEASE_CLIENT_ID,
      client_secret: env.RELEASE_CLIENT_SECRET,
      audience: "mx-sdk",
      scope: "sdk.release.read sdk.release.publish sdk.release.approve"
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
  -H "authorization: Bearer $TOKEN" |
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
| `kind` | 必填；Luopan 完整包使用 `app-installer` |
| `version` | 必填；必须与安装包内应用版本一致 |
| `componentId` | 必填且精确绑定产品；`app-installer` 必须等于 `productId`，`renderer-ui` 必须等于 `${productId}-renderer` |
| `fileName` | 必填；保留正确扩展名，建议只用安全 ASCII 文件名 |
| `digest` | 必填；文件 sha256，可传 hex 或 `sha256:<hex>` |
| `platform` / `arch` | 一般可选，但 `app-installer` 两者都必填 |
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
    -H "authorization: Bearer $TOKEN" \
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

读取服务端登记的 metadata（不会返回 OSS 凭据）：

```bash
curl -fsS "$BASE/internal/v1/sdk/releases/artifacts/$ARTIFACT_ID" \
  -H "authorization: Bearer $TOKEN" |
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
    -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    --data-binary @-
)"

PLAN_ID="$(jq -er '.plan.planId // .release.planId' <<<"$PLAN_JSON")"
printf 'planId=%s\n' "$PLAN_ID"
```

`artifactId`、`currentVersion` 和 `requestId` 是必填项。还可传：

- `channel`，但只能省略或与 artifact channel 完全一致；
- `releaseNotes`；
- `targetUserIds` / `targetInstallIds`；
- `rolloutStrategy` / `rolloutPercentage` / `rolloutRings`；
- `featureKeys`；
- `suiteId` / `topology` / `sites`。

`productId`、`releaseId`、`componentId`、目标版本、URL、digest、size、platform、arch
都从服务端保存的 artifact 派生。create body 即使伪造这些字段也不能覆盖 artifact
metadata。`createdBy/requestedBy` 同样不由调用方决定，审计身份强制使用 Bearer token
对应的 service account。

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
  -H "authorization: Bearer $TOKEN" |
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

完成定向 gate：

```bash
curl -fsS "$BASE/internal/v1/sdk/releases/$PLAN_ID/gate" \
  -H "authorization: Bearer $TOKEN" \
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

若使用 `release-center-publish.mjs --approve`，必须同时提供
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
    -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    --data-binary @-
)"

FULL_PLAN_ID="$(jq -er '.plan.planId // .release.planId' <<<"$FULL_PLAN_JSON")"
```

全量 plan 同样先得到 `blocked` gate；它复用同一个 `artifactId`，但必须使用新的
`requestId`。审批人复核定向 plan 后，再调用同一个 gate endpoint
把 `$FULL_PLAN_ID` 设为 `passed`，并把定向 `$PLAN_ID` 写入 `evidence`。当前 API 没有
“原地扩大定向 audience”的接口；不要假设定向 plan 会自动变成全量。

`release-center-publish.mjs` 是“上传本地文件并创建一个 plan”的 one-shot 包装，不提供
`--artifact-id` 或 `--plan-id` 复用模式。CI 使用它时必须显式传稳定的
`--release-id` 与 `--request-id`，否则默认随机 ID 不适合超时重试。canary → full
promotion 和对既有 plan 的延后审批应使用本章 curl：复用服务端返回的同一个
`artifactId`，为全量 create 使用新的稳定 `requestId`，不要再次运行 CLI 并误以为它会
自动复用旧 artifact。

## 8. Consumer 保持现有接法

Luopan 主进程继续通过 `@qpjoy/electron-launcher` 的 release updater 调用现有接口。
下面只用于排障，不应替代包内 updater。定向 plan 的 gate 为 `blocked` 时预期得到
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
| token 返回 `401 invalid service account credentials` | service account 是否 active；K8s JSON 是否包含完全一致的 client ID；secret 是否至少 32 字符；Internal API 是否已 rollout |
| token 提示仅限 Internal | 请求是否经过 Domestic 公网 edge；改为 Internal 地址或已 ready 的 Luopan 产品 VIP |
| Publisher 返回 `401` | Bearer 是否缺失/过期、audience 是否为 `mx-sdk` |
| Publisher 返回 `403` | token 是否有对应 read/publish/approve scope；`allowedProductIds` 是否含 `luopan`；artifact/plan 是否属于 Luopan |
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

1. 平台先注册 ProductNetwork/AppCenter，并确定唯一 `productId` 和小写 channel；检查
   `productId` 不使用保留的 `-renderer/-config` 后缀，两个派生组件也不与启用产品冲突；
2. 平台创建独立 service account、独立 secret 和最小 `allowedProductIds`；
3. 产品 CI 构建并完成 OS 签名/公证；Release Center 不替代构建、签名或 notarization；
4. CI 计算 sha256，通过 scoped artifact endpoint 上传；
5. CI 只用 `artifactId` 创建 `blocked`（待验证）定向 plan，并先做离线/CI artifact 验证；
6. Approver 过定向 gate 后，圈定 Consumer 才使用现有 updater 真机升级并 report；
7. Approver 依据定向客户端证据建立并审批全量 plan；
8. 每个平台/架构独立验证；回退版本必须仍有 gate-passed 全量 plan 和可下载 artifact。

接入方不需要访问 Admin 全量 Release Management API、K8s、数据库或 OSS 凭据。若需求超出
上述 SDK facade，应先扩展受 scope 和 product allowlist 约束的契约，不要把 Internal ops
token 或 Admin endpoint 暴露给产品 CI。
