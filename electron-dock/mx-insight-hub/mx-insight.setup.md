```bash
# 配置 Hub
cd /root/mx/workspace/de-llaaddddeerr/electron-dock/mx-insight-hub

install -m 600 /dev/null .env.internal
vi .env.internal

# 写入 .env.internal（三个密钥必填）
MX_INSIGHT_ADMIN_TOKEN=<独立随机值，至少32字符；不要提交真实令牌>
MX_INSIGHT_API_KEY_PEPPER=<另一个独立随机值，至少32字符>
MX_INSIGHT_POSTGRES_PASSWORD=<另一个URL安全随机值，至少24字符>
NIGHT_ALL_SERVICE_TOKEN=
# NIGHT_ALL_BASE_URL 可省略：hostNetwork overlay 下默认 http://127.0.0.1:13141（宿主机 Night-All）
# NIGHT_ALL_BASE_URL=http://127.0.0.1:13141
# 本机 127.0.0.1:5432 的 saved-records 源库由 root deploy 通过 postgres peer
# 自动建/核对 13 个游标索引。仅远端源库需要配置 root 管理的 libpq service：
# MX_INSIGHT_NIGHT_ALL_DDL_SERVICE=night_all_ddl
# 可选：限定 bootstrap key 授权的平台（逗号分隔）；不填则自动发现 Night-All 支持的全部平台
# MX_INSIGHT_BOOTSTRAP_PLATFORMS=xiaohongshu,douyin

# 可选：先幂等部署 HanLP。Hub 随后的普通 deploy 会自动发现 ready Endpoint，
# 无需在 .env.internal 手工配置 MX_COMMON_HANLP_ENABLED / MX_COMMON_HANLP_URL。
cd ../mx-common
bash scripts/manage.sh deploy hanlp
cd ../mx-insight-hub

# 一键部署：自动 build → Hub migrate → Hub 在线索引 → 已配置 saved-records
# 源库的 13 个在线索引 → rollout Admin/Public/worker → smoke → 幂等 bootstrap key。
# 服务器有 127.0.0.1:7788 出口代理时使用代理模式；它同时覆盖 Docker Hub
# token/frontend、基础镜像和 Dockerfile RUN。不要再叠加 BUILD_NETWORK。
MX_INSIGHT_BUILD_PROXY=http://127.0.0.1:7788 bash scripts/manage.sh ops internal-production deploy
# 仅在 Docker Hub 可以直接访问、只需让 RUN 使用宿主网络时，才改用下面这一条：
MX_INSIGHT_BUILD_NETWORK=host \
bash scripts/manage.sh ops internal-production deploy

# deploy 不会触发 Elasticsearch 全量重建。若数据中心仍开启“projector 重启时
# 自动全量重建”，deploy 会在应用 Hub Kubernetes 资源前拒绝执行，请先关闭它。content schema
# 变化时，在数据中心核对磁盘/HanLP 负载后手动点一次“开始严格重建”；日常新数据
# 继续走增量 outbox。

# 部署完即可用，无需 port-forward / 手动连 admin：
#   Admin : http://10.88.88.88:18151/            （SPA + /internal/v1/admin/*，头 x-mx-insight-admin-token）
#   Public: http://10.88.88.88:18150/api/v1/...  （Authorization: Bearer <API key>）
# deploy 末尾会打印 bootstrap API key 和一条示例，例如：
#   curl -H "authorization: Bearer <KEY>" http://10.88.88.88:18150/api/v1/data/capabilities

# 其他动作
bash scripts/manage.sh ops internal-production status
bash scripts/manage.sh ops internal-production smoke
bash scripts/manage.sh ops internal-production logs

# 安全：hostNetwork 把 18150/18151 绑到宿主机所有网卡。公网 Nginx 前置就绪前，
# 用主机防火墙把 18150/18151 限制在内网（仅 10.88.88.88 段）。

# 如需联动 Launcher（会 rollout restart mx-launcher-internal），显式开启：
# MX_INSIGHT_SYNC_LAUNCHER=1 bash scripts/manage.sh ops internal-production deploy
# 独立 Hub deploy 默认等价于 MX_INSIGHT_SYNC_LAUNCHER=0，不会重启 Launcher。

# 首次不要执行（本地开发栈）：
# bash scripts/manage.sh search up
# bash scripts/manage.sh local up
```

