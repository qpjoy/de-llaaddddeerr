# 小红书搜索 503：TikHub 共享熔断被 Hub 自身失败触发（2026-10-29）

## 现象

Delta 调用小红书搜索（raw），Hub 返回：

- `503 external_platform_circuit_open`，请求 `0a92d464-e219-4a26-8db6-b2dd2a237490`
- `scope=shared_upstream`、`cause=upstream`、`reason=upstream_failure`、`failureThreshold=3`
- `circuitOpenUntil=2026-10-29T03:48:07.795Z`，`retryAfterMs=4445`；没有 `upstream` 字段

本次没有调用供应商，也没有计费。

## 原因（代码确认；生产数据待只读诊断核实）

所有 TikHub 平台（小红书、抖音、Instagram、Twitter、微信等）共用一个 TikHub 熔断：连续 3 次失败就暂停整个 TikHub 约 60 秒。

问题在于，计入这 3 次的不只是 TikHub 的失败，还包括 **Hub 自己的失败**：

| 记录的错误码 | 实际含义 | 之前是否计入共享熔断 |
| --- | --- | --- |
| `invalid_content_search_contract` | Hub 读不懂已付费的内容搜索页（例如 10-29 抖音“相关搜索”卡片问题，修复尚未部署） | 是 |
| `invalid_social_contract` | Hub 读不懂已付费的账号页 | 是 |
| `external_platform_enrichment_unknown` | 小红书详情补全时 Hub 内部出错，或已拿到数据但缺少采集时间 | 是 |
| 投影失败（`succeeded_unusable`，非供应商错误） | Hub 处理已付费的搜索结果时出错 | 是 |
| 结算写库失败后改记为 `unknown` | 供应商已应答，只是 Hub 写库失败 | 是 |

这样，某个平台的 Hub 解析问题会暂停所有 TikHub 平台，正是“上游能通、Hub 却拒绝”。

本次拒绝的 `reason=upstream_failure` 也指向这一点：熔断记录的最后一个错误码如果是供应商错误（`upstream_*`，如超时、5xx、429、余额），会原样显示；只有不是 `upstream_*` 的码，才会显示成通用的 `upstream_failure`。而上表的 Hub 错误码都不是 `upstream_*`。

本次拒绝不带 `upstream` 字段，是因为小红书搜索路径还在用旧的拒绝写法，没有附上触发熔断的那次调用（10-28 只改了小红书采集路径）。

## 修改

1. **Hub 自身失败不再计入共享熔断**（`tikhub-gateway.mjs`、`content-search-workflow.mjs`、`social-account-workflow.mjs`）：上表各项改为 `affectsCircuit: false`。
   - 解析失败的响应仍按原规则进入 5 分钟响应隔离，同一接口不会被反复付费采购，但不再连带暂停其他平台。
   - 真正的供应商故障照旧计入：超时、传输错误、5xx、429、鉴权或余额问题、接口不可用，以及 TikHub 返回的非法 JSON 或信封。
2. **熔断拒绝带上触发原因**：小红书搜索、小红书采集、排队后复核共 5 处，统一改用 `openCircuitError`。拒绝中附带最近一次供应商失败的 `upstream`（错误码、HTTP、业务码、是否计费、时间），诊断中心也能看到。内部冷却仍按原样说明。
3. **新增只读诊断** `server/ops/diagnose-provider-circuit.mjs`（`provider-circuit-diagnostic.v1`）：可用于任意平台的熔断拒绝。它列出被拒请求、当前供应商熔断状态，以及拒绝前后 5 分钟内该供应商的失败调用（平台、接口、结果、HTTP、业务码、错误码，含 Hub 自身错误码）。只读，不调用供应商，只输出已知代码和 Hub 接口名。

阈值、开闸时长和 5 分钟响应隔离都没有改，MX-H2I、登录和联网也没有改。

## 核实本次触发原因（只读）

在包含本次代码的 Hub 源码目录执行，不需要先部署：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - 0a92d464-e219-4a26-8db6-b2dd2a237490 < server/ops/diagnose-provider-circuit.mjs
```

看 `nearbyHistoricalFailures` 中 `completedBeforeTarget=true` 的几条：

- 错误码是 `invalid_content_search_contract`、`external_platform_enrichment_unknown` 等 Hub 自身错误：与上面的判断一致，部署本次修改即可。
- 错误码是 `upstream_*`（如 `upstream_deadline_exceeded`、`upstream_http_error`）：说明确实是 TikHub 自身故障，熔断是正常保护，只暂停约 60 秒。

## 测试

- 内容搜索解析失败后，TikHub 共享熔断计数保持 0。
- 小红书搜索的熔断拒绝带有 `cause=upstream` 和完整的 `upstream` 证据。
- 新诊断：可用于任意平台、能识别 Hub 自身错误码、查询只读，不输出未识别的存储值。
- 用 PGlite 0.2.17 跑完整服务端套件，失败项仍是原有 45 项；类型检查通过。

## 部署

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh ops internal-production deploy
```

同时也会部署尚未上线的抖音“相关搜索”解析修复和 Twitter 准入等待。
