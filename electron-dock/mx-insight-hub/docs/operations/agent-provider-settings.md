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
| Provider/Sequence 测试 | Chat/Embedding | 使用固定、无业务数据请求；可一次性明确选择继承部署默认、Pod/Node 系统出网或某个 Proxy Sequence，精确测试选中的 Provider，不会改绑定或因其他 fallback 成功而误报 |
| 中文分词 | 非 LLM | HanLP 是独立链路，不读取 Provider/Sequence；Agent 中心变更不会改变严格分词、pending/backoff 或 quarantine 行为 |

## 界面结构

一级菜单「Agent 中心」包含：

1. **LLM Provider**：保存多个账号、模型和调用协议。Chat 支持 OpenAI-compatible
   （OpenAI、DeepSeek、Kimi 等兼容接口）及 Anthropic Messages；Embedding 只允许
   OpenAI-compatible。Anthropic 的 temperature 上限为 1；Agent Market Trace 会同时
   显示请求值与实际下发值。Chat/Embedding 分别以页面内 Catalog 表格管理；新建和编辑
   只展开当前 Provider 的内联表单，不再用整条 Catalog 的弹窗。Catalog 顺序只用于
   目录管理；即使只有一个 Provider，也应通过仅含一项的 Sequence 提供服务。Embedding
   可以显式引用一个数据库管理的 Chat Provider，复用其 Endpoint、协议、凭据、超时和
   兼容 Proxy 绑定，但不会复制 Key，也不会继承 Chat 模型；Embedding 模型和 dimensions
   始终独立保存。能力目录把连接/模型标为“支持”“不支持”或“需要连接测试”：已知不支持
   的选项不能保存，未知 OpenAI-compatible 网关仍可保存，但加入业务 Sequence 前必须实测。
2. **LLM Sequence**：把已保存 Provider 按顺序组成可复用服务，并显式保存三态网络策略：
   继承部署默认、Pod/Node 系统出网，或一个有序 Proxy Sequence 作为该服务统一的专属出口。保存和设为业务默认前
   会逐个执行精确连接测试；至少包含一个 Provider。`say hi` 会走完整 Sequence，展示
   实际响应的 Provider、模型和延迟。存在未保存修改时，按钮会先用 CAS 保存当前草稿，
   再强制刷新并测试同一 revision，避免测试旧链；手动测试可作为已打开熔断器的恢复探测。
   创建或保存记录不会自动设置默认；Chat 与 Embedding 的业务默认都可显式设置或清除。
3. **LLM Proxy**：维护无凭据的 HTTP/HTTPS Proxy endpoint 和有序 Proxy Sequence。
   endpoint 通过专用手柄拖入 Sequence，并可按插入位置拖拽排序或拖出移除；卡片、表单和
   滚动区域本身不可拖。新业务配置由 LLM Sequence 选择网络策略；继承模式依次解析
   Provider 专属兼容绑定 → Hub 应用策略 → 部署时观测的 Docker daemon 生效代理 →
   Pod/Node 系统出网。显式系统出网会终止继承；专属代理链也不会混入低优先级代理。
   是否在整条代理链传输失败后使用 Pod/Node 系统出网由显式开关决定。Proxy 整体可不配置，
   创建第一条记录也不会自动绑定。
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
   引用的 Provider 不能删除，必须先从对应 Sequence 移除。创建 Embedding Provider 时可
   选择“独立配置”，也可选择一个数据库管理的 Chat Provider 作为连接来源；选择继承不会
   把 Chat Key 返回浏览器或另存一份，且不会自动选择第一条 Chat Provider。
2. 逐个执行连接测试。测试只访问选中的 Provider；在 LLM Proxy 页面还可明确选择
   「继承部署默认」「Pod/Node 系统出网」或某个已保存 Proxy Sequence 做一次性严格测试。
   这些选项都不默认第一条，
   不保存绑定，也不产生可供业务 Sequence 复用的验证证据。
3. Proxy 记录是可选项。LLM Sequence 默认继承部署策略：兼容 Hub/Provider 都未覆盖时，
   会使用部署时只读观测的 Docker daemon 生效代理；daemon 未配置或目标命中 NO_PROXY 时
   才使用 Pod/Node 系统出网。若需要明确绕过 daemon，选择「Pod/Node 系统出网」。如需应用代理，新建 7788、7890 等
   endpoint，用专用手柄组成 7788-only、7890-only、7788→7890 等 Proxy Sequence；仅创建
   记录不会改变任何请求路径。
