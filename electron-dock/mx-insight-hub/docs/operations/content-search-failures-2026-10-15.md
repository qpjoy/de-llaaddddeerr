# 策略搜索报错与字段跟进

更新：2026-10-15。本轮依据用户截图、本地 Hub／Night-All 源码及隔离回归；没有重新执行付费搜索或改生产历史。

## 当前结果：v7 固定规则已通过生产原档只读验收

用户已回传 v7。parser 与 diagnostic 的完整 SHA 均匹配文下本地源码指纹；本请求自己的调用 `bc969a1f-d327-411d-aef5-4b4c927c4124` 再次通过 348957 字节和完整 SHA 核验。候选投影接受 7 条作品、1 个非内容相关词卡，duplicateCount=0、postgresSafeItems=true、hasMore=true，下一页保留 cursor／search_id／backtrace。推荐词全部 6/6 通过固定规则，invalidIndexes=[]、truncated=false，已经补齐 v6 只采前两项的证据缺口。这确认了该原页的解析修复，不需要继续轮换诊断版本。

报告中的 committed502／succeeded_unusable／billed=true／ingest_job=false 是原失败的历史状态；只读验收没有改写历史、入库或正式交付。fillCoverage.available=false 是因为该调用历史 outcome 不是 succeeded，诊断不对失败调用模拟组页；它不否定单页候选投影成功，也不证明生产自动补页已执行。后续须同步完整 Hub 源码、重建 Hub 镜像才会应用到在线新请求，单独复制诊断脚本不改变线上解析器。快手原丢失异常仍未确定，不能将抖音验收推及所有平台。

操作人员在服务器的 `electron-dock/mx-insight-hub` 目录同步源码后按现有流程发布：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh ops internal-production deploy
```

该命令明确保留 Hub-only 发布并关闭付费数据 smoke；本轮未执行生产发布或新增供应商搜索。旧幂等键继续重放原 502，不作为部署后验证新代码的入口。

## v6 结构证据与 v7 验收方法

用户回传 v6 的源指纹匹配，原请求 `ae37ff0f-3e29-4ed7-a4e7-4178779d8cc4`／调用 `bc969a1f-d327-411d-aef5-4b4c927c4124` 的 348957 字节、完整 SHA `19edfbe3c7044f4c081a724efe45ad2532cd3f21bc651be351996226c426f102` 核验通过。index=4 卡片外层 25 个键明确包含 `related_word_list`（6 项）、`words_query_record`、`card_info` 等；data 的 4 个键为 `card_tags`、`rs_extra_info`、`hotspot_tab_config`、`common_tab_config`。`words_query_record.info` 和 `rs_extra_info.impr_extra` 都是编码的空 JSON 对象。79 个结构节点已展开，唯一截断为数组仅采前 2 项，不能据此推断后 4 项都合法。

Hub 现用 `isDouyinRelatedWordsCard` 取代未通过原档的 scalar-only 候选。按已观察的固定 schema 验证 type=6、card_type、安全的 null／对象容器、非空相关词数组以及每个词条的 related_word／word_record；最多 100 项全部验证，图片 URL 列表也全部验证。所有已出现的元数据字段都有固定类型，未知键（含 null／标量）或非空编码 JSON 均阻止非内容排除。真实 aweme_id／awemeId／aweme_info 视频继续拆包解析；未知结构继续明确拒绝，不生成假身份。完整原始 8 项仍归档，推荐词不会入库为作品；正文、媒体、分页字段及最多 3 次补页不变。

Night-All 的关键词响应适配是固定 JavaScript 规则及容器选择启发式：`lib/domains/search/tikhub-execution-service.js` 调用端点后直接调用 `normalizeTikHubResponse`；`lib/integrations/tikhub/normalizer.js` 的 `unwrapItem`、字段候选和 `isSearchEmptyContentItem` 负责拆包、映射和过滤。该卡片先取 data，因没有正文／标题／封面／图片／视频而被过滤，没有 Agent 实时比对字段。显式 Agent 搜索和可选模型摘要是其他流程。Hub 借鉴固定拆包和已确认卡片规则，不照搬递归猜数组、SHA 生成替代内容 ID 或任意空内容丢弃，以保留原生身份及付费证据边界。

以下 v7 原档验收已由操作人员完成；命令留作复核记录，无需重新搜索：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - ae37ff0f-3e29-4ed7-a4e7-4178779d8cc4 \
  < /tmp/mx-hub-content-search-diagnostic-v7.mjs
```

