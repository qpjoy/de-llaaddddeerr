# LCY-delta 的 Hub 限制开关

2026-10-30 扩大范围：此开关控制原始 LCY-delta Key 的 Hub 请求次数、频率、普通并发、月度采购/补贴预算与自动供应商熔断等待。它不改变业务接口、请求参数、Key 密文、授权或价格，也不能解除上游供应商实际执行的限制。

## 管理入口与身份范围

使用 **Admin Token** 登录 Hub，进入 **API Keys → LCY-delta → Hub 限制开关**。在“数据浏览中心 → 限制与恢复”选中此 Key 后，也可以通过链接进入。普通租户会话和 Launcher/SSO 管理会话没有此设置入口或接口权限。

服务端同时校验以下不可变身份，不按名称匹配：

| 身份 | UUID |
| --- | --- |
| API Key | `fd2f8cc9-0ff1-4052-a538-8cc8150bde83` |
| 租户 | `277bf8a4-5ed5-414d-b429-d72fcd7d36b6` |
| 调用者 | `be7d07fe-3d98-4db3-b00d-e5cbe5a76190` |

重命名其他 Key、创建同名 Key、签发替代 Key、在业务请求中添加豁免字段，都不会获得此设置。读取和保存只访问 Hub 管理接口，不触发供应商查询。

## 三种保存状态

| 保存值 | 界面状态 | 行为 |
| --- | --- | --- |
| `null` | 沿用历史策略 · 尚未显式设置 | 保留现有内部 Key 的部分豁免；不等于已开启本开关的频率与并发豁免。部署迁移不会自动开启。 |
| `true` | 豁免已开启 | 跳过 Hub 业务查询的请求次数配额、限频、普通执行并发门禁、月度采购/补贴预算和自动供应商熔断等待；下列业务与安全边界继续生效。 |
| `false` | 豁免已关闭 · 普通 Hub 限制 | 使用普通 Hub 限制；明确覆盖原始 LCY Key 的 `managed_full` 及环境内部身份配置带来的额度豁免。 |

界面开关是待保存选项；点击保存并得到服务端确认后，才改变“当前状态”。每次变更填写原因，使用当前版本号提交，并记录不可变审计。首次把历史策略显式保存为关闭，会恢复普通限制，不能把它理解为“保持原样”。管理接口不提供写回 `null` 的操作。

保存影响后续准入，不清空历史计数，不改已经保存的响应或结算，不取消已派发调用，不重新执行旧请求。关闭后已有累计用量仍按普通规则计算，可能立即达到额度。

## 保留的业务与安全边界

以下规则继续生效：Key、租户和调用者有效性；平台、操作和合同授权；服务暂停/发布控制；凭据和合同校验；余额、价格、费用预占及结算；响应及合同隔离；结果未知、重复采集和幂等保护；分页、响应大小及传输限制。

商品媒体传输仍受自身的请求频率、并发和响应大小限制，可能返回 `external_media_rate_limited` 或 `external_media_busy`。IP 订阅权益继续检查已购总次数、每日次数和有效期，可能返回 `commerce_quota_exhausted`、`commerce_daily_limit_exhausted` 或 `commerce_subscription_required`。这些分别属于传输资源保护和已购权益，不由此开关解除。

Facebook RapidAPI 的已购供应商额度账本和单笔派发记账顺序仍然保留，不能通过此开关清空已购额度或破坏不确定调用的账本。普通供应商并发/RPM 限制可豁免，供应商实际额度耗尽仍会阻止成功获取数据。此开关不会自动重试、切换供应商或增加付费调用。

“限制与恢复”中的共享供应商行仍显示真实全局状态。选中此 Key 时的豁免说明只描述该 Key 的效果，不将共享限制伪装成已解除，也不会影响其他 Key。

## 上游限流的错误语义

对新请求的已识别上游限流，保留原来的 HTTP/主错误码兼容性，并补充可区分来源的字段：

```json
{
  "error": {
    "code": "external_platform_capacity_exceeded",
    "details": {
      "layer": "upstream",
      "reason": "upstream_rate_limited",
      "upstreamDispatched": true,
      "upstreamStatus": 429,
      "limit": null,
      "retryable": false
    }
  }
}
```

