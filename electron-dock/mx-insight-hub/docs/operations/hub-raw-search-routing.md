# Hub 搜索的平台迁移、内容标题与媒体

2026-10-08。沿用 `POST /api/v1/search/raw`，保留 `POST /api/v1/night-all/search/raw` 为同一入口。没有新增 `/api/v1/data/search/raw`。Delta 无需修改 URL；以后可只把 URL 改为 `/api/v1/search/raw`，请求体、Key 和同次请求的幂等键不变。

## 2026-10-13：重复媒体的补充诊断

补齐一个已由本地回归复现的窄分支：抖音图片在 `media.images`、视频在同一行的 `video_urls`、明确封面在 `cover_url` 时，也按完整 URL 相等移除重复封面。保留视频、封面、真实图片、图集/混合类型以及不同 URL；不改原始证据、历史交付或下游已保存副本。此修复尚不能证明用户截图正好命中该分支。

Luopan 截图中头像旁的 ID 来自作者字段，不能当作帖子 ID。`t2_15nmkah` 对应的 `[X] ...` 是 Reddit 转载标题，应保留；Twitter/Facebook 的无标题政策不能按标题里出现 X 链接套用。小图和视频看起来相同，也不能仅凭截图删除所有图片。

本轮通过已登录的 Hub 管理界面只读浏览，按作者与文本找到截图中的两条抖音记录：

| 作者 ID | 帖子 ID | Hub canonical UUID |
| --- | --- | --- |
| `7644956974627521593` | `7694499580356934565` | `27c49438-6ebd-429e-8a7f-0b0bf2111b5f` |
| `98668214217` | `7694498708125257014` | `f54db585-8310-469b-960d-82cef43cd5d6` |

两条当前记录均属于 `night-all.search.v1`，`content_type=4`、revision 2、`collected_at=2026-10-09T03:15:57Z`；`media.images=[]`、视频数量 1，并保留 `coverUrl`。这证明这两条当前 canonical 已没有重复图片，不能证明旧交付、缓存或 Luopan 已保存副本同样修复；上面的嵌套字段窄分支也不是这两例已证实的重复原因。本次证据来自管理界面，不是 k8s 脚本执行；没有写库、部署或重新采集。

同一管理界面随后核对 Reddit：canonical `41f923a6-5a34-4953-b9ea-b718b5347849`，帖子 `1x2arsq`、作者 `t2_15nmkah`，数据集 `night-all.search.v1`、revision 1、`collected_at=2026-10-10T10:44:20Z`。两张图片分别为官方 `preview.redd.it` 上的 `mk4i7zgtwluh1.png`（140×140、裁剪及签名参数）和 `https://i.redd.it/mk4i7zgtwluh1.png`；封面为前者，`videos=[]`。这确认为同一 Reddit 资产的缩略图与原图重复，不是“图片加视频”；不在文档保存签名值。

据此新增 `reddit-original-image.v1` 窄规则：仅 Reddit、HTTPS 官方 `preview.redd.it` / `i.redd.it`、完全相同的单段字母数字资产文件名及 png/jpg/jpeg/webp/gif 后缀，且同一个图片数组已获得无查询参数的原图时，移除该预览附件并把对应封面换成已有原图 URL。保留原图顺序/对象信息、正文、原生标题、其他图片与全部视频。不接受凭据、端口、fragment、空白、编码/多段路径、未知域名或不同文件名；不对其他 CDN 去参数，不从预览地址生成原图。覆盖现代媒体、raw 字符串/数组及嵌套行、两类 canonical 入库；不合并图片别名，也不因原图位于另一字段就清空当前消费者读取的图片数组。实际发生修正的记录摘要含媒体政策，重复相同输入保持幂等，原始 payload 及其摘要保留。本轮仅本地代码和测试，不执行迁移、历史修复或发布，线上已保存 revision 1 不会被本次编辑自动改变。

Luopan 本地源码 `/Users/qpjoy/workspace/mingxi/luopan/po-frontend` 的 `ClueWithTabs.vue` 和 `OpinionDetail.vue` 另接入共享 `src/utils/mediaDisplay.js`：仅在有视频且图片与明确封面完整 URL 一致时，从展示列表隐藏封面；Reddit 同数组的官方预览/原图使用上述窄身份规则。缩略图、计数和预览索引共用过滤后的图片列表，不改变接口响应、标题或持久化副本。9 项媒体行为测试、原有 clueTimeFilter 检查及 Quasar SPA 构建通过；原有 detailMixedMedia / mediaCardLazyVideo 两项检查在未修改源码上已有失败，未计入通过结论。此显示补救尚未发布，不代表已核对 Luopan 后端中的历史副本。

