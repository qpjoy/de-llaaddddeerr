# System Proxy 与供应商出网

Agent 中的 LLM Proxy 改名为 System Proxy，保留原路由和代理表。当前接入范围包括 Agent、TikHub、RapidAPI、Web Search 供应商与启信；不改变 JustOne、Launcher、MX-H2I 登录、联网和 DNS。

启信的独立绑定由迁移 `135_qixin_proxy.sql` 增加，默认系统网络、不继承全局代理；已配置的固定出口中继保持有效。选用正向代理后访问启信官方地址，仅在显式允许系统回退时再使用原中继。详见 [启信出网与余额检查](enterprise-qixin.md#出网代理与余额检查2026-10-09)。以下 TikHub 初始部署默认值不适用于启信。

## 部署与使用

正常执行 Hub 数据库迁移（076_external_platform_proxy.sql）并部署新服务与前端。迁移只在不存在时创建 `tikhub-internal-7788` Endpoint / Sequence，将 TikHub 单独绑定到 `http://127.0.0.1:7788`；不覆盖已有记录和全局策略。默认禁止直连回退。Public API 的 Internal Kubernetes 部署已使用 hostNetwork，因此该地址指宿主机代理。非 hostNetwork / Compose 环境请先改为容器可访问的宿主机地址；此默认值是本次 Internal 环境配置。

进入“外部数据平台 → TikHub → TikHub 出网代理”，可选：继承 System Proxy 全局设置、指定 Proxy Sequence、直接出网。填写原因保存后，下一次请求读取数据库新版本，无须重启。在“Agent 中心 → System Proxy”维护代理地址、顺序和直连回退。被 TikHub 引用的序列不能直接删除，须先改绑定。

服务显式选择优先于全局设置；继承全局时复用既有 Agent 解析器及部署代理快照、NO_PROXY。Docker daemon 代理不会自动注入 Node fetch，此处由应用明确创建 dispatcher。Public API 接收可选部署快照 MX_INSIGHT_AGENT_DOCKER_PROXY_SNAPSHOT。不会设置进程级全局 dispatcher。

## 探测策略（migration 095）

探测策略属于出网链路本身，所以默认值维护在 **System Proxy 的 Proxy Sequence** 上（Agent 中心 → System Proxy → 编辑 Sequence → 连通性探测策略）；需要为单个服务调整时，再到该服务的绑定页覆盖（外部数据平台 → TikHub → TikHub 出网代理 → 探测策略覆盖）。解析顺序是 **服务覆盖 → 所绑定 Sequence → 应用默认**，留空即继承，`0` 是一个明确取值而不是「未设置」。三项策略与应用默认：

| 策略 | 默认 | 含义 |
| --- | --- | --- |
| `probe_timeout_ms` | 15000 | 单次探测超时。必须大于链路真实握手耗时，否则会把正常但慢的出口判成不可达。旧版本硬编码 5 秒，是把稳定的 7788 判成 `proxy_routes_unreachable` 的主因。 |
| `probe_attempts` | 2 | 同一出口的探测次数。仅重试探测；付费业务请求仍然只发一次。 |
| `probe_cache_ttl_ms` | 0 | 复用上一次成功选路的时长。0 表示每次调用都探测。**开启会削弱计费证据**：跳过探测后，付费请求的失败从「明确未计费（rejected）」变成「结果未知（unknown）」。 |

两张表的列都可为 NULL，迁移不回填、不修改任何既有取值；二进制若先于迁移上线，会自动退回应用默认而不是让 TikHub 出网整体失败。

## 请求与计费边界

每次业务调用先解析绑定，按顺序请求固定小红书 search_notes 地址，不带 API Key、业务参数或调用者请求头。**探测只证明出口可达**：目标返回的任何 HTTP 状态（含 401/403/404/422/429/500）都算可达，只有代理自身产生的 407/502/503/504 才判定该出口不可用并换下一个。401 等接口响应只能证明出口及鉴权入口可达，不能证明令牌、余额或业务内容可用。选定出口后仅发送一次带凭据的业务请求；该请求超时或 5xx 不会触发换代理重试。探测失败会返回 proxy_routes_unreachable，不发送业务请求；调用统计仍可能包含这次连接尝试，不能将它当作成功计费。

探测全部失败时，每次失败的业务分发会向 `control.external_platform_proxy_probe_failures` 写一行（每次分发一行，不是每个候选一行，保留最近 200 条），记录出口标签、HTTP 状态或错误类型与耗时；出口标签只有 `scheme://host:port`，不含代理凭据。同样的明细会出现在 `proxy_routes_unreachable` 的 message 与 details 中，并在 TikHub 出网代理面板的「最近探测失败」里展示，无须登录节点排查。

迁移不会启用停用的业务操作，不会修改消费者授权、价格、预算和 API Key。部署后以一次笔记采集及对应调用记录验收业务成功；本次已有证据仅确认代理上的未认证请求返回 401，付费业务仍需部署后验证。

代理绑定修改仅允许 Admin Token，使用 revision 防止并发覆盖，原因与版本写入审计表。TikHub 管理 DTO 只返回序列标识和状态，不返回代理凭据；Public runtime 不加载 LLM Provider 密钥。

## 扩展方案：Domestic 出网反代（固定公网出口 IP）

System Proxy 解决的是「换一个出口」，本节解决的是「出口必须是某个固定公网 IP」。上游按 IP 白名单准入时属于后者，启信宝的 `status=104`、`未添加IP白名单` 是已观测到的实例（见 enterprise-qixin.md）。Internal 直连上游时出口是内网机房 IP，不在白名单内；把调用绕回 Domestic，上游看到的就是 Domestic 固定的公网出口 IP。

两者是两种形态，不互相替代。System Proxy 是**正向代理**：URL 不变，应用显式创建 undici dispatcher，TLS 端到端到上游，凭据不落在中间任何一跳。出网反代是**反向代理**：应用把 URL 重写到自己的边缘，由边缘代为发起，TLS 在边缘终止再重建。能用 dispatcher 就优先用 dispatcher；只有当边缘已经是既有链路、且愿意承担凭据经过边缘的代价时，反代才更划算。

链路是 Hub 入站链路的镜像，边缘配置在 compass 仓库 `compass/deploy/nginx/conf.d/90-egress.conf`：

```text
入站  公网 -> Domestic nginx -> WireGuard -> 10.88.88.88:80 -> 127.0.0.1:18150
出站  Hub pod -> WireGuard -> 10.88.0.1:8081 -> Domestic nginx -> https://api.qixin.com
```

边缘只在 WireGuard 地址上发布 `10.88.0.1:8081`，公网不可达。路径以 `/u/<平台>/` 前缀区分上游，原路径与 query string 透传：`/u/qixin/APIService/v2/search/advSearch` 到达上游是 `/APIService/v2/search/advSearch`。Internal Nginx 不在这条路径上，无需改动——出站是 hostNetwork pod 经宿主 wg0 直接到 Domestic。

三条约束来自 `server/adapters/qixin.mjs`，换其它上游前要逐条复核：

- **签名不绑 Host。** 启信宝 Auth 2.0 的 `sign = md5(appkey + timestamp + secret_key)`，不含 Host、路径或 body，以请求头发送，因此经反代不会失效。若某个上游把 Host 或完整 URL 纳入签名，反代方案直接不可用，只能走 dispatcher。
- **不能产生 3xx。** 适配器 fetch 使用 `redirect: 'error'`，任何重定向都是硬失败而非被跟随。边缘不做斜杠规整、不返回 `30x`。
- **超时与体积。** 适配器 30 秒超时、响应上限 16 MiB，边缘的读超时与缓冲区按此设定，比调用方更宽松即可，调用方的 AbortSignal 才是权威。

代价是 `appkey`、`timestamp`、`sign` 三个请求头以明文经过 Domestic 的 nginx（`secret_key` 本身不出网），在 timestamp 有效期内可被重放。边缘日志格式因此只记 `$uri` 不记 `$args`。System Proxy 的 dispatcher 方案没有这个暴露面，这是选型时的主要权衡点。

启用需要的应用改动，按最小面计：`server/adapters/qixin.mjs` 的 origin allowlist 保留对目录 URL 的校验，之后把传输目标重写到 egress base；`server/index.mjs` 构造 `QixinAdapter` 时传入；`server/config.mjs` 读取环境变量；`tests/server/enterprise-qixin.test.mjs` 两处 origin 断言补分支；Deployment 补环境变量。不要放宽 allowlist 本身——它是合同校验，重写发生在校验之后。

上线顺序：**边缘必须先于 Hub**。Hub 切到 egress base 时若 8081 尚未发布，企业数据全部连接失败。顺序是发布边缘并验证可达、上游侧加白名单、再部署 Hub、最后用一次真实查询验收。

路由与探测现已在 `server/external-platforms/proxy.mjs` 按 provider 固定目标地址。启信先选择代理路由，再仅对系统网络分支应用中继重写；不会放宽目录地址校验或自动覆盖已有中继配置。

## 同一云端出口：Nginx 中继与正向代理

现有 `/u/qixin` 是 HTTP 反向代理路径，不能直接填成 Proxy Sequence 的正向代理地址。若在同一台云主机另行部署支持 HTTP CONNECT 的正向代理，可把它的代理端口配置成独立 Endpoint / Sequence；保留原 Nginx 中继，使用启信的主出口选择在二者之间切换。Hub 每次派发读取配置，已发送请求继续原路径，不中断、迁移或重复发送。

只有两者最终使用同一公网 IP / NAT，且正向代理对 `api.qixin.com` 直接出网而不再串联海外节点时，启信看到的来源 IP 才相同。供应商记录才是出口证据；私网中继地址、代理监听地址和普通查 IP 服务返回值不能替代按目标验证。

| 项目 | 现有 Nginx 中继 | HTTP CONNECT 正向代理 |
| --- | --- | --- |
| 维护与切换 | 复用现有 Nginx，每个供应商维护固定转发规则 | 需另行维护代理服务、访问控制，可统一用 Sequence 管理多个供应商 |
| 请求内容 | Nginx 接收业务请求后重新向上游发起，能看到请求头和正文；现有内网段由 WireGuard 承载 | 不启用 TLS 解密时，Hub 与启信建立端到端 TLS，代理只转发隧道流量 |
| 观测 | 可记录具体 HTTP 状态、路径和回源耗时，需避免记录签名/参数 | 主要观察 CONNECT、连接耗时和字节数；业务证据仍由 Hub 保存 |
| 可用性 | 依赖原 Nginx 与隧道 | 依赖新代理服务与隧道；同机部署仍共享主机故障，不能当成独立容灾 |
| 延迟与成本 | 经云端转发 | 同样经云端转发；多一层 CONNECT 不保证更快或更便宜，需实际测量 |

原理依据：[Nginx 反向代理](https://docs.nginx.com/nginx/admin-guide/web-server/reverse-proxy/)与 [Squid HTTPS / CONNECT](https://wiki.squid-cache.org/Features/HTTPS)。建议先保留已运行的中继，再独立准备只对受信内网开放的正向代理并验证启信出口；确认后显式切换。当前改动没有创建或启用云端正向代理，也没有触发企业查询。
