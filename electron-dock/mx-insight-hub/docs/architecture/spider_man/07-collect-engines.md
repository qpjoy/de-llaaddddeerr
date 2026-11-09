# 07 通用采集引擎（阶段 1）

**活文档。** 这是 [06 接入计划](06-platforms-integration-plan.md) 阶段 1 的设计和实现记录，后续阶段（Apify、runner、应用商店……）都挂在这套骨架上，改动要同步更新本章。

最后更新：2026-11-09。状态：阶段 1–6（通用骨架、Apify、同步查询、runner 与应用商店、单链接补全与子域名、音频）**已实现未部署**（本地未提交）。

## 1. 目标与边界

- **一套通用骨架**：把「自建引擎」从「只服务微信」推广成任意采集方式都能接的异步任务框架。
- **高并发**：
  - 一个引擎可以有多个执行槽，不再只能串行；
  - 多个进程、多个节点可以同时派发，彼此不等待；
  - 调用方大量提交和轮询时，对数据库的压力有上限。
- **统一管理入口**：Hub 管理台「数据接入与治理 → 自建引擎」统一管理所有引擎，原来的微信引擎也列在这里。
- **不动的部分**：
  - 微信引擎的表（migration 165）、执行器和对外接口一律不改；
  - 不影响 MX-H2I 的登录和联网，也不改 Launcher；
  - 迁移只新增 schema，不修改、不锁现有表。

## 2. 数据模型（migration 183，schema `collect`）

| 表 | 内容 |
|---|---|
| `engines` | 一行对应一个真实的上游资源。字段包括：<br>· 类型 `kind`、名称、插槽 `slot_ref`、地址、凭据键；<br>· 执行槽数 `capacity`、排队上限、每个调用方未完成上限、最长排队时间、单次执行上限；<br>· 启用开关、计费开关、隔离、冷却、修订号 |
| `engine_slots` | 每个执行槽一行：当前任务、隔离原因 |
| `routes` | 哪个引擎承接哪个能力。`route_key` 用来把同一能力分给多个引擎，例如每个应用市场一个引擎 |
| `batches` / `jobs` | 任务。`phase` 区分 `dispatching`（本进程正在调用上游，受租约约束）和 `waiting`（上游已接收，到点由任一执行器核对） |
| `job_results` | 结果只写一次，和任务行分开存。轮询和扫队列都不会读写大字段 |
| `engine_events` | 审计记录：新建、配置、隔离、恢复、冷却、核对 |

新引擎一律由管理台创建，默认停用，迁移里不预置任何引擎。

## 3. 并发设计

| 场景 | 做法 | 保证 |
|---|---|---|
| 派发 | 领取任务时，用 `FOR UPDATE SKIP LOCKED` 取一个空闲执行槽，再取最早的排队任务 | 任何进程、任何节点都不等待别人；部分唯一索引 `(engine_id, slot_no) WHERE status='running'` 保证一个槽同时只有一个执行中任务 |
| 加锁顺序 | 所有会等待的事务，都按「引擎 → 执行槽 → 任务」的顺序加锁 | 不会死锁。领取时对执行槽和任务都用 SKIP LOCKED，从不等待 |
| 提交 | 对同一调用方的提交加一把事务级锁（`collect:submit:<consumer>`）；整批任务用一条 `INSERT … jsonb_to_recordset` 写入 | 每个调用方的未完成上限是精确的，幂等也没有竞态；不同调用方的提交互不等待 |
| 引擎排队上限 | 计数最多扫到上限 + 1 行 | 属于准入控制（不变量 4），允许同时在途的提交短暂超出 |
| 轮询 | 每个引擎、每个进程缓存队列快照 2 秒，快照最多取前 1000 条；`Retry-After` 在执行中时为 5 秒，排队时按预计开始时间给 5–60 秒 | 读取压力不随轮询方数量线性增长。预计开始时间会扣除当前空闲的执行槽 |
| 异步任务 | 上游接收后任务进入 `waiting`，执行器进程不再占用它；到点由任一执行器领取核对，领取时把 `next_check_at` 往后推，这一步本身就是核对租约 | 执行器重启不会丢任务，也不会把任务误判为 unknown |
| 派发途中进程失联 | 用租约发现（`lease_until`）。可核对的类型改为向上游核对（runner 用 dispatchId 查询）；不可核对的记为 unknown，并隔离执行槽 | 多个执行器同时运行也安全：不会因为一个进程启动，就把另一个活着的进程正在执行的任务判为失联 |
| 吞吐 | 每个进程最多同时处理 32 项；任务一结束立刻唤醒执行器去取下一条，不等 1 秒的轮询周期 | 执行时间短的任务也能用满执行槽 |
| 执行器空闲时 | 每秒做一次无锁的就绪查询 | 空闲引擎没有行锁，也不产生 WAL |

## 4. 执行方式（合同）

`server/collect/contracts/`：每种 `kind` 一个合同模块。合同只负责组请求和判定结果，所有状态变化都由存储层和执行器完成。

- `sync`：一次请求，`dispatch` 直接给出结果。留给以后迁入的微信 Night-All 这类同步调用。
- `async`：`start` 给出结果或上游关联 ID，之后 `check` 反复核对，直到给出结果。
- 结果判定统一为 `succeeded / failed / unknown`，另带数据完整性（`success / partial / no_data / unknown`）和 `charge`、`quarantine`（`slot` 或 `engine`）、`cooldownUntil` 等字段。

第一阶段已实现的合同：**runner**，对应 mx-crawler-runner 协议（`mx-crawler-runner.v1`）：

| 接口 | 语义 |
|---|---|
| `POST /v1/invocations` | 请求体 `{dispatchId=jobId, slotId, operation, params, deadlineMs}`。runner 先持久登记再启动进程，返回 202 |
| `GET /v1/invocations/{id}` | 返回 `accepted / running / completed`，完成时带 adapter 结果外壳；结果至少保留 24 小时 |
| `GET /v1/health` | 返回 `{ok, version, capacity, running}` |

判定规则：

| 情况 | 判定 |
|---|---|
| 429 runner 没有空闲容量 | 失败，不收费，执行槽释放 |
| 其他 4xx | 失败，不收费 |
| 连接被拒、地址解析失败 | 失败，请求未送达 |
| 超时或 5xx | 改为向 runner 核对，不猜结果 |
| 确认已接收后查询返回 404 | unknown，隔离执行槽 |
| 从未确认接收，且隔开几次查询都是 404 | 判为没有开始执行，失败 |
| adapter 报告 `unknown` | 进程已经结束，所以不隔离执行槽，只把数据和计费标为待核实 |

## 5. 对外接口（202 + 轮询）

前缀 `/api/v1/data/collect`：

| 接口 | 说明 |
|---|---|
| `GET /capabilities` | 列出各能力的路由，以及当前 Key 是否已授权、能力是否就绪 |
| `POST /jobs` | 请求体 `{capability, input}`，必须带 `Idempotency-Key`；返回 202，带 `Location` 和 `Retry-After` |
| `POST /batches` | 请求体 `{capability, items:[{input, clientRef?}]}`，1–100 条，可以分到不同引擎 |
| `GET /jobs?limit=&capability=` | 当前调用方的任务列表 |
| `GET /jobs/{id}` | 查询任务 |
| `GET /jobs/{id}/result` | 读取结果：原样返回 adapter 结果外壳，另带字节数、sha256 和条数作为证据 |
| `POST /jobs/{id}/cancel` | 只能取消还在排队的任务 |
| `GET /batches/{id}`、`/result` | 查询批次、读取批次结果 |

这组接口在数据准入里归入 `read` 通道：它们只排队、读取已存的结果，真正的采集在执行器里完成。

**能力项由代码定义**（`shared/collect-engines.mjs`）。第一个能力项是 `collect.app.details`：

- 应用商店应用详情，按 `market` 路由，首个市场是小米（交付包 195）；
- 输入白名单：`market`，以及 `appIds`（1–50 个十进制字符串，不能重复）；
- runner 调用为 `operation=collect`、`params={inputs, input_kind:'id', history:false}`。

能力项会加入 `PUBLIC_CAPABILITIES`，但**不会**自动授予 `managed_full` Key（LCY-delta）：采集能力必须等插槽通过验收后，逐个 Key 显式授权。

## 6. 计费

沿用 D14 和 D15：

- 引擎上的计费开关默认关闭。关闭时不写使用账本，也不与调用方其他付费请求争用预留锁。
- 开启后，派发时预留账本（幂等键 `col-<jobId>`），按 `charge` 结算：
  - `success / partial / no_data` 收费；
  - 失败和取消不收费；
  - unknown 待核实。
- 价格通过套餐管理发布，部署迁移不写价格。

## 7. 管理台：数据接入与治理 → 自建引擎

页面：`src/self-hosted-engines.jsx`，路由 `/self-hosted-engines`，仅平台管理员可见。

