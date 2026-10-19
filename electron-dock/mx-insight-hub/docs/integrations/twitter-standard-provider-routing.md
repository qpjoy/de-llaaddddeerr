# Twitter 标准搜索的供应商兼容

2026-10-18：Hub 在现有 `/api/v1/data/search`、`/api/v2/data/search` 内接入 TikHub 的 Twitter timeline。下游继续使用原 API、Twitter 平台授权、幂等键及分页方式，不需要申请 `social` 或 `native.*` 权限。MX-H2I 登录、SSO 和联网链路没有改动。

## 供应商选择与历史兼容

策略由数据库统一管理，**无需在 `.env` 设置 `MX_INSIGHT_TWITTER_SEARCH_PROVIDER=auto`**。迁移 `160_twitter_strategy_search.sql` 只在策略缺失时初始化 `priority / rapidapi / tikhub`：新搜索在采购前优先选已就绪 RapidAPI；其凭据或操作发布策略未就绪时，使用已就绪 TikHub 保底。两者均未就绪时报告不可用，不采购。这里的就绪检查不是额度、并发或网络成功承诺；当前操作权限、预算、并发及平台授权仍由各供应商原网关在实际派发前检查。

2026-10-18 用户补充授权：**RapidAPI 优先、TikHub 保底**时，无游标的新搜索若尚未取得成功源页，且 RapidAPI 明确返回上游 **HTTP 400**，Hub 保留原检索条件转 TikHub 一次。该分支要求确定的已保存拒绝证据；Hub 自身参数400、其他上游状态、超时、unknown、成功响应不可用均不触发切换。已存在游标或取得过源页后不跨供应商补页，固定 RapidAPI 与 TikHub 优先也不启用此400保底。不把历史400永久当作查询黑名单，也不改写旧失败回执。

管理入口为 **数据产品 → 策略搜索 → 管理 → 内容搜索 → Twitter / X**，仅 Admin Token 会话可编辑：

- `fixed`：固定 RapidAPI 或 TikHub。
- `priority`：选择优先供应商，另一个作为派发前未就绪时的保底；默认 RapidAPI 优先。仅 RapidAPI → TikHub 这一方向另支持上述首请求确定400保底。
- `paused`：暂停新的采购，包括原游标需要的后续采购；原重放窗口内的已完成响应和已购缓冲仍可交付。补页中途暂停保留已取得的结果及后续游标。

保存需要当前修订号和修改原因，并写入审计；并发修改返回冲突，刷新后重新填写。每次新选路和实际采购前读取策略，无需重启。迁移、重复部署均不覆盖已有数据库策略。旧环境变量仍接受合法值以兼容既有部署文件，但不再覆盖数据库；从旧环境变量固定模式升级时，以本次迁移初始化的 RapidAPI 优先为准，需要其他模式可在界面保存。

此优先级在 Hub 发布后对未固定供应商的新标准请求生效，下游无需升级。已有请求和游标不随默认顺序变化。Twitter raw 搜索仍走 RapidAPI，Facebook 的 RapidAPI 额度优先/JustOne 保底策略不变。

本次顺序调整的223项相关回归通过、无跳过，覆盖真实运行时的调用方策略、RapidAPI优先及未就绪时TikHub保底、原TikHub缓冲页重放、双版本unknown及幂等保护；其中4项本地HTTP测试解除沙箱监听限制后补跑通过。零线上采购，尚未替用户部署。

- 已保存请求优先按原供应商重放，包括原200、原失败以及原有 fresh/stable 语义。
- 新 TikHub 请求在预订时就保存供应商标记，不能因为派发前失败而转去另一供应商。
- 签名游标固定供应商、查询、页大小、调用方及前一页；配置切回 RapidAPI 后，已有 TikHub 游标仍沿 TikHub 继续。旧 RapidAPI 游标继续由旧实现处理，旧 `mxnc1` 保留原重放/显式重启边界。
- 标准搜索外的 raw/social/账号接口保持原有路由；Facebook、Instagram 等平台的策略不变。
- 同一调用方、已知查询的未决结果跨供应商、跨版本继续保护，复用已有 Boolean 编译器识别 SQL式和其等价 native 式。缺少查询的历史记录不会变成整个平台禁用。原 key 自身仍受幂等和 unknown 约束。
- 滚动升级期间两种供应商共用标准 Twitter 父派发租约，并在持有租约后检查未决结果，防止同一请求重复采购。