示例用于解释字段，不是所有产品共用的新主错误码：原有社交/Web Search 等主错误码继续保留；供应商通过 HTTP 200 的业务码表达限流时，`upstreamStatus` 仍记录实际 HTTP 200。只有有证据时才附加 `outcome`，没有可靠额度/恢复时间时不编造 `limit` 或 `retryAfterMs`。旧的已保存响应保持不变。

IP 查询的公共 HTTP 状态保留原来的 502，并通过新增 `error.details.layer`、`reason`、`upstreamStatus` 等字段说明真实上游限流；不把普通 Key 的原 HTTP 合同改成 429。

Hub 自己的并发等待拒绝则使用 `layer: "hub"`、`stage: "concurrency_admission"` 与具体 `reason`，可提供 `retryAfterMs`。下游应展示消息、错误码、来源和 Request ID；不能单凭 HTTP 429 自动重发已经派发的付费请求。

## 管理接口

```text
GET /internal/v1/admin/api-keys/:id/hub-limits
PUT /internal/v1/admin/api-keys/:id/hub-limits
```

认证沿用 `x-mx-insight-admin-token`。GET 和 PUT 的 `data` 均返回：

```json
{
  "apiKeyId": "fd2f8cc9-0ff1-4052-a538-8cc8150bde83",
  "policyVersion": 2,
  "hubRateLimitExempt": null,
  "effectiveExempt": false,
  "inheritedQuotaExempt": true,
  "source": "legacy",
  "revision": 0,
  "updatedAt": null
}
```

`policyVersion: 2` 表示服务器已包含 2026-10-30 扩大的预算及自动熔断豁免；旧版本没有这个字段。`effectiveExempt` 仅表示显式开启本开关的豁免范围；`inheritedQuotaExempt` 说明历史额度豁免。显式保存后 `source` 为 `explicit`。PUT 请求为：

```json
{
  "hubRateLimitExempt": true,
  "revision": 0,
  "reason": "允许 LCY-delta 直接接收上游限流反馈"
}
```

必须使用刚读取的版本号。`409 api_key_hub_limits_changed` 表示其他管理员已修改，需重新读取后决定；`403 api_key_hub_limits_not_supported` 表示身份不在范围；失效/撤销/测试 Key 或停用身份不能保存。网络断开时保存可能已完成，界面会清除旧快照并要求重新读取，不自动重试 PUT。

## 发布与启用

先发布 migration `153_api_key_hub_limits.sql`、Public API、Admin API 和前端的同一版本，确认**所有 Public/Admin Pod 已更新，滚动更新中的旧 Pod 已退出**，再在界面保存开启。不能只更新前端或部分 Public 副本；旧进程既会执行旧限制，也不能正确处理 PGY 豁免派发使用的新 `exemptActive` 队列状态。迁移默认保留历史状态，不自动开启 LCY，也不修改其他 Key。

如果需要回滚旧代码，先关闭开关并等待正在执行的 PGY 豁免任务结束；关闭不会取消已派发任务。不要通过清空队列或未知结果记录来完成回滚，否则会丢失防止重复付费调用的证据。