- **总览**：启用引擎数、执行槽占用、排队数、待人工核实数、本进程执行器状态。
- **引擎列表**：通用引擎和原微信引擎放在同一张表里。原微信引擎带「原微信引擎」标记，点开后直接嵌入它原有的管理面板。
- **引擎详情**：
  - 概览：执行槽网格，隔离的槽可以填原因后恢复；连通性探测（只读）。
  - 配置：地址、凭据键、插槽、执行槽数、各项上限、承接能力、启用和计费开关；必须填修改原因，带修订号做乐观锁。
  - 任务：最近 50 条，可查看输入、派发情况、上游关联 ID、结果证据和原始结果外壳。
  - 记录：审计事件。
- **新建引擎**：选择类型，填写 ID、名称、地址、执行槽数、承接能力和原因；创建后为停用状态。

管理接口前缀是 `/internal/v1/admin/collect`：`catalog`、`engines`（GET 列表 / POST 新建）、`engines/{id}`（GET 详情 / PUT 修改）、`engines/{id}/probe`、`engines/{id}/recover`、`engines/{id}/slots/{n}/recover`、`jobs/{id}`。

## 8. 代码位置

| 文件 | 作用 |
|---|---|
| `migrations/183_collect_engines.sql` | schema、约束、索引 |
| `shared/collect-engines.mjs` | 前缀、状态、各项上限的取值范围、执行方式、能力项目录 |
| `server/collect/catalog.mjs` | 能力的输入校验、路由键、runner 调用映射 |
| `server/collect/store.mjs` | PostgreSQL 实现，以及语义一致的内存实现 |
| `server/collect/executor.mjs` | 多引擎执行器：执行槽、异步核对、租约回收、计费结算 |
| `server/collect/contracts/runner.mjs` | runner 合同 |
| `server/collect/service.mjs` | 对外接口、管理接口，以及读取原微信引擎的状态摘要 |
| `server/collect/runtime.mjs` | 组装。凭据按供应商键从凭据库读取（migration 052） |
| `server/app.mjs`、`server/index.mjs`、`server/hub-service.mjs`、`server/core/data-admission.mjs` | 路由、启停、能力项和准入通道 |
| `src/self-hosted-engines.jsx` / `.css`、`src/api.js`、`src/App.jsx` | 管理台 |
| `tests/server/collect-engines.test.mjs`、`collect-engines-postgres.test.mjs` | 单元测试和 PostgreSQL 原生测试 |
| `server/collect/contracts/{apify,native,shodan}.mjs`、`server/collect/native/*` | 阶段 2、3 的执行方式（第 10、11 节） |
| `migrations/184–186_*.sql` | apify、shodan、googleplay 的 System Proxy 绑定 |
| `electron-dock/mx-base/mx-crawler-runner` | runner 服务、审核过的交付包、镜像和部署清单（第 12 节） |
| `integrations/market-*/manifest.json` | 7 个应用市场的插槽登记（候选） |
| `tests/server/collect-{apify,sync,runner}.test.mjs` | 阶段 2–4 的测试 |

## 9. 验证（2026-11-09，本地）

- **单元测试 13 项通过**，覆盖：
  - 输入白名单；
  - runner 各种应答的判定；
  - 管理接口的校验和路由互斥；
  - 拒绝在排队之前完成（停用、未承接、未授权、超限、幂等）；
  - 执行槽上限、异步核对、隔离与恢复、失联派发的核对；
  - 凭据缺失和 runner 不可达时不占执行槽；
  - 开启计费时的结算；
  - HTTP 合同和管理接口的权限。
- **PostgreSQL 17 原生测试 4 项通过**：
  - 8 个并发领取、执行槽数为 2 时恰好领到 2 条；
  - 同一调用方 9 个并发提交、上限 4 时恰好成功 4 条，其他调用方不受影响；
  - 两个执行器使用各自的连接池，共享执行槽、核对并结算；
  - 失联派发的核对；缩容时忙碌的执行槽执行完再移除。
- **完整服务端测试套件**：和干净的 HEAD 副本相比没有新增失败。原有的失败都与本次改动无关，其中包括微信引擎的原生测试「billing off forwards…」，它在 HEAD 上同样失败。
- 微信内存存储的提交时间改为严格递增（只改内存实现，与 PostgreSQL 的 `clock_timestamp()` 语义一致）。原来两次提交落在同一毫秒时顺序随机，这次改动让测试跑得更快，频繁触发了这个问题。
- **浏览器端到端**（内存模式 API，加一个本地 runner 桩）：
  - 在管理台新建引擎，默认停用；
  - 探测健康；启用；
  - 用 Key 提交 5 条任务加 1 个批次，执行槽数为 2，20 秒内全部完成；
  - 能读到结果和证据；能力发现显示「已授权、已就绪」；
  - 原微信引擎的管理面板嵌入正常。

## 10. 阶段 2：Apify（2026-11-09，已实现未部署）

### 10.1 执行方式 `apify`（`server/collect/contracts/apify.mjs`）

| 步骤 | 请求 | 判定 |
|---|---|---|
| 启动 | `POST /v2/acts/{actorId}/runs?build=<固定版本>&timeout=&restartOnError=false`，请求体是审核后的 Actor 输入 | 201 且 `actId` 与固定的 Actor 一致 → 进入 `waiting`，运行 ID 存为上游关联 ID。400 / 401 / 402 / 403 / 404 / 429 → 失败，没有启动。连接被拒，或 System Proxy 探测全部失败（请求没发出） → 失败。超时、5xx、应答无法确认 → **unknown，隔离执行槽**（`apify_start_uncertain`），因为 Apify 上可能已经有一次付费运行 |
| 核对 | `GET /v2/actor-runs/{runId}` | READY / RUNNING / TIMING-OUT / ABORTING：继续等，间隔 5–30 秒；读取失败就下次重试。401 / 403 / 404：unknown，隔离执行槽 |
| 读结果 | `GET /v2/datasets/{id}/items?format=json&clean=false&offset=0&limit=N` | N 由能力的 `resultLimit` 决定，最大 1000。单页超过 4 MiB 时减半重读。完整性按 `X-Apify-Pagination-Total` 判断：总数达到请求条数就算完整（Actor 多给的不算缺）。少于请求条数且上游还有更多、没有总数头、记录里带 error、或运行以 TIMED-OUT 结束 → `partial`。0 条 → `no_data` |
| 结束 | — | SUCCEEDED → 成功。TIMED-OUT 且有数据 → 部分成功，没有数据 → 失败。FAILED / ABORTED → 失败。每种情况都记录 `usageTotalUsd` 作为采购成本 |
| 截止时间 | `POST /v2/actor-runs/{runId}/abort` | 启动时传给 Apify 的 timeout 比 Hub 的执行上限少 60 秒，正常情况下由 Apify 自己结束运行。超过截止时间后 Hub 再请求中止：确认已中止 → 失败，释放执行槽；没能确认 → unknown，隔离执行槽 |
| 探测 | `GET /v2/users/me`、`/v2/users/me/limits` | 不花钱。只取账号名、套餐、本月已用和上限、并发上限，不读邮箱等个人信息 |

- **不传花费上限**（D18），但每次运行的成本都记入任务的 `cost`。管理台的任务列表和引擎列表（近 24 小时合计）会显示，对外接口不返回。
- **执行器失联不重提**：Apify 无法按 Hub 自己的任务 ID 查运行，所以 `apify` 不支持核对（不可 reconcile）。派发途中进程失联的任务记为 unknown 并隔离执行槽，从不再次启动 Actor。
- 运行对象只保留审核过的字段：ID、Actor、状态、版本号、数据集、时间、成本、状态说明；不保留用户 ID、环境变量和代理信息。

### 10.2 试点能力项（2a）

| 能力项 | 交付包 | Actor@build | 输入白名单 → Actor 输入 |
|---|---|---|---|
| `collect.ecommerce.temu.search` | 111 | `crw/temu-products-scraper`（`dXoeNAkKt3ZRfOKvx`）@0.0.452 | `keyword`（1–100 字）、`sort`（5 种取值）、`maxItems`（10–200，默认 40）→ `region` 固定为 US |
| `collect.ads.meta.library` | 202 | `apify/facebook-ads-scraper`（`JJghSZmShuco4j9gJ`）@0.0.375 | `urls`（1–10 个 https facebook.com 链接）、`resultsLimit`（1–200）、`activeStatus`、`newerThan`、`olderThan`（YYYY-MM-DD）→ 详情、About 页面、电商补充一律关闭 |
| `collect.web.similarweb.overview` | 185 | `tri_angle/similarweb-scraper`（`heLi1j7hzjC2gFlIx`）@0.0.82 | `domains`（1–10 个裸域名，自动去掉 www.）→ `websites` |

三个能力项都是 `candidate`，不会自动授权。一个 Apify 引擎可以同时承接三者；它的执行槽数对应 Apify 账号允许的并发运行数，可以在探测结果里看到。

### 10.2b 电商能力项（2b，2026-11-09）

原则：

