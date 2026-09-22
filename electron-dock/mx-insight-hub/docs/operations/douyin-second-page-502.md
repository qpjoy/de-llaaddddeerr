# Douyin 第二页 502：2026-09-22

Hub requestId：`37bf1066-508d-47c9-9c54-2d572e03a0a5`。
告警检索式：`受害企业 赔偿回收率`；失败页 2，完成 1 页，累计入库 1 条。
告警中的三天窗口是业务检索范围，不能把窗口起止当作失败调用的精确时间。

## 目前证据

已进一步取得 Night-All `http_request_failed` 日志，与下方 requestId/traceId 完全吻合。
请求进入 `/api/v1/search/raw`，应用耗时 13144 ms；Night-All 的
`TIKHUB_ALL_ENDPOINTS_FAILED` 包含两个失败候选：
`douyin_search_fetch_video_search_v1`、`douyin_search_fetch_general_search_v2`，
均为 `TIKHUB_HTTP_ERROR` / `TikHub request failed.`。
因此当次 502 确认为 Night-All 应用汇总 TikHub 候选 HTTP 失败，不是仅凭代理返回码的猜测。
日志没有具体供应商 HTTP 状态、正文或重试次数，仍不能定性分页参数、限流或供应商故障。

本地代码进一步确认：TikHub client 的异常 details 原有 statusCode/body/attempts；
`callTikHubCandidates()` 聚合时仅复制 endpointId/message/code，丢弃其余 details。
`executeTikHubEndpoint()` 在丢弃之前会尝试将 `err.details.statusCode` 保存到
`source_call_logs.http_status`，所以历史数据库仍可能提供具体 HTTP 状态。
该路径创建调用记录时没有传 traceId，不能只用 trace_id 精确过滤；应按实际时间窗口、
平台、能力和两个端点检索候选，再核对关键词。并发记录不可直接当作本请求记录。

下一步在 Night-All 项目根目录运行
[diagnose-night-all-douyin.sh](../../scripts/diagnose-night-all-douyin.sh)，
使用服务同一 Node 环境与数据库配置，仅读取历史调用账本。
HTTP 状态只是下一层证据；若仅剩 400 等状态而未存响应正文，仍不能凭状态猜参数原因。

2026-09-22 19:18（北京时间）收到用户返回的 Hub 数据库证据：

- Hub 请求 `released`，`night_all_http_502`，无响应正文，未保存结构化 failure_evidence。
- 请求快照存在，`platform=douyin`、`count=20`；顶层 cursor 为长度 353 的字符串。
  其哈希为 `83efb7d3873dd8db728193cc1a4243524273b6c3452a0388a2fb37ccc66e4385`。
  游标存在不证明它损坏，也不等于已经知道解包后发给 Night-All 的分页参数。
- connector 为 `raw`、`failed`、`failure_kind=http`、HTTP 502，耗时 13147 ms。
- 实际调用窗口是 `2026-09-22T10:24:54.337Z` 至 `10:25:07.486Z`，
  北京时间 18:24:54–18:25:07。
- 上游 requestId 为 `req_mucj2atg_dab35701`，traceId 为
  `ebf5a392b67ce29affdaa64ae4a4f809`。

这些记录确认是收到明确 HTTP 拒绝而非 Hub 的未知结果/等待超时分支。
Night-All 格式的关联 ID 强烈支持请求进入了 Night-All 应用，但具体内层原因仍需日志。
13.1 秒不能单独证明发生了重试、超时、限流或游标错误。
无需继续重复读取该 Hub ID；下一步在对应 Night-All 实例的项目根目录执行：

```bash
grep -nF \
  -e 'req_mucj2atg_dab35701' \
  -e 'ebf5a392b67ce29affdaa64ae4a4f809' \
  logs/api.log
```

若没有匹配，核对轮转日志及 Docker/systemd 实际 stdout 日志；空结果不表示请求未发生。
需要同一 ID 的错误记录、`error.code`、`details.errors`、`endpointTrace` 与内层 HTTP 状态。
若只剩 http_request 汇总，则从 Night-All 的 data_api_requests 按同一 request_id
读取 error_code/error_message 与当次 request_params 中的分页字段，继续关联供应商调用记录。

