# 微博搜索 409：读取旧响应定位解析失败

## 2026-10-08 冷启动告警

策略 `a31b7976-c0e6-4b1f-85cd-812d0b3b582d`，关键词“CN光头”，
Hub 请求 `06f6157d-abc9-4341-ade8-fd08d9d7b142`。

已通过生产后台“请求诊断”只读核实：

- 请求时间 `2026-10-08T07:57:55.172Z`，完成时间 `07:57:55.199Z`。
- 请求已释放，错误码 `external_platform_response_unusable`，没有当次上游调用或客户扣款记录。
- 告警中的 `upstreamDispatched=false` 与上述证据一致。这是保护性拒绝，不是本次供应商请求失败。
- 告警给出的保护截止时间为 `2026-10-08T07:59:13.288Z`（北京时间 15:59:13.288）。

`ExternalPlatformGateway` 在 dispatch lease 检查时返回这个 409。
先前 `succeeded_unusable` 会在相同 provider、operation、endpoint、contract version
范围内阻止新调用，**不限定同一检索词或调用者**。所以告警中的“同平台其他检索式继续运行”
只描述下游调度隔离，不能保证这些检索式在 Hub 中都可以成功。
默认冷却为 15 分钟，可由 `MX_INSIGHT_TIKHUB_UNKNOWN_FINGERPRINT_COOLDOWN_MS` 覆盖。
服务器只读报告已确认生产冷却配置为 `900000ms`，找到一条截止时间完全匹配的候选：

- 原 Hub 请求 `21ab2d17-4fbb-4bcf-9834-8675711a688d`，调用 ID `b20680d8-9004-48bd-acd6-67fbc73eaa56`。
- TikHub 请求 `fdfc0c5c-a7f3-4d91-b0d1-e33d43911588`，完成时间 `07:44:13.288Z`。
- HTTP / 业务码均为 200，`billed=true`，Hub 保存 `invalid_weibo_search_contract`。
- 校验归档摘要后重跑已部署解析器：请求页大小 20，结果数组有 10 条，逐行 ID 校验没有错误；
  `pagination` 是对象，但 `has_next_page` 缺失，触发 `invalid_weibo_search_shape`。
- 被抑制的下游请求实际路径为 `/api/v1/data/search`，不能仅凭下游日志中的 `operation=raw` 判断 HTTP 路由。

已定位这份成功响应被拒绝的直接原因是 Hub 强制要求布尔分页字段。
10 条少于请求页大小不证明已经到最后一页。

### 实际响应验证与修复

用户随后授权一次付费验证。在 `2026-10-08T09:01:04.072Z` 对同一检索词 `CN光头`
直接调用 TikHub `GET /api/v1/weibo/web_v2/fetch_realtime_search?query=CN光头&page=1`，
仅调用一次，没有重试、详情补取或下一页请求。此次费用在 TikHub 账户，不经过 Hub 客户账本。

- HTTP / 业务码均为 200；供应商请求 ID `3940de2c-c9c5-44c2-a803-9300c91eed11`。
- `data.parsed_data` 含 8 条有效帖子，`result_count=8`、`parse_success=true`、`pagination={}`、`search_stats={}`。
- 原始响应 8121 字节，SHA-256 `fce6d94fad46198800e5ddc2d76426eb8a009680833d6f24c145853f2a0fee1e`。
- 修复前离线重放稳定得到 `invalid_weibo_search_shape`；修复后完整保留 8 条结果并生成续页游标，原始字节摘要不变。

这是新的同检索词样本，不是 `07:44:13.288Z` 那份旧响应；旧归档报告只确认缺少分页布尔字段，
尚未读取旧响应的完整分页对象。新样本证明空分页对象是实际成功响应的一种形状。

共享微博投影现在接受明确的 `pagination.has_next_page` 布尔值，或已验证的空对象 `{}`。
空对象时沿用历史 Night-All 的按页续取规则：非空结果提供下一页游标，空结果停止，最多 15 页。
供应商只接收 query/page，不接收 Hub 的 pageSize，因此不足 pageSize 不作为结束条件。
生成游标本身不调用上游；下一页仍需调用者提交游标，按现有权限、限流、预算与幂等规则执行。
该修复同时用于 `/api/v1/data/search`、`/api/v1/search/raw` 和旧 raw 别名。

缺失/null/数组分页、非布尔标志、未知非空分页对象、明确 `parse_success=false`、
无效帖子 ID 和超出请求条数仍然失败，保留原保护与归档逻辑。
事故版本 gateway 将这些解析错误统一记录为 `invalid_weibo_search_contract`，
必须读取原始归档才能确定失败分支。本次诊断补丁保留三个代码内定义的具体原因，
不透传任意异常消息，仍按原方式归档、结算并保护后续调用。不能仅凭 409 断言是正文“展开”或某个关键词导致。

