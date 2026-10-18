# V2-5：调用方契约——调用方 / 配额 / 公平、Job API v1、长轮询、回调、结果 Schema、作用域状态流与嵌入路由

日期：2026-10-18。依据 [2.0 方案](device-center-v2-plan-2026-10-15.md) §6.2、§6.3、§10、§10.1、§11.7 实施，只改 mx-device。**没有部署 18891，没有迁移线上库，没有连接手机、PoC、ADB 或 VPN**，不影响 MX-H2I 登录与联网。前置内容见 [V2-4 工作台 2.0](v2-4-workbench-2-2026-10-18.md)。

## 1. 结论

- **调用方**：新增迁移 `014_clients_outbox.sql`（`clients`、`client_usage`、`outbox` 三张表和一个按调用方查任务的索引）。每个调用方一个 API 密钥 `<调用方 ID>.<随机串>`，中心只存 SHA-256 摘要。调用方带作用域（允许的等级、App、模板、机架）、配额（排队上限、并发上限、每分钟提交数加突发量）、公平权重、允许的回调来源和嵌入范围。管理台新增「调用方」页面。目前只开放模拟模式。
- **公平**：按方案 §6.3 实现 EEVDF 式加权公平。领取时按预计耗时记账，会话结束后按实测设备耗时修正。调用方重新活跃时不能拿空闲期攒下的额度。三个等级严格优先，等待超时只提升一级、只提升一次；批量等级保底 10% 设备时间。**队列里没有调用方任务时，排序与以前完全相同**（有逐项比对的测试）。
- **Job API v1**：
  - 提交：`POST /v1/jobs`。按 `clientRequestId` 幂等；超出配额返回 429 和 `Retry-After`；截止时间不可行返回 422 和 `predictedFinishAt`，此时不入队。
  - 查询：`GET /v1/jobs/:id`，返回状态、可读的等待原因、预计时间、进度和 v1 结果。
  - 同步：`GET /v1/jobs/:id/wait?timeout=25` 长轮询。
  - 取消：`POST /v1/jobs/:id/cancel`。排队中的任务立即取消；运行中的任务在下一个安全点停止，不会打断在途指令。
  - 模板：`GET /v1/templates`，返回参数 Schema 和结果 Schema。
- **回调**：任务结束的同一个事务里写入 outbox 记录，提交后再投递。投递带 HMAC 签名和投递 ID，失败按指数退避重试，12 次后放弃，管理员可以手动重试。只向调用方允许的来源发送，不跟随重定向。
- **作用域状态流与嵌入**：
  - `GET /v1/stream?scope=client|ops`：与工作台同源的 SSE 流。
  - `/embed/*`：供 Hub 后端反向代理的只读工作台。ops 作用域是完整工作台的只读版；client 作用域只显示本调用方的任务和设备池汇总。
  - 浏览器只持有 Hub 自己的会话，不接触 mx-device 凭证。
- **端到端验收**：`npm run dev:sim -- --hub` 启动一个模拟 Hub。它反向代理两种作用域，每 6 秒通过 Job API 提交一个任务（三分之二带回调异步，三分之一用 `/wait` 同步），并校验回调签名。浏览器验收见 §8。
- **测试**：`npm run test:pg` **270 项全部通过**（V2-4 后为 257 项）。新增 `tests/clients.test.mjs`（12 项）和 `tests/clients-pg.test.mjs`（PostgreSQL 上两个调用方、回调与并发领取投递）。

## 2. 调用方与配额

