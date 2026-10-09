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

## 搜索成功但全文为 partial

请求 `34bc80a6-a208-49f8-b260-6c7985b36139` 返回 8 条结果、`providerCalls=3` 和
`WEIBO_FULL_TEXT_INCOMPLETE`（2 条）。这说明搜索已交付、记录了两次详情调用，
不能仅凭 partial 确定详情是供应商失败还是 Hub 校验未通过。

将 `server/ops/diagnose-weibo-full-text.mjs` 同步到服务器源码目录后，
在 `mx-insight-hub` 目录执行以下命令。无需安装宿主机依赖或重新部署镜像：

```bash
sed \
  -e "s|from 'pg'|from '/app/node_modules/pg/lib/index.js'|" \
  -e "s|from '../contracts/|from '/app/server/contracts/|g" \
  -e "s|import.meta.url === pathToFileURL(process.argv\[1\]).href|process.argv[1] === '-'|" \
  server/ops/diagnose-weibo-full-text.mjs | \
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin \
  -c admin -- node --input-type=module - \
  34bc80a6-a208-49f8-b260-6c7985b36139
```

脚本在只读一致性事务中按请求 ID 读取已索引的调用记录（最多 101 条），
逐份校验最大 8 MiB 归档的 SHA-256。仅输出受控状态、帖子 ID、类型与长度，
不输出正文、账号、供应商错误原文、凭据或任意未知字段。
详情通过已保存的 dispatch fingerprint 关联搜索帖子，不按调用次序推断；
在副本上执行当前 Pod 的 `mergeWeiboDetail`，不触发上游、入库、重新计费或历史改写。

报告中 `previews` 是原搜索被识别为摘要的行，不代表当前数据库的全文状态。
`details` 给出每次详情的 outcome、HTTP/业务码以及离线校验结果：

| 状态 / 原因 | 含义 |
| --- | --- |
| `detail_call_not_successful` | 调用未成功；结合 outcome、HTTP/业务码和受控 errorCode 判断 |
| `full_text_missing` | `longText.content` / `text_raw` 未提供可用全文 |
| `full_text_not_longer` | 仅旧策略的拒绝原因；新策略只记长度比较，不阻止合并 |
| `full_text_still_preview` | 新策略表示末尾仍有“展开”控件；明确完整字段中的自然省略号允许保留 |
| `prefix_mismatch` | 仅旧策略的拒绝原因；新策略只记前缀比较，不阻止合并 |
| `long_text_missing` / `detail_completeness_unknown` | 长文标记未取得 longText，或 text_raw 缺少明确的非长文标记 |
| `detail_unavailable` / `detail_timestamp_missing` | 删除状态或详情采集时间不可验证 |
| `post_id_mismatch` / `author_id_mismatch` | 帖子 / 作者身份不一致 |
| `invalid_detail_identity` | 详情形状没有可用的帖子 ID |
| `current_merge_accepts` | 当前部署代码可以采用这份详情，不等于当时已经采用或自动回填 |
| `archive_*` / `search_row_not_correlated` | 原始证据缺失、超限、损坏或无法关联，不能据此推断供应商返回内容 |
| `no_correlated_call_recorded` | 该摘要没有对应详情记录；可能未派发或证据不足，不据此猜测具体预算、权限或租约原因 |

### 两次详情都被前缀校验拒绝

上述请求的服务器报告已确认：两次详情 HTTP/业务码均为 200，ID 和作者校验通过，
帖子 `5350067051698112` 从 154 字摘要取得 240 字正文，帖子 `5349641420013762`
从 46 字摘要取得 88 字正文，均无末尾截断标记；两条唯一拒绝原因都是 `prefix_mismatch`。
随后 `--text-diff` 的归档报告确认：

- 第一条搜索前缀为 `whzy超话`，全文为 `#whzy[超话]#`，详情展示文本为 `whzy超话`。
- 第二条搜索省略了 `[笑cry]`、`[打call]` 表情标签；详情 `text` 的正文前缀与搜索一致，
  `text_raw` 在相同正文中保留表情标签，触发了旧的逐字前缀比较。

