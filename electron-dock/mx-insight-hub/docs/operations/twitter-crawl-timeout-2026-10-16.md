# Twitter 账号采集旧链路超时（2026-10-16）

## 已确认的原请求证据

运营者返回 Hub 管理诊断，查询时间为 `2026-10-15T16:07:42.270Z`（北京时间 10 月 16 日 00:07:42）。

| 项目 | 记录 |
| --- | --- |
| Hub request ID | `7c686127-a835-473a-80eb-e14241194c90` |
| 业务 | Twitter `crawl` 账号内容；下游 Run #193832 |
| Hub 请求开始 | `2026-10-15T16:00:15.421Z`（北京时间 10 月 16 日 00:00:15.421） |
| Hub 请求结束 | `2026-10-15T16:00:45.433Z` |
| 请求状态 / 原因 | `unknown` / `night_all_outcome_unknown` |
| 连接器调用 | `d976bba6-b1f3-4ea2-ba17-ed7d9bd657ab`，`crawl` / `twitter` |
| 连接器结果 | `unknown`，`failureKind=timeout`，耗时 `30001 ms` |
| 上游 HTTP / request ID / trace ID | 均未记录 |
| Hub 直连供应商调用 | 当次没有 `providerCalls`；另有明确的 Night-All 连接器调用 |
| 保存的公共响应 | 无，不能重放成功结果 |
| 客户结算 | `unknown` / `enforced`；报价 1 CNY 最小货币单位，已扣 0，尚未结算 |

这份记录明确证明故障发生在 **Hub 等待 Night-All 账号采集的约 30 秒超时边界**。后续相同幂等请求的 HTTP 409 / `request_outcome_unknown` 是这个旧 unknown 的保护响应，不是新的供应商拒绝，也不是 Hub 并发或 RPM 拒绝。

`httpStatus=null` 只表示 Hub 没有记录可用的 Night-All HTTP 响应；不能据此断定 Night-All 没有调用供应商、采集失败、未扣费，或已停止后台工作。这里不能进一步区分 Night-All 处理慢、内部供应商慢、传输或响应体停滞。没有上游关联 ID，也不能把此前的 Twitter 标准搜索或其他 Run 的异常当作本次根因。

客户 `chargedMinor=0` 与 `status=unknown/settledAt=null` 必须同时解读，不能写成已经退款、已释放预占或供应商费用为零。

## 旧入口与 Hub 直连入口

源码中 Twitter 的旧账号入口仍转到 Night-All：

```text
POST /api/v1/night-all/search/crawl
POST /api/v1/search/crawl
```

两条别名使用同一个旧合同与幂等路径。旧账号资料入口同样保留。它们不因 Hub 已实现新的 social API 而自动改变执行方。当前诊断 JSON 未暴露原 URL，无法区分两条旧 HTTP 别名；连接器证据已足以确认这笔走了旧执行链。

已经实现的 Hub 账号直连入口为：

```text
POST /api/v1/data/social/crawl
POST /api/v1/data/social/user-info
```

Twitter 在新入口内使用 Hub 的 RapidAPI 账号解析与内容流程；其他平台按已审阅的固定合同执行。参数、平台授权、操作 capability、返回字符串字段和分页规则见 [账号接入指南](../integrations/social-account-migration.md)。`/api/v1/data/search` 是关键词内容搜索，不能直接代替账号 `crawl`。

按用户此前要求，旧转发入口继续保留，不在本事故中透明改为 Hub 直连。切换须落在调用方，并确认实际生产已发布新的 social 实现、原 Key 具有所需 capability、内部操作和采购配置可用。源码支持不代表已完成生产部署或供应商线上验证。

## 修复与恢复边界

1. 在调用方将后续账号内容和资料请求切到上述 social 路径，继续保留原平台与账号参数；核对 `raw_info/raw_data` JSON 字符串和 `page/pageInfo` 解析。
2. 新遍历从第一页开始，后续只使用新接口返回的 Hub 游标；不把旧 Night-All 游标转成 social 游标。页大小与筛选条件保持一致，每一页使用独立幂等标识。
3. **不能用更换 URL、幂等键或自动创建新 checkpoint 来重试这笔 unknown。** 切换路径不代表原请求已终止或可免费重做。保留原请求关联，先处理原任务状态和可能的重复费用；不要因第 1 步部署而自动重跑旧未决任务。
4. 下游遇到 `request_outcome_unknown` 应保存原 request ID 并进入待核对状态，不通过普通瞬时错误重试策略不断重发。当前 Twitter 人工重试能力只覆盖 `/api/v1/data/search` 的标准搜索，不支持这笔旧 `crawl`。

