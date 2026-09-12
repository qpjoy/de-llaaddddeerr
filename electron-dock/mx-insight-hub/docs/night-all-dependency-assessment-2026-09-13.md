# Hub / Night-All 依赖评估与分阶段迁移

日期：2026-09-13。范围：本地 Hub server、workers、运维脚本与 Night-All 的 routes/lib/docs/specs。本文是代码评估和建议，不代表已经验证线上开关、目标地址、数据库连接、业务流量、磁盘或 ES 健康，也没有修改运行策略。

用户目标：明确全部固定依赖与回退路径；解决 Twitter crawl 预算问题；让 Hub 承接适合的简单采集和 Agent 编排，同时保留 Night-All 自建专业服务。

## 1. 结论

Hub 已经不是纯 Night-All 代理。固定运行时 HTTP 依赖集中在三个业务组：统一搜索、legacy raw/crawl/user-info、存量导出回填。另有 Night-All 数据库作为清洗来源的依赖，不能因为不走 HTTP 就遗漏。

不存在“所有 Hub 请求失败都回 Night-All”的通用保底。小红书历史路径属于按条件选择的分发路线，直连失败不会在本段代码里自动切到 Night-All 再买一次。legacy 的异常保底是 Night-All 失败后取 Hub 精确快照。ES 失败的存量读取回退到 Hub PostgreSQL，不是 Night-All。

当前问题应先在 Hub 兼容入口修正预算语义与可观测性，不应通过移除鉴权或全局抬高 pageSize 解决。简单采集迁移不必等待完整 Agent Studio，但必须复用受控 connector、持久任务和原始证据入库，不能把爬虫放进 API 进程同步执行。

## 2. 固定依赖清单

