# 2026-10-17：v2 入口 404 与 Delta Facebook 保护

## 2026-10-18：入口打通后的 Twitter 409

用户部署后回传了另一条告警：策略 `6905bd48-7324-4602-9c06-4b77994f93d9`、Run `65a9f174-e611-4032-a759-fb64efcb540e`，Twitter 第一页返回 JSON `409 request_outcome_unknown`，`error.details.requestId=8ebd9f58-f6b6-4f8a-b8fe-db94c1068c09`，`automaticRetryAllowed=false`。这已证明该次请求到达 Hub；不是之前的 nginx HTML 404。

告警的英文消息 `A search outcome is unresolved; changing API version, key, window or cursor cannot authorize another acquisition` 来自 `SearchProtocolStore.begin()`，在本次调用执行底层搜索之前抛出。因此被拒的这次尝试没有开始新的供应商调用。这里的 `details.requestId` 是保护逻辑返回的既有 usage 身份，不能当作本次新采购 ID；若未来告警只有顶层 `requestId`、没有 details 中的 durable ID，则还可能只是 HTTP correlation ID。

仅凭告警无法区分：原供应商结果未知、底层采集已提交但 v2 投影/落库未完成、进程退出留下过期租约，或本次未采购但承接了另一请求的未知状态。`usage.status=committed` 不证明 v2 交付已确认，`released` 也不单独授权解锁。混合显示 `+08:00` 和 `+00:00` 的合法时间戳不构成时间窗错误证据。

### 原请求回执已确认

用户先后回传 v2、`twitter-outcome-diagnostic.v3`。该 ID 为 `unknown`，预留于 **2026-09-15 09:01:11.047 UTC**，完成时间为 **09:01:41.061 UTC**（北京时间 17:01，间隔 30.014 秒）；`requestPath=null`、无 saved HTTP status，供应商调用、gateway、协议 binding 和 lease 列表都为空，无截断。协议表均存在。回执中的 Admin 运行文件哈希对应本次修复前的源码，不证明历史 Public 实例版本。

该次返回的阻断身份已明确指向 9 月 15 日的旧 unknown；按当前已核对代码，对应**同 tenant/consumer/API Key/Twitter 下，历史 usage 缺少路径而产生的平台级保守阻断**，本次尝试尚未进入新采购/投影。该旧请求不能凭年龄认定失效，也不能认定其原查询就是“台湾”。这里只查了该旧 UUID 的关联 binding/lease，空列表不代表其他请求没有阻断；核对这一条后仍须经过完整保护检查。

历史代码解释了缺失字段：`094_acquisition_request_snapshot.sql` 于 9 月 17 日增加正文快照且明确不回填旧记录；9 月 15 日前的标准搜索直接调用 Night-All，不记录现在的 provider call/gateway，且当时标准分支也不记录 connector call。空表不能证明未执行、未扣费或可以重试。v2 诊断的 `errorCode=other` 只是白名单投影占位值；后续 v3 已补查真实旧错误码。

v3 回执明确：usage 的 `errorCode=night_all_outcome_unknown`、`billingMeterKey=raw`、`capability=null`、整个 acquisition 快照和 body 均不存在；关联唯一 connector `75b0d57a-1f3d-4967-82df-63bf7bb673c1` 的 `operation=raw`、`outcome=unknown`、`failureKind=timeout`、`sourceMode=live`，平台和指纹与 usage 匹配，等待 30001 毫秒后超时，无 upstream request/trace ID。由此可以恢复**旧 raw 操作身份**，仍不能恢复其查询或判断 Night-All 下游是否扣费。`queryEqualsComparison=null` 表示没有可比较的正文，不能推断它与“台湾”是否相同。

### 修复：恢复已有的 raw / 标准搜索操作边界

标准 v1/v2 保护原本只覆盖标准搜索；已保存 `/api/v1/night-all/search/raw` 或旧 `/api/v1/search/raw` 路径的记录不会进入标准历史阻断。问题是快照引入前的 raw 缺少路径，被当成无法确定范围的标准 unknown。本次在 `SearchProtocolStore` 的内存与 PostgreSQL 实现中，仅对完整一致的旧 raw 证据恢复这个既有边界：