- 只开放关键词搜索，以及站点、排序、条数、价格这些必要的筛选。
- 会增加费用、风险或范围的选项一律关闭：卖家和多报价采集、验证码破解、变体价格、详情页、评论。以后要用就另立能力项、单独验收。
- Amazon 和 Shopee 还接受链接，但只限该平台自己的域名。
- 「条数」是对每个关键词或每个链接的上限；Hub 读结果时，按「条数 × 关键词数（或链接数）」读，最多 1000 条。

| 能力项 | 交付包 | Actor@build | 输入白名单 | 固定或关闭的 Actor 选项 |
|---|---|---|---|---|
| `collect.ecommerce.amazon.search` | 108 | `junglee/Amazon-crawler`（`BG3WDrGdteHgZgbPK`）@0.0.433 | 两选一：`keyword` 加 `marketplace`（US/UK/DE/FR/IT/ES/CA/JP/AU/IN/MX，Hub 拼成站内搜索链接），或 `urls`（1–10 个 amazon 各站点的 https 链接）。`maxItems` 1–100，默认 20 | `scrapeSellers=false`、`maxOffers=0`、`useCaptchaSolver=false`、`scrapeProductVariantPrices=false`、不展开变体；每个链接最多翻 5 页 |
| `collect.ecommerce.ebay.search` | 109 | `automation-lab/ebay-scraper`（`Y7h6Aodb7ZXkv6Ieb`）@0.1.36 | `keywords` 1–5 个；`marketplace` 是 8 个站点之一；`maxItems` 1–200，默认 50；`sort`、`condition`、`listingType`、`minPrice` / `maxPrice` | 翻页数按每页 60 条推算；`maxRequestRetries=3`；空的筛选条件不发送 |
| `collect.ecommerce.aliexpress.search` | 110 | `khadinakbar/aliexpress-all-in-one-scraper`（`UR7eULfh4hq61XjRe`）@1.1.4 | `keyword`；`site` 是 8 个站点之一；`shipCountry` 为两位国家码，默认 US；`maxItems` 1–200，默认 50 | `detailedItems=false`、`includeReviews=false`；代理用 Actor 默认的住宅代理，Hub 不改 |
| `collect.ecommerce.etsy.search` | 113 | `yumitori/etsy-listings-scraper`（`6xoTiGfCmvG8ZKmtn`）@0.1.104 | `keywords` 1–5 个；`country` 22 个可选；`sort`；`maxItems` 1–200，默认 48；价格范围；`onSaleOnly`、`freeShippingOnly`、`handmadeOnly`；`includeAds` 默认 false | `digitalOnly=false`、`dedupeAcrossQueries=true`；翻页数按每页 48 条推算，最多 30 页 |
| `collect.ecommerce.shopee.search` | 114 | `gio21/shopee-scraper`（`fmKWN5uByUCIy2Sam`）@0.4.66 | `country` 必填（BR/ID/TH/MY/SG/PH/VN/MX）；两选一：`keywords` 1–5 个，或 `shopUrls` 1–10 个，且必须是该国站点的链接；`maxItems` 10–500，默认 50 | 不开放分类链接；`priceSlicing=false`、`debug=false`。国家不给默认值，因为 Actor 默认会去巴西站 |

补充说明：

- **定位**：这 5 个和 Temu 一样是异步采集产品，**不能**作为同步接口 `/api/v1/data/ecommerce/products/search` 的备用供应商，因为主备合同不同（见 06）。
- **JustOne 欠费时**：Amazon、AliExpress、Shopee 可以通过它们拿数据，但调用方要改为 202 + 轮询。
- **结果结构**：原样保留各 Actor 的结果外壳。映射到统一商品结构（`products/search` 的 normalizedItem）属于数据映射验收阶段，以后再做。
- **授权**：5 个都是 candidate，不自动授权。每个能力单独授权，Key 拿到 Temu 的权限，不代表也能用 eBay。

### 10.2c 长尾能力项（2c，2026-11-09）

**新增规则（D27）**：每次启动 Actor 都传 Apify 的运行选项 `maxItems`，值等于 Hub 会读回的条数（能力的 `resultLimit`）。

- 对按结果计费的 Actor，这样 Apify 不会对 Hub 读不到的记录收费；
- 这限制的是条数，不是预算，和「先不做花费限制」（D18）不冲突；
- Craigslist 这个固定版本本身没有条数参数，完全靠这一项约束。

| 能力项 | 交付包 | Actor@build | 输入白名单 | 固定或关闭的选项 |
|---|---|---|---|---|
| `collect.ecommerce.shein.listing` | 112 | `shahidirfan/shein-product-scraper`@1.0.12 | `url`：www.shein.com 的分类或精选列表链接；`maxItems` 1–200 | 不支持关键词（交付包说明里就不支持）；不改代理 |
| `collect.ecommerce.flipkart.search` | 123 | `shahidirfan/Flipkart-Product-Scraper`@0.0.8 | 两选一：`keyword`，或 `url`（flipkart.com 链接）；`sort`；`maxItems` 1–200 | 两者都填时 Actor 会优先用关键词，所以 Hub 强制只填一个 |
| `collect.ecommerce.mercadolibre.search` | 118 | `sourabhbgp/mercadolibre-scraper`@0.0.74 | `country` 必填（9 国）；`keyword`；`maxItems` 1–200 | 只用搜索模式；详情、评论、问答、变体、卖家资料、精选商品都关闭；`maxConcurrency=2` |
| `collect.ecommerce.fbmarketplace.search` | 124 | `apify/facebook-marketplace-scraper`@0.0.326 | `urls`：1–5 个 facebook.com 的 `/marketplace/...` 链接；`maxItems` 1–200 | `includeListingDetails=false`；不接受帖子、主页、广告库链接 |
| `collect.classifieds.craigslist.search` | 127 | `ivanvs/craigslist-scraper-pay-per-result`@0.0.38 | `urls`：1–5 个 `<地区>.craigslist.org/search/...` 链接；`maxAgeDays` 1–30，默认 7；`maxItems` 1–200 | `maxConcurrency=2`；条数靠运行选项 `maxItems` 限制 |
| `collect.ecommerce.shopify.catalog` | 129 | `trovevault/shopify-products-scraper`@0.1.75 | `domains`：1–5 个裸域名；`maxItems` 1–500（每个店铺） | `includeInventoryDetails=false`；不传 `datasetId` / `runId` |
| `collect.web.builtwith.technologies` | 184 | `builtwith/builtwith-official-technology-scraper`@0.0.35 | `domains`：1–10 个 | `maxRequestsPerCrawl` 设为域名数 × 3（上游默认是一千万） |
| `collect.company.uk.search` | 191 | `scrapesage/companies-house-scraper`@1.1.18 | 两选一：`query`（名称关键词，配合 `maxItems` 1–100），或 `companyNumbers` 1–20 个（自动补零到 8 位，或 SC123456 这种格式） | 只取企业基础信息：高管、实际控制人（PSC，属于个人数据）、申报历史、抵押、监控模式都关闭；`maxConcurrency=2` |
| `collect.travel.tripcom.hotel-reviews` | 80 | `knagymate/trip-com-reviews-scraper`@0.0.23 | `hotelUrl`：trip.com 及其地区子域名的 `/hotels/...` 详情链接；`maxReviews` 1–500，默认 100；`sortBy`，默认最新；`since`（YYYY-MM-DD） | 不接受 ctrip.com 链接，也不含机票和门票 |

9 个都是 candidate，按能力项逐个授权。管理台的引擎列表里，承接能力多于 3 项时只列前 2 项，加「等 N 项」，悬停可看全部；完整列表在引擎的配置页。

### 10.3 出口和凭据

- **migration 184**：
  - 把 `apify` 加进 `external_platform_proxy_bindings` 允许的供应商；
  - 如果 `tikhub-internal-7788` 序列存在且启用，就把 apify 绑定到它（D19），否则用系统直连，等操作员在引擎页选择；
  - 探测结果缓存 5 分钟，避免每次查询状态前都先探测一遍；
  - 其他供应商的绑定、全局路由和 LLM 路由都不动。
- **出口**：调用走 `createApifyProxyFetch`，即 System Proxy 现有的 provider 路由。只有未鉴权的探测会切换代理，付费请求结果不明时从不换路重试。引擎配置页可以改绑定，带修订号，同时写入审计记录。
- **凭据**：
  - 新建 apify 引擎时，凭据键默认填 `apify`；
  - 在引擎配置页录入，写入共享凭据库（migration 052），只写不读；
  - 页面和接口只返回「是否已配置」和修订号；
  - 引擎审计记录只写「谁更新了凭据」，不写内容。
- **Q9 怎么关掉**：操作员把 token 录入后点「连通性探测」，就能看到这个 token 是否有效、什么套餐、本月已用多少、上限多少。

### 10.4 验证（2026-11-09，本地）

