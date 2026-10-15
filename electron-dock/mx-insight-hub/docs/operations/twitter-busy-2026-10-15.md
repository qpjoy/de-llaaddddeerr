# Twitter 标准搜索并发拒绝（2026-10-15）

下游返回 `503 external_platform_busy`，请求
`23820161-3f4d-4e2b-886d-b9fc9664c234`，文案为
`External data capacity is occupied`；该平台对应检索式的增量采集保持阻塞。

该精确文案位于 `runTwitterSearchFill` 的首次并发准入失败分支，发生在
`beginProviderCall` 之前。下游的 `operation=raw` 标签不能代替 Hub 保存的请求路径；
当前该分支用于 `/api/v1/data/search` 的 Twitter 标准补页流程。
运营者返回的只读账本确认：该请求于 `2026-10-15T01:08:58.124Z` 预占，
`01:08:58.153Z` 释放，耗时 29 毫秒；路径确为 `/api/v1/data/search`。
原 usage 仅保存 `external_platform_pre_dispatch_failed`，HTTP 为 null，
gateway 与 ownCalls 均为空，与旧准入分支相符。

当时有两个同 tenant/consumer/Key 的 Twitter 搜索重叠：

| 调用 | 请求 | 开始（UTC） | 完成（UTC） | 结果 |
| --- | --- | --- | --- | --- |
| `7536b0c7-7066-4d89-bdb4-2fb521065ba3` | `fb816933-b8bb-4b6e-b86a-558c156cd6fb` | 01:08:57.388 | 01:08:58.865 | rejected / HTTP 400 |
| `bb003490-383d-4345-98dd-65c666cebaaf` | `d5be4d0c-c74c-43f2-9ced-fd956b90265b` | 01:08:57.810 | 01:08:58.663 | rejected / HTTP 400 |

两条均为 `social.content.search`，与单 consumer 上限 2 相符。若它们属于同一个计数实例，
首个名额在目标预占后约 539 毫秒释放，另一个约 741 毫秒；这支持瞬时占满的解释。
历史进程计数与实例身份未保存，因此不能严格证明究竟先命中哪一项限制。
三个 Facebook 候选调用最早于 `01:09:11.018Z` 才开始，全部不与目标重叠。
两条 Twitter 的 HTTP 400 是另外的已派发拒绝；本报告没有其响应正文，不能推断是参数、额度或其他原因。
`databaseNow=2026-10-15T04:54:18.410Z` 是读报告时间，不代表旧请求仍阻塞或已恢复。

## 容量和时长

- 当前 `rapidApiConfig` 代码默认为每网关实例总并发 3、单 consumer 并发 2。
- 事故版本的 Twitter 标准补页使用 `canWait=false`，立即拒绝，遗漏了通用等待队列。
- 本轮修复让尚未持有已采集页的请求等待首次采集名额，默认最多 10 秒、32 个等待项。
  等待仍预留完整采集超时和 5 秒落库余量，不能延长原请求期限。
- busy 没有固定熔断期限；并发名额释放后新业务请求才可能获准。
- 一次标准补页流程取得名额后，在该流程结束时释放；未知写入保留派发去重租约的保护仍独立存在。
- `hubSocialGateway` 与 Facebook 标准搜索的网关实例分别创建，不能因为供应商相同就断言两者竞争同一进程计数。
  其他实例、Pod 的时间重叠也不能证明本实例满额。
- 下游“保持阻塞”是调用方工作流状态，不能当成 Hub 仍处于熔断或已经允许安全重试的证据。

## 新错误说明（待发布）

保留 `503 / external_platform_busy`，新文案为：

> Hub Twitter 数据采集等待并发名额超时，本次尚未发起采集，请稍后重试。

队列满时明确显示“等待队列已满”。

附 `platform=twitter`、`layer=hub`、`stage=concurrency_admission`、
`admissionMode=bounded_wait`、`upstreamDispatched=false` 和原 durable request ID。
`reason` 区分 `concurrency_queue_full`、`concurrency_queue_timeout`，
并给出当次进程/consumer 的当前值、上限、队列深度和 `maxWaitMs`。
`retryAfterMs=1000` 对应 `Retry-After: 1`，只是退避建议，不承诺恢复时刻。

等待期间只保留原客户预占与交付去重租约，不购买采集预算、不消耗 RPM、不新增调用。
出队重查 Key/tenant/consumer、授权、套餐、页大小、凭据、操作、熔断、父请求未知状态和派发去重。
同 owner 的派发复核保留原租约期限，也不能绕过新增未知/隔离证据。
等待超时、队列满或取消通过已有拒绝事务释放预占并保存网关记录；busy 保留原 503。
已有付费余量遇到新采集繁忙时直接提交短页和原 Bottom 续页，不等待、不重复入库或采集。
同时修正首轮说明补丁在此场景提前释放预占的错误；仅尚未持有已采集页的失败允许走拒绝释放。
旧路径可能只留下 `external_platform_pre_dispatch_failed` 的 usage，且无 gateway 记录；
只读诊断如实返回这些字段，不替历史补写 HTTP、原因或计费结果。
本次保持并发上限、已派发失败保护、补页边界、价格与一次结算语义，以及 MX-H2I 登录联网。

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

首轮说明补丁验证为 117 项通过。本轮 10 个相关测试文件共 296 项，293 通过、
0 失败、3 项既有真实 PostgreSQL 环境条件跳过（Facebook 回退/配额/恢复探测）。
覆盖第三次请求等待并正常取得名额、真实客户 hold、相同请求保护、凭据重读、
撤权/暂停/熔断/未知阻断、满队/取消/原期限、付费余量短页正确提交及 HTTP 文案/退避/请求 ID。
既有通用、Facebook、其他内容补页回归及诊断脚本也通过；PGlite 使用真实结算触发器验证交付。
类型检查、语法和差异格式检查通过。
尚未生产部署或发起付费请求；下游工作流所在项目仍未提供，本次未修改其阻塞/退避策略。