- usage 必须为 `unknown`、整个 acquisition 快照为空、capability 为空、计量项为 `raw`、指纹为合法 64 位小写十六进制 SHA256。
- 关联 usage 的 connector 必须有且仅有一条，其 operation/outcome 为 `raw/unknown`，consumer、平台、指纹全部匹配。
- 任一证据缺失、矛盾、多行、仍在 `reserved`、快照只缺部分字段、明确为标准路径，均继续保守阻断。数据库读取失败也不放行 v2。
- 只排除该条记录对标准搜索造成的扩大阻断，不修改历史 usage/connector，不结算、不清 unknown、不补猜测的 query/path。原 key 仍属于旧请求，v2 复用原 key 仍冲突；其他标准 unknown、binding 和 lease 继续逐项检查。

因此修复不依赖请求年龄，也不是按平台统一忽略旧 unknown。它不证明这条旧 raw 的查询与新搜索不同；它恢复的是已有 API 操作隔离。若以后找回旧标准请求体，必须按历史算法验证完整指纹；单纯 hash 不同不能证明 query 不同。

使用更新后的 `server/ops/diagnose-twitter-outcome.mjs`（输出版本 `twitter-outcome-diagnostic.v3`），在有本地脚本且可访问 Hub 集群的终端、Hub 源码目录执行：

```sh
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - 8ebd9f58-f6b6-4f8a-b8fe-db94c1068c09 --compare-query '台湾' \
  < server/ops/diagnose-twitter-outcome.mjs
```

脚本从 stdin 执行，无需重建镜像。它在一个 `REPEATABLE READ READ ONLY` 快照里读取该 UUID 的 usage、供应商调用/归档元数据和关联的 v2 binding/lease，始终 rollback，不发 HTTP、不查询会回收租约的 Public 状态接口。只输出状态、错误码白名单、时间、归档存在性和哈希；不输出关键词、幂等键、游标、凭据或响应正文。binding 同时按原 usage ID 或同租户/consumer/API Key/平台/幂等键关联，以覆盖 `finish` 尚未写入 usage ID 的情况；兼容协议表尚未部署的旧数据库。

诊断中的底层 `requestPath=/api/v1/data/search` 也可能由 v2 内部调用产生，不能据此认定 Delta 降级。历史路径缺失会明确标注，已知非搜索路径仍拒绝；无关联记录、旧表缺失或列表截断都不代表允许重试。运行文件哈希仅表示诊断容器当前代码，不证明历史 Public 实例版本。

恢复必须依据原请求证据：确有供应商 unknown 时继续保留保护；若底层已成功则核对原交付及投影，不能重新采购来修补；若是派生阻断，须进一步定位原阻断请求，不能仅凭释放状态或无调用行清除 unknown。旧 Twitter v1 的人工重试入口不能用于绕开本次 v2，v2 会拒绝 `X-MX-Insight-Retry-Of`。

本地标准协议回归 **27/27、零跳过**，包含内存、真实 PGlite SQL 和本机 Public HTTP。新增已知 raw 路径对照、缺快照 raw 身份恢复、22 类证据缺失/矛盾、同 key 所有权、跨 v1/v2 running/unknown、其他标准 unknown、缺 connector 表时拒绝执行。原 v3 只读诊断 **10/10、零跳过**，脚本 SHA256 为 `748e6fffb3d7d72c3d7e0d4797fb59ab9bf9b8301fb4b08a8e1ceb0539c0c01b`。未调用线上供应商，未部署或修改历史记录、SSO、Launcher/MX-H2I 登录与联网。

### 发布与原 Delta Run 恢复边界

这是 Hub 运行时代码修复，须发布所有 Public 实例；本次不新增迁移、不需要再次改 nginx。使用仓库现有部署流程，在 Hub 源码目录执行：

```sh
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh ops internal-production deploy
```

明确禁用 Launcher 联动。发布后的无认证 401 只能验证入口可达，不能证明此业务恢复；不要使用真实认证搜索作为探测。