```bash
# 进入TG数据库
PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=3000' \
psql "host=127.0.0.1 port=5432 dbname=night_all user=mx_data" \
  -X -W -v ON_ERROR_STOP=1


# LLM 有两种配置来源：
# 1. 推荐：先部署一次，然后用 Hub admin token 登录「中心 Agent」，把 Provider/Key
#    保存到数据库；后续地址、Key、超时、启停和顺序更新无需改 env 或重启。
# 2. 回滚/兼容：继续用下面的环境变量。baseUrl 填 API 根路径，不要填
#    /chat/completions；apiKeyEnv 填变量名，不是明文 Key。环境配置变化仍需重新部署。

# MX_INSIGHT_AGENT_PROVIDERS='[
#   {
#     "id":"thirdparty",
#     "baseUrl":"https://your-provider.example.com/v1",
#     "model":"your-chat-model",
#     "apiKeyEnv":"THIRDPARTY_API_KEY"
#   }
# ]'
# THIRDPARTY_API_KEY='<实际 key>'


# 向量检索是另一套独立配置。Provider Key/地址可在中心 Agent 热更新，但
# MX_INSIGHT_EMBEDDING_DIMENSIONS 决定 ES mapping，仍必须在部署时固定。
# 模型或 dimensions 的变化需要受控 reindex，管理接口不会直接放行。
# MX_INSIGHT_EMBEDDING_PROVIDERS='[
#   {
#     "id":"openai",
#     "baseUrl":"https://api.openai.com/v1",
#     "model":"text-embedding-3-small",
#     "apiKeyEnv":"OPENAI_API_KEY",
#     "dimensions":1536
#   }
# ]'
# MX_INSIGHT_EMBEDDING_DIMENSIONS=1536
# OPENAI_API_KEY='<实际 key>'

# TG 数据库迁移
# 1. 保持 TG 任务暂停，源端写入程序也先停止。
# 2. 临时 DDL 两项留空。
# 3. 确认框输入 telegram-monitor。
# 4. 点击“准备 / 修复源库”。
# 5. 等两张表的 updated_at、触发器、游标索引、硬删除保护、表合同全部变绿。
# 6. 点击“精确核对源库进度”。
# 7. 确认 Writer 合同，启用任务，再点“立即同步”。

# 只有以下情况才重置：
# 已有 Checkpoint 后换服务器、换数据库或源表被 DROP/重建；
# 准备面板明确显示 requiresCheckpointReset；
# 修复历史漏数后，明确决定从头全量重放。

# 1. Admin 数据中心接口：查看完整数据和删除标记
export HUB_ADMIN_URL="http://10.88.88.88:18151"

curl -sS --get \
  "$HUB_ADMIN_URL/internal/v1/admin/data-center/records" \
  -H "x-mx-insight-admin-token: $MX_INSIGHT_ADMIN_TOKEN" \
  --data-urlencode "datasetId=telegram.sqlite.messages.v1" \
  --data-urlencode "platform=telegram" \
  --data-urlencode "objectType=message" \
  --data-urlencode "pageSize=50" | jq


export HUB_PUBLIC_URL="http://10.88.88.88:18150"

curl -sS -X POST \
  "$HUB_PUBLIC_URL/api/v1/data/stored/search" \
  -H "Authorization: Bearer $HUB_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: tg-sqlite-search-0001" \
  -d '{
    "platform": "telegram",
    "datasetId": "telegram.sqlite.messages.v1",
    "objectType": "message",
    "query": "需要搜索的关键词",
    "pageSize": 20
  }' | jq
```

```bash
# 重新索引数据
bash scripts/manage.sh reindex-search

# 搜索TG Monitor和sqlite数据源，TODO: 全部来源
POST /api/v1/data/canonical/search
Authorization: Bearer <API_KEY>
Idempotency-Key: <stable-key>
Content-Type: application/json

{
  "platform": "telegram",
  "objectType": "message",
  "query": "AI Agent",
  "pageSize": 20
}
```