由操作人员在服务器的 `electron-dock/mx-insight-hub` 目录执行既有 Hub 部署命令，代理参数沿用当前服务器配置：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 \
bash scripts/manage.sh ops internal-production deploy
```

该流程只发布 Hub，保留 MX-H2I 的登录和联网链路。代码实现和离线验证不代表生产已发布或开关已开启；本次不自动执行生产部署、开关写入或付费探测。发布后可只读打开开关核对版本和状态，明确保存一次开启，重新读取确认，再观察后续原有业务流量的 Request ID 与错误来源。

## 界面验证记录

最终本地集成回归共 521 项：514 项通过、7 项因未配置真实 PostgreSQL 测试环境跳过、0 项失败。已启用实际 PGlite 的迁移、审计事务、准入与账本测试；覆盖开启/关闭、同名冒用、普通 Key 计数、分页中关闭、PGY 重复拥有者与未知结果保护。类型检查与 Vite 构建通过，未调用真实供应商。

本地使用实际 Hub React 页面和拦截的合成管理响应验证：历史状态开启/关闭及重新打开；必填原因；409 版本冲突后重新读取；保存响应丢失时不重复提交；同名其他 Key、错误租户和 SSO 管理员均不显示开关。所有测试均未发起 Public 业务查询。

1440×1000 桌面与 390×844 移动端的新增弹窗可正常显示、滚动和操作，没有弹窗内横向溢出、框架错误或未处理异常。API Keys 原有背景表格在手机宽度下仍有页面横向溢出，移除新增按钮也存在；本次未修改该表格布局。浏览器插件未提供，验证使用本机 Playwright/Chrome。管理客户端回归确认只使用 GET/PUT 管理路由，保留原版本号和错误详情，不自动重试保存。

## 2026-10-30 最大业务豁免

用户进一步要求 LCY-delta 最大豁免。新版继续使用原开关，不另建同名 Key，也不更改 Key 密文。显式开启后：

- 请求次数、供应商 RPM、普通并发继续豁免。
- 即使请求没有正价钱包 hold，也不会被 Hub 月度采购和补贴预算上限拒绝。该行为适用于共用采购账本的 JustOne、TikHub、RapidAPI 等调用路径。
- 无关历史成本缺失不会阻塞该 Key 的新请求；本请求的成本及预占证据仍必须完整。成本照常保存，不将预算豁免标成客户已付费，不清零共享预算或历史成本。
- 跳过 Hub 供应商级自动熔断等待，包括充值或修复前留下的欠费、认证、传输错误等记录。每个新请求仍实际接受上游成功或失败；不推断上游已恢复，不清空共享熔断，不自动重试旧请求。
- 管理员主动暂停（包括三个 Facebook 业务开关）、凭据/合同准入、合同级隔离、未知结果、防重复采购、幂等、正常客户扣费和钱包余额检查保持生效。
- Key 生命周期、服务授权、有效套餐、IP 已购订阅权益、响应/分页/传输硬边界及实际资源故障不能由此开关解除。

已有 `true` 在全部服务升级后自动取得扩大范围；`false` / `null` 不被部署静默开启。管理页要求读取到 policyVersion 2，避免对旧后端作出扩大范围的错误承诺。预算核对会读取当前 Key 状态及原始租户/调用者绑定，不能靠请求字段或同名 Key 冒用。

### 发布后启用

此增量不新增数据库迁移，依赖已存在的 153。先通过上方正常发布命令完成全部 Public/Admin 和前端更新，再在服务器 Hub 仓库目录执行：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -- \
  node --input-type=module - --apply < scripts/enable-lcy-max-exemption.mjs
```

省略 `--apply` 为只读预览。脚本只请求 Pod 本机管理 API，读取已有 Admin Token 环境变量，不输出凭据、不调用供应商。它核对 policyVersion 2、读取当前修订后只保存一次开启，再回读确认；已经开启则只读返回。并发修改或保存结果未知时不重试，不清计数。回退可在管理页显式关闭开关，或者回退代码；历史账本保持不变。

本次仅完成本地实现和合成数据验证，尚未执行生产发布或生产开关写入。浏览器验证包括打开、保存开启与重新读取，均未使用真实凭据或产生供应商请求。

本增量验证：九个相关测试文件 132 项通过、2 项需真实 PostgreSQL 环境跳过；LCY 诊断视图另 1 项 PGlite 测试通过。新增测试执行真实 PostgreSQL 身份核对 SQL，成本写入路径另以可控账本夹具验证，不能视为真实多连接并发压测。另运行旧 `admission-recovery.test.mjs` 全文件时，两项既有夹具缺少 `usage_requests.fingerprint`，与本次豁免路径无关；保留原夹具，单独运行受影响的 LCY 诊断用例已通过。类型检查、构建及本地浏览器保存/回读通过。

### 2026-10-30 资源保护补充

最大豁免不取消新增加的“产品与 API 资源限速”。所有 Key 默认受它保护，并可单独约束 LCY 的产品/API；它与历史供应商限速开关分开。预算身份判断合并到已有成本证据查询，不为豁免单独增加数据库往返。见 [资源限速与性能边界](product-api-resource-limits-2026-10-30.md)。

## 2026-10-31 供应商优先排队

状态：已实现未部署。需要 migration `172_api_key_supplier_priority.sql`，与 Public API、Admin API 和前端同一版本发布。

### 为什么

原来的豁免会让 LCY 跳过供应商并发和每分钟请求数（`gateway.mjs` 的 `#enter` 直接返回 `exempt`，限速令牌直接放行；TikHub 内部流量也不取令牌）。Delta 的突发请求原样打到供应商，供应商回 429（证据里 `limit: null`），Hub 标为不可重试，Delta 再把整个平台挂起。豁免实际上把“在 Hub 排几秒队”变成了“上游失败加 Delta 冷却”。

