# Agent 中心：Provider、Sequence 与 Proxy

HanLP、Hub Agent 和向量检索是三条独立链路。HanLP 安装成功只代表中文
分词服务可用，不会自动启用大模型、逐条分类或 embedding。

Agent 中心是 Hub 内部模型能力的唯一管理入口。Agent Market、文件字段建议、固定省份
分析、在线语义检索和 embedding projector 都继续调用同一个 `AgentRuntime` 兼容门面；
业务代码不读取 Key，也不各自实现 fallback。Provider Catalog 只是账号目录，第一条记录
不会成为系统默认；只有显式绑定的 LLM Sequence 才能承接未指定 Sequence 的模型调用。
若控制面 migration 尚未可用，滚动部署窗口才临时保留旧 Catalog 顺序兼容；正常控制面
可用但未设置默认时，通用模型调用 fail closed，拥有确定性降级的旧消费者继续降级。

| 消费者 | 能力 | 当前边界 |
| --- | --- | --- |
| Agent Market | Chat，可选 Embedding | Admin-only `--dry-run`；可显式选择 LLM Sequence，模型/检索失败只产生阶段降级，不写 canonical、queue、outbox 或 usage |
| 文件字段映射/文件画像 | Chat | 管理员显式启用；模型只收到列名、类型族和聚合结构信号，不收到原始值，建议仍需人工批准 |
| 全国省份分析 | Chat | 规则优先、歧义才送模；其 durable completion 最终可能写 assertion、current state 与 projection outbox，所以仍保持原 pipeline 开关、证据校验和重试语义 |
| 在线混合检索 | Embedding | Admin 检索可生成查询向量；没有 provider 时保持 lexical-only，原搜索 API 契约不变 |
| Embedding projector | Embedding | 异步写 PG 向量并投影 ES；继续强制同模型、同维度和 revision fence，模型不可用不阻塞 canonical 入库 |
| Provider/Sequence 测试 | Chat/Embedding | 使用固定、无业务数据请求；精确测试选中的 Provider，不会因其他 fallback 成功而误报 |
| 中文分词 | 非 LLM | HanLP 是独立链路，不读取 Provider/Sequence；Agent 中心变更不会改变严格分词、pending/backoff 或 quarantine 行为 |

## 界面结构

一级菜单「Agent 中心」包含：

1. **LLM Provider**：保存多个账号、模型和调用协议。Chat 支持 OpenAI-compatible
   （OpenAI、DeepSeek、Kimi 等兼容接口）及 Anthropic Messages；Embedding 只允许
   OpenAI-compatible。Anthropic 的 temperature 上限为 1；Agent Market Trace 会同时
   显示请求值与实际下发值。Chat/Embedding 分别以页面内 Catalog 表格管理；新建和编辑
   只展开当前 Provider 的内联表单，不再用整条 Catalog 的弹窗。Catalog 顺序只用于
   目录管理；即使只有一个 Provider，也应通过仅含一项的 Sequence 提供服务。
2. **LLM Sequence**：把已保存 Provider 按顺序组成可复用服务。保存和设为业务默认前
   会逐个执行精确连接测试；至少包含一个 Provider。`say hi` 会走完整 Sequence，展示
   实际响应的 Provider、模型和延迟。存在未保存修改时，按钮会先用 CAS 保存当前草稿，
   再强制刷新并测试同一 revision，避免测试旧链；手动测试可作为已打开熔断器的恢复探测。
   创建或保存记录不会自动设置默认；Chat 与 Embedding 的业务默认都可显式设置或清除。
3. **LLM Proxy**：维护无凭据的 HTTP/HTTPS Proxy endpoint 和有序 Proxy Sequence。
   Provider 指定的 Proxy Sequence 优先于 Hub 全局值；链中代理仅在 transport 失败时
   尝试下一个，是否最后使用系统出网由显式开关决定。Proxy 整体可不配置：Hub 全局和
   Provider 都未绑定时，Node 请求使用容器的系统出网。endpoint 和 Sequence 都支持
   页面内新建、编辑、删除；全局绑定与逐 Provider 绑定独立显示。
4. **Agent Market**：进阶搜索教学 demo。可选具体 LLM Sequence；不选择时只使用显式的
   Chat 业务默认。若未设置可用默认，模型阶段确定性降级，不会偷选第一条记录。
5. **原中心 Agent**：保留既有 pipeline、断言和处理边界，迁移期间不改变业务开关。

## 第一次启用

先完成一次经过批准的 Hub 部署，让 migration 建立 Agent 设置表及默认暂停的分析表，
并让 API/projector 运行新版本：

