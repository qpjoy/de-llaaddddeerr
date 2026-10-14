# 策略接口、持久化与每日入库统计

更新：2026-10-15。以下结论来自当前 Hub 与本机 `/Users/qpjoy/workspace/mingxi/Night-All` 源码；不能据此证明线上部署版本、当前供应商健康或实际数据库记录数量。本文不授权付费探测、历史补采、停用旧接口或更改 MX-H2I 登录联网。

## 入口名称与实际执行者

`/api/v1/search/crawl` 与 `/api/v1/night-all/search/crawl` 是同一 Hub 兼容合同；user-info 的两个拼写也是如此。URL 含 `night-all` 不保证每次调用都经过 Night-All，URL 不含它也不保证已经迁移。调用者始终向 Hub 认证、授权、计量与结算。

| 用途与平台 | 当前执行位置 | Hub 持久化/入库边界 |
| --- | --- | --- |
| 兼容 crawl：抖音、Facebook、Instagram、LinkedIn、Reddit、TikTok、Twitter、微博、YouTube | Hub → Night-All → 原已登记供应商 | 成功/部分成功交付保留兼容响应及连接器证据，原子排队进入 canonical |
| 兼容 user-info：抖音、Facebook、Instagram、LinkedIn、Twitter、微博、知乎 | Hub → Night-All → 原已登记供应商 | 同上；资料由 `raw_info` 映射为 profile |
| 小红书兼容 crawl/user-info | 符合单账号、posts、受支持标识/游标等形状，且正式 Key 和原操作门禁允许时，Hub → TikHub；其他兼容形状仍经 Night-All | 已迁移链路也保留独立供应商/请求证据并排队入库；crawl 的资料子调用与内容子调用分别留证据 |
| Twitter 专用 `/api/v1/data/social/search`、`crawl`、`user-info` | Hub → RapidAPI，不回退 Night-All | 当前 `socialData()` 明确 `skipIngest:true`：保留调用/交付归档，**不自动写 canonical** |
| 标准 `/api/v1/data/search` 与普通 raw 搜索 | 按平台和形状分别由 Hub 直连或经 Night-All；TikTok 等保留旧适配器，Instagram/Facebook 使用各自现行策略，Twitter/微博/小红书存在已迁移范围 | 标准旧适配器用 `search-result` 入库；Hub 直连搜索与兼容交付用各自已绑定的入库作业 |
| 微信 `data/search`、`/search/raw` 与专项搜索 | 归一为 Hub 原生微信接口，不经过 Night-All；含 night-all 的旧微信 raw 分支仍为 410 | 当前 `forwardNative()` 明确 `skipIngest:true`，保留原生交付/受限证据，**不自动写 canonical** |
| Telegram | Hub 本地已采集数据 | 查询已有数据，查询本身不产生新的上游采集 |

兼容支持范围是原合同的明确集合；例如 TikTok/Reddit/YouTube 没有在兼容 user-info 中声明，LinkedIn 没有在普通兼容 raw 中声明。不能由表中某用途支持一个平台推导所有用途均支持。

供应商保持原约定：Twitter 使用 RapidAPI，Facebook 使用其既有 JustOne/额度策略，其他平台不因此改走 RapidAPI。本文和统计都不修改供应商选择、授权、价格、游标、原始响应或历史账本。

## Night-All 会不会自行保存

**源码存在自行保存流程，但不是每个成功响应都必然完整落库的保证。**

