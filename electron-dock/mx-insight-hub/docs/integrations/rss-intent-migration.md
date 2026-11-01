# RSS/新闻 intent 迁移：保留旧 RSS 覆盖

2026-11-01 用户决定：保留旧 RSS 订阅库覆盖并迁入 Hub，不以当前 Hub 新闻发现库存替代。
本轮状态：已收到生产数据库只读证据，完成 RSS 快照对账工具、Hub stored aggregate RSS 来源、Delta intent 适配器及离线回归。
尚未执行生产导入/授权或发布 Delta；文件回退源仍待核对，不能宣称已完整迁移。
未部署、未调用供应商或模型、未变更 MX-H2I 登录/联网。

## 已确认的代码问题

- Delta `/Users/qpjoy/workspace/mingxi/po-infra/llm/data_query.py` 的 `hub_data_query_route`
  原先对 `search_intent + rss/news` 返回空路由、仍由旧 HTTP Skill 执行；现在 RSS 使用代码内 Hub 分派，未迁来源明确拒绝。
- Night-All `search-intent-service.js` 原先优先使用 `intent`，可覆盖真实 `query`。
  现改为 query 优先；无 query 的既有调用仍兼容 intent 查询别名，businessId 不作为关键词。
- intent 曾复用事件概览的“通用问题清空关键词”分支；现在 intent 内部固定 preserveQuery，
  RSS/新闻收到原 query，不把检索静默变成首页浏览。普通事件概览保持原行为。
- `event-search-service.js::collectPlatform` 漏传 todayOnly，RSS/news 的默认行为会覆盖 false。
  现显式传递 true/false。mode、limit 与旧 rules/both 摘要行为保持；Hub 新链路只提供数据，摘要交给 Delta。

修复位于 Night-All 三个 search service，并新增 `tests/search-intent-query.test.js`。
新测试修复前复现3项失败；修复后新测试与既有 event-search 回归共8项通过。

## 必须保留的数据范围

旧 RSS 路径不等于当前 Hub 新闻发现：

| 来源 | 旧读取方式 | 迁移核对事项 |
| --- | --- | --- |
| `rss_canonical_items` | 时间窗内有行时优先 | 独立 UUID、rss_item_id、feed_key、原文/摘要、发布时间/收录时间、更新水位 |
| `rss_items` + `rss_feeds` | 规范库无对应窗口数据或不存在时回退 | 旧独有记录、订阅元数据、与规范库对应关系，不能只迁规范库 |
| `event_source_items` | news/hot 的数据库来源 | source_type 与业务来源隔离；不能把 Agent 产物重新当公开新闻 |
| RSS fetcher、本地 news-results JSON | 数据库不满足条件时的文件来源 | 需运行时核对文件与数据库覆盖；不能以数据库计数证明完整覆盖 |

2026-11-01 操作者回传：night_all 只读连接可用；rss_feeds=1,067，rss_items=85,214，rss_canonical_items=85,214；
legacy_without_canonical=0，canonical_without_legacy_id=0。Hub 当时 rssSources=[]。
event_source_items=640,817，分类为 project=311、realtime=4,183、search=1、social=632,803、social-hot=3,504、wechat_article=15，
没有 source_type=news；这不能证明本地 news-results 或 NewsNow 没有新闻，也不允许把所有事件改标为新闻。
旧 RSS 查询先取受限窗口再内存过滤 query，可能漏掉窗口外的匹配项；Hub 应在过滤实际 query 后分页，
而不是迁移这一限制。不得通过放大源库扫描或清空关键词伪造检索成功。

## 只读生产核对

把本次新增脚本同步到服务器，在 mx-insight-hub 目录执行；无需发布镜像、迁移或重启：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - \
  < server/ops/diagnose-rss-intent-migration.mjs