```bash
cd electron-dock/mx-insight-hub
bash scripts/manage.sh deploy
```

部署启动后，`MX_INSIGHT_AGENT_AUTO_MIGRATE=1` 会尝试把现有
`MX_INSIGHT_AGENT_PROVIDERS` / `MX_INSIGHT_EMBEDDING_PROVIDERS` 及其引用的环境 Key
原样导入 PostgreSQL，并生成未绑定的 `mx-default-chat` / `mx-default-embedding` 兼容
Sequence 候选；它们不会自动成为业务默认。migration 042 只会把旧版本以
`environment-bootstrap` 创建的精确默认绑定改成带 revision 的空 tombstone；管理员曾
显式设置的默认保持不变。
导入是幂等竞争安全的：多个 API/worker 同时启动只有一个 revision 获胜。旧配置包含
数据库策略不接受的 URL、ID 或缺失 Key 时会跳过导入并继续使用环境 catalog，不阻断
进程启动。

然后用 **Hub admin token** 登录管理台，打开「Agent 中心」：

1. 在 LLM Provider 确认自动导入结果，或新建 Provider。Base URL 必须是 API 根地址；
   Anthropic 使用 `https://api.anthropic.com/v1`，不要填写 `/messages`。被 LLM Sequence
   引用的 Provider 不能删除，必须先从对应 Sequence 移除。
2. 逐个执行连接测试。测试只访问选中的 Provider；已停用但凭据完整的候选也可隔离测试。
3. Proxy 是可选项。不需要应用级代理时保持 Hub 全局和 Provider 未绑定，此时请求走容器
   的系统出网；如需代理，再新建 endpoint、加入 Proxy Sequence，并显式绑定为 Hub 全局
   或 Provider 专属出口。仅创建第一条 endpoint/Sequence 不会改变任何请求路径。
4. 在 LLM Sequence 拖动 Provider 手柄组成顺序，执行「验证并保存」或「保存并设为业务默认」。
   只保存记录不会改变业务默认；默认可以随时显式清除。
   `say hi` 报 `transport failure` 时先看页面显示的当前配置路由；若已绑定的 Proxy Sequence
   没有已启用 endpoint，请求会 fail closed，不会绕过代理使用系统出网。把 endpoint 加入链并启用后再测。
5. Agent Market 可显式选择一个 Chat Sequence 做 dry-run；保留空项时只读取 Chat 业务
   默认。正常控制面没有默认、默认过期或显式选择过期时都不会回到 Catalog 顺序：
   Agent Market 的模型阶段确定性降级，通用调用 fail closed，避免悄悄扩大或改写顺序。
6. Admin API 立即刷新；projector 和 classifier 最迟在下一个轮询周期采用同一数据库
   revision，无需修改 `.env` 或重启。

正常保存返回 `200`，表示当前 Admin API 已采用新 revision。若数据库提交已经成功、
但该进程暂时无法重新读取并验证新配置，接口返回 `202` 和
`runtimeApplied: false`：被修改的 Agent 能力会先安全停用，后台轮询会继续应用同一
revision；这不是要求再次保存，也不会影响 canonical 入库、HanLP 或登录链路。

当前 `bash scripts/manage.sh deploy` 会应用并重启独立的 classifier Deployment；它没有
Service/Ingress，数据库 pipeline 仍强制全局单飞。classifier rollout 失败只产生 warning，
不会把 API/ingest 部署判为失败，durable backlog 保留。生产仍需检查真实 Pod、模型
Secret 和 provider egress；不要把 API 中出现暂停的 `province-geography-v1`、manifest
存在或 provider 测试成功解释为该环境已经完成分类。

Launcher 平台管理员可以查看脱敏状态，但不能修改 Provider 或 Key。写入只接受
Hub admin token。设置 API 不接受 `apiKeyEnv`、Secret 名称、Launcher 配置、数据库
URL 或任意环境变量名。

## 全国省份分析 pipeline

完整的首次全量、增量、raw revision、分类限流、失败恢复和人工审核边界见
[全国省份舆情固定源运维手册](province-public-opinion-ingestion.md)。这里只说明 provider
侧行为：

- pipeline 默认 `paused`，默认 12 items/min、数据库全局 `maxInFlight=1`；它是 item
  dispatch 限制，不是 provider RPM/TPM、日 token 或费用预算。
- 每条任务先跑本地规则，只有省份证据缺失或冲突时调用 Chat provider；模型只收到
  有界语义投影，不收到整行 raw。
