# 2026-09-23 三个平台搜索故障取证

| Hub requestId | 用户报告 | 最新证据（05:58 UTC） |
| --- | --- | --- |
| 98a5c405-dbe4-4ccc-bf0a-5e6907ca7320 | 抖音 night_all_rejected | Night-All 候选请求 DATA_UPSTREAM_FAILED；供应商候选调用 HTTP 400，cursor=8、有 backtrace、没有 search_id |
| 43b3dd52-76a3-41a7-b5e3-e3fbad5b06fa | 快手 upstream_outcome_unknown | Hub 30 秒截止；匹配的 Night-All 候选请求 34.601 秒后成功，HTTP 200、9 条，完成比 Hub 截止晚 4.601 秒 |
| 87a2d0c7-ebf6-41bb-b1ee-1bd073a4477b | 微信公众号上游 503 | wechat_mp 在 Night-All 能力门禁被拒：DATA_PLATFORM_NOT_READY / degraded / contract_unverified |

不能把三个 ID 都归因为上一事件的游标丢失，也不能把错误类别当根因。
初始工作仅取证；后续按用户要求将 Night-All 调用超时统一为 60 秒。
不增加调用次数限制、不重试、不改结算或登录/联网。

## 源码发现

Hub `HubService.search()` 的历史 Night-All 分支（/api/v1/data/search）只记录 usage，
没有 legacy raw/crawl/user-info 分支的 beginConnectorCall/finishConnectorCall 和结构化
错误链存储。因此如果请求确实走该路径，诊断页没有当次上游调用记录是现有实现缺口，
不是证实未调用上游；旧上游 ID 也无法通过补部署自动恢复。需要从 acquisition_request.path
确认本次实际路径，再按 Night-All 时间、平台、query hash 关联其请求记录。

Night-All `paged-content-search-service.js` 中 DATA_PROVIDER_CALL_LIMIT_REACHED 表示
该次页请求的内部 pageFetches 达到安全上限，输出少于 pageSize 且 providerState.hasMore=true。
默认上限是 3，可由构造配置降低/改变；这里计数是底层页面获取次数，不等同于包含重试、
候选端点和详情补充后的实际供应商请求次数。warning 不证明账户总配额或余额耗尽，
也不是这三笔失败的统一原因。是否继续用 pageInfo.nextCursor 应结合成功包络、hasMore、
分页进展和采集预算；不能为消除此 warning 就提高上限。

Hub NightAllAdapter 的 unknown 包含连接/读取异常、超时，以及成功 HTTP 的非 JSON、
JSON 解析失败、响应契约校验失败。因此快手不能只凭错误类别判为超时或断网。
部分请求可能已在供应商执行甚至计费，需要保留原幂等身份和下游检查点。

## 服务器只读取证

复制更新后的 [diagnose-douyin-request.sh](../../scripts/diagnose-douyin-request.sh)。
文件名保留兼容旧命令，现支持 1–10 个 Hub UUID，不局限于抖音。
在有 kubectl 权限的 Hub 管理机执行，非 Night-All 项目根目录：

```bash
bash diagnose-douyin-request.sh \
  98a5c405-dbe4-4ccc-bf0a-5e6907ca7320 \
  43b3dd52-76a3-41a7-b5e3-e3fbad5b06fa \
  87a2d0c7-ebf6-41bb-b1ee-1bd073a4477b \
  | tee /tmp/hub-search-diagnosis-20260923.json
```

输出 diagnosticVersion=3。保留旧请求的只读 cursor 解密与运行实例 compound 合成探针，
新增请求路径/耗时/querySha256、cursor operation、三个账本及成功交付的分页/warning 摘要。
querySha256 对原 query.trim() 的 UTF-8 做 SHA-256，不打印查询词；它只用于后续关联候选，
不能替代 requestId/traceId 直接关联。缺失的请求 ID 独立列出，不冒充查询成功。
账本查询使用独立 savepoint，失败显示 Error.code；最多 150 条并标明截断。
已保存的 failure_evidence 复用白名单投影；正文、密钥、完整 cursor 和任意错误消息不输出。

没有 connector 记录时，先取得三个请求的真实时间和路径，再在 Night-All 查询
data_api_requests 的对应窗口/平台和 query hash，得到 req_* 后查 logs/api.log 与 source_call_logs。
时间/关键词候选需继续验证，不能直接归属。脚本不会重新采集，也不会自动解除 unknown。

本轮未改变生产调用逻辑；服务器返回证据前不推断具体 400/503 或 unknown 的内层原因。

## Hub 服务器返回与下一步（05:47 UTC）

三个请求均命中 `/api/v1/data/search`；querySha256 相同。运行 compound 探针三项均为 true。
抖音是第二页，Night-All HTTP 502，6204 ms；快手是第三页，30013 ms 后 unknown，
服务明确配置 NIGHT_ALL_TIMEOUT_MS=30000；wechat_mp 无游标首屏，44 ms 返回 HTTP 503。
四个证据列表均为空且无查询错误，确认该路径缺少 connector 证据，不是 UI 漏展示。

