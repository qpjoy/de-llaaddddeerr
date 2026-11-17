# Twitter 评论与回复默认 RapidAPI

日期：2026-11-17。最新状态：已保存的 TweetDetail 200 响应在只读复验中确认被时间线指令校验拒绝；本地已补齐 TimelineTerminateTimeline，待部署后再次检查同一归档。累计仍为 2 次供应商 HTTP 请求，thread-replies 未尝试；两个评论接口最后确认仍固定 TikHub、revision 3。兼容验收尚未通过。此次只修改 Hub，不修改 Launcher、MX-H2I、登录、SSO 或联网配置。

## TimelineTerminateTimeline 适配修复（当前执行）

用户返回的固定归档 hashVerified=true、jsonSafe=true，保存错误码为 invalid_social_contract。结构摘要为 ClearCache、AddEntries、TerminateTimeline 各一条，1 个 focal 条目、39 个会话模块、1 个非空 Bottom 游标，40 个 Tweet 且无已知字段异常；parser 在原第 29 行的未支持指令分支失败。该解析器未接收 TerminateTimeline，足以导致整个响应成为 succeeded_unusable / Hub 502。结构摘要未给出结束方向，不能据非空游标推断为 Top，也不能据此确认后续所有字段已兼容。

修复严格接收 X 官方定义的 Top、Bottom、TopAndBottom 三种方向及 type / __typename / direction 元数据；如有 __typename，必须与指令类型相符。Top 保留向下游标；Bottom / TopAndBottom 保留本页业务行并停止供应商向下续页，已购溢出仍通过 Hub 缓存分页交付。未知方向、未知指令和夹带业务字段仍拒绝，不静默遗漏评论。依据：[X 官方方向序列化实现](https://github.com/twitter/the-algorithm/blob/c54bec0d4e029fe34926ef3258a86ccacc0d0182/product-mixer/core/src/main/scala/com/twitter/product_mixer/core/functional_component/marshaller/response/urt/TerminateTimelineInstructionMarshaller.scala)。底部结束优先于残留游标是按终止语义采取的保守处理，尚不是本份真实归档已验证的方向组合。

请求参数、标准评论字段、raw_data 别名、签名游标和历史失败回执保持原契约。诊断脚本新增结束方向与字段结构计数，未知值统一为 other，不输出原始字段名或值。

这次修改了镜像内的解析器，**需要重建并滚动更新 Hub**，仅同步诊断脚本不会加载修复。同步代码后在服务器 Hub 目录执行：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh deploy

kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-public -c api -- \
  node --input-type=module - \
  < server/ops/diagnose-twitter-rapid-comment-page.mjs
```

第二步只读使用原 200,594 字节归档，供应商新增调用应为零。需要确认 parser、projection、workflow 三项均为 ok=true，并检查 terminateTimeline 方向与计数；若仍失败，使用受审代码行号继续定位，无需重新买首屏。旧 committed/502 回执不会被修改为成功，原幂等键仍回放原失败。总额度仍剩一次，本步骤不使用该额度、不切换生产路由。

本地验证：先以合成三指令响应复现原 parser 失败和真实网关 HTTP 200 → Hub 502，再完成修复；54 项相关测试通过、零跳过，覆盖三方向、指令顺序、异常元数据、评论与回复公共字段、底部结束后的缓存排空、失败回放、TikHub 和手动分页。包含真实迁移 schema 的 PGlite 只读查询测试；没有调用生产供应商。实际归档的修复后结果仍待服务器返回。

## TweetDetail 200 响应不可交付：只读检查保存归档

最新 usage 为 `e531d032-0bfa-463e-9e0f-ff10e2457a5d`，provider call 为 `783683dc-0dde-45ac-9c9c-76753f9c8949`。usage 为 committed/502，供应商回执为 succeeded_unusable/200/billed=null。完整响应 200,594 字节，SHA-256 为 `34747817708f7dd6e4ab1b8dd9f4b92f20f2fd5c8f96165e347532d3a35fa2a6`，归档长度和哈希已验证。

这是新接口已经返回响应、但尚未形成可交付评论结果的证据，不是业务兼容验收成功。`billed=null` 表示账本尚不能确认供应商计费。原 TikHub 源、首次 404 回执和固定 TikHub 路由均保持不变；总三次额度还剩一次，不能再次购买首屏来获取相同诊断材料。

本次顶层 `verification_unavailable` 还暴露了验证工具错误码白名单遗漏：评论工作流明确抛 `external_platform_response_unusable`，旧脚本未收录，因而泛化显示。读取已存 usage/provider/public 错误码可进一步确定失败阶段；仅凭 HTTP 200 和字节数不能判断具体字段或指令问题。

同时修正执行报告中的剩余额度显示：`remainingSupplierCalls` 现在按执行后的保存调用数计算；这份回执累计两次，应剩一次，原来的数字二是执行前的值。预算门槛和采购流程没有变化。

专用 `server/ops/diagnose-twitter-rapid-comment-page.mjs` 仅读取上述固定 usage/call 及受限归档，验证身份关联、长度和固定 SHA，再以已部署的解析与投影代码离线检查。输出只包含白名单结构、计数、代码版本哈希与受审文件的行号，不包含正文、作者、帖子 ID、游标或凭据。不初始化运行时、不写 usage、不中转新业务请求。

脚本分别报告 parser、projection 和 workflow 结果。为避免读取供应商凭据，离线回放不执行生产工作流中的凭据回显脱敏步骤；即使离线三阶段全部成功，也不代表原请求或线上交付已经成功。首次复验已定位到未支持的结束指令，修复后的实际归档结果仍待确认。

仅更新诊断脚本时，可同步到服务器 Hub 工作目录后执行，无需重建镜像；本轮解析器修复则需要先执行上节的部署命令：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-public -c api -- \
  node --input-type=module - \
  < server/ops/diagnose-twitter-rapid-comment-page.mjs
```

已有 thread-first 回执后，原 `--resume-thread` 按设计只读取历史，不自动续买。先依据已保存字节定位并验证字段适配，再决定如何使用剩余的一次授权额度；不修改原失败回放或把旧回执标记为成功。

前次诊断工具验证：probe 与专用诊断合计 23 项测试全部通过、零跳过，包含真实迁移 schema 的 PGlite 查询、归档哈希拒绝、三阶段失败定位、输出脱敏、stdin 执行，以及 HTTP 200 不可交付后重复诊断不增加供应商调用。测试均使用本地合成数据，未调用生产供应商。

## 续验脚本状态校验修复（已完成）

用户返回 `read_saved_only / resume_source_unverified`，新增供应商调用为 0；固定的原 request/call ID、77 字节 SHA-256、502/404、rejected、billed=false 及路径匹配均通过显示。代码检查发现 guard 错误要求旧 usage 为 `released`。真实 RapidAPI `finishFailure` 会把明确拒绝保存为 `committed + HTTP 502 + units_actual=0`，这里 committed 表示失败响应已经存档，不代表成功交付。原测试也手写了 released，遗漏了真实失败生命周期。

修复只把此状态条件改为真实的 committed/502；保留所有固定身份、哈希、供应商拒绝和调用预算条件，继续拒绝 reserved/unknown/released。新增 `resumeSourceInspection`，仅显示固定状态、逐项布尔校验及 `failedChecks`，不输出帖子 ID、请求正文或供应商原始消息。guard 修订为 `twitter-rapid-thread-guard.v2`；原诊断 revision、五个幂等键及所有历史记录不变。

本次只需同步 `server/ops/verify-twitter-rapid-comments.mjs` 到服务器工作目录，**无需重建镜像、重新部署或执行数据库迁移**。然后在 Hub 目录运行：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-public -c api -- \
  node --input-type=module - --resume-thread \
  < server/ops/verify-twitter-rapid-comments.mjs
```

可选：去掉 `--resume-thread` 只读查看新增校验摘要。正常原回执应显示 `usageStatus=committed`、`usageHttpStatus=502`、`failedChecks=[]`。有任何不匹配仍停止。续验最多剩余 2 次请求，默认路由保持 TikHub；不删除或重置旧记录，也不重买旧 `/replies` 请求。

本次专项 14/14 通过（含真实 PGlite 查询，0 跳过）。新增离线 RapidAPI 404 → 网关 → 实际 Memory store `finishFailure` 回归，确认 committed/502/零交付用量以及同键失败回放零新增采购；released/reserved/unknown 均不能续验。固定归档及总三次预算未放宽。`git diff --check` 通过，未调用生产供应商。

## TweetDetail 首次安装与恢复步骤（保留记录）

恢复事务已提交：`post-comments` 与 `comment-replies` 均为 `fixed / tikhub / null / revision 3`。本次恢复和归档诊断没有供应商请求。`billed=false` 是保存的采购记录，不能用它推断 RapidAPI 月账单；该 HTTP 请求仍占本轮最多 3 次额度中的 1 次。

新修复使用供应商 [Tweet with replies 文档](https://www.twittrapi.com/docs/reference/tweet-tweetid)中的 `GET /tweet/{tweetId}`，新增独立操作 `native.r.twitter_aio_tweet_thread`。旧 `/replies` 操作、历史回执及游标合同保留。新路径同样需要真实回执确认，文档存在不代表当前订阅一定可用。

标准接口、请求参数、返回字段及旧别名不变；Hub 内部投影会过滤 focal 帖子、会话根和明确祖先，保留回复身份、真实父级关系及未知计数的 null。迁移 192 只登记新采购操作，不修改两条已经恢复的路由。此前迁移 191 已部署，不改写它。

同步本次代码后，在服务器 Hub 项目目录执行：

```bash
cd /root/mx/workspace/de-llaaddddeerr/electron-dock/mx-insight-hub
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh deploy
```

部署成功后，使用新的显式续验命令：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-public -c api -- \
  node --input-type=module - --resume-thread \
  < server/ops/verify-twitter-rapid-comments.mjs
```

工具先校验原失败 usage/call UUID、77 字节、固定 SHA-256、404/rejected/billed=false、目标路径匹配，以及两条路由仍固定 TikHub。随后仅用新操作最多请求“帖子评论首屏”和“评论回复”各一次；使用原调用方身份，正常权限、采购、计费与归档控制生效。旧 1 次与新最多 2 次共同计入原 3 次预算。遇到失败或未知结果立即停止，不自动重试；已有任一 thread 验证记录时，重跑只读取保存结果。

本轮剩余额度不覆盖真实上游下一页，报告明确保持 `upstreamContinuationVerified=false`；不能将两次成功解释为全链路验收完成。此工具也不覆盖公网 Ingress。不会自动把路由改回 RapidAPI。默认无参数或原 `--execute` 命令只读取已存在的旧回执。

本次修复的本地回归：134 项通过、0 失败、0 跳过，包含真实 PGlite 迁移/恢复/预算查询、原生传输、标准字段及别名、旧 signed cursor 的缓冲排空和固定旧端点续页、失败幂等回放。`npm run typecheck`、`git diff --check` 通过。未从本机调用生产供应商；新的 TweetDetail 修复尚待服务器同步、部署和真实限额验证，验证等级仍为 `derived`。

## 之前的实施与诊断记录

以下保留首次部署与失败诊断时的历史步骤；当前执行命令以上一节为准。

用户随后授权少量付费请求验证兼容性。本轮最多 3 次 RapidAPI 上游请求：帖子评论首屏、其续页、一个评论的回复页。使用已有 TikHub 归档作对照，不重新付费搜索帖子或重采 TikHub。取得真实回执前仍保留 `derived` 标记。

## 接口与默认策略

复用现有 Twitter AIO 的 RapidAPI 凭据及主机 `twitter-aio.p.rapidapi.com`。供应商公开的 [Tweet replies 合同](https://www.twittrapi.com/docs/reference/tweet-tweetid-replies)提供 `GET /tweet/{tweetId}/replies`；帖子评论传帖子 ID，评论回复传评论 ID。帖子与评论都是 Tweet，不需要新供应商账号或改成直连 TwittrAPI 的鉴权方式。现有订阅是否允许该端点仍由实际账户状态决定。

| Hub 业务 | 本轮结果 |
| --- | --- |
| Twitter 标准搜索 | 沿用既有 RapidAPI 优先、TikHub 保底策略 |
| Twitter 账号内容、账号资料 | 沿用既有 RapidAPI 路由 |
| Twitter 帖子评论 | 新增 RapidAPI，默认 RapidAPI 优先、TikHub 保底；JustOne 仍可选 |
| Twitter 评论回复 | 新增 RapidAPI，默认 RapidAPI 优先、TikHub 保底 |

入口为 `/api/v1/data/social/post-comments`（含原两个 `search/post-comments` 别名）和 `/api/v1/data/social/comment-replies`。普通业务调用继续使用原 `social.comments.list` 授权。新增独立原生操作为 `native.r.twitter_aio_tweet_replies`；原生入口需要其自己的授权，不自动增加租户权限。指定供应商的原生接口和历史 Night-All 路由不被统一策略改写。

迁移 `191_twitter_rapidapi_comments.sql` 仅将 migration-181 留下、审计与原因匹配、修订仍为 1 的原始 Twitter 默认策略升级至修订 2，并添加审计。已保存的人工固定、优先、暂停策略保持原值；如需改动，仍在对应管理页填写原因后保存。历史 TikHub recipe 保留，已有请求重放与游标继续绑定原供应商。

## 调用与响应边界

- 一次业务请求最多购买一个 RapidAPI 源页；不为凑满 `count` 自动购买下一页。已购余量继续由原缓冲交付，后续按 Hub 返回的游标显式续页。
- RapidAPI 未就绪时只在首次派发前选择 TikHub；已发出的拒绝、超时、未知结果或解析失败不会自动跨供应商重购。Twitter 标准搜索原有的特定 HTTP 400 保底规则不扩展到评论。
- 固定数字路径参数与供应商主机，不允许任意 URL、`count` 或 `format` 透传。默认 `rankingMode=Relevance`、`includePromotedContent=false`。
- 使用 raw TweetDetail 布局，处理 conversation 模块、可见性包装和 Bottom 游标。保留长正文、已提供的父子关系；未知指标保持 `null`。不递归把引用帖子、祖先或推荐内容当作评论。
- 供应商说明回复响应与 TweetDetail 使用同一布局，但回复页尚无独立公开响应样例。因此实现标记为 `derived`，页面显示“按已知合同结构适配，首个生产页待核对”，不能称为已付费样本验证。测试响应均是依据公开结构构造的离线数据。

## 调用方字段兼容

RapidAPI 响应经 Hub 投影后继续使用原来的 `post-comments.v1` / `comment-replies.v1` 合同、URL、请求参数和授权。调用方无需理解供应商的 `instructions` 或 module 结构。

| RapidAPI 原始字段 | Hub 原有字段 | 兼容要求 |
| --- | --- | --- |
| Tweet `rest_id` / `legacy.id_str` | `commentId`、`id`、`externalId`、`content_id` | 字符串 ID，不转浮点数 |
| `note_tweet` 正文或 `legacy.full_text` | `text`、`content`、`full_text` | 保留完整正文和空白 |
| `core.user_results.result` | `author`、`author_id`、`author_name`、`authorHandle` | 保留原字段类型；缺失值不编造 |
| `legacy.created_at` | `publishedAt`、`publishedTime` | 前者归一 ISO，后者保留供应商时间字符串 |
| `favorite_count` / `reply_count` 等 | `likeCount` / `like_count`、`replyCount` / `reply_count`、`metrics` | 缺失为 `null`，实际零值为 `0` |
| `conversation_id_str` / `in_reply_to_status_id_str` | `conversationId`、`parentExternalId`、`parentCommentId`、`parentRelationship`、`replyRef` | 区分根帖、直接父级和未知关系 |
| 顶层 Bottom 游标 | `page`、`pageInfo` 的 Hub 不透明游标 | 绑定原供应商，不向调用方暴露供应商游标 |

`items` 与 `comments` / `replies` 别名保持一致；`raw_info` 仍是字符串 `'[]'`，`raw_data` 仍是 `JSON.stringify(items)`。`includeRaw` 继续按原请求控制，默认不返回原始供应商对象。字段匹配比较身份、类型、别名和关系；不同时间、排序和供应商造成的评论集合或互动量差异不应被误报为接口字段不兼容。

离线回归已修复一个已有边界：当 Twitter 帖子评论的目标本身是一条回复时，外层 `postId/contentId` 保留请求目标，但 `replyRef.contentId` 使用已知的真实会话根帖，避免下一次查回复因根帖 ID 冲突而失败。未知的 timeline instruction 不再被静默略过；完整归档后报告合同不匹配，待根据真实样本适配，不能把未知非空页返回成“没有更多”。

## 发布与只读验收

用户要求先付费验证兼容性再切换默认。若本轮代码尚未部署，先将新脚本同步到服务器，在 Hub 目录对原默认配置记录一次“保持当前路由”的审计修订：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-public -c api -- \
  node --input-type=module - --apply \
  < server/ops/preserve-twitter-comment-routes.mjs
```

该工具不改变 mode、primary 或 fallback，仅对 migration-181 留下的未修改默认增加修订及原因，使迁移 191 保留当前调用方路由。人工保存过的策略不会修改；重复执行不追加审计。去掉 `--apply` 可只读查看。返回 `rapidAlreadySelected:true` 说明 RapidAPI 已经是当前策略之一，此工具不会撤销已发布的策略。

然后在 Hub 项目目录执行完整 Hub 发布。只有在完成上述路由保留步骤或明确已经保留人工策略后，才能按“先验收、后切换”顺序发布：

```bash
cd /root/mx/workspace/de-llaaddddeerr/electron-dock/mx-insight-hub
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh deploy
```

这两个开关跳过 Launcher 同步及业务数据采样；正常 Hub 数据库迁移、镜像构建、服务滚动更新仍会执行。不能只替换前端或跳过迁移 191。

迁移本身将新增采购操作注册为 `disabled`，不写入价格。完整发布已有的 `seed_default_price_books` 阶段会补齐缺失估算价格，且仅对审计证明未被人工修改的初始禁用操作设为 `active`；显式价格、预算与人工状态保留。既有缺价默认值为账本币种的 0.01，仅是 Hub 采购估算，不是本次查证的 RapidAPI 实际单价。只执行迁移、价格补齐失败、凭据缺失或人工禁用时，RapidAPI 仍可能未就绪；这是采购操作就绪，和全局策略是否选择它是两件事。

安装了新合同后，执行本轮已授权的限额验证：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-public -c api -- \
  node --input-type=module - --execute \
  < server/ops/verify-twitter-rapid-comments.mjs
```

去掉 `--execute` 是纯只读预检，即使旧镜像缺新合同也可先读取历史源摘要并返回 `needs_deploy`。工具复用真实 TikHub 请求 `7e7cd2d0-aa97-4aa5-a113-5a92f8b3143b` 的归档和原调用方身份；不会发出新的 TikHub 请求、增权、调整价格或改全局策略。独立进程直接指定新 RapidAPI 网关，正常授权、采购控制、计费与归档仍生效。固定三个阶段及幂等键，数据库锁阻止并发，已有任一验证回执时重跑只读旧回执，不自动续购；失败或未知结果停止。

输出仅包含兼容检查与回执摘要。三次预算不保证三个阶段均有数据：没有游标、没有回复候选、只有缓冲余量或有效空页时，应按输出说明未覆盖的部分，不能把 HTTP 200 当成字段或上游续页验证成功。此工具验证安装的 Hub 网关和交付合同，不验证公网 Nginx/Ingress。保存成功回执并核对覆盖范围后，才在两个 Twitter 评论策略管理页填写原因、保存 RapidAPI 优先/TikHub 保底；原游标仍保持原供应商。

发布后只读核对策略搜索管理页的 Twitter 两个评论策略、可选 RapidAPI 及验证标记；核对供应商控制页中 `native.r.twitter_aio_tweet_replies` 的有效状态、价格和凭据。不要仅凭优先级显示就认定实际调用已转 RapidAPI。

第一笔正常业务调用完成后，使用其持久 request ID 检查已有归档，不重新采样：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - --request-id '替换为持久请求UUID' \
  < server/ops/inspect-post-comment-contract.mjs
```

把引号内的占位文字替换为实际 UUID。该工具读取已保存字节、校验 SHA-256 并输出受限结构摘要，不调用供应商。RapidAPI 已加入可检查端点；历史 `--verify-twitter-projection` 专用模式仍仅适用于 TikHub，不能用于声称 RapidAPI 校准完成。真实正文、作者、关系、翻页及计费仍待首次正常业务归档核对；错误或未知回执先按原请求排查，不换幂等键重购。

## 本地验证

合并运行原生转发、RapidAPI 传输证据、Threads 兼容、评论与回复、游标、策略管理 API 和实际 PGlite SQL 迁移回归：112 项通过。补充策略 UI、目录、归档检查及既有自动补价测试：70 项通过，1 项现有运行时测试在 Windows 因缺少 `fs.constants.O_NOFOLLOW` 而失败，尚待 Linux 补验；失败发生于未修改的 `ServerFileReader.create` 初始化。共 182 项通过。`npm run typecheck` 和 `git diff --check` 通过。没有供应商 HTTP 请求，没有生产变更。

用户追加付费验证请求后，本轮复核的 37 项相关测试通过（包含真实 PGlite 预检 SQL、路由保留及迁移顺序、限三次/防重复采购、旧字段/别名、回复帖引用及未知响应归档）。仍未从本机发出生产供应商请求：服务器不可直连，等待操作人在服务器运行限额工具并回传摘要；不能据此将 `derived` 升为 `verified`。

## 首轮服务器回执：RapidAPI 404，停止后续采购

用户已确认部署并运行 `--execute`。新 usage 为 `e813c900-44b2-45e8-bf84-6eb8786b1a5e`，唯一 provider call 为 `dc07998d-21c6-44cd-8f48-5f99f7e7918c`：上游 HTTP 404 / rejected，Hub HTTP 502 / `external_platform_rejected`。错误原始归档 77 字节，SHA-256 为 `a8f881027fc841cd737652640dbc864c94af4fe55f612ace64236059ed25a9a2`，长度及 hash 已验证。累计只发生 1 次上游调用；next/replies 均未尝试，原 TikHub 源归档保持不变。

此回执尚不能区分端点路径未注册和目标帖子不可用，也不能证明实际供应商扣费。失败发生在上游 HTTP 阶段，尚未验证成功响应的字段投影。官网仍列出 [/tweet/{tweetId}/replies](https://www.twittrapi.com/docs/reference/tweet-tweetid-replies) 和 [/tweet/{tweetId}](https://www.twittrapi.com/docs/reference/tweet-tweetid)，但文档不能代替本次实际错误内容。不根据响应长度猜根因，不修改已发布原生合同的路径，不换幂等键重购。

已给现有验证脚本增加保存错误分类。只同步 `server/ops/verify-twitter-rapid-comments.mjs` 到服务器工作目录，无需重建镜像或部署，执行以下**不带 `--execute`** 的命令：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-public -c api -- \
  node --input-type=module - \
  < server/ops/verify-twitter-rapid-comments.mjs
```

应返回 `savedErrorInspectionVersion:1`、`mode:read_saved_only`、`supplierHttpCallsMade:0`，以及当前两个 Twitter 评论策略。`stages[0].providerCalls[0].errorInspection` 只从 hash 验证成功的旧归档识别固定错误短语：`endpoint_path_not_found`、`tweet_unavailable`、`subscription_required`，其他文本为 `unclassified`。路径只显示模板和是否匹配原目标的布尔值，不输出帖子 ID、供应商任意文本或密钥。`billed:null` 仍表示实际供应商收费未知；不把 404 当成免费。

只读诊断与限额工具的 11 项测试通过，含 PGlite 实际 SQL、缺路由 404、保留失败回执及零新增采购。修复端点或更换目标的决定待这次零采购诊断回传后做；3 次总预算与已消费的首个槽位保持不变。

### 后续回执：当前线上实际已选 RapidAPI，需先恢复业务路由

用户回传的只读结果仍缺少 `savedErrorInspectionVersion`、`errorInspection` 和 `billed`，说明使用的还是旧版脚本，不能据此认定 77 字节错误已经分析。该结果同时确认两个 Twitter 评论策略均为 `priority / rapidapi / tikhub / revision 2`；部署前保留步骤没有在这两行上生效。此前“保持 TikHub”的预期不等于实际线上状态。

立即恢复无游标新请求至 `fixed / tikhub / null`，原因记录为 `Temporary TikHub routing after RapidAPI 404; compatibility validation pending`。恢复函数 `server/ops/restore-twitter-comment-routes.mjs` 仅匹配用户报告的两行 revision 2 及完整模式/供应商值，在同一连接事务中按接口排序加行锁，连同两条审计一起提交；已固定 TikHub 的行不改，其他新状态整体拒绝。此处依据用户已报告的当前状态恢复，不额外假定审计 actor。真实 PGlite 回归验证了两行恢复、审计冲突全回滚、并发新修订不覆盖、其他平台不变及重复零变更。

策略每次请求读取数据库，提交后无需重启即可影响新选路。已经在途的请求、已有 RapidAPI 游标及历史失败回放保持原身份，不能承诺全部 RapidAPI 调用立刻停止，也不换幂等键重新购买旧失败。此恢复不修改采购操作启停、凭据、价格、历史 usage/call、登录或联网配置。实际恢复仍须以服务器返回的两条 fixed/TikHub 结果确认；恢复提交后，错误归档诊断失败应单独报告，不误报已提交的恢复失败。