当前仓库的 `NightAllAdapter`、环境示例、Compose 和 K8s 发布默认超时均为 60000 ms。原记录在约 30000 ms 到达超时；实际生产镜像、配置和 Night-All 服务日志尚未读取，不能声称当前源码默认值已在生产生效。盲目放宽 Hub 并发、清除 unknown 或全局提高超时都不能证明原请求恢复。

本轮确认的是故障层和迁移位置；调用方项目目录尚未提供，未修改其调用、任务恢复或 checkpoint。未部署、未发起供应商查询、未修改原账本和 MX-H2I 登录/联网功能。

## 2026-10-16 源码复核与现场检查

以上表格来自仓库已保存的运营者记录，本次没有重新读取生产数据库。截图的开始/完成时间相差 30.012 秒，与已保存的 connector `timeout/30001ms` 一致。

### 下游合同与时间预算

| 层 | 当前源码行为 | 本次可确认的边界 |
| --- | --- | --- |
| 调用方 → Hub | Luopan 的 `po-infra/llm/data_query.py` 固定拼接 `/api/v1/night-all/search/{operation}`，`search_crawl` 映射为 `crawl` | 当前源码确定使用旧入口；生产原请求的账号参数与镜像版本仍需现场证据 |
| Hub → Night-All | `NightAllAdapter.legacySearch` 向 `POST /api/v1/search/crawl` 发送经 Hub 校验/分页解包的 body，并附加 Hub 配置的 `businessId` | 与 Night-All `routes/v1/search.js` 注册路径匹配；不是 `/api/data/crawl` |
| Night-All crawl 合同 | 必须有业务身份、平台及账号标识；`count=20`、`page=1` 合法 | 账号内容采集与关键词搜索不同，不能用 `keyword` 替代 `username/userId/uid` 等账号标识 |
| Night-All Twitter | 默认 RapidAPI；数字 ID 使用 `/user/{id}/tweets`，用户名使用 `/user/-1/tweets?username=...` | 实际选择仍需生产请求/供应商证据，源码默认不能证明原请求采用了该分支 |
| 时间预算 | `rapidapi-twitter-pagination.js` 同步预算默认 170000ms，子进程通常至多约 165000ms；Python `GetUserContent.py` 单次 HTTP 30s、最多尝试 3 次 | 30s 外层截止可能先于下游结束；把 Hub 改成 60s 也不保证覆盖全部下游工作，不能盲目全局延长或声称恢复 |

Hub 的请求中断不提供 Night-All 任务已取消的证据。Night-All 本身已有内部重试，不能再叠加 Hub/调用方自动重发来处理 unknown。

### Luopan 调用方已定位

用户本次确认 Agent 属于 Luopan。沿前端 `po-frontend/src/features/Portrait/usePortraitAnalysis.js` 的 `/api/portrait/add`、`/api/portrait/delta/add` 定位到 Java `po-backend-java` 的 Portrait 入口；截图中 `data_query.hub_legacy_request_failed`、`phase=data_query_init` 和 `agent_health_check` 的具体实现位于 `/Users/qpjoy/workspace/mingxi/po-infra`。

- `llm/data_query.py:21` 默认 HTTP 超时 90 秒，但 `llm/skill_runtime.py` 会传入 Skill 版本/运行配置的超时，不能把默认值当成 Run #193832 的实际配置。
- `hub_legacy_search_data()` 发送 Bearer Key 与 `Idempotency-Key`，剥离调用方业务身份，由 Hub 已认证 consumer 的 `businessId` 控制下游身份。`count/page/账号标识` 的静态转换与旧合同相容；原账号值和线上实际请求仍未读取。
- `llm/skill_runtime.py:1106` 使用 checkpoint、页号、游标和归一化 body 生成稳定幂等键。异常不会推进页号/游标；同一 checkpoint 再执行应得到原 unknown 的 409。
- 通用任务错误分类会把部分 502/timeout 作为可重试错误，截图中的 409 不属于该类别；网络路由层也可能在传输异常时使用同一键换出口。当前源码没有在上述通用分类处专门处理 Hub unknown，因此后续应将其作为待核对状态处理。是否实际发生自动重试及次数，仍需读取原 Run/SkillRun，不能从单张 409 截图推断。

