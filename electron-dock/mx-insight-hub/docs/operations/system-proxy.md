# System Proxy 与 TikHub 出网

Agent 中的 LLM Proxy 改名为 System Proxy，保留原路由和代理表。当前接入范围是 Agent 与 TikHub；不改变 JustOne、Launcher、MX-H2I 登录、联网和 DNS。

## 部署与使用

正常执行 Hub 数据库迁移（076_external_platform_proxy.sql）并部署新服务与前端。迁移只在不存在时创建 `tikhub-internal-7788` Endpoint / Sequence，将 TikHub 单独绑定到 `http://127.0.0.1:7788`；不覆盖已有记录和全局策略。默认禁止直连回退。Public API 的 Internal Kubernetes 部署已使用 hostNetwork，因此该地址指宿主机代理。非 hostNetwork / Compose 环境请先改为容器可访问的宿主机地址；此默认值是本次 Internal 环境配置。

进入“外部数据平台 → TikHub → TikHub 出网代理”，可选：继承 System Proxy 全局设置、指定 Proxy Sequence、直接出网。填写原因保存后，下一次请求读取数据库新版本，无须重启。在“Agent 中心 → System Proxy”维护代理地址、顺序和直连回退。被 TikHub 引用的序列不能直接删除，须先改绑定。

服务显式选择优先于全局设置；继承全局时复用既有 Agent 解析器及部署代理快照、NO_PROXY。Docker daemon 代理不会自动注入 Node fetch，此处由应用明确创建 dispatcher。Public API 接收可选部署快照 MX_INSIGHT_AGENT_DOCKER_PROXY_SNAPSHOT。不会设置进程级全局 dispatcher。

## 请求与计费边界

每次业务调用先解析绑定，按顺序请求固定小红书 search_notes 地址，不带 API Key、业务参数或调用者请求头。每个探测最多 5 秒，受原 TikHub 总超时约束。401 等接口响应只能证明出口及鉴权入口可达，不能证明令牌、余额或业务内容可用。选定出口后仅发送一次带凭据的业务请求；该请求超时或 5xx 不会触发换代理重试。探测失败会返回 proxy_routes_unreachable，不发送业务请求；调用统计仍可能包含这次连接尝试，不能将它当作成功计费。

迁移不会启用停用的业务操作，不会修改消费者授权、价格、预算和 API Key。部署后以一次笔记采集及对应调用记录验收业务成功；本次已有证据仅确认代理上的未认证请求返回 401，付费业务仍需部署后验证。

代理绑定修改仅允许 Admin Token，使用 revision 防止并发覆盖，原因与版本写入审计表。TikHub 管理 DTO 只返回序列标识和状态，不返回代理凭据；Public runtime 不加载 LLM Provider 密钥。
