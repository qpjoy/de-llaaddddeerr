# Twitter 标准搜索并发拒绝（2026-10-15）

下游返回 `503 external_platform_busy`，请求
`23820161-3f4d-4e2b-886d-b9fc9664c234`，文案为
`External data capacity is occupied`；该平台对应检索式的增量采集保持阻塞。

该精确文案位于 `runTwitterSearchFill` 的首次并发准入失败分支，发生在
`beginProviderCall` 之前。下游的 `operation=raw` 标签不能代替 Hub 保存的请求路径；
当前该分支用于 `/api/v1/data/search` 的 Twitter 标准补页流程。
生产账本尚未返回，不能据此推定当时确切计数、哪一个实例、供应商额度或下游阻塞恢复。

## 容量和时长

- 当前 `rapidApiConfig` 代码默认为每网关实例总并发 3、单 consumer 并发 2。
- Twitter 标准补页的准入使用 `canWait=false`，立即拒绝，不进入通用的 10 秒等待队列。
- busy 没有固定熔断期限；并发名额释放后新业务请求才可能获准。
- 一次标准补页流程取得名额后，在该流程结束时释放；未知写入保留派发去重租约的保护仍独立存在。
- `hubSocialGateway` 与 Facebook 标准搜索的网关实例分别创建，不能因为供应商相同就断言两者竞争同一进程计数。
  其他实例、Pod 的时间重叠也不能证明本实例满额。
- 下游“保持阻塞”是调用方工作流状态，不能当成 Hub 仍处于熔断或已经允许安全重试的证据。

## 新错误说明（待发布）

保留 `503 / external_platform_busy`，新文案为：

> Hub Twitter 数据采集并发名额暂不可用，本次尚未发起采集，请稍后重试。

附 `platform=twitter`、`layer=hub`、`stage=concurrency_admission`、
`admissionMode=immediate`、`upstreamDispatched=false` 和原 durable request ID。
`reason` 区分 `hub_concurrency_exhausted`、`consumer_concurrency_exhausted`、
`concurrency_queue_pending`，并给出当次进程/consumer 的当前值、上限和队列深度。
总并发与 consumer 同时达到上限时优先报告总并发。
`retryAfterMs=1000` 对应 `Retry-After: 1`，只是退避建议，不承诺恢复时刻。

该新拒绝通过已有 `rejectWithoutDispatch` 原子释放预占并写入网关 503 记录。
旧路径可能只留下 `external_platform_pre_dispatch_failed` 的 usage，且无 gateway 记录；
只读诊断如实返回这些字段，不替历史补写 HTTP、原因或计费结果。
本次没有增大并发、增加自动重试、修改补页与结算语义，或改变 MX-H2I 登录联网。

## 生产只读取证

将 `server/ops/diagnose-twitter-busy.mjs` 同步到服务器源码后，从仓库根目录执行；
不要求先部署应用镜像：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - 23820161-3f4d-4e2b-886d-b9fc9664c234 \
  < electron-dock/mx-insight-hub/server/ops/diagnose-twitter-busy.mjs
```

脚本按 UUID 读取原 usage、gateway、ownCalls，及有界时间窗内最多 100 条 RapidAPI
候选调用，使用已有 request/provider-time 索引和只读一致性事务，结束回滚。
语句超时 5 秒、锁超时 1 秒，全部列表显式报告截断。
时间窗从 reservation 前 5 分钟开始，到 completion（最多计至 reservation 后 5 分钟）再加 30 秒；
更早开始的调用不在样本中。只输出固定状态、ID、时间和同 tenant/consumer/Key 的布尔关系，
不读取正文、游标、检索词或凭据，也不触发采集、回放、reaper 或任何生产写入。

## 本地验证

117 项相关测试通过，0 失败、0 跳过：实际并发占用下的总量/consumer 拒绝、
预占释放、名额不误释放、显式新请求恢复、HTTP 中文原因/退避/请求 ID、
既有补页/归档/未知保护，以及诊断脚本实际 PostgreSQL 查询和受限输出。
本地 PGlite 使用现有真实结算触发器验证缓冲交付；类型检查、语法和差异格式检查通过。
尚未生产部署或发起付费请求；下游工作流所在项目仍未提供，本次未修改其阻塞/退避策略。
