# 07 通用采集引擎（阶段 1）

**活文档。** 这是 [06 接入计划](06-platforms-integration-plan.md) 阶段 1 的设计和实现记录，后续阶段（Apify、runner、应用商店……）都挂在这套骨架上，改动要同步更新本章。

最后更新：2026-11-09。状态：阶段 1 和阶段 2（Apify）**已实现未部署**（本地未提交）。

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
- **没有做的**：没有用真实 token 调用 Apify，也没有跑任何 Actor。三个 Actor 的价格模型仍未知。

## 11. 待办与后续

| 事项 | 说明 |
|---|---|
| 部署 | 发布 migration 183、184 和 Hub 镜像。部署后没有任何引擎，对外接口对能力返回 `capability_not_routed`，不影响现有接口 |
| 阶段 2 联网验收 | 在引擎页录入 Apify token → 探测（Q9）→ 在 Apify 页面查清三个 Actor 的计费方式（Q10）→ 每个能力各跑一次小量运行，例如 Temu `maxItems=10` → 核对结果、成本和出口 → 再逐个 Key 授权 |
| 阶段 2b / 2c | 按 06 的顺序继续加能力项：Amazon、AliExpress、Shopee、eBay、Etsy……每个都要写输入白名单、固定版本，并做一次联网验收 |
| 阶段 4 | 实现 mx-crawler-runner 并做 195 联网验收，之后再给 Key 授予 `collect.app.details` |
| 微信迁入 | 把 Night-All 微信写成一个 `sync` 合同，再把 migration 165 的数据迁到 `collect`。在此之前两套并存，互不影响 |
| 公共文档 | `/docs` 里还没有 collect 接口的说明，等第一个能力验收通过时补 |
| 价格 | 能力的价格模板和产品条目等计费开启时再定 |
