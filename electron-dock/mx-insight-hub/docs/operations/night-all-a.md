# Night-All-A 接入（2026-09-16）

管理页已升级为案例驱动的操作台：一页新闻、关键词新闻、已有计划触发；支持任务、运行、步骤日志和 Hub 操作历史。
统一接入模型、195 材料复核和后续平台验收流程见 [Hub 数据插槽方案](../architecture/integration-slots.md)。

## 决策

Night-All-A 独立登记在管理页「数据清洗中心 → 外部数据平台」。它不替换 Night-All，
也不修改 MX-H2I、Launcher、VPN、DNS、登录或现有数据读取。

Hub `100.127.0.6` 经现有 OpenVPN 访问 `http://100.127.0.1:8100` 即可。
**Nginx 不是必须的**，本次不增加海外部署依赖，也不修改 de-mingxi。
只有需要来源 IP 限制、独立访问日志或稳定入口时才另加代理（预留 8101），
此时仍须保留上游登录；不能把加一层代理当成租户权限控制。
从实际 Admin Pod/宿主验证 VPN 路由和回程，不能只以个人电脑连通为依据。
本次本机请求超时，未对海外服务或线上版本作成功声明。

## 接口目录来源

管理页包含 **83 个路径、117 个操作**：本地 Night-All-A FastAPI 的 `app.openapi()` 完整快照，
以及该项目的 8 篇业务指南。快照记录源码提交与每个 app Python 文件的 SHA-256；
它反映工作区源码而非证明某个提交已部署。内部宿主、资源与凭据接口仅登记。
独立 docker-runner 服务不属于 8100 主应用，未纳入其转发目录。

管理页展示分组、搜索、逐接口参数/类型/必填/默认值/约束、请求体模型、响应声明、
业务字段释义与 Hub 对接操作。上游未声明的响应模型明确标为未知。
平台：<http://100.127.0.1:8100/collect>；文档：<http://100.127.0.1:8100/docs>。

刷新目录可使用 `scripts/snapshot-night-all-a.py /path/to/Night-All-A`。
在独立 Python 环境安装上游 backend/pyproject.toml 的依赖；脚本不启动 lifespan、
不连接生产数据库、不读取 .env、不请求上游，也不将连接器凭据写入快照。

## 运行配置与上线

先按 Hub 现有流程执行新增迁移 `084_night_all_a_dispatch.sql`，再部署 Hub。
只影响 Hub Admin 的可选 Secret `mx-insight-hub-night-all-a`：

| 环境变量 | 默认 / 含义 |
| --- | --- |
| `MX_INSIGHT_NIGHT_ALL_A_BASE_URL` | `http://100.127.0.1:8100`；仅允许该 IP 的 8100/8101 端口，无额外路径、凭据和查询串 |
| `MX_INSIGHT_NIGHT_ALL_A_ENABLED` | 默认关闭；`1` 开放受控查询 |
| `MX_INSIGHT_NIGHT_ALL_A_WRITES_ENABLED` | 默认关闭；`1` 另行开放采集触发，仍要求上一开关为 `1` |
| `MX_INSIGHT_NIGHT_ALL_A_SESSION_COOKIE` | 若上游启用认证，配置 `dq_admin_session` 的值，不含 Cookie 名称 |
| `MX_INSIGHT_NIGHT_ALL_A_CSRF_TOKEN` | 上游会话对应的 CSRF Token，供写请求使用 |

上游现有认证是登录会话 + CSRF，不是 service-token/Bearer API Key。
只通过 Night-All-A 正常登录获取会话，过期后人工更新独立 Secret 并滚动 Admin。
没有配置会话时只适用于已明确允许的 VPN 内无登录访问；401/403 保留为上游 HTTP 结果。
不复用旧 `NIGHT_ALL_SERVICE_TOKEN`，不转交 Hub Token，不把网站 Cookie 当平台会话。

Kubernetes Admin 清单已添加 optional Secret 引用；Secret 缺失也能启动。
配置无效只禁用 Night-All-A，健康检查与启动不探测它。写请求没有 PostgreSQL 记录能力时拒绝派发。
新增表不存上游会话、Hub Token 或请求 body，只存请求指纹、原因、Admin actor、状态和响应。
响应属于仅 Admin 可读的业务/执行证据。保留记录不能随意清理，否则会失去幂等保护。

## Hub 对接入口

全部要求 `x-mx-insight-admin-token`，仅现有 Admin Token principal 可用。
没有新增公开 API、租户权限、客户计费或 Launcher 认证依赖。

