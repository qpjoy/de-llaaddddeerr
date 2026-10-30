# 产品与 API 资源限速

2026-10-30。本地实现和合成验证，未部署、未调整线上限速、未发起付费探测。

## 两类策略

LCY-delta 的显式最大豁免继续覆盖历史 Hub 配额、供应商普通限速/并发、月度采购/补贴预算、共享自动供应商熔断等待。新的**资源保护**对所有 Key 生效，包括该原始 LCY Key；不能用请求字段或豁免开关跳过。授权、钱包、业务接口暂停、幂等和供应商自身限制保持原约束。

资源入口在数据产品的“管理 → 产品与 API 资源限速”。可以管理：

- 所有公共数据 API 共用的默认规则。
- 当前产品的规则，覆盖该产品全部已登记 API。
- 指定 method + API 模板的规则；路径中的记录/任务 ID 不产生新桶。
- 每条产品/API 规则可选所有 Key，或仅原始 LCY-delta。管理 API 也允许指定其他 Key UUID，不授予该 Key 任何权限。

默认规则、匹配产品规则、匹配 API 规则同时生效，任何一项达到上限就拒绝。删除单独规则恢复其余适用规则，不能关闭默认保护。原生供应商接口按自身产品登记，聚合内部调用不是额外 HTTP 请求；此层不替代执行端的资源预算。

## 口径与初始值

**按 API 进程计数，不是集群共享信号量。** 当前 Public PostgreSQL 部署由四个进程共享端口，四个进程及不同 Pod 的计数不共享。同一 Key 分布到多个进程后总量可能高于单进程数值；不得把 100 解释为集群总 QPS。严格跨节点资源互斥仍由自建引擎数据库约束承担，未来全局供应商租约见 Spider-Man 第 04 章。

| 初始配置 | 每 API 进程上限 |
|---|---:|
| 所有 Key 共享并发 | 256 |
| 每 Key 并发 | 32 |
| 所有 Key 共享每秒请求 | 1000 |
| 每 Key 每秒请求 | 100 |

这是新增保护的初始设置，不是实测容量，也不表示把既有 RapidAPI 上限升到 100 QPS。截图的供应商 `60` 是 **60 请求/分钟**，平均约 1 请求/秒；`6` / `4` 是并发上限，`30000` 是最长排队毫秒。供应商 RPM 与此页每秒请求数分开维护。

采用令牌桶，桶容量等于一个秒额度，可瞬时突发一个秒额度，以每秒配置值持续补充。达到并发/速率上限返回 `429 resource_admission_limited`、`Retry-After`、`details.scope/reason`。不添加等待队列、不读取请求正文、不预约钱包或调用供应商。鉴权通过后检查；执行名额直到 handler 完成才释放，客户端断开不能提前释放仍在执行的工作。此 HTTP 尝试未开始不代表之前同幂等键的请求未执行，重试仍保留原参数和 Idempotency-Key。

媒体流沿用自己的字节与并发保护；管理、登录、健康、支付不进入此层。微信自建任务提交/查询受 HTTP 保护，真正后台采集仍由原有持久任务和数据库全局互斥控制，不能用本页设置代替爬虫锁。

## 性能和配置一致性

- 本地内存原子检查；正常请求不新增数据库查询、定时器或异步等待。每进程定时 5 秒读取一次配置；启动首次请求可等待同一个初始化读取。
- 配置超过 30 秒未成功刷新，受保护的数据请求返回 `503 resource_policy_unavailable`，管理恢复入口继续可用。不会永久使用过期规则。
- 管理保存使用修订号 CAS、事务和不可修改的事件表；冲突/响应丢失必须重新读取，无自动重复保存。多进程通常 5 秒内生效，不承诺瞬时全局一致。
- LCY 当前存储身份与预算豁免校验已内联到原有采购成本查询，取消额外一次权限查询往返；仍读取即时 Key 状态，不缓存豁免权限。
- 本地 100,000 次同步准入+释放微基准约 99.6 ms，即每次约 1 微秒。使用模拟到达时钟，不含网络、鉴权、账本、数据库和供应商；它只能说明新增门禁的本机开销，不能证明端到端 QPS 或线上时延改善。

## 负载证据与调参

已有用户提供的线上样本：2026-10-30 的运行中 HanLP Pod 存在累计 OOM kill，详见下方。尚无 Public API 的同窗排队/延迟证据，不能把全部调用瓶颈归因于 HanLP；没有自动升高任何线上配置。供应商实时搜索与本地检索是不同链路；HanLP 在本地检索分析/索引中参与，当前 mx-common 源码支持多 worker 和交互保留槽，不能沿用旧“固定单槽”说明推定现网能力。

同步此文件所在代码到服务器后，在 Hub 目录执行：

```bash
bash scripts/inspect-resource-load.sh
```

