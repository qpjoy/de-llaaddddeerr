# 贴吧权限拒绝与诊断记录缺口（2026-11-17）

## 已有证据

用户提供的 Delta Agent 通知显示：`social_query`、`action=search`、`platform=tieba`，Hub HTTP 403，错误码 `platform_not_granted`，请求 ID 为 `ab00ef17-1e2e-4085-8254-eb6a13729966`。用户确认使用 `lcy-delta` Key。通知中的 `dev` 是调用方环境标签，不能据此认定 Hub Key 为 test，或把同名应用当作唯一调用身份。

诊断中心返回 0 条关联请求，并明确提示“未匹配不代表请求成功”。这不是一次成功查询。历史请求的实际 HTTP 路径、准确 Key ID 和当时的授权快照尚未取得；不凭截图补造 usage、供应商调用或账务记录。

## 代码中确认的问题

标准搜索和 Night-All 兼容搜索先检查有效平台权限，再创建 usage reservation。有效权限是应用当前授权与 Key 自身范围的交集；`legacy_dynamic` Key 沿用应用授权。平台校验拒绝直接返回 HTTP 请求 ID，不会创建 usage。

原诊断只读取 `usage_requests`，以及已关联 usage 的供应商和连接器调用。普通 403 `AppError` 也没有独立的持久拒绝证据，因此这类请求有 requestId 却可能查不到。已有 `usage_request_failures` 依赖 usage 外键，不能用于补记这种早期拒绝。

当前 Hub 的公共能力目录、标准 V2 搜索及固定 legacy raw 合同没有登记贴吧。标准 V1 仍有通用历史适配分支，不能仅从目录缺项断言其下游绝对不可用。Night-All-A 管理目录中的贴吧能力不等于公共 `social_query` 已接入；不能改走 Admin 接口绕过权限。权限与接口支持必须分别核对，不能承诺补授即可恢复搜索。

用户进一步确认 `lcy-delta` 是最高权限 Key。代码复核表明：原 LCY 的 `managed_full` 由部署时 `syncManagedApiAccess()` 把 `businessApiScopes()` 已登记的业务范围同步到应用授权及该 Key 的范围，并保留审计；它不是请求时放行任意平台的通配权限。当前 `businessApiScopes([]).platforms` 不含 `tieba`，所以“最高权限”与贴吧 403 并不矛盾。LCY 的限额豁免同样不绕过平台授权。

普通业务授权入口是“调用者 → 租户业务开通”，单 Key 在“API Keys → 调整 Key 权限”。但当前缺少贴吧的公共业务合同/目录登记，不能仅靠这两处勾选就完成 `social_query` 接入。后续应先明确并实现贴吧公共业务接口与供应商映射，登记能力后沿既有 managed-full 同步流程授权。403 本身不能证明底层贴吧服务未启动、未部署或供应商订阅未开通。

## 修复范围

新增 migration 193 的独立权限拒绝记录，只在已认证、明确位于 reservation 之前的搜索平台校验处采集。使用服务器生成的独立事件 ID；调用方提供的 HTTP requestId 只作关联字段，允许不同事件使用相同关联 ID，不能覆盖其他请求。

记录仅包含身份 ID、平台、Key 范围模式、固定接口路径、403 与错误码和时间；不保存关键词、请求正文、响应正文、Headers、Key 密钥或任意异常消息。写入有时间上限；失败保留原 403，不把诊断故障变成新的业务错误。授权判断和公共错误合同保持不变。

诊断 API 增加独立 `admissionFailures`，与 usage 分开展示。页面明确显示“Hub 权限校验拒绝”，不展示采购重试、额度恢复或结算按钮。查询和导出只读，继续限定 Admin Token。旧库未部署时明确提示拒绝证据不可用；旧请求不会自动补回证据。

## 现场核查与发布

已经提供不依赖新代码的 K8s 只读查询：按 `lcy-delta` 精确匹配应用名、business ID 或 Key 名，返回最多 20 个候选 Key 的状态、环境、范围模式、有效期及贴吧授权交集，同时精确查询原 usage ID。匹配名称只用于定位候选，不能证明哪个 Key 发出了历史请求。当前配置也不能代替历史授权证据。

