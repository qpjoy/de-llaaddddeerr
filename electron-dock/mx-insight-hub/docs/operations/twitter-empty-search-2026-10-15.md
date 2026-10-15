# Twitter 标准搜索零条结果核查

更新：2026-10-15。两份原生产归档均完成候选只读验收：首份包装层遗漏修复后返回 20 条，第二份超量页在 v3 中完整解析为 24 条并拆成 20＋4。用户随后要求下一页由 Hub 自动补齐，本轮运行实现见下节；v3 报告仍只验证单份归档，不证明多页实时补齐。实际 Hub 发布仍待操作者执行。

## 后续要求：余量不足时由 Hub 自动补页

用户确认 v3 单归档拆分正确后，要求下游不再处理先 4 条、再取新上游页的情况。Twitter 标准 `/api/v1/data/search` 现在将缓冲与后续成功上游页组合：余量 4 条优先交付，继续沿原 Bottom 获取并去重，直到达到请求的 20 条或明确的停止边界；新页未消费的内容仍保存。下游只使用 Hub `nextCursor`。

查验本机 Night-All 的 `lib/domains/search/paged-content-search-service.js`，其统一分页层已有 `drainBuffer`、已交付 ID 去重、最多 3 次供应商调用及不可变游标快照。这些行为适合借鉴。其 `raw-search-service.js` 的提前 `slice(0,pageSize)` 会丢掉超量页余量，Twitter Python 爬虫还存在内部多次 GET/连接重试，不能直接复制到 Hub 的采购执行器。

Hub 使用独立组页工作流：每次最多 3 次实际派发、每次最多请求 50 条、一次查询最多 15 个上游页和 15 个公开页；原请求期限与 12 MiB 完整归档预算（包含输入缓冲）进一步限制工作量。每个新采购页在下一次派发前先持久化原始响应凭证，并提交一次完整页入库任务。服务端沿已提交交付链读取已交付 ID，签名游标仅保存前驱交付引用、上游计数和余量位置，不塞入全部历史 ID。

一个 Hub 客户请求沿用一次现有报价和结算；各上游调用有独立采购、速率、操作授权与归档记录。新幂等键不能绕过同一请求的未知状态。读取旧余量时先验证完整归档与规范化页哈希；不修改原历史失败、stable 重放、账单或隔离。供应商明确耗尽可返回短页，调用次数/期限/预算等停止则保留真实 `partial` 警告及安全的下一页；已派发失败或未知结果不会被补采掩盖。

本次自动补页仅覆盖 Twitter 标准内容搜索。raw、social、crawl 与 user-info 保持原合同；旧 Hub 游标保留兼容校验，旧原生游标没有可追溯前驱时只能从继续后的窗口去重。无新迁移、无新增生产付费探测，发布仍限定 Hub、`MX_INSIGHT_SYNC_LAUNCHER=0`。

本轮最终 411 项相关回归通过，0 失败、0 跳过；使用本机模拟 HTTP 和隔离 PGlite，包含真实客户结算触发器。覆盖 24→20、余量 4＋新页→20、后续余量、75/100 条补齐、跨页去重、3/15 页上限、已知循环游标关闭、旧游标与历史精确重放、取消／撤销权限后无新增派发、源 partial 信息、完整页各提交一次入库任务、多来源原子结算和强制回滚。未知状态写入失败时原客户预留及租约仍保留，过期核对转为 unknown，新幂等键不能再次采购。类型检查与差异格式检查通过。Parser SHA 仍为已验收的 `aa6d31cbedfd3cb7af5f5250f6f9f625bedac5739844166b8635304f45b359d5`；这些本地测试不表示生产补页已发布或实时查询已验证。

## 先前 v3 单归档修复：HTTP 200 但交付失败

用户随后报告 Twitter / X 查询“杭州美女”失败，Hub 请求 ID 为 `c53dadd0-a1c7-4176-b60c-72c749b34b3c`，公开错误为 `social_upstream_response_unusable`、`upstreamStatus=200`。本次使用与前轮一致的 v2 候选 bundle 对原归档只读检查，返回明确的 `upstream_page_exceeds_requested_count`。