```

脚本读取 Admin 已有 DATABASE_URL，查 Hub 当前登记的 `telegram-monitor-messages` 源连接，
复用其数据库配置只读检查四张固定 RSS/事件表。该登记源只是 Night-All 源库候选；表不存在时
返回 absent/incomplete，不能推断另一台服务器也没有数据，不尝试猜密码、端口或扫描其他主机。
如现场确认应使用已登记 chats 连接，可把 node 参数改为 `node --input-type=module - telegram-monitor-chats`。

输出包括连接是否已登记、表列类型、主键/索引定义、行数、旧 RSS 未被规范库覆盖的数量、
规范 RSS 无旧 ID 的数量、事件来源类别。不输出密码、DSN、文章正文或源 URL。
所有连接和事务只读；10秒语句超时、1秒锁超时；超时保留为 unavailable，不当作0。
`database_observed` 只表示数据库检查完整，不代表文件源完整、数据已迁移或链路可用。
脚本4项测试通过，包含真实 PGlite SQL、缺表、凭据不输出和只读连接约束。

## 已实现的边界与验收条件

1. 按实际源库身份和 schema 复用 Hub 管理的数据源连接；明确 RSS 规范/旧记录去重身份、更新及删除策略。
   通过现有清洗/入库流水线保存原始证据、规范记录及检索索引；不凭源 updated_at 自动宣称无丢失增量。
2. Hub 公开检索限定当前 Key 已授权 RSS/新闻范围，实际 query 必填；businessId 仅作业务归因，不能授予数据权限。
   RSS 与 news 来源选择保持可辨；缺少迁移来源不能静默变成已授权的全部新闻。
3. todayOnly=true 按 Asia/Shanghai 当天过滤；false 不附加当天限制。
   日期窗口需在首次请求/检查点冻结，跨天重试与续页不得改变原窗口。返回所用时间字段及范围。
4. 支持 mode=fast、limit 默认20和明确的有界分页，rules/both 摘要请求由 Delta 消费原始证据后生成；
   Hub 不隐式调用模型。单一社交平台既有 raw 路由保持，未支持的混合源明确报错而非回退 Night-All。
5. 新接口、文档、授权/计量和数据可用性验证完成后再切 Delta 代码路由；保留原请求/游标检查点，
   不能仅改旧 agent_sources 文件或以新幂等键绕过未决请求。


## 数据迁移与持续更新

新增 migration `174_rss_subscription_snapshots.sql` 只创建 Admin 订阅快照与文章身份映射表，不改任何已有授权。
`server/ops/reconcile-rss-intent.mjs` 默认 dry-run；`--apply` 才写 Hub。复用已确认的
`telegram-monitor-messages` 连接，但只读取三张 RSS 表，源端事务固定为 REPEATABLE READ READ ONLY。
连接来源的 host/port/database 指纹固定到新源，密码轮换不改变指纹；换库必须重新核对，工具拒绝静默换源。

- 每轮完整扫描 UUID 主键，每批100条；不使用未经证明的 updated_at 增量水位，不修改 Night-All 数据或索引。
- 规范记录优先，旧表仅读取 NOT EXISTS 对应 rss_item_id 的行；`item:<rss_item_id>` 在规范化前后身份不变。
  没有旧 ID 的规范记录使用 `canonical:<id>`。首次观察后若同一规范 UUID 的 rss_item_id 改变（含从空值补关联），
  返回 rss_article_identity_changed，要求核对身份；不会悄悄新增第二份文章。不同订阅的不同文章 ID 保留，不猜测按 URL 合并。
- 全部订阅（含 disabled）进入 `catalog.rss_subscription_snapshots`，保留原 JSON 与 import_run_id；
  文章和关联订阅证据通过现有 source_objects → canonical/revisions → outbox 流水线，dataset=`rss.articles.v1`。
  Public 只返回文章白名单字段，订阅 URL、metadata 和 raw 不公开。ES 由现有 projector 异步更新。
- 新来源 `rss-subscription-snapshot` 保持 paused；它属于专用快照对账工具，不可启用通用数据库增量调度。
  `--apply` 登记本次明确映射的操作员审批；已有来源/映射或物理来源指纹不符时拒绝覆盖。
- Hub 会话级锁防并发，文章批次使用同一持锁连接提交；进程中断后的 running 记录在下一轮标记 failed。
  失败可能已提交部分批次，下一轮从头对账并去重。整体成功前不要开放首次 RSS 数据授权。
- 不传播上游硬删除：这是保留历史的镜像，源端缺失不等于删除证据。订阅表也是最近观察值，不自动删除失踪订阅。
  源库采集器仍负责抓取；本阶段去掉查询对 Night-All HTTP API 的依赖，并未替换 RSS 抓取器。
- 每条 SQL 30秒超时、对账总预算1小时；默认仅手动执行。可选的 `deploy/k8s/rss-reconciliation.example.yaml`
  每6小时运行一次、Forbid 并发，初始 suspend=true，未加入 kustomization，不会随常规部署自动启用。
  首轮测量耗时与数据库负载后再单独配置镜像/周期并启用。每轮长期持有源库只读快照，应观察数据库负载。

## 发布顺序与服务器命令

1. 发布含上述工具的 Hub 镜像并通过常规 migration Job 应用174；不要先发布 Delta 切换。
2. 在 Hub 新镜像上先运行只读 dry-run，核对数量（源库继续采集时可以高于本次85,214）：

```bash
kubectl -n mx-insight-hub exec deployment/mx-insight-hub-admin -c admin -- \
  node server/ops/reconcile-rss-intent.mjs --dry-run
```

3. 核对成功后执行已准备的数据导入。此命令**写 Hub**，源端仍只读，日志只有计数和运行 ID：

```bash
kubectl -n mx-insight-hub exec deployment/mx-insight-hub-admin -c admin -- \
  node server/ops/reconcile-rss-intent.mjs --apply
