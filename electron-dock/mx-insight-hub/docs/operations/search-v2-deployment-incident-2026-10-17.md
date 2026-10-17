# 2026-10-17：v2 入口 404 与 Delta Facebook 保护

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

本地验证不等于线上已恢复。本次已写回本地 Delta、Hub 与 `de-mingxi` 源码，未执行部署、清理历史或触发付费查询。线上已取得的证据只有公网 HTML 404 与指定 Public pod 的 401；网关更新后的公网 401、Delta 正确实例及历史阻断记录仍待按上面的命令核验。
