# Launcher 与 Luopan 链路耗时量化方案

状态：设计方案，未修改生产路由。本文用于先建立只读基线，再按同一个 probe ID 串起客户端、Domestic、公网 Nginx、Internal Nginx/Caddy、Kubernetes Service/Pod 和应用日志。

2026-10-22 补充：本文第 5 节的 Luopan 调用点取自 demo，不能代替正式产品及其 pnpm 补丁。
正式 `/Users/qpjoy/workspace/mingxi/luopan/po-frontend` 的当前等待链、依赖一致性、海外后台任务和
Domestic 容量分析见 [53](./53-luopan-login-and-domestic-capacity-review-2026-10-22.md)。现场量化仍按本文方法执行。

## 1. 当前路径与需要先确认的事实

### 1.1 Launcher Admin

仓库中的 `compass/deploy/nginx/examples/71-launcher.conf.example` 描述的是：

```text
浏览器
  -> DNS / TCP / TLS
  -> 公网 Nginx (launcher.minsight-ai.com:443)
  -> 10.88.88.88:80
  -> Internal host Nginx
  -> (按 Host/路径转发到 Caddy、Kubernetes Service、Pod 和数据库)
  -> 响应
```

该示例把 `/admin/`、`/auth/admin/` 和 `/admin-api/` 直接 `proxy_pass` 到
`10.88.88.88:80`，并在 server 级别设置了 `access_log off`。它在仓库中位于
`examples/`，不能据此断定线上已经启用；现场第一步必须保存：

```bash
nginx -T > /tmp/launcher-nginx-T.txt
ss -ltnp | egrep ':(80|443|8008|18090)\b'
```

还要确认 `10.88.88.88:80` 当前由 host Nginx 还是 Caddy 接收。历史上曾出现 Caddy
抢占 80、Nginx 启动失败而公网返回 `MX Internal gateway route not found` 的情况；
入口层错误或排队不能归因于 Launcher API 或数据库。

### 1.2 Luopan standalone

Luopan 的首次连接和连接后的业务请求是两条路径，必须分开统计：

```text
首次 bootstrap：
Luopan -> h2i.minsight-ai.com:443
        -> 公网/Compass Nginx
        -> mx-domestic-edge:8088
        -> Domestic/WireGuard relay
        -> Internal gateway/API

连接后业务：
Luopan 本机产品 WireGuard
        -> Domestic relay（或配置的 direct peer）
        -> Luopan service VIP 10.88.100.3:18090
        -> Internal gateway/Caddy
        -> Launcher API Pod / 数据库
```

Luopan 当前代码的顺序是：bootstrap 健康探测、ProductNetwork 查询、enrollment、snapshot、
Domestic peer sync、可选 Internal direct peer sync、本机 WireGuard/routes/ownership、
`http://<serviceVip>:18090/healthz`，之后才是用户登录和业务 API。service VIP 是产品级
地址，不是某台客户端的 lease IP；不能用 ICMP 或数据库 active lease 数量代替 HTTP healthz
证据。

### 1.3 MX-H2I 保护边界

MX-H2I 已有 `connection.diagnostics.transitionTiming`，字段为
`controlPlaneMs`、`preflightMs`、`wireGuardMs`、`postConnectMs`、`totalMs`。本方案复用这
个阶段模型作为分析口径，但第一阶段不改 MX-H2I 的登录、WireGuard、PAC、DNS/NRPT、路由
或断开逻辑。MX-H2I 只读取已有诊断日志和健康端点；Luopan 全流程测试使用隔离机器或 VM，
不在现有 H2I 用户机上反复断开重连。

## 2. 观测点和阶段定义

每个样本带 `probeId`；如果是用户流程，再带 `traceId` 和 `scenario`。每一跳保留本机的
单调时钟耗时，跨主机的墙上时间只用于日志关联。建议阶段如下：

| 阶段 | 入口 | 记录内容 | 目的 |
| --- | --- | --- | --- |
| `client_dns` | 外部/客户端 | DNS 查询时间、解析地址、缓存命中 | 区分 DNS 慢与 TCP 慢 |
| `client_transport` | 外部/客户端 | TCP、TLS、连接复用、TTFB、下载和总耗时 | 量化公网首段 |
| `public_edge` | 公网 Nginx | `$request_time`、upstream connect/header/response | 量化 TLS 终止和到内网的等待 |
| `domestic_edge` | `mx-domestic-edge` | 收到、转发、上游状态和耗时 | 区分 Domestic facade 与 WG/内网 |
| `internal_ingress` | Internal host Nginx/Caddy | request duration、upstream 地址和耗时 | 区分 80/8008/18090/Host 路由 |
| `k8s_service` | Service/Pod | endpoint、ready、排队、CPU throttling | 区分 Service/Pod 调度和应用处理 |
| `app` | Launcher API | handler、auth、DB、response 分阶段耗时 | 找出 Nest/身份校验/数据库瓶颈 |
| `wireguard` | Domestic/Internal peer | latest handshake、endpoint、RX/TX 增量 | 证明隧道是否活跃；不能单独推导 HTTP 延迟 |
| `client_data_plane` | Luopan | peer sync、WG apply、route proof、VIP healthz | 解释 standalone 连接慢 |