Delta 已把 `409 request_outcome_unknown` 保存为当前 Run 的本地页 unknown，**Hub 发布不会自动解除这个本地阻断**。不能删除标记或新建 Run 绕过；现有手工冷启动重试还可能恢复整个同平台组，不能当成只恢复一个 Run。需要核对原账本、冻结 payload/key、失败 Step、成功页和入库计数，并保留历史证据后决定受限恢复方式。

将最新 `server/ops/diagnose-delta-search-v2.py` 复制到 Delta 宿主机当前目录，执行精确 Run 的只读检查：

```sh
docker exec -i -w /app \
  -e MX_DIAGNOSTIC_PLAN_KEY=6905bd48-7324-4602-9c06-4b77994f93d9 \
  -e MX_DIAGNOSTIC_RUN_KEY=65a9f174-e611-4032-a759-fb64efcb540e \
  -e MX_DIAGNOSTIC_BLOCKER_REQUEST_ID=8ebd9f58-f6b6-4f8a-b8fe-db94c1068c09 \
  delta_59202-worker-1 python manage.py shell < diagnose-delta-search-v2.py
```

输出版本 `delta-search-v2.2`；脚本 SHA256 `49fba5858027793c80cafe0600028fda99ef83b90d0919cd401f2ae6f6ae9362`。只读取属于指定 Plan 的 Run，不输出 query、原 key、cursor 或原始错误，只返回摘要、固定消息匹配布尔、计数及截断标记。`requestDispatched` 只表示 Delta 曾向 Hub 发送 HTTP，不等于 Hub 向供应商发请求；错误文本布尔也不单独授权解锁。诊断 **18/18 测试通过**（模型模拟与入口接线测试，不替代线上 PostgreSQL 验证）。

### Delta 精确回执（2026-10-17 16:47:32 UTC）

用户随后回传了上述检查结果：Plan 和指定 Run 均存在，Run 仍为 failed/cold_start/twitter；当前组为 `9216a18c-0f33-449a-8b46-b27656d8c19e`。只有一个第一页 unknown stream 和一个失败的现代 Step `5df2ee9a-ec1c-4163-92aa-7f55499716e5`，Run block、stream、Step failed request 和唯一 request ID 均指向旧 raw UUID。零成功页、零 Run/Step 计数、零实际 CollectionItem，无 cursor、无截断，固定 409/unknown/准入消息匹配。Hub base 为根路径，不存在 URL 前缀重复。

已核对的原页摘要：

- stream SHA256：`de921845eb613631546a441aed80f0fd04022542a0f5e901c692472e0e0edbe5`
- payload SHA256：`40ba477e6e7b6bbb5c58bdf40c978daa6d03d9bd3931a5637c78f7d2ad5ff43b`
- idempotency key SHA256：`c7ef520abe008e7c8ba0555bdddd496a0b055e37bc37dd97bd0323884afa1c00`

这些证据与 Hub 的固定准入拒绝分支一致，支持将本次原页的失败识别为继承旧 raw 阻断。恢复仍必须在执行时再次核对完整错误结构、原页与 Step 请求一致性和数据库变化；不能将本事故规则推广成通用 unknown 清理。

### 事故专用 Hub 前置核验

恢复还需要 Delta 的任务认领保护：恢复脚本提交数据库后会保留专用等待标记，只有指定 task ID 的 worker 能原子认领并解除；watchdog 入队口不能越过该等待标记。单独同步 stdin 脚本不够，须先更新测试环境的 Web、beat 和全部 worker。

将本次 po-infra 修改同步到已确认的服务器 checkout `/home/lcy/test/Delta/mx_data`，使用其现有 NAS 发布入口。下列命令要求原测试实例 env 文件已存在，避免悄悄生成新环境；脚本通过 NAS release wrapper 保留该项目的存储绑定，不使用裸 Compose 默认项目：

```sh
cd /home/lcy/test/Delta/mx_data
test -f deploy/.env.delta-59202.ghcr && \
  COMPOSE_PROJECT_NAME=delta_59202 bash scripts/deploy_public_ghcr.sh \
    --instance delta-59202 --port 59202 --tag feat-new_delta \
    --local-build --no-pull --no-cleanup
```