- **单元测试 9 项（`collect-apify.test.mjs`）**：
  - 三个试点能力的输入白名单；
  - 启动：201、各种拒绝、应答丢失、Actor 不一致、超时、连接被拒、出口不可用；
  - 核对：完整、Actor 多给、部分、空结果、记录带错误、缺总数头、TIMED-OUT、FAILED、数据集读取失败后重试、超大单页减半；
  - 端到端：凭据只写，运行、结果、成本、探测都不泄露 token 和邮箱；
  - 没有地址、凭据必填、缺凭据时不派发；
  - 截止时间：确认中止就释放执行槽，没确认就隔离；
  - 执行器失联不重提；
  - System Proxy 有 apify 路由，拒绝其他域名；
  - HTTP 接口里凭据只写、修订号冲突、出口不可用。
- **阶段 1 的 13 项测试仍然通过。** 两处断言原先写死「只有一个能力项」，已改为不依赖能力项数量。
- **PostgreSQL 原生测试 5 项通过**，其中新增一项：migration 184 把 apify 绑定到了 7788 序列（缓存 5 分钟），TikHub 的绑定不变；成本按引擎汇总近 24 小时。
- **完整服务端测试套件**：63 个失败，和 HEAD 基线完全相同，没有新增。
- **浏览器**：在新建引擎页选 Apify，地址和插槽字段会隐藏，凭据键默认 `apify`，三个能力项可选；创建、绑定、录入凭据（本地假值）后，页面只显示「已配置 · 修订 #1」，全页文本里搜不到凭据值；内存模式下出口显示为直连。生产构建通过。
- **2b（3 项）**：
  - 5 个电商能力的输入映射，以及付费附加项都关闭；
  - 22 种越界输入在排队前就被拒绝；
  - 一个 Apify 引擎同时承接多个平台，读结果的条数按「条数 × 关键词数」计算，Key 按能力项分别授权。
- **测试合计 25 项通过**（Apify 12 项，阶段 1 13 项）。在管理台的 Apify 引擎配置页，8 个能力项都能勾选。
- **2c（再加 2 项）**：
  - 9 个能力的输入映射：详情、评论、个人数据都关闭；
  - 23 种越界链接或已关闭的选项在排队前就被拒绝；
  - 启动参数里带上 `maxItems`。
- **测试合计 27 项通过。** 一个 Apify 引擎可以承接全部 17 个 Apify 能力项。
- **没有做的**：没有用真实 token 调用 Apify，也没有跑任何 Actor。8 个 Actor 的价格模型都还不知道。

## 11. 阶段 3：同步查询（2026-11-09，已实现未部署）

### 11.1 为什么不放在 native forwarding

06 原计划把 Shodan 做成 native forwarding 的一个新供应商前缀。实际看下来，native forwarding 和 TikHub、JustOne 的价格表、熔断、供应商网关绑得很紧，新加一家就要另外接一整套。所以改为在通用采集引擎上增加**同步执行方式**（D28）。好处是：

- 引擎、执行槽、凭据、出口、任务证据、计费开关、管理台都和阶段 1、2 用同一套；
- 「同时只跑几个」继续由 PG 执行槽保证。

### 11.2 同步查询 `POST /api/v1/data/collect/query`

- **请求**：和 `/jobs` 一样是 `{capability, input}` 加 `Idempotency-Key`，只接受标了 `sync` 的能力；其他能力返回 400 `capability_not_synchronous`。
- **执行流程**：
  1. 先像 `/jobs` 一样登记任务。
  2. 用 `claimJob` 认领**这一个**任务。它和普通派发一样用 SKIP LOCKED 抢执行槽，只是不按队列顺序。
  3. 抢到就在当前请求里执行，返回 **200 `{job, result}`**，`result` 里有原始结果和证据（字节数、sha256、条数）。
  4. 抢不到时，最多等 5 秒，期间也可能由其他执行器跑完。仍没完成就返回 **202**（带 Location、Retry-After），任务留在队列里由 Admin 执行器处理。
- **执行状态**：任务失败或结果未知时也返回 200，看 `job.status` 和 `job.error`，和 `GET /jobs/{id}` 一致。
- **在哪个进程执行**：Public 进程也能执行，用的是一个从不启动轮询的执行器实例；执行槽照样由 PG 仲裁。
- **准入通道**：`/query` 归 `acquisition`，因为会在请求里调用上游；`/jobs` 等其他接口仍归 `read`。
- **重放**：同一个 `Idempotency-Key` 重放时，返回已经保存的结果，不会再查一次。

### 11.3 执行方式

| kind | 合同 | 特点 |
|---|---|---|
| `native` | `contracts/native.mjs`，每个能力自带 `native.run` | 在 Hub 进程内执行，没有外部付费供应商；只读（`readOnly`）。探测会检查 DNS 解析和 RDAP 引导表 |
| `shodan` | `contracts/shodan.mjs` | 调用 api.shodan.io，出口走 System Proxy 的 shodan 绑定（migration 185，7788）；凭据键默认 `shodan`；只读；`minIntervalMs=1100` |

- **只读执行方式失联（D29）**：上游没有后续动作，所以派发途中进程失联的任务记为 failed（`executor_lost`），释放执行槽，不隔离。结果不明的 Shodan 调用（可能已扣查询额度）记为 unknown，但同样不占执行槽。
- **节流**：Shodan 账号限制每秒 1 次。每次调用结束后，把引擎的 `cooldown_until` 往后推 1.1 秒。这个冷却存在 PG 里，所有进程共享，也不写审计记录。被节流的 `/query` 会在 5 秒的等待时间内自动重试认领。

### 11.4 能力项

| 能力项 | 交付包 | 输入白名单 | 实现 |
|---|---|---|---|
| `collect.intel.dns.lookup` | 181 | `name`：公网域名，允许 `_dmarc` 这类下划线标签，支持 IDN，拒绝 URL、IP、单段名和 local/internal/svc 等后缀；`types`（8 种，默认 A、AAAA）；`resolver`：alidns（默认）、dnspod、cloudflare、google | `node:dns` 的 Resolver，必须指定公共解析器，**从不使用宿主机的解析器**（D30），超时 3 秒、重试 2 次。区分 NXDOMAIN、没有记录和查询失败 |
| `collect.intel.rdap.domain` | 180 | `domain` | 通过 IANA 引导表（进程内缓存 24 小时）按最长后缀匹配注册局。重定向只跟到公网 https 域名，最多 2 次，不接受 IP。404 → `no_data`；没有 RDAP 服务的后缀 → 失败；429 → 引擎冷却 |
| `collect.intel.ct.issuances` | 182（按需查询部分） | `domain`、`includeSubdomains`、`maxItems` 1–1000 | SSLMate Cert Spotter `/v1/issuances`，用 `after=` 翻页，最多 10 页；没有凭据时用免费额度，引擎配了凭据就用 Bearer；429 → 引擎冷却 |
| `collect.intel.shodan.host` | 188 | `ip`：只接受公网 IPv4 / IPv6；`history`、`minify` | `/shodan/host/{ip}`，不扣额度 |
| `collect.intel.shodan.search` | 188 | `query`（Shodan 查询语法，1–1000 字）、`facets`、`minify` | `/shodan/host/search`，**只取第 1 页**；带过滤条件时扣 1 个查询额度 |
| `collect.intel.shodan.count` | 188 | `query`、`facets` | `/shodan/host/count`，不扣额度 |
| `collect.intel.shodan.domain` | 188 | `domain`、`type` | `/dns/domain/{domain}`，扣 1 个额度 |

- 7 个都是 candidate，按能力项逐个授权。
- Shodan 的探测（`/api-info`，免费）会显示套餐、剩余查询额度和扫描额度。
- 没有开放的：扫描、告警、Trends，以及搜索第 2 页以后（会额外扣额度）。

### 11.5 验证（2026-11-09，本地）

- **单元测试 10 项（`collect-sync.test.mjs`）**：
  - 各能力的输入校验，包括内网名称和内网 IP 都会被拒绝；
  - DNS：一定使用公共解析器，能区分空记录、NXDOMAIN 和查询失败；
  - RDAP：引导表、最长后缀匹配、重定向限制、429、引导表缓存；
  - 证书透明日志：翻页、条数上限、凭据、429；
  - Shodan 合同：key 在查询参数里且不会出现在结果中，404、401、403、429、应答丢失；
  - `/query`：有空槽时返回 200，重放返回同一结果，异步能力返回 400，没有空槽时退回 202；
  - Shodan 两次连续调用间隔超过 1 秒，且不写冷却审计；
  - 只读任务失联后为 failed，执行槽释放；
  - HTTP 接口：200、缺 `Idempotency-Key` 返回 400、引擎停用返回 503。
- **PostgreSQL 原生测试共 6 项通过**，其中新增一项：三个进程同时认领同一个任务，只有一个成功；节流冷却写入 PG，不写审计，冷却期内不能认领；migration 185 的 shodan 绑定正确。
- **采集相关测试合计 53 项通过**（含微信 16 项）。
- **本地实测**（内存模式 Hub，从这台 Mac 发出的真实只读公开查询）：
  - 探测：DNS 和 RDAP 引导表都正常；
  - `iana.org` 的 DNS 经阿里 DNS，0.5 秒；
  - RDAP 由引导表找到 PIR，1.4 秒；
  - 证书透明日志经 Cert Spotter，2.3 秒；
  - 三个都同步返回 200，任务列表里有记录。
