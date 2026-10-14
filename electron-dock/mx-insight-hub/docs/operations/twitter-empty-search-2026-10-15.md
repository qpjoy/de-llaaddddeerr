# Twitter 标准搜索零条结果核查

更新：2026-10-15。此记录区分调用方截图、源码与未取得的服务端证据，不表示已经定位生产原因或恢复上游。

## 已知情况

调用方在策略搜索中使用 Twitter / X、关键词“美女”、`pageSize=20`，界面显示 0 条、`sourceMode=live`，响应为 `night-all.data-search.v1`，Hub 请求 ID：

```text
446a7664-028d-4dc8-940a-06baaff0c340
```

截图只能证明所展示交付与条数，不能证明供应商原始页为空，也不能单靠统计中的 URL 判定是否迁移。标准 `/api/v1/data/search` Twitter 分支在当前源码使用 Hub RapidAPI 执行器，按原 `twitter` 平台权限和计量规则执行；公开 source 的 null 字段不是实际执行渠道证据。

当前标准请求映射为固定 Twitter AIO Host 上的 `GET /search/{encoded-query}`，`category=Top`、`count=min(pageSize,50)`、`includeTimestamp=false`。这与本机 Night-All `GetCommentByKeywords.py` 的同类参数映射一致。独立 social/raw 默认 Latest 的区别已经存在；`type=fresh/stable` 仍是回放策略，不是排序。尚无证据支持把默认 Top 改成 Latest。

现有解析器沿固定 timeline/instructions/entries 链读取内容，同时支持 `TimelineTimelineModule → content.items[].item.itemContent.tweet_results.result`。该模块形状与 Night-All 账号时间线原代码一致，本轮合成回归证实可以返回帖子、保留下一页、排除引用帖树。因此不能把“Top 模块未解析”当成该请求已经确认的原因。其他未识别形状、真实空页、供应商查询或内容策略仍需原归档区分。

## 服务器只读诊断

新增 `server/ops/diagnose-twitter-search.mjs`：只读取该 UUID 的原 usage、关联 provider-call ledger 和最多 10 个受限归档；同一请求之外的调用不会加入报告。每个归档最多 4 MiB，先核对 SHA-256 和长度，再在内存中运行已安装的当前解析器。只输出：

- 原公开交付的 contract、status、sourceMode、实际与声明条数；缺失字段明确标记未知。
- 保存参数的固定字段类型、长度及页大小；不输出关键词、账号、游标、URL或令牌内容。
- 原 provider call 的已知 endpoint/version/contract、HTTP/业务码、outcome、billed 与记录条数；null 不推定成免费或成功。
- instructions/entries/modules/tweet/cursor 的固定结构计数、最多 20 个条目字段类型，以及当前离线投影的条数、丢弃数、重复数和分页状态。

脚本使用 `REPEATABLE READ READ ONLY`、5 秒语句超时和 1 秒锁超时；不搜索、不重放 HTTP、不更新历史、不创建临时表、不读取供应商凭据，也不写容器文件。输出中的 `current_mapping_from_saved_input` 是从原入参计算的当前映射，不是保存下来的 HTTP wire 参数，二者不能混淆。

在已同步源码的仓库根目录执行：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - 446a7664-028d-4dc8-940a-06baaff0c340 \
  < electron-dock/mx-insight-hub/server/ops/diagnose-twitter-search.mjs
```

Hub Admin 镜像的工作目录为 `/app`，stdin 入口复用其 `pg`、`DATABASE_URL` 与已安装 parser，无需 sed、写入容器或重新构建。若已经在 Hub 子目录，输入文件改用 `server/ops/diagnose-twitter-search.mjs`。脚本若已随镜像发布，也可直接运行：

```bash
kubectl -n mx-insight-hub exec deployment/mx-insight-hub-admin -c admin -- \
  node /app/server/ops/diagnose-twitter-search.mjs 446a7664-028d-4dc8-940a-06baaff0c340
```

需要原样检查报告中的 `delivery` 与 `evidence[].projection`：

- `current_projection_accepts` 且归档结构没有内容候选、离线也为 0，说明该已保存页经当前解析得到空结果；仍不能证明其他关键词、其他排序或供应商未来状态。
- 结构存在 tweet 候选而投影为 0／rejects，才能继续核对具体固定路径、身份类型和 legacy 字段，准备有证据的解析回归；不可泛扫任意嵌套数组把推荐或引用当结果。
- `archive_missing/integrity_failed/too_large` 或非当前合同需要补相应证据，不能据此认定真实空页。
- `deliveredCountMatchesCurrent=false` 表明当前投影与旧交付条数有差异，需要保留原响应和账单并核对版本；诊断本身不修复历史。

本机没有该生产请求对应数据库或 Kubernetes 上下文。本轮只执行合成 parser/路由回归、原样 stdin 入口测试及隔离 PostgreSQL 只读查询验证。没有发起新付费查询、自动重试或部署，没有修改 Top 默认、RapidAPI-only 规则、授权、价格、游标、历史响应／账单，也没有改动 MX-H2I 登录联网。