```

最后一行必须为 `status=succeeded`。保留 importRunId、feeds/canonical/legacy/changed；
失败不能当作空库，按错误码检查连接/迁移/来源指纹后从头重跑。再次执行应只更新源库新增或变化记录。
导入状态可在数据清洗中心查看；paused 是该专用源的预期状态。

4. 核对文件覆盖。在实际 Night-All 运行主机上，将参数替换成**实际运行的代码目录/挂载目录**：

```bash
node server/ops/diagnose-rss-file-fallbacks.mjs /actual/runtime/Night-All
```

也可在 Night-All 容器的应用工作目录用 stdin 运行该独立脚本。
脚本只读 data/rss-results.json、data/news-results.json 和 data/rss-config.json；输出数量/内容哈希，不输出文章/URL/凭据。
错误工作目录返回 runtime_root_unverified，不能把它当作文件不存在。文件有记录时还需按实际身份与数据库比对并补迁，
本工具不会把这些未核对文件静默当作已覆盖。旧 news 还可能触发 NewsNow；目前不迁 realtime/social 等事件为 news。

5. 由操作员给目标 consumer 和对应 Key 明确配置 `rss` 平台及现有 canonical-search 所需额度/价格，
确认源数量与 projector 状态，再验证 Hub 搜索。普通授权配置和 Key 的平台快照都需包含 rss；businessId 不授予权限。
本次代码和 migration 不批量改 Key、不自动给已有用户添加 RSS。

```json
{"query":"实际搜索问题","platforms":["rss"],"objectTypes":["article"],"mode":"stored","pageSize":20,"filters":{}}
```

地址为 `POST /api/v1/data/aggregate/search`，Bearer Key + 每个独立页面的 Idempotency-Key。
响应为 `mx-insight-hub.aggregate-search.v1`，包含全文、URL、author、eventTime、collectedAt 和 opaque nextCursor。
`GET /api/v1/data/aggregate/sources` 只向获授 rss 的 Key 显示该 stored-only 来源。

6. 数据覆盖/授权验收后再发布 po-infra。无需修改 Launcher/MX-H2I、SSO、网络、数据库连接或支付逻辑。
未决旧 Night-All 请求不自动重放到 Hub；先处理旧请求状态，不能用新路径或新 Key 绕过未决结果。

## Delta 调用与重试

`llm/intent_search.py` 接受原 intent 形状（query 必填）；Skill 合并原 config/action payload_defaults 后由代码选择 Hub 路径。
默认 mode=fast、limit=20、todayOnly=true、summaryMode=rules。只支持 platforms=[rss]（未指定默认 rss）；
news/web/未迁混合范围明确报 intent_source_unavailable，不回退旧 HTTP，也不替换为当前 Hub saved-news 库。
已有单一社交平台和 Telegram 分流保持。

`todayOnly=false` 不附加日期范围。true 在第一次调用固定上海当天00:00至23:59:59.999（Hub 日期边界为闭区间）。
时间字段是 RSS effective time：规范记录 normalized_at → published_at → collected_at → created_at，
旧表 published_at → discovered_at → created_at；源原始精度在 raw JSON 保留，检索精度为毫秒。

执行前持久化完整请求和幂等键到 Skill request_meta.checkpoint。
Skill 响应的 result.checkpoint（直接 Python helper 响应的 intentCheckpoint）可作为下一次输入的 intentCheckpoint 原样恢复；
跨天仍使用原窗口和 Key，改变 query/limit/cursor 等请求参数会拒绝恢复。
续页保留首轮 intent.searchWindow、query、limit、todayOnly，并传 Hub cursor，使用**新的**幂等键；
续页不能携带上一页的 intentCheckpoint。网络路由重试复用同一已冻结请求，403/429/503 原样保留，不转换为空结果。
直接 helper 调用若异常，HTTP 错误的 exception.result 带检查点，网络/解析异常的 exception.intent_checkpoint 保留原请求；
Skill 网络异常的检查点已写在 request_meta。data_reuse.enabled=true 的分析复用调用明确拒绝新检索，应读取源 run 的既有证据。

rules/both 都不在 Hub 隐式调用模型；返回 intent.summaryGenerated=false、summaryOwner=caller，交给 Delta 上层生成。
businessId/intent 业务用途仅保留在调用方输入审计，永远不充当搜索关键词。

## 本地验证

- 真实 PGlite 运行全部 Hub + mx-common migrations，验证规范/旧表补漏、旧记录规范化保持身份、重复导入不新增投影、更新、失败重跑及换库拒绝。
- Hub RSS 独立授权、实际 query/日期过滤、私有订阅字段不泄漏、幂等重放无外部调用；公开文档与 YAML 一致。
- Delta 纯离线测试覆盖默认值、false/both、无 query 拒绝、跨天恢复与续页、错误/取消以及现有社交/Telegram 路由。
- 聚合 + public-docs 31项通过；RSS 数据/诊断6项、文件诊断1项、Delta8项通过；typecheck通过。
  另一个既有 content-search-aggregate 测试仍期望 Weibo hub_only.refresh=false，但 HEAD 已为true；本次不改该无关预期。
- 未在生产运行导入、调整授权或发起模型/供应商调用；文件覆盖、实际导入耗时/计数及线上检索仍待操作员回传。
