# 限制与恢复

入口：**可观测性 → 诊断中心 → 限制与恢复**，与“请求诊断”并列。旧 `/data-browser?view=limits` 链接保留兼容跳转。诊断结果中的“查看当前限制与恢复倒计时”会带入原始 Hub 请求 ID，定位所属 Key。状态查询只读取已保存的状态，不查询供应商、不重试历史请求、不产生采购费用；手动恢复仍是需要明确确认的独立写操作。

## 展示范围

| 状态 | 范围 / 倒计时 | 手动操作 |
| --- | --- | --- |
| 供应商熔断 | 供应商共享；数据库 `circuit_open_until` | 恢复 Hub 熔断 |
| 平台契约熔断 | 供应商 + 契约 scope | 确认解析修复后恢复 |
| 响应解析冷却 | 特定调用产生的端点 / 契约保护，默认 5 分钟，影响所有调用者 | 只解除选中调用产生的保护 |
| 供应商本地速率 | 共享令牌桶，下一个单次调用的预计可用时间 | 补充配置允许的 burst |
| Key / 调用者滑动窗口、Key 操作速率、套餐窗口 / 瞬时速率 | 选择 Key 后查看；调用者和套餐层由其全部 Key 共享 | 从恢复时刻重新计数该层 |
| Key 操作总额、套餐月度额度 | 累计用量 / 月度截止时间 | 前往 Key 或套餐设置调整，不清空用量 |
| 派发锁、上游调用中 | 同调用者、同请求内容；租约或执行中证据 | 只读，不强制解锁 |
| 调用结果未知、内容不可用冷却 | 同调用者、同请求内容；默认 15 分钟 | 只读，不重发潜在已计费请求 |

默认展示供应商共享状态和当前调用保护。选定 Key 后增加配额，并将调用者专属保护限定到该 Key 的调用者；共享解析冷却仍完整展示。内部白名单或 store-authenticated `managed_full` 身份的配额豁免、TikHub 本地速率豁免及 10 秒速率熔断例外单独标注，不修改共享状态。

2026-10-12 最新授权：原始 LCY-delta Key 的固定 Key/tenant/consumer 身份且 `managed_full` 时，
豁免 Hub 侧 TikHub 共享 429 熔断，不再等待 10 秒。选中该 Key 会显示豁免说明；共享熔断卡片仍可处于生效状态，
因为它继续保护其他调用者。其他内部 Key 的 10 秒策略和非 429 故障保持。供应商实际返回的 429 不会被改成成功，也不自动重试。

解析冷却通过 `MX_INSIGHT_JUSTONE_RESPONSE_QUARANTINE_COOLDOWN_MS` 和
`MX_INSIGHT_TIKHUB_RESPONSE_QUARANTINE_COOLDOWN_MS` 配置，部署默认 `300000`；
未知结果和内容不可用仍使用各供应商的 `UNKNOWN_FINGERPRINT_COOLDOWN_MS`，默认 `900000`。
未显式设置解析冷却且既有未知结果时长短于 5 分钟时，沿用较短值。配置生效需发布新镜像和所有服务副本。

服务器时间是倒计时基准。页面可每 10 秒自动刷新，后台标签页暂停轮询；30 秒未成功刷新时禁用恢复按钮。倒计时归零先显示“等待刷新确认”，不能据此认定上游健康或重发失败采集。供应商本地速率只估计下一个单次调用，多调用操作和并发流量仍需重新准入。

列表最多展示最近 200 个 Key（可粘贴其他完整 Key ID）、200 条调用保护、200 个派发锁和 30 条恢复记录；超限明确标注，汇总不是全量。一个请求可能同时有派发锁和调用中记录，卡片数是保护项数量，不是独立请求数。

进程内并发限制不跨副本共享，页面不伪造集群级执行百分比。余额不足、授权缺失、采购预算、运营停用等配置仍在供应商 / Key / 套餐页面管理，不能用恢复按钮绕过。已解除某项保护也不表示其余准入条件已满足。

