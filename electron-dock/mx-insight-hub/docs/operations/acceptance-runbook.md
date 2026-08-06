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

单节点上这台机器同时跑 Night-All、Hub 及其 worker，ES 默认请求 2Gi / 上限 3Gi / 堆 1g。堆和内存请求要一起调——只调其中一个会让两者不一致，Pod 会 OOM。请求量大约取堆的两倍，剩下是 Lucene 读段用的堆外 page cache。

## 2. Hub 部署

`.env.internal` 需要（mode 0600）：

```bash
MX_INSIGHT_ADMIN_TOKEN=<32+ 位>
MX_INSIGHT_API_KEY_PEPPER=<32+ 位>
NIGHT_ALL_BASE_URL=http://127.0.0.1:13141
NIGHT_ALL_EXPORT_TOKEN=<与 Night-All 一致>

# 可选：Launcher 登录（不配则只有 admin token）
MX_INSIGHT_LAUNCHER_URL=http://mx-launcher-server.mx-internal-shadow.svc.cluster.local:PORT
MX_INSIGHT_LAUNCHER_ADMIN_SCOPES=insight-hub.admin

# 可选：Agent 与向量（不配则映射建议退回规则推断，检索只有 BM25）
MX_INSIGHT_AGENT_PROVIDERS='[{"id":"deepseek","baseUrl":"https://api.deepseek.com/v1","model":"deepseek-chat","apiKeyEnv":"DEEPSEEK_API_KEY"}]'
MX_INSIGHT_EMBEDDING_PROVIDERS='[{"id":"deepseek","baseUrl":"https://api.deepseek.com/v1","model":"embedding-2","apiKeyEnv":"DEEPSEEK_API_KEY","dimensions":1024}]'
MX_INSIGHT_EMBEDDING_DIMENSIONS=1024
DEEPSEEK_API_KEY=<key>
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
