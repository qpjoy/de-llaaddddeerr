# 上线验收 Runbook

按顺序执行。每一步都有明确的「通过」判据，不要靠"看起来起来了"。

## 0. 前置：Night-All

Night-All 的改动是纯增量（新增 `/api/v1/data/export`、新增迁移 038），`start-node.sh` 无需修改。

```bash
cd /path/to/Night-All
# 导出接口需要显式配置 token，未配置时该路由返回 503 而不是放行
echo 'NIGHTALL_EXPORT_TOKEN=<32+ 位随机串>' >> .env
sh start-node.sh restart
```

**通过判据**：启动日志出现 `applying 1 pending database migration(s)` 或 `database migrations are up to date`，且现有 `/api/v1/data/search` 仍可用。

## 1. 共享数据面

```bash
cd electron-dock/mx-common
bash scripts/manage.sh deploy     # = ensure，缺失镜像会自动通过 Docker 预热
bash scripts/manage.sh status
```

**通过判据**：`health` 输出 `{"elasticsearch":"green|yellow","redis":"ok","postgres":"ok",...}`。

`ensure` 开始会先报三件事：节点可分配内存 vs 本栈请求量、每个镜像是否已缓存、以及等待过程中每个 Pod 的状态变化。**不再有静默等待**——看到 `still waiting on X (Ns of 300s)` 说明在正常拉镜像，看到 `stuck in ImagePullBackOff` 会立即中止并给出处置方式。

常见失败：

| 现象 | 处置 |
| --- | --- |
| `ImagePullBackOff` | `bash scripts/manage.sh preload`，或设镜像源 `MX_COMMON_ELASTICSEARCH_IMAGE=<mirror>/elasticsearch:9.4.2` |
| ES 反复重启 / OOM | 内存不够：`MX_COMMON_ELASTICSEARCH_HEAP=512m bash scripts/manage.sh ensure` |
| `vm.max_map_count` 提不上去 | 脚本会打印需要 root 执行的命令 |
| `creating retained local PV` | 正常，无默认 StorageClass 时自动建 Retain 本地 PV |
| PG `Permission denied` / ES `node.lock AccessDeniedException` | hostPath 目录属主不对。**`fsGroup` 对 hostPath 卷不生效**，`ensure` 会按各 Pod 的 runAsUser 修正（PG 999:999 0700，ES 1000:0 0775）并重启崩溃的 Pod |
| `hanlp: disabled` | 仅在明确接受本地 Jieba 的开发/受控降级环境中正常；生产索引基线要求先部署 HanLP。content/chunk writer 严格使用配置后端，不会在 HanLP 瞬时故障时把 fallback 写进 `*Hanlp` |
| 首次 `Pulling` 耗时几十分钟 | ES 镜像约 890MB，境外 registry 很慢。`ensure` 现在会先用 Docker 预热 |

单节点上这台机器同时跑 Night-All、Hub 及其 worker，ES 默认请求 2Gi / 上限 3Gi / 堆 1g。堆和内存请求要一起调——只调其中一个会让两者不一致，Pod 会 OOM。请求量大约取堆的两倍，剩下是 Lucene 读段用的堆外 page cache。

## 2. Hub 部署

`.env.internal` 需要（mode 0600）：

```bash
MX_INSIGHT_ADMIN_TOKEN=<32+ 位>
MX_INSIGHT_API_KEY_PEPPER=<32+ 位>
NIGHT_ALL_BASE_URL=http://127.0.0.1:13141
# 只有要做历史回填（从 Night-All 存量内容拉数据）才需要。
# 不配的话：实时链路、入库、ES 投影全部正常，只是回填不可用。
# 配了就必须和 Night-All 的 NIGHTALL_EXPORT_TOKEN 完全一致，
# 且 Night-All 那边也要设置——它未配置时导出路由返回 503 而不是放行。
NIGHT_ALL_EXPORT_TOKEN=<与 Night-All 一致，可留空>

# 可选：Launcher 登录（不配则只有 admin token）
# MX_INSIGHT_LAUNCHER_URL 不用填 —— deploy 会按 label
# app.kubernetes.io/name=mx-launcher-internal 自动发现 Service 的命名空间和端口，
# 并检查它有没有就绪的 endpoints。只有自动发现看不到的集群才需要手动指定。
MX_INSIGHT_LAUNCHER_ADMIN_SCOPES=insight-hub.admin

# 可选：Agent 与向量（不配则映射建议退回规则推断，检索只有 BM25）
# 数组顺序即降级顺序。任何 OpenAI 兼容端点都能加，一行配置，不用改代码或 YAML。
MX_INSIGHT_AGENT_PROVIDERS='[
  {"id":"deepseek","baseUrl":"https://api.deepseek.com/v1","model":"deepseek-chat","apiKeyEnv":"DEEPSEEK_API_KEY"},
  {"id":"openai","baseUrl":"https://api.openai.com/v1","model":"gpt-4o-mini","apiKeyEnv":"OPENAI_API_KEY"}
]'
MX_INSIGHT_EMBEDDING_PROVIDERS='[{"id":"openai","baseUrl":"https://api.openai.com/v1","model":"text-embedding-3-small","apiKeyEnv":"OPENAI_API_KEY","dimensions":1536}]'
MX_INSIGHT_EMBEDDING_DIMENSIONS=1536

# key 用 apiKeyEnv 里写的那个变量名，deploy 会自己把用到的变量收集进
# Secret/mx-insight-hub-model-keys 并注入所有工作负载。加新 provider 不用动 YAML。
DEEPSEEK_API_KEY=<key>
OPENAI_API_KEY=<key>
```