注意 data-search 外层 token 的 continuation.value 是 Night-All 的不透明服务端游标，
完整 provider state 保存在 Night-All data_search_cursors。外层 hasSearchId=false /
hasBacktrace=false 不是 raw compound 的丢参证据。不能把旧 raw 接口结论直接套用。
快手时间高度支持 Hub 30 秒 deadline，但仍需查询 Night-All 是否在此后成功/失败完成；
wechat_mp 的速度符合能力门禁等早期拒绝，需要具体错误码，不能据此确认供应商停机。

### Night-All 旧状态兼容修复（未部署）

当前 Night-All HEAD 的 tikhub-endpoint-orchestrator 已在 `a50c296` 保留抖音原生
params.cursor，新状态已修复。paged-content-search-service.fetchInput 仍假定非 cursor
的 nextParams 已含全部上下文，读取旧服务端状态时会省略独立 nextCursor。
本轮在 Night-All `lib/domains/search/paged-content-search-service.js` 增加约束性恢复：
仅 platform=douyin 且 endpointId 为 video_search_v1/general_search_v2、params.cursor
为空时，用保存的 continuation.nextCursor 补齐。已有 cursor 优先，不改变其他平台，
不重写存储、不放宽 TTL/身份/端点绑定、不新增请求或调整填页/重试上限。
不能因此宣称生产本请求已确认命中该情况。后续供应商调用记录已有 cursor=8，
这项旧状态兼容修复不能单独解决该次 HTTP 400。

新增 Night-All tests/paged-content-search-service.test.js 三项测试，使用当前真实提取器
生成状态并模拟旧库中 cursor 分开放置，覆盖两端点跨三页、内部填页和已有 cursor 优先。
修复前 3 项失败，修复后相关四文件共 40 项通过；Hub 两诊断文件 7 项通过，跨源码验证通过。
无付费请求，无部署，无 MX-H2I 登录/联网修改。

### 执行新的 Night-All 只读脚本

把 [diagnose-night-all-search-requests.sh](../../scripts/diagnose-night-all-search-requests.sh)
复制到服务器 Night-All 的 scripts/ 下，从 Night-All 根目录执行：

```bash
sudo env NODE_BIN="$(command -v node)" \
  bash scripts/diagnose-night-all-search-requests.sh --from-api-process \
  | tee /tmp/night-all-search-diagnosis-20260923-v2.json
```

沿用已验证的 PID/cwd 检查和 API 进程 DATABASE_URL 读取方式，不需要部署修复即可运行。
输出 diagnosticVersion=2。读取 data_api_requests 候选；只有可用的真实 cursor 才精确 JOIN，
审计值为 [redacted] 时明确标为 audit_cursor_redacted_not_looked_up、found=null。
检查 query hash、错误码、结束是否晚于 Hub；
读取 provider state 的参数存在性和 cursor 摘要，不打印游标原值；source_call_logs
按平台和包含 Hub 截止后两分钟的窗口列候选（不是已证明关联）。各节独立 savepoint、
5 秒 statement_timeout、最多 50 条及截断标记；已被 TTL 清理的游标不会被重建。
从 logs/api.log 最后最多 64 MiB 中筛出候选 requestId 的结构化错误，最多 50 条，
只输出代码/状态/端点等，不输出错误正文、凭据或请求内容。日志轮转/缺失或表权限错误
均单独报告。取回后优先区分 DATA_PLATFORM_NOT_READY、DATA_CURSOR_*、DATA_UPSTREAM_FAILED
和供应商 HTTP 错误，以及快手在 Hub deadline 后的真实完成状态。

## Night-All 服务器证据与处理结论（05:58 UTC）

Hub 没有保存本路径的上游 requestId；以下映射来自平台、请求开始时间和 query hash
一致的候选，各窗口仅返回一条。供应商记录 trace_id 为空，不能称为跨系统 ID 精确关联。

| Hub requestId 前缀 | Night-All 候选 requestId | 证据 |
| --- | --- | --- |
| 98a5c405 | req_mudnmt3b_683653ed | 05:20:35.783–05:20:41.972 UTC，502 / DATA_UPSTREAM_FAILED |
| 43b3dd52 | req_mudnocnd_9a8637c4 | 05:21:47.785–05:22:22.386 UTC，200 / success / result_count=9 |
| 87a2d0c7 | req_mudnpfou_c5ef4b57 | 05:22:38.382–05:22:38.412 UTC，503 / DATA_PLATFORM_NOT_READY |

### 抖音：底层 HTTP 400，仍缺供应商错误正文