| 字段 | 说明 |
| --- | --- |
| 密钥 | `<uuid>.<43 位 base64url>`。中心只存 `keyHash`；创建或轮换时只显示一次，旧密钥立即失效。请求按前缀只加载这一行，常数时间比较摘要 |
| 回调签名密钥 | 用于计算 `X-MX-Signature`，必须保存原文才能签名。只在创建或轮换时显示一次，任何视图和事件里都不出现 |
| 状态 | `active` / `disabled`。停用后拒绝新请求（403）；已提交的任务照常执行 |
| 作用域 | `classes`（默认标准 + 批量）、`apps`、`templates`、`racks`；空列表表示不限 |
| 配额 | `maxQueued`（默认 200）：排队任务上限，超出返回 429。`maxInflight`（默认 20）：同时执行上限，领取时为硬约束，规划器按"执行中 + 已计划"计数。`ratePerMinute` / `burst`（默认 120 / 30）：令牌桶，只在提交被接受时消耗 |
| 权重 | 0.1–100，默认 1 |
| 回调来源 | 完整来源，例如 `https://hub.internal:8443`。提交的回调地址和实际投递都必须匹配其中之一 |
| 嵌入 | `none` / `client`（默认）/ `ops`：此调用方可以打开的最大作用域 |

管理接口（登录会话或管理员令牌，`mode=sim`）：`GET/POST /api/clients`、`POST /api/clients/:id`（`revision` 校验；可改配置、`status`、`rotateKey`、`rotateCallbackSecret`）、`GET /api/clients/:id/deliveries`、`POST /api/outbox/:id/retry`。

## 3. 公平排序

```text
领取（域事务，调用方行已加载）：V_c += est / w_c；会话记下 {clientId, class, estimateMs, weight}
会话结束（按行事务，不锁调用方行）：追加 usage 行 {deltaMs = 实测 − 预估}
下一个域事务：DELETE … RETURNING 取出 usage 行，V_c += deltaMs / w，按等级累计服务时间
系统虚拟时间 V = 有排队任务的调用方 V_c 的加权平均
提交时调用方从无活动任务变为有：V_c = max(V_c, V)
每个等级内：按"虚拟截止时间 V_c + est/w_c"最小者取下一个任务（只在 V_c ≤ V + 120 秒的调用方中选，都不满足时不受此限）
调用方内部：截止时间早者优先 → 短任务优先 → 先到先得
```

- **等级**：interactive / standard / batch 映射到原 1–9 优先级的 2 / 5 / 8，等级之间严格优先。等待超过本等级的 `maxWait`（30 秒 / 2 分钟 / 10 分钟）时提升一级，只提升一次。原有"5 分钟防饿死提到最前"只作用于非调用方任务。
- **批量保底**：所有调用方近 5 分钟（指数衰减）的服务时间中，批量占比低于 10% 且有批量任务排队时，批量任务本轮排到最前，占比回到 10% 以上就恢复原等级。近期服务总量不足 60 秒时不触发。
- **非调用方任务**（管理台、演示）作为一个权重为 1、虚拟时间固定为 V 的参与者，内部顺序与以前相同。
- **实现位置**：`server/fairness.mjs` 的 `orderJobs` 替换了领取、规划器、调度快照和检查点插入四处的 `sort(compareJobs)`。同一轮领取只排一次序，之后的领取只跳过已领走的任务。2000 个排队任务、3 个调用方时，一次排序约 1.2 ms（原排序约 0.2 ms）。
- **测试**：权重 1:3 时前 40 个约为 10:30；截止时间优先；等级严格；超时提升；虚拟时间领先过多的调用方让路；批量保底触发与解除；领取记账与按实测修正（9 秒、权重 2 → 4500）；`maxInflight` 让出设备给其他任务。

## 4. Job API v1

鉴权：`Authorization: Bearer <API 密钥>`，请求体 JSON。所有接口只读写本调用方的数据，查看别人的任务返回 404。

