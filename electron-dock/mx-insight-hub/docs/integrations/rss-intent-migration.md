# RSS/新闻 intent 迁移：保留旧 RSS 覆盖

2026-11-01 用户决定：保留旧 RSS 订阅库覆盖并迁入 Hub，不以当前 Hub 新闻发现库存替代。
本轮状态：已收到生产数据库只读证据，完成 RSS 快照对账工具、Hub stored aggregate RSS 来源、Delta intent 适配器及离线回归。
尚未执行生产导入/授权或发布 Delta；v4已证明文件文章原文全部存在于源库，80条仅原订阅键缺失；已实现文件元数据/原文证据与归属保留，仍待生产迁移，不能宣称已完整迁移。
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

- 每轮完整扫描 UUID 主键，每批最多100条，并按完整行JSON累计8MiB限制返回量；单条超限明确失败，不截断证据或跳过记录；不使用未经证明的 updated_at 增量水位，不修改 Night-All 数据或索引。
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

1. 发布含上述工具的 Hub 镜像并通过常规 migration Job 应用174和175；不要先发布 Delta 切换。先执行本文末尾的文件溯源dry-run/apply，再执行数据库文章导入，让原订阅归属在首轮入库时进入私有证据。
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


## 2026-11-01 文件运行时回传与逐项比对

操作者已从监听13141的 node 进程确认：PID=136442，cwd=/home/fzj/Night-All，exe=/usr/bin/node。
这是一份当时的进程定位证据，不是固定 PID 配置。宿主机目录检查返回：

| 文件 | 状态 | 大小 | 订阅数 | 条目数 | SHA-256 |
| --- | --- | ---: | ---: | ---: | --- |
| data/rss-results.json | read | 25,214,415 | 240 | 14,836 | 354df4ee21fb0434428044254c6c6b11fed434f7cea42bf841f7f8fce620af4e |
| data/news-results.json | absent | — | — | — | — |
| data/rss-config.json | read | 11,128 | 8 | 8 | 1b4fab42aedbd9b1c6ad2cc504d22bb425a5354b68899cb876180f3a3d6cc345 |

RSS条目及配置条目均没有缺失 link/url/guid。这个统计不证明链接有效，也不证明数据库完整保留了文件内容。
`news-results.json` 不存在只排除了该主机目录当时的这一个文件；NewsNow 等动态新闻来源仍不在本阶段的覆盖证明中。

新增 `build-rss-file-comparison.mjs` 在宿主机读取这三份固定文件，生成仅含哈希的独立比对程序。
程序复用 `rssSourceOptions` 的注册连接解析，在现有 Admin Pod 里只读检索 Night-All RSS 表，
无需镜像更新、不需要复制正文进 Pod，不创建表、临时表、索引或写入 Hub。
在服务器 mx-insight-hub 目录运行：

```bash
set -o pipefail
node server/ops/build-rss-file-comparison.mjs /home/fzj/Night-All |
  kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- node --input-type=module -
```

同步两份新脚本 `server/ops/build-rss-file-comparison.mjs`、`server/ops/rss-file-coverage.mjs`，
并保留此前已同步的 `server/ops/diagnose-rss-intent-migration.mjs` 即可。请回传最终 JSON，不需要粘贴中间程序或源文件。
宿主机只读取固定文件；文件缺失/损坏、读期间被原地改写、目录不正确时停止，不把错误当空文件。
不同时间的文件内容可能改变，新结果中的 files.*.sha256 是本轮精确对比的快照。

身份使用旧 `saveRssFetchRun` 的精确表达式：
`SHA1([feed.id, guid||'', link||'', title||'', parsedDate||pubDate||discoveredAt||''].join('\n'))`。
此表达式本身不含 isoDate，不能擅自换成另一种日期优先级。另用身份字段数组的 SHA-256 防止换行拼接歧义，
用递归排序 JSON 的 SHA-256 比较完整原始文章内容（对象键顺序无关，数组顺序和字段值保留）。
对有规范记录的旧文章，比对的是 Hub 实际将保留的规范 raw，剥离写入器添加的 feed/feedResult；
不能因为旧表 raw 相同就忽略规范 raw 的差异。剥离导致原文章同名字段丢失时会报告 contentDiffers，不认定覆盖。

输出含义与补迁决策：