脚本只读取 Kubernetes CPU/内存、Public/Admin/HanLP 容器各两次间隔 10 秒的 cgroup 计数，以及三次间隔 10 秒的 Admin 数据压力和 HanLP `/health`，不推理、不搜索、不读 Secrets、不打印 Token。Admin 压力只代表被采样的 Admin 进程，**不是 Public 四进程合计**；HanLP health 的 pool 是服务共享状态。缺失指标标为 unavailable，不能当成零负载。

判断顺序：

1. 供应商 RPM 到顶、上游 429 或上游耗时占主导：先核对供应商配额，增加 Hub 并发不能解除供应商限制。
2. HanLP `queued.interactive` 连续增长：核对 worker 存活、CPU/内存与 bulk 竞争；不直接增加模型并发或内存占用。
3. Hub 数据读取排队、数据库 pool 等待增长：结合 PostgreSQL / ES 指标定位。可另运行既有 `bash scripts/inspect-retrieval-capacity.sh`（默认不探测推理）。
4. 在同一流量窗口观测 P95、429、队列年龄、CPU/内存余量后，小步提高对应门禁，再复测。低 CPU 不能单独证明应提高限速。

## 发布与验证

migration `171_resource_admission.sql` 与 Public/Admin/UI 一起发布。旧进程不会执行新规则，混合版本期间不能承诺所有 Key 已受新保护。沿用正常发布流程；保持 `MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0`，不改变 MX-H2I 登录/联网。

已覆盖资源隔离、LCY 与普通 Key、令牌恢复、拒绝不消耗其他范围额度、配置更新时不丢活动名额、超期配置、零逐请求 DB 查询、CAS 与审计不可修改、真实 HTTP 断开后的结算生命周期。浏览器用真实 React 构建与内存合成管理响应验证 LCY 产品规则保存/重新读取以及 API 选择，无线上写入。

验证结果：相关回归 151 项通过、2 项真实 PostgreSQL 环境测试跳过；成本权限 SQL 和 migration 171 另以 PGlite 执行。类型检查及构建通过。合成浏览器截图见 `/tmp/hub-resource-limits-ui.png`。

Metrics API 不可用时，`kubectl top` 标为 unavailable 后继续，不要求安装 Metrics Server。cgroup 读取不依赖 Metrics API：两次 `cpu.stat` 的 `usage_usec` 差除以间隔微秒得到平均使用 CPU 核数；同时看 throttling 增量和 memory.current / memory.max。v1 cpuacct.usage 单位为纳秒。缺少文件/容器/权限只表示该样本不可用；非 namespace cgroup 挂载可能显示祖先 cgroup，不能直接认定是该容器负载。采样约需 50 秒加 API 读取时间。所有探测仍是只读。

## 用户提供的线上证据：HanLP cgroup v1 OOM

2026-10-30 用户逐 Pod 采样：

- `mx-common-hanlp-59c745b6c4-6rzwd`：Running、1/1、容器 restart 0，运行约 2 天 21 小时。
- `mx-common-hanlp-6db4799d44-cn9mn`：ContainerStatusUnknown、0/1、无 IP；这是历史异常 Pod，不能算作第二个可用实例。尚未修改或清理它。
- 运行中 Pod：memory.usage_in_bytes=19624402944（18.28 GiB），limit=34359738368（32 GiB），max_usage=34362466304（约 32 GiB）。memory.failcnt=5，memory.oom_control 的 under_oom=0、oom_kill=35。
- 同一 Pod 的 localhost health：5/5 worker 存活、3 线程/worker、保留 1 个交互 worker、两个等待队列为 0、replacedWorkers=35。

结论：已确认该 cgroup 发生过 OOM kill；替换计数与 OOM kill 数一致，强烈支持 worker 被 OOM 杀死后恢复的解释。不是容器重启，也不是 FutureWarning 导致退出的证据。采样时未处于 OOM，空队列不能证明没有历史故障或 Public 请求时延充足。计数为累计值，不能推出 35 次都发生在当天；failcnt 与 oom_kill 计数口径不同。

当前源码：5 worker、16 CPU、32 GiB；请求最多 256 文本、每文本截取到 20,000 字符，模型推理批次峰值值得检查。此配置是本地源码，不能当作线上全部环境变量已核实。不要仅调低 MAX_BATCH_TEXTS：超出它的现有客户端批量会直接返回 400。后续优先核对节点 MemAvailable 与按进程 RSS，再选择保持外部合同的内部推理分批或适当调整执行并发/内存；暂不增大并发、不自动扩容、不改线上配置。

2026-10-31 后续：采用了“保持外部合同的内部推理分批”，并加了空闲时按常驻内存回收 worker，未增加并发或内存上限。详见 [HanLP 第三轮](hanlp-query-concurrency-2026-10-20.md#第三轮2026-10-31worker-内存回收)。