Hub 返回 `night_all_rejected` / `upstreamStatus=502`，表明收到了 Night-All 地址对应的
HTTP 502。具体由 Night-All 应用还是其前置代理产生，需要调用记录与日志确认。
不能直接把它归因为 Hub 请求格式、代理、临时抖动或 TikHub 的某种分页错误。

另一截图报告的测试是 `keyword=AI`、`limit=1` 的首屏，三次 HTTP 200，
与此次不同关键词、第二页的请求不等价，也未验证同一服务实例/参数/游标。
截图同时报告标准化 items=0：这只能说明该次 HTTP 请求成功，不能证明有效数据交付已恢复。
这也不能直接解释此前的 502。`hub_legacy_request_failed` 是路由/日志名，不证明该路由过时。

## 原因不可见的代码缺口与修复

### 两个项目源码联查与当前修复状态

2026-09-22 重新核对：当前 Hub 工作树已包含提交 `d2cceed8`（2026-09-21）的
compound 分页修复，不能将该已有修复描述成本轮新增，也不能据此认定生产实例已更新。

实际路径：

1. Night-All `tikhub-endpoint-orchestrator.js` 的 `extractProviderPage` 从供应商 data
   提取 cursor/search_id/backtrace，返回 compound；主 cursor 与 nextParams 分开。
2. Night-All `payload-utils.js` 的 `paginationContract` 保留该分页信息。
3. Hub `capNightAllCompatibilityTraversal` 将完整状态封装成 consumer 绑定的加密
   mxnc1 游标；下游仅传回 nextCursor，不需要理解平台参数。
4. Hub `prepareNightAllCompatibilityTraversal` 还原 cursor 和 params，适配器向
   Night-All `/api/v1/search/raw` 原样传递还原后的字段。
5. Night-All `tikhub-raw-search-service.js`、`tikhub-param-mapper.js` 合并参数，
   `tikhub-execution-service.js` 注入端点默认值，再交给 TikHub client。

修复前 Hub 只识别 composite，compound 落入单值 cursor 分支，搜索上下文丢失。
本轮新增 [跨源码验证脚本](../../scripts/verify-night-all-pagination.mjs)，使用 Night-All
真实目录、分页提取、分页契约、参数构建和执行模块，只替换数据库、供应商 client 及
内容归一化为合成数据；不启动服务、不加载密钥、不访问网络或数据库。

```bash
# 从 Hub 项目根目录运行；第二个路径是本机 Night-All 源码目录。
node scripts/verify-night-all-pagination.mjs /Users/qpjoy/workspace/mingxi/Night-All
```

结果：两个抖音搜索端点各三页均保留 cursor/search_id/backtrace 和静态筛选条件，
终页停止；付费请求 0。将 Hub 分页模块临时替换为 `d2cceed8^` 的版本后，同一验证在
第二页 search_id 断言失败（实际空字符串），复现了跨项目参数丢失，不是模拟供应商 400。
旧单值 token 在新代码下仍不能恢复已丢失的上下文；合成旧 token 长度也是 353，
与现场相同但长度本身不是归因证明。

本轮未再次修改生产分页算法或 Night-All 源码。对外继续维持统一 nextCursor，平台/
端点差异留在适配边界；未来新增端点应验证完整 continuation，而非让下游按平台拼参数。
既有多平台矩阵覆盖 12 平台/13 端点形态；同平台不同供应商或接口版本不能任意共享游标。

### 区分运行版本与旧游标（不付费）

2026-09-22T12:08:59Z 用户返回的 Hub v2 诊断明确显示：

- runtimeHost=mx-internal-server；所测代码 preservesCursor=true，但 preservesSearchId /
  preservesBacktrace 均为 false。该运行实例尚不具备本地 d2cceed8 的完整 compound 处理，
  不能再仅归因为旧游标。该主机名本身不证明部署方式或其他副本状态。
- 历史 token 已通过该 consumer 的认证解密，platform/operation 匹配，page=2、
  type=cursor、numericCursor=8，没有 search_id/backtrace。缺上下文已由解密证实，
  不再只是长度 353 的猜测；但供应商 400 的具体解释仍未取得。
- 先将包含修复的 Hub 代码更新到实际运行服务、核对所有副本三项 probe 均为 true，
  再为受影响查询建立新的首屏/游标链；新代码不会修复已持久化的旧 token。
- 用户允许必要时在 Hub 或 Night-All 修改上游适配；本问题已有 Hub 修复足以保留
  Night-All 返回的上下文，本轮不为相同缺陷重复修改 Night-All。

