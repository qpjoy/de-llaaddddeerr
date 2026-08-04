```bash
cd /root/mx/workspace/de-llaaddddeerr/electron-dock/mx-insight-hub

install -m 600 /dev/null .env.internal
vi .env.internal


MX_INSIGHT_ADMIN_TOKEN=<独立随机值，至少32字符>
MX_INSIGHT_API_KEY_PEPPER=<另一个独立随机值，至少32字符>
MX_INSIGHT_POSTGRES_PASSWORD=<另一个URL安全随机值，至少24字符>
NIGHT_ALL_BASE_URL=http://<Internal节点实际IP>:13141
NIGHT_ALL_SERVICE_TOKEN=

```