- `/search/crawl`、`/search/user-info` 先经 `dataApiRequests.track()` 记录请求审计；审计建行/结束写入会捕获数据库异常、进入短期审计熔断，业务仍可能继续。因此审计成功与业务返回成功必须分别核对。
- TikHub 执行器与 JustOne 搜索会尝试建立 `source_call_logs`。创建调用记录失败会保留 `storageError` 而继续调用；取得可用 call ID 后，已规范化内容通常经 `insertItems()` 写入 `social_<platform>_contents` 与 `social_<platform>_observations`，内容重复按原唯一键更新，观察绑定调用。
- 缺少对应内容/观察表时，存储仓库可以返回空数组；没有稳定外部 ID 的条目会跳过。`event_source_items` 投影还受目标列是否齐全及条目类型条件限制，不能声称所有返回对象都已加入事件库。
- RapidAPI 用户资料与 JustOne Facebook 用户资料等有 `insertActors()` 分支，写入 `social_<platform>_actors`；目标 actor 表不存在也会返回空数组。TikHub 用户资料先走其已规范化 item 存储路径，不能把所有供应商资料保存都笼统描述成同一 actor 表。
- 一旦已有 call ID，某些 TikHub/JustOne 后续存储错误可能使该请求失败；RapidAPI 资料存储则会把错误记入 storage 元数据后继续返回。不能把整个项目的存储统一称为强制成功或统一称为完全忽略失败。

`crawlDataApi()` 正常实时抓取后返回标准兼容 envelope；单独的 `crawlDataApiFromStorage()` 才启用 `storageBackedResult` 从对应已存调用记录重建结果。普通 crawl 返回接口并不等于无条件只读缓存。

因此 Night-All 是否真的保存了某次结果，要读取它的调用存储元数据、`source_call_logs` 和目标表，而不是从 Hub HTTP 200 或某个 `resultCount` 推算。Hub 本轮统计只读 Hub 自己的入库证据，不连接或统计 Night-All 数据库。

## Hub 如何保留兼容结果

旧兼容调用不是只转发。`HubService.#nightAllCompatibilitySearch()` 在外部调用前建立 `serving.connector_calls`，成功后 `commitCompatibilityLiveDelivery()` 在一个 PostgreSQL 事务内提交：

1. 原请求 `usage_requests.response_body` 和交付状态；完整成功还建立有时效的 `serving.compatibility_snapshots`，用于已有回退语义。
2. 连接器结果、上游请求关联与失败/部分成功证据。
3. 以 connector call ID 去重的 `mxq.jobs` 入库作业。

事务保证的是“交付证据与入库作业同时提交”，**不保证 HTTP 返回时异步入库已经完成**。未知、失败、入库重试/死信仍需看对应记录。旧兼容合同保留完整已解析 JSON 和 `raw_info/raw_data` 字符串；不能把它等同于 Hub 原生供应商路径额外提供的逐字节供应商原始响应归档。

入库 worker 的 `night-all-compat-result` 分支将 `raw_info` 映射为 `profile`，`raw_data` 映射为 `post`。账号身份使用平台和稳定外部 ID，不按显示名合并；缺稳定 ID 或无法映射的对象可能跳过，不能把原始返回条数视为 canonical 数量。映射出的资料、正文、媒体和原始字段保留各自的原始/规范化证据。

`ingestExternalRecords()` 在事务内写 source objects/revisions、`core.canonical_records`、`core.record_revisions`、`core.observations` 和 outbox；由独立投影器消费到 Elasticsearch。内容未变化时不创建新的内容版本，但可能留下新的观察与指标证据。成功连接器 call/供应商 call 绑定入库 run、原请求和每条观察，旧 NULL 链路不会从可变当前状态猜补。

标准旧 `/data/search` 使用 `night-all.search.v1` 与 `search_posts` 入库流；兼容 raw/crawl/user-info 使用 `night-all.compat.v1`。Hub 直连已接入搜索通过 `external-platform-result` 与其原定 dataset 入库。相同社交内容跨 dataset 仍是不同 canonical 身份，统计不会虚称全域去重的真实帖子数。

## 每日调用与每日数据是两个指标

已有 `GET /internal/v1/admin/strategy-search/usage?days=7` 统计保存的业务请求；新增 `GET /internal/v1/admin/strategy-search/data-statistics?days=7` 统计 **有链路证据的 Hub 入库子集**。两者都仅 Admin Token 可读，`days=1–31`、默认 7，时区为 Asia/Shanghai，包含今日未结束部分；读取不发供应商请求。