本次未修改 Luopan/po-infra、Java 后端或 Night-All；也未将旧任务自动迁移到新 social 路径。

需要确认自动重试时，在 **po-infra 数据库**用现有运维入口执行以下投影（不要误连 Hub/Night-All 库）：

```sql
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '3s';
SET LOCAL lock_timeout = '1s';
SELECT id, status, queue_name, attempt_count, max_attempts,
       retry_of_id, resume_from_run_id
FROM llm_agentrun WHERE id = 193832;
SELECT id, attempt_number, status, started_at, finished_at,
       error_message LIKE '%request_outcome_unknown%' AS outcome_unknown,
       error_message LIKE '%status=502%' AS contains_502,
       error_message LIKE '%status=409%' AS contains_409
FROM llm_agentrunattempt WHERE run_id = 193832
ORDER BY attempt_number LIMIT 20;
SELECT id, alias, status, duration_ms, started_at, finished_at,
       request_meta->>'mode' AS mode,
       request_meta->>'action' AS action,
       request_meta->>'operation' AS operation,
       request_meta->>'timeout_seconds' AS recorded_timeout_seconds
FROM llm_agentskillrun WHERE agent_run_id = 193832
ORDER BY started_at, id LIMIT 30;
ROLLBACK;
```

此查询不回传原始错误正文、URL、账号、输入或请求头；生产 schema 不兼容时停止，不为诊断自动迁移。po-infra 仓库使用 Docker Compose，不能据此猜测服务器的 K8s namespace/deployment。

### 第一轮：运行中的 Public Pod 与当前连通性

在有 `kubectl` 权限的服务器上，将本次新增的诊断脚本复制到服务器 Hub 项目目录后执行，无需发布 Hub；也可复制单文件到任意目录并用绝对路径运行：

```bash
bash scripts/diagnose-night-all-crawl-runtime.sh
sudo ss -ltnp '( sport = :13141 )'
```

脚本仅输出 Public Pod 镜像身份、节点、hostNetwork、重启次数、实际进程环境中的超时、ConfigMap 当前超时、源码摘要，并向配置的 Night-All 发一个有 5 秒截止的 `GET /api/v1/health`。不调用 crawl/search、不输出 Token、数据库地址或响应正文；不更改配置、重启服务或结算。当前配置/健康结果不代替历史证据。

若环境仍为 `NIGHT_ALL_TIMEOUT_MS=30000`，说明当前运行 Pod 仍使用显式旧值；更新源码默认值不会覆盖它。若 ConfigMap 与 Pod 不同，先核对原部署环境文件与生效方式，不能只改 ConfigMap 后假定正在运行的进程已更新。若 13141 拒绝连接，先确认原服务的管理方式与实例身份；Night-All 此目录没有对应 K8s deployment，不能猜一个名称重启。

### 2026-10-16 第一轮现场回执

用户已返回以下生产输出：

| 项目 | 现场值 |
| --- | --- |
| Public Pod | `mx-insight-hub-public-c4f85779b-xb45l` |
| Node / hostNetwork | `mx-internal-server` / `true` |
| imageID | `sha256:4b8d5a107698fad29007a56657e693c27591796ff73955b27b50c8365d15b01b` |
| Pod `NIGHT_ALL_BASE_URL` 的 origin | `http://127.0.0.1:13141` |
| Pod / ConfigMap `NIGHT_ALL_TIMEOUT_MS` | 均为 `30000` |
| 当前 13141 监听 | `node`，PID `913534`，`*:13141` |

这确认了当前部署仍显式使用 30 秒，与保存的原请求 `30001ms` 超时相符。源码的 60 秒默认值不会覆盖该环境值；不能仅重建镜像就认为超时已更新。Pod 与 ConfigMap 值一致，当前没有“ConfigMap 已改、Pod 未重启”的证据。`scripts/manage.sh` 发布会从部署环境（通常 `.env.internal`）生成这个字段；其具体来源文件尚未读取。