| Hub 入口/组件 | Night-All 目标 | 触发条件与范围 | 断开影响/保底 |
| --- | --- | --- | --- |
| POST /api/v1/data/search | POST /api/v1/data/search | 普通历史搜索路径；适配器注入 consumer businessId、availabilityMode=ready_only | 已提交的相同幂等请求可重放；本分支未实现 legacy 那种独立旧快照兜底。异常返回 rejected/unknown |
| POST /api/v1/night-all/search/raw；别名 /api/v1/search/raw | POST /api/v1/search/raw | legacy 关键词/查询；小红书满足直连条件时例外 | Night-All ambiguous 或 HTTP 502/503/504 时尝试 Hub 同 consumer/operation/fingerprint 的有效快照 |
| 同上 crawl | POST /api/v1/search/crawl | 用户/频道采集；Twitter 当前走此路径，小红书满足直连条件时例外 | 同 legacy 快照策略；本次 work_budget_exceeded 在调用之前返回 |
| 同上 user-info | POST /api/v1/search/user-info | 用户资料；小红书满足直连条件时例外 | 同 legacy 快照策略 |
| POST /internal/v1/admin/backfill → backfill queue → ingest worker | GET /api/v1/data/export?platform&since&cursor&limit | 已配置平台的存量回填；独立 export token；分块续跑、保存游标和心跳 | Night-All 停止则回填暂停/失败；已经入 Hub 的记录仍可查。不会因为读取已有导出而主动发起爬虫，但会消耗 Night-All 数据库资源 |
| /internal/v1/admin/pipelines/night-all-saved-records/* + external source worker | 来源 PostgreSQL 的 public.saved_records_* | 固定表/写者合同，来源连接由管理配置，13 个来源分类 | 不经过 Night-All HTTP；依赖它的数据生产与数据库。Hub 已入库数据继续可用 |
| 运维 migrate-tikhub-credential.mjs | 指定 Night-All 私有配置文件 | 一次性迁移外部平台凭据到 Hub，不是每次请求读取 | 不等于运行时采集依赖；不应把原始凭据写入评估、日志或公共文档 |

legacy 支持的平台集合是 Hub 固定合同，不意味着上游此刻健康：

- raw：bilibili、douyin、facebook、instagram、kuaishou、reddit、tiktok、twitter、wechat_mp、wechat_search、weibo、xiaohongshu、youtube、zhihu。
- crawl：douyin、facebook、instagram、linkedin、reddit、tiktok、twitter、weibo、xiaohongshu、youtube。
- user-info：douyin、facebook、instagram、linkedin、twitter、weibo、xiaohongshu、zhihu。

saved_records 分类：汽车、财经、论坛、热点、地方新闻、媒体、新闻、其他、招聘、研究、社交媒体、科技、网页。数据产品采用 data_center_saved_records_* 逻辑平台，不应把 Night-All 当作对外业务分类。

### 定义了但未找到生产调用点的方法

NightAllAdapter.dependencies() → /api/v1/health；capabilities() → /api/v1/data/capabilities；exportWatermarks() → /api/v1/data/export/watermarks。

这些方法存在，不等于目前定期访问它们：app.dependencies() 明确将外部 dataService 标记 unknown；HubService.capabilities() 本地构建历史能力；回填进度读取本地队列游标。legacySearchCapabilities() 本身也是本地合同生成，无 HTTP。

## 3. 分流和保底边界

### 小红书

- /data/search：pageSize=20，兼容的首屏、验证/灰度开关满足时走 Hub TikHub connector；已发的直连 cursor 保持原路径。
- 非 20 页大小或其他不满足直连条件的历史请求仍可能走 Night-All。
- legacy raw/crawl/user-info：各有请求形状与独立 rollout 条件；不能把“小红书已直连”理解成全部旧调用已经迁完。
- 直连分支返回 gateway 的结果，不自动在失败后调用 Night-All。否则超时未知时可能双重采集和扣费。
- 迁移必须固定 cursor、请求指纹、幂等键所属执行器，不能在翻页中途无声更换。

### legacy 旧快照

Night-All 错误满足 ambiguous 或 502/503/504 才尝试 Hub 快照。当前窗口 raw 15 分钟、crawl 60 分钟、user-info 60 分钟；精确匹配 consumer、operation、fingerprint，并受快照有效性约束。400 参数拒绝不应伪装成缓存成功。

快照交付不能把未知上游结果改写成“未调用”，必须保留源调用证据与 sourceMode。相同幂等键重放和旧快照保底是不同机制。

### 已不走 Night-All 的固定能力

- Telegram 搜索读取 Hub canonical；public_opinion 和 data_center_saved_records_* 由 stored/canonical 路径提供，统一 live-compatible search 明确拒绝它们。
- 电商/账户搜索的 JustOne connector、小红书 TikHub 直连部分已经在 Hub。
- tokenize 使用 mx-common segmenter；其降级不等于 Night-All 保底。
- Hub 字段映射、分类、embedding、专题/省级分析及 Agent Market 的已有执行器使用 Hub 数据和配置的模型；确定性/模型序列回退不等于 Night-All 调用。
- 未发现固定调用 Night-All /agents、/agent-runs、/research、/search/intent 的 Hub 生产执行链。因此完整 Agent 中心不是“替换一批现有 Night-All Agent HTTP”这么简单；主要是新增 Hub 自身执行能力、逐步替换 connector 后端。

可配置边界：自定义 HTTP 数据源、数据库连接、模型/代理地址可能由线上数据库配置指向 Night-All 或其自建服务。本地固定调用扫描无法穷尽这些实例；部署前需导出脱敏的 source/connection/provider/proxy 配置清单并按实际目标聚合。也不能从服务名称推断 HanLP、数据库或模型实际部署归属。

## 4. 当前 Twitter crawl 问题

代码要求 identityCount × effectivePageSize × activityTypeCount ≤ min(policy.maxPageSize,100)。effectivePageSize 优先 count，其次 pageSize、limit，缺省 20。相等允许，截图“total_count=100 恰好触发”不能作为准确的因果结论。

已本地复现：单身份 100 条通过；两个身份各 100、单身份 100 加两个 activityTypes、username 与 usernames 重复表达同一账号均返回同样 400。实际失败请求缺少 body，仍不能确定是哪一种。

Night-All 的 crawl schema 本身也限制 count≤100，但其 social-crawl-service 对 username/usernames 做合并去重。Hub 原预算按提供字段相加，这属于可修正的兼容语义差异。

建议近期实施顺序：

1. 保留单身份/单页上限 100，另设 maxCrawlWork，默认 100；按 consumer/platform 授权受控放宽，不由公开 body 自报预算。
2. 对已证实等价的字段做合并去重；username 与 userId 跨命名空间不做猜测合并。活动类型也按实际平台执行语义归一化。
3. 拒绝响应增加 stage=admission、upstreamDispatched=false、identityCount、pageSize、activityTypeCount、requestedWork、allowedWork、retryable=false，不记录身份值/密钥。配套日志让 requestId 可定位预检失败。
4. Agent 对此 400 不原样重试；同步入口继续明确拒绝超额。大任务通过新异步任务合同拆分，并跟踪所有子请求、分页游标、已交付条目和总预算。
5. 不要在旧同步接口内部悄悄拆成多个付费请求后假装仍是一笔；那会改变计费、失败恢复和响应合同。不要为绕过 100 而移除鉴权/账本。

500 只是可选验证值，不是经过容量验证的生产建议；独立总预算放宽仍不能绕过 Night-All 每页 schema、平台权限和真实上游限制。

## 5. Hub 是否变重，以及测什么

Hub 比无治理的代理多了授权/策略读取、预约、幂等、调用证据和结果落库，存在真实开销。reserve 使用短 PostgreSQL 事务，并在 tenant/consumer 月度计划、scope、幂等键上加 advisory locks；同一调用身份高并发可能竞争。上游 HTTP 位于预约事务之后，不应描述为整个网络等待一直占着该事务锁。

搜索结果提交与 ingest enqueue 原子完成；归一化、canonical 和 ES 投影在后台。这保证失败后能恢复，不应为了“轻量”退回可能丢结果的内存任务。

优先测：
- 按 route/consumer/operation 统计 QPS、P50/P95/P99、预检拒绝率、请求字节和结果条目。
- 单独计时 auth、policy、reserve/lock wait、connector、commit/enqueue、响应序列化；区分总预算与实际外部调用数。
- PG pool wait、锁等待、账本/原始响应/队列表大小；观察 reapStaleReservations 的请求内清理开销，再决定是否限频或后台化。
- ingest/projector 排队时间、运行数、重试和 oldest-job-age；ES 写入拒绝、检索耗时、磁盘水位。
- Night-All 延迟/错误、下游限流及模型失败分别计量；不把模型 503、Hub 400、ES 故障归为同一告警。

限流需区别在线检索、付费采集、批量回填、清洗/投影；回填与大 Agent 作业不能挤占用户交互和登录资源。当前没有线上指标，不能声称已经发生瓶颈或给出承载量。

## 6. 适合迁移的业务与前置

| 业务 | 建议归属 | 迁移门槛 |
| --- | --- | --- |
| 已存数据筛选、聚合、摘要、人物画像报告 | Hub | 数据权限/来源完整；模型序列、证据引用、可恢复 run、结构化输出、质量评估 |
| 简单公开 HTTP/RSS/固定 JSON 采集 | Hub connector + 独立 worker | URL/网络边界、限流、缓存、抓取许可/认证、版本化解析器、持久任务和去重 |
| Twitter 用户资料/有限页发文 | 可作为下一条独立试点 | 明确 provider 合同、成本、cursor、用户标识、节流、结果规范化；旧路由按开关和已发 cursor 固定执行器 |
| 复杂反爬、登录态/浏览器采集、专业爬虫 | 保留 Night-All 或专门 worker | 会话、代理、反爬维护和资源隔离；不要把它们塞进 Hub API 进程 |
| Night-All 自建专业数据服务、历史库 | 保留 Night-All | 版本化内部 API/导出/CDC、健康和超时边界；Hub 管产品合同和访问权限 |
| 媒体持久化 | 独立 mx-static | 本地持久队列/落盘、NAS 隔离与容错完成后再接；不成为 API 登录依赖 |

不能用“大模型 Agent”替代所有确定性 connector。Agent 负责选择已授权工具、规划/归纳；分页、金额校验、幂等、预算与落库仍由确定性代码执行。

### 可复用基础

Hub 已有 Postgres 持久队列、预约/计量、connector evidence、原始响应、ingest worker、canonical/outbox/ES、LLM Sequence、部分规则与模型分析、Agent Market dry-run。它们是迁移基础，而非从零另建一套框架。

Agent Studio registry 当前标记 compile-only/runtimeAvailable=false，静态图校验和编译不能代替生产执行器。已有专用分析运行也不能自动证明任意图能恢复、取消和安全执行采集。

### 通用 Agent 中心必须补齐

1. 版本化发布与运行快照：definition、tool/connector/parser/model sequence 版本锁定，明确 compile/test/release/run 状态。
2. 持久运行状态：run/step/attempt/checkpoint、租约与心跳、可恢复 cursor、取消、超时、部分结果、死信和人工恢复。外部副作用采用 at-least-once + 幂等/对账，不宣称天然 exactly-once。
3. 权限与副作用：运行继承 consumer/tenant 授权，工具分只读、采集、写入、发布；LLM 不能扩大授权或自己切换供应商凭据。
4. 分层预算：每页、总条目、外部调用次数、并发、时间、模型 token、费用独立；有每 consumer 和全局公平性，不能只用 count 代表成本。
5. 数据合同：raw 原样证据 → versioned parser → observation/canonical → outbox → ES。定义数据归属、去重键、修订、授权、保留期、重解析、媒体来源与存储。
6. 安全运行边界：HTTP 工具不能任意访问内网/元数据；脚本/浏览器工具在独立受限执行环境；抓取内容是数据，不能当作 Agent 的系统指令。
7. 评估与追踪：完整 request/run/step/connector trace 关联、合同 fixture、质量/费用/失败评估、无真实付费的故障测试；灰度前验证重启、超时、部分提交和取消。

## 7. 实施路线及验收

P0：先做预算解耦、别名一致性、可解释拒绝；用本次故障变体验证 100 边界、重复身份、多活动、未授权放宽，证明拒绝时没有上游 dispatch。

P1：创建 provider-neutral 的采集任务合同，内部仍可使用 Night-All executor。先解决长任务拆分、断点、回查、部分交付与资源隔离，不急着搬所有爬虫。

P2：选一种 Twitter 单账号资料/发文或简单公开源实现 Hub-native connector。固定样本/录制响应做对照，灰度只让一个执行器拥有一次付费请求；不能用双跑同一付费采集当默认影子验证。保留回滚开关和旧 cursor 的执行器粘性。

P3：Hub 自有入库完成后，让画像/报告 Agent 使用同一数据产品读接口；保持公开 API Key 合同、授权和来源证据，避免下游依赖物理 provider。

P4：Night-All 专业服务长期保留，稳定为 Hub 的可选能力后端和数据来源。以实际成本、质量、运维收益决定单个能力是否继续迁移。

部署前补齐脱敏的线上清单：Night-All base URL、已开启 rollout/canary、配置的数据源/模型目标、回填任务、各 route 调用量、最大 payload、DB/队列/ES 指标。仓库历史 specs 有尚未实现域名和旧状态说明，不能据此宣布线上现状。

## 8. 代码证据导航

- server/adapters/night-all.mjs：全部固定 HTTP 方法；server/index.mjs：适配器注入和小红书 rollout。
- server/hub-service.mjs：capabilities、nightAllCompatibilitySearch、search；server/app.mjs：路由、dependencies、backfill 管理入口。
- server/data/night-all-compat.mjs：预算和快照错误条件；server/contracts/night-all-legacy.mjs：操作/平台白名单。
- server/workers/ingest.mjs、server/ingest/backfill.mjs：回填与归一化任务。
- server/ingest/crawler/source-contract.mjs、pipeline.mjs：saved_records 来源合同和清洗任务。
- server/stores/postgres-store.mjs：reserve 锁、结果/队列原子提交、快照存储。
- server/agent-studio/registry.mjs、compiler.mjs；server/agent/index.mjs、providers.mjs；server/agent-market/runner.ts：设计期/已有运行边界。
- scripts/migrate-tikhub-credential.mjs：配置文件凭据迁移，仅为运维依赖。
- Night-All/lib/shared/schemas/search.js、lib/domains/search/social-crawl-service.js：每页 100 和身份合并。
- Night-All/routes/v1/search.js、data.js：采集与存量导出服务入口。