这条命令更新 `delta_59202`，不更新共用目录的 `mx_data`。若该服务器采用自定义 `DEPLOY_ENV_FILE`，须沿用原实例文件，不能复制其他实例配置代替。没有新增数据库迁移。原供应商 unknown 和等待中的原 Run 仍保持阻断；完成 Hub 与 Delta 发布后，再生成下面的短期核验回执。

发布后确认使用应用镜像的进程均已替换，以下容器应为本次构建的同一 image ID；不能仅看相同 tag，或用一台 worker 的文件摘要代替整套进程检查：

```sh
docker inspect --format '{{.Name}} image_id={{.Image}} started={{.State.StartedAt}}' \
  delta_59202-web-1 delta_59202-beat-1 delta_59202-worker-1 \
  delta_59202-worker-agent-data-hub-1 delta_59202-worker-agent-interactive-1 \
  delta_59202-worker-agent-short-1 delta_59202-worker-agent-long-1 \
  delta_59202-worker-strategy-draft-1 delta_59202-chat-gateway-1
```

`server/ops/verify-delta-raw-admission-recovery.mjs` 只检查本文固定事故，不能通过 CLI 换成任意请求。在 Hub 源码目录执行：

```sh
kubectl -n mx-insight-hub rollout status deployment/mx-insight-hub-public --timeout=180s
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-public -c api -- \
  node --input-type=module - \
  < server/ops/verify-delta-raw-admission-recovery.mjs \
  > delta-raw-admission-receipt.json
```

当前 Public manifest 是单副本 Recreate；rollout 完成后从 Public 执行，避免以 Admin 的文件版本代替服务版本。脚本要求 Public 的 `search-protocol-store.mjs` SHA256 为 `439490f908a1caf65211cd7e1562c719e05cbe667141cc1d83c164923389713b`。它使用只读事务再次验证原 raw 的完整正向证据，并在同 consumer 的 usage、usage key binding、protocol binding、protocol lease 四处按原页 key SHA256 检查**全部历史**，无日期窗口或抽样截断。

仅当输出 `revision=delta-raw-admission-recovery.v1`、`ready=true` 才继续。原页 key 已存在、证据改变、源码不同、缺表或读取失败都会停止。该回执不是新请求预留，也不替代 Hub 实际准入；关键的未派发证据仍是原 Step 的完整准入拒绝及其原身份，不能仅凭记录不存在解锁。回执不含 key、query、数据库地址或凭据，后续 Delta 脚本还会检查其身份和 30 分钟有效期。

### 原 Run 的受限恢复

`server/ops/recover-delta-raw-admission.py` 固定上述 Plan/Run/Step/组/blocker 及三个摘要，不接受其他事故身份参数。在上面的 Delta 任务保护已发布后，以 Django shell stdin 执行；脚本本身不要求另一次镜像构建。将这个脚本和刚生成的 `delta-raw-admission-receipt.json` 复制到 **Delta 宿主机当前目录**，先预览：

```sh
docker cp delta-raw-admission-receipt.json delta_59202-worker-1:/tmp/delta-raw-admission-receipt.json
docker exec -i -w /app \
  -e MX_RECOVERY_HUB_RECEIPT=/tmp/delta-raw-admission-receipt.json \
  delta_59202-worker-1 python manage.py shell < recover-delta-raw-admission.py
```

默认预览使用只读事务，不导入任务入口，不调用会 `get_or_create` 的运行状态 helper，不发 HTTP、不排队。必须返回 `status=preview_ready`，检查 `followupCount` 和 `previewSha256`。仅原 Run 首次排队，其原有分页、分析和后续任务仍按原业务执行；不是恢复整个冷启动组。

恢复脚本会核对当前容器的 `data_hub/raw_admission_recovery.py` 与 `data_hub/tasks.py`，对应 SHA256 分别为 `725daeb98044678551806048a0318c81f615ad4b35afd068fd219b7203b3a99d`、`4c0afece78b080202eca0eb05f9ef5f79fddd2035362e5f8f4122b5534026d0a`。脚本自身 SHA256 为 `0f2e9f506b1e240464ab0fab15fad42bf67db28ebcd4134f17ab6cf714f0e1cd`。`runtime_recovery_build_required` 表示当前构建不匹配，应核对部署和代码差异，不能直接改常量跳过。