400保底在同一个客户请求和原幂等身份内完成，不要求下游换接口、删词、改查询、加供应商字段或手动重试。RapidAPI 拒绝与 TikHub 保底分别保留调用/采购成本证据，客户请求仍按现有规则结算一次；不能把确定400理解成供应商一定未收费。TikHub 成功后的分页固定 TikHub 并先交付已购缓冲，同页重放不重复派发。TikHub 若超时或结果未知，原请求及等价查询继续保留 unknown 保护，不能再切回 RapidAPI。

## 数据和分页

2026-10-20：新标准查询默认 `Latest`（旧默认 `Top`）。v1/v2 都可显式传以下 Twitter 参数；已保存的原响应仍精确重放，旧游标及旧请求的人工安全重试保留原 Top 语义，新游标绑定本次实际生效的条件。

```json
{
  "platform": "twitter",
  "query": "张婧仪",
  "pageSize": 20,
  "type": "stable",
  "params": {
    "category": "Latest",
    "includeTimestamp": false
  }
}
```

`params.category` 可为 `Latest/Top/Photos/Videos`；`params.filters` 为最长 2048 字的字符串（去除首尾空白，空白值省略）；`params.includeTimestamp` 为布尔值，默认 false。这是内容搜索合同，仍要求 `query`，不支持返回账号的 `People`。未知参数明确拒绝。原生 `count` 不再受 Twitter 支持，不能用 `params.count` 控制页数；Hub 的 `pageSize` 负责归档余量和逻辑交付。调用方继续原样传回顶层 `cursor=data.pageInfo.nextCursor`，不能把原生 Bottom cursor 放到 `params.cursor`，也不能在翻页时改变条件、页大小或 type。

TikHub 使用固定 `t.twitter_web_fetch_search_timeline`，传 `keyword`、对应的 `search_type=Latest/Top` 和下一页的原生 `cursor`。Photos/Videos、非空 filters 和 includeTimestamp=true 尚无已验证的 TikHub 等价映射：选择 TikHub 时在采购前明确拒绝；RapidAPI 明确400后的保底也不会丢弃这些条件转交 TikHub。Hub 复用既有等价 Boolean 编译器，保留客户原查询和指纹，不删除条件、不自动缩短检索式。TikHub 接口未声明 count，Hub 不添加这个参数。

