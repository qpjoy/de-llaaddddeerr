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
若当时配置为默认 900000ms，匹配的原始调用应在 `06:51:23.835Z` 完成；
实际配置和归档仍需脚本核对。保护范围是同一供应商、operation、endpoint、contract，
不限某个检索词或 Key。下游称“其他检索式继续运行”不保证这些请求也能通过 Hub。
超过这次截止时间也不代表没有新的保护记录，或下游已自行解除策略阻塞。

当前 Hub 原生 Instagram 分支直接请求 TikHub `instagram/v3/general_search`。
保留旧 cursor / 小页请求的历史路由；不能只凭下游 `operation=raw` 判断实际 HTTP 路径。
该原生接口不接受 count 参数，Hub 对超出请求页大小的响应会拒绝，不能直接截断丢弃记录。
这是待核查的分支之一，尚未证明本次就是超量、分页或 ID 错误。
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

这次代码变更增加诊断脚本和调用账本的固定细分错误码，未知异常仍记通用错误码，
不改变 Instagram 解析接纳规则、冷却、计费或 MX-H2I 登录/联网。
根因修复需要上述归档报告；无需重新付费取得已经保存的响应。