以下命令会**真正恢复采集**，worker 可按原业务访问供应商。将 `<previewSha256>` 替换为同份回执预览输出的值，保持两步之间配置和任务不变：

```sh
docker exec -i -w /app \
  -e MX_RECOVERY_HUB_RECEIPT=/tmp/delta-raw-admission-receipt.json \
  -e MX_RECOVERY_ACTION=apply-and-resume \
  -e MX_RECOVERY_PREVIEW_SHA256='<previewSha256>' \
  delta_59202-worker-1 python manage.py shell < recover-delta-raw-admission.py
```

执行会锁住 Plan、当前 Twitter 冷启动状态、原 Run/Step、运行暂停状态及原 query group，再重新验证所有证据和预览摘要。要求原 Run failed、唯一第一页失败 Step/stream、完整固定准入错误结构、原 Step 与页 payload 完全一致、原查询快照仍生成同 stream、冻结 v2 contract 一致、零成功页/计数/实际条目、当前计划和平台可执行。其他同平台 unknown 仍会阻断并回滚整笔修改。摘要或条件不一致时不能靠改脚本常量、删历史或手工设成功继续。

成功事务只为这条原页记录核对审计、恢复 pending，保留原 key/body/window，保留原失败 Step 和原 Hub raw unknown；以新 Celery task ID 隔离迟到的旧投递。提交时仍保留 `raw_admission_dispatch_prepared` 等待标记，提交后只发布指定 Run 一次，关闭 publisher 自动重试。只有匹配身份的新版 worker 能在行锁内认领并清除这个专用标记；普通 unknown 或已改变的页状态不能被认领清除。数据库不需要迁移，其他 Run、MX-H2I 登录/联网不在修改范围。

`status=published` 只确认此次发布调用返回，不表示采集已完成。`already_recorded_no_publish` 不会二次发布。发布异常可能已经送达：在行锁内记录 `dispatch_unknown`，尚未认领时保留活动保护；已经认领时不覆盖实际 worker 的结果，由原页账本和 Hub 保护继续约束执行。出现该状态或 `manualReconcileRequired=true` 应核对原 task ID，不能换 ID 重发。数据库提交与 broker 发布不是跨系统原子事务；若进程在两者之间被硬终止、审计停留 `dispatch_prepared`，等待标记会阻止 watchdog 替换任务。须人工核对原投递，不能宣称恰好执行一次或凭重跑脚本补发。正常 Celery 同 task ID 重试、同 Run 后续分页仍受原页 key 与 Hub 门禁约束。

恢复后用上一节的精确 Run 诊断复查新 Step、页状态、计数和最新 request ID。若返回新的供应商错误或另一个历史 blocker，按新的原请求调查；不要扩大本次豁免范围。助手尚未在服务器执行上述恢复。

### 本次恢复验证

| 验证 | 结果 | 覆盖与限制 |
| --- | --- | --- |
| Hub 标准搜索协议 | 27/27，零跳过 | 内存、实际 PGlite SQL、本机 Public HTTP；raw 证据范围、同 key、跨版本 unknown |
| Hub 只读恢复前检 | 7/7，零跳过 | 实际 PGlite、stdin 入口、源码门禁、全历史 key 检查、失败回滚和脱敏 |
| Delta 恢复脚本 | 17/17 | 模拟 ORM 事务；原页身份、快照冲突、发布失败、进程退出、重复 apply 与时区/毫秒精度 |
| Delta 精确只读诊断 | 18/18 | 模型模拟和入口接线；不等于线上数据库验证 |
| Delta 新旧采集回归 | 142/142 | 含 17 项认领保护、页账本、冷启动、增量、日报与重试反馈；最小补齐旧测试漏注入的两个依赖 |
| Delta 实际 ORM | 8/8 + 6/6 | 既有保护回归及本次认领/入队适配；真实 Django/SQLite 最小表，不能代替 PostgreSQL 并发测试 |
| 恢复脚本与真实认领 helper 联合检查 | 5/5 | 恢复脚本生成实际 audit/hold，再调用 helper；覆盖发布与认领的两种顺序、真正 unknown 保留、同 ID 重试和中断 |