用户回传已确认该调用的 `archive.projection` 为 `candidate_accepts/itemCount=7/nonPostCount=1/hasMore=true`；第 4 项 `compatibility.relatedWordsCard=true`，`relatedWordsCoverage` 显示 inspectedCount=6、invalidIndexes=[]。该诊断没有更新原 committed502、账单、归档、隔离或 ingest_job；本地结构回归和生产原档接受均已通过，线上发布尚未由本轮执行。

v7 本地相关回归 87/87，无跳过：纯合同 25、网关／存储 38（6 项实际 PGlite）、诊断 24（含实际只读 SQL）。验证完整 8 项归档、7 条内容只入库一次、第 3／6 项推荐词及未知字段异常拒绝、真实 type=6 视频保留、三次补页上限、固定游标和历史付费 502 原样重放。类型检查与 diff 检查通过。原样独立包另验证五平台六份合成归档、19 次只读 SQL、知乎同秒 Date 对象的 36 唯一／20 交付模拟／16 缓冲，以及诊断隐私／预算／原档来源门槛。该包 parserSha256=`a972eb6bf0a855f506873e137038b7ff77024bd29e4b1621491e6921e703a09e`，diagnosticSha256=`25748c791d424b955baa988d5e59116214c56dead9fa61517c3b9ac969f64644`，bundleSha256=`326ac37cda56085f96d0d01bbc986384eef495db43ae5efc906349768dd7f76c`。未冒充原 SHA 生产归档做本地正例。

## v5 拒绝与 v6 结构诊断历史

用户回传 v5 指纹完全匹配，原 SHA／348957 字节仍核验通过，但第 4 项 `emptyMaterialCard=false`，整页继续拒绝 invalid_content_search_identity。data 的 4 个值为 3 个 null 和 1 个对象；外层除 data 外还有 5 个对象、1 个数组。因此 scalar-only 候选没有修复原事故，不能宣称已返回 7 条或线上恢复，当前未知嵌套结构拒绝符合设计。

此前固定字段白名单只报出已知字段缺失，没展示真实未知结构。本轮 v6 改为唯一事故的 schema-only 模式，必须同时满足原请求／调用 UUID、完整 SHA、348957 字节、TikHub／固定 V1 operation/endpoint/version/contract、8 项数组和 index=4/type=6；完整字节长度／SHA 校验先于 schema，且只在原请求自己的调用启用，其他记录继续使用固定字段模式。这里的原 endpoint_key 是 `native.t.douyin_search_fetch_video_search_v1`，不可错用公开配方 key `t.douyin_search_fetch_video_search_v1`。

schema 优先展开 card.data，再检查其余外层字段；只显示短 ASCII 技术字段名、类型与容器大小，不输出正文、标量 ID、URL、关键词、凭证或字段值。含数字、疑似长 token、非标识符、保留键的名称整体哈希。字段记录用数组避免原型键冲突；上限为卡片根深度 0 起最多深度 8、全局 300 个实节点、每数组 2 个样本；最大 64 KiB 的编码 JSON 字符串也只展开结构。所有深度／节点／采样截断均明确报告，截断部分不能用于非内容排除判断。该模式会显示短技术字段名，并不声称词法过滤可以证明任意纯字母动态映射键都非个人信息。

将已生成的独立 v6 文件复制到服务器 `/tmp/mx-hub-content-search-diagnostic-v6.mjs`，无需同步仓库或发布，然后执行：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - ae37ff0f-3e29-4ed7-a4e7-4178779d8cc4 \
  < /tmp/mx-hub-content-search-diagnostic-v6.mjs
