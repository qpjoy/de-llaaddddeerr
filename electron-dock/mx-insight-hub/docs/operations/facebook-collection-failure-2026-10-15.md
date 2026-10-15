# Facebook 采集失败（2026-10-15）

## 已确认的请求

下游报告首页失败、完成 0 页、累计入库 0，检索式包含 OR 和引号。
Hub 请求 ID：`e0885b83-be96-4525-bfdd-c5b3c5bf1d4f`。
运营者于 `2026-10-15T05:11:27.249Z` 返回既有只读请求诊断结果。

| 项目 | 原账本证据 |
| --- | --- |
| Hub 状态 | committed；保存 HTTP 502 失败响应，可回放 |
| Hub 预占 / 完成 | 2026-10-15T01:09:11.260Z / 01:09:12.203Z |
| Hub 错误 / 数据单元 | upstream_collection_failed / 0 |
| 本请求调用数 | 1；列表未截断，无 Night-All connector 调用 |
| 渠道 / 操作 | JustOne / native.j.facebook_post_search_v1 |
| Provider call ID | a6617674-59ef-4f96-92d4-41d8bb072af1 |
| 供应商关联 ID | 2b74548b0a604b22b885abf6dcddde88 |
| 调用起止（UTC） | 2026-10-15T01:09:11.333Z 至 01:09:12.203Z |
| HTTP / 业务码 / outcome | 200 / 301 / rejected |
| 调用耗时 | latencyMs=850 |
| 供应商计费 | billed=false |
| 采购估价 | costMinor=1、costKind=estimated、CNY；不是实际扣费证据 |
| 归档 | 普通与受限归档均存在，报告 bodySize=136；本轮未读取或校验原字节 |
| 客户结算 | captured / enforced，quotedMinor=chargedMinor=1 CNY 最小单位，即 ¥0.01 |

301 经 JustOne 适配器固定映射为采集失败，再映射成公共
`502 external_platform_rejected`、`reasonCode=upstream_collection_failed`、`retryable=false`。
HTTP 200 只表示收到响应，committed 只表示该失败响应及其结算已经保存；两者都不能当作交付成功。
原始错误消息受限且未展示，不能推断内部超时、风控、Cookie、查询语法或当前恢复时间。
本请求中没有 RapidAPI 调用，故没有本请求内的 RapidAPI 429 后置回退。

## 选路边界

仅 JustOne 的账本既可能来自固定 JustOne 模式，也可能是自动模式的派发前跳过 RapidAPI。
当前 Facebook 订阅准入最多允许一个 RapidAPI 在途调用；`source_busy`、限流、配额和其他已允许准入阻断
可使自动模式在第一次采购前选择 JustOne，不能从渠道名称反推“月额度已经耗尽”。

先前 Twitter 并发取证中的 Facebook RapidAPI 调用
`65a66fbd-557e-4f83-9cf6-ea8c3e4a7341`（所属请求 `4ea1aa6e-85f2-4e83-ae80-32b77d89acd6`）
在 `01:09:11.018Z–01:09:16.317Z` 执行，与本次覆盖重叠，符合 `source_busy` 场景。
但本请求未保存当次选路模式/准入原因，不能将该关联升级为已证实的唯一选路原因。
当前策略快照也不能替代当时状态。

## 客户扣费解释

`finishFailure` 当前将 JustOne 的明确拒绝保存为 committed、HTTP 502、unitsActual=0。
既有商业结算触发器对 committed 的正价 enforced 按请求预占执行 capture，
没有按 responseStatus 或供应商 billed=false 自动豁免。因此本次失败仍捕获 ¥0.01，与已返回客户账本一致。
这是现有规则的事实说明，不代表用户已确认该收费政策，也不授权退款、改历史或扩大到其他供应商的规则变更。

## 后续处理和验证

采集渠道可按供应商关联 ID `2b74548b0a604b22b885abf6dcddde88`、上述 UTC 起止和接口查询内部 301 原因。
本轮没有对外发送消息或发起重试。保留原检索式与检查点，不擅自拆分 OR、替换供应商或把错误伪装为空结果。
已保存的失败响应仍按原幂等回放；新的业务采集可能产生新的成本，不能把它当作只读核查。

该次离线回归最初以实际适配器合成响应覆盖 raw/standard × 固定 JustOne/自动 source_busy 四种组合。
随后用户要求繁忙时全局排队，自动组合改用明确 `quota_exhausted` 触发 JustOne，保留以下验证：
检索式完整传递、日期映射、唯一 JustOne 301、无 RapidAPI 派发、无自动重试、0 入库、
保存 502 和当前客户结算事实、策略改为 paused 后仍精确回放原失败且不重复扣费。
该回归通过。它核实本地实现边界，不是原归档重放，也不证明供应商当前可用。
本次 301 调查没有修改计费政策或历史记录，没有生产部署或 MX-H2I 登录联网改动。
后续共享队列与计数修复见 [Facebook 全局额度排队](facebook-shared-quota-queue-2026-10-15.md)，
不能用后续代码推断本请求当时的选路原因。

