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