### 新增的选择

开关显式开启后，多了一项“供应商并发与每分钟请求数”：

| 保存值 | 行为 |
| --- | --- |
| `bypass`（默认，所有已有记录） | 与原来完全一致 |
| `priority` | 按“管理”页的供应商并发与每分钟请求数发起，名额不足时排在其他 Key 前面等待 |

Hub 次数配额、月度采购/补贴预算、共享自动熔断等待的豁免在两种模式下都保留。关闭豁免后这个值不生效，但会保留，下次开启时沿用。只有原始 LCY 身份能保存 `priority`（数据库约束同 153）。旧版界面只提交 `hubRateLimitExempt` 时保留已存的模式。

### `priority` 的具体规则

- **并发。** LCY 计入网关并发计数，不受单调用者上限限制。有 LCY 请求在执行或等待时，其他 Key 合计最多占总并发的 20%（`LCY_RESERVED_SHARE = 0.8`）；LCY 空闲时其他 Key 可以用满。正在执行的请求不会被打断，所以 LCY 偶尔要等一个普通请求结束。按进程计数：每进程 4 个名额时，LCY 有任务期间普通 Key 拿不到名额。
- **等待。** 名额不足时 LCY 进入等待队列，排在普通 Key 前面。最长等待取“管理”页的最长等待时间与（请求剩余时间 − 上游超时 − 5 秒）中较小的一个；多步工作流按剩余调用数扣除。等待期间保留调用方已持有的派发租约，不重新抢占。等不到时返回 `429 external_platform_busy`，`details.layer = "hub"`、`upstreamDispatched = false`、`admissionMode = "priority"`、`retryAfterMs = 1000`：尚未调用上游、不计费、可重试。原来允许“满额立即改用已存结果”的入口，LCY 改为在时限内等待实时结果，因为它原来就不受这道门限制。
- **每分钟请求数。** LCY 也取供应商令牌桶（PG 共享，跨进程准确）。拿不到时按 `retryAfterMs` 等待，不再绕过；等待同样不超过“管理”页的最长等待时间和请求截止时间（2026-10-31 补：生产预留租约 180 秒，只按租约等会超过 Delta 的 90 秒超时）。并发等待和限速等待先后各自计时，最坏合计约两倍最长等待时间再加一次上游超时，所以最长等待时间建议不超过 20 秒。TikHub 的令牌桶突发量为 1（`MX_INSIGHT_TIKHUB_RATE_LIMIT_BURST`），即严格匀速：每分钟 60 次就是每秒 1 次。普通 Key 仍是一次尝试。
- **上游限流后放慢。** 供应商最近一次失败是 `upstream_rate_limited` 时，LCY 的取令牌速率先降到配置值的一半，60 秒内线性恢复；之后任何一次成功调用会清掉这个状态，立即恢复全速。依据是共享的供应商状态，所有进程一起放慢，不新增状态。只是放慢，不拒绝，也不加冷却。
- **明确未计费的限流拒绝重试一次。** 只有 `outcome = rejected`、`billed = false`、`errorCode = upstream_rate_limited`（RapidAPI 网关自己返回的 429、JustOne 业务码 302）才会在同一请求内等 1 秒后用同一供应商重试一次，前提是还能放下一个完整的上游超时。这次拒绝照常计入供应商失败，所以重试按减半的速率取令牌。重试只有一次；结果收费或不确定的（TikHub、Twitter 的 429 是 `billed = null`）、余额不足等其他拒绝都不重试。重试记为同一客户请求的第 2 次供应商调用（`callOrdinal = 1`, `callRole = retry`），客户只计一次。
- **小红书 PGY 详情队列、Facebook 全局额度队列。** LCY 按普通规则排队，不再跳过；PGY 原有的“可重试错误重排一次”随之适用。

### 范围

已接入：通用网关（JustOne、RapidAPI、Web Search、企业等走 `gateway.mjs` 的路径）、TikHub 小红书网关、TikHub 用户资料网关、内容搜索工作流（抖音/快手/B站等，TikHub 429 的主要来源）、账号工作流、Twitter 与 Facebook 补页。

未接入：IP 风险产品（百度渠道的冷却、令牌、日配额仍按原豁免），微博原始搜索的详情补全（自带等待循环，只是不再跳过令牌）。

### 与其他限制的关系

