# Threads 策略搜索：响应前失败

日期：2026-11-14。状态：原请求归档已确认 `ENOTFOUND`；操作者核对时 Public Pod 的 DNS 与 HTTPS 均正常，业务恢复尚未验证。

## 截图证据

Hub 请求 `de42efcd-4a06-48d7-9752-60a0f2b39d48`，调用
`rapidapi / native.r.threads_scraper_search_posts`。供应商调用开始于
`2026-11-14 07:23:39.764 UTC`，结束于 `07:23:43.892 UTC`，记录耗时 4065 ms。
结果 `unknown`，错误码 `social_upstream_response_unusable`；HTTP 状态和供应商 requestId 未记录。
客户记录扣款 0、结果未知，供应商实际计费未知。估算采购金额不证明已扣款。

这次已选择 Threads Scraper。当前适配器在 `fetch` 尚未返回 Response 时捕获异常，
会产生这组状态，并将受限技术元数据写入 `responseArchive.rawPayload.response.transportFailure`。
已收到响应后发生的解析错误会保留 HTTP 状态；代理探测全部失败有独立的
`social_egress_unavailable`。这些是代码路径及本地模拟证据，不能替代原请求归档。

操作者执行只读命令后返回同一 UUID：`requestFound=true`、`status=unknown`，只有一条 RapidAPI
调用；`transportFailure={phase:"request",codes:["ENOTFOUND"],deadlineExceeded:false,elapsedMs:4063,timeoutMs:30000}`。
该证据确认主机名解析失败，适配器总超时未触发。没有 HTTP 响应，不是本次返回 HTTP 403 的证据。