- items.exactCanonical / exactLegacyOnly：相同身份与完整 raw 已被当前数据库导入路径覆盖；文章无需另造一份。
- items.contentDiffers：身份相同，但文件保留的内容版本不同；需保留文件版本证据，不能用较旧文件覆盖最新数据库内容。
- items.identityMismatch：哈希匹配却不能证明同一身份（如旧写入算法/订阅键变化、关联变化或拼接歧义）；保留待核对，不能按 URL 猜测合并。
- items.missing：按旧写入器精确身份未在源库命中；需作为文件补迁候选，不能丢弃。相同 URL 的其他文章不是重复证明。
- feeds.matchedKey/missingKey：240个结果订阅键的覆盖。configFeeds 按完整订阅键和 URL 比较，区分相同、URL变化、同URL异键及缺失。
  这只核对8个配置的身份，不证明 enabled、抓取计划、标签或其他配置全部一致；完整配置仍需保留快照，不能覆盖生产订阅开关。
- articlePayloadsCovered=true 只表示本轮所有文件文章 raw 均已覆盖；fullFileCoverage 固定false，明确尚未证明完整配置迁移和动态新闻覆盖。

本轮新增2项测试通过：真实 PGlite SQL覆盖精确/差异/独有/身份冲突/订阅键与URL差异，以及实际生成程序的 stdin 执行和无正文泄露。
旧文件诊断测试仍通过。生产逐项比对待回传；此时不开放新授权、不执行补迁，也不发布 Delta 切换。


### 只读比对 OOM 修复（v2）

首次生产比对在约256MiB Node堆上限处退出134，没有得到有效覆盖结果。
旧查询每批250条，传回 canonical.raw 中逐篇重复的整个 feedResult，且同时保留旧表/规范表的重复 raw。
新版 `rss-file-coverage.v2` 在 SQL 中先剥离写入器的 feed/feedResult，只选择迁移实际采用的一个版本，
每批16条；SQL在返回前检查文章JSON文本及feed_key合计字节数，超过256KiB则不传回正文。
使用已有 item_hash、rss_item_id、feed id 唯一索引查找；保留 repeatable-read/read-only、语句/锁/空闲事务超时。
宿主机构建器以 JSON.parse 字符串嵌入哈希清单，减少大对象字面量编译开销。

新增 `items.payloadTooLarge` 表示超大条目尚未比对，不计入 missing、contentDiffers 或已覆盖数；
有此类条目时返回完整计数、status=incomplete、退出码2，articlePayloadsCovered=false，需后续单独核对。
结果含 limits.batchSize=16、limits.maxRowBytes=262144，可确认运行的是新版。
这是单次查询返回文章文本量的边界，不是整个进程RSS内存或数据库执行内存的承诺。

本地4项测试通过：实际PGlite查询（含2MiB重复feedResult、旧表/规范表超大条目和关联规范哈希变化）、
生成程序的stdin执行、文件诊断，以及独立Node子进程在96MiB堆限制下处理14,836条64KiB模拟文章（928批）。
压力测试使用驱动替身，实际SQL语义由PGlite测试验证；尚未取得生产v2比对结果。

重跑前将 `server/ops/build-rss-file-comparison.mjs` 和 `server/ops/rss-file-coverage.mjs` 两份更新同步到服务器，
执行上面的同一条管道命令即可；无需调高Pod内存、发布镜像或重启服务。
本轮仅修改诊断脚本、测试及说明，没有导入数据或修改MX-H2I登录/联网逻辑。


### v2 生产比对回传与身份差异细分（v3）

操作员回传的只读源库快照时间为 `2026-11-01T13:39:13.708Z`：

- 14,836条文件文章：exactCanonical=14,706，identityMismatch=130；exactLegacyOnly/contentDiffers/missing/payloadTooLarge均为0。
- 240个结果订阅键：238个存在，2个缺失；8个配置的订阅键与URL全部匹配。
- rss/config文件大小及SHA-256与前一次清单一致，news文件仍不存在。
- status=observed证明诊断完整执行；不是“迁移完成”。articlePayloadsCovered/fullFileCoverage仍为false，尚未执行生产导入。

130条全部命中旧item_hash，但按当前选用记录重算的身份不同；不能据此说文章丢失，
也不能推断130条一定来自那2个缺失订阅键。现有contentDiffers=0只涉及身份一致的条目，
不说明这130条的raw也一致。需要在当前证据上区分身份字段差异。

`rss-file-coverage.v3`（配套哈希清单 `rss-file-manifest.v2`）为文件身份的5个分量分别生成SHA-256：
feedKey、guid、link、title、identityDate（仍取parsedDate/pubDate/discoveredAt的原表达式）。
仍只向Pod传哈希，不传原文/URL/订阅键，不修改数据库查询、16条批量或256KiB单条上限。

新输出 `identityDifferences` 只细分identityMismatch：