新增 `server/ops/diagnose-search-media.mjs`，使用 Pod 已有 `DATABASE_URL` 查询存量证据，不调用供应商、不修改数据。允许 `--author-id`、`--text`、`--request-id`，组合时取交集。已部署工具时，在服务器执行：

```bash
kubectl -n mx-insight-hub exec deploy/mx-insight-hub-public -c api -- node server/ops/diagnose-search-media.mjs --platform douyin --author-id 7644956974627521593 --text '三台新车全部断踏板'
```

也可在持有工具源文件、已具备集群只读访问的 Hub checkout 中，通过 stdin 执行；无需复制文件进 Pod、发布或重启：

```bash
kubectl -n mx-insight-hub exec -i deploy/mx-insight-hub-public -c api -- sh -c 'cd /app/server/ops && exec node --input-type=module - "$@"' sh --platform douyin --author-id 98668214217 --text '谁经得起检验' < server/ops/diagnose-search-media.mjs
```

已知请求 UUID 时，保留 `--platform` 并改用 `--request-id UUID`，只读该已提交交付及其链接缓存；只传请求 ID 不推断它与当前 canonical 的关系。作者/文本模式检查最近交付、这些交付关联的缓存，以及 `night-all.search.v1` / `night-all.compat.v1` 的当前 canonical。默认候选上限 50、全报告匹配上限 20，可设 `--recent 1..200` / `--limit 1..50`。canonical 候选按现有索引的 `coalesce(event_time,collected_at,last_seen_at,first_seen_at)` 排序，是内容流窗口，不是采集时间排序；文本在有界候选中筛选，零命中不代表全库没有该记录。

报告区分作者/帖子 ID、交付/缓存/当前修订，分开输出创建与采集时间，未知采集时间保留 null。媒体仅输出 URL 哈希、host、路径哈希和查询参数名，不打印正文或签名参数值；`samePathDifferentUrl` 只是候选关系，不能证明相同图片。`currentNormalization` 使用运行环境的规范化代码离线比较，不执行修复。报告明确未检查原始供应商档案和 Luopan/Delta 副本。

每次事务为只读，语句/锁超时分别 5 秒/1 秒，单条正文上限 8 MiB，并报告候选、检查和截断范围。失败仅输出固定阶段及允许的 SQLSTATE 分类，不回显数据库异常或连接串。测试：`node --test tests/server/search-media-diagnostics.test.mjs tests/server/search-content.test.mjs tests/server/reddit-search-media.test.mjs`。诊断脚本已通过本地测试，尚未在生产执行；上述管理界面证据仅确认这三条当前 canonical，不代表完整交付链路已取证。

## 2026-10-09：统一搜索入口与抖音封面

`/api/v1/data/search` 与两条旧 raw URL 现在统一进入 Hub 的 `search` 业务入口。内部选择 data/raw 输出分支，不通过 HTTP 再调用自身。旧 raw 的请求体、`raw_data` JSON 字符串、`raw_info`、分页、授权、raw meter 和幂等身份继续兼容，Delta 不需要改接口。现代入口保留严格的 `night-all.data-search.v1` 结构和原平台计费；data/raw 的游标与计费单位仍分别保持原约定，不能只替换成现代 URL 就混用两种请求结构。

本轮统一的是 Hub 的交付与 canonical 内容规则。各平台已接通的上游分流继续使用；抖音仍经过现有 Night-All 采集链路，没有新增直连供应商调用。后续可以在统一入口内逐个平台替换采集实现。

线上只读诊断抽取最近 3 次已交付抖音搜索，每次前 3 条，共 9 条：`kind="4"`，单张图片的 URL 哈希与封面完全相同，另外存在独立视频地址。对应新交付的修正规则为：