- **没有验证的**：Internal 服务器能否访问这些服务；Shodan 没有用真实 key 调用过。

## 12. 阶段 4：runner 与应用商店

2026-11-09 已实现，未部署。对应 [06](06-platforms-integration-plan.md) 第 8 节。runner 合同在阶段 1 已经定义，这一阶段补上 runner 服务本身，以及 7 个应用市场。

### 12.1 runner 服务（`electron-dock/mx-base/mx-crawler-runner`）

- **技术栈**：Node 22 写成，不依赖任何第三方包。交付包在各自的 Python 环境里运行（阶段 5 起为 3.13，见 13.2；阶段 4 时是 3.11）；Google Play 另外需要 Node 后端。
- **交付包**：
  - 7 个包原样复制在 `packages/` 下。
  - `packages.json` 是审核过的清单。每一项登记：插槽 → 包、允许的 operation、出口策略（`never` / `allowed`）、由 runner 注入的参数（`work_dir`、`runtime_dir`），以及包目录的 sha256。
  - 计算 sha256 时排除 `.venv`、`.runtime` 和 `__pycache__`。
- **安装**（`scripts/install-packages.mjs`）：
  - 先核对每个包的 sha256，再按包自带的 `requirements.lock.txt` 建 Python 环境。lock 内容相同的包共用一个环境：国内 6 家的 lock 完全一样。
  - 使用 `--no-deps`，lock 文件就是完整的依赖集合。
  - Google Play 后端用包自带的安装器执行 `npm ci --ignore-scripts`。
  - 最后跑每个包的离线测试 `test_adapter.py`。
  - 包的源码不 pip install，而是原地导入（`PYTHONPATH=<包>/src`）。195 系列用 `python -m` 启动的 Scrapy 子进程也能找到源码，包目录始终和审核时一致。
- **接口**：

  | 接口 | 行为 |
  |---|---|
  | `GET /v1/health` | 返回协议、版本、容量、运行数，以及每个插槽的可用性和原因（`integrity_mismatch`、`dependencies_not_installed` 等） |
  | `POST /v1/invocations` | 先校验：插槽、operation、保留参数、截止时间、代理是否允许。然后写入记录并 fsync，再启动进程，返回 202。<br>同一个 `dispatchId` 重复提交同样的请求，返回已有状态；请求不同返回 409。包不可用返回 424，容量满返回 429；这两种情况都不登记 |
  | `GET /v1/invocations/{id}` | 返回 `accepted`、`running` 或 `completed`。completed 时带 `envelope`，或者带 `failure.code` |
  | `POST /v1/invocations/{id}/abort` | 停止整个进程组，等进程结束后再应答 |

- **进程**：
  - 每次调用一个进程，自成一个进程组。到截止时间先发 SIGTERM，5 秒后发 SIGKILL。进程结束后，进程组里残留的子进程一并清理，包括 Scrapy worker 和 Node 后端。
  - stdout 上限为 4 MiB − 64 KiB，超过记为 `output_too_large`。
  - stderr 末尾 8 KiB 只写进 runner 自己的日志，并做脱敏处理。
- **子进程环境变量**：只有 `PATH`、`HOME`/`TMPDIR`（都在工作目录里）、UTF-8 设置和 `PYTHONPATH`。不继承 runner 的任何环境变量。只有包允许、且 Hub 传了代理时，才设置 `HTTPS_PROXY`。代理地址不写进记录，也不进日志。
- **重启和保留**：
  - runner 重启时，未完成的记录一律标成 `interrupted`。进程已经随容器结束，Hub 会把这些任务判为普通失败，不收费。
  - 记录和工作目录保留 24 小时，每 10 分钟清理一次。
- **并发**：全局 24 个，每个插槽 4 个，写死在代码里。真正的排队在 Hub 引擎上，所以 Hub 上全部 runner 引擎的执行槽之和不能超过 24（标准配置 18 个引擎 × 1）；超过时，突发请求会被 runner 以 429 拒绝，Hub 把这些任务记为失败（不收费），而不是排队。这个上限原来是 8 个、每个插槽 2 个，上线前的验收脚本跑出了这个问题（见 [上线手册](../../operations/collect-engines-rollout.md)）。
- **配置**：不读任何环境变量。部署时用默认值：`127.0.0.1:18190`、`/var/lib/mx-crawler-runner`、`/run/secrets/mx-crawler-runner/token`。本地运行时用命令行参数覆盖。

### 12.2 部署

- **镜像**（`Dockerfile`）：基于 `python:3.13-slim-bookworm`（阶段 5 起），加上 Node 22 二进制。构建时执行 `lock-packages` 和 `install-packages`，所以每个包的离线测试都在 Linux 上跑一遍；默认用国内镜像源。
- **工作负载**（`deploy/k8s/mx-crawler-runner.yaml`）：
  - 单独一个 Deployment，不在 Hub 的 kustomization 里。Hub 发版不会动它，它也不碰 Launcher、WireGuard、split DNS 等 MX-H2I 的路径。
  - 使用 hostNetwork，只监听 `127.0.0.1:18190`，并用 podAffinity 和 Hub Admin 调度到同一节点。这样 Admin 走回环就能访问 runner，Hub 选出的 `127.0.0.1:7788` 在 runner 这边也指向同一个监听。
- **运行权限和数据**：
  - 进程以 uid 1000 运行，根文件系统只读。
  - 记录放在宿主机 `/var/lib/mx-crawler-runner`；目录由 init 容器 chown，这是唯一一处以 root 运行的操作。
  - token 来自 Secret `mx-crawler-runner-token`。
- **部署命令**：`scripts/deploy.sh all`，依次执行：构建 → 导入 containerd（与 `manage.sh` 用同一个 `run_ctr`）→ 创建 token Secret（只建一次，不打印）→ apply → 健康检查。
- **Hub 侧**：每个交付包一行 runner 引擎：
  - 地址 `http://127.0.0.1:18190`；
  - 凭据键默认 `collect-runner`。runner 引擎的凭据从可选改成了**必填**，因为 runner 拒绝任何不带 token 的请求；
  - 插槽从下拉框里选。

### 12.3 Hub 侧

**`collect.app.details` 按 `market` 路由**，每个市场一个插槽：

| market | 插槽 | 标识 `idKind` | 历史版本 |
|---|---|---|---|
| `xiaomi` | market-195 | `id`（数字） | 无 |
| `vivo` | market-197 | `id` | 无 |
| `tencent`（应用宝） | market-198 | `package` | 无 |
| `baidu` | market-216 | `package` / `pid` / `docid` | 仅限 `pid` |
| `lenovo` | market-217 | `package` | 无 |
| `wandoujia` | market-219 | `id` | 有 |
| `googleplay` | market-193 | `package` | 无；每次只查 1 个应用，另外可传 `country` 和 `lang` |

**国内市场的参数：**

- 每次最多 50 个标识。开启历史版本时最多 10 个，每个最多 5 个版本。
- 标识一律按字符串处理。
- Hub 只传以下参数，`delay` 和单次并发保持交付包的默认值：
  - `max_requests = min(200, 标识数 ×（3 + 历史版本数）)`；
  - `timeout = min(300, 60 + max_requests)`。

**Google Play 的其余 8 个操作**是独立能力，都需要 market-193 插槽的引擎：

| 能力 | operation | 白名单 |
|---|---|---|
| `collect.app.googleplay.search` | `search` | `term`、`num` 1–50、`country`、`lang` |
| `collect.app.googleplay.reviews` | `reviews` | `appId`、`sort`、`maxPages` 1–5、`nextPageToken`、`country`、`lang` |
| `collect.app.googleplay.charts` | `list` | `collection`（TOP_FREE / TOP_PAID / GROSSING）、`category`、`num` 1–100、`country`、`lang` |
| `collect.app.googleplay.developer` | `developer` | `developerId`、`num` 1–100、`country`、`lang` |
| `collect.app.googleplay.suggest` | `suggest` | `term`、`country`、`lang` |
| `collect.app.googleplay.similar` | `similar` | `appId`、`country`、`lang` |
| `collect.app.googleplay.permissions` | `permissions` | `appId`、`country`、`lang` |
| `collect.app.googleplay.datasafety` | `datasafety` | `appId`、`lang`。上游这个页面不保证按地区切换，所以不开放 `country` |

`categories` 在交付方验收时没有取到数据，不开放。所有能力都是 `candidate`，不会自动授权给任何 Key。

**插槽约束。** 能力和路由都登记了自己的插槽。runner 引擎只能承接本插槽的能力，改插槽时也不能留下不匹配的路由；服务端校验，管理台的勾选项也按插槽过滤。

**出口。**