```

只需回传原调用 `bc969a1f-d327-411d-aef5-4b4c927c4124` 的 `archive.incidentCardSchema`，或完整 JSON。这仍只读原归档，不采购、计费、更新状态或自动解除任何锁。本轮只改诊断及文档；v6 诊断 22/22（含实际 PGlite）、原样编译包五平台／事故来源门槛／预算／隐私验证通过，未伪造原 SHA 的完整正例。本轮 parserSha256 保持 4b31fc01…，diagnosticSha256 为 f962d5c8…、bundleSha256 为 af013a9e…。

## 已确认并修复的本地缺口

- 产品展示原先对任意 sending/uncertain 请求禁用整个平台 fieldset。现在平台按钮始终可选择；未知状态只锁原平台的请求，切回保留原参数、幂等键和只读核对入口。切换不会发送请求；其他平台须显式点击搜索。接口调试的既有全局安全阻止保留，父页面提示准确区分两者。
- HTTP correlation ID 与 durable usage UUID 原先可能混用。组页流程的新错误在 details.requestId 携带实际账本 ID；界面优先使用明确的账本证据，分别标注 Hub 请求 ID 与幂等键。只读核对仍校验身份、路径、参数和已知账本 ID，不因错误或切换自动解锁。
- 快手已知反馈卡的 ID 可能位于 external_id/externalId 或 feed/photo 包装。沿 Night-All 白名单识别；仅在缺少真实内容身份、作者、媒体、时间和指标证据时排除诊断卡。未知行仍失败，不把任意结构静默丢弃。
- 数字 HTML 实体 D800–DFFF 不是有效 Unicode 标量。原投影会把它转换为 PostgreSQL 无法保存的单个代理字符；现在保留该实体原文，正常 Unicode／emoji 继续解析，完整原始回执不变。
- 微博补齐 Night-All 已声明的 flat 指标别名、浏览与收藏字段，真实 0 保留、缺失或无效值为 null。协议相对 post_url 补 https，保留原路径与查询参数；正文、原生媒体、原始归档及既有响应重放不改。

微博旧投影已经支持 interaction.like_count/comment_count/repost_count 和 likes/comments/reposts，因此不能仅凭截图断定全零就是这一别名缺口。两个快手／字符修复也尚未与截图的原归档建立因果对应。

## 待核对的线上记录

| 截图 | 显示的 HTTP 请求 ID | 显示的幂等键 | 状态 |
| --- | --- | --- | --- |
| 快手 | c3095da0-1784-49d0-a36a-010b6bb18abc | 340b2144-869f-4854-a4fc-dcbbbee534bf | request_outcome_unknown |
| 知乎 | fa239430-0c00-4738-b388-5476e707b2ca | 7969fff8-7e04-4d09-b5ab-2540ccb42760 | request_outcome_unknown |
| 抖音 | 25991b77-3439-4f27-9dfb-175d28c1b189 | 截图未显示 | external_platform_response_unusable |

HTTP 请求 ID 未必就是账本行 ID。只读诊断同时按 supplied UUID 和 idempotency_key 查找。抖音的隔离拒绝本身不证明这次请求派发过，也不能据此放开隔离重采。

## v2 原归档证据（2026-10-15 用户回传）

- 知乎 `fa239430-0c00-4738-b388-5476e707b2ca`：原请求为 unknown／external_platform_persistence_unknown，两个自己的子调用分别为 `a72a8f66-b7a0-4e26-8f5b-9666505f8bbb`、`fb5c274b-797c-4f49-b7df-9d18ad5374a9`；两次均 succeeded、HTTP/business 200、billed=true、18 条。两份完整归档分别为 258680、280783 字节，SHA 已核实，operational archive、archive object 和 ingest job 均存在。候选逐页投影各接受 18 条并排除 2 个非帖子，均保留下一页。任务存在不等于 canonical worker 已完成；最终父请求未知，不能重新付费采集。
- 快手 `c3095da0-1784-49d0-a36a-010b6bb18abc`：父请求在开始约 3 秒后标记 persistence unknown。子调用 `2070972c-856d-4b9b-8323-13941e911907` 后被 reaper 标记 reservation_lease_expired，HTTP／业务状态／billed 均未知，三个归档／任务位置均缺失。53 秒时间差不能证明供应商超时、未执行或未收费，不能解锁重采。
- 抖音 `25991b77-3439-4f27-9dfb-175d28c1b189`：本次请求 released、没有自己的派发。前置隔离候选 `bc969a1f-d327-411d-aef5-4b4c927c4124` 的 348957 字节完整回执 SHA 已核实，HTTP/business 200、billed=true，但候选解析仍拒绝 invalid_content_search_identity。已知包装为 `payload.data.data` 数组 8 项、aweme_list=null，前两项带 aweme_info；当前解析器已经支持该包装，现有信息不足以判断剩余条目的身份或类型，不按猜测过滤未知条目。
- 微博同 Key／同截图关键词候选 `78dfbef4-0bbd-41a3-9c1a-7c43a20a6e6b`：10 条的 `interaction.like_count/comment_count/repost_count` 原始数值全部为 0，当前候选投影保留这些 0；浏览与收藏原始字段缺失，保持 null。10 条 post_url 均为协议相对地址，前一轮 https 修复可投影出 10 个原文链接。没有证据表明这份归档的非零互动被 Hub 丢失，也不能由上游 0 推断真实平台互动为零。

快手现有账本无法还原丢失的原异常。内容搜索 workflow 已补仅限固定失败阶段、错误类别、SQLSTATE 和持久请求／调用 UUID 的日志，禁止异常消息、SQL、stack、关键词、正文及凭证；日志本身失败也保留原 unknown／钱包 hold／租约行为，没有新增数据库写入。

知乎本地复现并修复了与 18+18／pageSize20 一致的最终提交缺陷：第二子页剩余 16 条时，buffer.providerCursor 与 job.providerCursor 共享对象引用，严格 JSON 树校验拒绝整个 manifest。现在复制固定标量游标，保留严格 JSON 校验及已有未知账本；完整 gateway 和实际 PGlite 回归验证完整归档、20 条组页、16 条缓冲和一次父结算。后续用户回传的 v3 已确认原两档没有跨页重复，见下节；原 unknown 状态保持原样。

## v3 用户回传确认与 v4 定位

用户回传的 v3 指纹与最终独立包匹配（parser=db6de818…、diagnostic=db7d39d3…）。知乎两份自己的 SHA 校验归档已只读确认 36 条唯一内容、模拟交付 20 条、缓冲 16 条；每页 18 条均 PostgreSQL-safe，旧最小共享游标状态不符合 JSON 树，复制后符合。该报告是原归档的纯消费模拟，没有向客户正式交付、更新 unknown 或证明生产最终事务已执行。

抖音前置同端点归档 `bc969a1f-d327-411d-aef5-4b4c927c4124` 共 8 项：0–3、5–7 均为 type=1、带有效字符串 aweme_id 的视频，逐条候选投影接受且 PostgreSQL-safe；第 4 项为 type=6、data 对象、无直接 aweme_info／data.aweme_info，选中层身份及内容字段均缺失。不能据此删除所有 type=6：v3 没有展开其 data 内部，真实 data.awemeId 视频也可能被旧拆包逻辑遗漏。

本轮已修复 data.awemeId 固定路径别名拆包，直接／嵌套 aweme_info、snake/camel 身份及带真实内容的 type=6 保留。未知卡片仍明确拒绝并保留付费归档，不用假 ID 或数字类型猜测掩盖错误；尚不能宣称第 4 项线上卡片已修复。[官方精确 V1 文档](https://docs.tikhub.io/370212779e0)没有 type=6 的完整定义；[多重搜索文档](https://docs.tikhub.io/370212783e0)中的 type=6／cha_info 话题定义属于另一接口，不能仅按数字移植。

v4 只对 type=6 或投影拒绝项增加 cardShape：固定白名单字段类型、身份状态、键数量、已知卡片标记及最多两层嵌套结构；整个报告共享 24 个详细节点上限，不输出任意字段名、正文、ID、URL 或游标值。读取原供应商归档所属的请求 `ae37ff0f-3e29-4ed7-a4e7-4178779d8cc4`，避免把后续 released 请求误认为有自己的采购。将独立脚本复制到服务器后执行：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - ae37ff0f-3e29-4ed7-a4e7-4178779d8cc4 \
  < /tmp/mx-hub-content-search-diagnostic-v4.mjs
```