- 视频保留原地址，封面保留在 `coverUrl` / `cover_url`；仅从图片附件移除与明确封面 URL 完全相同的项。
- 保留其他真实图片、明确的图集/混合类型、未知数字类型及账号数据；没有明确封面或可播放视频时不推断。CDN 查询参数不同也不视为同一张图片。
- 同时覆盖现代 `data.items[].media.images`、旧 raw 的 `image_urls/images/media.images` 和嵌套 raw 结果；JSON 字符串与数组类型保持原样。
- `night-all.search.v1` 与 `night-all.compat.v1` 的 canonical 入库使用同一媒体规则。`douyin-video-cover.v1` 标记修订版本，下次正常入库更新旧记录一次；重复入库不反复生成修订，原始证据与历史修订保留。

常规部署不改写已提交响应、旧幂等重放或 Delta 已保存的内容，也不自动启动回填。部署 Hub API 和 ingest worker 后，正常的新交付生效；若仍读取原请求的不可变快照，仍会看到原内容。用户随后明确要求修复历史抖音数据，使用下方手动迁移工具处理这一例外。本项没有新增 SQL migration，不需要发布 Delta、Night-All 或 MX-H2I。

回归入口为 `tests/server/search-content.test.mjs`，包括两条 raw URL 的共用请求身份、单次采集/计费、现代严格结构、历史重放，以及独立 PostgreSQL 中两种入库路径的修订验证。数据库测试只在提供 `MX_INSIGHT_TEST_DATABASE_URL` 时运行，必须指向可丢弃的测试库；本轮未调用真实供应商。

### 一次性修复历史抖音数据

工具：`server/ops/repair-douyin-media.mjs`。这是用户于 2026-10-09 明确要求的历史修复，不挂接部署或自动 schema migration。默认仅预览 canonical；`--apply` 才写入，`--include-deliveries` 明确扩展到旧交付和兼容缓存。所有范围均只匹配抖音，并复用实时接口的精确封面去重规则。

| 范围 | 修复行为 |
| --- | --- |
| canonical（默认） | 各数据集内未删除的抖音 post；只改 `stable_fields.media`，新增修订并通过 outbox 更新搜索投影，保留原采集时间、正文和原始证据 |
| 历史交付（显式选项） | `usage_requests` 中已提交、HTTP 200 的抖音现代/raw 响应；之后同一幂等键重放修正后的媒体，账单、用量、时间和请求身份不变 |
| 兼容缓存（显式选项） | `serving.compatibility_snapshots` 内抖音响应；只改重复封面，不延长有效期，也不更改已过期/已被替代状态 |
| 原始供应商证据 / Delta 数据库 | 本工具不改。Delta 已持久化的副本需在其数据库另行迁移，不能通过 Hub 自动回写 |

先同步并部署本轮 Hub API 与 ingest worker，确认滚动发布完成后再执行，避免旧 worker 重新写入旧格式。以下每条都是独立单行命令，无需 heredoc：

只读预览全部 Hub 范围：

```bash
kubectl -n mx-insight-hub exec deploy/mx-insight-hub-public -c api -- node server/ops/repair-douyin-media.mjs --include-deliveries
```

执行同样范围的迁移：

```bash
kubectl -n mx-insight-hub exec deploy/mx-insight-hub-public -c api -- node server/ops/repair-douyin-media.mjs --include-deliveries --apply
```

再次执行预览，`matched` 应为 0。若只修复 canonical，去掉两条命令中的 `--include-deliveries`；旧响应重放将保持原样。输出只含模式、运行 ID 和每类的 `scanned/matched/updated` 数量，不打印正文、地址、凭据。canonical 的数据库修复立即生效，搜索索引等待现有 projector 消费 outbox；不需要全库重建或重新采集。

默认每批 50 行，可用 `--batch-size 1..200` 调整。每批在同一短事务内备份、修改、写修订和 outbox；行锁最多等待 2 秒，单条语句上限 15 秒。不跳过被锁行而声称完成；异常停止时已完成批次保留，失败批次回滚，重新执行同一命令即可继续。运行捕获开始时间，不追逐之后新增的数据。不要同时启动多个 apply，工具会通过专用锁拒绝第二个运行。

首次 apply 创建私有运维备份表 `control.douyin_media_repairs`，保存每条原始行、目标、运行 ID 和修复后摘要；历史 canonical 修订不改写。只读预览不创建表。对能核对原始修订的两类搜索数据，迁移哈希与现行入库一致，再正常入库不会仅因本次迁移增加版本；其他映射使用独立的人工修复摘要。不得直接降低 canonical 修订号或用备份覆盖迁移之后的新采集；备份用于审计及核对后的恢复。