| 证据 | 已核对结果 |
| --- | --- |
| 原 Hub 请求 | committed，HTTP 502，`stable`、`pageSize=20` |
| 原供应商调用 | `992e50ff-aa36-480b-b25e-e9a0f7abd625`，RapidAPI `twitter-aio.search`，HTTP 200、succeeded_unusable |
| 原归档 | 167318 字节、`hashVerified=true` |
| 原归档 SHA-256 | `21e2788e2095ed4c017ce5fe4d51affefe5fc554ad01173ffa98826258a843ae` |
| 原请求映射 | Top、count=20、includeTimestamp=false |
| 实际结构 | 外层 TimelineAddEntries 内有 23 项，包含两个各有 3 个 items 的模块；总计 24 个带 legacy 和字符串身份的 Tweet |
| 原投影拒绝 | `upstream_page_exceeds_requested_count` |

原因是 Hub 将供应商超量的完整有效页作为合同错误拒绝。当时仅为 `/api/v1/data/search` 的 Twitter 关键词搜索增加完整归档分页：先按原 count 采购一次，最多交付所请求的 pageSize；余下内容由绑定原调用和全页规范化哈希的游标从同一归档读取，缓冲耗尽后才沿原 Bottom 游标继续上游。若原 24 个候选经身份校验和去重后均保留，交付为 20 条加 4 条；实际完整条数以 v3 的 acquiredCount 为准，v2 的结构计数不能证明身份互不重复。完整规范化页只入库一次；读取缓冲不新增供应商调用或采购，客户仍沿用现有每请求定价与授权规则。

旧 raw 别名及 `/data/social/*` 保持严格页大小校验。新标准游标继续绑定 Key、query、原 pageSize、fresh/stable 和 data 路径，保留 RapidAPI 身份、24 小时期限与最多 15 个公开页。标准 pageSize=75/100 的缓冲按原交付页大小分页，不按供应商 50 条上限拆错页。原始归档字节和已保存失败响应保持原样；该阶段尚未自动补页，也不会补历史入库、改账或清隔离。

缓冲读取核验原调用、成功交付、tenant/consumer/Key/path、端点及版本、SHA、大小与期限。重投影后的全页规范化哈希必须与初次采集时一致；若原凭据回显经初次脱敏后导致哈希不同，缓冲明确拒绝，不交付原秘密或重新采购。

新版 v3 只读诊断复用实际分页函数，输出 `acquiredCount`、`returnedCount`、`bufferedCount` 和第二页的内存预览；不会创建可使用的游标或真实交付。它只验证原归档的解析与分页，不代替供应商网络、凭据脱敏及数据库提交的运行验收。

### v3 原归档分页验收通过

操作者直接发送已生成的 v3 独立脚本后，返回的 parser、诊断源码与变换后模块哈希均与本地一致，确认已加载新增分页代码：

| 核验项 | 原归档验证结果 |
| --- | --- |
| 诊断版本／实现 | `twitter-search-diagnostic.v3`／`bundled_local_candidate` |
| parser SHA-256 | `aa6d31cbedfd3cb7af5f5250f6f9f625bedac5739844166b8635304f45b359d5` |
| 诊断源码 SHA-256 | `838e56408a1da9c965431fd65b82d0d53ef0edf345c299fe040d50c865b32393` |
| 原归档 | 同一 `992e50ff-aa36-480b-b25e-e9a0f7abd625` 调用，167318 字节，SHA `21e2788e2095ed4c017ce5fe4d51affefe5fc554ad01173ffa98826258a843ae`，hashVerified=true |
| 当前投影 | `current_projection_accepts`、`deliveryStatus=ok` |
| 完整规范化页 | `acquiredCount=24`，重复 0、丢弃 0 |
| 第一页／缓冲 | `returnedCount=20`、`bufferedCount=4`、`hasMore=true` |
| 缓冲内存预览 | 返回 4 条、`upstreamCallCount=0`、`hasMore=true`，表示耗尽后仍可沿原供应商 Bottom 继续 |

该原生产页的解析及 20＋4 分页修复已经验证。报告顶层 `responseStatus=502` 和 provider-call `outcome=succeeded_unusable/billed=null` 仍然是原历史记录，并非 v3 新投影失败。此次验证没有新采购、交付、入库、计费或数据库写入，也没有将旧失败归档变成可使用的运行缓冲；实际运行缓冲仍只接受符合归属与完整性条件的成功采集。

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

当前分页诊断顶层带 `diagnosticRevision=twitter-search-diagnostic.v3`，并返回 `projectionImplementation`。原样脚本使用 `installed_hub_contract`；`structure.rootFields`、`entryContainers`、`entryWrapperTypes` 和 sample 的 `containerPath/wrapperType/nestedEntries` 区分具体包装，`acquiredCount/bufferedCount/bufferPreview` 验证完整页及缓冲拆分。v2 能证明原严格 count 拒绝，但不能验收新增的分页代码。