当前监听只证明端口有进程，尚未证明 HTTP 健康、供应商可用或故障时也正常；这个镜像摘要也尚未映射到源码提交。下一步读取该 Night-All 实例的原调用账本，确认 30 秒以后是成功、明确失败、仍在运行还是缺少证据。不更改全局超时、重启实例或重试原 unknown。

已提供单文件 [diagnose-night-all-crawl-history.py](../../scripts/diagnose-night-all-crawl-history.py)。将此文件复制到服务器 `/tmp/diagnose-night-all-crawl-history.py`，在 `mx-internal-server` 宿主机执行：

```bash
sudo python3 /tmp/diagnose-night-all-crawl-history.py 913534
```

脚本核对 PID 的进程身份、项目、网络/挂载命名空间和启动标识，仅在内存提取启动环境中的 `DATABASE_URL`；通过该 Node 可执行文件和项目的 `pg` 依赖运行下面固定窗口的只读查询，不加载业务模块、不输出连接串/原始 stderr、不请求供应商。默认总截止 20 秒，数据库连接/SQL 分别有更短截止。若启动环境中没有连接串或进程/namespace 不匹配，输出明确错误后停止，不自动改读其他实例或配置文件。此连接来源对应当前实例启动环境，不单独证明事故时的数据库配置相同。

后续用户执行旧脚本，在第 76 行 PID 参数检查遇到 `AttributeError: 'str' object has no attribute 'isascii'`。此异常发生在读取 `/proc` 和启动 Node 之前，尚未查询数据库，不能作为下游失败证据。已修复 Python 3.5+ 兼容：ASCII 数字逐字符检查、旧版严格路径解析、显式字符串路径，以及 `universal_newlines/stdout/stderr` 替代 Python 3.7 的 `text/capture_output` 参数。原进程校验、只读 SQL、超时及输出过滤保持不变。Python 3.5 语法检查和 11 项旧接口约束模拟检查通过（含完整模拟进程到 subprocess、非 ASCII PID 拒绝、缺失路径拒绝和敏感值不输出）；本机没有 Python 3.5 解释器，未声称真实旧解释器/服务器执行通过。运营者需用修正版覆盖该单文件后重跑，无需升级服务器 Python 或发布应用。

### 第二轮：Night-All 保存的原调用结果

在 **实际 Night-All 服务使用的数据库**执行以下只读 SQL。注意这不是 Hub 的 mx-common 数据库。使用原有数据库运维入口即可，不输出连接串。事务和查询都有超时；只读取固定字段，无账号、请求正文、响应正文或任意错误文本。

```sql
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SELECT id, request_id, endpoint, platform, provider, status,
       http_status, duration_ms, result_count, upstream_call_count,
       error_code, created_at, finished_at,
       request_params->'__traceContext'->>'traceId' AS trace_id
FROM public.data_api_requests
WHERE created_at BETWEEN '2026-10-15T15:59:45Z'::timestamptz
                     AND '2026-10-15T16:01:00Z'::timestamptz
  AND endpoint = '/api/v1/search/crawl'
  AND (platform = 'twitter' OR platforms @> ARRAY['twitter']::text[])
ORDER BY created_at, id
LIMIT 31;
ROLLBACK;
```

结果只标识**时间窗口内的候选调用**，不能因为只出现一行就认定属于这笔 Hub 请求；31 行表示窗口可能截断。旧版本未向 Night-All 发送 Hub UUID，直接按 `7c686127-a835-473a-80eb-e14241194c90` 查不到不代表没执行。需要用候选 trace ID、原业务身份、账号与页参数在管理员本地核对。

候选 `trace_id` 可用于查 Night-All 的 `unified_crawler_started/finished/failed` 日志，观察范围延至 `2026-10-15T16:04:00Z`（北京时间 10 月 16 日 00:04）。分享时只保留时间、事件、requestId/traceId、timeoutMs、durationMs、itemCount、错误代码；不要回传完整 stderr、配置或业务正文。Night-All 当前 `context.fromInput()` 可能覆盖继承的 requestId，但 traceId 保留，因此不能只 grep Hub UUID。