```bash
# 重建索引
cd /root/mx/workspace/de-llaaddddeerr/electron-dock/mx-insight-hub

MX_INSIGHT_SYNC_LAUNCHER=0 \
  bash scripts/manage.sh ops internal-production deploy

kubectl -n mx-insight-hub rollout status \
  deployment/mx-insight-hub-projector --timeout=180s

bash scripts/manage.sh reindex-search
```


```bash
# Hub API 参考
# TikHub/TGStat
## 舆情处理省份归类情况
curl -fsS \
  -H "x-mx-insight-admin-token: $HUB_ADMIN_TOKEN" \
  "$HUB_ADMIN_BASE/internal/v1/admin/pipelines/province-opinion/quality-summary" |
jq '.data | {
  canonical,
  publication,
  geography,
  completeness,
  analysis,
  archive
}'
```


# JustOne/TikHub：先关闭 gate 完成迁移，再分别启用计费明确的上下游
```bash
# .env.internal
MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED=0

# 若旧集群还保留了未配成本证据的 TikHub 开关，首次升级也显式关闭。
# 这只停止新的付费上游 dispatch，不影响 Hub migration、存量读取、
# Launcher/MX-H2I 登录或用户联网。
MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED=0 \
MX_INSIGHT_TIKHUB_CONTRACT_VERIFIED=0 \
MX_INSIGHT_TIKHUB_SEARCH_CONTRACT_VERIFIED=0 \
MX_INSIGHT_TIKHUB_USER_ACTIVITY_CONTRACT_VERIFIED=0 \
MX_INSIGHT_SYNC_LAUNCHER=0 \
  bash scripts/manage.sh ops internal-production deploy

# 部署参数中的 MX_INSIGHT_JUSTONE_BILLING_JSON 和
# MX_INSIGHT_TIKHUB_BILLING_JSON 未设置或传空字符串时，语义都是保留集群
# ConfigMap 中已有的经审核策略，不会清空已有值。要停用付费上游，必须显式把
# 对应的 *_CONTRACT_VERIFIED gate 设为 0；不能用 *_BILLING_JSON="" 代替。

# 上述部署会执行 migration 056：复用版本化 customer_price_books / entries，
# billing_unit=request。usage_requests 精确记录新的逻辑 Hub 请求；同一个
# Idempotency-Key 的安全重放不重复创建 usage/customer charge。

# 不要用 0 或猜测价格发布下游“临时”价目表。费率确认后，在套餐与配额页面发布
# 新的不可变 price-book/plan version，先将 canary tenant 设为 shadow，核对
# request meter 数量，再充值并切 enforced。只影响之后明确分配到新版本的请求。

# JustOne gate 只有在 MX_INSIGHT_JUSTONE_BILLING_JSON 已包含经审核的币种、
# pricingAsOf、正数 endpoint 成本以及两个非负月度成本线后才能改为 1；成本线可设为 0，
# 让未计价/影子流量保持关闭。对同一 usage request 已完成正数 enforced 钱包冻结的
# 下游请求，这两个 Hub 财务线只告警、不拒绝上游 dispatch；真实 provider rate/quota、
# 并发、熔断、合同、凭据和当前请求成本证据仍然生效。
# 客户价目表是下游售价，不能替代上游采购成本证据，也不能用猜测汇率混算两本账。

# 检查启用状态
kubectl -n mx-insight-hub get configmap mx-insight-hub-config -o json \
  | jq '.data | {
      contractVerified: .MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED,
      configuredSignal: .MX_INSIGHT_JUSTONE_CONFIGURED
    }'
```
```bash
# 零上游调用的能力检查
curl -fsS \
  -H "Authorization: Bearer $HUB_API_KEY" \
  "$HUB_PUBLIC_URL/api/v1/data/capabilities" \
  | jq '.data.platforms[] | select(.platform == "ecommerce")'
```