`MX_INSIGHT_POSTGRES_PASSWORD` 不再需要——数据库在 mx-common 里，凭据由它生成并保存，重复部署复用而不轮换。

```bash
cd electron-dock/mx-insight-hub
bash scripts/manage.sh deploy     # 检查共享数据面 → 建库 → 构建 → migrate → 滚动 → 冒烟
```

**通过判据**：`Internal production deploy OK.`，且 `kubectl -n mx-insight-hub get pods` 中 public / admin / projector / ingest 四个都 Running。

如果上一版留了本地 PostgreSQL，deploy 会提示但**不会删**。确认新库正常后再显式清理：

```bash
MX_INSIGHT_CONFIRM_DESTROY=mx-insight-hub \
  bash scripts/manage.sh ops internal-production decommission-local-postgres
```

## 3. 冒烟

```bash
bash scripts/manage.sh verify
```

### 3.1 原有 Night-All 通路（回归项，必须先过）

```bash
curl -s -X POST https://hub.minsight-ai.com/api/v1/data/search \
  -H "authorization: Bearer $API_KEY" -H "content-type: application/json" \
  -H "idempotency-key: $(uuidgen)" \
  -d '{"platform":"xiaohongshu","query":"AI Agent","pageSize":5}' | jq '.data.items | length'
```

**通过判据**：返回 5。这条不通就停下，后面都不用看。

### 3.2 异步入库

上一步之后：

```bash
kubectl -n mx-insight-hub logs deployment/mx-insight-hub-ingest --tail=20 | grep ingest
```

**通过判据**：出现 `[ingest] xiaohongshu request=... ingested=5 changed=5`。

### 3.3 ES 投影

```bash
kubectl -n mx-common exec statefulset/mx-common-elasticsearch -c elasticsearch -- \
  curl -s 'http://127.0.0.1:9200/mx-insight-hub-content/_count'
```

**通过判据**：`count` > 0。

### 3.4 模糊搜索用户名

```bash
curl -s "$ADMIN/internal/v1/admin/..." # 或直接用控制台「调用者」页
```

也可以直接查 ES 验证 author 字段确实建好了：

```bash
kubectl -n mx-common exec statefulset/mx-common-elasticsearch -c elasticsearch -- \
  curl -s 'http://127.0.0.1:9200/mx-insight-hub-content/_mapping' | jq '..|.authorName?|select(.)'
```

**通过判据**：能看到 `keyword` / `prefix` / `bigram` 三个子字段。

### 3.5 备份

```bash
cd ../mx-common
bash scripts/manage.sh snapshot run
sleep 30 && bash scripts/manage.sh snapshot status
```

**通过判据**：输出里有 `last_success`。只看到策略存在但没有 `last_success` 不算通过。

### 3.6 控制台

浏览器打开 `http://10.88.88.88:18151/`，用 `MX_INSIGHT_ADMIN_TOKEN` 登录。

**通过判据**：左侧出现「数据平面」分组（外部数据源 / 历史回填 / 检索管线 / 中心 Agent）；「中心 Agent」页显示 provider 链路且熔断状态为「正常」。

## 4. 可选验收

**回填**：控制台「历史回填」→ 选平台「开始 / 继续」，或

```bash
curl -X POST "$ADMIN/internal/v1/admin/backfill" \
  -H "x-mx-insight-admin-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"platform":"xiaohongshu"}'
```

**外部导入**：控制台「外部数据源」→ 注册 → 上传样例 xlsx 预览 → 保存映射 → 批准 → 导入。

**检索**：控制台「检索管线」查看三段计数；配了 embedding 才有向量召回，否则页面会明示 `no embedding provider; vector recall is unavailable`。

## 5. 回滚

```bash
# 只缩容 Hub 工作负载，保留数据
bash scripts/manage.sh ops internal-production down
# 共享数据面同理
cd ../mx-common && bash scripts/manage.sh down
```

两条命令都不删 PVC、PV、索引和 Secret。


## 6. Launcher 登录怎么用

**Hub 不做 OAuth 跳转**，控制台的登录框接受两种凭据：admin token，或一个 Launcher 签发的 token（`mx-v1-...`）。这决定了平台管理员是怎么产生的：

**没有人"自动"成为管理员。** JIT provisioning 发生在**该用户用 Launcher token 登录 Hub 控制台的那一刻**——那时 Hub 才去 introspect、创建 member、比对 scope 白名单。在此之前「成员」列表是空的，这是正常的，不是配置没生效。

先确认 Launcher 已被发现：