Night-All 的 HTTP 访问日志仅在响应 `finish` 时写入；Hub 提前断开时可能没有访问日志。请求表没有行也可能是审计写入失败/查错实例/时间窗口不匹配，均不能证明供应商未调用。`upstream_call_count` 是该服务记录值，不是供应商账单的逐次结算证明。

### 2026-10-16 第二轮现场回执与临时修正

用户已成功执行兼容修正版脚本，返回 `revision=night-all-crawl-history.v1`、`databaseSource=process_exec_environment`、`stage=complete`。窗口内共 6 条 Twitter `/api/v1/search/crawl` 记录，均为 `provider=rapidapi`、`status=success`、HTTP 200、`upstreamCallCount=1`、`errorCode=null`，没有截断。其中 3 条耗时分别为 37.853、31.525、41.526 秒，超过当前 Hub 30 秒等待上限。

与原请求最吻合的候选为：

| 项目 | 现场值 |
| --- | --- |
| Night-All 记录 ID | `c22da661-4ed3-4343-8780-9a88628bfb98` |
| Night-All requestId | `req_mv9q65om_013799a7` |
| Night-All traceId | `2d4eb008a9836fcf4d6ad2c050ca6828` |
| 开始 / 完成（UTC） | `2026-10-15T16:00:15.431Z` / `2026-10-15T16:00:46.956Z` |
| 请求 count / page | `20` / `1` |
| 结果 / 耗时 | 成功，20 条，`31525ms` |

该候选比 Hub 原请求开始晚 10ms，比 Hub 记录超时结束晚 1.523 秒，数量与页码一致。因此“Hub 等待时间短于下游实际完成时间”已有强证据；但 `hasIdentity=true` 仅表示存在账号输入，未验证其值、业务身份或完整请求。脚本仍明确标记 `candidates_not_confirmed_identity`，不能将此候选直接登记为 Hub 原请求成功、交付或结算证明。其他窗口内记录也不能据此判定为同一任务的重试。

对后续新请求，建议先把线上显式 `NIGHT_ALL_TIMEOUT_MS=30000` 恢复为本仓库现有默认 `60000`。60 秒覆盖本轮观测的 31–42 秒成功耗时，但不是成功保证，也不是 Night-All 最长 170 秒同步预算的完整适配。后续应观察新请求耗时与错误率，结合实际 Agent Skill 超时决定是否需要专用 crawl 预算或异步执行。

生产变更步骤（由运营者执行，本地尚未执行）：

1. 在服务器 Hub **实际部署目录**的 `.env.internal` 中将唯一有效定义改成 `NIGHT_ALL_TIMEOUT_MS=60000`，不要回传整个文件。`manage.sh` 会直接加载它；只在命令前设置同名环境变量可能仍被文件内旧值覆盖。此修正不需要执行完整 deploy/apply，也不需要迁移数据库或发布本地代码。
2. 查询实际租约，预期 `reservationLeaseMs=180000`。若为空或其他值，先核对该镜像生效的默认值与租约余量，不直接扩大预算。同时核对 Luopan 原 Agent Skill 的实际 `request_meta.timeout_seconds` 应大于 Hub 等待时间；helper 默认 90 秒、seed 120 秒均不能代替生产值。

   ```bash
   kubectl -n mx-insight-hub exec deployment/mx-insight-hub-public -c api -- \
     node -e 'console.log(JSON.stringify({timeoutMs:process.env.NIGHT_ALL_TIMEOUT_MS || "unset",reservationLeaseMs:process.env.MX_INSIGHT_RESERVATION_LEASE_MS || "unset"},null,2))'
   ```