`tests/server/douyin-media-repair.test.mjs` 在临时 PostgreSQL 数据库执行完整迁移建表、预览、事务故障注入、行锁竞争、原值备份、计费字段不变及重复执行测试。测试要求 `MX_INSIGHT_TEST_DATABASE_URL` 指向允许创建/删除测试数据库的可丢弃实例，不连接生产，不调用供应商。

## 本次路由

| 平台 / 请求形状 | 处理位置 |
| --- | --- |
| 微博，单个 `keyword` 或 `query`，不超过 500 字符，有效页大小至少 20（仍受原 Key 上限约束） | Hub 直连已注册的实时搜索接口，按需获取全文 |
| Instagram，同样的单关键词，有效页大小至少 20，不要求详情补取 | Hub 直连已注册的 general search；保留 caption、媒体和复合分页状态 |
| Twitter，同样的单关键词，有效页大小不超过 50，不要求详情补取 | Hub 复用现有 RapidAPI 适配器；标准 `raw_data[].title` 为空字符串，canonical title 为 null |
| Facebook | 采集仍用现有 Night-All 复杂处理；新交付的内容空标题规则由 Hub 执行 |
| 已支持的小红书、微信 | 保留原有路由和权限规则，包括旧 Night-All 微信入口的 410 |
| 批量关键词、未迁移平台、特殊筛选/工作量参数 | 保留历史处理，逐步迁移 |

新直连子集允许空 `params`，不支持非空 params、评论补取、缓存时长、并发参数；显式 `page>1` 和旧 `mxnc1` 游标继续走历史链路。普通首屏允许 `page=1`。`count/limit/pageSize` 沿用原解析优先级。

Hub 新分页使用绑定 consumer、Key、平台、查询与页大小的 `mxraw1` 游标，最多 15 页。下一页保持请求条件，提交顶层 `cursor`，每页使用新幂等键。新的 Hub 游标不会回退至 Night-All；已选择直连后，停用操作、凭据错误、限流、供应商异常或未知结果也不会改走旧通道。

微博分页兼容已经验证的上游 `pagination={}`：非空页提供续页游标，空页停止，仍限制 15 页。供应商不接收 Hub 的 pageSize，不能因返回不足 pageSize 就停止。若供应商明确返回布尔 `has_next_page`，按其值处理。Hub 不自动请求下一页；其余未知分页形状仍明确失败。实际响应证据与冷启动修复见 [微博搜索诊断](weibo-search-diagnostics.md)。

## 微博全文

2026-10-09 起，Hub 将搜索摘要与详情全文分开保存。搜索结果包含“展开c”“展开全文”、末尾省略号或明确的长文标记时，仍通过原受控详情接口请求 `is_get_long_text="true"`；调用次数、费用和限流不变。

新合并策略 `weibo-detail-identity.v1` 核对帖子 ID 与详情作者；搜索有作者时必须相同。正文优先采用非空 `longText.content`；没有该字段时，仅在 `isLongText=false` 明确表示非长文的详情中采用 `text_raw`。缺失长文、未知完整性、删除状态、空正文或仍含末尾“展开”控件都拒绝。已明确完整的正文允许以作者实际书写的省略号结尾。

摘要前缀不同、表情/超话/链接展示不同、详情更短或正文已经编辑，都不再单独阻止采用有效详情。原有 `weibo_display_v2` 比较仅用于诊断，`prefixComparison.blocking=false`；全文保留表情和话题原文，不依赖不断增加表情白名单。搜索指标、发布时间和媒体保持原映射。

| 字段 / 存储位置 | 含义 |
| --- | --- |
| raw 行 `summary` | 原搜索摘要，补详情时不改写 |
| raw 行 `full_text` | 明确完整的正文；未取得时为 null，不再把摘要标为全文 |
| raw 行 `text/content` | 有全文返回全文，否则返回摘要，供现有下游继续使用 |
| raw 行 `body_provenance` | 摘要与全文各自的来源、采集时间、详情字段与身份，以及非阻塞比较结果 |
| canonical `body` | 同样优先全文，现有数据库列表与索引继续读取该字段 |
| canonical `extensions.weiboBody` | 分别保存摘要、全文及各自来源/时间，便于审计与后续升级 |