- items/invalidRaw：差异条数/无法解析为文章对象的条数。
- fields：各身份字段不同的条数；一条可以同时改变多个字段，因此不可把这些数相加当文章数。
- rawPayloadEqual/rawPayloadDifferent：身份不同的条目，其完整文章raw是否相同；invalidRaw不计入两者。
- feedKeyOnlyChanged：身份仅订阅键不同；不保证其他非身份raw字段一致，需要同时看rawPayloadEqual。
- fileFeedMissing：这些差异文章中，文件的原订阅键在rss_feeds里缺失的条数。
- distinctFileFeeds/byFileFeed：涉及的原文件订阅数与匿名分组计数，附fileFeedRegistered。
  分组编号仅用于本轮阅读，输出不含订阅键、URL、正文或字段哈希；不是可供迁移合并使用的稳定ID。

v3不会把“仅订阅键变了”自动认定为同一条迁移身份，也不自动修复源库或覆盖Hub数据。
同步两份comparison脚本后执行同一条只读管道，回传version= rss-file-coverage.v3的最终JSON。
本地4项测试通过，新增实际SQL夹具覆盖缺失/重命名/空订阅键、多个身份字段变化、raw相同/不同/无效、
匿名分组及不泄漏字段哈希；14,836条模拟记录仍在96MiB堆限制下通过。生产v3分类待回传。


### v3回传：历史回填包装导致的诊断歧义（v4修正）

生产源库快照 `2026-11-01T13:44:54.383Z` 的v3结果仍为14,706条精确/130条身份不一致。
130条原文哈希不同，guid/link/title/identityDate均不同；其中80条feedKey不同且原订阅键缺失。
匿名分组分别为30条（缺订阅）、50条（订阅存在）、50条（缺订阅）。文件哈希与此前一致。
**这不是130条真实原文已经损坏/丢失的证明。v3存在历史raw布局识别缺口，以上差异须按v4重新判定。**

本地代码证据：Night-All `scripts/backfill-rss-canonical-items.js` 的SELECT构造：
`jsonb_build_object('rssItem', raw, 'feed', coalesce(feed_metadata, '{}'::jsonb))`；
同时source_ref.table=rss_items、source_ref.id=旧文章id。它与实时写入器将item字段平铺到raw的格式不同。
v1–v3仅剥离feed/feedResult，未展开rssItem，因而会把包装对象当文章比较，产生所有身份字段为空和raw不同的假差异。
目前只证明存在这种旧写入格式，不能断言生产130条全部来自它，或直接宣称原文一致。

`rss-file-coverage.v4` 在SQL返回前识别历史包装：raw.rssItem必须是对象，顶层必须恰为rssItem/feed，
source_ref.table必须为rss_items，且source_ref.id必须等于当前c.rss_item_id。
符合时比较内层完整原文（内层原有feed/rssItem同名字段完整保留），否则保持原比较规则，不猜测解包。
源库feed_key仍原样参与身份校验，缺失/变化不会用文件值偷偷补齐，因此文章原文相同也可能继续报告feedKey差异。

新增rawLayouts统计canonicalBackfill/canonicalInline/legacy；unverifiedBackfillShape是匹配包装但来源关联未通过的子计数，
不能与前三项相加。identityDifferences现在基于识别后的文章原文。
16条批量、256KiB字节上限、只读快照及匿名输出保持；没有源库写入、身份合并、Hub补迁或授权变更。

更新 `server/ops/rss-file-coverage.mjs` 一个文件后重跑同一条管道（现有构建器的manifest.v2兼容），
应返回 `rss-file-coverage.v4`。这是修复诊断误判后的核对，不是重复要求相同证据。
4项本地测试通过，新增实际SQL历史包装、错误source_ref、额外顶层字段、原文内同名字段、
缺失feed_key、真正内容变化及超大内层文章用例；96MiB压力测试仍通过。
完整配置/文件快照保留与是否需要文章补迁仍待正确比对证据；不要根据v3直接补入130份重复文章。


### v4最终文件证据与迁移执行（2026-11-01）

生产只读快照 `2026-11-01T13:55:24.590Z` 已确认：

- 14,836条文件文章原文全部在源库：14,756条身份和原文完全一致；80条原文及guid/link/title/日期一致，仅feed_key不同。
- 80条属于两个源库缺失的文件订阅键（30+50）。不需要重复创建80篇文章，更不能覆盖源库现有feed_key。
- 130条历史回填包装均通过来源关联校验；实时格式14,706条；无未知包装、缺失文章、正文差异或超大条目。
- 8个配置键/URL一致；完整配置与240个文件结果订阅的元数据仍需保留。news文件不存在不代表NewsNow已迁移。
- v4的articlePayloadsCovered仍为false，因为其原定义要求身份也完全一致；这里对“原文全部存在”的结论来自exactCanonical及80条rawPayloadEqual，未修改旧布尔含义。