3. 等在途采集结束，在低流量时执行以下条件更新和仅 Public 的重启。仓库清单为单副本 `Recreate`/hostNetwork，重启会短暂中断 Hub 数据 API；默认终止宽限可能不足以等待仍在采集的请求。下面用子 shell 的 `set -eu` 保证前一步失败后不继续重启；若配置已不是 `30000`，条件更新停止，应先查看当前单字段值。

   ```bash
   (
     set -eu
     kubectl -n mx-insight-hub patch configmap mx-insight-hub-config --type=json \
       -p '[{"op":"test","path":"/data/NIGHT_ALL_TIMEOUT_MS","value":"30000"},{"op":"replace","path":"/data/NIGHT_ALL_TIMEOUT_MS","value":"60000"}]'
     kubectl -n mx-insight-hub rollout restart deployment/mx-insight-hub-public
     kubectl -n mx-insight-hub rollout status deployment/mx-insight-hub-public --timeout=180s
     kubectl -n mx-insight-hub exec deployment/mx-insight-hub-public -c api -- \
       node -e 'console.log(JSON.stringify({timeoutMs:process.env.NIGHT_ALL_TIMEOUT_MS,reservationLeaseMs:process.env.MX_INSIGHT_RESERVATION_LEASE_MS || "unset"},null,2))'
     kubectl -n mx-insight-hub get pods -l app.kubernetes.io/name=mx-insight-hub-public \
       -o 'custom-columns=NAME:.metadata.name,IMAGE_ID:.status.containerStatuses[*].imageID'
   )
   ```

4. 验证实际进程值为 `60000`、租约仍有余量、Pod 就绪，并比对 `imageID` 是否仍为第一轮记录的 `sha256:4b8d5a107698fad29007a56657e693c27591796ff73955b27b50c8365d15b01b`。当前清单使用本地可变 `shadow` tag/`imagePullPolicy: Never`，重启不能单独证明代码版本未变。变更前应由运营者确认没有其他镜像替换作业；如摘要不同，先定位版本再判断结果。

该 ConfigMap 还被其他 Hub 进程消费，但环境变量在启动时读取。本次仅重启 Public 修正公共兼容 crawl 路径；Admin/worker 将在后续正常重启时采用新值。不修改或重启 Launcher、MX-H2I 登录/联网组件，也不改 Night-All 出口。保留旧 `7c686127-a835-473a-80eb-e14241194c90` 的 unknown 和原幂等键；此次配置修正不会恢复旧任务、补回原响应或消除原请求的 409。恢复旧任务仍需核对账号、业务身份、已存结果和结算证据。

### 租约回执与截图 merge 审查

随后用户返回实际 Public 环境 `timeoutMs=30000`、`reservationLeaseMs=180000`，确认当前租约可容纳上述 60 秒等待修正；尚未收到配置修改或重启完成回执。用户同时要求检查 merge `35381ae747d87fccb3da2726075124c963571f89` 是否覆盖之前的超时修改。

历史树核对结果：

| 提交 | 与 Night-All 超时有关的变化 |
| --- | --- |
| `a2bad6253c7c535840d1f3d6e31c909a0c9173a0`，2026-09-16 | runtime config、部署脚本、Compose 与示例默认从 30 秒升到 120 秒；默认租约从 150 秒升到 180 秒。Adapter 独立构造默认仍为 30 秒。 |
| `6ac79401233c8aeecd8d6ee64b9b816b5ab75c11`，2026-09-23 | 上述默认从 120 秒调整到 60 秒，同时 Adapter 独立默认从 30 秒统一为 60 秒；用同一截止时间覆盖响应头与完整正文，加入 6 项回归测试。 |
| 两个 parent `66f89e24` / `c70c3211` | runtime config、Adapter、部署脚本、Compose、示例均为 60 秒。 |
| merge `35381ae` | 保留上述 60 秒；相对第二 parent，这些文件与 timeout 测试完全无 diff。相对第一 parent，相关改动只是凭据迁移说明/部署逻辑，不改超时。 |
| 后续 `0416ccb4` / `a3157dcb` | 只修改 DataPort 部署或权限/session 文件，没有修改 Hub timeout。 |

两个历史超时提交均为 merge 的祖先。结论是该 merge **没有丢失或回退 Night-All 超时修改**；120 秒改为 60 秒发生在此前的明确提交中。此审查仅覆盖本次 timeout 链路，不代表整次 merge 的全部业务功能经过验证。

在临时目录导出 merge 的原始 `server`、`shared` 与 timeout 测试，复用本机已安装依赖，6 项模拟计时测试全部通过，无网络访问。直接运行该历史版本 `loadConfig` 得到：未设 `NIGHT_ALL_TIMEOUT_MS` 时 60000，显式 30000 时 30000，显式 60000/120000 时各自生效；这四种配置的默认租约均为 180000。临时目录已清理，未修改工作树业务代码或生产配置。

