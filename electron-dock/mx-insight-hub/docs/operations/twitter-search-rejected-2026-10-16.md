# Twitter 搜索 554b85cb 上游 400 核查

最新处理见 [Twitter 标准搜索的供应商兼容](../integrations/twitter-standard-provider-routing.md)：已接入标准 v1/v2，用户返回的 v4 只读验证已确认19条真实归档正确映射、游标保留、零新增采购。下一步执行其中的 `verify-twitter-standard.sh`，验收 Public 标准服务的双版本交付、重放和缓冲续页（最多累计2条供应商调用）；历史排查命令与中间结论保留在下文。

最新标准验收已确认v1首个小页及缓冲第二页成功，第二页同 key 重放409使v2未运行。根因为PostgreSQL内部幂等查询遗漏已保存的供应商标记，缓冲页无自己的供应商调用记录时误选旧供应商。内部投影修正需发布Hub，然后使用原验收命令续验；已有回执和累计采购预算保留，不需要Delta恢复操作。

2026-10-16 用户提供下游策略告警。此次先核对已保存请求，不重发采集。

## 已知事实

- 下游策略标识：`e6b5adb3-8211-4bfe-b2bc-89796752ab78`。这是策略 Key，不能当成 Hub API Key UUID。
- Hub 请求 ID：`554b85cb-3fa7-4559-8941-8b9fcf7d9f70`。
- 平台 Twitter，失败页 1、已完成 0 页、累计入库 0。
- 下游报告窗口：`2026-10-15T07:31:52.275982+00:00` 至 `2026-10-16T07:31:52.275982+00:00`。这不是该笔上游请求确实携带时间过滤的证据。
- 错误：Hub HTTP 502 / `social_upstream_rejected`；保存的上游状态为 400、`outcome=rejected`、`retryable=false`。

当前 RapidAPI adapter 在非 2xx 分支生成此拒绝，在成功响应解析前发生；标准搜索组页和通用 gateway 均会映射成这个公共错误。它不证明客户报价缺失、连接超时、内容解析失败或唯一的参数错误原因。`billed` 需要读实际账本，不能因 HTTP 400 推定免费。

本次不能把下游 `operation=raw` 当作 Hub 实际路径。日志使用 `data_query.hub_standard_request_failed`，而本地 `po-infra/llm/data_query.py` 仍是 legacy 路径及 `hub_legacy_request_failed`，运行版本存在待核对差异。

`po-infra/data_hub/alerts.py` 的“检索式：-”来自 `platform_scope.query_expressions` 缺失时的显示回退；“请求 ID：-”来自 collector 的 `request_ids` 为空。它们不证明实际 query 为 `-`、没有发请求或没有 Hub requestId；错误正文已含本次 UUID。下游采集步骤的 `params.keyword` 和 `Query expression:` 日志可作为补充证据，优先读取 Hub 已保存原请求。

## 与之前的路径编码事故分开

此前请求 `03d6c41f-88c4-42dd-a7f7-eb502d0b148b` 的已校验归档明确返回 `invalid request path`，已在 Twitter 查询路径段补齐 `!'()*` 的百分号转义；详见 [原事故记录](twitter-outcome-unknown-2026-10-15.md)。当前代码保留该修复。

本次尚未取得原 query、400 错误正文或 Public 服务版本，不能直接归因为同一编码问题，也不能将原事故的成功/失败记录代替本次证据。当前 Admin 容器的代码重建仅用于对照，不是历史实际请求 URL 或 Public 镜像版本证明。

## 一次只读取证

已扩展现有 `server/ops/compare-twitter-requests.mjs`：一个 UUID 为单请求诊断；三个 UUID 保留原对比合同。不需要指定“成功对照”，不扫描其他候选请求。

将**更新后的脚本**同步到服务器，在 `electron-dock/mx-insight-hub` 执行：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - 554b85cb-3fa7-4559-8941-8b9fcf7d9f70 \
  < server/ops/compare-twitter-requests.mjs
