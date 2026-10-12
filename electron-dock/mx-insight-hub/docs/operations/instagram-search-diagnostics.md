# Instagram 搜索冷却诊断

## 2026-10-12 话题推荐与缺失游标

策略 `ad3c1131-6850-4cbf-a37a-ade3de846bd9` 的 Hub 请求
`7962155d-a920-4426-8663-ad5e68720806` 在 `01:55:44.930Z` 创建，
`01:55:44.954Z` 释放，实际路径是 `/api/v1/data/search`。
操作者返回的只读归档报告找到一条与告警截止时间完全匹配的候选：

- 原 Hub 请求 `8ba962cb-701f-4b43-acb9-d002c20063db`，调用 `8b12d535-5a5b-4bd2-81ce-2059f08489fe`。
- 调用结束于 `2026-10-12T01:51:24.698Z`，加 900000ms 正好是告警中的 `02:06:24.698Z`。
- HTTP / 业务码均为 200，`billed=true`，上游请求 `71881104-9125-4e2d-85f0-7680f569ae49`。
- `status=ok`、`list[1]`；唯一条目为 `position:number + hashtag:object`，
  外层没有 `id/pk/code/shortcode/user/media/caption/media_type/place`。
  没有媒体网格/items，`has_more=true`，`rank_token` 长 78，但没有 `next_max_id`。
- 当时已部署解析器回放仍报 `invalid_instagram_search_shape`。这次是话题推荐，
  与 10 月 9 日的账号推荐分支不同。旧记录未保存 blocker ID，仍保留候选关联的证据边界。

