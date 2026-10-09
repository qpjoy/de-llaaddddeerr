# Instagram 搜索冷却诊断

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
  不以“过滤账号”为由掩盖丢失帖子。地点/话题形态尚未加入这个分支，不猜测它们的内部结构。

标准 `/api/v1/data/search` 与两个 raw URL 共用此修复；原始响应、采购计费、历史重放不修改，
不回退 Night-All、不追加付费探测，不影响 MX-H2I 登录/联网。无新增 migration。
部署 public API 和 admin 的新镜像后重跑上面的只读诊断；该归档预期为
`current_projection_accepts`、`returnedCount=0`、`hasMore=false`。本地以报告字段结构重建的
模拟账号样本已通过标准搜索/raw 链路和只读诊断测试；生产原文仍留在服务器，部署后才能
对该份原文完成最终回放验证。不应把这个零条结果表述为“Instagram 上完全没有相关帖子”。
其他归档若 `listEntries` 显示未知类型，仍需按证据补充，不能直接删除结构校验。
旧请求 `status=released` 是不可改写的历史状态；下游已经阻塞的策略需要重新启动采集，
不能用旧幂等键的失败回放判断新代码是否正常。