4. 在 LLM Sequence 拖动 Provider 手柄组成服务顺序，并按业务需要选择继承、系统出网或
   一个专属 Proxy Sequence，然后执行「验证并保存」或「保存并设为业务默认」。即使只有一个 Provider，
   也把它放入单项 LLM Sequence；业务不直接绑定单个 Provider。
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
- Chat provider 和 Sequence 的测试使用与普通 Hub completion 一致的 1024 token 输出上限，
  避免 DeepSeek V4 等默认先生成 `reasoning_content` 的模型在最终 `content` 前被 8/32 token
  截断而误报失败。测试仍要求非空最终 `content`；仅有思维链不会被当作成功，也不会写入错误或日志。
- 测试证据绑定精确的 Provider settings revision 与待保存 LLM Sequence 有效出网路由的
  SHA-256 指纹，最多复用 15 分钟。LLM Sequence 三态策略、兼容 Provider/Hub 绑定、
  endpoint URL/启停/顺序或 direct fallback 发生变化都会使对应 proof 失效；未绑定的 Proxy
  目录项不会使继承/系统出网证据失效。部署观测的 Docker daemon 功能值发生变化时只会
  使继承该值的 proof 失效；显式系统出网和显式 Proxy Sequence 不受影响。长测试期间发生
  热刷新不会把旧 Key/旧出口的成功记到新 revision。
- migration 043 不会给旧 Sequence 伪造路由 proof；migration 044 将无专属 Proxy 的旧记录
  回填为 `inherit`、有专属 Proxy 的记录回填为 `proxy-sequence`，也不会伪造新 proof。
  这类兼容记录会在界面标成「需重验」，
  下一次「验证并保存」或 `say hi` 前保存会生成精确 proof。为避免滚动升级直接中断旧业务，
  旧记录在完成首次重验前仍按先前路由运行；重验后只有 Provider 配置或实际生效的出网
  路由改变才会再次失效。
- 部署 043/044 时先让 migration、Admin、classifier 与 projector 全部完成同一版本 rollout，再开放
  Agent 配置写入；旧 worker 不认识 LLM Sequence 的专属 Proxy 字段，混合版本窗口内不要新建或
  修改该绑定。标准 `manage.sh` 会先等待 migration Job，再滚动工作负载，运维仍应等整次部署成功。
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

应用创建的 Proxy URL 不保存账号密码，也不接受 query、fragment 或 path。业务调用先解析
LLM Sequence，再按「首个显式命中即终止」决定出口：请求级一次性覆盖 → LLM Sequence
三态策略 → 兼容 Provider 专属 Proxy Sequence → Hub 应用策略 → 部署观测的 Docker daemon
代理 → Pod/Node 系统出网。显式 Sequence 专属链不会混入 Provider/Hub/daemon 的低优先级
代理；显式系统出网也会直接绕过这些层。若已选择代理链，只有该链明确打开
`directFallback` 时，所有代理发生可重试传输异常后才回到 Pod/Node 系统出网，而不是重新继承 daemon。

链中遇到 DNS、连接、TLS、timeout 等 transport 异常时会继续下一个代理。任何 HTTP 响应
都按 Provider 响应处理：无法可靠区分代理合成的 5xx 与代理转发的上游 5xx，因此不会换代理
重放同一个可能计费、非幂等的 LLM 请求。HTTP 5xx 保持既有 Provider 级 fallback；
401/403/404/429 也不会换代理重复请求。调用方 abort 立即停止，不继续代理或 Provider fallback。

新建或重新绑定的 Proxy Sequence 至少需要一个已启用 endpoint；只需要系统出网时应在
LLM Sequence 或 Hub 应用策略明确选择「Pod/Node 系统出网」，而不是保存空链。历史空链仍可在界面中查看、修复或删除，
但不能再次绑定。删除使用 revision CAS，且 endpoint 被任一 Proxy Sequence 引用、或 Proxy
Sequence 被任一 LLM Sequence 以及兼容全局/Provider 引用时返回 `409`，不会级联修改现有
出口策略。同样地，被引用的 Proxy Sequence 不能直接停用；必须先解除全部绑定。

内部 K8s 的 Admin API、classifier 和 projector 使用 `hostNetwork`，所以
`http://127.0.0.1:7890` 指向节点上的代理。部署脚本从 `docker info` 只读采集 Docker
daemon 当前生效的 HTTP/HTTPS/NO_PROXY，并通过只供 Agent 使用的 Secret 快照注入这三个
工作负载；不会设置进程级 `HTTP_PROXY`，因此不会改写 Night-All、PG、ES 或 Launcher 请求。
`systemctl` 仅用于展示可能的 DropIn 路径，不会 source、修改或重启 systemd/Docker。
Compose 不共享宿主网络，应填写
`http://host.docker.internal:7890`；compose 已注入 `host-gateway`。多节点 K8s 部署前必须
保证每个可调度节点都有等价代理，或把 Proxy endpoint 改为集群可路由地址。