数据看板按 `ingest_runs.started_at` 的实际入库日归属，返回 `items[].interface/platform/objectType`、各项 `total` 与逐日补零的 `daily`，还有整个窗口独立去重的 `summary`：

| 字段 | 口径 |
| --- | --- |
| `newObjects` | 第 1 版归属当前创建 run，且 canonical 首次入库时间、首版创建时间与 run 创建时间精确一致的唯一对象；重新观察第 1 版不算新增 |
| `updatedObjects` | 本窗口/当日新写入第 2 版及以后内容版本的唯一对象 |
| `contentRevisions` | 上述第 2 版及以后新内容版本条数 |
| `observations` | 有对应请求与已完成入库 run 的已保存观察条数 |
| `observedObjects` | 上述观察涉及的唯一 canonical 对象数 |

`summary` 和每组 `total` 按整个窗口去重，daily 按当日去重；同一对象可跨接口、跨日观察或更新，不能相加每日或接口行重建全局唯一对象数。新增对象也可以在同一窗口随后更新。初始由其他导入建立的对象不能在首次 API 再观察时冒充 API 新增。

覆盖边界必须随看板显示：Twitter 专用 `/data/social/*` 与微信原生转发当前跳过 canonical 入库；无已保存策略路径、无完整入库观察链路、未完成 run 或没有映射成对象的结果不计入。旧观察缺少 `canonical_revision` 时不猜测更新。缺席或零值不代表这些接口没有返回、没有归档，或 Night-All 没有自存。

内存模式没有持久化入库账本，返回 `available:false`、`summary:null`；不会虚构零。队列积压/失败当前返回独立 `processing.available:false` 和原因，不把未统计当作 0。需要任务/死信诊断时使用现有数据清洗中心。

查询先使用已有 `ingest_runs_stream_idx` 的 connector/stream/时间范围定位，再利用 `observations_ingest_order_idx` 与 record revisions 主键联接窄身份；不读取正文或 raw payload。READ ONLY 事务、10 秒本地 statement timeout，超时要求缩小日期范围。无需新迁移，不修补旧链路、不改历史数据，也不启动重新入库或索引重建。

## 目前不能直接移除旧接口

兼容 crawl/user-info 对多数平台仍由 Night-All 执行；即使调用转到 Hub 不含 night-all 的别名，实际旧适配器依赖也可能仍在。调用统计合并兼容别名，部分历史 data/search 没有 connector_calls，微信三个入口也归一到专项路径；它不能区分真实旧 URL 流量，也不能证明所有迁移已经完成。

退役前应同时核对足够时间的入口访问日志、业务请求与连接器/供应商证据、各客户端的真实迁移版本，以及每个平台和用途的替代合同及分页。先保持旧格式、授权、定价与原请求重放；本轮没有删除接口或停止 Night-All。

## 源码依据与本地验证

Hub：`server/hub-service.mjs`、`server/contracts/night-all-legacy.mjs`、`server/external-platforms/gateway.mjs`、`server/external-platforms/tikhub-user-info-gateway.mjs`、`server/workers/ingest.mjs`、`server/ingest/legacy-night-all.mjs`、`server/stores/postgres-store.mjs`、`server/data/strategy-search-data-statistics.mjs`。

Night-All：`routes/v1/search.js`、`lib/domains/search/search-public-facade.js`、`crawl-data-api-service.js`、`tikhub-execution-service.js`、`justone-search-service.js`、`user-info-service.js`、`rapidapi-storage-service.js`、`lib/integrations/tikhub/repository.js`、`lib/domains/data-source/services/data-api-request-service.js`。

本地定向统计/API 回归 12 项通过，包含 PGlite 实际 SQL 聚合、首次创建/重复第 1 版/其他导入后观察/跨用途更新去重、权限隔离与只读超时。未验证线上数据量、队列状态或供应商实时结果；未发付费请求。