- enabled providers 按显式业务默认 Sequence 的顺序尝试。transport/timeout、无效 JSON、401/403/404、
  429 和 5xx 会 fallback；普通 4xx 不 fallback。
- 每个 provider 默认 timeout 60 秒，可设 1–300 秒；连续 3 次失败后在当前进程熔断
  60 秒。API 与 classifier 各有 process-local circuit，管理页看到的 API circuit 不能
  代替 worker 日志/状态。
- provider test 使用固定、无业务数据的小请求并且只测指定 provider。它可能仍产生
  provider 侧调用/计费，也不能证明 classifier Pod 拥有相同的 Secret 和网络出口；
  同一 provider 单飞、测试后冷却 5 秒，单进程最多同时探测 2 个 provider。
- 测试证据绑定精确的 Provider settings revision 与 Proxy 控制面 SHA-256 指纹，最多复用
  15 分钟；长测试期间发生热刷新不会把旧 Key/旧出口的成功记到新 revision。
- Chat/Embedding 的 HTTP 2xx 仍必须通过语义校验；空 chat 内容、向量数量/index/维度/
  非有限值或返回 model 不匹配都会把该 provider 记为失败并允许健康的下一候选 fallback。
- rule/Agent assertion 默认只是 `proposed`。当前 API 可读列表但没有 accept/reject
  writer，assertion 也不投影到 canonical/public serving；不要用临时 SQL 代替审核。

## Key 行为

- Key 按当前运维策略以明文保存到独立数据库凭据表。
- 常规 GET、PUT 响应、日志和管理界面只显示 `keyConfigured`。
- 唯一明文读取路径是 Admin listener 的 Provider reveal：当前会话必须本身是 Admin Token，
  且请求体再次提交并恒定时间校验同一个 Hub Admin Token。Launcher platform-admin 不能
  使用该接口；响应设置 `no-store`，关闭弹窗即清除组件状态。
- 密钥输入框永远为空；留空表示保留数据库中的当前值，清除必须显式选择。
- Provider 地址切换到另一个 origin 时，必须同时输入新 Key 或显式清除，旧 Key 不会发送到新主机。
- 数据库 dump、WAL、备份、只读副本和恢复介质因此都是 credential-bearing 资产，必须加密、限权并审计。

当前 Hub 工作负载仍共享同一个数据库 owner DSN，因此独立表只能减少 HTTP 和普通
查询误泄漏，不能提供 Pod 级数据库隔离。后续应拆分 migration owner、Agent 配置写
角色、Agent runtime 读角色，并让不需要模型凭据的 workload 没有凭据表的 `SELECT`
权限。

Provider Base URL 也是高权限网络配置：当前只允许 Hub admin token 写入，并拒绝明文
HTTP、userinfo、localhost 和 IP literal，但 DNS 名称仍可能解析到内网地址。因此不要
把该写权限下放给租户管理员；若以后需要下放，必须先增加受信 hostname allowlist，
并在 Pod egress 层拒绝 metadata、loopback、link-local 和非批准的私网网段。

## Proxy 与 K8s

Proxy URL 不保存账号密码，也不接受 query、fragment 或 path。应用级代理优先级为：
Provider 专属 Proxy Sequence → Hub 全局 Proxy Sequence。两者都未绑定时，请求不附加
应用 Proxy dispatcher，使用 Node/容器的系统出网；若已绑定代理链，则只有该链明确打开
`directFallback` 时，所有代理 transport 失败后才回到系统出网。代理切换
只处理 DNS、连接、TLS、timeout 等 transport 失败；上游 HTTP 401/403/404/429/5xx
仍按 LLM Sequence 的 Provider fallback 规则处理，避免同一 Provider 经多个代理重复计费。

新建或重新绑定的 Proxy Sequence 至少需要一个已启用 endpoint；只需要系统出网时应清除
全局/Provider 绑定，而不是保存空链。历史空链仍可在界面中查看、修复或删除，但不能再次
设为全局或 Provider 绑定。删除使用 revision CAS，且 endpoint 被任一 Proxy Sequence 引用、
或 Proxy Sequence 被全局/任一 Provider 引用时返回 `409`，不会级联修改现有出口策略。
同样地，已被全局或 Provider 引用的 Proxy Sequence 不能直接停用；必须先解除绑定。

内部 K8s 的 Admin API、classifier 和 projector 使用 `hostNetwork`，所以
`http://127.0.0.1:7890` 指向节点上的代理。Compose 不共享宿主网络，应填写
`http://host.docker.internal:7890`；compose 已注入 `host-gateway`。多节点 K8s 部署前必须
保证每个可调度节点都有等价代理，或把 Proxy endpoint 改为集群可路由地址。

