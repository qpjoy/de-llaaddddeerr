# Agent provider settings

HanLP、Hub Agent 和向量检索是三条独立链路。HanLP 安装成功只代表中文
分词服务可用，不会自动启用大模型、逐条分类或 embedding。

| 能力 | 必要前置 | 当前接线 |
| --- | --- | --- |
| 中文分词 | `mx-common-hanlp` Ready，Hub 的 `MX_COMMON_HANLP_URL` 指向该 Service | canonical 入库不阻塞；content/chunk 索引写入严格要求配置后端（生产 HanLP）：瞬时故障 pending/backoff 并自动恢复，永久/记录级错误累计 5 次后 dead/quarantine；只有查询分词 fail-soft |
| 文件字段映射建议 | 至少一个 Chat provider | 管理员在文件预览时显式选择 Agent；模型只收到列名，建议仍需人工批准 |
| 记录分类 | Chat provider | 通用 ingest 仍未自动送模；固定 `public-opinion.province.v1` 已接入默认暂停、raw-revision-anchored 的规则/Agent 任务。仓库包含独立 classifier package/Compose/K8s workload，但配置模型或部署 worker 本身不会启用暂停的 pipeline |
| 向量检索 | Elasticsearch、projector、固定的 `MX_INSIGHT_EMBEDDING_DIMENSIONS`、同维度 embedding provider | projector 异步生成向量；模型不可用不阻塞 canonical 入库和删除投影 |

## 第一次启用

先完成一次经过批准的 Hub 部署，让 migration 建立 Agent 设置表及默认暂停的分析表，
并让 API/projector 运行新版本：

```bash
cd electron-dock/mx-insight-hub
bash scripts/manage.sh deploy
```

然后用 **Hub admin token** 登录管理台，打开「中心 Agent」：

1. 选择 Chat 或 Embedding 链路。
2. 将配置来源从 `environment` 切换为 `database`。
3. 按降级顺序添加 OpenAI-compatible provider，填写 API 根地址、模型、超时和启停状态。
4. 对需要 Bearer 鉴权的 provider 重新输入 API Key。环境变量中的 Key 不会被浏览器读取或自动回显。
5. 保存后逐个执行连接测试。测试只访问选中的 provider，不会因为 fallback 成功而把故障的首选误报健康；已停用但凭据完整的候选也可先隔离测试，测试成功不会把它加入生产链。
6. Admin API 进程立即刷新，projector 和 classifier 最迟在下一个轮询周期采用新 revision；无需修改 `.env` 或重启。

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
- enabled providers 按 priority 尝试。transport/timeout、无效 JSON、401/403/404、
  429 和 5xx 会 fallback；普通 4xx 不 fallback。
- 每个 provider 默认 timeout 60 秒，可设 1–300 秒；连续 3 次失败后在当前进程熔断
  60 秒。API 与 classifier 各有 process-local circuit，管理页看到的 API circuit 不能
  代替 worker 日志/状态。
- provider test 使用固定、无业务数据的小请求并且只测指定 provider。它可能仍产生
  provider 侧调用/计费，也不能证明 classifier Pod 拥有相同的 Secret 和网络出口；
  同一 provider 单飞、测试后冷却 5 秒，单进程最多同时探测 2 个 provider。
- Chat/Embedding 的 HTTP 2xx 仍必须通过语义校验；空 chat 内容、向量数量/index/维度/
  非有限值或返回 model 不匹配都会把该 provider 记为失败并允许健康的下一候选 fallback。
- rule/Agent assertion 默认只是 `proposed`。当前 API 可读列表但没有 accept/reject
  writer，assertion 也不投影到 canonical/public serving；不要用临时 SQL 代替审核。

## Key 行为

- Key 按当前运维策略以明文保存到独立数据库凭据表。
- GET、PUT 响应、日志和管理界面只显示 `keyConfigured`，不存在读取或 reveal 接口。
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
进程启动时的环境配置；环境变量本身发生变化仍需重新部署。

`MX_INSIGHT_SYNC_LAUNCHER` 与 Agent 设置无关，保持默认 `0` 即可。保存动态设置不会
运行部署脚本、写 Launcher Secret、重启 Launcher 或修改 MX-H2I 登录/联网链路。

## 安全验收

至少确认：

- `GET /internal/v1/admin/agent` 的响应中没有 Key、`apiKeyEnv` 或 Secret 名称；
- 单 provider 测试失败时不会 fallback，成功响应不包含模型 payload/vector；
- Launcher platform-admin 可读但写设置返回 `403 admin_token_required`；
- 旧 revision 写入返回 `409`，不会覆盖另一管理员的更新；
- 非法 URL、未知字段和客户端提交的 `apiKeyEnv` 被拒绝；
- 数据库或新配置暂时不可用时，进程保留 last-known-good，Hub readiness、canonical ingest 和 MX-H2I 登录不受影响；
- analysis pipeline 保持暂停时，部署/保存 provider 不会创建模型任务；classifier 停止时固定源同步和严格 HanLP 投影仍独立运行。