Kubernetes 对 `hostNetwork` Pod 与 `podSelector` / `namespaceSelector` 的匹配取决于 CNI；
当前部署脚本因此继续强制单节点，worker 不暴露 Service/端口，并依赖节点防火墙作为额外
边界。HanLP 部署 smoke 仍验证 Service DNS 和真实 tokenize 响应，但不把这次请求误报为
普通 Pod 网络的 namespaceSelector 验证。改成多节点前需同时重新评审这一网络边界。

Proxy 配置只影响 LLM HTTP 出口，不修改 Docker daemon 的代理、Pod DNS、Launcher、
WireGuard 或 MX-H2I 用户网络。界面初始以只读证据显示观测来源、脱敏后的 HTTP/HTTPS/NO_PROXY、
观测时间、运行位置、生效层和覆盖顺序；必须确认风险后才解锁 Hub 应用策略的页内编辑。
保存只写 Hub 数据库中的应用策略，不会写 `/etc/systemd/system/docker.service.d/`。
LLM Sequence 或兼容 Provider 引用了不存在/停用的专属 Proxy Sequence 时会 fail closed；
显式系统出网才会绕过 deployment default。daemon URL 如含 userinfo，仅在 Kubernetes Secret 和
运行时内存中使用，普通 GET、日志和界面只显示脱敏值。

## Embedding 的不可热切换项

Embedding 的 Key、HTTPS 地址、超时、启停和同一模型的 failover 顺序可以热更新；
模型或维度不能直接切换。Elasticsearch `dense_vector` 的维度固定，即使两个模型维度
碰巧相同，它们的向量空间也可能不可比较。设置接口会拒绝这类变化并返回需要 reindex
的错误。

Embedding 的“继承 Chat Provider”只复用连接账号，不复用 Chat 模型。引用保存在
Embedding Catalog 中，密钥仍只存在于原 Chat credential 记录；reveal、probe 和运行时
请求都在服务端解析同一个父引用。被继承的 Chat Provider 不能删除或切回 environment；
修改其 Endpoint、协议、Key、超时、Proxy 或启停状态会同步提升 Embedding revision，使
旧 probe evidence 和 Embedding LLM Sequence proof 失效，重新验证后才能继续承接业务。

能力目录是安全提示而不是对所有兼容网关的猜测：官方明确不支持 Embedding 的连接会被
拒绝，官方已知模型可直接选择；私有或未知 OpenAI-compatible 网关显示“需要连接测试”，
不会被错误地硬过滤。当前 Router 不发送可选 `dimensions` 请求参数，所以已知 OpenAI
Embedding 模型必须使用其默认返回维度；支持缩维需要先扩展 Router 契约并重新规划索引。

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
- LLM Sequence 的显式 Proxy/系统出网优先于兼容 Provider/Hub 和 daemon；继承模式才会继续解析低优先级层；
- endpoint 只能从专用手柄拖入/排序/拖出，输入框、滚动条和卡片不会启动拖动；
- Provider × 路由一次性测试必须显式选择继承部署默认、Pod/Node 系统出网或 Proxy Sequence，且不会改绑定或写 reusable evidence；
- Docker daemon 快照只注入 Agent 工作负载，普通 API 只返回脱敏值；确认编辑只写 Hub 应用策略，不修改/重启宿主 Docker；
- Launcher platform-admin 可读但写设置返回 `403 admin_token_required`；
- 旧 revision 写入返回 `409`，不会覆盖另一管理员的更新；
- 直接绕过界面更新 Catalog 也不能删除被 LLM Sequence 引用的 Provider，服务端返回 `409 agent_provider_in_use`；
- 直接绕过界面更新 Chat Catalog 也不能删除被 Embedding Provider 继承的父 Provider；继承记录不含独立 API Key，公共响应只显示来源 ID 和安全连接元数据；
- 已知不支持 Embedding 的连接在前后端均被拒绝；未知 OpenAI-compatible 网关保留 probe-required 路径，不能仅因不在白名单就冒充已支持；
- 非法 URL、未知字段和客户端提交的 `apiKeyEnv` 被拒绝；
- 数据库或新配置暂时不可用时，进程保留 last-known-good，Hub readiness、canonical ingest 和 MX-H2I 登录不受影响；
- analysis pipeline 保持暂停时，部署/保存 provider 不会创建模型任务；classifier 停止时固定源同步和严格 HanLP 投影仍独立运行。
