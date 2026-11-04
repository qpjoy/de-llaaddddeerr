# Instagram 熔断与 Twitter 429（2026-10-27）

## 事故证据与尚未确认的原因

| 平台 | 用户提供的 Request ID | 已确认 | 待线上核查 |
| --- | --- | --- | --- |
| Instagram | `ed363e5f-41c2-4082-8c02-8e004d389358` | 生产诊断记录 503 / `external_platform_circuit_open`，usage 与客户预留均 released，客户扣费 0；无供应商或连接器调用记录。 | 实际供应商、当时触发熔断的失败类型、是否仍受保护；缺少调用记录本身不能证明未派发。 |
| Twitter | `447fadc0-5de6-4a83-8dec-d9d7a3b5aa2b` | 一个 RapidAPI `twitter-aio.search` 调用返回 HTTP 429 / rejected；失败响应 committed。客户已扣 ¥0.01，供应商 `billed=null`。 | 已保存的 99 字节受限响应所述原因、限流是短期频率还是套餐额度、恢复时间、供应商实际结算。 |

Instagram 的数据库默认策略是 fixed/JustOne，管理员可修改；默认值不证明这次请求的实际路由。Twitter 当前标准搜索允许特定 RapidAPI HTTP 400 保底，429 不触发该切换；其适配器对明确的 429 不增加熔断计数。因此两处错误不能据此合并为同一个供应商或网络故障。

用户提供的两份生产诊断分别保存于 `/tmp/hub-diagnostics-ed363e5f-41c2-4082-8c02-8e004d389358.json` 和 `/tmp/hub-diagnostics-447fadc0-5de6-4a83-8dec-d9d7a3b5aa2b.json`，检查时间为 2026-10-27 07:25–07:26 UTC。Instagram 请求发生于 03:36:24 UTC，26ms 后释放；Twitter 请求发生于 05:35:40 UTC，其调用 ID 为 `df92fee0-4f3a-44ff-85b5-e266a90b1b37`，上游延迟 619ms。Twitter 的 `costMinor=1/costKind=estimated` 是供应商费用估算，与客户实扣分开，不能当作供应商已收费的证明。

本机只有 docker-desktop kube context、GitHub SSH 配置，没有生产 Hub `.env.internal`；浏览器工具被 Work 设置禁用。授权范围内的只读健康检查确认公网与 Internal Admin `/health/live` 返回 200。健康响应不证明付费搜索可用；本次分析依据用户导出的生产账本，尚未读取具体熔断触发记录和受限 429 回执。

## 本次代码修正

- Instagram 初始熔断拒绝补充实际保护范围、原因、截止时间、等待提示与 `upstreamDispatched=false`。响应契约保护与供应商共享保护分别标识；保留 HTTP 503 和 `external_platform_circuit_open`。
- Twitter 新调用在接收 HTTP 响应后立即留存固定数值限流头与 Retry-After，供 `diagnose-twitter-outcome.mjs` 只读查看。它们是供应商观测值，不用于修改 Hub 限额或推断月度套餐；历史缺失保持缺失。
- 保留原派发、回放、重试、熔断、计费和路由策略；无需数据库迁移。没有改动 MX-H2I、Launcher、SSO 或用户联网配置。

这些修正提高后续错误的可诊断性，**不代表原事故根因已经确认或线上恢复**。

## 先读取已保存记录

在管理台“可观测性 → 诊断中心”分别查询上表两个 UUID，打开“限制与恢复”查看当前状态。其对应只读接口为：

```text
GET /internal/v1/admin/request-diagnostics/ed363e5f-41c2-4082-8c02-8e004d389358
GET /internal/v1/admin/request-diagnostics/447fadc0-5de6-4a83-8dec-d9d7a3b5aa2b
GET /internal/v1/admin/admission-limits?requestId=ed363e5f-41c2-4082-8c02-8e004d389358
```

也可在有生产 kubectl 权限的服务器执行下面命令。使用已部署的只读诊断模块和 Pod 中现有的数据库配置，不需要复制或输出 Token，不启动应用、不发起搜索。

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- node --input-type=module <<'NODE'
import pg from 'pg'
import { lookupRequestDiagnostics } from './server/acquisitions/diagnostics.mjs'
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1,
  connectionTimeoutMillis: 5000, query_timeout: 6000 })