下游统一调用规则与示例见 [Hub 游标标准](../api/hub-cursor-standard.md)。

本轮增强 [Hub 诊断脚本](../../scripts/diagnose-douyin-request.sh)（diagnosticVersion=2）。
注意该脚本在有 kubectl 权限的 Hub 管理机执行，与 Night-All 的 v4 脚本是不同脚本。
它读取既有请求快照，并在 Pod 内用该 consumer 的 codec 验证/解密 cursor；只输出结构、
数字游标和字段存在性，不输出密钥、search_id/backtrace 原值或完整 cursor。
同时以纯合成数据测试所选运行实例的 compound 封装/还原行为，不调用任何供应商。

```bash
bash diagnose-douyin-request.sh
```

| runtimeCompoundProbe | cursorState | 含义与处理 |
| --- | --- | --- |
| searchId/backtrace 为 false | 任意 | 当前所查 Pod 缺少完整分页处理；应更新并核对全部副本 |
| 三项 true | authenticated、type=cursor、hasSearchId=false | 当前逻辑已修复，但历史 token 未携带该上下文；不能靠重试该 token 补回 |
| 三项 true | authenticated、type=params、hasSearchId=true | 该 token 已包含上下文；需核对当时实例、首屏证据、最终参数及供应商错误正文，不能继续认定 Hub 丢参 |
| 任意 | 解密失败或 absent | 密钥轮换、无快照等证据不足，不等于 token 内容缺失 |

单个 Pod 的行为不证明全部副本一致；runtimeHost 标出所测实例，HUB_TARGET 可指定具体
Pod 再只读核对。token 缺上下文也不能单独证明一定由旧版 Hub 生成，首屏上游可能未提供。
历史交付保持不变。必要的线上恢复验证应使用新首屏、新幂等键和它返回的新 cursor
请求第二页，不能用旧交付/旧 token 验收；用户已授权必要的少量付费验证，本轮尚未使用。

本轮验证：现有分页/多平台/加密游标测试 35 项通过；诊断脚本测试 3 项通过，覆盖完整/
旧 token、认证失败、只读连接和敏感值不输出。未部署或更改 MX-H2I 登录/联网。

### v4 返回的历史证据（2026-09-22T11:37:59Z）

从当前 API 进程 DATABASE_URL 成功连接，并在 data_api_requests 精确命中
`req_mucj2atg_dab35701`：failed、HTTP 502、TIKHUB_ALL_ENDPOINTS_FAILED，
时间 10:24:54.341–10:25:07.483 UTC。upstream_call_count=0 不能解释为未调用上游，
因为同一 requestId 的应用错误日志明确记录两个端点失败。

两条高度吻合的候选账本为：

| source_call_logs.id | endpoint | UTC 时间 | HTTP |
| --- | --- | --- | --- |
| 240393 | douyin_search_fetch_video_search_v1 | 10:24:54.345–10:24:59.614 | 400 |
| 240394 | douyin_search_fetch_general_search_v2 | 10:24:59.618–10:25:07.480 | 400 |

两者 keyword_matches=true、cursor=8、has_search_id=false；端点、顺序、时间和总请求
高度吻合，但 trace_id=null，不能声称已通过关联 ID 直接证明归属。
此前同关键词附近也有多次 HTTP 400，以及 10:22:01 的一条 429；后者不属于本次时间窗口，
不能用它把本次故障定性为限流。之后出现 HTTP 200，只能证明其他请求成功。

首版脚本 capability='search_posts' 会漏掉这些记录：实际值为
search_fetch_video_search_v1 / search_fetch_general_search_v2。
Hub 的长游标与此处 cursor=8 属于不同层的记录，不应直接比较长度来断言损坏。
缺 search_id 是分页参数核对线索，不足以证明 400 的原因；本地端点定义也没有 count/offset，
因此 requested_count/offset=null 不能直接判定 Hub 丢参。
候选记录 raw_saved=false、has_raw_response_ref=false，当前材料没有供应商 400 的解释正文。
后续应核对失败页参数及首屏返回的分页上下文，并在 Night-All 候选聚合前保留脱敏 HTTP
状态与结构化错误、传递 requestId/traceId，避免继续只保存泛化错误；不自动重跑收费请求。