- migration 186 新增 `googleplay` 绑定，默认使用 7788 序列。
- 每次派发时，Hub 用这个绑定的探测策略选一个代理，结果缓存 5 分钟，然后把代理地址放在 `proxyUrl` 里传给 runner。这些都是免费的公开读取，所以允许探测和切换。
- 没有可用代理时，任务记为 `egress_unavailable`，不调用 runner。
- 国内市场永远直连，runner 也会拒绝给它们传代理。

**合同变更：**

| 情况 | 结果 |
|---|---|
| runner 返回了 envelope | 和阶段 1 一样按适配器状态判定 |
| runner 只返回了 `failure`（例如超时、中止、重启） | failed，错误码为 `runner_<code>`，不收费，释放执行槽 |
| 424 包不可用 / 404 未知插槽 | failed，错误码为 `runner_package_unavailable` / `runner_slot_unknown`，未开始执行 |
| 超过截止时间 | 调用 abort。runner 确认已停止时记为 failed，否则保持 unknown |
| 探测 | runner 健康，**并且**本引擎的插槽可运行，才算健康 |

另外修正：条数统计改为读取 SDK 结构 `result.data.items`。

### 12.4 验证（2026-11-09）

- **runner 单元测试 18 项**（`npm test`）：
  - 计算 sha256 时会忽略安装产物，交付包被改动后会被拒绝；
  - 拒绝越界的清单；
  - 重复提交和冲突；
  - 子进程拿不到 token，只在允许时才有代理；
  - 不合法的请求都不会登记；
  - 输出无法解析、进程崩溃、输出超限；
  - 截止时间一到，连同子进程整组停止；
  - 中止要等进程结束才确认；
  - 全局容量和每个插槽的容量；
  - 重启后记为 interrupted；
  - 清理；
  - 日志里的代理密码已脱敏；
  - 以相对路径启动时，工作目录仍是绝对路径；
  - HTTP 鉴权、413，以及完整的调用往返。
- **Hub `collect-runner.test.mjs` 10 项**：
  - 7 个市场的输入规则；
  - Google Play 9 个操作的映射和拒绝规则；
  - 插槽约束和出口状态；
  - 只给 Google Play 传代理，绑定失效时不调用 runner；
  - runner 的各种结束方式都不占用执行槽；
  - 截止时间中止；
  - 探测要求插槽可用；
  - 代理选择器的探测、缓存和失败；
  - **端到端**：Hub 执行器经 HTTP 调用真实的 runner 代码，再到测试包。
- **原有采集测试 37 项**（阶段 1–3）经过修订后全部通过。修订原因：runner 合同改为必须带 token、Xiaomi 的参数和健康检查返回的插槽列表都变了。
- **在 macOS 上安装 7 个包**：每个包 10 项离线测试都通过，包括 Google Play 的 `npm ci`。
- **Linux 镜像**：在本机 Docker 上构建，arm64，约 452 MB。
  - 构建过程中核对了 sha256，7 个包的离线测试每个 10 项都通过（Google Play 含 `npm ci`）。
  - 容器按 k8s 的方式运行：只读根文件系统、uid 1000、去掉全部 capabilities。启动后 7 个包都可运行，用小米真实查询了一次 QQ（4.6 秒，success）。
  - Internal 是 amd64，部署时要在那边重新构建。
- **PostgreSQL 原生测试 6 项通过**：在一次性数据库上应用了 migration 186，`googleplay` 绑定和 shodan 一样指向 7788 序列。
- **全量服务端测试**：失败 63 项，和干净的 HEAD 完全相同，没有新增失败。管理台生产构建通过。
- **本地联网实测**：内存模式的 Hub → 本地 runner → 真实的公开页面，每个市场查 1 个应用。

  | 市场 | 结果 |
  |---|---|
  | 小米 | QQ 9.3.75 |
  | vivo | QQ 9.3.80 |
  | 应用宝 | QQ 9.3.80 |
  | 百度 | QQ 9.3.80 |
  | 联想 | QQ 9.3.80 |
  | 豌豆荚 | 没测成：这台 Mac 把 `www.wandoujia.com` 解析成 127.0.0.1，属于本机 DNS 问题，不是包的问题。任务按 `adapter_error` 失败，没有占用执行槽 |
  | Google Play | 没测：本机没有可用的海外代理 |

  每个任务约 11 秒。

## 13. 阶段 5：单链接详情补全与子域名

2026-11-09 已实现，未部署。对应 [06](06-platforms-integration-plan.md) 第 9 节。

### 13.1 范围和调整

| 交付包 | 处理 |
|---|---|
| 94 Pinterest、96 Medium、98 Snapchat、101 Dailymotion、104 Kick、105 Substack、107 WordPress.com | 接入 runner，对外合并成一个能力 `collect.web.url.details` |
| 182 subfinder | **改成 Hub 原生实现** `collect.intel.subdomains`。交付配置只启用了 crt.sh 一个数据源，本质就是查证书透明日志。原生实现同时查 Cert Spotter 和 crt.sh，不需要 40 MB 的 Go 二进制，也不需要放开到 crt.sh 的 PostgreSQL 5432 出口（D38） |
| 100 Mastodon | **暂不接**。适配器把要查的账号写死成 `Mastodon`、帖子写死 2 条，只能拿到实例信息和这一个账号，做不成「实例、账号、帖子」的通用能力。以后需要时，用 Mastodon 公开 REST API 在 Hub 原生实现；但实例地址是任意主机，必须先做公网 IP 校验（D39） |

### 13.2 runner 侧

- **上游库**：7 个包原本自带完整的上游仓库，含 `.git`，共约 170 MB；Snapchat、Dailymotion、Kick 用的是同一份 yt-dlp。现在只收上游的导入包，按审核时的 commit 用 `git archive` 取出，放在 `upstream/<名称>@<commit 前 12 位>/`，附 LICENSE 和 `SOURCE.json`；同一份上游只放一次。

  | 上游 | commit | 许可证 | 文件数 |
  |---|---|---|---|
  | yt-dlp | `bbc809a1161d` | Unlicense | 1053（Snapchat、Dailymotion、Kick 共用） |
  | gallery-dl | `2adf2a8e0041` | GPL-2.0 | 314 |
  | medium-scraper | `9cf365c5c052` | MIT | 16 |
  | substack-api | `714f4e564786` | MIT | 11 |
  | blog2epub | `97ab6fe30793` | MIT | 35 |

  - 不构建、不安装这些上游，运行时把目录接在包源码后面加进 `PYTHONPATH`。
  - `packages.json` 里每个上游都登记了 sha256。上游被改动后，只有用到它的包会变成不可用（`upstream_mismatch:<id>`）。
  - 重新取上游用 `scripts/vendor-upstream.mjs`，它会核对 checkout 的 HEAD 是否就是审核过的 commit。
- **WordPress 的依赖**：107 的 lock 里有 Kivy、pywin32、pyjnius 等 GUI、Windows 和 Android 专用包，在 Linux 上装不上；采集路径也从不导入它们（只有 `blog2epub_gui.py` 用）。所以单独用 `overrides/107/requirements.linux.txt`：只删掉这 15 个包，其余版本一个不改。文件头写明了删掉的清单。
- **Python 3.13**：Substack 的上游要求 Python ≥ 3.12，交付方所有包都是在 3.13.3 上验收的，所以镜像从 3.11 改成 `python:3.13-slim-bookworm`。本机用 uv 自带的 3.13，第 12 节的 7 个包也在 3.13 上重新跑过离线测试。
- **安装时的导入检查**：交付包自带的离线测试会 mock 掉 SDK，测不到上游库，所以 `install-packages` 还会用该包的 Python 环境 import 一遍每个上游。lock 里缺依赖时，在构建阶段就会失败。
- **字节码**：镜像构建时用 `compileall --invalidation-mode checked-hash` 预编译。根文件系统只读，不预编译的话，yt-dlp 每次调用都要重新编译约 1000 个模块。`__pycache__` 不计入 sha256。
- **脱敏**：有几个包会把 worker 的 stderr 原样抄进结果（`diagnostics` 字段）。现在 runner 对适配器的 stdout 也做脱敏：代理的完整地址、`host:port` 和密码都会替换掉，结果不会把代理地址带回 Hub。

### 13.3 能力 `collect.web.url.details`

**输入**只有 `url`，必须是 https，不能带账号密码或端口，长度不超过 2000。Hub 按主机名自动路由到对应的包，调用方不用传站点：

