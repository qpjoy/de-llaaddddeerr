# Twitter 搜索 554b85cb 上游 400 核查

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
