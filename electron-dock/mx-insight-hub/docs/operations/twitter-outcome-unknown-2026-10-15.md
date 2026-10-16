# Twitter 搜索结果未知（2026-10-15）

## 本次证据边界

下游报告第一页失败、完成页数 0、累计入库 0，查询为
`("US semiconductor export" OR "semiconductor export controls" OR SMIC) AND #chipban`，
检索时间窗口为 `2026-10-14T09:31:27.132106+00:00` 至
`2026-10-15T09:31:27.132106+00:00`。
该窗口是检索条件，不代表故障发生时间。

外层显示“请求 ID：-”，但 Hub 错误正文包含可查询的原请求 ID：
`ced3bb03-709d-438b-8d80-4deada7f8476`。
原错误为 HTTP 502 / `social_upstream_outcome_unknown`，
`upstreamStatus=null`、`outcome=unknown`、`retryable=false`。

精确文案 `External social data request failed; verify its saved outcome before retrying`
来自 `server/external-platforms/twitter-search-fill.mjs` 的标准搜索错误映射。
下游 `operation=raw` 标签不能代替账本的 `acquisition_request.path`。
当前实现中，收到 HTTP 响应后的格式解析失败会保留 HTTP 状态；此次 null 状态
指向适配器尚未取得响应对象的失败，可能发生在代理配置读取、连接或等待响应头期间。
这不是供应商返回 HTTP 502 的证据，也不能据此判定检索语法错误、额度耗尽或并发拒绝。

运营者已返回 `twitter-outcome-diagnostic.v1`，数据库读取时间为
`2026-10-15T09:47:18.691Z`（北京时间 17:47:18.691）。原账本确认：

| 项目 | 结果 |
| --- | --- |
| 原请求 | `unknown`，`/api/v1/data/search`，内部错误 `social_upstream_response_unusable` |
| 请求预占／结束 | `09:33:15.068Z`／`09:33:25.633Z`（北京时间 17:33） |
| 唯一 own call | `a71c8fe2-fc05-400a-afce-3e5abcc1aed5`，RapidAPI `twitter-aio.search` |
| 调用耗时／结果 | 10494 ms，`unknown` |
| HTTP／业务码／供应商扣费 | 均为 null，不能解释为未扣费 |
| operational／restricted archive | 均不存在，无正文、哈希或上游 request ID 可供复核 |
| 网关记录 | `unavailable` / 502；这是 Hub 对外状态，不是供应商 HTTP 502 |
| 截断 | own calls / gateways 均未截断；没有内部成功页记录 |

当前所查 Public 容器四份源码哈希均与本轮开始前本地版本一致；Admin 也给出相同
adapter/fill 哈希。因此当前 Public 的解析、补页、存储源码并不落后于本轮开始前本地。
尚未发布的是本轮新增的故障原因留存。该版本快照不能单独证明过去每个 Pod 的运行版本，
但现有证据不支持用“旧解析／排队修复未发布”解释本次失败。

`social_upstream_response_unusable` 在该旧适配器只是泛化错误码，不证明收到正文或解析失败。
未取得 HTTP 响应对象就已失败，因此不是已记录的成功响应解析错误、补页缓冲落库故障，
也不属于 `social_egress_unavailable` 的已知代理探测拒绝分支。

已检查的本地依赖 `undici@7.29.0` 在 `lib/core/connect.js` 默认连接超时为 10000 ms，
`proxy.mjs` 的直连 fetch 与默认 ProxyAgent 都未显式覆盖这一连接期限。
10494 ms 与该连接超时相符，是优先怀疑；适配器 30000 ms 总期限触发会写
`social_upstream_timeout_or_size_limit`，不同于本次已保存错误码。
但原异常 cause 已丢弃，且这四份哈希未单独验证生产依赖／dispatcher／当时出口，
不能将其确诊为 `UND_ERR_CONNECT_TIMEOUT` 或断言是 DNS、TCP、TLS 的哪一段。
因此不据此增加超时或切换代理。后续用户明确要求实现人工重试，见文末；开发验证未重发这笔生产请求。

历史证据已到边界：代理失败表仅记录探测拒绝，成功探测后的业务传输异常不会保存，
也没有 request/call 外键；配置审计不能重建本次实际出口。此异常被转换为 AppError，
旧通用错误日志不保留其底层 cause。继续泛查日志、当前 DNS/TLS 探测或重跑相同查询
不能恢复这次历史原因。下一步是在正常 Hub 发布中纳入诊断补丁，观察后续正常业务的
新失败证据；原 unknown、供应商扣费未知和已有重试保护保持不变。

