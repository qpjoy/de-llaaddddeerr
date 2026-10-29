# 闲鱼商品检索两次 503：JustOne 余额不足（2026-10-29）

## 现象和结论边界

截图记录 Delta 任务 388637 的请求 `0386fa4d-7e02-4191-a305-f249f0070fb1` 返回 `external_platform_circuit_open`；继续后的任务 388660、请求 `ee011e3d-cf27-4ae7-b6d4-9faf3f8c210c` 返回 `external_platform_capacity_unavailable`。

第一个错误表示准入时熔断仍打开。第二个错误已由生产证据确认：请求实际发到 JustOne，供应商返回 601 / upstream_balance_exhausted（账户余额不足），被 Hub 映射为 capacity_unavailable。截图中“整轮对话失败”是调用方的错误处理表现；本次没有核查或修改 Delta。

## 生产证据（操作者回传，已核对）

以下时间均为北京时间 2026-10-29：

- 19:55:13–14，8 次 Facebook 调用均为 HTTP 200、业务码 601、upstream_balance_exhausted、billed=false。
- 19:57:53.116，京东调用 `1818b963-1637-4e05-b57c-28b9a6aeb664` 同样返回 601。按默认 60 秒保护推算会持续到 19:58:53.116；第一次闲鱼请求 19:58:33.366 落在其中。历史熔断状态未保存，这一具体开闸截止时间是推算，不是历史状态快照。
- 第一次闲鱼请求的 gateway 明确为 justone / circuit_rejected / 503，providerCallId=null，约 20 毫秒后 released。
- 19:59:29，第二次闲鱼请求的 gateway.providerCallId=`151f4b32-42a2-4aca-be76-fecd7b1bd008`，与第一份诊断 nearbyHistoricalFailures 中的闲鱼调用完全匹配：HTTP 200、业务码 601、upstream_balance_exhausted、rejected、billed=false。可确认已经放行后被供应商拒绝，HTTP 200 并不代表业务成功。committed 表示失败响应已持久化，不等于成功交付或客户已扣费；这份诊断只确认供应商 billed=false，没有查询客户钱包账本。
- 20:46:40 观测时，JustOne consecutiveFailures=3196，最后错误仍为余额不足（20:44:18.868）；circuitOpenUntil=20:45:18.868，openNow=false 只说明冷却期限已到，不证明上游已经恢复。不能把累计 3196 次全部归因为同一错误。
- 近 24 小时电商已记录的 25 次调用（闲鱼 3、京东 21、淘宝 1）全部是 601、未计供应商费用。电商最近成功调用始于 10-19 00:27:22；供应商共享状态的 lastSuccessAt 为 10-22 16:23:05，两者统计范围不同。
- 闲鱼当前固定 justone、无备用；电商 operation 为 active。supplierModeInstalled=false，表示路由记录未含新版 mode 字段，当前没有证据表明新的供应商路由迁移已安装。

回传为 provider-circuit-diagnostic.v1（因此电商 platform 显示 other、没有 ownCalls），但两份结果通过同一个 providerCallId 已闭合证据，无需为本次结论重跑 v2。此前发现的解析隔离隐患仍存在，但本次没有证据指向该隐患：已知调用全部是供应商余额拒绝。

## 恢复处理

先恢复 Hub 实际使用的 JustOne 账户余额，或替换为有可用余额且具备对应权限的凭证。现有 60 秒冷却到期后新请求即可再尝试，成功会按现有恢复规则清除失败状态；无需通过重启 Pod 清除数据库熔断。闲鱼目前没有接入备用供应商，不能直接套用淘宝/天猫的 RapidAPI 路由。生产充值、凭证修改、付费验证均未执行。

## 代码确认

- 闲鱼商品检索目前只注册 JustOne；淘宝/天猫的 RapidAPI 备用不覆盖闲鱼（server/contracts/justone.mjs）。
- JustOne 默认连续失败 3 次后暂停 60 秒，可由部署环境覆盖（server/external-platforms/config.mjs）。计数达到阈值后，后续失败会继续延长开闸时间；到期允许下一次调用，并非主动证明账户已恢复。
- provider_state 是跨平台、跨 Pod 的共享供应商状态。余额/鉴权等账户级问题会影响使用同一供应商的其他平台。
- 发现独立的隔离隐患：gateway 的 delivery 未填 marketplace；JustOne 适配器标记 circuitCategory=contract 的失败在 store 中拿不到 scope，仍落入共享供应商计数。该问题可能扩大拒绝范围，但没有证据说明它触发了截图中的第一次失败。本次未改变运行逻辑。
- “供应商当前能调用”仍可能遇到上一轮熔断尚未到期；同时不能把供应商其他接口成功当成闲鱼接口或同一账户可用的证明。

## 只读取证

诊断脚本升级为 provider-circuit-diagnostic.v2，增加 historical.ownCalls、截断标记，以及电商 capacity/鉴权错误分类。仅读取元数据；不读取凭证、正文或查询词，不发起供应商调用，不修改历史记录。没有调用记录本身不能证明没有派发；要结合 gateway/sourceMode 等证据。

在本地更新后的源码目录执行，脚本通过 stdin 送入现有 Admin Pod，无需部署：

```bash
cd /Users/qpjoy/workspace/qpjoy/de/de-llaaddddeerr/electron-dock/mx-insight-hub

for request_id in \
  0386fa4d-7e02-4191-a305-f249f0070fb1 \
  ee011e3d-cf27-4ae7-b6d4-9faf3f8c210c
do
  kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
    node --input-type=module - "$request_id" < server/ops/diagnose-provider-circuit.mjs
done

kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - 24 < server/ops/diagnose-ecommerce-search.mjs
```

第一份看 nearbyHistoricalFailures 中 completedBeforeTarget=true 的失败候选；第二份看 historical.ownCalls 的业务码、错误码、HTTP、outcome 和 billed；最后一份看当前 JustOne 状态、闲鱼路由和近期成功/失败。附近失败列表有上限且只覆盖请求开始前后五分钟，不保证包含真正触发熔断的所有调用。通用诊断的 platformContractCircuits/searchPolicy 不代表电商 marketplace 规则，以电商诊断为准。

## 减少不必要拦截的后续方向

根据证据选择修复：账户余额或鉴权问题先恢复账户能力；Hub 解析问题应修复解析并缩小隔离范围；接口级失败应避免阻断其他平台；恢复后应允许受控的探测请求尽快解除旧状态。不能把移除所有保护当作恢复上游能力，也不应自动重发结果未知或已经计费的请求。

本次仅修改只读诊断及测试，并根据回传证据更新本记录。针对性测试 4 项通过；未部署、未调用付费接口，未修改 MX-H2I、Launcher 登录、SSO、网络或任何生产配置。本次优先恢复供应商账户能力，不以取消熔断代替账户恢复。
