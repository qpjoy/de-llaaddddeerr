# 小红书并发与等待队列

2026-10-12：用户授权提高 Hub 并发容量，并在容量耗尽时让请求先排队。本次修改已完成本地验证，生产发布由操作者执行。

## 生效范围和默认值

主 TikHub Xiaohongshu gateway 的搜索、评论、回复、官方接口和单篇详情使用同一进程内并发计数。
标准搜索和 Night-All/raw 兼容入口走相同等待路径。
独立 user-info gateway、其他供应商不因此获得这套队列。

| 项目 | 默认值 / 行为 |
| --- | --- |
| 正在执行的容量 | 每个 gateway 进程 16，原默认 8 |
| 等待队列 | 最多 32 个尚未派发的 HTTP 请求 |
| 等待时间 | 最多 10 秒，且必须为上游 timeout + 5 秒留下原预留租约时间 |
| 可选搜索详情补全 | 最多占用 12 个总槽位，为前台请求保留 4 个；每条搜索仍最多 2 个补全并发 |
| 等候顺序 | 可执行请求按进入顺序；某个调用者达到自身上限，不堵住其他调用者 |
| 队列满 / 超时 | 明确返回 429 `external_platform_busy`，不无限积压 |

有已允许的缓存降级结果时仍可立即返回；取得槽位后再次读取新鲜快照，避免等待期间已经产生结果却重复采购。
`live_only` / 显式 `refresh` 不因此改为缓存结果。
搜索详情补全是可选工作，容量不足保留现有 partial 结果，不挤进前台队列。
普通调用者自己的默认并发上限仍为 8，内部流量的既有豁免保持。

这不是持久化任务队列：等待依附当前 HTTP 连接，不返回异步任务 ID，进程重启不自动重放。
已经派发的供应商调用按现有规则记录和结算；本次调整不增加付费重试。
已有 PGY 详情队列及其已确认未计费重试合同保持独立。

## 等待期间的约束

等待不占用派发并发槽、供应商采购预算或同请求派发锁；原客户用量预留仍受原租约约束。
拿到槽位后重新检查当前 Key/调用者/租户身份、平台与接口授权、活跃已发布套餐、供应商状态、凭据和运营控制，
再取得同请求派发锁，执行预算与速率准入。
等待期间出现的新未知结果、解析冷却、权限撤销或预算不足仍阻止派发。
客户端断开、等待超时会移出队列；未派发的请求不会因为取消而标为供应商结果未知。

超量错误保留原错误码，新增 `details.reason`：

- `concurrency_queue_full`：排队数量达到上限。
- `concurrency_queue_timeout`：等待或原预留租约时间不足。
- `consumer_concurrency_changed`：等待期间身份策略变化，重新检查后达到普通调用者上限。

这些错误带 `upstreamDispatched=false`、`retryAfterMs=1000`，以及错误发生时的进程容量/队列信息。
HTTP 返回 `Retry-After` 提示，不代表一秒后一定有容量，也不触发 Hub 自动重试。
Admin 的限制页读取共享数据库状态，不将这些瞬时进程计数冒充集群总量。

## 配置与发布

在服务器 `electron-dock/mx-insight-hub/.env.internal` 中设置以下值。
若已有旧的 `MAX_CONCURRENCY=8`，须更新该行；仅更新代码中的默认值不会覆盖显式配置。

```dotenv
MX_INSIGHT_TIKHUB_MAX_CONCURRENCY=16
MX_INSIGHT_TIKHUB_CONCURRENCY_QUEUE_WAIT_MS=10000
MX_INSIGHT_TIKHUB_CONCURRENCY_QUEUE_MAX_PENDING=32
```

队列等待值必须为 1–60000 毫秒，长度为 1–256；超界配置会在 provider 配置校验中被拒绝。
`manage.sh` 生成的运行配置和 Compose 使用同样默认值。
不新增数据库迁移；不修改 Launcher、MX-H2I 登录和联网、支付及授权合同。

同步本次 Hub 代码后，在该目录执行：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 bash scripts/manage.sh deploy
kubectl -n mx-insight-hub rollout status deployment/mx-insight-hub-public --timeout=300s
kubectl -n mx-insight-hub rollout status deployment/mx-insight-hub-admin --timeout=300s
```

可以只读核对 Public 进程中的配置，不发起付费调用：

```bash
kubectl -n mx-insight-hub exec deploy/mx-insight-hub-public -c api -- node --input-type=module -e 'for (const k of ["MX_INSIGHT_TIKHUB_MAX_CONCURRENCY","MX_INSIGHT_TIKHUB_CONCURRENCY_QUEUE_WAIT_MS","MX_INSIGHT_TIKHUB_CONCURRENCY_QUEUE_MAX_PENDING"]) console.log(k+"="+process.env[k])'
```

并发上限是每个进程的值，多副本不是共享 16；增加副本也会增加潜在供应商在途调用。
排队能缓冲短峰值，持续超载仍会达到边界。实际吞吐受供应商响应时间、搜索补全数量和供应商限额影响；
不能从 16 个槽位直接推算 16 QPS。下一步用正常业务观察等待失败、上游 429 和延迟，不进行付费压测。

## 本地验证

- 真实内存账本 + 模拟供应商：满容量评论先排队、释放后只派发一次；等待不占采购预算或派发锁。
- 等待中取消、撤销授权、新熔断、新未知结果、预算不足、队列超时均不会额外派发。
- HTTP 队列满返回原因与 Retry-After；客户端断开移除等待项；标准及两个 raw 兼容入口传递取消信号。
- 搜索槽位释放后沿用原请求 ID；等待中出现新鲜快照直接复用；原租约时间不足直接结束等待。
- 补全让出前台容量；计数回收；既有官方接口、PGY 队列、用户详情、搜索兼容及部署脚本回归通过。
- 未发起供应商实测；本地测试通过不代表新镜像已经在线上运行。