小红书主 gateway 的新默认容量为每进程 16，满容量前台请求最多排队 10 秒 / 32 个。
这是当前 HTTP 请求内的等待，不是共享熔断，也不是持久化任务；队列满和超时仍明确返回 429。
配置、作用范围和发布步骤见[小红书并发与等待队列](./xiaohongshu-concurrency-queue.md)。

## 恢复与审计

- 仅 Admin Token 可读写；Launcher 会话（包括平台管理员）、普通 Live Key 和 Public listener 不能访问。
- 操作需选择具体保护项并填写 3–500 字恢复原因。服务端核对状态版本；期间有新失败、配额变化或已过期时返回 `409 recovery_state_changed`，需刷新后重新选择。
- `control.admission_recoveries` 保存操作人类型、原因、请求 ID、原状态、作用范围和时间。相同版本重复提交返回同一次恢复，不重复重置。
- 解析冷却按不可变 provider call ID 记录解除标记。供应商原始响应、调用结果、计费、采购账单、历史响应和幂等复现均不改写；新的失败仍触发新的保护。
- 配额恢复与请求准入使用同一调用者事务锁。新预留在获锁后使用实际写入时间，从而计入恢复后的窗口；累计用量、月度商业额度、历史账单不重置。
- 供应商熔断恢复保留上次错误及失败时间，清除当前熔断和连续失败计数。操作不会调用供应商或自动重启下游采集。

管理接口：

```text
GET  /internal/v1/admin/admission-limits
GET  /internal/v1/admin/admission-limits?apiKeyId=<UUID>
GET  /internal/v1/admin/admission-limits?requestId=<Hub UUID>
POST /internal/v1/admin/admission-limits
```

GET 使用只读一致性事务；响应 `private, no-store`。POST 接收 GET 返回的 `kind/target/scopeType/scopeKey/revision`，配额恢复另带 `apiKeyId`，以及 `reason`。不接受重试、强制跳过或上游 URL 参数。内存模式返回 503，不能用于验证跨副本恢复。

配额统计一次读取当前调用者/Key 的候选用量与授权集合，再汇总各层限制。单语句上限仍为 10 秒；
超时返回 `503 admission_snapshot_timeout`，可先切回“全部上游”。缺失数据库结构或读取权限返回
`503 admission_snapshot_unavailable`。失败不能视作零限制，不调整全局超时、不在读取时补迁移。

## 部署和验收

必须先执行 migration **138_admission_recovery.sql**，再更新 **全部 Public、Admin API 副本和前端**。旧副本不识别恢复标记，混合版本期间不要点恢复。Admin/Public 应使用相同的供应商冷却时长配置。

在服务器的 `electron-dock/mx-insight-hub` 目录执行既有部署流程：

```bash
bash scripts/manage.sh deploy
kubectl -n mx-insight-hub rollout status deployment/mx-insight-hub-public --timeout=300s
kubectl -n mx-insight-hub rollout status deployment/mx-insight-hub-admin --timeout=300s
```

验收不需要付费请求：

1. 进入新 tab，确认服务器时间、自动刷新、作用范围及倒计时可见。
2. 从已保存的请求诊断跳转，核对 Key 和平台；历史 `released/partial` 状态不会被改成成功。
3. 选择已确认修复的 Hub 解析冷却，填写原因后恢复，确认该保护消失、恢复记录增加；其他保护独立保留。若没有活跃限制，不必人为制造付费失败。
4. 检查未知结果、执行中调用没有恢复按钮。恢复后需要继续采集时，由下游显式发起正常新请求并接受全部准入检查。

本地覆盖：PGlite 执行真实 SQL 和派发 / 配额准入路径；HTTP 测试覆盖权限与只读边界；浏览器使用模拟状态验证真实 SPA 的倒计时、Key 筛选、恢复确认、409 并发提示、审计和移动布局。生产数据和供应商未被修改或调用。
