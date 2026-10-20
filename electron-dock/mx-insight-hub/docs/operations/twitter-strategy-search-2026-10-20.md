# Twitter 策略搜索参数与准入错误

## 原请求与证据边界

截图中的请求 ID 为 `97a61bef-c5b8-4d70-9638-6a966d1e2fdd`，关键词为“张婧仪”，接口为策略搜索的 `POST /api/v1/data/search`，错误为 `usage_admission_unavailable`。运营者已返回下述只读回执，但没有可关联的原始失败细节；不能把近期共享磁盘、PostgreSQL 或某个供应商的问题认定为本次根因。

代码链路为：产品展示提交原参数和幂等键 → Hub HTTP/身份校验 → 标准搜索选路及请求预留 → 供应商采购 → 保存、投影与交付。该错误由 `PostgresStore` 在本次请求尚未提交预留时产生：

| details.stage | 代码所确认的边界 | 尚不能确认的具体原因 |
| --- | --- | --- |
| `connection` | 获取数据库连接失败，事务未开始 | 池排队、连接超时、连接中断等需日志区分 |
| `reservation` | 预留事务在发送 COMMIT 前遇到 55P03、57014 或 40P01，执行回滚 | 分别对应锁不可用、语句取消或死锁；仅凭截图无法选择其中之一 |
| `recovery` | 旧预留清理遇到同类数据库错误 | 需原时刻日志和 SQLSTATE，不能据此归因供应商 |

COMMIT 已发出而确认丢失使用独立的 `usage_reservation_persistence_unknown`，不能解释为“没有开始”。即使本次没有预留，也不能推断更早的同幂等键请求没有采购。继续核查或人工重试应保留原参数及原幂等键；本次修改不自动重试、不改历史状态和账单。

原 HTTP catch 不记录 `AppError`，导致被包装的数据库根因丢失。本轮只为 `usage_admission_unavailable` 补充 `hub_database_request_failed` 结构化日志，保留 HTTP requestId、固定错误码、阶段、原因分类及 SQLSTATE；不输出 SQL、参数、凭据、异常消息或堆栈。日志写入失败不改变原响应。该修改仅改善发布后的证据，不能重建本次丢失的历史根因。

## 生产只读取证

本机 kubeconfig 仅有 `docker-desktop`，未连接生产。运营者可直接运行：

```bash
for previous in false true; do
  kubectl --request-timeout=20s -n mx-insight-hub logs \
    -l 'app.kubernetes.io/name in (mx-insight-hub-public,mx-insight-hub-admin)' \
    --all-containers=true --prefix=true --timestamps=true \
    --since=24h --tail=20000 --max-log-requests=6 \
    --previous="$previous" |
    grep -F -C 8 '97a61bef-c5b8-4d70-9638-6a966d1e2fdd'
done

kubectl --request-timeout=30s -n mx-insight-hub exec \
  deployment/mx-insight-hub-admin -c admin -- \
  node server/ops/diagnose-twitter-outcome.mjs \
  97a61bef-c5b8-4d70-9638-6a966d1e2fdd
```

第一组只覆盖当前 Pod 保留的最近 24 小时、每容器最多 20000 行及其重启前日志，不包含已删除 Pod；没有匹配不代表请求没有发生。第二组使用只读事务查询原 ID，不调用供应商。`request_not_found` 可能表示 HTTP ID 没有对应持久化 usage；不能据此自动生成新 key 采购。若旧镜像缺少诊断文件，应从当前源码以 stdin 运行已有 `server/ops/diagnose-twitter-outcome.mjs`，无需为取证部署。

### 2026-10-20 运营者回执

返回结果：

```text
Error from server (BadRequest): previous terminated container "admin" in pod "mx-insight-hub-admin-5cfb47b787-2x6c8" not found
{"error":"request_not_found"}
command terminated with exit code 1
```

- `previous ... not found` 只表示指定 Admin Pod 没有可读取的上一容器实例日志，不是这次搜索的业务错误，也不证明整个部署从未重启。标准搜索在分离部署下由 Public/api 处理，Admin 在此仅用于数据库只读诊断。
- outcome 诊断没有找到该 UUID 对应的 usage 行。HTTP 层先生成 correlation ID，采购预留另有 usage ID；预留失败且没有 durable ID 时，响应展示的是 HTTP ID。因此结果符合预留前失败的代码路径，不能称为数据丢失，也不能证明更早同一幂等键的尝试未采购。
- 用户确认原 Network 响应已找不到，无法取得其中的 `error.details.stage` 和原时刻。当前没有足够证据区分 connection、reservation、recovery，或定位当时的具体 SQLSTATE。不要拿当前数据库健康、Pod Ready 或新请求结果替代历史证据。

