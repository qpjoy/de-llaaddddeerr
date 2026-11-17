# Twitter 评论与回复默认 RapidAPI

日期：2026-11-17。状态：本地实现与离线验证完成，未部署、未执行供应商付费采样。此次只修改 Hub，不修改 Launcher、MX-H2I、登录、SSO 或联网配置。

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