```

无需重新部署或重启。脚本按唯一 UUID 在 `REPEATABLE READ READ ONLY` 事务内读取原请求、最多 15 条自己的调用，并只检查匹配 Twitter 搜索合同的 rejected HTTP 400 归档。最多 16 KiB，验证实际字节长度、SHA 和 JSON 后输出有限错误字段；不输出凭据、完整业务正文或原始游标。事务最后回滚，不触发供应商请求、状态清理或计费。

预期报告 `diagnosticRevision=twitter-request-diagnostic.v1`、`readOnly=true`、`businessCalls=0`。重点字段：

- `request.owner.apiKeyId`：本次实际 Hub Key，不以策略 Key 或默认 LCY-delta 代替。
- `request.savedInput.path/fields`：原路径、原 query、页大小和游标是否存在。
- `request.ownCalls[]`：自己的上游状态、合同、操作/凭据 revision 和账本状态。
- `request.ownCalls[].rejectedArchive`：完整性通过后投影的 400 错误消息；消息是供应商陈述，不等于独立证实的内部原因。
- `request.currentFirstCall`、`runtime`：明确标为诊断容器当前代码重建和哈希；没有正常化函数也应仍能读取保存证据。

若归档缺失、不完整或消息未提供原因，应保留证据边界，不根据 HTTP 400 猜测语法、改写检索式或自动换键重试。当前下游保存失败页/检查点并隔离该采集单元的行为应保留。

## 本地验证与剩余事项

单请求/原三请求对比及 outcome 诊断共 14 项通过，无跳过，包含实际 PGlite 查询、唯一样本归档读取、回滚和脱敏校验。没有修改 Hub 运行时、下游代码、历史交付、账务、供应商设置、MX-H2I 登录或联网。

## 已返回的生产回执与结论

运营者返回 `twitter-request-diagnostic.v1`，`readOnly=true`、`businessCalls=0`。本次不再需要重复运行同一诊断：

| 证据 | 值 |
| --- | --- |
| 实际入口 | `POST /api/v1/data/search`，Twitter，pageSize=20，无 cursor/params |
| 实际 Hub Key | `fd2f8cc9-0ff1-4052-a538-8cc8150bde83`，tenant `277bf8a4-5ed5-414d-b429-d72fcd7d36b6`，consumer `be7d07fe-3d98-4db3-b00d-e5cbe5a76190` |
| 请求时间 | 2026-10-16 07:33:35.177–07:33:36.438 UTC |
| Hub 交付 | committed，HTTP 502，`social_upstream_rejected`；committed 表示已保存失败响应，不表示业务成功 |
| 唯一供应商调用 | `1fb5fff9-9bd3-4298-8fd0-136bb7ffb978`，RapidAPI `twitter-aio.search`，凭据 revision=1、策略 revision=2 |
| 调用结果 | HTTP 400，rejected，1184ms，`billed=null`，没有供应商业务错误码 |
| 上游 requestId | `e5c1ec8cb84833528ab0f54d46dd9dcac3f73dfb73e6a6f5b8e93ac0ee3ba9ba` |
| 已校验错误正文 | 30 bytes，SHA256 `0e549ec31befa83d4c6b3ea1b60dcba2ba34cb5a7dc600decc8c1e20d762b3e3`，消息 `400, bad request` |
| 原 query | 374 个 JS 字符，UTF-8 520 bytes；SHA256 `8d500e36872a71e061ae3ff4d5029efc42e4b3bb4bcec0c1f20321daa636e7a1` |

不是空检索式，也不是本次在报价准入处被拒。已获得真实供应商响应，不属于先前的未知超时；`billed=null` 仍不能解释为免费。错误正文没有更具体原因，也不是此前的 `invalid request path`。

### 离线请求构造复核

使用本次保存的完整 query，运行实际 `normalizeHubDataSearch → RapidApiAdapter` 并以 mock fetch 截获 URL，没有供应商 HTTP。解码路径后逐字及 SHA 与原 query 一致；编码 pathname 为 1192 bytes，完整 URL 为 1271 bytes，没有截断、fragment 或二次编码。参数仍为 `count=20/category=Top/includeTimestamp=false`。四份本地相关文件 SHA 均与回执 Admin 容器相同。此验证说明当前构造逻辑无复现差异，不能代替历史 Public 实际出站 URL 或版本证据。

原式 374 字符在 Hub 500 字符上限以内。没有取得 Twitter AIO 的字节上限证据，不能因为 UTF-8 为 520 bytes 就断言超过 512 限制。`type=fresh/stable` 都沿用标准搜索的 Top 排序，不等于 Latest；本次保存请求没有时间参数，query 中也没有 since/until，所以告警时间窗不能当作已传给供应商的过滤。排序/窗口是增量采集的另一项适配检查，不是已证明的 400 原因。

2026-10-16 只读查看 [Twitter AIO 官方 Search 页面](https://rapidapi.com/viperscores-viperscores-default/api/twitter-aio/playground/apiendpoint_602d9730-5aec-48f1-ae31-7020727eb762)，未登录或点击 Run：页面仍展示 searchTerm 路径参数、Top 类别、可选 filters（since 示例）与 includeTimestamp=false。文档提醒很长的 cursor 可能触及 GET 长度限制，但未给出本次 query 的布尔语法或具体字节上限；本次没有 cursor。不能从该提醒推出本次长度超限。

### 下游查询需要核对的两项问题

原式结构为 `中文主题组 AND NOT (排除组) AND (英文主题组 AND 英文动态词组 -ad -marketing -repost)`。

1. **语法兼容性待验证。** [X 官方查询语法](https://docs.x.com/x-api/posts/search/integrate/build-a-query)使用空格表达 AND、`-` 表达排除，并要求逐项排除而非对整个组取反。当前原式混用 `AND NOT (...)` 与 `-ad`。这说明值得检查平台专用序列化，但原生 X 文档不是 Twitter AIO 的合同，不能据此宣称已找到此次 400 的唯一根因。不得在 Hub 用字符串替换静默改写查询。
2. **跨语言召回语义需要业务确认。** 按表达式预期的布尔逻辑，中英文主题及英文动态词都必须命中；若目标是中英文任一语言的亚太外交内容，这与目标不符，应该在下游审核版策略中把对应语言分支作为备选。即使改语法后接口成功，保留这个交集也可能大量漏召回。

本地 `po-infra/data_hub/query_guidance.py` 已要求跨语言同义表达组内 OR；带 topic/entity 角色的 atomic compiler 会合并 anchor，而无角色历史 blueprint 仍可能组间 AND。自由文本规划入口允许完整布尔式，保存时未统一检查此问题。原式仅凭文本不能确定来自哪个生成器，需以该策略的已保存版本为准；本次没有修改外部 po-infra 仓库或线上策略。

### 后续处理边界

- 当前没有已复现的 Hub 编码、参数截断或路由错误，不再添加猜测性的运行时修复。
- 下游先核对策略 `e6b5adb3-8211-4bfe-b2bc-89796752ab78` 的当前表达式和目标语义；平台语法调整与中英 OR 调整分别审阅，避免把语义变化伪装成编码修复。
- 若需供应商确认，可提供上面的 RapidAPI requestId、时间、HTTP 400 和 query SHA，由供应商核对拒绝原因。本次未代发任何消息。已保存错误仅为泛化 400；继续读取同一批日志无法补出供应商未返回的内部原因。
- 在线对照必须是明确发起的新业务请求，可能消耗额度；本次没有自动重试、切换供应商、修改幂等身份、清理失败记录或解锁采集检查点。

**本次只补充事故证据与处理建议，未确认线上恢复。** MX-H2I 登录、联网及 Hub/Pay 账务配置保持原状。

## 2026-10-18 新告警：b5906846 的上游 400

用户回传请求 `b5906846-8564-4791-8b83-ef3ce97789bc`，计划 `c4298858-948a-434b-bef6-d4d3b2c30ea4`、Run `8a61e985-ece8-4127-a97e-b80e73499337`。错误为 Hub HTTP 502、`social_upstream_rejected`，details 明确 `upstreamStatus=400`、`outcome=rejected`、`retryable=false`。这证明请求取得了上游拒绝响应，不是网关 HTML 404、准入等待或 unknown。

用户已执行现有单 UUID 诊断并返回完整回执，下面的命令只作留档，无需重复执行：

```sh
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - b5906846-8564-4791-8b83-ef3ce97789bc \
  < server/ops/compare-twitter-requests.mjs