该历史请求的已知结论止于 **Hub 请求准入失败**。不重复同 UUID 查询或 Admin previous 日志，不为重建丢失证据自动搜索、换 key、重启或修改历史记录。已完成的日志补丁只对正常发布后的新失败提供阶段和原因分类，不会补回旧证据；本轮未进行生产发布或状态修改。

## 搜索行为

现有数据库策略为 `priority / rapidapi / tikhub` 的缺省值；已保存策略优先，不由本轮覆盖。RapidAPI 优先、TikHub 保底，固定模式及暂停模式继续有效。首请求的确定 RapidAPI HTTP 400 保底规则、原生续页固定供应商、unknown 保护及已有账单语义保留，参数不兼容时不能丢弃参数强行保底。

新标准查询默认 `Latest`，调用方可通过 `params.category` 覆盖为 `Top`、`Photos`、`Videos`；`params.filters` 和 `params.includeTimestamp` 允许显式覆盖。已保存请求精确重放，旧游标维持原搜索类别，新游标绑定实际生效的搜索条件。产品展示中更改控件不采购，点击查询或下一页才执行。

[Twitter AIO Search 文档](https://rapidapi.com/viperscores-viperscores-default/api/twitter-aio/playground/apiendpoint_602d9730-5aec-48f1-ae31-7020727eb762)说明 `count` 已不受 Twitter 支持，下一页取 Timeline 的 Bottom cursor；Hub 因此继续以 `pageSize` 控制逻辑交付量、保留整页归档和余量，调用方只回传 Hub 的 `data.pageInfo.nextCursor`。原生 cursor 不直接成为公开 Hub cursor。

当前是内容搜索合同：仍要求关键词，`People` 的账号结果与仅 filters 无关键词查询不在本次范围。官方页面提示长 cursor 可用 POST，但未提供可核实的 POST body 示例；本轮不猜测请求格式，也不取消现有游标长度和有效期边界。

## 验证与发布状态

本轮只修改 Hub 搜索、界面和准入日志；不修改 MX-H2I、Launcher 身份、SSO、联网、Pay 或共享数据库部署。未部署、未进行线上采购；已有运营者回执无法确定历史具体根因，生产恢复未验证。本次无需新增迁移，不代表此前尚未发布的迁移可以跳过。

| 本地检查 | 结果与范围 |
| --- | --- |
| 新参数、路由、v2人工重试、路径编码独立复核 | 43/43 通过；包括旧Top/新Latest、最大filters与4096原生游标、缓冲续页、原参数重放及不兼容参数拒绝 |
| 参数/诊断重点套件 | 54通过、2原有数据库环境跳过；使用真实适配器与合成供应商响应，无线上请求 |
| 产品展示与重试客户端 | 61/61通过；覆盖参数编辑不派发、翻页保参、原请求省略字段、unknown锁定与v2重试 |
| 动态/静态接口文档和策略指南 | 23/23通过；实际HTTP测试解除本地监听沙箱限制后通过 |
| 本地HTTP与协议补跑 | social、Twitter重试/恢复和v2协议53通过、13原有数据库环境跳过，0失败 |
| 实际PGlite补跑 | 使用已有本地依赖，buffer、supplier、retry-preparation、v2准备与请求比较47/47通过，0跳过；未安装依赖或访问生产 |
| 准入日志、预留边界、连接池和v2拒绝 | 40通过、4原有数据库环境跳过；包含先失败后修复的日志回归，公开响应与COMMIT未知语义不变 |
| 登录路由隔离与邀请身份 | 5通过；真实OIDC+PostgreSQL集成1项因未配置环境跳过，没有验证生产SSO |
| 类型、构建、代码检查 | `npm run typecheck`、`npm run build`、`git diff --check`通过；构建保留既有大chunk提示 |
| 实际页面 | 仅本机内存API和测试身份，窄屏检查默认Latest、筛选控件、排版；未执行搜索，测试服务已停止 |

上述套件有重叠，不可直接相加作独立测试总数。扩展Twitter回归发现5个既有诊断bundle失败：严格依赖检查返回 `parser_dependencies_changed`，用本轮修改前HEAD的diagnostic/parser/errors源码同样复现；本轮未扩大到该打包器修复。生产命令使用现有独立 outcome 诊断，不依赖该bundle。本地HTTP监听失败已在允许回环端口的环境补跑通过；其余未配置的原生数据库用例保持明确跳过。