merge 中 `manage.sh` 仍会读取 `.env.internal`，按 `${NIGHT_ALL_TIMEOUT_MS:-60000}` 写入 ConfigMap；`.env.internal` 被 Git 忽略，不会随着 merge 自动同步 `.env.example` 的值。因此生产 30000 不能由该 merge 对源码默认的回退解释，应继续检查服务器部署环境的显式定义或历史配置。尚未读取服务器 `.env.internal` 的该字段，不能断言具体由哪个文件/操作写入 30000；镜像摘要与提交的映射也仍未确认。

### 同一 Run 的 Skill 502 与后续 409，以及罗盘重试分类修复

用户补充同一 Run #193832、同一 checkpoint、同一 Hub request ID 的 Skill 告警：`status=502`、`upstream_outcome_unknown`、`duration_ms=30161`、`phase=checkpointed_hub_legacy_search`、`skill=data_query`、`version=7`。其“当前进度”仍为 `409 request_outcome_unknown`。前者是约 30 秒后收到的原未知结果响应，后者是原幂等请求处于 unknown 时的保护响应。Skill 总耗时与 Hub 30001ms 连接器超时一致，不能把 30161ms 当作调用方配置的 timeout。Skill version 7 也不是人物画像 Agent 的版本号。

这张截图没有提供新的 request ID 或新的生产配置证据，不能认定为 60 秒调整后的新超时；也无法单独区分自动重试、人工重试或恢复任务。Hub 在 unknown 分支就返回 409，不再次派发 Night-All。

罗盘调用方当前源码另有可复现的重试分类问题：`po-infra/llm/result_errors.py` 泛匹配 502，因此原 unknown 会被标为可重试，影响外层模型 fallback 和任务重排。人物画像 v144/v145 还各有独立的 Skill 重试循环，已支持异常 `retryable=False`，但原异常未携带该标记。只修外层判断不足以阻止内部重试；只禁止重试而不保留嵌套错误提取，又会把部分 409 错误漏判为成功。

本地已修改 `/Users/qpjoy/workspace/mingxi/po-infra` 的三个运行文件与两个回归测试文件（未提交、未部署）：

- `llm/result_errors.py`：精确匹配本程序 `data_query.hub_legacy_request_failed` 包装及 Hub `error.code` 的两个 unknown 值；优先判为不可重试，顶层与嵌套结果仍识别为失败。不以单独的 unknown 文案或 HTTP 状态误触发。
- `llm/data_query.py` / `llm/skill_runtime.py`：仅上述错误的 `DataQueryAPIError` / `AgentSkillError` 设置 `retryable=False`，包含 checkpoint 两次异常包装；现有 v144/v145 内层判断直接使用该标记，不改已保存 Agent 版本代码。普通暂态错误不新增此属性，原重试策略保留。
- 新增纯分类回归与 Persona 原参数调用次数测试，保留原 requestId、异常文本、分页/幂等键及历史任务记录。

验证：7 项纯 `unittest` 通过；通过实际异常类及 AST 提取的 v144/v145 内部重试函数完成 16 个离线场景（两种 unknown、原异常/两次包装均只调用一次，普通 502/timeout 仍按原规则尝试 3 次），没有数据库或网络访问。当前 Python 缺少 Django/Celery，完整 Django Persona 集成测试尚未执行，应在调用方正常测试环境补跑 `python manage.py test llm.tests_result_errors llm.tests_persona_hub_checkpoint`。本次五个文件的差异格式检查通过；该仓库原有两个 spider 文件的无关修改保持不动。

调用方补丁须在实际执行人物画像的 po-infra worker 发布后才会生效。它负责停止未知结果的自动重试，不恢复旧 Run 或写回 Hub 成功，不替代 Hub 60 秒配置修正。旧请求恢复仍需精确关联已取得的下游数据和结算证据；当前管理台 Twitter 标准搜索重试入口不适用于这笔 legacy crawl。

### 用户更新 Luopan 后的重新核对