用户已回传 v4。该版本 parserSha256 为 5d5b2fbe929f1f00c3d8916f1fb5160cd1130d0cc3b1d5fde967d300be6dcd8c。

## v4 原卡片证据与 v5 候选验收

v4 直接找到原请求 `ae37ff0f-3e29-4ed7-a4e7-4178779d8cc4` 为 committed／502，属于自己的付费调用 `bc969a1f-d327-411d-aef5-4b4c927c4124` 及完整 SHA 为 19edfbe3… 的 348957 字节归档。第 4 项外层有 type=6、数字 card_type、明确 aweme_list=null、data 对象；data 有 4 个键，外层／data 的已检查身份、正文、媒体、作者、统计、时间、URL 及已知内容容器均缺失，不能命名这些未知键为话题／广告。

候选新增 `isDouyinEmptySearchCard`，只对这个空内容包装做兼容：自有安全非负整数 card_type、自有 aweme_list=null、自有普通 data 对象及数字 type=6 缺一不可；外层／data 任何已知内容字段（含 null、空对象、空数组、0）都阻止排除；未知嵌套对象／数组也阻止排除，不递归抽取未知容器或生成假身份。外层除 data 外和 data 的未知值必须为无损 JSON 标量／null。符合时仅计入 nonPostCount，完整原生 8 项仍存归档，7 条真实内容可继续投影和入库一次；真实 type=6 视频与未知卡片保持解析／明确拒绝。