归档没有保存失败 hostname；`request` 阶段还包括代理路由读取所需的 PostgreSQL 连接，故可能涉及
数据库主机、直连 Scraper 主机或代理主机，不能直接认定 `threads-scraper.p.rapidapi.com` 不存在。
[Node DNS 文档](https://nodejs.org/api/dns.html#dnspromiseslookuphostname-options)也说明，`ENOTFOUND`
可能代表其他系统名称解析失败，不仅是域名不存在。下一步在实际 Public Pod 核对当前路由和名称解析；
当前检查只能说明当前状态，不能独立重建事故时的出口或证明供应商计费。

第二次操作者回执确认 Public Pod 当前路由为 `source=system/directFallback=true/proxyHosts=[]`，
使用集群 DNS，`ndots:5`。`threads-scraper.p.rapidapi.com`、`twitter-aio.p.rapidapi.com`、
`kubernetes.default.svc.cluster.local` 和 `mx-common-postgres.mx-common.svc.cluster.local` 的
系统 lookup 与 DNS A 查询均成功；两个 RapidAPI 域名都返回 `52.196.64.63`、`54.178.244.118`。
当前没有证据支持切换供应商、写死供应商 IP、修改集群 DNS 或重启 Pod。

不依据 `ENOTFOUND` 给整个 fetch 增加自动重试：本地已安装的 Undici 7.29 对 HTTP 421 有一次内部重连。
无网络 dispatcher 模拟复现了“首响应 421 → 内部重连 ENOTFOUND”，适配器仍会保存
`phase=request/httpStatus=null/outcome=unknown`。因此归档的这组字段不能证明 fetch 全程没有发送 HTTP。
历史未知状态保持。操作者继续执行不带 Key 的固定根路径 HEAD，返回
`{httpStatus:401,reachedHttp:true}`，确认当前已取得 HTTP 响应。该探测没有调用搜索接口，
不验证订阅权限、搜索响应解析或业务交付；不再以此事故为由修改 DNS 或供应商路由。

## 展示页恢复缺口

当前后端已有“只拦截仍在执行的同查询请求”规则：已结束的 unknown 保留原幂等键保护，
新请求仍走当前权限、价格、限流、并发和供应商派发保护。已有用户决策见
[历史未知请求准入规则](twitter-search-admission-disposition-2026-10-28.md)。
策略搜索展示页却把任何 uncertain attempt 持续锁到整个所选平台，使一次结束的失败继续阻止手动新查询。

本次将恢复入口限定为 Threads 标准内容搜索首页（不带 cursor）：先以原幂等键只读核对，必须匹配本地原请求 ID、
Threads 平台、unknown 状态和有效结束时间，再显示“准备新查询（再次发送会计量）”。
准备只保留原证据并恢复输入，不调用供应商、不清除旧状态或费用；之后点击搜索才创建新请求。
未查到、查询失败、reserved、身份或 ID 不匹配继续保持保护。分页请求、账号、详情和其他平台不扩展。
这个入口不承诺所有后台活动都已结束，也不保证新请求一定准入；发送时以服务器当前检查为准。

## 本地改动

管理员诊断查询现读取有大小上限的传输元数据，通过固定白名单再次投影，展示到供应商调用卡片，
并随已有证据导出。未知状态及计费规则保持原有语义。新搜索失败响应使用内容搜索文案。

`request` 阶段表示尚未取得 Response，不等于未发送；`body` 阶段表示读取响应正文失败。
读取和展示历史证据不触发供应商请求，也不释放冻结或更改旧的响应复现。

## 读取原请求

当前工作环境仅有 `docker-desktop` context，没有已连接的生产 Hub 集群。
将新增诊断脚本同步到运行环境的仓库后，在仓库根目录执行：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - de42efcd-4a06-48d7-9752-60a0f2b39d48 \
  < electron-dock/mx-insight-hub/server/ops/diagnose-threads-transport.mjs
```

脚本可从 stdin 在已有 Admin 镜像内执行，无需为取证先部署新镜像。仅按该 UUID 查询 Threads
请求和最多 20 条关联调用，使用只读事务，连接和查询超时各 5 秒、锁等待 1 秒、CLI 总截止 20 秒，
最后回滚。输出不含关键词、正文、URL、Key、异常消息或堆栈。`request_not_found` 表示当前库中没有
该 UUID 的 Threads usage；`diagnostic_timeout` 表示达到脚本总截止。未找到记录或技术码缺失不证明没有派发。

原请求报告、当前 Public Pod 解析与 HTTPS 检查已取得，待发布展示页修复并由用户明确发送业务查询验收。
本轮没有重放未知请求、调用付费接口、切换供应商或修改历史结算。

## 发布与验收

将本次 Hub 改动（包含新增文件）同步到服务器，在 `electron-dock/mx-insight-hub` 目录使用现有部署脚本：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh deploy
```

该命令发布 Hub，关闭 Launcher 联动和真实数据 smoke。本次修复没有新增数据库迁移。
部署完成后刷新页面。若仍有原查询锁定，依次点击“只读核对原请求状态”与“准备新查询（再次发送会计量）”；
然后明确点击搜索，才会发送一次新查询。如果刷新后没有保留本地查询状态，可直接重新填写关键词并发送。
新查询按当前规则计量，可能与原未知调用重复计费。记录新请求 ID 与实际返回作为业务恢复证据；
原请求 `de42efcd-4a06-48d7-9752-60a0f2b39d48` 仍应保留 unknown，不用它的回放结果判断新查询是否成功。

## 本地验证

Threads 现有业务、原生接口、代理、诊断 SQL 和页面回归通过；新增取证脚本 6 项测试全部通过，
包括 PGlite 实际 SQL 的请求隔离、只读事务、元数据大小与行数上限，以及 stdin 执行和总截止。
展示页、交互和接口指南的 56 项回归通过。Threads 公共 API 的 5 项测试覆盖已结束 unknown 的只读查询、
独立新请求成功以及旧请求、归档和计费记录保持原值。类型检查、生产构建和 diff 格式检查通过。
这些验证不代表生产请求已恢复。