```bash
curl -s -H "x-mx-insight-admin-token: $TOKEN" \
  http://10.88.88.88:18151/internal/v1/admin/session | jq '.data.identityProvider'
```

`"mx-launcher"` 表示已接上；`null` 表示没发现到 Launcher，登录只有 admin token 可用。

签一个用户 token（需要 Launcher 的 ops token）：

```bash
curl -X POST http://mx-launcher-internal.mx-internal-shadow.svc.cluster.local:18090/internal/v1/user-center/tokens/issue \
  -H "x-mx-ops-token: $LAUNCHER_OPS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"subjectKind":"user","subjectId":"<userId>","audience":"mx-insight-hub"}'
```

把返回的 token 粘进 Hub 控制台登录框。登录后查自己的 scope 匹配情况：

```bash
curl -s -H "x-mx-insight-admin-token: <那个 mx-v1 token>" \
  http://10.88.88.88:18151/internal/v1/admin/session \
  | jq '{launcherScopes, adminScopeAllowlist, adminScopeMatched, platformAdmin}'
```

`adminScopeMatched` 为空数组就是白名单没配对——Launcher 实际定义的 scope 是 `rbac.manage`、`admin.dashboard.read`、`release.manage`、`site-slot.manage`、`dns.manage` 等，`MX_INSIGHT_LAUNCHER_ADMIN_SCOPES` 必须写其中之一。

没匹配上的用户仍然能登录成功，只是看到空控制台，直到有人给他授予 tenant membership。**认证成功不等于有权限**，这是刻意的。

## 7. 验证 API key 的调用能力

新建的调用者需要两样东西才能调：**平台授权**和 **API key**。控制台「平台能力」授权、「API Keys」签发。
新 key 默认有效 180 天，也可在签发时设置 1–730 天；验收时应同时记录返回的
`expiresAt`，并在到期前采用“新旧 key 短期并行、验证新 key、撤销旧 key”的方式轮换。

然后跑端到端验证——它比手工 curl 多验四步：

```bash
bash scripts/manage.sh verify-data-path <api-key>
```

不传 key 就用部署时存下的 bootstrap key。逐段报告：

| 阶段 | 验证的东西 |
| --- | --- |
| 1/5 capabilities | key 有效、平台已授权 |
| 2/5 search | Night-All 可达、返回了 items（**这一步是计费的**） |
| 3/5 ingest → PG | 异步入库确实落地（接口返回时并不等它） |
| 4/5 outbox → projector | 投影事件被消费干净 |
| 5/5 Elasticsearch | 文档真的进了索引 |

任一步失败会直接给出该看哪个 workload 的日志。3/5 卡住看 ingest worker，4/5 卡住看 projector 和死信。

## 8. Launcher token 到底怎么来的

先把事实说清楚——这几点在 Launcher 现有实现里是确定的：

- **Launcher 管理台没有"签发 token"的按钮。** 它只调 `bootstrap` / `roles` / `users` / `users/import` / `oversea-entitlements`，没有任何界面调用 `tokens/issue`。
- **API 文档在** `http://10.88.88.88:18090/docs/api`（还有 `openapi.json` 和 `mx-launcher-api.md`）。
- **内网网关 `:18090` 把所有路径反代给 Launcher**，所以下面这些接口浏览器可直接访问。

有两条路拿到 token：

**用户自己登录（推荐，不需要 ops token）**

```bash
curl -X POST http://10.88.88.88:18090/internal/v1/sdk/oauth/token \
  -H 'content-type: application/json' \
  -d '{"grant_type":"password","username":"<账号>","password":"<密码>","audience":"mx-insight-hub"}'
```

⚠️ `audience` **必须**写 `mx-insight-hub`。它默认是 `mx-sdk`，而 Hub 会校验 audience 并拒绝不匹配的 token。

**管理员代签（需要 ops token）**

```bash
curl -X POST http://10.88.88.88:18090/internal/v1/user-center/tokens/issue \
  -H "x-mx-ops-token: $LAUNCHER_OPS_TOKEN" -H 'content-type: application/json' \
  -d '{"subjectKind":"user","subjectId":"<userId>","audience":"mx-insight-hub"}'
```

### 但现在不用手工 curl 了

Hub 控制台登录页有「Launcher 账号」页签，直接填账号密码。

**登录请求由 Hub 后端转发给 Launcher**，浏览器不直连 Launcher。这一点是刻意的：Launcher 只在内网 `10.88.88.88:18090` 上应答，不连 VPN 的浏览器根本够不着；而 Hub 和 Launcher 同机部署，Hub 后端本来就要调 Launcher 做 introspection，转发登录用的是同一条已存在的信任链路。

密码只转发、不落地——不记日志、不入库、不进缓存，只有换回来的 token 会返回给浏览器。

不需要任何额外配置：`MX_INSIGHT_LAUNCHER_URL` 由 deploy 自动发现，登录页签随之出现。

两点防护：调用方 IP 通过 `X-Forwarded-For` 透传给 Launcher（否则它的按源限流只会看到 Hub 一个地址，一个攻击者就能把所有人锁死），Hub 侧另有每 IP 每分钟 10 次的本地限流，避免 Hub 变成放大器。
