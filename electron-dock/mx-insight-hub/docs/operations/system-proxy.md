# System Proxy 与 TikHub 出网

Agent 中的 LLM Proxy 改名为 System Proxy，保留原路由和代理表。当前接入范围是 Agent 与 TikHub；不改变 JustOne、Launcher、MX-H2I 登录、联网和 DNS。

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

平台数量增长后，更好的归宿是把 `server/external-platforms/proxy.mjs` 的路由与探测泛化成按 provider 配置——它目前硬绑 `https://api.tikhub.io`。届时反代与 dispatcher 可以在同一套绑定界面里按服务选择，本节方案退化为其中一种出口类型。