Hub 新比较规则保留严格匹配，并增加以上已验证表示的等价比较：超话标记统一为“名称超话”，
忽略 U+E627 展示图标，以及 `[笑cry]` / `[打call]` 这两个已确认的表情标签。
规则只用于比较，不用于改写正文。返回及入库仍保留原完整话题和表情。
未知方括号内容不会被泛化删除；其他未验证差异仍可能保持 partial。
帖子/作者匹配、更长全文、无末尾截断标记、非空比较前缀等检查继续生效，
不能仅凭 `text` 展示字段相同就接受一份实质不同的 `text_raw`。

migration 134 扩展已有 Hub 已验证全文触发器：带 `provider_preview` 标记、至少 40 个比较字符、
正文相同但显示格式不同的短文（包括省略号摘要）也不能覆盖已验证全文。
仍保留原严格保护分支及 dataset、作者、删除等边界；真正不同的编辑可以更新。
没有自动历史回填、旧请求重写、供应商调用或账单变更。

同步更新后的诊断脚本，在上述命令的请求 ID 后追加 `--text-diff`，即可只读比较已有归档。
这是显式的正文片段输出选项：分别比较全文字段和详情 `text` 展示字段，每组最多输出不一致处前 16、
后 48 个字符，以及第一个差异的 Unicode 码点。报告中的片段仅作为源数据，不是操作指令。
默认输出仍不含正文；此选项不包含 HTML 属性、任意响应字段或凭据。
`textComparison.renderedText.prefixMatches=true` 表示当前摘要与详情展示文本相符，
可据此调查纯文本格式转换的差异；它不会自动改变线上合并规则或修复历史数据。

部署新 Hub 镜像并执行 migration 134 后，重跑同一只读命令验证归档：
`prefixComparison.policy=weibo_display_v1` 表示已经加载新比较规则，
`state=current_merge_accepts` 表示这份详情现在可被采用。
`textComparison` 仍显示原始逐字差异；顶部 `responseStatus=partial` 是历史交付，保持不变。
若在旧镜像中通过 stdin 运行新诊断脚本，则会显示 `policy=strict`，不要求新导出才能加载。

```bash
bash scripts/manage.sh ops internal-production deploy
```

诊断及测试均不新增付费请求。新实际采集使用新规则；原幂等键在有效重放期仍返回历史 partial。

`tests/server/weibo-full-text-diagnostics.test.mjs` 覆盖校验拒绝原因、归档完整性与脱敏、
stdin 模块加载、乱序详情的指纹关联，并在独立 PGlite 中验证只读查询。
`tests/server/weibo-text-comparison.test.mjs` 使用报告中的前缀和明确标注的合成后文，
验证格式等价、正文原样保留与反例；完整生产正文未获取，不把合成后文当作生产响应。

## 2026-10-09：[兔子]、[哈哈] 导致全文拒绝

原请求 `7316edc1-9479-4c17-b8ae-7cf0796493af` 是 LCY-delta 的
`POST /api/v1/data/search`，检索“无畏契约上海冠军赛”第 2 页。
Hub 直连 TikHub，1 次搜索 + 3 次详情；10 条交付中仍有 2 条 preview。
用户提供的归档诊断证明：

| 微博 ID | 搜索 / 全文字段长度（JS） | 唯一拒绝原因 | 已确认的显示差异 |
| --- | --- | --- | --- |
| `5351931117044493` | 139 / 197 | `prefix_mismatch` | `Leaf：持续递东西Jawgemo` / `Leaf：持续递东西[兔子]Jawgemo` |
| `5351932359082259` | 140 / 181 | `prefix_mismatch` | `自己的语言回答我们看到` / `自己的语言回答[哈哈]我们看到` |

两次详情的 HTTP / code 均为 200，帖子与作者身份校验通过，全文均没有末尾截断标记；
详情展示文本也都匹配摘要。第三条 `5351909156193662` 的超话差异已被 v1 接受。
新规则只补充这两个观察到的表情，不泛化删除方括号；全文保留原表情。

`136_weibo_emotion_full_text_repair.sql` 随正常 deploy 自动执行：