```

回执确认本请求在 **2026-10-18 13:00:11.640–13:00:13.215 Asia/Shanghai** 发生 live 调用。唯一供应商调用 `98828234-9aa4-4f1a-88ac-f7db09f54b1e` 是 RapidAPI `twitter-aio.search` primary，1267ms 后 rejected/HTTP400，`billed=null`。归档长度 30 bytes、SHA `0e549ec31befa83d4c6b3ea1b60dcba2ba34cb5a7dc600decc8c1e20d762b3e3` 已校验，仅含 `400, bad request`。上游 requestId 为 `74e8c579cae4bcf8a8abfbd73c57b80d1826cb0fcaad5b8bc295fca9fb9e66f7`，可供供应商进一步定位；本次没有代发消息。

`committed` 表示该 502 已保存，不能解释为采集成功。记录确认当时发生了新上游调用，但后续告警仍可能重放该失败。v2 内部采购也可能保存 `/api/v1/data/search` acquisition 快照；此诊断未读外层 protocol binding，不能仅凭该路径判定 Delta 没有升级 v2。`billed=null` 也不能证明免费。

原保存 query 的 SHA `f8f3da5a20307fa43713d737199766faa376498fe825ea69889b171f72a37386` 与离线截图转录样本一致：280 字符、370 UTF-8 bytes。实际 normalizer → RapidAPI adapter 的离线往返逐字一致，没有截断或 fragment，完整 URL 为 915 字符；四份本地文件 SHA 与本次 Admin 诊断回执一致。这是当前代码验证，仍不是历史 Public 出站 URL 证据。查询低于 Hub 500 字符上限，没有已确认的供应商长度上限或 Boolean 拒绝原因，不按猜测修改查询、日期或供应商。供应商仅返回泛化 400，继续读取同一归档不能补出其未返回的内部原因。

另已在 Delta 实际 collector/task 函数中离线复现并修复一处独立错误：`retryable=false` 在 HTTP 包装层被丢弃，冷启动因此仍调度 10/30/60 秒重试。标准 v1/v2 仅在结构化 `social_upstream_rejected/outcome=rejected/retryable=false` 时保留不可重试标识，collector 透传并停止冷启动短重试；不把拒绝改成 unknown，不清失败记录或改页身份。标准 v1 非 Facebook 旧任务可能按新 Step 生成新 key，测试已覆盖这一差异，不能笼统承诺旧重复尝试都使用同 key。

5 项新增回归与既有 unknown、准入等待、v1/v2、日报测试合跑 **95/95 通过**；Hub 路径编码回归 **5/5 通过**。这些均为本地离线验证，无供应商采购或线上修改。发布 Delta Web/beat/workers 后可停止这类无效重试，**不代表本请求的供应商 400 已解决或冷启动已恢复**。Hub 本轮未修改运行时、路由、配额或 MX-H2I 登录联网。

## 2026-10-18 继续修复：Twitter 原生查询语法

用户进一步要求修复实际采集，不能只停止重试。以下是本次新增的合同证据与实现，前面的只读结论保留为历史记录。

### 供应商合同与生成链路

[Twitter AIO 官方 Search 文档](https://www.twittrapi.com/docs/reference/search)明确说明沿用 X 搜索框语法，`GET /search?searchItem=...` 和 `GET /search/{searchItem}` 使用相同处理器，并推荐新代码使用查询参数形式。这不证明两种形式在 RapidAPI 网关经过完全相同的路径处理，需用同一完整查询作对照，不能预先认定切换必然有效。文档给出组合查询与过滤条件的 512 **字符**限制，不是 UTF-8 字节限制。本次原式 280 字符，不支持“长度超限”归因。

[供应商查询示例](https://www.twittrapi.com/blog/search-twitter-without-developer-account)使用空格连接必选条件、`OR` 连接备选词、`-` 排除词；[X 查询文档](https://docs.x.com/x-api/posts/search/integrate/build-a-query)也说明逐词排除，不能把 `NOT (a OR b)` 直接当作原生语法。供应商[错误说明](https://www.twittrapi.com/docs/helpful-infos/error-handling)中，400 也可能表示未分类的 X 错误，因此原响应的泛化 `400, bad request` 仍不足以单独证明唯一原因。

本地 Delta `data_hub/keyword_config.py` 的 `keyword_expression` 生成通用 `AND/NOT` 规则，`bind_keyword_queries` 再与平台查询组合；`platform_query_llm.py` 允许模型生成平台原生表达式。这能解释当前混合语法的生成路径。本次不改下游已冻结的查询或页身份，在 Hub 的供应商适配边界处理。

### 已实现的兼容行为

`server/contracts/twitter-search-query.mjs` 对明确的布尔子集进行有界解析，不做全局字符串替换：

```text
a AND b                → a b
a AND NOT (b OR c)     → a -b -c
(a OR b) AND (c OR d)  → (a OR b) (c OR d)
```

本次完整查询编译后为 257 字符，保留全部正向组、全部排除词及中英文组之间的交集：

```text
("外交" OR "外交部" OR "外交政策" OR "外交关系" OR "外交动态" OR "外交表态" OR "外交事件" OR "外交议题" OR "外交回应" OR "外交澄清") -"广告" -"营销" -"重复搬运" ("diplomacy" OR "foreign policy" OR "diplomatic relations") ("statement" OR "response" OR "clarification" OR "update") -ad -marketing -repost
```

- 标准 `/api/v1/data/search` 及 v2 的新 Twitter 首次采购使用兼容结果。原 query、业务指纹、页大小、Top 排序、时间窗、供应商端点合同不变；已有原生语法逐字透传。
- 新分页的签名内层游标签入 `queryDialect=twitter.boolean.v1`，第二页与后续页固定此语法。旧无标记游标继续原语法；未知版本不能换语法继续。v2 外层游标保留原时间窗及内层标记。
- 引号内文本、原生字段不作为 SQL 运算符。无法证明等价的形状（例如未加引号的 `url:example.com/a(b)`、否定的合取组或负向 OR 分支）在标准入口原样透传，不静默拓宽条件，也不因新增验证挡住旧交付重放。
- 不变更原失败回执、幂等键、账务和 unknown 保护。相同旧 key 仍可能重放已保存的 502；不能把部署新编译器等同于原 Run 已恢复。原始 raw/social 兼容入口保持原语义。

### 已完成的真实验证

| 查询与方式 | Hub requestId | 结果 |
| --- | --- | --- |
| 原混合语法、路径参数 | `b5906846-8564-4791-8b83-ef3ce97789bc` | 上游 400，Hub 502 |
| 完整等价原生语法、路径参数 | `e5c6fddf-eb56-4d9b-afef-38727910a072` | 上游 400，Hub 502 |
| 原计划简单词对照，输出却仍为 candidate | `9faad699-5178-4d00-8af5-bcab5d2867ba` | 上游 400，Hub 502；不能算作简单词对照 |
| 明确指定 `OpenAI`、路径参数、stable | `888b6a78-dd8e-4c3b-b82d-bebc443abe39` | HTTP 200，20 条，hasMore=true，providerCalls=1，dataStatus=ok |
| 完整等价原生语法、查询参数 | `22e3c544-db09-461f-be46-550bda290c73` | 上游 400，Hub 502；一次明确拒绝，原请求不变 |
| 中文子式 115 字符、路径参数 | `94cf23d2-fc3d-4d67-8eac-e55f6b9e8805` | HTTP 200，20 条，hasMore=true；唯一供应商调用 succeeded/200 |
| 英文子式 141 字符、路径参数 | `030c9a71-a749-4870-8511-f2df1fc19132` | 上游 400，Hub 502；唯一供应商调用 rejected/400 |
| 英文两组显式 AND，145 字符、路径参数 | `9b15c0e6-5ca7-4ff9-9a3f-5c418e3afa06` | 上游 400，Hub 502；唯一供应商调用 rejected/400，未执行完整式 |

简单词成功输出为 `twitter-query-compat-check.v2`、`case=control`、`requestType=stable`，query SHA 为 `8b7d1a3187ab355dc31bc683aaa71ab5ed217940c12196a9cd5f4ca984babfa4`。这证明当前链路、认证和 Top/count20 的基本搜索可用；完整查询的 400 仍未解决，不能把简单词的结果替换为业务冷启动成功。窗口未传入该旧 v1 请求，coverageComplete=null。

完整候选 SHA 为 `1f56dcc7e0521efdb6bed09df10ff0c72ab2615940a880b45b963ccfd852e215`。原 Run 确认为 `/api/v1/data/search`、没有 v2 contract 或持久化页 ledger；验证没有修改原任务。SQL 布尔语法转换不足以解决当前 400，**上述兼容实现尚不是已验证的事故修复**。RequestsDependencyWarning 也不能解释已收到的供应商 400。

第三次结果仍选择 candidate 的具体原因尚未确认。另需纠正此前“固定 key 可防重复采购”的描述：旧 v1 默认 fresh 仅有 120 秒回放窗口，超过窗口后可能产生新采购；不能只靠固定 key 保证永久回放，也不能仅凭顶层 requestId 变化判断采购。真实 unknown 不会因窗口过期放开。

### 当前验证脚本与重复执行边界

`server/ops/verify-twitter-query-compat.py` 修订为 v2，默认只预览；已经失败的完整 candidate 禁止再次执行。control 显式写入最终 HTTP 请求的 `type=stable`，固定新验证 key `delta-twitter-compat-cb68cde0557eb3c1c3365995c6f4f062a00abee4`，遵循 Hub 稳定回放。该保留模式调整只用于独立诊断，供应商 Top/count20 和原任务均不变。

已使用以下命令取得上面的成功回执，**无需再次执行**：

```sh
docker exec -i delta_59202-worker-1 python manage.py shell -c 'import sys; n={"__name__":"twitter_compat_payload"}; exec(compile(sys.stdin.read(),"<twitter-query-check>","exec"),n); n.get("REVISION")=="twitter-query-compat-check.v2" or sys.exit("Outdated diagnostic; no HTTP sent"); n["main"](case="control",execute=True)' < server/ops/verify-twitter-query-compat.py
```

这最多发一条 Hub HTTP；Hub 内部可能多次调用供应商组页，本次实际为 1 次。不跟进下一页、不自动换网络重发、不写 Delta 业务状态、不清除 unknown。成功首页不能证明完整时间窗覆盖或原冷启动入库完成。

### 已完成的传输形式对照

Night-All 旧 `_request_search` 与 Hub 的路径编码、count、Top、includeTimestamp=false 已再次核对一致，未发现这些参数差异。随后对照了官方推荐的 `GET /search?searchItem=...`，仍使用完整 257 字符候选查询，不拆组、不减少条件、不改变中英文交集。

`server/ops/verify-twitter-query-param.mjs` 的完整 candidate 查询参数对照已经执行，历史回执修订号为 `twitter-query-param-check.v1`、case=candidate、endpointVariant=`GET /search?searchItem`。该案例不再需要执行，当前入口见下方显式 AND 对照。`adapterCalls` 仅表示进入适配器的次数，是否真正到达供应商以保存的 `providerCalls` 回执为准。

该独立诊断使用现有 raw 单页网关、原 Twitter 平台授权、数据库凭据、代理和计费归档，不要求新增 capability。为了与已失败的标准搜索对照，诊断明确把 raw 默认 Latest 钉回 Top。它不改变生产 raw 合同，也不代表标准搜索的组页交付或 Delta 冷启动恢复。

派发前核验 b590 原请求和 e5c6/9faad 两个已知候选的相同 owner、完整查询、已保存的明确 400；缺失或 unknown 则停止。固定探针 key 一旦已有任意状态的 usage 即只读返回，不重新派发；仍保留同查询 v2 binding/lease 阻断。这是本次固定样本的保护范围，不宣称完成了所有历史 v1 请求的全库 unknown 排查。初版 8 项离线测试通过，并经独立复审。

用户已返回 `twitter-query-param-check.v1`：完整候选仍为 HTTP 502 / `social_upstream_rejected`，唯一调用 `38e539e4-eeb8-497a-bbee-b5f6c681a2bf` 保存 rejected/HTTP400，上游 requestId 为 `9477759c4bcc19bf7c6cfc8957779492782da853e51426603d75db74056e3eee`。原请求未改变。`command terminated with exit code 1` 是脚本有意报告失败，不是 kubectl 没运行成功。无需再次执行该完整候选对照，也不能将切换传输形式作为有效修复发布。

### 查询结构与下一步分解

完整原生式含 17 个正向词、6 个排除词、14 个 OR、3 个括号组；257 字符、347 UTF-8 字节。当前结构已经因式分解，展开为全部组合会产生 120 个分支；不能贸然引入自动分拆采购。没有公开证据证明存在 256 字符或特定 OR 数量限制。

[X 网页搜索帮助](https://help.x.com/en/using-x/advanced-xpro-features)明确示范多组 OR 使用 AND 连接，[X 运算符文档](https://docs.x.com/x-api/posts/search/integrate/operators)也示范带引号的排除短语。显式 AND、多个组或负向引号本身不能被定为此次根因。普通词与引号短语的匹配不同，也不能把“外交”是其他中文词的字串前缀当作删词依据。

只读核查 Delta 实际 `bind_keyword_queries` 和 `clean_queries` 能重建原 280 字表达式及相同 SHA，重复绑定不会继续加层。`keyword_config` 在现有合同和测试里是硬条件，平台查询以 AND 绑定；改中英文 AND 为 OR 会改变业务。未传配置时共享自动生成与逐平台生成的差异是另一项生成质量问题，尚未证实本事故配置来源，不修改已冻结任务。

已经执行的 halves 诊断将原式分为恰好由 AND 连接的两个部分，仍保留各自原有引号与排除词：

```text
CN（115字符）：
("外交" OR "外交部" OR "外交政策" OR "外交关系" OR "外交动态" OR "外交表态" OR "外交事件" OR "外交议题" OR "外交回应" OR "外交澄清") -"广告" -"营销" -"重复搬运"