- **171 资源保护。** 等待中的请求占着 HTTP 执行名额（默认每进程单 Key 32）。如果 Delta 同时在途请求超过约 4 × 32，新请求会立即收到 `resource_admission_limited`。开启前用实际在途峰值核对，必要时在“管理 → 产品与 API 资源限速”给 LCY 设规则。
- **数据产品“管理”页。** 供应商并发与每分钟请求数从此真正约束 LCY。**开启前先把这些值调到不低于 LCY 平时的用量**，否则 LCY 会变慢并收到繁忙错误。
- **多副本。** 并发计数和等待队列仍在进程内。Public 加副本前必须完成 [Spider-Man 04](../architecture/spider_man/04-admission-and-concurrency.md) 第 4 节的 PG 全局租约。

### 启用与回退

1. 按上文正常发布命令发布（含 migration 172），确认所有 Public/Admin Pod 已更新。
2. 在“数据产品 → 管理”核对 TikHub、JustOne、RapidAPI 的并发和每分钟请求数。先在服务器 Hub 目录跑只读脚本取 LCY 近 7 天的实际负载：

   ```bash
   kubectl -n mx-common exec -i statefulset/mx-common-postgres -- \
     psql -X -U mx_common -d mx_insight_hub < scripts/inspect-lcy-supplier-load.sql
   ```

   第 0 段确认 172 已执行；第 2 段的 `p99_per_min` 是每分钟请求数的下限参考，`needed_concurrency` 是并发的下限参考；第 3 段是实际同时在途峰值；第 4 段对比 429 所在分钟和平时的调用量：明显更高说明是突发导致，排队能消掉；差不多说明是供应商自身限制，排队消不掉；第 5 段的 HTTP 在途峰值应明显低于 128（每进程 32 × 4）。每分钟请求数不能高于供应商实际允许的值。
3. API Keys → LCY-delta → Hub 限制开关，选“优先排队”，填写原因保存。
4. 观察：LCY 的 `upstream_rate_limited` 是否下降；`external_platform_busy` 且 `admissionMode = "priority"` 的数量；Delta 的平台挂起是否减少。
5. 回退：在同一界面改回“绕过”，立即生效，不需要部署。

### 本地验证

- 新增 `tests/server/lcy-supplier-priority.test.mjs` 10 项：身份与模式判断、队列优先、80% 预留、等待/超时/取消/重新校验失败释放名额、放慢与恢复、按截止时间取令牌、开关 CAS 与审计及旧客户端保留模式、JustOne 302 在同一请求重试一次且只计一次费、绕过模式/第二次拒绝/余额不足都不重试。
- TikHub 小红书网关新增 2 项：保留共享熔断豁免但按减半速率取令牌；满额时排队而不是绕过。
- 全量 Hub 服务端测试与改动前基线对比，见下方记录。

### 2026-10-31 首轮实测与建议值

`scripts/inspect-lcy-supplier-load.sql` 在 Internal 上的结果（近 7 天，开关仍为绕过时的流量）：

| 供应商 | 每分钟 p95 / p99 / 最大 | 同时在途 p99 / 峰值 | 延迟 p50 / p95 | 部署默认（并发 / 每分钟） |
| --- | --- | --- | --- | --- |
| TikHub | 68 / 93 / 242 | 29 / 42 | 2.6 s / 6.3 s | 16 / 50 |
| RapidAPI | 33 / 89 / 110 | 30 / 46 | 3.2 s / 7.8 s | 6 / 60 |
| JustOne | 8 / 18 / 48 | 9 / 31 | 0.3 s / 5.6 s | 32 / 50 |
| 启信宝（qixin） | 26 / 28 / 28 | 12 / 13 | 0.2 s / 0.3 s | 10 / 30 |

- 管理页没有任何已保存的供应商限额，全部是部署默认值；默认值低于 LCY 的实际用量，开启优先排队后 TikHub、RapidAPI 会明显排队。
- TikHub 近 7 天 30,710 次调用里 5,951 次被 429（约 19%），全部 `billed = null`。出现 429 的分钟中位数 73 次，平时 6 次：限流由突发造成，匀速排队能消掉大部分。
- 首轮建议（观察一天再调）：TikHub 并发 24、每分钟 90、最长等待 20 秒；RapidAPI 并发 24、每分钟 90、最长等待 20 秒；JustOne 保持默认；启信宝（企业数据）并发 16，其余默认。单调用者并发不影响优先模式下的 LCY，保持默认即可。