[Twitter AIO 官方 Search 文档](https://rapidapi.com/viperscores-viperscores-default/api/twitter-aio/playground/apiendpoint_602d9730-5aec-48f1-ae31-7020727eb762)说明下一页使用 Bottom cursor，并提示长游标可改 POST，但未提供可核实的 POST body 示例。本轮保留现有 GET、原生游标长度上限及有效期，不猜测 POST 格式。参数及本次准入失败的取证说明见 [2026-10-20 排查记录](../operations/twitter-strategy-search-2026-10-20.md)。本段为本地源码变更，不表示已部署。

映射以供应商 `tweet_id` 字符串为真实身份，保留 `text`、发布时间、作者和照片/视频。缺失指标保持 null，真实0保持0；无关新增元数据不导致可用帖文被拒。整页存档及去重后按客户 pageSize 交付，所有超额帖子保存在缓冲，后续页先消费缓冲再采购；同页重试重放原回执。原生短页或空页带有效游标时继续分页；重复游标停止继续采购并返回明确提示。

v1 请求不添加新的日期限制。v2 沿用原精确半开时间窗交付过滤及覆盖限制提示；过滤后空页仍保留有效游标。第一页成功、19条结果或 `hasMore=false` 都不能单独证明完整历史窗口覆盖。

## 本次线上证据与验证

已购原生请求 `dcc086fa-469a-4237-a435-e427b7e70f3a`、唯一调用 `6c6177d6-4065-499c-aabb-50217f355780` 为 HTTP200/business200/succeeded。原280字符SQL式的等价257字符 native 式被 TikHub 接受。v3归档结构检查覆盖全部19项且未截断；本轮离线测试使用相同字段结构的合成数据，不冒充原始帖子字节。

用户随后返回 v4 实际归档映射：`mapped_saved_native_page`，19条全部成为标准项和 canonical 记录，身份、作者、正文和发布时间齐全，PostgreSQL投影安全；保留下一页游标。views有1条未知，其余指标真实0未被当成缺失。此项已在线只读验证通过，零新增采购；验证范围是 Admin 诊断容器的归档映射。

部署 Hub 新镜像后，在 Hub 源码目录执行：

```bash
bash server/ops/inspect-twitter-tikhub-saved.sh
```

该命令只读上面的已购回执，不采购、不操作 Delta、不改历史结果；v4实际调用部署镜像的标准映射、canonical转换及PostgreSQL安全校验。应看到 `adapterCalls=0`、19条映射和有效游标。旧镜像缺少新映射时明确返回 `needs_deploy`，不再发送供应商请求。

部署使用现有入口：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh ops internal-production deploy
```

无需 Delta/罗盘/Java 升级。此次可配置策略需要迁移160，完整 Hub 部署入口会在升级服务前自动执行；不要仅更新前端或跳过迁移替换 Public 镜像。迁移不修改凭据、价格、授权、历史请求或账单，查看和保存策略不会采购数据。

小量真实采购已获用户授权；标准链路验收入口已补齐，在有 kubectl 权限的宿主机同步下列两个同目录文件后执行：

```bash
bash server/ops/verify-twitter-standard.sh
```

入口读取同目录 `verify-twitter-standard.mjs`，以 stdin 在 **Public/api** 容器执行，不需要把诊断脚本重新打入镜像。使用已部署的 `createRuntime()` 和 `service.search()`，不启动第二个监听器或后台任务；检查的是 Public 镜像中的实际标准服务链路，不是公网 nginx/HTTP 认证入口。当前原调用方身份和授权仍在正常服务内检查，不读取/展示客户明文 Key，不新增权限或修改供应商策略。

- 保留原280字符完整查询，分别验证标准 v1/v2：首个小页、同 key 重放、原游标的下一页和再次重放。`pageSize=1`用于低采购量验收，不修改客户任务的20条页大小；全量供应商页仍由 Hub 保存并缓冲。
- v1没有新日期条件；v2明确使用固定诊断窗 `2026-09-18T00:00:00Z` 至 `2026-10-19T00:00:00Z`（Asia/Shanghai、半开区间），不声称重建旧请求丢失的时间窗。过滤后0条和有效游标可同时成立。
- 固定4个 `ops-twitter-standard-b5906846-*` key，`type=stable`。最多累计2条供应商调用记录，包含历史执行；不因重跑命令恢复额度。独占锁和实际派发前的预算检查仅作用于诊断进程，正常服务的客户额度与行为不变。已有缓冲页和重放可在额度用尽后继续读取；未知结果继续由原协议保护。
- 预期 `diagnosticRevision=twitter-standard-check.v1`、`standardDeliveryVerified=true`、`paginationVerified=true`、`originalUnchanged=true`。报告列出实际供应商及回执；页2的 `bufferedContinuationVerified=true`表示未新增供应商调用而完成缓冲续页。若源已耗尽，没有第二页则分页验收保持未确认。
- 这会按正常服务流程生成独立 usage/供应商回执和 Hub 入库队列任务，可能消耗供应商和客户额度；不写 Delta，不改原失败回执，不把诊断结果塞入旧冷启动。两次额度耗尽/拒绝/unknown时停止，保留结果供判断。

本地不能连接线上集群，标准服务验收仍需用户返回该命令结果；小页通过也不等于整月覆盖或旧 Delta 冷启动已经入库。

2026-10-18 首次标准验收已返回：v1第一页 `d117b74f-1b09-436d-96e3-903d0f7c5968` 经 TikHub 成功交付1条，同 key 重放通过；第二页 `af5f764d-7f9a-479f-96af-de57d807f401` 交付1条并确认纯缓冲续页、零新增供应商调用。随后第二页重放发生409，v2尚未运行，累计只采购1次。

已定位并修正 Hub 的 PostgreSQL 内部读取缺项：`getUsageRequestByIdempotencyKey()` 原先使用通用状态投影，丢掉 `acquisition_request` 中的供应商标记。第一页有自己的 TikHub 调用记录可供识别；缓冲第二页没有自己的调用记录，因此被误选为旧 RapidAPI，与原 TikHub 游标冲突。现在内部读取保留该快照，公开状态接口仍不暴露请求正文。没有修改历史数据、游标、指纹或幂等校验，也不需要数据库迁移。

发布此修正到 Hub 后，相同验收命令和固定 key 仍可重放v1已交付页；累计2次供应商调用上限不变，已使用的1次仍计入。尚未创建的v2请求按当前策略运行；RapidAPI 首次明确400后，TikHub 保底也需要独立采购额度。这个历史验收只剩1次额度，不能保证同时容纳 RapidAPI 拒绝和 TikHub 保底；诊断不为完成验收强制TikHub、绕过旧回执或自动提高预算。无需在Delta清理任务或重新配置查询。部署前重跑诊断脚本本身不能修复Public服务实现。

此次修正的211项相关回归全部通过、无跳过。4项真实PGlite身份读取回归在旧代码全部失败、修正后全部通过；另外将实际PostgreSQL读取投影接入完整标准验收，确认双版本缓冲续页和再次运行均可重放。公开状态接口仍不返回原请求快照，跨供应商游标冲突、unknown和APIKey归属保护保持有效。

原请求 `b5906846-8564-4791-8b83-ef3ce97789bc` 的400/502回执不可改写为成功。对该旧 key 的重试仍返回原结果；旧失败任务若坚持复用该 key，需通过原业务提供的新搜索/重建入口形成新任务。Hub 不自动清空 unknown，也不把独立诊断页灌入旧冷启动任务。

## 本地验证记录

2026-10-18 明确400保底本轮回归432项通过、0失败、0跳过，类型检查和生产构建通过。新增完整服务链路测试覆盖v1/v2、原条件与平台别名、RapidAPI400后同请求TikHub交付、同页重放、缓冲及原生续页、一次客户结算、并发、策略变化、超时/unknown及持久化失败；真实PGlite验证两份采购归档、跨供应商调用序号、父租约、费用预留释放与生产结算触发器。历史成功和400在策略数据库暂不可用时仍原样重放。本轮未进行线上采购或部署，未验证原Delta冷启动已经恢复入库。

数据库策略与管理界面本轮整合回归389项通过、0失败、0跳过，包含真实PGlite迁移重复应用不覆盖配置、CAS及审计回滚、Admin权限、表单保存和冲突、运行时策略热更新、暂停后重放/缓冲及补页恢复、v1/v2幂等和unknown、raw及其他平台回归。类型检查和生产构建通过。本轮零线上采购、尚未部署；本地浏览器控制在Work设置中关闭，未完成真实浏览器视觉验收，组件处理函数已离线验证。

447项相关回归通过，无跳过，包含本地HTTP接口、真实PGlite的跨供应商租约/unknown校验、标准v1/v2、原raw/social和聚合计费、分页缓冲、映射、手动重试与只读诊断。独立复核已完成。额外检查发现旧 `content-search-aggregate.test.mjs:35` 的Weibo能力预期在本轮之前的HEAD也失败，已独立快照复现，未改动该平台行为。线上标准交付及旧任务恢复不包含在离线通过结论内。

本次62项相关测试通过、无跳过。新增验收脚本回归使用实际 HubService/路由/网关/适配器和合成供应商响应，覆盖双版本交付、缓冲和重放、跨执行预算、未知保护、空页、旧回执不变、JSONB对象键顺序、回执归属和固定命令入口，并用真实PGlite校验历史调用计数SQL。未增加生产服务限制，MX-H2I登录与联网代码无改动。