EN（141字符）：
("diplomacy" OR "foreign policy" OR "diplomatic relations") ("statement" OR "response" OR "clarification" OR "update") -ad -marketing -repost
```

使用已成功简单词对照的路径形式，保持 Top/count20。每个子式最多一页、一次 adapter 调用；子式成功不能替代完整业务交付，更不能把两个首屏的交集当完整结果。若只有一个部分被拒，后续只定位该部分；若都成功，说明拒绝与完整组合有关，但仍不能确定内部复杂度阈值或具体原因。

用户后续返回的是修订号 v2 的 `case=candidate`，`adapterCalls=0`，读取既有 `22e3...` 失败回执；这不是新的 400，也不是 halves 结果。核查 CLI 后，没有将 `--case=halves` 转成 candidate 的分支；环境变量也不选择 case，具体执行或复制差异无法由输出确认。文档移除已完成的 candidate 执行命令，避免误选。

无参数入口 `server/ops/verify-twitter-query-halves.sh` 固定 `--case=halves --execute`，该步骤已取得下面的线上回执，无需再执行。它应直接由宿主机 Bash 运行；曾将 `.sh` 内容交给 Node 的一次执行在解析阶段失败，没有供应商调用。

这是显式的真实验证入口，最多顺序派发两次，可能消耗两次供应商额度。入口拒绝所有额外参数，并在调用集群前检查同目录源文件修订号；不需要部署镜像。先核验完整候选的三次明确拒绝，只有第一子式已有保存的成功或明确 400 回执，才继续第二子式；unknown、缺失证据或其他状态停止。已经有记录的子式不再派发，v1 已发出的 candidate/control key 保持原样。输出 `diagnosticRevision=twitter-query-param-check.v2`、`case=halves`、`maxAdapterCalls=2`、两个 `reports`；如果有 `stoppedAfter`，以该项错误为准。

这仍是独立诊断，没有新生产接口或 Delta 操作，也没有变更原失败任务。此前 16 项离线测试通过，覆盖最多两次、重复执行无采购、第一项 unknown 阻止第二项、原回执核对、原 key 不变、原平台授权、stdin 导入无执行副作用，以及 shell 入口固定参数、任意工作目录、缺失/旧文件提前停止。Shell 测试使用假的 kubectl，未访问集群。

### 两段线上结果与显式 AND 对照

用户提供的 `twitter-query-param-check.v2 / case=halves` 已确认两次实际供应商回执：

- 中文 `94cf23d2-fc3d-4d67-8eac-e55f6b9e8805`：保存为 committed/200，唯一调用 `ecd75717-1aa5-4f0d-9e24-32f69dab009d` succeeded/200，20 条且 hasMore=true。
- 英文 `030c9a71-a749-4870-8511-f2df1fc19132`：保存为 committed/502，唯一调用 `e1524a1a-e427-4389-9fb1-697558e526ad` rejected/400。

英文部分单独失败，所以下一步只检查英文条件的兼容性，不再重复完整失败式或中文成功式。该证据不能证明英文、多词短语、负词或所有多组 OR 都不支持，也不能把 400 当成无结果。

v3 的 `english-and` 对照先保持英文所有条件不变，只将两个 OR 组间的空格合取写成显式 AND：

```text
("diplomacy" OR "foreign policy" OR "diplomatic relations") AND ("statement" OR "response" OR "clarification" OR "update") -ad -marketing -repost
```

[X 官方示例](https://help.x.com/en/using-x/advanced-xpro-features)支持两个 OR 组用 AND 连接；这是一项等价写法对照，实际结果仍失败，不能作为修复。现有生产编译器会把显式 AND 再转换为空格，因此诊断在私有适配器内固定并校验真正发出的字符串、路径及 Top/count20，生产编译器和旧分页方言不变。

诊断的用量身份与 unknown 检查继续使用原 native 查询，新的固定 key 同时绑定显式 AND 文本。报告区分原查询与预期供应商查询的 hash；数据库原有 provider call 回执并不保存出站 URL，不能将重读旧回执说成一次新的 URL 验证。离线测试检查实际适配器生成的 URL，线上首次执行与已有回执分别报告。

先核对上述中文成功、英文明确拒绝及原有失败回执；英文显式 AND 有保存的成功回执才继续完整业务式的相同改写。英文仍拒绝、unknown、缺失证据或其他失败都会停止。最多两次供应商请求，不翻页，不修改 Delta 或原 Run；已有探测记录只读取、不重发。英文成功不能代替完整式成功，完整式一页成功也不能代替原冷启动入库及完整窗口验收。

该对照通过 `verify-twitter-query-and.sh` 已执行，无需再运行。用户回执为 `twitter-query-param-check.v3 / english-and`，本次 adapter handoff 的 SHA `de258a4ed11e7694cc2e1b39c4f73b8406e4902ca721d45b1a636791015590fd`、长度145；保存请求 `9b15c0e6-5ca7-4ff9-9a3f-5c418e3afa06` committed/502，唯一调用 `4fa2fa1c-2889-4238-9370-25802866c877` rejected/400，上游 ID `e60a6e2d9cb5038958ce1086e592089dafd43b2bd5f54fac4363851834445a72`。总调用一次，在英文项停止，没有调用完整265字符式。脚本退出码1只是该失败的退出状态，不是 kubectl 链路故障。显式 AND 并未解决英文子式的400；不能因此断言全部多词短语、否定词或英文均不支持。

本轮 27 项离线检查全部通过，包含旧 native 400 后新 AND key 的真实适配器 URL 对照、原词/引号/排除不丢失、英文拒绝/unknown 不进入完整式、回放零派发、跨版本 unknown 阻断、固定入口参数与实际 JavaScript stdin 内容；未调用线上供应商。

### 英文两个正向组对照与 HTTP 200 解析失败

v4 将英文主题组与事件组分别作为诊断查询，保留各组内部原文、引号、OR 及全部三个排除词，保持 Top/count20 与路径形式：

```text
主题组：("diplomacy" OR "foreign policy" OR "diplomatic relations") -ad -marketing -repost
事件组：("statement" OR "response" OR "clarification" OR "update") -ad -marketing -repost
```

这是两项独立的诊断子式，不能代替完整业务条件。若只有一组失败，后续定位该组；若两组都成功，只能说明本次各组可用而此前组合被拒，仍不能证明供应商内部语法或复杂度原因；若两组都失败，再检查共同的排除条件与各组原子。不能把400标为空页，也不能将两个首屏拼接、求交集后视为完整业务结果。

v4 在派发前核对原失败、两半回执和上述精确显式AND拒绝（包括原 key、输入、所有权及唯一调用）。最多顺序两次、每项一页；第一项只有保存的成功或明确400才继续第二项，unknown、缺证据、其他失败停止。旧诊断 key 不变，已有记录只读取，不重新采购；不改生产编译器、分页方言、Delta 或原Run，不清除unknown。

用户已执行 `verify-twitter-query-groups.sh`，返回 `twitter-query-param-check.v4 / english-groups`。只执行了第一项 `english_topics`：

- 请求 `f89f7c4c-6fee-416c-8917-58970e78215e`，保存为 committed/502，错误为 `social_upstream_response_unusable`。
- 唯一供应商调用 `315bed17-f844-4346-8819-e0bfad1e4968` 返回 **HTTP 200**，Hub 记录为 `succeeded_unusable`；这不是新的供应商400，也不是可交付成功。
- 主题组82字符，SHA `3999e9f44235eb90fb3a356fa531ea8bcdb2ed42f0fa953af183ff81462f813a`；固定 key `ops-twitter-group-34bef51fbabafecb50b9a0ac505c123e9584ea7ce6693b59`。
- `savedOutcomeVerified=null`，在主题组停止，事件组尚未执行。不得将这个结果解释为英文组、完整业务式或冷启动已成功。

随后现有只读脚本 `diagnose-twitter-search.mjs` 已核实同一归档：196012字节，SHA `a1b6584bf6fa39d0db9ba4f5c26a699c74003c167e83af844d715edb592dbedd`，固定结构中有21个Tweet结果（含一个可见性包装、一个双项模块），存在Bottom游标，无根级错误，当前解析器明确报 `upstream_page_exceeds_requested_count`。不需要重复这项诊断。

这是raw诊断合同的count20限制，不是本次主题组供应商400；标准搜索已有超额页缓冲。不能因此放宽所有raw响应或宣称原完整式400已修复。脚本的 `mapping.category=Latest` 来自保存输入的默认映射，本次探测通过私有适配器使用Top，该字段不代表实际历史出站参数。

### v5 结果：主题组可解析，事件组仍被拒绝

v5 修正诊断流程，生产解析器与raw合同不变：主题组只读取已有记录，不再发送请求；归档须通过原调用所有权、固定输入、唯一调用、committed/502、succeeded_unusable/HTTP200、错误类型、长度与SHA核对。离线严格解析必须仍得到同一超额错误，允许超额的解析必须成功，才记录独立的 `archiveObservation.state=valid_overflow_response`。保留原 `savedOutcomeVerified=null`、502与所有历史记录，不生成新交付或向Delta入库。unknown、其他解析错误、归档缺失或损坏均不允许继续。

v5 仅执行此前未完成的事件组，最多新增一次供应商请求；若事件组也返回超额页，使用相同离线归档判断，不重新采购。重复运行只读取已有事件组记录；主题组缺失时停止，绝不补发。`archiveValidatedGroups` 单独列出归档可解析的组，不混入 `succeededGroups`。这些观察仍不能代替完整查询或冷启动验收。

该步骤已完成，无需再次执行groups入口。用户返回 `twitter-query-param-check.v5 / english-groups`：主题组adapterCalls=0，原196012字节归档SHA一致，离线解析21条、overflowCount=1、hasMore=true，原502不变。事件组adapterCalls=1，请求 `6f52fed6-ccfa-4f87-82b0-cb530d94363d` committed/502，唯一调用 `bde0fce4-bb51-49a6-8977-bc6e4dfac71a` rejected/400，上游ID `e44b76b1b25f17834482cac1b27d42266dff544c0b2fabdcd2bd0ac4b0b6f2e6`。事件组81字符，SHA `b79f0655a1b710c7be1e3a9631eee80b95663fad0694d6dc290eddd71a10b552`，固定key `ops-twitter-group-4ab63c1b8204c5c155156ca674661666f587e5b362c21abb`。

因此失败已在较短的事件组单独复现；主题组的成功证明这些引号、OR及共同排除词并非普遍不可用，但不能定位某个词，也不能断言是WAF、长度限制或供应商内部复杂度。完整式的400与冷启动恢复仍未解决。

### v6 结果：保留条件的 OR 顺序对照仍被拒绝

v6 固定比较下面的事件组，只有OR内部四个原子调换顺序：

```text
("update" OR "clarification" OR "response" OR "statement") -ad -marketing -repost
```

[X逻辑运算符文档](https://docs.x.com/x-api/posts/search/integrate/operators)定义OR、空格合取、括号和负词。该对照保留相同布尔条件、引号与排除词，不承诺供应商结果排序相同。[供应商错误说明](https://www.twittrapi.com/docs/helpful-infos/error-handling)也允许400来自未能归类的X错误，因此不能仅凭状态码判定词或语法不受支持。

先验证这个81字符的等价事件组；仅有已保存成功或校验通过的超额归档，才执行完整257字符式的同一改写。完整式其余部分逐字保留，不删词、不将AND改OR、不拆成多路采集。最多两次新的供应商调用，不翻页；拒绝、unknown、证据不符或其他不可用结果均停止后续。必须先核验上述6f52/bde0的精确拒绝及原key、所有权、输入和唯一调用；原native查询继续用于跨版本保护，新固定诊断key同时绑定原查询与发送形式，已有记录只读不重发。

若新事件组仍触发raw超额错误，其归档可离线确认，但短暂隔离期仍生效。脚本按数据库时间保守等待满5分钟的条件检查，在此之前返回 `event_order_full_query_deferred` 和 `continuationNotBefore`，不会创建完整式请求或消耗它的固定身份；到时执行同一入口只读事件组，再继续完整式。它不清除隔离期，实际执行仍经过所有现有准入检查。

该步骤已执行，无需再次运行order入口。v6反向顺序事件组请求 `019601cf-dc6d-42ad-b2b5-e30f46935816`，唯一供应商调用 `d4edacaa-6068-434e-bfe7-1020de91dfe8` 仍返回HTTP400；完整257字符式没有执行。此次对照未找到可用改写，也没有触发上述超额页续接。不能据此认定某个事件词不可搜索，不能把原始事件组和反向事件组的失败解释为所有OR顺序均被拒绝。

v6 联合检查64项通过、1项既有可选PGlite检查跳过。新增验证包括512组布尔真值、实际供应商URL中的原子置换、事件组及完整式的原native保护身份、固定历史拒绝、首次失败不执行完整式、超额响应离线观察、数据库时间异常时停止，以及冷却期内不创建完整式请求、期满后只发完整式的续接。未调用线上供应商或修改生产配置。

### v7 结果：词对和单词对照将失败缩小到 update 查询

v7的 `event-terms` 先分别查询以下两个固定词对，保留原引号、排除词、Top/count20和路径形式：

```text
("statement" OR "response") -ad -marketing -repost
("clarification" OR "update") -ad -marketing -repost
```

两个词对都先检查完；只有已保存为明确HTTP400拒绝的词对，才继续查询该词对的两个单词。单词仍保留引号以及三个排除词，例如 `"statement" -ad -marketing -repost`。成功的词对不拆分；unknown、未确认结果、身份或归档校验失败均停止后续。首次在结果明确时需要两次到六次调用，最多六次，不翻页；已有固定探针记录仅只读，不重新采购。每次实际调用可能消耗供应商额度。

这一步用于区分“哪个词对能够正常返回、哪个词对或单词仍被拒绝”，不是新的业务检索式。它不执行完整查询，不将子查询结果拼接或交付给Delta，也不修改原Run、业务窗口、旧任务或历史回执。原冷启动仍未恢复；即使单词失败，也只能确认本次固定条件下的供应商结果，不能仅凭400断言关键词封禁或内部根因。

针对此前count20实际返回21条导致诊断中断的问题，v7仅在新探针的私有适配器中使用完整供应商单页解析，保留并归档供应商返回的整页；21或22条不会单因超过请求count20而被判为不可用。不跟进供应商游标，不启动标准搜索组页，也不把这份诊断采集等同于20条业务交付。生产raw接口的条数合同、正常解析错误、准入限制和unknown保护保持原样；旧探针的502与归档不会被改写。

该步骤已完成，无需再运行terms入口。实际执行四次：第一个词对成功，第二个词对400，因此只拆分第二个词对。

| 查询 | 已保存请求 | 唯一供应商调用 | 结果 |
| --- | --- | --- | --- |
| `("statement" OR "response") -ad -marketing -repost` | `892f2db5-07c6-463d-9232-6b0ea694731c` | `a805b83a-6dc2-419f-8cc1-1dc9f2748413` | HTTP200，20条 |
| `("clarification" OR "update") -ad -marketing -repost` | `09a576b4-8a04-436b-97cb-b2f94631c806` | `001287f4-8797-4ed1-88be-2636ec072fea` | HTTP400 |
| `"clarification" -ad -marketing -repost` | `5083a1a0-c5f6-485e-8454-223abf9444a6` | `4daa0eed-3160-4ba0-b19e-06029eb4ff2f` | HTTP200，27条完整供应商页 |
| `"update" -ad -marketing -repost` | `b552925a-6396-4e8e-b14c-92bf583835df` | `86a1bede-c6e6-4e7f-a5c2-502162048b5d` | HTTP400 |

这确认31字符的update查询也能复现400；clarification的27条已由仅限新探针的整页解析正常保留，没有再次被count20限制阻断。英文主题组、statement/response词对和clarification均有成功结果，因此不能笼统解释为“英文不能搜”。仍不能仅凭这些回执认定update被永久屏蔽，或断言出站IP、WAF、语法就是供应商内部根因。未执行完整查询，未恢复原冷启动。

v7联合检查76项通过、1项可选PGlite检查因未配置模块跳过，独立复审通过。覆盖实际适配器的2/4/6次调用、21/22条完整供应商页、旧raw超额502保持不变、原请求与固定历史证据、已保存探针只读、unknown/未确认失败停止、当前授权及v2保护，以及五个Bash入口的实际stdin和版本检查。本地验证使用离线响应，没有线上采购或部署；生产编译器与MX-H2I登录联网未修改。

### v8 结果：宿主机7788代理未解决拒绝

v8的 `host-proxy` 保留同一供应商、查询原文、引号、排除词、Top/count20及路径形式，仅为这次诊断进程固定HTTP代理 `http://127.0.0.1:7788`。先查已失败的完整31字符子式 `"update" -ad -marketing -repost`；只有获得归属明确、已保存的HTTP200成功回执，才继续完整257字符业务候选式。最多两次新的供应商调用，可能消耗额度；不翻页、不删除update、不把中英文AND改OR。失败、unknown或证据不全即停止，已存在的固定探针身份只读，不重发。