用户表示 Luopan 代码已更新。本机 reflog 确认 `/Users/qpjoy/workspace/mingxi/luopan` 于 2026-10-16 01:14:08 +0800 从 `a4fc3b9` fast-forward 到 `dbd7b64`。对这个实际更新范围的审查发现，Portrait 三个文件仅调整历史/结果展示、页面布局及打开另一任务时清空残留结果；另有共享 `useAgentOutputTab.js`。没有改变 `usePortraitAnalysis.js` 的请求路径、超时、重试、幂等逻辑，`portraitTaskState.js`、`portraitBatchClient.js`、`boot/api.ts` 和 router 在该范围没有变化。

当前前端账号画像仍调用 `/api/portrait/add`，文件画像走 `/api/portrait/delta/add`；刷新/打开历史只读取进度，失败终态停止轮询。显式覆盖操作才调用 `/api/portrait/restart`，前端保留画像 taskId 不证明后端复用同一 Agent Run。已有批量创建的 request_id 与 Hub requestId 属于不同层级，不能据此前者认定 Hub 旧 unknown 已恢复。状态、批量恢复及结果 tab 的 18 项现有本地测试通过，没有真实 HTTP/供应商调用。

与此同时，本地 Java 后端仍为 `/Users/qpjoy/workspace/mingxi/po-backend-java` 的 `e86be9c0`（9 月 30 日），Python Agent 后端仍为 `/Users/qpjoy/workspace/mingxi/po-infra` 的 `5f1d29a`（9 月 24 日）；后者的本轮五个 llm 修复文件仍未提交。没有从本地版本信息得到这两个后端已更新/生产 worker 已发布补丁的证据。`luopan/po-backend` 是发布/客户端配置管理服务，不是新的画像 Agent 后端。此轮不拉取/合并远端，不修改调用方源码，保留所有工作区修改；若用户更新的是其他后端目录或远端分支，需要用其实际路径/提交继续审查。

截图来源还有一个限制：`po-infra/llm/health_checks.py` 定义 `HEALTH_CHECK_UID=agent_health_check`，健康检查创建 Run 时设置 `trigger_source=system`、`input_params._health_check`、`max_attempts=1`。正常 Java `DeltaAgentServiceImpl.runByKey` 则写入数字 userId。这支持该截图来自人物画像 Agent 健康检查的推断，尚未读取 Run193832 的这些字段作最终确认。若生产也为 `max_attempts=1`，外层 Celery 达到次数后不会重排；相同 checkpoint 的 502→409 更符合画像内部 Skill 重试等路径，不能据截图断言外层自动任务重试。此前发现的通用 502 分类漏洞仍然存在于未修复代码，修复同时覆盖当前 Persona 内层异常标记，但其实际触发层和生产 Agent 版本仍须区别。

### 按现场证据选择修复

- 下游后来成功：优先核对已存结果与费用，再决定原任务如何恢复；保持旧 unknown，不改账本来伪造交付。
- 下游报供应商超时/代理错误：依据同 trace 的内层错误修复 Night-All 对应出口/供应商，不调整 Launcher、WireGuard、DNS 或 MX-H2I 用户网络。
- 旧路径仍有业务调用：先核对完整超时链（调用方/反向代理 → Hub → Night-All），不能仅按平均耗时扩大一个全局超时。
- 后续业务迁移到 `/api/v1/data/social/crawl`：按上文迁移约束验收生产 readiness、原账号与分页/返回字段；保留旧入口和旧任务状态，不自动重跑这笔请求。

本次本地修复仅补调用关联：新请求向 Night-All 传递 Hub 账本生成的 UUID；已收到响应头后发生正文超时/无效响应时，仍保存已观察到的关联证据，同时维持 unknown。未收到响应头时不把发出的 UUID 伪装成已收到的下游确认。此修复不能补回历史缺失证据，也不证明生产采集恢复。

定向回归 103 项通过、1 项既有真实 PostgreSQL 条件跳过；typecheck 与差异格式检查通过。覆盖正文超时、响应头前超时、无效成功正文、实际 HTTP 200/503 仍为 unknown、诊断持久化失败不改变结算/响应、Public 不泄露内部证据、Admin 可见关联与原请求重试零新增派发。运行环境脚本通过语法检查及 5 个模拟 kubectl 场景（成功/超时/拒绝连接/不安全地址/多 Pod），没有生产访问或部署。
