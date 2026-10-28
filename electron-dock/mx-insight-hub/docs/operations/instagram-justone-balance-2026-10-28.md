# Instagram 熔断：JustOne 余额不足（2026-10-28）

## 结论

请求 `26bedabd-531b-41e1-afa7-d56d089e8091` 在策略搜索中返回 `503 external_platform_circuit_open`。这是**上游问题**：JustOne 账户余额不足，Hub 熔断只是暂停派发。Hub 没有调用供应商，本请求不产生供应商费用。

操作者运行只读诊断 `instagram-circuit-diagnostic.v1` 的结果：

| 项目 | 结果 |
| --- | --- |
| 请求 | `released`，2026-10-28 12:06:28 UTC，网关 `justone / circuit_rejected / 503`，无供应商调用 |
| JustOne 共享熔断 | 连续失败 2735 次，最后错误 `upstream_balance_exhausted`，每次失败后再保护 60 秒 |
| 附近失败 | 全部为 JustOne `instagram`、HTTP 200、业务码 `601`、`upstream_balance_exhausted`、`billed=false` |
| Instagram 契约熔断（Hub 解析保护） | 无记录，即 Hub 解析没有问题 |
| 路由 | `fixed / justone`，无备用供应商（revision 1，2026-10-14） |

## 恢复

两种方式任选其一，都在现有管理功能内完成，本次不改生产配置：

1. **给 JustOne 充值。** 余额恢复后，下一次请求成功即自动关闭熔断。
2. **切到 TikHub。** 在策略搜索 →“管理”中，把 Instagram 改为 `fixed / tikhub`。先发一次真实搜索确认可用；失败就改回。JustOne 充值后，可改为 `priority`（JustOne 主、TikHub 备），以后余额再出问题会自动切换。

   项目记录显示，TikHub Instagram 搜索在 2026-10-14 两次返回通用 HTTP 400，因此当时固定到了 JustOne；之后是否恢复只有用户的口头确认，没有新的成功证据，所以切换后需要先验证。在 `priority` 模式下，主供应商熔断打开后才会走备用，所以 JustOne 无余额时大约每分钟仍有一次请求先失败。余额不足期间建议用 `fixed / tikhub`。

## 改动：熔断拒绝带上原因和上游代码，诊断中心可查

**API 响应。** 所有 `external_platform_circuit_open` 都由同一个函数生成，新增：

- `cause`：`upstream`（上游连续失败）、`hub_response_parsing`（Hub 无法解析已付费的上游响应）、`hub_internal_cooldown`（内部冷却）。
- `reason`：使用实际的规范化原因码，例如 `upstream_balance_exhausted`。此前只在 4 个白名单值内传递，其余一律变成 `upstream_failure`。
- `upstream`：调用账本中该供应商最近一次失败的 `errorCode`、上游 HTTP 状态、上游业务码、`outcome`、是否计费、失败时间。

响应不含供应商名称或原文。只接受 `upstream_*` / `invalid_upstream_*` 形式的规范化代码，其他存储文本一律不输出。

证据来自 `provider_calls` 中拒绝前 15 分钟内该供应商的最近一次失败。查询走 `(provider_key, started_at DESC)` 索引，只在拒绝路径执行，读取失败时照常拒绝，只是不带 `upstream`。共享熔断报告任意平台的失败（同一供应商余额不足会同时影响电商和 Instagram）；契约熔断只看该平台的 `succeeded_unusable`。

覆盖范围：通用网关、排队后复核、TikHub 小红书采集与用户信息、Twitter fill、Facebook fill、内容搜索、社媒账号。电商采集仍沿用 2026-10-15 的决定：返回中性的 `reasonCode`，不透出上游代码。

**策略搜索等页面。** 错误面板在错误码下方增加一行：问题归属、原因码、HTTP 与业务码、保护截止时间，并注明“本次未派发上游请求”。

**诊断中心。** 网关记录为 `circuit_rejected` 且没有供应商调用时，诊断结果新增“拒绝原因（熔断保护）”：问题归属、供应商、触发调用 ID、上游错误码、HTTP、业务码、触发平台、是否计费、失败时间。建议文字和证据分析也会说明是上游问题还是 Hub 解析问题，以及下一步怎么做。这一部分在读取时从调用账本推导，不需要迁移，因此本次 `26bedabd` 这类历史请求也能查到原因。

## 验证

- 新增 `tests/server/circuit-refusal-evidence.test.mjs`：错误详情、代码过滤、契约熔断优先、读取失败容错、内存与 PGlite 查询窗口，以及诊断中心对上游、Hub 解析、无触发记录三种情况的说明。
- 扩展 Instagram 熔断路由测试，断言 `cause` 与 `upstream`。
- 用 PGlite 0.2.17 跑完整服务端套件，失败项仍是原有 45 项；另有两项此前存在的不稳定测试单独重跑 3 次均通过（其中一项会在随机请求 ID 恰好含 `601` 时误判）。前端构建与公开文档测试通过。
- 没有在浏览器中查看新界面，没有付费请求，没有改生产路由或配置，也没有改动 MX-H2I、登录或联网。尚未部署。

部署：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh ops internal-production deploy
```

部署后在诊断中心查询 `26bedabd-531b-41e1-afa7-d56d089e8091`，应显示“上游供应商 / upstream_balance_exhausted / HTTP 200 / 业务码 601 / 未计费”。