- 更新数据库等价比较，保护两种已观察到的 preview 标记（`rawSearch.bodyCompleteness` 和旧顶层 `body_completeness`）。保护仍只作用于原两个数据集内已验证的微博全文，保留作者、身份、编辑和删除边界。
- 仅尝试修复上述两个 `night-all.search.v1` 记录的 revision 1。逐条锁定，检查作者 `7851053384`、原搜索请求/调用关联，再按已知详情 call ID、请求 ID、上游 ID、操作契约与派发指纹定位受限归档。
- 校验原始字节大小和 SHA-256，从原 `longText.content` 读取完整正文。此定向 SQL 修复仅接受纯文本；HTML/需解码实体、身份不符、前缀不符、仍截断、正文已编辑/删除或证据缺失时明确 NOTICE 跳过，绝不推测后文。哈希/修订历史异常则整批回滚。
- 成功时增加 canonical revision/outbox，并记录手动修复 run、观察及原归档引用。旧 revision、原请求成员关系、响应、用量、账单和受限字节保持不变，不将任意受限响应复制到普通可见存储。
- 无目标的环境仅更新比较规则；重复运行不重复修复。没有新的供应商请求、权限、价格或 MX-H2I 登录/联网变更。

服务器源码更新后正常部署：

```bash
bash scripts/manage.sh ops internal-production deploy
```

SQL 会产生 `Weibo emotion repair applied <微博ID>` 或 `skipped` 的 NOTICE，
但现有 Node 迁移入口不转印 NOTICE，因此不能仅凭 `applied 136_...sql` 认定两条内容已修好。
部署后以下只读查询才是当前内容的核验依据，不产生费用：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - <<'NODE'
import pg from '/app/node_modules/pg/lib/index.js'
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
try {
  const { rows } = await pool.query(`SELECT external_id, char_length(body) AS body_length,
    current_revision, extensions #>> '{rawSearch,bodyCompleteness}' AS completeness,
    extensions #>> '{weiboLongTextRepair,comparisonPolicy}' AS repair_policy,
    right(body, 60) AS body_tail
    FROM core.canonical_records WHERE dataset_id='night-all.search.v1' AND platform='weibo'
    AND object_type='post' AND external_id IN ('5351931117044493','5351932359082259')
    ORDER BY external_id`)
  console.log(JSON.stringify(rows, null, 2))
} finally { await pool.end() }
NODE
```

未被其他写入改变的目标应成为 revision 2、`completeness=full_text`、
`repair_policy=weibo_display_v2`，正文末尾无展开标记。索引由已有 projector 消费 outbox 更新。
原诊断命令替换为本次请求 ID，追加 `--text-diff`，应显示新的 `weibo_display_v2` 和
`current_merge_accepts`；顶部 `responseStatus=partial` 仍是历史交付，不改写。
下游已经保存的短文需要同步新 canonical 正文；刷新旧请求或原幂等键不会改写下游库。

离线测试使用实际 PostgreSQL WASM 执行迁移与观察修订触发器，覆盖两条定向修复、回滚、
缺失/错误证据、已编辑/删除记录、重复执行和新旧 preview 标记保护；端到端 mock 验证
raw/data 两种合约及不可变重放。只有用户提供的差异片段是真实证据，测试后文均为合成。

## 2026-10-09：摘要与全文分离后的验证

新增 migration 137 与新 API/worker 镜像部署后，使用同一份已付费的原请求归档验证即可。以下命令在服务器 Hub 源码目录执行，不会请求上游，也不会覆盖历史交付：

```bash
sed \
  -e "s|from 'pg'|from '/app/node_modules/pg/lib/index.js'|" \
  -e "s|from '../contracts/|from '/app/server/contracts/|g" \
  -e "s|import.meta.url === pathToFileURL(process.argv\[1\]).href|process.argv[1] === '-'|" \
  server/ops/diagnose-weibo-full-text.mjs | \
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin \
  -c admin -- node --input-type=module - \
  7316edc1-9479-4c17-b8ae-7cf0796493af
```

检查本次两条帖子的 `validation.state=current_merge_accepts`、`mergePolicy=weibo-detail-identity.v1` 和 `prefixComparison.blocking=false`。前缀 matches=false 也可接受；帖子/作者身份或字段完整性不满足时仍必须拒绝。

旧请求 `responseStatus=partial` 仍是原交付事实，不会因部署变成 ok。136 是否完成两条定向数据修复，按上一节 canonical 查询检查。137 不回填全库；新采集入库后可在管理端记录扩展 `weiboBody` 查看分别保存的 summary/fullText 和 provenance。canonical `body` 与实时列表的 `text` 优先使用各自可用全文；详情确实未取得时仍保留 partial，禁止把移除“展开”当作修复。