所有检查使用本地合成数据，未调用线上供应商。线上发布、回执核验和原 Run 恢复仍需执行上述命令；`published` 不代表采集成功。

以下保留 10 月 17 日的历史证据与发布说明。

## 已确认与未确认的边界

用户在 Delta Docker 宿主机无凭据 `POST https://hub.minsight-ai.com/api/v2/data/search` 得到 `HTTP/2 404`、`content-type: text/html`、`nginx/1.30.4`。前面的 `200 Connection established` 是出站代理的 CONNECT 隧道应答，不是 Hub 成功响应。Twitter、Reddit、Instagram 告警与此一致：请求已发出，当前失败在 HTTP 网关路径，尚无到达 Hub v2 业务处理器的证据。

后续用户在 Public pod 内以相同无凭据 POST 探测 `127.0.0.1:18150`，已返回 `401 application/json; charset=utf-8` 与 `error.code=api_key_required`。这确认被探测的已部署 Hub 实例具备 v2 handler；当前公网 404 应优先修复前置网关，不需要为该 404 回退 v1 或重新采购。该探测不等于验证所有副本、租户权限或供应商调用。

`de-mingxi` 的 Domestic 与 Internal Hub vhost 均仅转发 `/api/v1/`，其他路径落入默认 404。初次修复在两层各补精确搜索路径；随后按用户要求扩展为 `location /api/v2/` 通用转发，包含搜索及后续 v2 Public API。真实本机双层 nginx 测试证明，任一层遗漏都能复现 HTML 404。线上具体哪一层仍使用旧配置，需要下面的分段探测定位；不能仅凭 nginx 版本判断机器。

Facebook 的“历史 Facebook 请求尚未核对”来自 Delta HTTP 之前的旧任务保护。已确认代码存在并发误拦：新版 collector 先建 Step，再持久化页账本；同计划兄弟 Run 在这段间隙被视作历史请求。补丁只排除能证明尚未发送的现代 Step；有发送、分页、结果、unknown 或不一致证据仍阻断。**该策略线上究竟命中了哪个历史 Run/Step，尚需只读诊断，不能保证现存失败记录会自动恢复。**

两类错误都不是当前截图能证明的时间窗错位。混合显示 `+08:00` 与 `+00:00` 本身合法，不应因此重建或滑动原任务窗口。

## 修复与发布范围

- `de-mingxi/compass/deploy/nginx/conf.d/40-hub.conf` 与 `compass/deploy/internal-nginx/hub.minsight-ai.com.conf`：按 `/api/v2/` 前缀通用转发，原 URI、body、Authorization、Idempotency-Key 不变，不 rewrite 到 v1。
- Hub：部署 smoke 增加无凭据 `POST {}`，要求 `401` JSON `error.code=api_key_required`；拒绝 HTML 404、旧后端 404、其他 401 和重定向。探测不产生供应商请求或 usage 预留。
- Delta：修复现代 Step 误拦；补 `request_dispatched` 诊断；同平台 unknown 保持跨 v1/v2 阻断，明确无关的平台不再继承阻断；来源缺失或矛盾则保守处理。告警加入 Run Key，并修正原来“同平台其他检索式继续”的过度承诺。
- 标准内容搜索、手工重试与冷启动恢复的 unknown 检查不再只依据当前任务是否带 v2 标记，避免无标记日报入库 Run 的重试漏查已有同平台 unknown；该修复不升级旧任务版本。
- 冷启动 watchdog 排队后的状态更新改为锁住 Run、读取最新 scope 后只合并自己的标记，避免用调用者旧对象覆盖 worker 刚保存的账本或 unknown。
- 本次没有更改 Java/罗盘业务条件、MX-H2I 登录、Launcher 联网、SSO 路由、Hub 回源地址或现有 v1 处理。不改数据库 schema，不清历史状态，不自动重跑。