[官方综合搜索说明](https://docs.tikhub.io/419083058e0)（2026-10-12 核对）说明返回可含
用户、话题和地点，翻页需使用响应中的 `next_max_id` 与 `rank_token`。
不能将话题当帖子、用 rank_token 代替 next_max_id，或为补齐数据额外自动购买一页。

修复仅扩展已识别的 list 分支：没有帖子字段、没有 user/place 冲突、显式含 hashtag 对象的
条目归类为非帖子；不猜测/规范化话题内部字段。原始话题对象仍完整留在受限响应归档。
地点和未知条目仍不猜测。有媒体的条目继续走帖子身份校验。

对于非空、全部为已识别账号/话题的 list，如果声明有更多结果但没有可用游标，
交付 HTTP 200、`status=partial`、零条帖子、`hasMore=false/nextCursor=null`，并带
`INSTAGRAM_NON_POST_CONTINUATION_UNAVAILABLE` 警告。这里表示**无法安全继续这一响应**，
不表示搜索已穷尽或 Instagram 没有相关帖子；标准 data-search 与 raw 都保留该警告。
有有效游标时仍可继续；有帖子/空 list 却缺游标、损坏的 token/分页标志、未知或坏帖仍明确失败。
这样不会为已识别的推荐页打开全端点解析冷却，也不会掩盖可能丢失的帖子。

本地用报告的字段类型构造模拟响应，验证旧代码拒绝、新代码接受，并覆盖标准 data-search、
两个 raw HTTP 别名、幂等回放、采购回执、有效分页和坏帖保护。未读取生产话题内容，
未发付费探测或修改历史状态。无新增 migration；仍需部署后回放服务器原文。

在服务器的 Hub 源码目录按既有流程部署，然后只读验证：

```bash
bash scripts/manage.sh deploy
kubectl -n mx-insight-hub rollout status deployment/mx-insight-hub-public --timeout=300s
kubectl -n mx-insight-hub rollout status deployment/mx-insight-hub-admin --timeout=300s
kubectl -n mx-insight-hub exec deployment/mx-insight-hub-admin -c admin -- \
  node /app/server/ops/diagnose-instagram-search.mjs \
  7962155d-a920-4426-8663-ad5e68720806 \
  --blocked-until 2026-10-12T02:06:24.698Z
```

匹配候选的 projection 预期：`current_projection_accepts`、`returnedCount=0`、
`hasMore=false`、`deliveryStatus=partial`，warningCodes 含上述警告。
旧请求依然是 released；不改账、不重写旧响应、不自动解除新出现的保护。
部署全部 API 副本并确认当前限制后，才在告警所属 po-infra 环境恢复该策略的 Instagram
冷启动任务，保留分页不完整的说明；Hub 部署不会自动重启下游任务。不要用 Dev 环境 404
推断生产策略不存在，也不要扩大到全平台恢复。MX-H2I 登录和联网保持不变。

## 2026-10-09 冷启动失败

策略 `78e90b16-999f-470f-b30c-45d83ad43429`，检索词 `Lu Benwei cheating`，
Hub 请求 `112fad2d-a78e-4959-9328-d3fdfb7d0c94`。

已从生产后台“数据浏览中心 → 请求诊断”只读核实：请求在
`2026-10-09T07:04:27.480Z` 创建、`07:04:27.490Z` 释放，
错误码 `external_platform_response_unusable`，没有当次上游调用、响应正文或客户扣款记录。
结合告警中 `upstreamDispatched=false`，这是之前解析失败引起的调度前保护，
不能判断为此次供应商限流、余额不足或没有搜索结果。

告警截止时间为 `2026-10-09T07:06:23.835Z`（北京时间 15:06:23.835）。
服务器报告已确认冷却为 900000ms，匹配的原始调用在 `06:51:23.835Z` 完成。
保护范围是同一供应商、operation、endpoint、contract，
不限某个检索词或 Key。下游称“其他检索式继续运行”不保证这些请求也能通过 Hub。
超过这次截止时间也不代表没有新的保护记录，或下游已自行解除策略阻塞。

当前 Hub 原生 Instagram 分支直接请求 TikHub `instagram/v3/general_search`。
保留旧 cursor / 小页请求的历史路由；不能只凭下游 `operation=raw` 判断实际 HTTP 路径。
该原生接口不接受 count 参数，Hub 对超出请求页大小的响应会拒绝，不能直接截断丢弃记录。
本次归档报告已排除这些作为第一处拒绝原因：实际失败点是顶层结构校验。
关键词推荐不作为帖子交付，未知结构也不转换为“成功但零条”。

## 读取服务器归档

从更新后的 Hub 源码目录执行。此方法通过标准输入运行宿主机上的脚本，
使用现有 Pod 的 `pg`、数据库连接及已部署解析器；不需要重建镜像、在宿主机安装依赖，
也不需要在只读容器中写文件。

```bash
sed \
  -e "s|from 'pg'|from '/app/node_modules/pg/lib/index.js'|" \
  -e "s|from '../contracts/|from '/app/server/contracts/|g" \
  -e "s|import.meta.url === pathToFileURL(process.argv\[1\]).href|process.argv[1] === '-'|" \
  server/ops/diagnose-instagram-search.mjs |
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - \
  112fad2d-a78e-4959-9328-d3fdfb7d0c94 \
  --blocked-until 2026-10-09T07:06:23.835Z
```

若新脚本已经随镜像部署，也可直接运行：

```bash
kubectl -n mx-insight-hub exec deployment/mx-insight-hub-admin -c admin -- \
  node /app/server/ops/diagnose-instagram-search.mjs \
  112fad2d-a78e-4959-9328-d3fdfb7d0c94 \
  --blocked-until 2026-10-09T07:06:23.835Z
```

脚本开启只读事务，查询最多 10 个候选、单份归档不超过 8MiB，并验证 SHA-256。
不请求供应商、不改账、不解除冷却；输出固定字段类型、数量和错误原因，
不输出正文、查询词、凭据或分页 token。当前仅重放保存了原始参数的首页请求；
后续页不会猜测 cursor 参数。

重点看 `evidence[].matchesReportedDeadline`、`storedErrorCode` 和 `projection`：

| 字段/原因 | 含义 |
| --- | --- |
| `matchesReportedDeadline=true` | 完成时间加冷却时长与告警一致；旧记录没有 blocker ID，仍是强匹配候选 |
| `invalid_instagram_search_shape` | 未识别的顶层数据结构或非正常业务状态 |
| `invalid_instagram_media_grid` | sections / layout_content / medias 结构不匹配 |
| `invalid_instagram_post_identity` | 帖子 ID 或 shortcode 不可用；`invalidRows` 指出类型及大整数风险 |
| `instagram_page_exceeds_requested_count` | 唯一帖子数超过保存请求的 pageSize |
| `missing_instagram_continuation` | 声明有后续页却没有可用 next_max_id |
| `invalid_instagram_continuation` / `invalid_instagram_pagination` | token 类型/长度或分页标志不符合约定 |
| `current_projection_accepts` | 已部署解析器能读取旧响应；不等于旧失败响应已修复或下游已恢复 |
| `archive_missing` / `archive_integrity_failed` | 原始证据不可用；不得据此判断接口健康 |

## 归档结果与 list 兼容处理

操作者返回的已校验归档报告定位到一条与冷却截止时间完全一致的候选：

- 原 Hub 请求 `db65c03d-af2d-46cc-a5a2-3c1d2af40d53`，调用 `72a54ecb-ede6-4f97-92b8-910a6dcbc75a`。
- 供应商请求 `49e81ea5-cb5b-40cd-aec8-ad792b8cb2d2`，HTTP / 业务码均为 200，`billed=true`。
- 顶层 `status=ok`、`list` 有 1 条、`has_more=false`，`rank_token` 长度 78；
  没有 `media_grid/items/keyword_recommendations`，触发 `invalid_instagram_search_shape`。
- 旧诊断中的 `resultCount=0` 仅表示旧解析器没有提取到帖子，不能证明 `list` 内容为空。

[TikHub 综合搜索官方说明](https://docs.tikhub.io/419083058e0)明确可能返回账号、话题和地点；
Night-All 的现有回归样本也包含 `list[].user`。操作者进一步读取了相同归档：唯一元素包含
数值 `position` 和对象 `user`，后者有字符串 `id/pk/username/full_name`；外层无
`id/pk/code/shortcode/media/caption/media_type/hashtag/place`。这是明确的账号结果结构，
不是帖子。Hub 将这种正常的“只有账号、没有帖子”的响应当成了契约错误。
诊断脚本现已追加不输出内容的 `listEntries` 类型证据，方便一次检查完整结构。

新增严格的 `status=ok + list` 分支，仅在媒体网格/items 没有提供时使用：

- `media` 对象或带 shortcode 的帖子沿用原 ID、媒体、caption 校验与去重。
- 明确带合法用户 ID、username 且不含帖子字段的 `list[].user` 不作为帖子入库。
  只有账号且 `has_more=false` 时，帖子接口返回正常零条、`hasMore=false`，不触发冷却。
- 若有有效后续游标，即使该页只有账号，也保留继续查询的能力；依然绑定 Key/查询，最多 15 页，
  不自动加发任何请求。
- 未知 list 项、混合的坏帖、无 ID 的媒体、异常状态及损坏的网格/items 仍明确失败，
  不以“过滤账号”为由掩盖丢失帖子。当时未支持地点/话题；话题的后续修复见上方 10 月 12 日记录。

标准 `/api/v1/data/search` 与两个 raw URL 共用此修复；原始响应、采购计费、历史重放不修改，
不回退 Night-All、不追加付费探测，不影响 MX-H2I 登录/联网。无新增 migration。
部署 public API 和 admin 的新镜像后重跑上面的只读诊断；该归档预期为
`current_projection_accepts`、`returnedCount=0`、`hasMore=false`。本地以报告字段结构重建的
模拟账号样本已通过标准搜索/raw 链路和只读诊断测试；生产原文仍留在服务器，部署后才能
对该份原文完成最终回放验证。不应把这个零条结果表述为“Instagram 上完全没有相关帖子”。
其他归档若 `listEntries` 显示未知类型，仍需按证据补充，不能直接删除结构校验。
旧请求 `status=released` 是不可改写的历史状态；下游已经阻塞的策略需要重新启动采集，
不能用旧幂等键的失败回放判断新代码是否正常。
