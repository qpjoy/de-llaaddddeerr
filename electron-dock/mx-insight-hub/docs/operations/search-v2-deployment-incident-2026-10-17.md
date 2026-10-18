# Search v2：部署后自动恢复准入拒绝

## 当前操作：更新 Hub 与测试 Delta 即生效

2026-10-18 调整为通用协议处理。下游不再需要事故 UUID、文件 SHA、Hub 回执、Django shell 或逐条解锁。旧的一次性 `verify-delta-raw-admission-recovery.mjs` / `recover-delta-raw-admission.py` 已退出当前流程；只读 `diagnose-*` 保留为可选排障工具。

同步本次源码后，在 Hub 源码目录执行：

```sh
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh ops internal-production deploy
```

然后在已确认的 Delta 测试宿主机执行：

```sh
cd /home/lcy/test/Delta/mx_data
test -f deploy/.env.delta-59202.ghcr && \
  COMPOSE_PROJECT_NAME=delta_59202 bash scripts/deploy_public_ghcr.sh \
    --instance delta-59202 --port 59202 --tag feat-new_delta \
    --local-build --no-pull --no-cleanup
```

沿用原实例 env、Hub 地址、凭据和 NAS release wrapper。若原实例使用自定义 `DEPLOY_ENV_FILE`，继续沿用该文件。发布覆盖 Web、beat、采集与 Agent worker；仅 restart 旧容器不会加载新代码。另一套 `mx_data` 不参与这条部署命令。Hub 的 Launcher 联动明确关闭；本次无新增数据库迁移、nginx、MX-H2I 登录或联网改动。

Delta beat 每分钟检查待恢复搜索，准入等待默认间隔 5 分钟重试，沿用原 Run、页请求体、Idempotency-Key、窗口及游标。明确的准入拒绝显示为等待状态，不再反复发送冷启动失败告警。无需再执行恢复脚本。部署本身不会把未知请求标为成功，恢复成功以原 Run 的新 Step 和采集结果为准。

## 协议与自动恢复边界

- **Hub 尚未接收本页采购**：当 v2 的当前 key 没有 usage、binding 或 lease 归属，只被其他未完成请求挡住，返回 `409 search_admission_blocked`，明确 `dispatchState=not_started`、`automaticRetryAllowed=true`、`retrySameRequest=true` 和 `retryAfterSeconds`。下游按退避重试同一页，Hub 每次重新判断是否可执行。
- **真正结果未知**：同 key 的 unknown、过期未完成租约、投影或存储不确定、网络响应丢失继续保留原保护。换 key、窗口、版本、计划或 consumer 都不是恢复方式。Hub 仍负责永久幂等和采购准入。
- **已被旧版本误记成 unknown 的 CollectionRun**：只对具有 v2 持久页账本、原失败 Step 与完整旧 begin 拒绝证据的原页进行一次原身份核对。旧文案也可能属于真正的同 key unknown，不能把它当作未采购证明；恢复后仍由 Hub 判断。若仍为真正 unknown 或发生传输不确定，保留阻断，不在每次部署后重复核对。
- **等待期间**：保留计划范围的阻断，只允许原 Run 的已保存页退避重试；兄弟 Run、新 key 和新窗口不能绕开。用户暂停、取消、过期计划和不再属于当前冷启动组的任务不自动恢复。原失败 Step 保留。
- **日报补搜**：未来明确的准入拒绝不再记成供应商 unknown，原有 Skill 重试仍复用原 body/key。本次不自动重跑整份历史日报 Agent，避免模型重新生成检索式造成业务范围变化。
- **旧一次性恢复审计**：若此前已执行旧工具而投递状态仍不确定，继续保留其原有等待保护；自动兼容不覆盖这类审计。

新错误中的 `blockingRequestId` 属于挡住当前请求的历史记录；顶层 `requestId` 仅用于定位本次 HTTP 尝试，不能当作新采购 ID。`request_outcome_unknown` 不因字符串里包含“准入”或因为记录较旧就获得重试权限。v1 请求、旧游标和旧时间窗保持原语义。

## 10 月 18 日自动恢复验证

| 验证 | 结果 | 边界 |
| --- | --- | --- |
| Hub `data-search-v2.test.mjs` | 31/31 | 真实 Public HTTP、内存与 PGlite；未准入零采购、相同请求恢复及交付重放、原 key unknown 与跨版本保护 |
| Hub `public-docs.test.mjs` | 11/11 | Public 文档路由与契约描述 |
| Delta 采集与协议离线回归 | 171/171 | 含 29 项新增准入状态、collector 与 task 检查；网络和部分框架边界使用 Mock/AST 隔离 |
| Delta 既有 guard ORM | 8/8 | 真实 Django/SQLite JSON 查询，生产 guard 函数 |
| Delta 新增调度 ORM | 33 项检查通过 | 真实 Django/SQLite 与生产调度、页状态函数；原 Run/key、退避、暂停、旧记录扫描、投递异常、重复 worker 与恢复后分页 |
| Hub → Delta 联合错误契约 | 通过 | Hub 实际生成的错误交给 Delta 原生请求解析函数；供应商和 HTTP 传输模拟 |

新增调度测试已保存到 Delta `data_hub/tests_search_admission_orm.py`，可用 `python -m unittest data_hub.tests_search_admission_orm` 重跑。验证未连接线上数据库或供应商，SQLite 不代替 PostgreSQL 行锁与真实 Celery 多 worker 验收。此处只确认本地代码和协议回归，线上恢复须在上述两个服务发布后观察。

## 本次事故依据

入口已从 nginx HTML 404 恢复到 Hub JSON 409。告警涉及 Plan `6905bd48-7324-4602-9c06-4b77994f93d9`、Run `65a9f174-e611-4032-a759-fb64efcb540e`。阻断请求 `8ebd9f58-f6b6-4f8a-b8fe-db94c1068c09` 于 9 月 15 日请求旧 Night-All raw，30 秒超时，状态仍为 unknown。v3 只读回执确认计量项 `raw`、唯一关联 connector 的 `operation=raw/outcome=unknown`，consumer、平台、指纹一致；旧 acquisition 快照缺失。

Hub 已依据完整 raw 证据恢复既有操作边界，保留该旧 raw unknown，不再把缺少历史路径的 raw 扩大成标准搜索的平台阻断。缺失、矛盾、多个 connector、仍在 reserved 或明确的标准搜索记录不适用这一判断；同 key 归属仍受保护。

Delta 的 `delta-search-v2.2` 回执确认原 Run 只有一个第一页 unknown stream 和一个失败 Step，完整拒绝来源一致，无成功页或实际入库条目，冻结 v2 请求仍在。自动核对使用这些通用结构，不硬编码本事故 UUID 或摘要；Hub 的原 key 保护是最终执行边界。旧 raw 的查询和下游扣费结果仍未知。

以下为 10 月 17 日入口与部署归属的历史排查记录；其中人工诊断命令仅供排障，不是上面的当前恢复步骤。

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

本节为 10 月 17 日首轮记录，本地验证不等于线上已恢复。后续用户部署后已取得 Hub JSON 409、旧 raw 与 Delta Run 诊断回执，当前自动恢复方式见本文开头。上述首轮与本次修复均未由助手执行线上解锁、排队或付费查询。