先更新 Hub 两层网关，再验收 Public v2 路径，最后在正确的 Delta 部署栈更新镜像。Hub 镜像单独部署不会发布外部 nginx 配置；Delta 主机的 `nginx:1.27` gateway 也不是应修改的 Hub vhost。两层宿主机定位、配置合入、`nginx -t` 与平滑 reload 命令见 `de-mingxi/compass/deploy/HUB-SEARCH-V2.md`。

## 1. Hub K8s 与入口的无采购检查

在能访问 Hub 集群的终端确认 Public pod 与镜像：

```sh
kubectl -n mx-insight-hub get pods -l app.kubernetes.io/name=mx-insight-hub-public -o wide
kubectl -n mx-insight-hub get deployment mx-insight-hub-public -o jsonpath='{.spec.template.spec.containers[*].image}{"\n"}'
kubectl -n mx-insight-hub port-forward deployment/mx-insight-hub-public 18150:18150
```

保持 port-forward 运行，在另一个终端：

```sh
curl -sS -i --connect-timeout 5 --max-time 15 -X POST \
  http://127.0.0.1:18150/api/v2/data/search \
  -H 'Content-Type: application/json' --data '{}'
```

在 Hub Internal 主机直接探测 nginx，再从 Delta 宿主机探测公网：

```sh
# 仅在 Hub Internal 主机执行
curl -sS -i --connect-timeout 5 --max-time 15 -X POST \
  http://127.0.0.1/api/v2/data/search \
  -H 'Host: hub.minsight-ai.com' -H 'Content-Type: application/json' --data '{}'

# 在 Delta Docker 宿主机执行
curl -sS -i --connect-timeout 5 --max-time 15 -X POST \
  https://hub.minsight-ai.com/api/v2/data/search \
  -H 'Content-Type: application/json' --data '{}'
```

预期均为 **401 JSON / `api_key_required`**；刻意不带真实 Key，不要加认证来“消除”401。Pod 直连 JSON 404 表示后端版本/路径不符；直连 401、Internal HTML 404 表示内层路由问题；前两项 401、公网 HTML 404 表示外层或公网实例问题。普通 `OPTIONS 204` 不足以证明 v2 handler 已上线。宿主机 curl 使用的出站代理与 worker 配置也可能不同，后续仍需确认 worker 的 Hub base URL。

## 2. 区分 `delta_59202` 与 `mx_data`

用户机器同时运行两套 Delta。告警 `dev` 和策略名称里的 `pub` 不能可靠证明所属部署；镜像 tag 相同也不能证明镜像内容相同。先读取四个容器的实际镜像 ID、启动时间与 Compose 来源，不输出环境变量：

后续用户已回传 Web 容器标签：`delta_59202` 和 `mx_data` 共用服务器目录 `/home/lcy/test/Delta/mx_data`，测试实例使用 `po-infra-local:delta-59202-feat-new_delta` 与 NAS `part2.release.json`；正式实例使用 `ghcr.io/mingxiinfo/po-infra:feat-new_delta` 与 NAS `part1.release.json`。这确认本次应将 po-infra 修复发布到明确的 Compose project，不能根据共享目录名操作默认项目。`Delta_Pub` 不包含本次所需 data_hub；详细源码依据和 Java profile 的默认目标见 `de-mingxi/compass/deploy/HUB-SEARCH-V2.md`。这些标签尚不证明指定计划属于哪套数据库，也不证明 Java 的运行时 URL 未被覆盖。

```sh
docker inspect --format '{{.Name}} image={{.Config.Image}} image_id={{.Image}} started={{.State.StartedAt}} project={{index .Config.Labels "com.docker.compose.project"}} compose={{index .Config.Labels "com.docker.compose.project.config_files"}} directory={{index .Config.Labels "com.docker.compose.project.working_dir"}}' \
  delta_59202-web-1 delta_59202-worker-1 mx_data-web-1 mx_data-worker-1
```

将本仓库 `server/ops/diagnose-delta-search-v2.py` 复制到 Delta 宿主机当前目录，再执行：