## 已修复的原因留存缺陷

RapidAPI 适配器原先在响应头前失败时不创建 operational archive，并丢弃底层异常。
`social_upstream_response_unusable` 是这个分支的泛化内部错误码，不能理解为
已经收到正文但无法解析；`social_upstream_timeout_or_size_limit` 也没有区分底层连接超时。

补丁在内部 `responseArchive.rawPayload.response.transportFailure` 保存有界、固定白名单的
错误代码，以及 request/body 阶段、耗时、总超时设置和总期限是否触发。
没有 HTTP 响应时只保存诊断元数据；HTTP 状态、正文大小、正文哈希仍为 null，
不创建伪造的 restricted response 或内容 archive object。
不保存异常消息、堆栈、URL、检索式、凭据或任意 cause 内容。

此修复提高新失败的可诊断性，不能补回历史已丢失的底层错误，也不等于修复了本次连接故障。
保留原公开状态/错误码、计费 unknown、客户预留、去重保护和不自动重试语义。
不调整 30 秒总超时、代理/DNS、查询表达式、分页、权限或价格。
不修改 Launcher、MX-H2I 登录及联网链路；无需数据库迁移。

## 生产只读查询

用户补充：正式服可能尚未部署当前代码。应先核对实际 Public 容器源码；
Admin 诊断脚本的 runtime 哈希仅代表执行诊断的容器，不能代替 Public 版本。
本地已有的 Twitter 解析、补页和排队修复并不直接证明这次 null-HTTP unknown 已解决。

```bash
kubectl -n mx-insight-hub exec deployment/mx-insight-hub-public -c api -- node -e '
const fs = require("node:fs"), crypto = require("node:crypto");
for (const file of ["server/adapters/rapidapi.mjs", "server/external-platforms/twitter-search-fill.mjs", "server/contracts/hub-social.mjs", "server/external-platforms/store.mjs"]) {
  try { console.log(JSON.stringify({file, sha256: crypto.createHash("sha256").update(fs.readFileSync("/app/" + file)).digest("hex")})); }
  catch { console.log(JSON.stringify({file, state: "unavailable"})); }
}'
```

当前发布清单为 Public 单副本 Recreate；若实际环境另有多个服务 Pod/流量池，
需对各实际服务 Pod 分别核对，不能用一个 Pod 的哈希代替全部。
本次本地校验参考：

| 文件 | 本轮修改后的 SHA-256 |
| --- | --- |
| `server/adapters/rapidapi.mjs` | `bd195ef86de855b0359d7145474fd6b0bc1fc11f1479944cd71d7b15b78b5d14` |
| `server/external-platforms/twitter-search-fill.mjs` | `eb4d91b71053f39b885828450906efef6d27f4a051734ca6a2d5dc6dc6648e4d` |
| `server/contracts/hub-social.mjs` | `4b88265e0f0587aff4582ea367ffc9cc3f820f4c7f0a7286f0e5048f6cfd6f13` |
| `server/external-platforms/store.mjs` | `e516e398551652f0c90cc58ab9a7ebd1967673ef180e1394949d136fbac58dad` |

本轮开始前的 `rapidapi.mjs` SHA 为
`ba39396b5aaf5ff916677b38a4424ef87af99201ac4b303496c35961e1f43c2d`；
其他三份文件在原因留存阶段未修改；文末人工重试阶段另有 fill/store 改动，以上哈希是第一阶段证据，不是最终发布版本。版本不同仅证明源码差异，仍须结合原请求账本判断故障。

将新增的 `server/ops/diagnose-twitter-outcome.mjs` 同步到有 kubectl 的服务器源码目录。
无需先发布应用镜像。在仓库根目录执行：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - ced3bb03-709d-438b-8d80-4deada7f8476 \
  < electron-dock/mx-insight-hub/server/ops/diagnose-twitter-outcome.mjs