`/api/v1/data/search` 保留严格 v1 结构，列表的 `items[].text` 优先返回全文，无需下游更换 URL 或解析字段。该严格接口不新增 summary 属性；摘要可在 raw 或 Hub 管理端 canonical 扩展中查看。上游本次没有交付完整详情时，实时接口仍如实返回摘要/partial，不把数据库旧全文伪装成新采集结果。

`includeDetails=true` 可请求详情；`disableAutoDetails=true` 保留原有禁止自动补取的语义。补取最多 `maxEnrichItems` 条，默认 20，同时受请求租约、供应商操作状态、限流和采购预算约束。每个详情请求都有独立采购成本与完整响应证据，但共用原搜索的一个客户用量/钱包身份。不会因为失败或响应未知而自动重试付费请求。

未补齐的摘要原文保留，并返回 `body_completeness=provider_preview`、`data.status=partial`、`WEIBO_FULL_TEXT_INCOMPLETE` 和不完整数量，不把删除“展开”当成全文修复。

2026-10-09 补取准入修复：微博详情子调用现在复用主搜索的内部调用者策略。只有部署 UUID 白名单命中的 Key/租户跳过 Hub 本地共享 RPM；仅 `upstream_rate_limited` 熔断按原内部策略缩短至最后失败后 10 秒。普通 Key 的限额、其他熔断、操作开关、采购预算、请求截止时间和重复派发保护不变。此前微博补取遗漏了这两项内部策略，可能导致搜索成功而详情未派发。无新 migration。

用户随后要求尽量补齐：本地 RPM 暂时不足时，按令牌桶返回的恢复时间等待，仍逐条获取详情；速率熔断能在时限内结束时也等待。一次搜索累计等待最多 60 秒，每次最多等 5 秒后重新检查，且必须预留一个详情 timeout 加 5 秒收尾。等待前释放本条的采购预留和派发锁，恢复时重新核对策略、预算和派发保护；父请求的并发名额和原租约仍生效。不会提高上游或 Hub 限额，也不重发已经派发的失败/未知请求。代价是搜索可能等待更久；超过时限、预算不足、人工暂停或上游没有有效全文时仍返回 partial。

