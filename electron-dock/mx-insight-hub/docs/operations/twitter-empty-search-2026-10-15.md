# Twitter 标准搜索零条结果核查

更新：2026-10-15。生产原归档已确认 `TimelineAddEntries` 包装遗漏，修复代码对同一归档只读投影返回 20 条并保留下一页；尚未发布。

## 已取得的生产归档报告与本轮修复

操作者已经对原请求完成只读诊断。归档 135269 字节，SHA-256：

```text
150dde9fbd26afee077591edb64f0dfa66835e0e61cb17b1b05dad6b5324b5ab
```

报告确认 hashVerified=true，供应商 payload 顶层为 object、没有 data 包装；固定结构遍历共遇到 24 个 entries 元素、20 个 tweet_results（19 个 Tweet、1 个 TweetWithVisibilityResults），20 个对象都有 legacy 和字符串身份，并有 Bottom/Top 游标各 1。当前部署解析器却交付 0 条，duplicate/discarded 都为 0，且没有下一页。标准参数仍为 Top、count=20、includeTimestamp=false。

因此“上游原页没有内容”已被这份证据排除；Hub 的固定容器提取遗漏了这些帖子，不能据此修改关键词、排序或切换供应商。原报告没有记录 entries 所在的固定路径与 wrapper type；再次收到的报告也没有新版字段，不能把具体生产包装层说成已经确定。

本轮独立复现一个最小解析缺口：`entries:[{type:"TimelineAddEntries",entries:[…实际条目…]}]` 会被原 parser 识别为 timeline，但只检查外层 wrapper 的 content，返回成功且 0 条。相同合成页内 20 条完整帖子和 Bottom 游标在修复后可以正确交付。随后操作者通过内存 bundle 对上述原 hash 归档验证，确认生产页正是该结构。

### 原生产页只读验证通过

返回的 `diagnosticRevision=twitter-search-diagnostic.v2`、`projectionImplementation=bundled_local_candidate` 与本地生成的源码哈希完全匹配：

| 证据 | 已核对结果 |
| --- | --- |
| 候选 parser SHA-256 | `6ebb098a5ad60102d0a9d9c619a31cf078017461f7304c69967382803e1c975c` |
| bundle SHA-256 | `6a84466cd5f30a692d7aad7879444c50f01136aec10358abed89a79fa340b022` |
| 原供应商调用 | `eabb5d55-3bdf-45f8-b15d-f8248acb7274`，RapidAPI `twitter-aio.search` |
| 原归档 | 135269 字节，`hashVerified=true`，SHA 同上 |
| 外层数组 | `payload.entries`，1 项，类型 `TimelineAddEntries` |
| 实际条目 | `payload.entries[0].entries`，23 项，包含 20 条推文和 Top/Bottom 游标 |
| 新投影 | `returnedCount=20`、`duplicateCount=0`、`discardedCount=0`、`hasMore=true`、`deliveryStatus=ok` |
| 历史交付 | 仍为 0 条、无续页，`deliveredCountMatchesCurrent=false` |

具体根因已确认：原解析器跳过了指令包装内的实际条目。新投影与历史交付不相同是预期结果，不是归档完整性失败。此次验证没有发布镜像、调用供应商或改写数据库；它证明本次修复能正确解析该原生产页，不能证明新实时请求已经恢复。

修改只在 entries 数组中展开明确 `type=TimelineAddEntries` 且具有 entries 数组的包装，按原位置保留顺序；未知 wrapper、引用帖与推荐业务树不递归采集。总展开最多 10000 个节点，过深或过大明确拒绝；原 count 上限、去重与丢弃统计、Bottom 游标、Key/query/pageSize/type 绑定和 15 页边界继续保留。

历史 `stable` 请求即使已经保存 0 条，也仍逐字返回原交付且不派发供应商请求。候选离线投影不会修改该旧响应、归档、原供应商 item_count、调用次数或账单；新的正确解析与历史交付是两份不同证据。本轮未授权再次付费查询，不能通过新键或刷新去验证修复。

## 已知情况

调用方在策略搜索中使用 Twitter / X、关键词“美女”、`pageSize=20`，界面显示 0 条、`sourceMode=live`，响应为 `night-all.data-search.v1`，Hub 请求 ID：

```text
446a7664-028d-4dc8-940a-06baaff0c340
```

截图只能证明所展示交付与条数，不能证明供应商原始页为空，也不能单靠统计中的 URL 判定是否迁移。标准 `/api/v1/data/search` Twitter 分支在当前源码使用 Hub RapidAPI 执行器，按原 `twitter` 平台权限和计量规则执行；公开 source 的 null 字段不是实际执行渠道证据。

当前标准请求映射为固定 Twitter AIO Host 上的 `GET /search/{encoded-query}`，`category=Top`、`count=min(pageSize,50)`、`includeTimestamp=false`。这与本机 Night-All `GetCommentByKeywords.py` 的同类参数映射一致。独立 social/raw 默认 Latest 的区别已经存在；`type=fresh/stable` 仍是回放策略，不是排序。本轮保持这些默认值。

现有解析器沿固定 timeline/instructions/entries 链读取内容，同时支持 `TimelineTimelineModule → content.items[].item.itemContent.tweet_results.result`。该模块形状与 Night-All 账号时间线原代码一致，本轮合成回归证实可以返回帖子、保留下一页、排除引用帖树。生产报告 moduleCount=0，因此不是已经确认的 Top 内容模块遗漏；新修复处理的是明确的 TimelineAddEntries 指令包装。

## 服务器只读诊断

新增 `server/ops/diagnose-twitter-search.mjs`：只读取该 UUID 的原 usage、关联 provider-call ledger 和最多 10 个受限归档；同一请求之外的调用不会加入报告。每个归档最多 4 MiB，先核对 SHA-256 和长度，再在内存中运行已安装的当前解析器。只输出：