```

若当前目录是 `electron-dock/mx-insight-hub`，重定向路径使用
`server/ops/diagnose-twitter-outcome.mjs`。
脚本通过 stdin 在现有 Admin 容器内执行，复用其 `pg` 和 `DATABASE_URL`，
不写容器文件、不调用 Public API，不触发采集、reaper、重试或部署。
查询使用只读一致性事务、语句/锁超时、UUID 关联和有界结果；只返回原请求及其 own calls、
gateway、归档元数据和固定诊断字段，不读取查询正文或供应商响应正文。

以上命令已完成取证，本事故不需要重复执行。诊断报告解读要点：

- 原请求 `unknown` 与已保存失败 `committed`，以及每个子调用的 outcome/HTTP/耗时。
- 已保存的超时错误码与新版本才可能有的 `transportFailure`；历史字段缺失不能当作没有异常。
- 是否存在内部成功页或受限原响应，避免把下游“0 入库”当作无采集、无扣费证据。

默认不能根据未知结果自动使用新幂等键重发、清理 unknown 或修改历史账单。
文末增加的人工重试需单独确认潜在重复费用，保留原 unknown 和账单。
底层原因未被旧版本保存这一限制仍然存在。

发布仅更新 Hub，在服务器同步完整待发布 Hub 源码并完成常规发布审查后，从
`electron-dock/mx-insight-hub` 目录使用现有入口：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh ops internal-production deploy
```

此步骤发布诊断能力，不是连接故障恢复验收，也不会把旧 unknown 改为成功。
没有必要为验收诊断而重新购买本次查询。

## 本地验证

9 个相关测试文件共 226 项：223 通过，0 失败，3 项既有真实 PostgreSQL 多会话环境测试跳过。
启用隔离 PGlite，实际验证归档表约束、计费触发器、unknown 保留预留且无扣款、
只读诊断 SQL、元数据大小边界、敏感信息过滤、HTTP 错误兼容和分页/代理/回放回归。
类型检查和差异格式检查通过。没有调用生产供应商或部署应用。

## 后续：用户明确授权的 Twitter 人工重试

截图中没有按钮是旧逻辑的限制：请求验证只接受有已提交响应的历史请求，且原比较器没有 Twitter 合同。现在为 Twitter `unknown` 增加独立流程，入口仍为“数据浏览中心 → 请求诊断”。

1. 查询原 requestId，点击“准备按原参数重试 Twitter”。这一步仅使用 Admin Token 的只读 GET，显示保存的接口、参数、原 Key 和资格。
2. 点击“确认按当前链路重试（可能再次计费）”，页面再次核对证据，使用原 Key、原参数、新幂等键发送一次标准搜索，携带 `X-MX-Insight-Retry-Of`。
3. 页面保留新请求 ID、幂等键、HTTP 结果及后续账本。网络中断只显示待核对，不自动重发。通过“只读核对重试结果”或新请求诊断链接继续查看。

公开合同仅扩展 `POST /api/v1/data/search` 的 Twitter 分支。必须为同一 tenant/consumer/API Key、完整且可验证的原参数、相同标准搜索指纹和当前 Twitter 调用合同。可继续使用原来的有效分页游标；失效游标、旧合同、缺失参数不允许从这条记录重试。raw、账号采集及其他平台没有新增重试行为。

新增 `152_twitter_manual_retry.sql`。数据库以原请求为主键、后续请求为唯一键记录关联，第一次 provider call 或仅缓冲交付的提交与关联写入同一事务。调度前拒绝不占用关联；已派发或已提交的重试只能有一个后续。后续再次 unknown 时，可以进入该后续请求诊断再人工确认，最多验证 32 层祖先关系，禁止分叉或跳过当前未决后续。

只为已验证的本条祖先链排除 unknown 去重；处理中、其他未知请求、响应不可用隔离、当前授权、客户余额/报价、成本、并发和熔断保护继续生效。旧请求及其费用预留不被重置或合并；新请求独立结算，可能再次产生费用。已关联后续的幂等回放永久保持，即使 `type=fresh` 超过两分钟，携带或省略 Retry-Of 重放同一幂等键都不会重新采集。

准备接口为 `GET /internal/v1/admin/acquisitions/{requestId}/twitter-retry`，使用有超时的 READ ONLY 事务，不调用 Public 状态查询中的过期预留清理器。原始 API Key 仍由现有受保护的短期凭据接口获取，不存进浏览器重试状态。

发布仍由运营者执行上文的 Hub-only 命令；此阶段必须纳入 **迁移 152、Public 后端和 Admin 前端**，按现有发布流程先完成迁移，再统一实际服务实例版本。仅更新网页不会打通旧后端重试保护。迁移未就绪时准备接口返回明确 503。没有新增 Launcher、MX-H2I、Pay 部署步骤。

这是人工恢复入口，不是已确认的 10 秒连接超时修复，也不能保证重试成功。本次没有执行生产重试或修改原事故账本。

