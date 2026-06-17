```bash
# k8s smoke
bash -n electron-dock/mx-launcher/scripts/manage.sh
bash electron-dock/mx-launcher/scripts/manage.sh ops guide
bash electron-dock/mx-launcher/scripts/manage.sh ops doctor
bash electron-dock/mx-launcher/scripts/manage.sh ops k8s-shadow dry-run
bash electron-dock/mx-launcher/scripts/manage.sh ops local-shadow build
bash electron-dock/mx-launcher/scripts/manage.sh ops local-shadow up
bash electron-dock/mx-launcher/scripts/manage.sh ops local-shadow smoke
bash electron-dock/mx-launcher/scripts/manage.sh ops local-shadow down

# local test
bash scripts/manage.sh ops k8s-shadow cycle
bash scripts/manage.sh ops internal-local port-forward
python3 -m http.server 18110 --directory desktop

# Terminal 1
#  ocal-platform = AWX + Internal
bash scripts/manage.sh ops awx-shadow install
bash scripts/manage.sh ops local-platform cycle

# Terminal 2
bash scripts/manage.sh ops internal-local port-forward 18090

# Terminal 3
python3 -m http.server 18110 --directory desktop

# 打开 http://127.0.0.1:18110/index.html
# 左下角 MX Server 保持：http://127.0.0.1:18090

# AWX UI
bash scripts/manage.sh ops awx-shadow port-forward 18080
bash scripts/manage.sh ops awx-shadow password
# 登录 http://127.0.0.1:18080

bash scripts/manage.sh ops awx-shadow status
bash scripts/manage.sh ops awx-shadow password
bash scripts/manage.sh ops awx-shadow port-forward 18080

# 清理V1.0
bash scripts/manage.sh ops site-slot cleanup-v1-wireguard --apply
```