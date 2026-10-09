# 2026-10-09 小红书容量拒绝与共享熔断

## 已确认的线上事实

证据为 `/tmp/Hub容量超限与熔断-20261009.md` 的 22 笔请求，以及操作者返回的
只读 PostgreSQL `provider_calls`、`gateway_requests`、运行配置和当前状态。
本次排查没有重放付费请求。

以下为北京时间，日期均为 2026-10-09：

| 时间 | 证据 |
| --- | --- |
| 05:18:41.822–42.488 | 4 笔搜索发出，随后都交付 HTTP 200 |
| 05:18:44.747–53.663 | 上述搜索派生 42 笔正文补全：32 笔 HTTP 200、10 笔上游 HTTP 429 |
| 05:18:52.717 | 第一笔补全限流完成，callId `466b11e4-f796-4e61-92f3-c866e276c86e` |
| 05:18:53.056–54.819 | 搜索主调用在补全结束后结算成功；旧代码无条件清空供应方熔断状态 |
| 05:18:57.269–05:19:00.193 | 报告中的 4 笔搜索发出，全部被上游 HTTP 429 拒绝，最后一笔在 05:19:00.952 完成 |
| 05:19:35.453–59.099 | 报告中的 18 笔搜索、详情、评论为 `circuit_rejected`，`provider_call_id=null`，没有新增上游调用 |
| 05:20:01.198 起 | 新详情、评论恢复派发，记录显示均成功 |

4 个搜索主请求放大为 46 笔上游调用（含 42 次补全）。再加后续 4 次失败搜索，
18.371 秒内共发出 50 笔调用。调用开始时间是 Hub 账本记录，不能作为网络抓包时间。
按接口分别计算滚动 1 秒窗口，详情峰值为 8 次、搜索峰值为 4 次。

线上技术配置：共享 RPM=50、进程并发=8、每 consumer 并发=8、
每次搜索最多补全 20 条、每次搜索补全并发=2、连续失败阈值=3、熔断期=60000ms。

## 原因与边界