- 原公开交付的 contract、status、sourceMode、实际与声明条数；缺失字段明确标记未知。
- 保存参数的固定字段类型、长度及页大小；不输出关键词、账号、游标、URL或令牌内容。
- 原 provider call 的已知 endpoint/version/contract、HTTP/业务码、outcome、billed 与记录条数；null 不推定成免费或成功。
- instructions/entries/modules/tweet/cursor 的固定结构计数、最多 20 个条目字段类型，以及当前离线投影的条数、丢弃数、重复数和分页状态。

新版顶层带 `diagnosticRevision=twitter-search-diagnostic.v2`，并返回 `projectionImplementation`。原样脚本使用 `installed_hub_contract`；`structure.rootFields`、`entryContainers`、`entryWrapperTypes` 和 sample 的 `containerPath/wrapperType/nestedEntries` 才能区分具体包装。没有这些字段的输出来自旧脚本，不能作为本轮候选代码的离线验收。

脚本使用 `REPEATABLE READ READ ONLY`、5 秒语句超时和 1 秒锁超时；不搜索、不重放 HTTP、不更新历史、不创建临时表、不读取供应商凭据，也不写容器文件。输出中的 `current_mapping_from_saved_input` 是从原入参计算的当前映射，不是保存下来的 HTTP wire 参数，二者不能混淆。

### 发布前验证候选 parser

使用本轮已经更新的源码，在可运行 Node 且能访问生产 Kubernetes 的服务器仓库根目录生成并发送只读 bundle：

```bash
set -o pipefail
node electron-dock/mx-insight-hub/scripts/build-twitter-search-diagnostic.mjs |
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - 446a7664-028d-4dc8-940a-06baaff0c340
```

bundle 内嵌本机候选 `hub-social.mjs` 和其固定错误类型依赖，报告标记 `projectionImplementation=bundled_local_candidate` 与候选源文件 `parserSha256`。本轮候选 parser SHA-256 为 `6ebb098a5ad60102d0a9d9c619a31cf078017461f7304c69967382803e1c975c`。它仍使用 Pod 现有数据库连接，在内存中重新解析同一受限归档，不写容器、不部署、不采集，也不保存新交付。必须核对诊断 revision、候选 parser hash、原归档 hash 和实际固定路径；候选返回 20 条及续页只证明原页可被此代码解析，不能声称新实时调用已经恢复。

若服务器没有本地 Node，可在有 Node 的源码机器运行 builder，将生成的 `.mjs` 复制到服务器，然后用同一 `kubectl ... node --input-type=module - <requestId>` 命令从该文件重定向 stdin。生成脚本只读本地三个源码文件，stdout 为 JavaScript、stderr 为源码及 bundle 哈希；候选代码不会读取服务器的已安装 parser。

### 读取当前已安装 parser

在已同步源码的仓库根目录执行：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - 446a7664-028d-4dc8-940a-06baaff0c340 \
  < electron-dock/mx-insight-hub/server/ops/diagnose-twitter-search.mjs
```

Hub Admin 镜像的工作目录为 `/app`，stdin 入口复用其 `pg`、`DATABASE_URL` 与已安装 parser，无需 sed、写入容器或重新构建。该普通模式**不会自动加载本机候选 parser**，尚未发布的修复不能用它验收；发布后可用它再次只读核对归档。若已经在 Hub 子目录，输入文件改用 `server/ops/diagnose-twitter-search.mjs`。脚本若已随镜像发布，也可直接运行：

```bash
kubectl -n mx-insight-hub exec deployment/mx-insight-hub-admin -c admin -- \
  node /app/server/ops/diagnose-twitter-search.mjs 446a7664-028d-4dc8-940a-06baaff0c340
```

需要原样检查报告中的 `delivery` 与 `evidence[].projection`：

- `current_projection_accepts` 且归档结构没有内容候选、离线也为 0，说明该已保存页经当前解析得到空结果；仍不能证明其他关键词、其他排序或供应商未来状态。
- 结构存在 tweet 候选而投影为 0／rejects，才能继续核对具体固定路径、身份类型和 legacy 字段，准备有证据的解析回归；不可泛扫任意嵌套数组把推荐或引用当结果。
- `archive_missing/integrity_failed/too_large` 或非当前合同需要补相应证据，不能据此认定真实空页。
- `deliveredCountMatchesCurrent=false` 表明当前投影与旧交付条数有差异，需要保留原响应和账单并核对版本；诊断本身不修复历史。

## 原归档验证后的 Hub 发布

候选报告已核对为同一归档、正确包装路径和 20 条及续页。由生产操作者在 Hub 子目录发布本轮解析器：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 bash scripts/manage.sh ops internal-production deploy
```

本轮不新增数据库迁移。发布后可重新运行上述普通诊断，核对 `installed_hub_contract` 对原归档的投影结果。原幂等键仍返回历史 stable 零条响应；不能用它判断新解析器是否生效，也不能在本轮只读核查中擅自使用新键再次付费采集。此发布保持 Launcher 同步关闭，不改 MX-H2I 登录联网。

本机没有该生产请求对应数据库或 Kubernetes 上下文。本轮 128 项相关回归通过，包含实际 HTTP 模拟与隔离 PGlite、原样 stdin 和候选 bundle 执行；类型检查通过。覆盖 20 条帖子及 visibility 包装、混合包装与直接条目的原顺序、重复/失效项、超限与过深拒绝、原归档字节保持、mxds1 下一页和历史 stable 空响应精确回放。没有发起新付费查询、自动重试或部署，没有修改 Top 默认、RapidAPI-only 规则、授权、价格、原游标语义、历史响应／账单，也没有改动 MX-H2I 登录联网。