source_call_logs.id=242221、endpoint=douyin_search_fetch_video_search_v1 返回 HTTP 400。
请求已有 cursor=8 和 backtrace，request_search_id 为空。因此不是简单补主 cursor 就能解决。
[TikHub 分页说明](https://docs.tikhub.io/370212779e0) 说明 search_id、backtrace 应从上一页获取。
缺 search_id 是明确需要核查的上下文缺口，但 raw_saved=false、没有错误原文，尚不能证明
它是 HTTP 400 的唯一原因，也不能断言丢在 Hub、Night-All 提取器或首屏上游响应中的哪一处。
不凭空用其他平台的 impr_id 规则替换 Douyin search_id。

Night-All 审计 upstream_call_count=0 不能证明没有实际供应商调用；该失败路径的汇总未体现
source_call_logs 中已发生的调用。需要继续检查首屏响应/保存的 provider state 和供应商错误。

### 快手：Hub 截止早于上游成功

Hub 运行配置 NIGHT_ALL_TIMEOUT_MS=30000，请求约 30.013 秒进入 unknown；候选 Night-All
请求耗时 34.601 秒并成功返回 9 条，供应商日志 id=242230 也记录 HTTP 200。
这组证据高度支持 Hub deadline 导致下游看到 unknown，不能将其当成供应商未执行。

按用户后续要求，Hub 配置、适配器自身兜底、.env.example、Compose 和部署脚本统一默认
NIGHT_ALL_TIMEOUT_MS=60000（此前应用/部署默认 120000，适配器独立兜底 30000）。
这是每次完整上游 HTTP 调用的总等待预算，包含响应头及完整响应体；不在收到响应头后重置。
需要同时修改实际运行环境中的 30000 覆盖值及持久部署配置，再重启 Hub API。
同时核对反向代理、下游等待时长和请求租约，让整条链路允许该耗时。
本轮未操作部署。旧 unknown 请求缺已提交的响应正文，不能仅凭 result_count=9 标成功交付、
扣费或自动重试，应保留幂等身份和检查点，按证据核对结算与交付。

已有 Kubernetes 部署先将 Hub 项目 `.env.internal` 中该项更新为 `60000`，避免下次部署
恢复旧值。仅更新现有 Hub ConfigMap 的该字段并重启两个 API 工作负载：

```bash
kubectl -n mx-insight-hub patch configmap mx-insight-hub-config --type merge \
  -p '{"data":{"NIGHT_ALL_TIMEOUT_MS":"60000"}}'
kubectl -n mx-insight-hub rollout restart deployment/mx-insight-hub-public deployment/mx-insight-hub-admin
kubectl -n mx-insight-hub rollout status deployment/mx-insight-hub-public --timeout=180s
kubectl -n mx-insight-hub rollout status deployment/mx-insight-hub-admin --timeout=180s
kubectl -n mx-insight-hub exec deployment/mx-insight-hub-public -- printenv NIGHT_ALL_TIMEOUT_MS
```

预期打印 `60000`。该操作不改 Secret、Key、业务计费和 Launcher 工作负载；按单副本策略，
两个 Hub API 在重启时会短暂不可用。反向代理/客户端的等待时间应留出上游 60 秒之外的本地
处理与传输余量，不要把代理等待也卡在同一秒导致 Hub 的结构化错误无法送达。

60 秒修订验证：新增 6 项模拟时钟测试，覆盖适配器独立默认和配置注入两种路径：
34.601 秒成功、响应头等待到 60 秒中止、响应头与正文合用 60 秒预算、不自动重试。
既有 Hub 搜索/分页/登录用例共 112 项通过、1 项按既有条件跳过；部署脚本测试通过。
Night-All 分页服务/提取器 39 项通过，跨源码两类抖音端点各 3 页完整上下文验证通过。
本次无需新增 Night-All 源码改动；这些离线用例不证明供应商历史 HTTP 400 已恢复。

### 公众号：契约未验证，调用前被拒

Night-All 日志明确返回 platform=wechat_mp、capability=search_posts、status=degraded、
reasons=[contract_unverified]。源码在 ready_only 的能力检查阶段拒绝，尚未进入供应商调用。
应核对运行实例选中的 provider/endpoint，完成该端点的实际契约验证；不直接切 best_effort，
也不手工伪造 last_success_at 来绕过门禁。

当前目录验证要求相关 endpoint 有 last_success_at 和 contract_updated_at，且前者不早于后者。
脚本 v2 的 currentCatalog 仅输出当前目录证据；它不是历史配置快照或全部就绪条件。

### 更正诊断 v1 的游标结论

两笔审计 cursor 长度均为 10、SHA-256 均为
017ad73325fcf108a972edac618f9edfc957c5b1de10f8b371b0a8bfa4f59e2d，实际都是 [redacted]。
Night-All data-api-request-service 会脱敏 cursor 字段；旧脚本用这个占位符关联游标表，
导致 found=false。该结果不能证明真实游标丢失、过期或被删除。

v2 已修正此误导，并添加 cursorContextCandidates：同 business/platform/query、时间范围的
当前游标候选，只输出指纹和参数存在性，标明 context_only_not_token_match；updated_at
晚于请求会单独标记。候选不等于确切请求游标，也不能还原当时已被覆盖/删除的状态。
新增脱敏占位符回归测试；Night-All 诊断脚本 3 项测试通过，bash 语法检查通过。
本轮只改诊断脚本、测试和本文档，未调用付费接口、未部署、未修改登录或联网路径。