| 接口 | 说明 |
| --- | --- |
| `GET /v1/templates` | 本调用方可用的模板，各取最新未归档版本：`{template, version, name, appId, loop, steps, estimateMs, params, resultSchema}`，另有允许的 `classes` |
| `POST /v1/jobs` | 请求体为 `{clientRequestId, template, version?, params:{keyword?, target?}, class?, deadlineAt? 或 ttlMs?, rack?, callback?:{url}}`。新建返回 202，同一 `clientRequestId` 重放返回 200 和原任务（`replayed: true`），同一 ID 内容不同返回 409。模板、等级、App、机架、回调来源超出作用域返回 403。排队或速率超限返回 429 和 `Retry-After`。截止时间不可行返回 422，带 `predictedFinishAt` 与 `predicted`，此时什么都不入队。`freshnessMs` / `shareable` 返回 400（Q4 未确认） |
| `GET /v1/jobs?status=active&limit=50` | 本调用方最近的任务（走 `jobs_by_client` 索引），不带结果 |
| `GET /v1/jobs/:id` | 任务视图（见下）。重复查询不会操作手机 |
| `GET /v1/jobs/:id/wait?timeout=25` | 任务结束或超时（≤ 25 秒）即返回任务视图，另带 `waitedMs` 和 `timedOut`。所有等待者共享一条状态查询（每 500 ms），本进程有写入时立即检查 |
| `GET /v1/jobs/:id/result?offset=&limit=` | 结果大于 200 条时分页取全部列表项 |
| `POST /v1/jobs/:id/cancel` | 返回 `{status: cancelled}`、`{status: stopping}`，或已结束时返回 `{final: true}` |
| `GET /v1/stream?scope=client|ops`、`GET /v1/state?scope=` | 作用域状态流与轮询（§7） |

任务视图 `{jobId, clientRequestId, template, class, status, final, createdAt, startedAt, completedAt, deadlineAt, predicted, blockers, queuePosition, progress:{completedSteps, steps}, reason, result}`：

- **status**：
  - 进行中：`queued`、`planned`（软计划已排到设备）、`running`、`stopping`；
  - 已结束：`succeeded`、`failed`、`unknown`（结果待核验，不自动重试）、`cancelled`、`expired`、`blocked`、`skipped`。
- **predicted**：
  - 有软计划时取计划的开始和完成时间（`source: plan`）；
  - 否则按估算（`source: estimate`）：排在它前面、能在同一批设备上执行的工作量，加上这些设备上在途会话的剩余时间，再均摊到设备数。估算不计节奏冷却，所以偏早。
  - `confidence` 为 high / medium / low / none。
- **截止时间**：
  - `deadlineAt`（或 `ttlMs`）在提交时做可行性检查；
  - 到期仍未绑定设备的任务在下一轮领取前转为 `expired`，不操作手机，并照常回调。
- **取消**：
  - 停在检查点的会话直接结束；
  - 由 Agent 执行的会话沿用 V2-3 的安全点停止；
  - 中心进程执行的会话在下一条指令开始前检查停止请求。
  - 两种情况都不会打断在途指令。

## 5. 结果 v1 与模板结果 Schema

```json
{
  "schema": "mx-device.result.v1",
  "realm": "sim",
  "jobId": "…",
  "attemptId": "…",
  "template": "xhs.detail@1",
  "collectedAt": 0,
  "completion": "succeeded | exhausted | partial | none",
  "counts": { "steps": 2, "completedSteps": 2, "items": 0, "records": 1, "pages": 0 },
  "items": [ { "id": "…", "title": "…", "page": 1, "step": 2 } ],
  "resultRef": null,
  "records": [ { "step": 2, "code": "xhs.note.detail", "target": "…", "fullText": "…", "complete": true } ],
  "evidenceSummary": { "source": "simulator", "validatedReceipts": 2, "allStopped": true, "commandCodes": ["app.open", "xhs.note.detail"], "firstAt": 0, "lastAt": 0 }
}
```

- 结果只由**已核验的指令回执**组成：成功任务取最终结果，未成功的任务取已成功的指令回执。
- 列表类步骤的 `items` 合并为一个数组，每项带页码和步骤号；其他读取或写入类步骤放进 `records`；导航步骤不出现。
- `completion`：
  - `succeeded`：全部步骤成功；
  - `exhausted`：成功，但最后一个列表步骤为空，说明来源已无更多结果；
  - `partial`：提前结束，但已有读取步骤的数据；
  - `none`：没有采集到数据。方案 §10 只列了前三种，`none` 是新增的。