| site | 接受的链接 | 插槽 | 结果 |
|---|---|---|---|
| `pinterest` | `(www.\|xx.)pinterest.<常见后缀>/pin/<id>`、`pin.it/<code>` | pinterest-94 | Pin 元数据和媒体地址；不含图板和主页 |
| `medium` | `medium.com/@作者/标题-<十六进制 id>`、`medium.com/p/<id>`、`<作者>.medium.com/…-<id>` | medium-96 | 标题和 Markdown 正文 |
| `snapchat` | `www.snapchat.com/spotlight/<id>` | snapchat-98 | 视频元数据和媒体地址（不下载） |
| `dailymotion` | `www.dailymotion.com/video/<id>`、`dai.ly/<id>` | dailymotion-101 | 同上 |
| `kick` | `kick.com/<频道>?clip=clip_…`、`/<频道>/clips/clip_…`、`/<频道>/videos/<uuid>` | kick-104 | 同上。直播频道不接受，交付方从未验收过 |
| `substack` | `<名称>.substack.com` 站点根地址 | substack-105 | 最新 2 篇的元数据，加第一篇正文 |
| `wordpress` | `<名称>.wordpress.com` 站点根地址 | wordpress-107 | 最多 2 篇文章或页面，HTML 需要清洗 |

**链接的处理：**

- 去掉 fragment 和查询参数，只有 Kick 保留 `clip`。站点根地址去掉末尾的 `/`，因为库会自己拼接路径。
- **不接受自定义域名**（例如 Substack、Medium 绑定在自己域名上的出版物）。runner 和 Hub 在同一节点的网络里，不能拿任意主机给它去请求（D37）。
- 已知的局限：主机名白名单只管第一跳。库在请求过程中跟随的重定向不受这个限制，但所有请求都走海外代理出口。

**调用 runner 时**只传 `{target, timeout: 110}`，`work_dir` 由 runner 注入。

**出口：**

- 7 个插槽共用一条新绑定 `overseas`（migration 187，默认使用 7788 序列）。
- 探测地址是中性的 `https://www.gstatic.com/generate_204`。
- Hub 选好代理后，每次调用时传给 runner（与 D34 相同）。

**条数**按各包的结果结构统计：Pinterest 数媒体消息，Medium 和视频站有结果算 1 条，Substack 数文章，WordPress 数文章。适配器报告失败时为 0 条。

### 13.4 能力 `collect.intel.subdomains`（Hub 原生，同步）

- **输入**：
  - `domain`：拒绝内网后缀；
  - `sources`：默认 `certspotter` 和 `crtsh` 两个都查；
  - `maxIssuances`：10–1000，默认 500，是 Cert Spotter 读取的签发条数上限。
- **查询方式**：两个来源并行查询。
  - Cert Spotter 复用阶段 3 的实现，带 `include_subdomains` 参数，最多读 10 页。
  - crt.sh 查询 `%.<domain>`，带 `deduplicate=Y`，超时 45 秒，最多读 4 MiB；超过时这个来源记为失败。
- **汇总**：
  - 只保留 `domain` 本身或它下面的名称，去掉 `*.` 并记为通配，同一张证书里重复的名称只计一次。
  - 每个名称给出来源、证书数，以及最早签发时间和最晚到期时间。
  - 最多返回 5000 个名称。
- **结果判定**：
  - 一个来源失败或被截断，记为 `partial`；
  - 两个来源都失败，记为 failed，不收费。如果是 Cert Spotter 限流，引擎进入冷却。
- **只访问证书透明日志服务**，从不连接目标域名本身的主机。

### 13.5 测试

- **runner 单元测试 19 项**，新增：
  - 上游登记、哈希校验，改动后精确禁用依赖它的包；
  - 清单不能越界；
  - `PYTHONPATH` 中上游目录排在包源码之后；
  - 适配器输出里的代理地址已脱敏。
- **Hub `collect-web.test.mjs` 7 项**：
  - 每个站点接受和拒绝的链接，包括自定义域名、直播频道、端口、账号密码、相似域名欺骗；
  - 各包的条数统计；
  - 按链接路由，并且每次都带 `overseas` 代理；
  - 插槽错配会被拒绝；
  - 子域名两个来源的合并、只保留域名下的名称、通配、同一证书去重、一个来源失败时为 partial、两个都失败时为 failed 并冷却、输入边界；
  - `overseas` 选择器通过绑定的代理探测 gstatic。
- **采集相关测试合计 81 项**：70 项通过，另有 11 项是需要 PostgreSQL 的原生测试，没有数据库时跳过。
- **PostgreSQL 原生测试 6 项通过**，已应用 migration 187，`overseas` 绑定和 shodan、googleplay 一样指向 7788 序列。
- **在 macOS 上安装**：14 个包在 Python 3.13 上离线测试全部通过，7 个上游都能 import。

### 13.6 本地联网实测（2026-11-09）

内存模式的 Hub → 本地 runner → 公开页面，链接都是交付方验收时用的那条。本机直连，没有代理。

| 能力 / 站点 | 结果 | 说明 |
|---|---|---|
| 子域名 `iana.org` | ✅ 200，25 个名称 | 两个来源都成功：Cert Spotter 33 张证书，crt.sh 207 张；用时 20–31 秒，主要花在 crt.sh |
| Pinterest | ✅ success | Pin 元数据和媒体消息 |
| Dailymotion | ✅ success | NASA TV，媒体格式 |
| Kick | ✅ success | 剪辑「Maddy detains Abd D:」 |
| WordPress.com | ✅ success，2 篇 | 19thcentury.wordpress.com |
| Medium | ❌ 交付包缺陷 | medium-scraper `9cf365c` 在退出时调用 `AsyncSession.aclose()`，但锁定的 curl_cffi 0.16.3 只有 `close()`。每次调用都是取完页面后报错。需要交付方修复，我们不改审核过的代码 |
| Snapchat | ❌ 上游失效 | 页面还在，但 Snapchat 已经不再嵌入 Next.js 数据。审核时的 yt-dlp 和最新 nightly（2026-09-27）都报「Unable to extract next.js data」。等 yt-dlp 修复后升级上游并重新审核 |
| Substack | ❌ 上游失效 | Substack 的 archive 接口现在拒绝 `offset=0`（返回 400「Invalid value」），所有 newsletter 都这样。审核时的 substack_api 和最新的 1.3.2 都会传这个参数 |

三个失败的任务都正常结束：failed、不收费、执行槽释放。本地实测中还发现并修正了一个问题：站点根地址原来带末尾的 `/`，Substack 库会拼出 `//api`。

**Linux 镜像**：在本机 Docker 上重新构建，arm64，Python 3.13，约 652 MB。

- 构建过程中核对了 sha256，14 个包的上游 import 和离线测试全部通过。
- 容器按 k8s 的方式运行（只读根文件系统、uid 1000、去掉全部 capabilities），14 个包都可运行：

  | 站点 | 结果 |
  |---|---|
  | Kick | 成功，1.5 秒。字节码已预编译，比 Mac 上的 2.1 秒快 |
  | 小米 | 成功 |
  | Dailymotion | **在容器里失败**。令牌和元数据都取到了，但取 m3u8 播放列表时 CDN 返回 403，换 Chrome、Firefox 指纹重试也是 403。同一时间在 Mac 上第一次就成功；容器里 curl_cffi 正常加载，版本也在 yt-dlp 支持的范围内（0.10–0.16） |

- Dailymotion 的差异只出现在拿签名媒体地址这一步，像是和网络路径或 TLS 栈有关。要在 Internal 上经 7788 实测确认，在此之前不要给 Key 授权。
- Internal 是 amd64，部署时要在那边重新构建。

## 14. 阶段 6：音频（节目与单集）

2026-11-09 已实现，未部署。对应 [06](06-platforms-integration-plan.md) 第 10 节。

### 14.1 范围和调整

| 交付包 | 处理 |
|---|---|
| 45 小宇宙、46 喜马拉雅、220 Apple Podcasts、222 LibriVox | 接入 runner，只开放 `discover`（找节目）和 `collect`（单集元数据和音频地址） |
| 221 Podcast Index | **等凭据**：需要 `PODCAST_INDEX_KEY` / `SECRET`。runner 目前不往子进程传任何凭据；有了凭据再设计传递方式（D44） |
| 下载、`list_records`、`stats` | **不开放**。下载要等 mx-static；另外两个只在持久的 `run_dir` 里才有意义 |

**和原计划的区别：不挂持久卷（D42）。** 交付包确实有状态：`discover` 把节目写进 `run_dir` 下的 SQLite，`collect` 再从里面读。但只取元数据和音频地址时，不需要跨调用的状态：

- 每次调用用一个新的 `run_dir`，`discover` 和 `collect` 在同一次 runner 调用里先后执行（见 14.2）。
- 增量去重放在 Hub 侧做。
- 持久卷等做下载时再加，那时 `list_records`、`download` 才有用。

### 14.2 runner：一次调用多个步骤（D41）

- **请求格式**：请求可以用 `steps: [{operation, params}, …]`（1–4 步）代替 `operation` + `params`。
  - 每一步都按清单检查：operation 必须在白名单里，不能带保留参数。
  - 请求哈希覆盖全部步骤：同一个 `dispatchId` 换了步骤会返回 409。这个问题是新测试抓出来的：哈希函数原来只取 `operation` 和 `params`。
