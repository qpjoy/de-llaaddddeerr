```bash
# 配置 Hub
cd /root/mx/workspace/de-llaaddddeerr/electron-dock/mx-insight-hub

install -m 600 /dev/null .env.internal
vi .env.internal

# 写入 .env.internal（三个密钥必填）
MX_INSIGHT_ADMIN_TOKEN=<独立随机值，至少32字符>
MX_INSIGHT_API_KEY_PEPPER=<另一个独立随机值，至少32字符>
MX_INSIGHT_POSTGRES_PASSWORD=<另一个URL安全随机值，至少24字符>
NIGHT_ALL_SERVICE_TOKEN=
# NIGHT_ALL_BASE_URL 可省略：hostNetwork overlay 下默认 http://127.0.0.1:13141（宿主机 Night-All）
# NIGHT_ALL_BASE_URL=http://127.0.0.1:13141
# 可选：限定 bootstrap key 授权的平台（逗号分隔）；不填则自动发现 Night-All 支持的全部平台
# MX_INSIGHT_BOOTSTRAP_PLATFORMS=xiaohongshu,douyin

# 一键部署：自动 build → migrate → 起 Admin/Public → 幂等建并打印 bootstrap API key
MX_INSIGHT_BUILD_PROXY=http://127.0.0.1:7788 bash scripts/manage.sh ops internal-production deploy
bash scripts/manage.sh ops internal-production deploy

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

# 首次不要执行（本地开发栈）：
# bash scripts/manage.sh search up
# bash scripts/manage.sh local up
```