try {
  for (const id of ['ed363e5f-41c2-4082-8c02-8e004d389358', '447fadc0-5de6-4a83-8dec-d9d7a3b5aa2b']) {
    console.log(JSON.stringify(await lookupRequestDiagnostics(pool, id), null, 2))
  }
} catch (error) {
  console.error(JSON.stringify({ error: 'request_diagnostic_failed',
    code: ['request_diagnostics_timeout', 'request_diagnostics_unavailable'].includes(error.code) ? error.code : null }))
  process.exitCode = 1
} finally { await pool.end() }
NODE
```

需要 Twitter 更细的存档元数据时，在服务器 **Hub 源码目录**执行（此脚本可通过 stdin 运行，无需先部署）：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - 447fadc0-5de6-4a83-8dec-d9d7a3b5aa2b \
  < server/ops/diagnose-twitter-outcome.mjs
```

该诊断使用 READ ONLY 一致性事务。新限流头只对修正后实际取得且成功留存的响应存在；运行新版诊断不能补回旧头。旧 `diagnose-instagram-search.mjs` 针对 TikHub 解析隔离，不适合将本次泛化熔断直接归因为旧解析事故。

本次已确认 Twitter 受限存档存在，可用扩展后的搜索诊断读取该次归档。先核验完整字节的长度与 SHA-256，再将固定位置的已知 429 错误模板转换成 `savedMessageObservation`。它只报告归档文案的说法（`*_claim`），不会输出原文、套餐名称或链接；不认识的模板保持 `unknown`，不推断阈值、账户状态或恢复时间。使用新版脚本通过 stdin 运行即可，无需部署服务：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - 447fadc0-5de6-4a83-8dec-d9d7a3b5aa2b \
  < server/ops/diagnose-twitter-search.mjs \
  > /tmp/hub-twitter-429-evidence.json
```

Instagram 使用新的专用脚本读取该请求网关记录中的实际供应商、该供应商当前状态、Instagram 契约保护与当前策略，并有界读取原请求前后五分钟内的失败调用元数据：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - ed363e5f-41c2-4082-8c02-8e004d389358 \
  < server/ops/diagnose-instagram-circuit.mjs \
  > /tmp/hub-instagram-circuit-evidence.json
```

两条命令均在同步了本次诊断脚本的服务器 Hub 源码目录执行。Instagram 报告分别标记 `historical/current/nearbyHistoricalFailures`；相邻失败仅是候选证据，当前状态不代表事故时状态。脚本不读取凭据、客户身份或原查询，不清空熔断。网关记录缺失时不根据当前策略猜测历史供应商。

## 根据证据处理

- Instagram：先看实际供应商和当时错误证据，再核对当前保护。共享保护可能涉及认证、额度、频率或传输；契约保护需要核对已归档响应。当前状态可能已过期或被后续调用改变，不能直接当作事故时的原因。不要仅凭截图清空保护或换路由。
- Twitter：核对实际 429 回执；`limit=null` 表示 Hub 没有已验证的供应商限额。明确 429 不证明供应商未收费，`billed=null` 仍为未知。数值 reset 观测值没有统一时间单位，不据此承诺恢复时间。
- 原查询是否已派发、是否已付费、是否存在未知或已提交回执，分别以对应请求账本为准。沿用相同幂等标识重新 POST 也受回放窗口约束，不作为只读检查。

## 发布边界

本地代码修正完成后由操作员按正常 Hub 流程发布，无需修改供应商凭据或迁移历史记录：

```bash
# 服务器 Hub 源码目录；同步本次完整代码后执行
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh ops internal-production deploy
```

本次没有执行生产部署、付费探测或历史记录修复。上线后新响应会包含补充诊断信息；既有回执和失败回放保持原样。

## 本地验证

- `npm run typecheck` 通过。
- Twitter 传输证据、失败回放与 outcome 诊断三文件共 38 项通过、0 跳过，包含实际 PGlite 数据库约束与只读 SQL；测试依赖仅从本机 npm 缓存提取到 `/tmp`，未修改项目依赖。
- Instagram 定向回归 12 项通过，覆盖 JustOne/TikHub、raw/标准搜索、共享/契约熔断与原失败回执保持。
- Twitter 搜索归档诊断 15 项通过、0 跳过，包含真实只读 SQL、归档字节不变、完整错误模板边界与旧部署解析器下的 stdin 执行。
- Instagram 只读诊断 5 项通过，包含实际 SQL、历史供应商与当前策略分离、相邻失败窗口、缺失可选表与不兼容 schema 的显式结果。
- 扩展回归仍有已有问题：三份网关套件中的 4 项 Twitter 默认 `Top/Latest` 预期不一致，已用改动前模块复现；Twitter 诊断 bundle 构建器的既有依赖白名单未跟随 `twitter-search-query.mjs` 更新。本次提供的两条 stdin 命令不使用该 bundle 构建器。这些未作为本次限流诊断的修复内容。