v4 没有输出未知键的值类型，尚不能证明原卡片全部满足标量限制。v5 包含修复后的候选和固定值类型计数（不输出未知键名／值），一次验收原档是否为 `candidate_accepts/itemCount7/nonPostCount1/hasMoretrue`、第 4 项 `compatibility.emptyMaterialCard=true`，并保留原 SHA。此验收只读，原 committed502／账单／归档／隔离状态／ingest_job 不会被改写。执行：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - ae37ff0f-3e29-4ed7-a4e7-4178779d8cc4 \
  < /tmp/mx-hub-content-search-diagnostic-v5.mjs
```

只需贴回调用 `bc969a1f-d327-411d-aef5-4b4c927c4124` 的 `archive.projection` 和 `archive.entryCoverage.entries[4].compatibility`，或完整 JSON。v5 parserSha256 为 4b31fc01f5ccf9a27d68047cb488d7a815b684c9ddf8f548a3e9893b883a6e19，独立脚本无需先部署。

`server/ops/diagnose-content-search.mjs` 使用 REPEATABLE READ READ ONLY 事务、语句／锁超时、固定端点及有限来源查询；校验受限字节长度／SHA／UTF-8 后只输出路径形状、条数、阶段凭据状态和当前候选投影结果。与已找到记录同租户／消费者／Key 的微博和抖音截图关键词，额外限定 48 小时、各最多 3 条，标记为候选而非已证明的对应请求。不输出正文、关键词、原文 URL、密钥或任意异常信息。

构建独立 stdin 诊断：

```bash
node scripts/build-content-search-diagnostic.mjs > /tmp/mx-hub-content-search-diagnostic-v7.mjs
```

可将本地已生成的同名脚本复制到服务器，无需先发布或依赖服务器仓库版本。执行：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - \
  c3095da0-1784-49d0-a36a-010b6bb18abc \
  340b2144-869f-4854-a4fc-dcbbbee534bf \
  fa239430-0c00-4738-b388-5476e707b2ca \
  7969fff8-7e04-4d09-b5ab-2540ccb42760 \
  25991b77-3439-4f27-9dfb-175d28c1b189 \
  ae37ff0f-3e29-4ed7-a4e7-4178779d8cc4 \
  < /tmp/mx-hub-content-search-diagnostic-v7.mjs
```

当前构建顶层版本为 content-search-diagnostic.v7，implementation=bundled_local_candidate。指纹以新构建元数据为准；旧 v6 parserSha256 为 4b31fc01f5ccf9a27d68047cb488d7a815b684c9ddf8f548a3e9893b883a6e19。原始 unknown、失败和 stable 零值响应保持原样，不解锁、重写或退款。