人工重试阶段验证：相关回归共 362 项全部通过、无跳过，包括实际 PGlite SQL/唯一约束/事务回滚/原账单保持、多页与仅缓冲交付、带或不带请求头的过期 fresh 回放、鉴权 HTTP 和文档一致性。PGlite 是单会话 PostgreSQL 引擎，没有将其结果宣称为真实 PostgreSQL 多进程锁调度验收。类型检查及前端构建通过。Browser 插件不可用，使用本机 Playwright/Chrome 检查实际 Admin SPA 的 1440px/390px 界面：成功、网络中断、缺失证据、切换页面、刷新后查询后续记录；全部业务 API 被离线拦截，采集只在明确确认时发生一次模拟 POST，页面无异常、无横向溢出。

## 重试返回上游 400：与成功展示请求对比

用户后续截图确认：重试 `03d6c41f-88c4-42dd-a7f7-eb502d0b148b` 已提交 HTTP 502，错误为 `social_upstream_rejected`，`upstreamStatus=400`、`outcome=rejected`、`retryable=false`。这次收到明确的上游拒绝，与原 `ced3bb03-709d-438b-8d80-4deada7f8476` 没有 HTTP 状态的 transport unknown 不同，不能继续将两者都解释成 10 秒连接超时。HTTP 400 分支发生在响应内容解析之前，不是成功结果投影或补页解析失败的证据。

用户指定成功展示请求 `8cef2ac9-69ea-426b-9c36-1864d87def47`，截图查询 `timo`，页大小 20。当前展示页与手动重试都使用 `/api/v1/data/search` 和同一 Twitter adapter；重试头只控制旧 unknown 的人工例外及幂等关系，不会选择旧版采集器。展示页提交 `type=stable`，原请求的实际 `type` 等参数仍需读取保存记录。离线使用真实 normalizer/adapter 配合模拟 fetch 确认：同一查询的 fresh/stable 上游参数相同，首请求为 `GET /search/{encoded query}?count=min(pageSize,50)&category=Top&includeTimestamp=false`；查询 `#chipban` 编码为 `%23chipban`，没有变成 URL fragment。此验证假设页大小 20、无游标，不代表读取了生产原参数。

新增 `server/ops/compare-twitter-requests.mjs`，对以上三个明确 UUID 执行有界 READ ONLY 查询，不扫描其他成功候选。报告显示原始 query、页大小/type/sort、路径、Key 身份是否相同、游标长度/哈希、当次调用合同/配置版本及结果。仅读取当次当前 Twitter 合同的 rejected HTTP 400 原归档，校验字节长度及 SHA 后投影有限错误字段；不输出完整响应、凭据、任意嵌套参数或游标值。错误文字是供应方陈述，不是独立确认的根因；涉及凭据的文字、未审核代码和超长字段不展开。

在服务器同步这个脚本后，从 `electron-dock/mx-insight-hub` 执行，不需要重新部署或付费重跑：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - \
  ced3bb03-709d-438b-8d80-4deada7f8476 \
  03d6c41f-88c4-42dd-a7f7-eb502d0b148b \
  8cef2ac9-69ea-426b-9c36-1864d87def47 \
  < server/ops/compare-twitter-requests.mjs
```

`savedInput` 是数据库保存的 Hub 参数；`currentFirstCall` 是按诊断容器已安装合同重建的首个上游请求，必须与历史实际发出的 URL 区分。历史账本未保存完整 outgoing URL，Admin 源码哈希也不能替代所有 Public 服务实例版本。只有生产输出确认两次参数与 400 原因后，才决定是否需要参数兼容性修复；不根据 `timo` 成功就认定复杂查询或时间条件也被供应商接受。

本阶段新增对比测试 7 项，与既有只读诊断测试合跑 13/13 通过、无跳过，包含实际 PGlite SQL、精确 UUID/归档范围、只读事务、长度/SHA 校验、敏感字段过滤和错误清理。生产三笔报告尚待运营者执行返回；没有修改运行时搜索逻辑、部署应用或发起付费查询。

## 三笔生产回执：路径拒绝与编码兼容修复

运营者已返回 `twitter-request-comparison.v1`。原请求与重试的保存参数及指纹完全相同；三笔请求同 tenant/consumer/Key，均为 `twitter-aio.search`、`twitter-aio.hub.v1`、`mx-insight-hub.social-data.v1`，凭据 revision=1、策略 revision=2。成功查询不是旧请求的同参验证。

| 项目 | 失败重试 `03d6c41f…` | 成功 `8cef2ac9…` |
| --- | --- | --- |
| Hub 入口 | `/api/v1/data/search` | 相同 |
| query | `("US semiconductor export" OR "semiconductor export controls" OR SMIC) AND #chipban` | `timo` |
| pageSize | 20 | 20 |
| type | 未传，默认 fresh | stable |
| cursor / params / 其他字段 | 均无 | 均无 |
| 当前合同上游参数重建 | count=20、category=Top、includeTimestamp=false | 相同 |
| 实际上游 HTTP / 耗时 | 400 / 1935 ms | 200 / 4629 ms |
| 结果 | 上游拒绝，Hub 保存 502 | 上游 22 条，Hub 交付 20 条、有后续 |