1. `external_platform_capacity_exceeded` 的这 4 笔不是钱包不足、Hub 数据库容量不足、
   consumer 额度或 Hub 本地并发拒绝。原始调用账本明确为上游 HTTP 429、
   `business_code=null`、`error_code=upstream_rate_limited`、`billed=null`。
   不能据此改写为“不收费”。[供应方官方说明](https://docs.tikhub.io/4579297m0)
   将 429 定义为请求速度超过频率限制；它没有给出本账号此次命中的数值阈值。
2. 旧令牌桶把 RPM 同时当作累积突发容量，闲置后可以集中消耗 50 个令牌。
   所以 50/min 并不等于每 1.2 秒最多一笔。每个搜索单独的补全并发也不能限制总突发。
   这是已确认的本地突发行为，不能单凭它认定此次超过了供应方的实际阈值。
3. HTTP 429 推进供应方级熔断，因此同一供应方的搜索、详情和评论都会受保护。
   原始默认策略是共享上游保护。随后用户明确授权 LCY-delta 使用内部豁免和 10 秒保护，
   实施范围与保留的安全边界见下节；普通 Key 的共享策略保持原样。
4. 主搜索先拿到成功响应，等待正文补全后才结算。旧代码用结算成功直接重置状态，
   因而会把这段时间内较新的补全失败/熔断清掉，造成继续派发与再次熔断。
5. 按最后一次失败和配置推算，本轮后段熔断期限约为 05:20:00.952，
   与 05:20:01 后恢复相符。旧版本未保存每次熔断状态快照，不能把此推算说成历史快照读取结果。
   操作者采样时当前熔断已关闭；当时的 Instagram 错误是另一个请求，不能当作本次起因。

## 供应方阈值与恢复时间（2026-10-09 补充核对）

[TikHub 官方计费说明](https://tikhub.io/pricing) 明确默认 **10 requests/second，按每个 API 路径分别计数**，
RPS 套餐可以提高阈值。这不是 Hub 当前的共享 50/min，也不是本账号已购买套餐的核验结果。
目前官方页面没有给出 429 后固定等待几秒恢复的承诺。60 秒为 Hub 配置；下述 10 秒也是 Hub 的准入策略，
都不是供应方恢复保证。若未来保留的响应给出 Retry-After，应结合该证据处理，不能自动重放付费请求。

此次 Hub 自身记录的滚动峰值低于公开默认值；可能还有 Night-All 等同凭证调用、实际接口/账号限制、
发送与到达时刻差异等，尚无证据确认其中哪项导致拒绝。原始 429 的错误正文或供应方账号后台/支持答复
才能继续缩小原因，不能把官方 10 RPS 当成压测验证过的安全值。

## LCY-delta 内部策略

用户明确授权对内部 Key 放开 Hub 限流，也接受 10 秒保护及按租户配置。
服务器只读输出确认该 Key 为 active：

- Key：`fd2f8cc9-0ff1-4052-a538-8cc8150bde83`
- 租户：`277bf8a4-5ed5-414d-b429-d72fcd7d36b6`
- Consumer：`be7d07fe-3d98-4db3-b00d-e5cbe5a76190`

实现采用运维配置的 UUID 白名单；名称、HTTP 参数和租户自助设置均不能获得豁免。默认白名单为空。
命中 Key 或租户后：

1. 不执行 Key 额外总量/窗口限制、Key scope 额度、Consumer 窗口及套餐月度/窗口/突发请求数检查。
   原配置与历史记录保留，移除白名单即可恢复。额度快照返回 `exempt:true`、`limit:null`、`remaining:null`，
   管理台显示“不限”，用量仍真实记录（包括所属 Consumer 的共享统计）。
2. TikHub 的小红书搜索、补全、详情、评论、用户信息以及通用网关的社交账号/微博/Instagram 路径
   跳过 Hub 本地共享 RPM 桶和每 Consumer 并发上限。普通 Key 继续使用原限制。
3. 仅对 `upstream_rate_limited` 熔断，当前调用者看到的截止时间为
   `min(原截止时间, lastFailureAt + 10s)`，公开错误范围为 `internal_caller`。
   不主动清空共享状态；其他 Key 保持原截止时间。新的上游限流会产生新的等待窗口。
4. 各网关原有的进程并发上限、接口队列/完整性控制、其他供应方技术保护、契约隔离、权限与暂停、有效套餐、
   钱包及采购预算仍生效。没有修改付费订阅权益或免除费用。认证/余额/未知故障不按 10 秒放行。
   不自动重试，不更换 Key、不修改 MX-H2I 登录或联网。

### 持久启用与回退

将本次代码同步到服务器，进入 **mx-insight-hub 项目目录**，在 `.env.internal` 中配置：

```dotenv
MX_INSIGHT_INTERNAL_KEY_IDS=fd2f8cc9-0ff1-4052-a538-8cc8150bde83
MX_INSIGHT_INTERNAL_TENANT_IDS=
```

如已有白名单，合并 UUID（逗号分隔）而非覆盖。这里仅选择已确认的 LCY-delta Key；若运维后续选择整个租户，
可将租户 UUID 放入 `MX_INSIGHT_INTERNAL_TENANT_IDS`，这会覆盖该租户所有现有和未来 Key。
执行 `bash scripts/manage.sh deploy`。不需要数据库迁移或更新 Key，不会改变它的 secret。
必须更新所有 Hub API Pod，旧版本不会识别新策略。

发布后只读检查（单行，不输出密钥）：

```bash
kubectl -n mx-insight-hub exec deploy/mx-insight-hub-public -c api -- node --input-type=module -e 'import {loadConfig} from "./server/config.mjs";import {createInternalTrafficPolicy} from "./server/core/internal-traffic-policy.mjs";const c=loadConfig();console.log(JSON.stringify({internal:c.internalTraffic,lcyDelta:createInternalTrafficPolicy(c.internalTraffic).matches({apiKeyId:"fd2f8cc9-0ff1-4052-a538-8cc8150bde83",tenantId:"277bf8a4-5ed5-414d-b429-d72fcd7d36b6"}),rateLimitCooldownMs:10000}));'
```

预期 `lcyDelta:true`，随后利用正常业务的新请求验收，不重放旧付费调用。
回退时从持久白名单删除对应 UUID 并重新部署；原额度配置与原共享熔断状态均未删除。
当前只完成本地实现和验证，启用是否生效以服务器发布及上述输出为准。

## 本地修复

- TikHub 增加 `MX_INSIGHT_TIKHUB_RATE_LIMIT_BURST`，默认 1；继续按原 RPM 补充。
  PostgreSQL 单条原子语句按供应方共享，旧满桶在下次准入时被钳制，不需要清表或新迁移。
  其他供应方保持原来的突发策略。原有一次预留多个调用的 user-info 工作流仍原子预留
  所需令牌（最多 3），不拆成可能重复购买的流程。此例外不是每个单次调用都可突发 3 次。
- PostgreSQL 并发下补充时间只前进，避免较早取得时间戳、较晚得到行锁的请求把时钟回拨。
- 成功请求只有在“请求开始时间不早于最近失败”时才能清除熔断；延迟结算照常保留成功交付、
  计费、快照与归档，但不能证明较新故障已恢复。同样保护已有的契约范围熔断。
- 小红书新 429 区分已经派发的上游限流，未知阈值用 `limit:null`；
  新 503 提供 `upstreamDispatched:false`、保护范围、原因、失败阈值、绝对期限与剩余等待时间，
  HTTP 带 `Retry-After`。详情/评论的公开错误转换保留这些 Hub 生成的信息。
- 没有自动重试、付费探测、凭据变更、预算/授权变更、历史结果重写或主动清除线上熔断。
  MX-H2I、Launcher、Auth、VPN、DNS、mx-pay 均不在改动范围。

## 发布与验收

当前结论是本地修复，不能据此声称线上二进制已经更新。
将本次 Hub 代码同步到服务器后，在 **mx-insight-hub 项目目录**执行现有发布入口：

```bash
bash scripts/manage.sh deploy
```

保留现有 RPM=50、并发、补全条数和熔断配置；新突发值默认即为 1。
若 `.env.internal` 已显式设置 `MX_INSIGHT_TIKHUB_RATE_LIMIT_BURST`，先核实它为 1。
所有使用同一供应方桶的 Hub API 二进制都应更新；混跑旧二进制仍会按旧策略放行。
发布不需要修改 Launcher/MX-H2I 配置或清除供应方状态。单 Pod Recreate 会有 Hub API 发布窗口。

只读检查：

```bash
kubectl -n mx-insight-hub rollout status deploy/mx-insight-hub-public
kubectl -n mx-insight-hub exec deploy/mx-insight-hub-public -c api -- node --input-type=module -e 'import {loadConfig} from "./server/config.mjs"; const c=loadConfig().tikHub; console.log(JSON.stringify({rpm:c.maxRequestsPerMinute,burst:c.rateLimitBurst,failures:c.circuitFailureThreshold,openMs:c.circuitOpenMs}));'
```

预期 `{rpm:50,burst:1,failures:3,openMs:60000}`。不要直接输出环境变量全集或 Secrets。
利用正常业务的新调用观察 `provider_calls` 和 `gateway_requests`，不重放本次历史收费请求。
突发时允许出现本地 `external_platform_rate_limited` + `Retry-After`，这表示尚未派发的背压；
已有的缓存/历史重放仍应可用。上游 429 的旧已提交失败保持原身份重放，不能换幂等键自动重购。

本次修复减少集中派发，但不是供应方容量承诺。补全额度不足会跳过部分补全并保留既有完整性标记；
多 Key/租户共享同一供应方额度。若上游实际阈值低于当前 50/min，或其他系统也使用同一供应方账号，
仍需按供应方真实证据进一步调整 RPM，而不是推断扩容能够消除限制。

## 验证记录

2026-10-09 内部策略追加验证：

- 真实本地 PostgreSQL 与配置/网关定向回归 72 项通过（首轮扩展回归 130 项通过）；
  覆盖 Key/租户白名单、同名 Key 不豁免、额度超限后放行、幂等与权限/钱包继续拒绝、
  10 秒内拒绝/10 秒后派发、补全及通用 TikHub 网关、其他供应方保护不变。
- 最终全量：2311 通过、79 按环境条件跳过、2 个已确认的旧标题断言失败，与下述原始 HEAD 复现一致。
- Vite 构建、部署脚本回归、shell 语法及 diff 空白检查通过。未连接生产库、未调用付费接口。

此前熔断修复验证：

- 核心回归 3 项（突发上限、主调用延迟成功、子调用延迟成功）在原始 HEAD 上全部复现失败，修复后通过。
- 受影响的网关、契约熔断、配置、缓存、幂等与 HTTP 错误测试 180 项通过，另加一项补全限流保留正文片段的回归。
- 独立临时 PostgreSQL 完整迁移至 135；实际数据库并发/旧桶升级、两种成功结算与研究接口 HTTP 回归 36 项通过。
  此测试库仅监听本机，未连接线上 PostgreSQL。
- 全量服务端与 Sites worker 测试：2302 通过、78 跳过、2 失败。两项失败为
  `aggregate-search.test.mjs` 的“实时新闻”标题与 `twitter-title.test.mjs` 的微博标题旧断言；
  在未修改的 HEAD 单独执行也同样失败，与本次熔断修复无关，未扩大修改范围。
- 部署管理脚本测试、shell 语法和 `git diff --check` 通过。