本次为 Hub 代码修复，无新增数据库 migration。部署新镜像后再运行下方只读诊断，
`current_projection_accepts` 可验证旧归档是否匹配已支持形状；报告还返回 `emptyPagination` 和 `hasMore`。
不会修改旧失败请求或清空隔离账本。若部署前又触发了同类失败，等报告中的冷却时间到期；
下游持久阻塞的策略需在恢复采集时单独解除。

## 只读诊断

使用服务器已有 Hub 数据库连接运行；不需要供应商 Key，不发出供应商请求，不修改数据库。
脚本在 `REPEATABLE READ / READ ONLY` 事务内读取请求与最多 10 条候选调用，
校验受限响应字节的 SHA-256，然后离线调用当前 `projectWeiboSearch`。
报告只包含请求/调用 ID、时间、受控状态、字段类型、条数和固定错误码。
不输出原始响应、帖子正文、检索词、凭据或任意异常消息。

在已有 `DATABASE_URL` 的 Hub 运行环境，更新此文件后执行：

```bash
node server/ops/diagnose-weibo-search.mjs \
  06f6157d-abc9-4341-ade8-fd08d9d7b142 \
  --blocked-until 2026-10-08T07:59:13.288Z
```

服务器源码已有脚本、运行镜像尚未包含它时，在服务器 `mx-insight-hub` 源码目录执行：

```bash
sed \
  -e "s|from 'pg'|from '/app/node_modules/pg/lib/index.js'|" \
  -e "s|from '../contracts/|from '/app/server/contracts/|g" \
  -e "s|import.meta.url === pathToFileURL(process.argv\[1\]).href|process.argv[1] === '-'|" \
  server/ops/diagnose-weibo-search.mjs | \
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin \
  -c admin -- node --input-type=module - \
  06f6157d-abc9-4341-ade8-fd08d9d7b142 \
  --blocked-until 2026-10-08T07:59:13.288Z
```

这里只在管道中调整导入路径及 stdin 入口判断，服务器源码不变。
Node 在 Pod 内执行，复用 `/app` 的依赖、已部署解析器和 Pod 的 `DATABASE_URL`；
无需在宿主机安装 `pg`，无需重建镜像或写入 Pod 文件系统。
Admin 容器设置了 `readOnlyRootFilesystem: true`，不要通过复制脚本到 `/app` 或 `/tmp` 解决。
本地已验证相同 stdin 启动方式能够完成模块加载并进入 CLI 配置检查；实际归档查询仍须在服务器执行。

脚本随已有 Dockerfile 的 `server` 目录复制进入镜像，没有新增自动任务或 migration。
此命令也可用于一条原始微博失败请求。旧记录没有保存 blocker ID，
`endpoint_quarantine_candidate` 始终表示候选；`matchesReportedDeadline=true`
表示按当前运行环境的冷却配置计算，候选的截止时间与告警一致。
修改过冷却配置、历史缺失或候选截断时，不能据此认定唯一因果关系。

`projection.reason` 区分：

| 错误码 | 当前解析器拒绝原因 |
| --- | --- |
| `invalid_weibo_search_shape` | 结果数组、分页形状或解析成功标志不符合要求；空分页对象现在受支持 |
| `invalid_weibo_identity` | 帖子 ID 不符合要求；`invalidRowIndexes` 是最多 20 个从 0 开始的位置 |
| `weibo_page_exceeds_requested_count` | 供应商返回条数超过请求页大小 |
| `unexpected_projection_error` | 其他解析异常；不输出任意异常消息 |

缺少归档、摘要不符、非 JSON、非成功 envelope 和缺少原始首页请求分别报告，
不会被当成“无搜索结果”。当前仅重跑首页投影，不伪造旧游标、不补全文、不入库、不重新计费。
`current_projection_accepts` 只说明当前代码能够处理这份旧响应，不证明当时部署代码相同。

新的响应形状必须有真实证据与对应回归样本后再修改解析规则。不要清空保护账本或用自动重试制造新付费样本。
Hub 冷却到期和下游策略解除阻塞是两件事；前者不证明解析错误已经修复，也不会自动改变下游策略状态。

## 本地验证

`tests/server/weibo-search-diagnostics.test.mjs` 覆盖分页、身份、溢出、空结果、归档完整性、
旧 raw 页大小优先级，以及从 409 请求追溯端点范围内旧响应的只读 SQL。
`tests/server/raw-search-routing.test.mjs` 使用匿名化的实际空分页形状，覆盖两种 Hub 合约的短页、
空页终止、15 页上限、原始归档保留、结果入库、幂等重放、受控全文补取及异常后的阻断。
设置 `MX_INSIGHT_TEST_PGLITE_MODULE` 后使用独立 PGlite 执行 SQL；测试没有生产连接或供应商调用。

修复验证：上述测试连同 gateway、受限原始归档、游标、Night-All 兼容、native forwarding、
微博全文迁移共 150 项，149 项通过、0 失败、1 项独立 PostgreSQL 预算迁移测试因未配置专用连接跳过。
本次全文迁移与只读诊断 SQL 已在 PGlite 中执行通过。