## 诊断脚本 v2 修复

v1 在根据固定端点元数据生成版本探针时，假定 query/keyword 必须被标记 required；抖音 V1 的关键词为可选元数据，会触发 diagnostic_contract_changed 并中断整批。Bilibili 则另外要求 order/page/page_size，单独提交关键词也会失败。v2 使用四个平台已测试的完整纯请求配方解析版本，微博使用固定 query/page；只解析元数据，不派发供应商。

新增隔离 PGlite 的全五平台批量查询、同 Key follow-up、编译后独立脚本回归。失败输出还会包含固定白名单 stage、错误类型、SQLSTATE 及相关 UUID，禁止输出异常消息／SQL／业务内容；无效时间值作为有界投影失败返回，不能中断整批。v1 独立文件不再使用。

v3 增加抖音已观察固定数组的逐条安全结构报告 entryCoverage：最多 50 项、固定字段类型、受限类型枚举、身份值是否为有效字符串／安全正整数／不安全整数及逐项投影结果，不输出 ID、正文、URL 或游标。整页及逐项投影新增 postgresSafeItems，区分“可投影”与“可存 JSONb”。fillCoverage 按取得时间顺序读取最多 3 份本请求自己的完整成功归档，使用实际下一页参数做纯投影、跨页排重及页内消费模拟；只报告条数和最小游标状态是否共享引用／可作为 JSON 树，明确标为 offline_consumption_simulation／minimal_cursor_state_only，并非读取到原持久 manifest、正式交付或历史修复。两项诊断均纯只读，不更新账本或清除隔离。定位本轮抖音及知乎时只需传入 `25991b77-3439-4f27-9dfb-175d28c1b189` 和 `fa239430-0c00-4738-b388-5476e707b2ca`，回传抖音 archive.entryCoverage 与知乎 fillCoverage 即可。

## 验证与发布边界

前一轮相关回归 532 项：528 通过、0 失败、4 项既有真实 PostgreSQL 条件测试跳过。实际 PGlite 验证只读诊断 SQL、同 Key 候选范围、JSONb 字符安全、字段投影及原子计费／归档；组件事件与真实 Chrome mock 验证未知平台切换和 351px 布局，无真实业务请求。类型检查与构建通过。本轮 runtime／路由／交互回归 148 项均通过（3 项本地监听受沙箱 EPERM 阻止后在允许 loopback 的环境重跑所在 91 项 suite 全部通过），v3 诊断 14/14 通过，含实际只读 PGlite SQL、八项逐行诊断、18+18 离线消费模拟、去重、同秒 PostgreSQL Date 对象毫秒顺序及异常归档拒绝。Gateway／store 的 31 项包含 6 项实际 PGlite，原 billing trigger、20+16 缓冲及事务回滚均验证。类型检查再次通过。

本轮新增别名／未知卡片回归：纯合同与网关 40/40、网关与存储 33/33（其中 6 项实际 PGlite），v4 诊断与合同 33/33（诊断 16、合同 17），无跳过。完整原始回执、失败重放、不自动重试、一次 ingest 以及真实零值／签名媒体均验证。

此前 scalar-only 候选集成回归 76/76 无跳过、类型检查及原样独立包五平台只读数据库验证通过；该候选仍被原 v5 归档拒绝，已由文首 v7 的相关词卡规则取代。旧本地用例通过不代表原档符合其假设。

知乎原档跨页唯一性与可复现提交缺陷已确认；抖音 v7 固定规则已通过原档全部六项及 7 条作品／1 推荐卡／下一页验收；快手原异常仍未确定，不能以这些验证宣称线上全部恢复。历史 quarantine_candidate 只表示当时同端点的候选，不能据其记录推断当前仍隔离；响应冷却／熔断可能自然到期，发布不会主动清除它们或恢复 unknown 请求。本轮不更改授权、价格、采购／隔离控制、历史账本或 MX-H2I／Launcher 登录联网；发布仍由操作人员重建 Hub 镜像（MX_INSIGHT_SYNC_LAUNCHER=0、MX_SMOKE_DATA=0），仅复制诊断包不会修复在线功能。