- **执行**：
  - 各步骤按顺序执行，每步一个进程，共用同一个工作目录。新增可注入参数 `run_dir`，由 runner 指向 `<工作目录>/data`。
  - 前一步的结果是 `success` 或 `partial` 才执行下一步。`no_data`、`error` 或 runner 侧失败都会在这一步结束。
  - 所有步骤共用一个截止时间。
- **结果**：
  - 顶层的 `envelope` 和 `failure` 永远是最后执行的那一步。
  - `steps` 列出每一步的 operation、状态、用时，以及最后一步以外各步的结果外壳。
  - Hub 按最后一步判定结果，结果里保存每一步的外壳。如果前面某一步是 `partial`、最后一步是 `success`，整体记为 `partial`。
- **单步请求**：格式和结果与之前完全相同。

### 14.3 能力项

两个能力都按 `platform` 路由，都是候选：

| 能力 | runner 调用 | 上限 |
|---|---|---|
| `collect.audio.shows` | `discover` | 最多 20 个节目 |
| `collect.audio.episodes` | `discover` → `collect`（两步，`feed_limit` 等于节目数） | 最多 10 个节目 × 每个 50 集（`episodesPerShow` 默认 10） |

各平台的输入：

| platform | 插槽 | 输入 | 出口 |
|---|---|---|---|
| `xiaoyuzhou` | xiaoyuzhou-45 | `podcastIds` 或 `episodeIds`（二选一），24 位十六进制 | 直连 |
| `ximalaya` | ximalaya-46 | `trackIds`：十进制声音 ID，同一专辑的会合并成一个节目。`collect` 不探测相邻 ID（`probe_range=0`） | 直连 |
| `apple` | applepodcasts-220 | `mode=search` 时用 `keyword`；`mode=charts` 时用 `genreId`（整数）。`country` 默认 us；`limit` | `overseas` |
| `librivox` | librivox-222 | `offset`、`limit`（书目分页） | `overseas` |

- **ID 必须填写**：小宇宙和喜马拉雅的包在没收到 ID 时会悄悄用内置的样例节目，所以 Hub 一律要求提供 ID（D43）。
- **超时**：`discover` 的 `total_timeout` 为 120 秒，`collect` 为 300 秒，请求间隔保持交付包默认的 2 秒。
- **条数**：按最后一步的 `items` 计。
- **不会访问内网**：交付包的网络层会拒绝解析到内网地址的目标，重定向之后也同样检查。

### 14.4 测试

- **runner 单元测试 21 项**，新增：
  - 多步骤共用 `run_dir`，后一步读到前一步写入的状态；
  - `no_data` 时不再执行下一步；
  - 多步骤的重放与冲突；
  - 每一步都按清单检查，包括操作白名单、保留参数、步骤数和字段。
- **Hub `collect-audio.test.mjs` 5 项**：
  - 4 个平台的输入规则，以及不允许使用样例 ID；
  - 两步映射和上限；
  - 直连和 `overseas` 出口；
  - 合同按步骤发送，判定看最后一步，前一步 partial 时整体为 partial，`discover` 无数据时结束；
  - **端到端**：Hub 经 HTTP 调用真实的 runner 代码，确认两步用的是同一个 runner 自有的 `run_dir`。
- **在 macOS 上安装 4 个包**：离线合同测试在 Python 3.13 上全部通过，分别为 31、31、30、30 项。4 个包的 lock 相同，共用一个 Python 环境。

### 14.5 本地联网实测（2026-11-09）

内存模式的 Hub → 本地 runner → 公开页面、接口和 RSS，用的是交付方验收时的目标。本机直连。

| 用例 | 结果 |
|---|---|
| 小宇宙节目（忽左忽右） | ✅ 1 个节目 |
| 小宇宙节目 + 3 集 | ✅ discover → collect，3 集 m4a 地址 |
| Apple 搜索「BBC Minute」+ 每个节目 3 集 | ✅ 3 集（BBC Just a Minute 的 RSS） |
| Apple 榜单 1318 | ✅ 3 个节目 |
| LibriVox 2 本书 + 每本 3 章 | ✅ 6 章（archive.org mp3）。交付方自己验收时这一步是 `no_data` |
| 喜马拉雅声音 3558286 + 3 集 | ❌ `discover` 失败：喜马拉雅的 baseInfo 接口对这台 Mac 返回 `ret 999`「操作过于频繁，请稍后再试」，单独用 curl 请求一次也是这样。这是平台的反爬限制，不是我们的代码问题；要在 Internal 上复测 |

每次调用约 3 秒。失败的那个任务按 `adapter_error` 失败，不收费，执行槽已释放。

**Linux 镜像**：在本机 Docker 上重新构建，arm64，Python 3.13，约 712 MB。

- 构建时 18 个包的离线测试全部通过。
- 容器按 k8s 的方式运行（只读根文件系统、uid 1000、去掉全部 capabilities），18 个包都可运行：
  - 小宇宙两步调用：discover → collect，3 集，2.0 秒；
  - LibriVox 两步调用：3 章，2.6 秒；
  - 喜马拉雅：在同一出口 IP 上同样返回 `ret 999`。
- Internal 是 amd64，部署时要在那边重新构建。

## 15. 待办与后续

上线步骤、验收脚本 `scripts/collect-acceptance.mjs` 和回滚方法见 [采集引擎上线手册](../../operations/collect-engines-rollout.md)。

| 事项 | 说明 |
|---|---|
| 部署 | 发布 migration 183、184 和 Hub 镜像。部署后没有任何引擎，对外接口对能力返回 `capability_not_routed`，不影响现有接口 |
| 阶段 2 联网验收 | 在引擎页录入 Apify token → 探测（Q9）→ 在 Apify 页面查清三个 Actor 的计费方式（Q10）→ 每个能力各跑一次小量运行，例如 Temu `maxItems=10` → 核对结果、成本和出口 → 再逐个 Key 授权 |
| 2b 联网验收 | 5 个电商能力各跑一次最小量，例如 `maxItems` 取最小值：核对结果字段、成本、站点和币种。Amazon 和 Shopee 的链接模式各补测一次 |
| 阶段 3 部署验收 | 发布 migration 185；在 Internal 上建 native 引擎并探测（确认宿主网络能访问公共 DNS、IANA、RDAP 注册局和 Cert Spotter）；录入 Shodan key 并探测，看套餐和额度；各做一次查询 |
| 2c 联网验收 | 9 个能力各跑一次最小量。重点看 Craigslist 的 `maxItems` 是否真的限制了计费条数，以及 Companies House 返回里有没有个人数据字段 |
| 阶段 4 部署验收 | 1. 发布 migration 186 和 Hub。<br>2. 在 Hub 节点上执行 `scripts/deploy.sh all`。镜像要在 Internal（amd64）上重新构建，本地验证的是 arm64。<br>3. 在 Hub 建 7 行 runner 引擎，录入 token 并探测。<br>4. 每个市场查 1 个应用（重点补测豌豆荚）。<br>5. Google Play 经 7788 的 9 个操作各查一次。<br>6. 之后再逐个 Key 授权 |
| Python 依赖哈希 | 现在依赖只锁版本，交付包源码有 sha256。可以在 Linux 上用 `pip download` 生成 `--require-hashes` 用的锁文件 |
| 统一应用结构 | 把 7 个市场的 `app` 字段映射成统一的应用快照（`market + app_id`，用 `version_code + observed_at` 区分快照），作为可选的规范化视图 |
| 统一商品结构 | 把电商能力的结果映射到 `products/search` 的统一结构，作为可选的规范化视图，原始结果外壳继续保留 |
| 阶段 5 部署验收 | 1. 发布 migration 187 和 Hub。<br>2. 在 Internal 上重新构建 runner 镜像。<br>3. 建 7 行 URL 引擎和 native 引擎。<br>4. 经 7788 对每个站点做一次查询。<br>5. Medium 等交付方修复 `aclose`；Snapchat、Substack 等上游修复后升级再审核 |
| 上游更新 | yt-dlp、gallery-dl 更新很频繁。升级的步骤：用 `vendor-upstream.mjs` 取新的 commit → `lock-packages --write` → 跑离线测试 → 联网验收 |
| 阶段 6 部署验收 | 1. 在 Internal 上重新构建 runner 镜像，建 4 行音频引擎。<br>2. 每个平台各做一次节目查询和单集查询；Apple、LibriVox 经 7788。<br>3. 重点复测喜马拉雅：确认 `ret 999` 是否只针对本机 IP |
| 音频下载 | 等 mx-static 上线。届时再给 runner 加持久卷，开放 `download`、`list_records`，并制定文件保留和容量策略 |
| Podcast Index | 拿到凭据后，设计 runner 按调用传递凭据的方式（只传给声明了需要凭据的包） |
| 微信迁入 | 把 Night-All 微信写成一个 `sync` 合同，再把 migration 165 的数据迁到 `collect`。在此之前两套并存，互不影响 |
| 公共文档 | `/docs` 里还没有 collect 接口的说明，等第一个能力验收通过时补 |
| 价格 | 能力的价格模板和产品条目等计费开启时再定 |