```sh
docker exec -i -w /app \
  -e MX_DIAGNOSTIC_PLAN_KEY=f5cce38c-6b8a-4eba-b8d1-829a2ec79dff \
  delta_59202-worker-1 python manage.py shell < diagnose-delta-search-v2.py

docker exec -i -w /app \
  -e MX_DIAGNOSTIC_PLAN_KEY=f5cce38c-6b8a-4eba-b8d1-829a2ec79dff \
  mx_data-worker-1 python manage.py shell < diagnose-delta-search-v2.py
```

脚本在 PostgreSQL `REPEATABLE READ READ ONLY` 事务中取快照，设置超时并始终 rollback。输出计划存在性、数据库身份摘要、运行源码摘要、脱敏 Hub URL、近期 Run、旧 Facebook 候选、unknown Run 与有限 Step/账本状态；不发 HTTP、不排任务、不清保护，也不输出检索式、游标、幂等键、凭据或原始报错。若显示列表截断，不能据此断言没有更早的阻断记录。

对 `planFound=true` 的部署，再把容器名换成相应 `web` 和 `worker-agent-data-hub` 执行同一脚本，比较 `code.*.sha256` 与数据库摘要。数据库摘要仅辅助识别，不是集群身份的强证明；若两套都找到该计划，先核对连接与调度归属，再发布。缺少新版模块的旧镜像仍可读取计划信息，代码摘要会显示 `available=false`。

## 3. 更新 Delta 与恢复原则

按已确认的 Compose 项目/配置文件构建并更新 Web、采集 worker、日报/agent worker 及使用同一代码的调度进程。不要只更新 Web，不要把 `docker compose restart` 当作新镜像发布，也不要因为这台机器有两个项目就一起重建。此处不提供未经确认的全栈 `down/up` 命令，以免中断另一个环境。

入口 401 门禁与代码摘要一致后，才核对原失败 Run 的请求账本：

- 明确的 nginx 404 可以通过原任务的受保护重试路径处理，保留冻结窗口、页号、cursor 和原幂等键，不新建替代 Run 来绕开旧保护。
- `legacyFacebookCandidates` 是旧筛选规则的候选列表，不等于确认所有候选都发过请求。新版无发送证据 Step 的误拦由代码修正；已部署旧版本产生的失败 Step 若没有足够记录仍保守阻断。
- 真正 `request_outcome_unknown` 或账本不一致需要核对原 Hub request；不能删标记、改平台/检索式/API 版本、换 key，或将任务强制标为成功。
- 本次修复不把旧 v1 请求升级为 v2，不把旧一天窗口解释成整月数据，不对旧 cursor 补新日期。

## 本地验证记录

| 验证 | 本次结果 | 边界 |
| --- | --- | --- |
| 两层真实 nginx | 4/4 | 本机 nginx、临时证书与合成后端；含分别遗漏任一层时的 404 复现 |
| Hub v2 / smoke | 21/21，零跳过 | 真实 Public HTTP 与临时 PGlite；覆盖 401 无采购、幂等和跨版本 unknown |
| Delta 联合函数回归 | 154/154 | 真实函数，外部依赖使用 AST 加载及 Mock；含日报重试、恢复入口和 watchdog 并发状态 |
| Delta Django ORM | 8/8 | 直接导入生产 guards，真实 Django/SQLite JSON1、最小临时表；未替代 PostgreSQL 与完整项目模型测试 |
| Java → Delta → Hub fixture | 12/12 | 使用已生成 Java fixture，4 平台 × 冷启动/增量/日报；本次未改 Java/前端 |
| 只读诊断回归 | 17/17 | 新增诊断 12 项及既有 5 项；验证脱敏、边界、只读语句和错误回滚，未连接线上数据库 |

本节为 10 月 17 日首轮记录，本地验证不等于线上已恢复。后续用户部署后已取得 Hub JSON 409 与旧 raw 诊断回执，最新修复和仍待核对的 Delta Run 见本文开头。上述首轮与本次修复均未由助手执行线上解锁、排队或付费查询。