新增175迁移创建两张Admin私有表：`catalog.rss_file_snapshots` 保存文件哈希/大小、完整解析后配置JSON、RSS顶层/逐订阅元数据及源库核对时点；
`catalog.rss_file_article_lineage` 保存每条文章的原文件feed_key、身份/原文哈希、**已核验原文raw_payload**和选中的数据库external_id/canonical_id。
原文件空白/键顺序等字节格式不单独存档，原文件SHA-256保留；文章原文对象、完整配置及元数据被保留。
私有证据原文从已核验一致的数据库行取得，不仅保存一个可能在源库更新后失去内容的哈希。
同一文件快照/源库指纹生成稳定snapshotId；整个快照和绑定一次事务提交，失败全部回滚。
重跑不重复插入，绑定到不同数据库文章时拒绝静默改绑。

`build-rss-file-lineage.mjs` 在Night-All宿主机读取文件，仅向Pod传文章哈希、原订阅元数据和完整配置，**包含私有订阅URL/配置，请直接使用管道，不把中间内容贴到聊天或日志**。
`reconcile-rss-file-lineage.mjs` 在Pod默认dry-run，再次完整只读比对源库：只接受完全一致，或仅feed_key不同且完整原文相同的条目。
任何新真实差异、超大条目或新增news文件均停止，不写部分绑定。该工具不修改可检索文章、不开启抓取、不改源库/授权/配置启停。
输入上限32MiB、累计待保存原文上限32MiB，写库每批最多100条/约2MiB；超限明确失败，不放大Pod内存。

数据库文章迁移仍用原`item:<rss_item_id>`或`canonical:<id>`，按同一源库指纹附加`extensions.file_feed_evidence`（snapshotId/feedKey/rawHash）。
旧订阅归属保留为历史证据，不替换当前订阅信息。完整配置与原文证据可从私有快照表追溯；public aggregate白名单不返回这些字段。
数据库读分页保留完整raw，累计返回最多8MiB；单行超过上限返回rss_source_row_too_large，需要单独处理，不能把失败当作迁移完成。
持续对账可以更新当前文章；私有快照保留旧文件版本，不受后续源库更新影响。

#### 下一步：新镜像和174/175迁移完成后先预检

这一步需要Pod镜像包含新模块，不能仅同步宿主机脚本。沿用Hub常规发布/migration流程，保持既有
`MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0`，不发布Launcher/Auth/Pay或调整MX-H2I网络。
宿主机在mx-insight-hub目录运行（源文件目录仍为/home/fzj/Night-All）：

```bash
set -o pipefail
node server/ops/build-rss-file-lineage.mjs /home/fzj/Night-All |
  kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node server/ops/reconcile-rss-file-lineage.mjs --dry-run

kubectl -n mx-insight-hub exec deployment/mx-insight-hub-admin -c admin -- \
  node server/ops/reconcile-rss-intent.mjs --dry-run
```

第一项应status=validated，若文件/源库未变则articles=14,836、feedAttributionsPreserved=80、feeds=240、configFeeds=8；
bindings为按身份+原文哈希去重后的条数，canonicalArticleWrites始终为0。第二项应status=validated，核对feeds/canonical/legacy。
只回传工具最终JSON，不回传中间bundle；预检不写Hub数据。

#### 预检通过后的实际写入顺序

下面命令写Hub，Night-All仍只读。先保留文件证据，再导入数据库文章：

```bash
set -o pipefail
node server/ops/build-rss-file-lineage.mjs /home/fzj/Night-All |
  kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node server/ops/reconcile-rss-file-lineage.mjs --apply
```

必须确认上一项status=succeeded并保存snapshotId后，再单独执行：

```bash
kubectl -n mx-insight-hub exec deployment/mx-insight-hub-admin -c admin -- \
  node server/ops/reconcile-rss-intent.mjs --apply
```

必须确认status=succeeded并保存importRunId。数据库导入中断仍按既有规则重跑；文件快照已提交且不被覆盖。
之后按上文核对projector、明确RSS授权并验证实际query/todayOnly，再发布Delta。NewsNow/混合新闻来源仍不在本次RSS覆盖证明内。

本地验证：8项RSS测试通过，覆盖真实SQL回滚、重跑、文章身份不变、源库更新后旧原文仍保留、订阅归属入canonical私有扩展、
不同源库隔离、字节分页和超大行失败；另1项RSS aggregate测试验证授权/query/日期/重放及私有溯源不泄漏；typecheck通过。
生产镜像/迁移/预检/apply及最终检索验收仍待执行。未修改MX-H2I登录/联网或共享支付/SSO逻辑。
