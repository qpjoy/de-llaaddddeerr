# Agent provider settings

HanLP、Hub Agent 和向量检索是三条独立链路。HanLP 安装成功只代表中文
分词服务可用，不会自动启用大模型、逐条分类或 embedding。

| 能力 | 必要前置 | 当前接线 |
| --- | --- | --- |
| 中文分词 | `mx-common-hanlp` Ready，Hub 的 `MX_COMMON_HANLP_URL` 指向该 Service | canonical 入库不阻塞；content/chunk 索引写入严格要求配置后端（生产 HanLP）：瞬时故障 pending/backoff 并自动恢复，永久/记录级错误累计 5 次后 dead/quarantine；只有查询分词 fail-soft |
| 文件字段映射建议 | 至少一个 Chat provider | 管理员在文件预览时显式选择 Agent；模型只收到列名，建议仍需人工批准 |
| 记录分类 | Chat provider | 能力已实现，但尚未接入通用 ingest；配置模型不会让所有入库数据自动送模 |
| 向量检索 | Elasticsearch、projector、固定的 `MX_INSIGHT_EMBEDDING_DIMENSIONS`、同维度 embedding provider | projector 异步生成向量；模型不可用不阻塞 canonical 入库和删除投影 |

## 第一次启用

先完成一次 Hub 部署，让 migration 建立 Agent 设置表并让 API/projector 运行新版本：

```bash
cd electron-dock/mx-insight-hub
bash scripts/manage.sh deploy
```

然后用 **Hub admin token** 登录管理台，打开「中心 Agent」：

1. 选择 Chat 或 Embedding 链路。
2. 将配置来源从 `environment` 切换为 `database`。
3. 按降级顺序添加 OpenAI-compatible provider，填写 API 根地址、模型、超时和启停状态。
4. 对需要 Bearer 鉴权的 provider 重新输入 API Key。环境变量中的 Key 不会被浏览器读取或自动回显。
5. 保存。Admin API 进程立即刷新，projector 最迟在下一个轮询周期采用新 revision；无需修改 `.env` 或重启。

正常保存返回 `200`，表示当前 Admin API 已采用新 revision。若数据库提交已经成功、
但该进程暂时无法重新读取并验证新配置，接口返回 `202` 和
`runtimeApplied: false`：被修改的 Agent 能力会先安全停用，后台轮询会继续应用同一
revision；这不是要求再次保存，也不会影响 canonical 入库、HanLP 或登录链路。

Launcher 平台管理员可以查看脱敏状态，但不能修改 Provider 或 Key。写入只接受
Hub admin token。设置 API 不接受 `apiKeyEnv`、Secret 名称、Launcher 配置、数据库
URL 或任意环境变量名。

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
- Launcher platform-admin 可读但写设置返回 `403 admin_token_required`；
- 旧 revision 写入返回 `409`，不会覆盖另一管理员的更新；
- 非法 URL、未知字段和客户端提交的 `apiKeyEnv` 被拒绝；
- 数据库或新配置暂时不可用时，进程保留 last-known-good，Hub readiness、canonical ingest 和 MX-H2I 登录不受影响。