Kubernetes 对 `hostNetwork` Pod 与 `podSelector` / `namespaceSelector` 的匹配取决于 CNI；
当前部署脚本因此继续强制单节点，worker 不暴露 Service/端口，并依赖节点防火墙作为额外
边界。HanLP 部署 smoke 仍验证 Service DNS 和真实 tokenize 响应，但不把这次请求误报为
普通 Pod 网络的 namespaceSelector 验证。改成多节点前需同时重新评审这一网络边界。

Proxy 配置只影响 LLM HTTP 出口，不修改 Docker daemon 的代理、Pod DNS、Launcher、
WireGuard 或 MX-H2I 用户网络。Provider 引用了不存在/停用的专属 Proxy Sequence 时会
禁止系统出网 fallback；已显式绑定但失效的全局 Proxy 也会 fail closed。全局和 Provider
都未绑定时才使用系统出网。尤其要注意，`/etc/systemd/system/docker.service.d/` 配置的是
Docker daemon 拉取镜像的代理，不会自动注入 Node/K8s Pod；若系统出网需要 HTTP proxy，
必须在容器运行环境单独配置，或显式使用这里的 Proxy endpoint/Sequence。

## Embedding 的不可热切换项

Embedding 的 Key、HTTPS 地址、超时、启停和同一模型的 failover 顺序可以热更新；
模型或维度不能直接切换。Elasticsearch `dense_vector` 的维度固定，即使两个模型维度
碰巧相同，它们的向量空间也可能不可比较。设置接口会拒绝这类变化并返回需要 reindex
的错误。

首次发现 environment Embedding 链时，运行时会把模型和 dimensions 作为向量空间锁
并发安全地写入 PostgreSQL；后续重新部署即使整条环境链同时改名，也不能绕过该锁。
`MX_INSIGHT_EMBEDDING_MODEL` 与 `MX_INSIGHT_EMBEDDING_DIMENSIONS` 若已配置，还会作为
environment 链的显式期望值参与启动校验。

确需更换 embedding 模型时，必须走受控流程：暂停 embedding 写入、创建新版本索引、
使旧 PG 向量失效、全量重新 embedding、验证召回质量，然后切换 alias。该流程完成前
不要只改 `MX_INSIGHT_EMBEDDING_DIMENSIONS`。

## Environment 回滚

现有 `MX_INSIGHT_AGENT_PROVIDERS`、`MX_INSIGHT_EMBEDDING_PROVIDERS` 和模型 Key
Secret 继续作为兼容与回滚路径。将某条链的来源切回 `environment` 后，它重新读取
进程启动时的环境配置，并删除该能力的数据库凭据；引用旧数据库 Provider ID 的显式
Sequence 因此会失效而不是继续使用 last-known-good 密钥。环境变量本身发生变化仍需
重新部署。紧急情况下可设置 `MX_INSIGHT_AGENT_AUTO_MIGRATE=0` 禁止下一次启动自动导入。

`MX_INSIGHT_SYNC_LAUNCHER` 与 Agent 设置无关，保持默认 `0` 即可。保存动态设置不会
运行部署脚本、写 Launcher Secret、重启 Launcher 或修改 MX-H2I 登录/联网链路。

## 安全验收

至少确认：

- `GET /internal/v1/admin/agent` 的响应中没有 Key、`apiKeyEnv` 或 Secret 名称；
- reveal 只有 Admin Token 会话并重新输入正确 Token 才返回明文，响应不可缓存；
- 单 provider 测试失败时不会 fallback，成功响应不包含模型 payload/vector；
- Provider/Sequence/Proxy 记录都不会因为位于列表第一条而成为默认；默认只能显式设置，也可清除；
- Sequence 保存会验证全部 Provider；正常控制面无默认或默认过期时不会兼容回退 Catalog；
- Provider 专属 Proxy 缺失时不会绕过代理使用系统出网，Proxy transport fallback 顺序可观测；
- Launcher platform-admin 可读但写设置返回 `403 admin_token_required`；
- 旧 revision 写入返回 `409`，不会覆盖另一管理员的更新；
- 非法 URL、未知字段和客户端提交的 `apiKeyEnv` 被拒绝；
- 数据库或新配置暂时不可用时，进程保留 last-known-good，Hub readiness、canonical ingest 和 MX-H2I 登录不受影响；
- analysis pipeline 保持暂停时，部署/保存 provider 不会创建模型任务；classifier 停止时固定源同步和严格 HanLP 投影仍独立运行。