代理耗时是嵌套区间：上游 `request_time` 已包含 upstream 时间，不能把所有行直接相加。
只有在同一个 `probeId` 串起同一个请求时，才计算近似残差，例如
`proxy_request_time - upstream_response_time`；残差必须标注为近似值。

## 3. 三处主动探针

### 3.1 公网外部探针

从至少一个不在 Domestic/装有 H2I 的外部网络运行，每 1–5 分钟测一次，冷连接和 keep-alive
各保留一组。第一阶段只测只读端点：

```text
https://launcher.minsight-ai.com/admin/
https://h2i.minsight-ai.com/healthz
https://h2i.minsight-ai.com/bootstrap-healthz
https://h2i.minsight-ai.com/internal-healthz
```

`/admin/` 还要用独立浏览器 profile 或 Playwright 记录 302、静态 chunk、首个 Admin API、
DOMContentLoaded 和 load；单个 `/admin/` 的 curl 总时间不能代表首屏完成时间。

使用 `curl` 时保留原始字段，不要只输出一个 total：

```bash
probe_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
curl --noproxy '*' --http1.1 --connect-timeout 3 --max-time 10 \
  -H 'X-MX-Probe: 1' -H "X-MX-Probe-Id: ${probe_id}" \
  -sS -o /dev/null \
  -w '{"probeId":"'"$probe_id"'","time_namelookup":%{time_namelookup},"time_connect":%{time_connect},"time_appconnect":%{time_appconnect},"time_pretransfer":%{time_pretransfer},"time_starttransfer":%{time_starttransfer},"time_total":%{time_total},"http_code":%{http_code},"remote_ip":"%{remote_ip}","size_download":%{size_download}}\n' \
  'https://h2i.minsight-ai.com/bootstrap-healthz'
```

派生值保持统一口径：

```text
dns_ms       = namelookup
tcp_ms       = connect - namelookup
tls_ms       = appconnect - connect
send_ms      = pretransfer - appconnect
server_ttfb  = starttransfer - pretransfer
download_ms  = total - starttransfer
total_ms     = total
```

### 3.2 Domestic 探针

Domestic 上也要运行脚本。它回答的是“公网入口之后还剩多少”，不能取代外部探针。对同一
vhost 使用 `--resolve` 保留 Host/TLS 路由，分别测本机 edge listener 和实际上游；保存
`probeId`，但不要把 `T_ext - T_dom` 当作单请求精确差值：两次请求的连接、负载和时间点不同，
只能比较同一时间窗的 P50/P95。

建议每分钟测三个健康面：Domestic 自身 `/healthz`、Domestic 反代的 `/bootstrap-healthz`、
Internal gateway 的只读 `/internal-healthz`。发生慢时再做 30 次连续样本，记录是否冷连接、
上游地址和失败类别。

### 3.3 Internal 探针

在 Internal host 或带网络权限的 debug Pod 运行：

```text
Internal host Nginx/Caddy -> Host 路由 -> Service/Pod -> /healthz
Service/Pod 直接访问 -> /healthz
```

两者的差值用于识别 80/8008/18090、Caddy、Service 或 Pod 路由开销。不要假定生产业务
Pod 内有 curl；使用临时、只读、可审计的 debug Pod。PG 只读观察
`pg_stat_activity`、WALWrite/WALSync、连接池等待、Pod CPU throttling、Endpoints/Ready
变化，不执行迁移、重启或压测。

## 4. 日志关联和代理配置

首选 W3C `traceparent`；若现有组件不接受它，统一透传 `X-MX-Probe-Id` 和已有的
`requestId`。响应回显 probe ID。Nginx 采样日志至少包含：

```nginx
log_format mx_probe escape=json
  '{"time":"$time_iso8601","probe_id":"$http_x_mx_probe_id",'
  '"request_id":"$request_id","host":"$host","request":"$request",'
  '"status":$status,"request_time":$request_time,'
  '"upstream":"$upstream_addr",'
  '"upstream_connect_time":"$upstream_connect_time",'
  '"upstream_header_time":"$upstream_header_time",'
  '"upstream_response_time":"$upstream_response_time",'
  '"bytes_sent":$bytes_sent}';
```