`POST /internal/v1/admin/external-platforms/night-all-a/dispatch/{operation}`

| operation | 上游方法与路径 | 请求字段 |
| --- | --- | --- |
| health / connectors / sourceFamilies | GET /api/health、/connectors、/source-families | 可选 query |
| tasks / task | GET /api/tasks、/api/tasks/{task_id} | 列表 query / 单条 id |
| runs / run | GET /api/runs、/api/runs/{run_id} | 列表 query / 单条 id |
| runLogs / runSteps / runArtifacts | GET /api/runs/{run_id}/logs、/steps、/artifacts | id；仅有界读取 |
| plans / plan / occurrences | GET /api/collection-plans、/{plan_id}、/{plan_id}/occurrences | query / id |
| records / record / recordMetrics | GET /api/records、/{record_id}、/{record_id}/metrics | query / id |
| createTask | POST /api/tasks | body、reason、Idempotency-Key 请求头 |
| runPlan | POST /api/collection-plans/{plan_id}/run-now | id、reason、Idempotency-Key 请求头 |

所有转发调用使用上述 Hub POST 信封，query 必须是对象且仅接受快照声明字段。
不接受自定义 URL、path、headers。上游响应大小限 4 MiB，请求信封限 64 KiB，
每个 Admin 进程最多 8 个同时调用，总超时 15 秒，禁止重定向与自动重试。

示例（Header 另传 Admin Token 与一个稳定的 Idempotency-Key）：

```json
{
  "body": {
    "connector_id": "china-news",
    "capability": "news.collect",
    "parameters": {"platforms": ["thepaper"], "limit_per_platform": 20, "max_pages": 2},
    "persist_results": true,
    "max_attempts": 1
  },
  "reason": "管理员确认的一次新闻采集"
}
```

返回 `{ dispatchId, upstreamStatus, data, replay }` 包装于 Hub `data` 内。
检查 upstreamStatus；Hub 的 200 表示完成转发/回放，不代表上游业务成功。
`data.task.id` / `data.run.id` 用于轮询任务与运行。202 不是同步结果。

## 幂等与失败处理

写请求先以唯一 Idempotency-Key 在 PG 原子占位，再发送一次。
相同键与指纹回放已记录结果；换 body、operation、id 或 query 返回 409。
保留相同键再次请求不重复派发。连接错误、15 秒超时、非法/超大响应、5xx、
以及响应落库失败都可能已创建任务，按 unknown 处理，禁止自动换键。
进程崩溃留下 reserved 也不自动重派；它表示可能正在运行或无法判定。

`GET /internal/v1/admin/external-platforms/night-all-a/dispatches/{dispatchId}` 查看持久状态。
`GET /internal/v1/admin/external-platforms/night-all-a/dispatches` 读取最近 50 条操作摘要，含原因、actor、派发状态和上游 ID；不访问上游，也不返回完整大响应。
completed 只证明 HTTP 响应留存，最终采集结论看上游 Run。
工作台在当前浏览器 sessionStorage 保留键，业务请求内容不存浏览器；跨会话仍须保存原键和 dispatchId。
工作台提供 dispatchId 查询，可在关闭转发后核对持久状态；不要换键重提未知任务。
只有人工核对上游任务后，才决定是否接受重复采集风险并创建另一请求。

## 数据清洗与计划边界

Night-All-A 采集计划负责外部采集；Hub 清洗计划负责内网数据库到 Canonical/索引。
沿用现有 `night-all-saved-records-*` 数据源的固定 source_type 分表契约、映射和 checkpoint。
这次不自动创建计划、不改 DSN、不修改已有 sourceId、datasetId 或游标。
启用前核对只读数据库权限、Writer 契约、字段漂移、`last_seen_at,id` 排序与水位推进。

records API 的 offset 不是快照/CDC；date_from/date_to 过滤 created_at，不是 published_at。
稳定去重身份为 connector_id + record_type + source_id；source_id 保持字符串。
新闻重复记录跳过；其他记录可能更新 run_id，因此按 run_id 查询不能当不可变历史。
指标缺失不能当 0，succeeded 不保证 complete，metrics.records.saved 包括新增与更新。
上游落库成功也不证明 Hub 已完成清洗/索引，分别检查各段证据。

## 验证与回滚

先部署关闭状态检查管理页/登录/原平台回归，再开启查询验证 health/connectors。
由实际 Hub 运行环境核对 VPN 直连、上游认证和返回 Schema 后，才开启写入并显式触发一次。
关闭独立开关即可停止新转发；保留 journal 和幂等记录。不回滚 Launcher，不调整 VPN/DNS。