- 超过 200 条时，`items` 只带前 200 条，`resultRef` 指向分页接口。
- `GET /v1/templates` 的 `resultSchema` 由模板版本冻结的指令输出 Schema 生成：列表项 Schema 加上 `page` 和 `step`，记录 Schema 加上 `step` 和 `code`，多种时用 `anyOf`。测试会用它校验真实返回的结果。

## 6. 回调（outbox）

| 项 | 做法 |
| --- | --- |
| 写入 | `server/client-settlement.mjs` 在每个存储事务的状态转换之后运行：调用方任务从未结束变为已结束且请求了回调时，追加一行 outbox。只追加、不加锁，所以按行执行事务也能写；`(job_id, event)` 唯一，同一任务只投递一次 |
| 投递 | `server/outbox.mjs` 的 `OutboxDeliverer` 运行在 API 进程（`server/index.mjs`、`dev:sim`）中。每秒用 `FOR UPDATE SKIP LOCKED` 领取到期记录并锁定 30 秒，多个 API 副本不会重复领取 |
| 请求头 | `X-MX-Delivery-Id`（接收方按它去重）、`X-MX-Event: job.finished`、`X-MX-Timestamp`（Unix 秒）、`X-MX-Signature: v1=<hex HMAC-SHA256(回调密钥, "<timestamp>.<deliveryId>.<body>")>`。接收方可参考 `verifySignature()`，时间偏差容忍 300 秒 |
| 内容 | 精简事件：`{event, deliveryId, occurredAt, job:{jobId, clientRequestId, template, class, status, completion, reason, completedAt, links:{self}}}`。列表数据由接收方用 Job API 读取 |
| 重试 | 任何 2xx 都算送达；否则按 10 秒起翻倍（最多 1 小时，±10% 抖动）重试，第 12 次仍失败即放弃。不跟随重定向，超时 10 秒。管理台「回调记录」可立即重试 |
| 安全 | 只投递到调用方允许的来源（投递前再检查一次）。来源由管理员配置，不由提交者决定 |
| 保留 | 已送达和已放弃的记录保留 14 天，由投递循环每 10 分钟分批清理 |

## 7. 作用域状态流与 Hub 嵌入

| 作用域 | 内容 |
| --- | --- |
| `ops` | 工作台实时状态的只读版：设备、队列、计划、等待原因、泳道、流转、解释；调用方任务只带名称、等级、模板、请求 ID 和截止时间，不带回调地址和请求指纹。需调用方 `embed: ops` |
| `client` | `{scope, client, pool:{devices, running, idle, paused, quarantined, offline, racks, queued}, mine:{queued, running}, jobs:[任务视图，无结果]}`。没有设备列表、画面、账号、事件和其他调用方的任务（Q6 默认值） |

- **共享生产者**：两种作用域都从同一个模式的共享状态派生（V2-4 的 `StateHub`），频道名为 `sim|ops` 和 `sim|client:<id>`。观察者再多也不会增加快照或规划；写操作会同时唤醒这个模式下的所有频道。
- **嵌入路由**：`/embed/` 提供页面和静态资源，`/embed/api/session|state|stream|jobs/:id|explain`（`explain` 只限 ops）。只接受 GET / HEAD，其他方法返回 405（Q8 默认只读，写操作留在 mx-device 管理台）。
  - 鉴权用调用方 API 密钥，由 Hub 后端添加；
  - `X-MX-Embed-Scope` 选择作用域，不能超过调用方允许的范围；
  - `X-MX-Embed-User` 是查看者显示名，经 URL 编码，只用于显示。
- **页面**：嵌入页的 CSP 为 `frame-ancestors 'self'`，同源的 Hub 页面可以用 iframe 嵌入；其他路由仍是 `'none'`。
  - 前端构建改为相对资源路径（`vite.config.mjs` 中 `base: "./"`）。服务端在嵌入页的 HTML 中加一个 `mx-embed` 标记，页面据此以相对路径访问 `api/…`，并显示只读外壳（`src/EmbedApp.jsx`）。
  - 工作台新增 `readOnly`：隐藏策略应用、提交、指派、取消、拖拽改派和机架管理，保留四种视图与解释面板。