用户执行首版 Night-All 账本查询返回 `calls: []`：这只代表该数据库中精确时间窗口、
provider/platform/capability/endpoint 条件没有匹配，不能推翻同 requestId/traceId 的失败日志。
`executeTikHubEndpoint` 使用 endpoint.capability 写账本，且 createCall 失败被捕获后仍继续
发送上游请求；finishCall 失败也被忽略。因此还需区分筛选漏查、运行实例与脚本的数据库
配置不同、写入失败或历史记录清理，不能直接归因为其中任何一种。

更新后的 [Night-All 只读脚本](../../scripts/diagnose-night-all-douyin.sh)
输出 `diagnosticVersion: 2`，依次查询精确 Night-All requestId、UTC 10:22–10:28 的
全部 douyin 候选调用、同窗口 traceId 匹配及最近五条 TikHub douyin 调用。
查询分别使用 savepoint；缺表、超时等显示错误码，不伪装成空数组。
每条查询限时 5 秒，候选最多返回 50 条并标明截断；不输出密钥、原始游标和响应正文。
`databaseConfigSource` 只说明本次脚本选用的配置来源，不证明与运行服务数据库相同。
最近记录和时间窗口候选只能辅助定位环境，不能据此把别的请求归给本事件。
即使精确请求存在而调用账本为空，也不足以独立证明当时写入失败；需进一步核对日志及保留策略。

后续 v2 输出 `DATABASE_URL_missing` 表明本次未建立数据库连接，不能作为空账本证据。
v2 的 `databaseConfigSource: config.json` 只是环境变量缺失时的默认标签，不能证明配置有效。
Night-All 的 start-node.sh 会 source 项目 `.env`，独立运行 Node 不会自动执行此步骤。
v3 修正来源为 `none`（未解析到连接），并提供 `bash diagnose-night-all-douyin.sh --with-env`，
仅显式加载当前项目受信任的 shell 格式 `.env`；不执行启动脚本、不重启服务。
如果仍缺配置，应核对实际服务容器/启动环境，不应猜测默认数据库或回传连接密钥。

v3 加载 `.env` 后仍返回 `DATABASE_URL_missing`。本地 start-node.sh 在 production 分支
额外注入默认 DATABASE_URL，因此只加载 `.env` 不一定等价于服务环境；服务器启动方式尚未确认。
v4 增加 `--from-api-process`：在 Linux 上通过 logs/runtime/api.pid 找到进程，验证 cwd
与当前目录相同且命令包含 server.js，只将其启动环境中的 DATABASE_URL 传给诊断子进程。
不打印该变量、不执行启动脚本、不复制其他服务环境变量；任何验证失败均停止，不猜测默认库。
需要 Python 3，并使用有权读取该进程 /proc 信息的服务用户，在同一容器/主机环境中执行。
该方法确定当前服务连接配置，不证明事件发生时配置相同。

NightAllAdapter 收到错误 JSON 后保存在 UpstreamRejectedError.body，
但 legacy 失败结算只保存总括 HTTP 错误码与顶层关联 ID，原内层证据没有落库。
本次补充 migration 102 与固定字段的错误链投影，保存到 connector_calls.failure_evidence，
由 Admin Token 专用请求诊断展示。保留候选端点 errors/endpointTrace 中已有的错误码；
上游此前删掉的 statusCode/message details 无法从 Hub 重新推导。
响应头 ID 作为正文缺失 ID 时的补充。公开错误和原业务结果保持不变。

## 查这个历史请求

在 Hub K8s 管理服务器复制并执行：

```bash
bash diagnose-douyin-request.sh
```

脚本：[diagnose-douyin-request.sh](../../scripts/diagnose-douyin-request.sh)。
只读指定请求与连接器记录，包含真实调用时间、Night-All requestId/traceId、分页参数摘要；
游标/search_id 只输出长度和哈希。无需更新镜像，不请求供应商、不恢复冷启动、不扣费。

贴回 JSON 后，沿返回的上游 requestId/traceId 在实际 Night-All 实例查日志；
不要只在 Night-All 中搜 Hub UUID。若关联 ID 缺失，应按 connector started_at/completed_at
核对服务/代理日志。升级不会补回旧错误，因此不要靠重复复现这个 ID 验证新错误捕获。
不要自动重新执行第二页或冷启动；任何必要的新请求对照需用户明确触发。
