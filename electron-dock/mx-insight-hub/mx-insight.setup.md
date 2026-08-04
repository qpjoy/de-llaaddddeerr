```bash
# 配置Hub
cd /root/mx/workspace/de-llaaddddeerr/electron-dock/mx-insight-hub

install -m 600 /dev/null .env.internal
vi .env.internal

# 写入.env.internal
MX_INSIGHT_ADMIN_TOKEN=<独立随机值，至少32字符>
MX_INSIGHT_API_KEY_PEPPER=<另一个独立随机值，至少32字符>
MX_INSIGHT_POSTGRES_PASSWORD=<另一个URL安全随机值，至少24字符>
NIGHT_ALL_BASE_URL=http://<Internal节点实际IP>:13141
NIGHT_ALL_SERVICE_TOKEN=

# 首次部署
bash scripts/manage.sh ops internal-production plan
bash scripts/manage.sh ops internal-production deploy
bash scripts/manage.sh ops internal-production status
bash scripts/manage.sh ops internal-production smoke

# 首次不要执行：
bash scripts/manage.sh search up
bash scripts/manage.sh local up
MX_INSIGHT_HUB_DEPLOY=1 bash scripts/manage.sh ops internal-production deploy

# 前两个是本地开发栈；最后一个会先重部署 Launcher。首次独立部署不会重启 Launcher，更安全。
# Admin 当前是 ClusterIP，可临时访问：
kubectl -n mx-insight-hub port-forward \
  service/mx-insight-hub-admin 18151:18151
```