线上 `launcher` vhost 目前应先确认是否关闭了 access log。建议只给 `X-MX-Probe: 1` 的
采样请求配置独立日志文件，短期采集后关闭；不要恢复完整登录日志，也不要记录 Cookie、
Authorization、密码、订阅 URL 或查询中的凭据。Caddy 使用 JSON access log，保留 request
ID、duration、upstream status/duration。每次修改先执行 `nginx -t`、Caddy validate，再小范围
reload。

Launcher HTTP 层若能做最小插桩，只对带 `X-MX-Probe: 1` 的只读请求返回 `Server-Timing`，
例如 `app;dur=…`, `auth;dur=…`, `db;dur=…`，并把同样字段写结构化日志。当前没有通用 HTTP
access timing middleware，不能假定已有服务日志能给出这些数字。历史 incident 曾记录
identity introspect 单次 2.2–6.2 秒而 TCP 建连约 0.2 ms，因此 Admin 慢必须单独测
identity introspect/SSO/API，不能先归因于网络。

## 5. Luopan 全流程计时

在隔离 Luopan 测试客户端把现有 `performance.now()`/`LoginTiming` 扩展为一次连接记录，
不改变连接顺序和状态机：

```text
bootstrap_dns_http
product_registry
enrollment
snapshot
domestic_peer_sync
internal_direct_peer_sync (skipped/failed 也要记)
wireguard_apply_and_route
service_vip_healthz
first_business_api
total
```

`demos/luopan/src-electron/electron-main.ts` 已有对应调用点：
`requestLuopanLease()`、`syncLeasePeers()`、`applyElectronLauncherStandaloneDataPlane()` 和
`probeServiceVipHealth()`。记录 `status`, `durationMs`, `httpStatus`, `errorClass`,
`serviceVip`, `leaseIp`（脱敏或仅保留地址类别）和 `traceId`；不要记录 token、私钥或密码。
Luopan 的 `connectNetwork` 当前把 enrollment 与 snapshot 串行执行，每个网络 POST 的超时
约为 15 秒，后续分析要保留“串行等待”这一事实。

业务登录、`identity/introspect`、Oversea subscription 和首个数据 API 单列，不与
`/healthz` 混成“网络 ready”耗时。MX-H2I 的控制面/数据面约束保持不变。

## 6. 数据格式、统计和告警

每行 JSONL/CSV 至少包含：

```text
ts, probeId, traceId, product, scenario, vantage, target,
dns_ms, tcp_ms, tls_ms, send_ms, ttfb_ms, download_ms, total_ms,
status, bytes, remote_ip, reused_conn,
edge_request_ms, edge_upstream_connect_ms, edge_upstream_header_ms,
edge_upstream_response_ms, caddy_duration_ms, app_ms, auth_ms, db_ms,
wg_handshake_age_ms, wg_rx_bytes, wg_tx_bytes, route_check, error_class
```

按 `product × path × scenario(cold|warm) × vantage × hour` 计算 P50/P95/P99，并输出：

1. 公网端到端 waterfall；
2. edge、Domestic、Internal ingress、Pod/app 的嵌套耗时；
3. Luopan connect 各阶段耗时和失败率；
4. 按小时热图以及 `probeId` 到各侧日志的查询链接。

先采集 7 天再设阈值。可以先用当前文档中的目标作为观察线：重复连接 P95 < 300 ms，已授权
visit↔staff P50 < 5 s、P95 < 10 s；Luopan 另按 bootstrap、warm VIP healthz 和全连接建立
三组建立基线。告警先看 P95 相对基线增加 30% 或连续 3 个窗口失败，避免用单次网络抖动触发
变更。

## 7. 实施顺序和验收

1. 现场确认 `nginx -T`、Caddy listener、Internal gateway ownership、实际 launcher vhost
   是否生效；保存配置快照。
2. 先部署三处只读 healthz 探针和外部 `/admin/` 页面采样，不改应用和 H2I 数据面。
3. 增加短期采样 access log 与 probe ID 透传，跑冷/暖连接基线。
4. 只在隔离 Luopan 客户端增加阶段计时，验证 `serviceVip` `/healthz` 与首个业务 API。
5. 若代理耗时正常而 app/DB 异常，再开启带 `X-MX-Probe: 1` 的 `Server-Timing`；若入口异常，
   先修 Nginx/Caddy/端口归属，再看应用。
6. 每次发布前复测 MX-H2I 原账号登录、既有联网、PAC/DNS/NRPT 和 visit/staff 切换；测量代码
   失败只能丢失诊断，不得阻塞或改变连接结果。

这套顺序可以回答“慢在公网、Domestic、WG、Internal ingress、Pod、身份校验还是数据库”，
同时把网络路径和 MX-H2I 的用户登录/联网行为隔离开。