失败 call `e890c334-d906-4f78-b84a-8405f0ee1ec2` 的原归档 32 字节、SHA `38db74815e48e244760fb674b1f1a3d1f796f23a83c2e5826e243c18c46797f2` 已校验，错误字段原文为 `invalid request path`，未脱敏。其上游 requestId 为 `cbb7bbac5692797086f12b34ee2cbebb7066802471c1ba4b2ab5a984e3e65f83`，调用时间 2026-10-15 18:32:36.439–18:32:38.394（Asia/Shanghai）。这不是原 10494 ms/noHTTP 的再次发生，也不是成功响应解析或补页故障。

代码核对找到路径编码差异：旧 Night-All 的 `crawlers/twitter/rapid/GetCommentByKeywords.py` 使用 `quote(search_term, safe="")`；Hub 的 `encodeURIComponent` 会保留 `!'()*`，事故表达式中括号直接进入路径。现在仅在 Twitter 搜索路径段补齐这五个字符的百分号转义，使实际 adapter 生成 `/search/%28%22US…SMIC%29%20AND%20%23chipban`。解码后查询逐字不变，不拆分/改写 AND、OR、引号或标签；仅编码原始查询一次，保留字面百分号含义，不改变 Top、页大小和供应商选择。

这是与历史编码行为一致的最小兼容修复，生产错误支持优先处理这个差异；**尚无修正路径的供应商成功回执，不能断言括号是唯一根因或线上已恢复**。RFC 允许这些字符作为路径中的 sub-delims，并不是所有含括号 URL 都非法；对 opaque 查询路径段作严格转义可避免路由解释差异。参考 [MDN 的编码说明](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/encodeURIComponent#encoding_for_rfc3986)、[Python quote 文档](https://docs.python.org/3/library/urllib.parse.html#urllib.parse.quote)；[Twitter AIO Search 文档](https://rapidapi.com/viperscores-viperscores-default/api/twitter-aio/playground/apiendpoint_602d9730-5aec-48f1-ae31-7020727eb762)确认搜索词为路径参数，但没有确认本次错误的具体路由判定。

保存记录也确认原请求未携带时间字段，query 内没有 since/until；下游报错中的时间窗口不是这笔 Hub 请求的上游时间过滤证据。本次不凭窗口描述自动追加时间条件。

修复只作用于供应商路径段，身份和指纹仍由原始查询构造：公开合同版本、原 query、指纹、游标 scope、档案和结算均保持。旧游标继续按既有规则验证；`03d6c41f…` 的已提交 502 和 `ced3bb03…` 的 unknown 不会被改写，同一幂等身份仍回放历史结果。新请求仍受既有 unknown/授权/计费保护，修复不会自动重发。只需运营者同步完整 Hub 源码并执行上文 Hub-only 发布命令，无新增迁移，不涉及 MX-H2I 登录或联网。本轮未向供应商发送查询。

验证：相关 10 个测试文件共 197 项通过，无跳过；其中 5 项 HTTP 测试首次受沙箱本机端口限制，允许 127.0.0.1 监听后定向重跑全部通过。新增测试使用实际 normalizer/adapter 配合模拟 fetch，并以固定旧格式的加密游标与指纹验证兼容性，不以模拟成功证明供应商恢复。其余覆盖原失败回放零采集、人工重试保护、分页缓冲与实际 PGlite 归档/计费事务。类型检查、差异格式检查通过。修复后 `server/contracts/hub-social.mjs` SHA-256 为 `27c88c5b6d203f1bfd1dd7b860401951d6efbc3e1b806634cfbb41cbeecb9e3b`。