新的 partial 请求会记录单行 `weibo_full_text_incomplete` 日志，包含 requestId、详情调用数、`admissionWaitMs` 等待时间和最多一页候选的跳过原因，不包含正文、检索词或凭据。`skipped` 为空且有详情调用时，继续按原诊断脚本检查已归档的失败/合并结果。详见 [5352046656226431 的准入排查](weibo-search-diagnostics.md#2026-10-09-详情未派发5352046656226431)。

## `/api/v1/data/search`

2026-10-08 后续修复：微博、Instagram 的普通查询（`pageSize=20–100`，仍受原 Key/套餐上限约束）首屏由 Hub 直接请求上游，不经过 Night-All。`platform=ins/ig/insta` 统一为 `instagram`。用户原来的 curl 请求体无需变化：

```json
{"platform":"weibo","query":"尊界V800 支架断裂","pageSize":20}
```

返回原 `night-all.data-search.v1` 严格结构：`data.items`、`data.pageInfo`、`status/warnings/meta`。普通微博/Instagram 帖子 `title=null`，正文仍在 `text`。微博默认进行上述受控全文补取；未验证全文时保留短文，返回 partial 与 warning。字段类型、内容 ID、平台授权、原平台客户计费 meter 和按结果条数记录的 usage 不变；补详情共用一个客户请求。raw 路径继续使用 raw meter 和一个 usage 单位，两套路径不是计费别名。

新 data-search 游标为 `mxds1`，绑定 consumer、Key、平台、查询、pageSize 和 type。最多 15 页，与 raw 的 `mxraw1` 不可互换。Instagram 同时保存 `next_max_id` 与 `rank_token`，解析已知媒体网格/items；2026-10-09 增加 `status=ok` 的 list 分支，明确的 `list[].user` 账号结果和推荐词不当作帖子，list 中的明确媒体继续沿用帖子校验。只有账号的一页仍保留有效后续游标；未知或损坏项不静默丢弃。重复游标停止续页。2026-10-12 起，Instagram 上游超出请求页大小时，Hub 按请求页大小交付，并用绑定原 Key/查询/页大小/type/接口的加密游标读取同一不可变归档中的剩余记录；读完后才推进 next_max_id/rank_token。该读取不产生供应商调用（标准 meta.providerCalls=0、raw meta.upstreamCallCount=0），客户每次新分页请求仍沿用原费率、幂等和 usage 语义。归档校验 hash 和完整投影摘要，缺失/变化返回 409 search_page_unavailable，禁止重新采集补洞。游标有效期 24 小时，最多 15 个交付页；到上限仍有记录时明确 partial/INSTAGRAM_PAGE_LIMIT_REACHED。未知结构或缺少必要续页字段仍保留证据并失败。页大小小于 20 和旧 `mxnc1` 游标暂保持原采集链路。归档诊断与上线验证见 [Instagram 搜索冷却诊断](instagram-search-diagnostics.md)。

保留 `type=fresh` 默认 120 秒重放窗口，以及 `type=stable` 永久重放语义。部署验收使用新幂等键，避免把旧交付当作新实现；保留旧键则按原规则重放。原请求 fingerprint 不因迁移改变。

标题治理同时覆盖新交付的历史 data-search/raw 响应与 canonical 入库：微博、Instagram、Twitter、Facebook 普通帖子不以正文/显示名称生成标题。raw 标题为空字符串，data-search/canonical 为 null。账号、地点、话题及明确标记的文章名称保留；其他平台不改。历史供应商原文、原始响应快照和已交付重放不改写；旧 canonical 数据在后续正常入库时生成修订，不做全库回填。

## 权限、账单与历史

迁移保持原平台授权和 `raw` 客户计费 meter，不自动发放 capability、修改限额、发布价格或启用供应商操作。内部执行仍经过已审核的操作控制、采购价格、凭据、预算、限流与出站策略。直接调用 native 接口仍需要其独立授权。

微博依赖已启用的 `native.t.weibo_web_v2_fetch_realtime_search`，补全文依赖 `native.t.api_4f35621a9c07e539`；Instagram 依赖 `native.t.instagram_v3_general_search`；Twitter 依赖 `social.content.search`。只有直连请求形状使用这些操作；历史处理保留原控制。未就绪的直连操作会明确报错，不绕过管理员暂停。部署不自动启用操作，也不修改已有采购价格。

两条 raw URL 共用旧的逻辑 fingerprint。已经成功交付的旧 raw 请求直接重放其原响应，即使当时还有短文或合成标题，也不重写、不再次采集、不重复计费。原始供应商响应与新交付响应分别存储。

## 部署与验证

部署 Hub API 和 ingest worker，Delta、Luopan、Night-All 无需同步发布。按正常 migrate 流程执行新增 migration 137，再滚动更新镜像：

```bash
bash scripts/manage.sh ops internal-production deploy
```

137 只更新既有微博全文保护函数，不扫描全库、不新增付费请求、不修改旧迁移。新 worker 按帖子身份加锁，将摘要与全文分别按采集时间选择，再计算 canonical hash、修订和投影事件。新摘要可更新自身和指标，但不能覆盖已确认全文；迟到的旧详情不能覆盖较新的详情；新详情允许正文变短。原始采集记录不改写，新的 canonical 修订记录选取后的正文。采集时间单独推进不会触发内容修订或重复向量化；时间证据保存在当前扩展与不可变采集记录中。旧记录的已验证全文在下一次正常采集入库时保留并转换到新结构；尚无可验证全文的旧记录不会凭空补全。

迁移也保护滚动发布期间的新结构记录，旧 worker 的摘要/旧格式不能降级它；旧采集原始证据仍保留。作者或删除状态变化不沿用前一作者/状态的全文。136 继续只针对原请求已归档的两条未变更短文做有证据的修复，见 [微博搜索诊断](weibo-search-diagnostics.md)。历史 API 响应、旧幂等重放、已保存到下游的记录不会自动改写。

本次未改 Launcher/MX-H2I 登录、联网或支付服务。最初的路由迁移未新增付费请求；后续空分页修复经用户授权新增一次微博搜索验证，其原始响应只用于离线重放。测试使用模拟供应商、原先已获授权保存的真实详情响应，以及独立 PGlite 数据库执行迁移。覆盖别名重放、旧响应重放、全文匹配、补取失败、采购成本、空标题、15 页与跨 Key 游标边界、原始证据和全文保护。

入口：`tests/server/raw-search-routing.test.mjs`、`tests/server/weibo-long-text-migration.test.mjs`、`tests/server/weibo-separated-body.test.mjs`。SQL 测试通过 `MX_INSIGHT_TEST_PGLITE_MODULE` 指向本机 PGlite 模块；测试不连接生产。
