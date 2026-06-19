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
# 打开 http://127.0.0.1:18090/admin/
# 可选：只调 UI 静态壳时再使用 python3 -m http.server 18110 --directory desktop

# Internal native host runner
# 必须运行在真实 Internal 宿主机上。macOS 使用 LaunchAgent，Ubuntu/Linux 使用 systemd。
# k8s API 通过 http://host.docker.internal:19190 访问它；不要用 Docker Desktop/LinuxKit runner 作为默认 WG runtime。
bash scripts/manage.sh ops site-slot native-host-runner status 19190
bash scripts/manage.sh ops site-slot native-host-runner install 19190

# Terminal 1
#  ocal-platform = AWX + Internal
bash scripts/manage.sh ops awx-shadow install
bash scripts/manage.sh ops local-platform cycle

# Terminal 2
## bash scripts/manage.sh ops internal-local port-forward 18090
bash scripts/manage.sh k8s port-forward internal-local 18090


# 最快看desktop样式
python3 -m http.server 18110 -d electron-dock/mx-launcher/desktop

# 打开 http://127.0.0.1:18090/admin/
# 左下角 MX Server 默认使用：http://127.0.0.1:18090

# AWX UI
bash scripts/manage.sh ops awx-shadow port-forward 18080
bash scripts/manage.sh ops awx-shadow password
# 登录 http://127.0.0.1:18080

bash scripts/manage.sh ops awx-shadow status
bash scripts/manage.sh ops awx-shadow password
bash scripts/manage.sh ops awx-shadow port-forward 18080

# 清理V1.0
bash scripts/manage.sh ops site-slot cleanup-v1-wireguard --apply

# 清理docker
docker image prune -f
docker builder prune -f --filter until=168h --keep-storage 8GB


# wg Domestic
wg show mx-domestic latest-handshakes
wg show mx-domestic endpoints
# wg Internal host runner
bash scripts/manage.sh ops site-slot native-host-runner status 19190
```