- **Hub 侧要做的**（不在本仓库范围内）：
  - 把 `/device-center/*` 代理到 `/embed/*`，并加上上面三个头；
  - 丢弃浏览器发来的 `Authorization` 和 `X-MX-*`；
  - 把 `/device-center` 重定向到 `/device-center/`（只有代理知道外部路径）；
  - 关闭对两个事件流的缓冲。
  - 管理台「调用方 → 接入说明」和 `scripts/hub-sim.mjs` 给出了示例。

## 8. 浏览器验收（2026-10-18）

根目录 `.claude/launch.json` 新增 `mx-device-sim-hub`：管理台在 5182 端口，模拟 Hub 在 5192 端口。`dev:sim` 会预置两个调用方：「Hub 运维」（ops）和「外部客户 A」（client，权重 2，回调到模拟 Hub）。

| 项 | 结果 |
| --- | --- |
| 模拟 Hub 首页 | 自动提交、同步等待，回调签名全部有效，没有重复 |
| 客户视图 `/customer/device-center` | 自动补斜杠；资源经代理以相对路径加载；页头显示「实时」和查看者「客户 A · 王五」；只列出本调用方的任务（等级、进度、预计 / 完成时间、原因）；结果弹窗显示完成度、已核验回执数和记录内容 |
| 运维视图 `/ops/device-center` | 完整工作台只读：没有策略应用、提交、指派、取消和场景入口；屏幕墙与泳道实时更新 |
| 管理台「调用方」 | 公平汇总（三个等级的近期用时占比）、调用方表（配额、当前、结果、公平差值）、回调记录（全部 HTTP 204，1–5 ms）、新增后只显示一次的两个密钥、接入说明 |
| 手机宽度 390 | 客户视图没有横向滚动，任务表在卡片内滚动 |
| 控制台 | 只有登录前会话检查的 401，没有其他错误 |

验收中修复：嵌入页的任务名使用了工作台专用样式；只读模式下用 `hidden` 属性隐藏的链接仍被 CSS 显示出来，改为不渲染；回调记录里的任务状态改为中文。

## 9. 与方案的差异、仍待处理

| 项 | 说明 |
| --- | --- |
| 结果共享（Q4） | `freshnessMs` / `shareable` 未启用，返回 400。待确认后，可以在提交前按"调用方 + 模板 + 参数"查找新鲜结果 |
| 真实模式 | 调用方和 Job API 只开放模拟模式。真实模板执行在 V2-6 |
| 限流画面 | 嵌入的 ops 视图显示模拟设备的合成投影。真实设备画面按视口限流在 V2-6（Agent 截图） |
| `jobs.client_id` 列 | 方案 §4.1 建议加列；目前用表达式索引 `jobs_by_client`，没有改 jobs 表结构 |
| `maxInflight` 与规划 | 领取时为硬约束；规划器按"执行中 + 本次已计划"计数，不模拟未来的释放 |
| 预测 | 估算不计节奏冷却，偏早。有软计划时以计划为准 |
| 截止时间 | 只用于调用方内部排序、提交可行性检查和到期过期，不跨调用方做 EDF |
| 跨进程唤醒 | 长轮询每 500 ms 查一次状态。多个 API 副本时可以改用 PostgreSQL LISTEN 唤醒 |
| 公平记账粒度 | 大循环会话的实测时间扣除插入绕行时间；会话在检查点等待冷却的时间仍计入（设备确实被占用） |
| Hub 侧 | 代理、页面与业务接口包装不在本仓库范围内 |

## 10. 部署注意（本轮未部署）

- 新迁移 `014_clients_outbox.sql`，只新增表和索引，不改已有表结构。
- API 进程会主动向调用方配置的回调来源发起 HTTP 请求，需要确认网络策略允许访问 Hub。
- 反向代理需要关闭对 `/v1/stream` 和 `/embed/api/stream` 的缓冲，`/v1/jobs/:id/wait` 的读取超时应大于 25 秒。
- 前端构建产物改为相对路径，部署方式不变。