该代理地址必须属于**实际运行Hub Admin Pod的Kubernetes节点**，不能拿Delta Docker宿主机上的127.0.0.1代替。新入口先通过标签 `app.kubernetes.io/name=mx-insight-hub-admin` 读取Running Pod，要求恰好一个未终止的实例、Pod Ready、admin容器就绪且 `hostNetwork=true`，随后exec刚检查的同一个Pod名。没有实例、滚动更新期间多个运行实例、未就绪或未启用hostNetwork时，入口会在启动诊断前退出。宿主机仅需Bash和kubectl，不需要Node；Node在选定的Admin容器中运行。

当前实际代理配置仍需本次运行确认，历史回执没有保存实际出站路由，不能将旧400描述为已经证明“直连”或“中国IP”。将本次请求明确交给7788，只能证明指定的代理入口被使用；它本身不能证明最终出口是国外IP。即使改路由后成功，也需要结合相同条件的保存回执判断，不能单凭一次结果确定IP地理位置是原因。[供应商错误说明](https://www.twittrapi.com/docs/helpful-infos/error-handling)和[X逻辑运算符文档](https://docs.x.com/x-api/posts/search/integrate/operators)仍是语法及错误解释的边界。

该步骤已完成，无需再运行proxy入口。请求 `d6ffc7e8-d736-4b7e-999b-a8af15755ee0` 已保存为committed/502，唯一供应商调用 `87e933ba-85fd-47da-9717-77acb61482ff` 仍为rejected/400，上游ID `c832fc557ff378fec834ae1b9ab4d32819ca7aa1a9aaf6fa63cfe2f8ad8a37df`。本次固定走7788、无直连回退，只发送了31字符update子式，完整式未发送。

当前普通路由快照为 `source=system`、无显式代理端点、允许直连回退；这不是历史出口证据，也不能据此判断出口国家。7788未解决拒绝，英文成功记录也已经排除“英文整体不可搜索”。仍不能从供应商笼统400确定是update单词、引号与排除条件的组合，还是供应商内部错误。不要继续重复已失败的词序、出口及传输形式对照，不要删词或扩大原业务条件。

v8联合验证113项通过、1项既有可选PGlite检查跳过：探针60项、入口20项、解析9项及1项跳过、代理24项。代理HTTP测试首次因沙箱禁止监听本地端口失败，取得本地监听权限后该24项全部通过。覆盖代理路径固定且不直连回退、一次无认证连通性探测后最多一次认证业务请求、旧400身份核验与unknown保护、update未成功不执行完整式、原查询不变、当前路由凭据脱敏，以及Pod就绪/hostNetwork核验和固定Pod执行。未调用线上供应商或部署，复审未发现阻塞问题。

### TikHub 首次结果：配置就绪，尚未发送供应商请求

继续使用原供应商更换路径、OR顺序或7788出口都没有找到可用路径，下一步通过Hub已经实现的TikHub原生入口验证完整257字符候选式。它保留原280字符业务式的全部布尔条件，没有移除update、引号、排除词或任何OR分支。

[TikHub官方接口](https://docs.tikhub.io/215701673e0)为 `GET /api/v1/twitter/web/fetch_search_timeline`，现有Hub入口为 `POST /api/v1/data/native/t.twitter_web_fetch_search_timeline`，请求包含 `params.keyword` 和 `params.search_type="Top"`。供应商没有声明count参数，单页数量由供应商决定；不伪造count20、不翻页，也不把结果条数当作完整窗口覆盖。此次对照仍沿用原已保存请求中没有日期参数的条件，不代表原Run时间窗已经验证。

首次 v1 独立入口 `verify-twitter-tikhub.sh` / `verify-twitter-tikhub.mjs` 不要求更新v8文件或部署镜像。先读取当前配置和原调用身份；凭据未配置、操作未开放、原Key缺少现有原生接口权限时返回具体未就绪状态，零采购，不自动改授权或启用操作。具备条件时最多调用一次TikHub完整查询，可能消耗该供应商及Hub额度；已有固定诊断请求仅检查保存记录，不重新采购。调用经过现有TikHub网关、业务码检查、计费和归档；仅返回状态、条数与分页结构，不输出密钥、正文或游标。

```sh
bash server/ops/verify-twitter-tikhub.sh
```

诊断对原SQL查询与等价native查询都保留搜索协议保护。原生请求若unknown或结果无法确认，两种查询在后续v1/v2都不能借换接口绕过；明确结果以“诊断不是标准交付”的终态结束保护，不保存伪造的v2成功响应。它不清除历史unknown，不改原Run，不改全局代理，不修改MX-H2I登录联网。成功后还需要将经验证的供应商接入标准Twitter搜索，并验证原任务时间窗、分页与入库，当前不能宣布冷启动恢复。

v1 的20项离线测试通过，JS/Bash语法检查与独立复审通过；覆盖实际TikHub适配器和网关、完整式及固定请求身份、业务码拒绝、已有回执只读、JSONB字段顺序、并发最多一次派发、双向v1/v2未知结果阻断，以及派发后证据读取或保护状态保存失败。

操作人员已回传 v1：`readiness.ready=true`，数据库凭据 revision=1，原调用方原生权限已开放，operation/release revision=3；但 `adapterCalls=0`、`fullQueryAttempted=false`、`409 search_admission_blocked`、`requestId=null`。这证明调用在 Hub 搜索准入阶段停止，不能归因为 TikHub 语法错误，也不能认定它已经采购。v1 未输出阻塞请求 ID，尚不能从这份报告确定具体是哪条历史记录阻塞。

### 已发布准入修复：只按已知查询归属阻断，不扩大为平台禁用

代码复核确认旧准入扫描有过宽条件：旧 usage 缺失路径或有效 query 时，会匹配当前调用方该平台的所有新 v2 查询。现改为明确保存标准 v1 路径、有效 query 且与本次 query 完全匹配才阻断。历史 unknown 不改写，原 key 继续保护；同一查询的协议 unknown/过期未完成租约仍保护 v1/v2。孤立 usage 和悬空幂等 binding 的 key 也不能复用。具体合同见 [搜索 v2](../integrations/data-search-v2.md)。这修复了已确认的扩大阻断规则，但尚未证明本次线上 blocker 一定属于这类旧记录。

诊断更新为 `twitter-tikhub-check.v2`，报告 `admissionPolicyRevision`、`stage` 和独立的 `blockingRequestId`；可读取原调用方自己的阻塞记录，显示路径类别、状态以及 query 是否匹配，不输出查询正文。采购前阻塞的 `requestId` 仍为空，不把旧 blocker 冒充本次采购。诊断 key 及两个协议 key 与 v1 **完全不变**，升级脚本不会创建新的采购身份。

本次涉及在线准入实现，需要同步完整 Hub 源码并重建部署 Admin/Public 镜像。只同步 stdin 诊断文件不会改变容器中的规则。从服务器 Hub 源码目录按既有流程执行：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh ops internal-production deploy
kubectl -n mx-insight-hub rollout status deployment/mx-insight-hub-public
kubectl -n mx-insight-hub rollout status deployment/mx-insight-hub-admin
```

此次没有数据库迁移，不要求操作或重新部署 Delta。Launcher 同步与付费数据 smoke 显式关闭；没有修改 MX-H2I 登录、SSO、联网或 nginx 路由。

如需继续已经授权的同一完整查询对照，部署后运行同一个 `bash server/ops/verify-twitter-tikhub.sh`。预期 `diagnosticRevision=twitter-tikhub-check.v2`、`admissionPolicyRevision=known-query.v1`、`maxAdapterCalls=1`；没有旧采购时最多新增一次供应商调用，可能消耗额度，已有回执不重发。如果仍阻塞，报告给出具体阶段与阻塞身份，不清除 unknown 或自动换 key。

按用户最新边界，Hub 不再继续拆词、换词序或代理来猜测检索式语法。若实际到达供应商后仍返回输入相关拒绝，保留原查询、上游状态及 requestId，将检索式兼容定位交给下游。供应商笼统的400本身不足以证明具体语法根因。当前没有切换生产供应商路由，也没有宣称原冷启动已采集成功。

本轮准入回归35项通过（含真实 PGlite 与 HTTP，无跳过），TikHub诊断及入口25项通过；覆盖新请求不受无归属历史牵连、旧 key 不复用、已知同查询 unknown/reserved、跨版本保护、状态不变、诊断身份稳定、blocker 归属限制及原生查询字段识别。

### 已确认结果：完整候选式被 TikHub 接受，保存响应待标准映射

用户回传 `twitter-tikhub-check.v2`：策略版本 `known-query.v1` 已生效，`adapterCalls=1`、`fullQueryAttempted=true`，请求 `dcc086fa-469a-4237-a435-e427b7e70f3a` 已保存为 committed/200。唯一调用 `6c6177d6-4065-499c-aabb-50217f355780` 为 HTTP200、businessCode=200、succeeded，且原生回执归属校验通过。这确认完整257字符 native 候选式在 TikHub 被接受；原280字符 SQL 式没有直接发送。此前 RapidAPI 的400不能再被笼统归为“这个完整业务条件无法搜索”。没有证据证明具体 RapidAPI 内部拒绝机制。

本次 `timeline` 是长度19的数组，`next_cursor` 是字符串。19是容器元素数，尚未验证每项都能映射为有效帖子。现有 Hub Twitter 解析器处理 GraphQL `entries/instructions`，不接受这个数组结构；Night-All只提供通用字段猜测，并会在缺ID时生成哈希，不能据此生成标准帖子。`protocolGuardState=failed` 是私有诊断以 `diagnostic_not_standard_delivery` 结束保护的内部状态，表示未形成标准交付；它不表示供应商失败，也不改变已经保存的原生200。原 `b590...` 的502仍保持不变。

不再重复付费查询。v3新增固定已保存响应的只读检查：仅接受上述成功请求及其唯一调用，检查现有 timeline 的字段类型、原生身份和时间字段状态；不输出正文、URL、ID或游标值。读取缺失或不匹配时直接结束，不创建供应商运行时、不发HTTP、不修改协议状态。诊断采购key和两个协议key继续保持v1身份。

同步 `server/ops/verify-twitter-tikhub.mjs`（v3）及同目录 `inspect-twitter-tikhub-saved.sh`，无需重新部署，从有kubectl权限的宿主机执行：

```bash
bash server/ops/inspect-twitter-tikhub-saved.sh
```

预期 `diagnosticRevision=twitter-tikhub-check.v3`、`mode=read_saved_only`、`adapterCalls=0`，并返回已保存数据的结构摘要。此次只读数据来自已保存的原生交付，不冒充原始上游字节归档的重新哈希校验；既有回执仍通过原调用归属及合同检查。

v3相关35项离线测试通过，覆盖19项全页结构、明确的分组/节点/深度截断、内容及未知字段脱敏、固定成功回执、缺失或错误回执时零运行时/零HTTP/零状态写入，以及两个Bash入口的参数、版本和stdin内容。独立复审、JS/Bash语法及diff检查通过。本轮仅修改诊断、测试和本文，没有切换标准搜索生产路由。

完成字段确认后，标准接入复用现有 TikHub content-search 的整页存档、溢出缓冲、去重和分页，不要求下游新增social/native授权；客户沿用twitter平台权限及计量，采购使用现有TikHub操作。仅新的标准搜索选择新供应商，旧Rapid游标仍由原供应商处理，原raw/social接口与已保存重放不变。复用现有等价Boolean转换并保留原查询指纹，不继续新增语法改写。v2原时间窗和交付过滤保持不变；供应商成功返回第一页不代表完整历史窗口覆盖。

v5 联合验证51项通过、1项既有可选PGlite检查因未配置模块跳过，独立复审通过。覆盖旧主题归档21条、原502和归档不变、事件组最多一次、事件组同样超额时离线判断、缺失/损坏/非JSON/不可用归档停止、未知结果/身份不匹配不读归档、不清除现有隔离期、跨版本保护，以及三个入口的实际JavaScript stdin与v5版本检查。没有线上采购或部署，生产查询逻辑保持不变。

v4此前35项离线测试全部通过，包括两个精确出站URL、全部成功/400组合、历史9b15/4fa2证据与原key校验、unknown/缺证据停止、重复读取零派发、跨版本running/unknown保护，以及三个固定入口实际发送JavaScript stdin。

本地查询、路径和组页合同测试 17 项通过，其中包含 160 组布尔真值比较、实际 adapter 两页 mock HTTP、v2 内外游标往返。另有带 PGlite 的 v1/v2、跨版本 unknown、HTTP 重试边界 33 项通过。Python 验证脚本 24 项测试及 Delta 原生 v1/v2 请求构造联合检查通过。这些离线测试不能代替供应商接受完整查询和原冷启动入库验收。

准入修复及一次原生供应商成功已由用户回执确认；上述 v3 阶段尚未形成标准响应映射或原冷启动交付，没有新增数据库迁移或修改 MX-H2I 登录、SSO、联网及 Domestic/Internal nginx。

### v4：用已保存成功页验证实际标准映射

操作人员的 v3 回执检查完整19项、没有结构截断：原生 `tweet_id`、正文、可解析的 `created_at`、`user_info` 身份和作者字段、互动指标及照片/视频附件已有结构证据。接入的新映射保留整页、原生字符串ID、完整正文、真实零值和未知指标，照片与视频封面分开；供应商返回超过请求条数时交给既有整页缓冲，不重新采购。空页仍有 `next_cursor` 时继续保留分页可能性。

更新后的 `inspect-twitter-tikhub-saved.sh`（同目录 `verify-twitter-tikhub.mjs` 为 `twitter-tikhub-check.v4`）仍只读取固定 `dcc086fa-469a-4237-a435-e427b7e70f3a` 和唯一调用 `6c6177d6-4065-499c-aabb-50217f355780`。这次使用**容器已安装的** `projectContentPage`，验证真实 Twitter 标准分支、现代输出、canonical 记录和 PostgreSQL 安全，不再生成字段类型大段摘要。结果仅给映射条数、游标是否存在、指标已知/零值/未知计数及媒体覆盖计数，不输出帖子正文、ID、媒体URL或游标值。

本轮映射属于运行代码，先正常发布新的 Hub Admin/Public 镜像；只同步 stdin 脚本不会安装映射。旧镜像缺模块或 Twitter recipe 时报告 `projection.state=needs_deploy`，不启动任何补采。发布后运行同一个只读入口：

```bash
bash server/ops/inspect-twitter-tikhub-saved.sh
```

预期 `diagnosticRevision=twitter-tikhub-check.v4`、`mode=read_saved_only`、`adapterCalls=0`、`maxAdapterCalls=0`；成功时 `projection.state=mapped_saved_native_page`，提供 `acquiredCount/standardItemCount/canonicalRecordCount` 与 `postgresProjectionSafe=true`。映射失败仅报告已知原因，不改变原生200或原始502、不清除unknown、不重新采购，也不操作Delta。固定采购key及两个协议key仍沿用v1身份。此次离线映射不等同于正式标准交付、完整日期窗口覆盖、已签发可继续使用的游标或冷启动入库完成。