## 原始失败与历史选路的进一步只读检查

用户要求确认之前错误的具体原因；首次准备以下检查时尚未收到该 136 字节归档的校验结果。
全局队列和单调额度修复针对本地可复现风险，不是已完成的历史根因证明。
新增独立脚本 `server/ops/diagnose-facebook-failure.mjs` 可直接送入原 Admin 镜像，
无需先部署新运行时。在同步脚本后的 Hub 目录执行：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - e0885b83-be96-4525-bfdd-c5b3c5bf1d4f \
  < server/ops/diagnose-facebook-failure.mjs
```

诊断以 READ ONLY 一致性事务核对本请求、最多十条本请求调用、JustOne 拒绝响应的原始字节
（最大 64 KiB，先校验长度及 SHA-256）、请求发生前最后一条策略审计，以及此前七天内
最近十五条开始时间不晚于本请求的 Facebook RapidAPI 调用和白名单计费头。
不读取当前额度作为历史快照；不调用供应商、触发回放、改计数、账本或日志配置。

策略审计能补充当时可见的模式证据，但不能替代当次准入原因与令牌状态。
`inFlightAtReservation=true` 是候选调用重叠；`completedBeforeReservation=false` 表示该调用响应
发生于选路之后，其剩余数不能当作选路时已知额度。最近十五条样本不等于完整周期的采购统计。

原始响应仅投影固定位置的 message／msg／error.message 类型、长度与精确匹配的已审核短文本；
其他文本不输出，避免回显检索式、凭据或业务内容。若出现 `unreviewedText=true`，表示有未展示文本，
不能断言供应商只给了笼统错误。若已核实原文也只为“采集失败”，Hub 无法从 301 补出内部原因，
需运营者凭上游请求 ID `2b74548b0a604b22b885abf6dcddde88` 向供应商核对内部日志。
脚本没有读取任意深层内容，因此未投影的位置不能被宣称不存在其他证据。

本地五项测试全部通过，包含实际 PGlite 只读 SQL、原始字节校验、历史审计时点、
重叠调用响应时间边界、隐私输出和 CLI；随后收到的生产回执如下。

## 2026-10-15 06:36:44Z 运营者回执

运营者返回 `facebook-failure.v1`：原 JustOne 归档校验成功，136 字节，SHA-256
`54e41613e2de5814bd92bc4c05142acb01504e84f621be07425a4e1b7e3e724b`，
code=301、上游请求 ID 与原账本一致；data=null、无 root msg/error。
root message 是 34 字符字符串，`unreviewedText=true`，内容尚未展示。
这不是“已确认原文只写了采集失败”，也不能据此归因查询语法、内部超时、Cookie 或风控。

最后一条请求前策略审计为 revision1、auto、monthlyLimit1000，创建于 2026-10-10T14:34:16.402Z。
请求前最近已完成 RapidAPI 调用 `e36dc76c-587f-4ee4-b28f-a2465e64b077`
于 01:08:20.897Z 完成，计费头 remaining282／limit1000，无冲突、未报月额度耗尽。
重叠调用 `65a66fbd-557e-4f83-9cf6-ea8c3e4a7341` 于 01:09:11.018Z 开始，
目标请求于 01:09:11.260Z 预占；该调用在 01:09:16.317Z 才完成，届时 remaining281。
此 281 是选路后证据，不能倒填成当时已知状态。

这些证据更支持旧版 `source_busy` 首请求转 JustOne，且不支持供应商月额度耗尽的解释；
原始准入原因／本地额度快照仍未记录，故不宣称唯一根因已完全证实。
最近十五条样本被截断，不能代替完整周期计数，也不证明普通计费头曾补额度的风险已在此请求发生。

为继续核对 301 文本，增加独立显式读取工具 `server/ops/read-facebook-failure-message.mjs`。
要求运营者给出原请求 UUID、原 call UUID、已确认 SHA 三个身份，SQL 限定 Facebook／JustOne／
固定操作与端点／HTTP200／rejected／业务301。只取最大4KiB归档、校验原始长度和SHA，
核对 payload code 和关联 ID 后返回 root message（最多512字符）；遮蔽 URL、凭据赋值和长不透明串。
默认诊断和公共错误不会获得任意消息文本。此工具只读，不需要重新部署或业务请求。

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - \
  e0885b83-be96-4525-bfdd-c5b3c5bf1d4f \
  a6617674-59ef-4f96-92d4-41d8bb072af1 \
  54e41613e2de5814bd92bc4c05142acb01504e84f621be07425a4e1b7e3e724b \
  < server/ops/read-facebook-failure-message.mjs
```

八项测试通过，包括实际 PGlite 的显式单归档读取、三身份不匹配拒绝、原字节／关联 ID 校验、
消息投影与脱敏、默认诊断不泄露文本、CLI 无数据库失败路径。该 34 字符原文仍待运营者输出，
没有发起付费请求、读取通用日志、部署或修改历史、计费与 MX-H2I 登录联网。