无需同步代码或部署镜像，可直接在服务器执行下面命令。没有搜索、授权修改或供应商请求；不读取 Key 密钥、摘要或密文。

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-public -c api -- \
  node --input-type=module <<'NODE'
import pg from 'pg'
import { loadConfig } from './server/config.mjs'
let pool, db
try {
  pool = new pg.Pool({ connectionString: loadConfig().databaseUrl,
    max: 1, connectionTimeoutMillis: 10000 })
  db = await pool.connect()
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  await db.query("SET LOCAL statement_timeout='10s'")
  await db.query("SET LOCAL lock_timeout='1s'")
  const requestId = 'ab00ef17-1e2e-4085-8254-eb6a13729966'
  const usage = await db.query(`SELECT id,consumer_id,api_key_id,platform,status,response_status,error_code
    FROM public.usage_requests WHERE id=$1`, [requestId])
  const keys = await db.query(`SELECT k.id AS api_key_id,k.name AS key_name,
      c.id AS consumer_id,c.name AS consumer_name,c.business_id,k.environment,k.scope_mode,
      t.status AS tenant_status,c.status AS consumer_status,k.status AS key_status,k.expires_at,k.last_used_at,
      EXISTS(SELECT 1 FROM platform_grants g WHERE g.consumer_id=c.id AND g.platform='tieba') AS consumer_granted,
      EXISTS(SELECT 1 FROM api_key_platform_entitlements e WHERE e.api_key_id=k.id AND e.platform='tieba') AS key_snapshot_granted
    FROM api_keys k JOIN consumers c ON c.id=k.consumer_id JOIN tenants t ON t.id=k.tenant_id
    WHERE lower(c.name)=$1 OR lower(c.business_id)=$1 OR lower(k.name)=$1
    ORDER BY k.created_at DESC,k.id LIMIT 21`, ['lcy-delta'])
  console.log(JSON.stringify({ mode: 'current_state_not_historical', supplierHttpCallsMade: 0, writes: 0,
    requestId, savedUsage: usage.rows, keys: keys.rows.slice(0,20).map(k => ({ ...k,
      effective_platform_granted: k.consumer_granted && (k.scope_mode === 'legacy_dynamic' || k.key_snapshot_granted)
    })), truncated: keys.rows.length > 20 }, null, 2))
} catch (error) {
  console.log(JSON.stringify({ errorCode: 'read_only_inspection_failed',
    sqlState: /^[0-9A-Z]{5}$/.test(error?.code || '') ? error.code : null }))
  process.exitCode = 1
} finally {
  if (db) { await db.query('ROLLBACK').catch(() => {}); db.release() }
  await pool?.end()
}
NODE
```

取得准确 Key ID 后，可使用 `server/ops/diagnose-platform-access.mjs` 继续核对当前元数据；不发搜索、不扩权、不修改 Key、不自动重试。若调用方仍传入尚未接入其目标接口的平台，需要修正其能力选择，或另行完成该平台的公共接口接入。

本次改动仅涉及 Hub 搜索拒绝的可观测性；不修改 Launcher、MX-H2I 登录、联网或 SSO。同步代码后按 Hub 正常部署流程应用迁移与更新 Public/Admin/前端：

```bash
cd /root/mx/workspace/de-llaaddddeerr/electron-dock/mx-insight-hub
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh deploy
```

原历史请求仍可能显示无记录；新的同类拒绝才会具备独立证据。无需为验收重新发起付费搜索。

## 本地验证

新增 18 项专项通过（HTTP 搜索拒绝、独立 PostgreSQL 证据、诊断查询/UI 和当前权限核查），含真实 PGlite 与 React SSR。合并扩展回归共 94 项：92 通过，1 项未提供 `MX_ECOMMERCE_TEST_DATABASE_URL` 跳过，1 项既有 Telegram 能力断言失败；使用 HEAD 原版 HubService 单独复现相同 `semanticSearch` 新字段导致的旧断言失败，未修改该不相关行为。类型检查、前端构建与 `git diff --check` 通过。本次未部署、未修改生产授权、未发付费请求。
