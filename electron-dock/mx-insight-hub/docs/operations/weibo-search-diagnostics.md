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
若生产使用默认值，需重点核对 `07:44:13.288Z` 完成的那次调用；这尚不是已确认的原始请求。

微博直连搜索投影会检查 `data.parsed_data.results`、布尔类型的
`pagination.has_next_page`、逐行帖子 ID，以及实际返回条数是否超过请求页大小。
当前 gateway 将这些解析错误统一记录为 `invalid_weibo_search_contract`，
必须读取原始归档才能确定失败分支。不能仅凭 409 断言是分页格式、空结果、正文“展开”或某个关键词导致。

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

脚本随已有 Dockerfile 的 `server` 目录复制进入镜像，没有新增自动任务或 migration。
此命令也可用于一条原始微博失败请求。旧记录没有保存 blocker ID，
`endpoint_quarantine_candidate` 始终表示候选；`matchesReportedDeadline=true`
表示按当前运行环境的冷却配置计算，候选的截止时间与告警一致。
修改过冷却配置、历史缺失或候选截断时，不能据此认定唯一因果关系。

`projection.reason` 区分：

| 错误码 | 当前解析器拒绝原因 |
| --- | --- |
| `invalid_weibo_search_shape` | 结果数组或布尔分页字段不符合要求；结合 `shape` 看缺失、null 或类型 |
| `invalid_weibo_identity` | 帖子 ID 不符合要求；`invalidRowIndexes` 是最多 20 个从 0 开始的位置 |
| `weibo_page_exceeds_requested_count` | 供应商返回条数超过请求页大小 |
| `unexpected_projection_error` | 其他解析异常；不输出任意异常消息 |

缺少归档、摘要不符、非 JSON、非成功 envelope 和缺少原始首页请求分别报告，
不会被当成“无搜索结果”。当前仅重跑首页投影，不伪造旧游标、不补全文、不入库、不重新计费。
`current_projection_accepts` 只说明当前代码能够处理这份旧响应，不证明当时部署代码相同。

拿到报告后，针对真实响应补回归样本再修改解析规则。不要清空保护账本或用自动重试制造新付费样本。
Hub 冷却到期和下游策略解除阻塞是两件事；前者不证明解析错误已经修复，也不会自动改变下游策略状态。

## 本地验证

`tests/server/weibo-search-diagnostics.test.mjs` 覆盖分页、身份、溢出、空结果、归档完整性、
旧 raw 页大小优先级，以及从 409 请求追溯端点范围内旧响应的只读 SQL。
设置 `MX_INSIGHT_TEST_PGLITE_MODULE` 后使用独立 PGlite 执行 SQL；测试没有生产连接或供应商调用。