脚本使用 `REPEATABLE READ READ ONLY`、5 秒语句超时和 1 秒锁超时；不搜索、不重放 HTTP、不更新历史、不创建临时表、不读取供应商凭据，也不写容器文件。输出中的 `current_mapping_from_saved_input` 是从原入参计算的当前映射，不是保存下来的 HTTP wire 参数，二者不能混淆。

### 发布前验证候选 parser

使用本轮已经更新的源码，在可运行 Node 且能访问生产 Kubernetes 的服务器仓库根目录生成并发送只读 bundle：

```bash
set -o pipefail
node electron-dock/mx-insight-hub/scripts/build-twitter-search-diagnostic.mjs |
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - c53dadd0-a1c7-4176-b60c-72c749b34b3c
```

bundle 内嵌本机候选 `hub-social.mjs` 和其固定错误类型依赖，报告标记 `projectionImplementation=bundled_local_candidate` 与候选源文件 `parserSha256`。分页修复的候选 parser SHA-256 为 `aa6d31cbedfd3cb7af5f5250f6f9f625bedac5739844166b8635304f45b359d5`，v3 bundle SHA-256 为 `86e5645ee70eb546f08861fe6d29d4acba69fbcfeed0b587f0682b046969c0d4`。它仍使用 Pod 现有数据库连接，在内存中重新解析同一受限归档，不写容器、不部署、不采集，也不保存新交付。必须核对诊断 revision、候选 parser hash、原归档 hash 和实际固定路径；预期返回首屏 20、全页 24、缓冲 4，第二页预览的 upstreamCallCount=0。这只证明原页可被此代码解析和分页，不能声称新实时调用已经恢复。

若服务器没有本地 Node，可在有 Node 的源码机器运行 builder，将生成的 `.mjs` 复制到服务器，然后用同一 `kubectl ... node --input-type=module - <requestId>` 命令从该文件重定向 stdin。生成脚本只读本地三个源码文件，stdout 为 JavaScript、stderr 为源码及 bundle 哈希；候选代码不会读取服务器的已安装 parser。

操作者首次尝试分页验收时仍返回 v2/旧 parser `6ebb…`，说明该次没有加载新增代码。可直接将已经生成并核对哈希的 v3 bundle 复制到服务器，以文件重定向运行，避免仓库同步版本歧义；重复的旧 v2 报告不作为分页修复通过证据。

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

首轮包装层修复与 v3 第二份原归档的 20＋4 分页均已验证。将本轮完整 Hub 运行代码及前端改动同步到服务器后，由生产操作者在 Hub 子目录发布。仅复制诊断 bundle 不会更新应用运行代码：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 bash scripts/manage.sh ops internal-production deploy
```

本轮不新增数据库迁移。发布后使用镜像内的普通诊断，核对 `installed_hub_contract` 对第二份原归档也返回 acquired24、returned20、buffered4 与零上游调用的 4 条缓冲预览：

```bash
kubectl -n mx-insight-hub exec deployment/mx-insight-hub-admin -c admin -- \
  node /app/server/ops/diagnose-twitter-search.mjs c53dadd0-a1c7-4176-b60c-72c749b34b3c
```

原幂等键仍返回历史 stable 零条或502响应；产品中的“重放／重试原查询”继续遵守这一行为，不能用它判断新解析器是否生效。后续新的业务请求才会使用新逻辑，本轮只读核查不擅自使用新键再次付费采集。此发布保持 Launcher 同步关闭，不改 MX-H2I 登录联网。

本机没有该生产请求对应数据库或 Kubernetes 上下文。上一轮单归档分页与布局修复的 144 项相关回归全部通过且无跳过，包含实际 HTTP 模拟、PGlite 原子提交与真实计费触发器、原样 stdin 和候选 bundle 执行；类型检查与前端构建通过。覆盖真实摘要对应的 outer1/inner23/两个内容模块、全页24→20＋4、完整入库一次、下一供应商页继续溢出、100/50 页大小边界、归档损坏/归属/TTL/脱敏哈希不符拒绝、旧 stable 空响应和502精确回放。接口列表修复另经351及1440宽度和Web Search控制台验证，端点卡片内容不溢出。没有发起新付费查询、自动重试或部署，没有修改 Top 默认、RapidAPI-only 规则、授权、价格、历史响应／账单，也没有改动 MX-H2I 登录联网。
