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

# k8s install
cd ~/mx/workspace/de-llaaddddeerr/electron-dock/mx-launcher

kubeadm reset -f
systemctl restart containerd kubelet

# 安装host-runner
bash scripts/manage.sh ops site-slot native-host-runner install 19190
curl -sS http://127.0.0.1:19190/capabilities
curl -sS http://192.168.31.121:19190/capabilities

bash scripts/install-k8s-centos.sh \
  --advertise-address 192.168.31.121 \
  --allow-cgroup-v1 \
  --image-repository registry.aliyuncs.com/google_containers

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


### 正式部署
# 先在 CentOS 上按 runbook 安装 kubeadm/containerd/kubectl，并 kubeadm init
kubectl get nodes -o wide
kubectl -n kube-system get pods -o wide

# 然后进入仓库
cd /path/to/de-llaaddddeerr/electron-dock/mx-launcher

corepack enable
pnpm approve-builds --yes
pnpm install

PG_PASSWORD='<换成 Internal 测试库密码>' \
MX_SHADOW_BUILDKIT_KEEP_STORAGE=2GB \
MX_SHADOW_BUILDKIT_PRUNE_UNTIL=24h \
  bash scripts/manage.sh ops internal-production deploy

bash scripts/manage.sh ops internal-production status
bash scripts/manage.sh ops internal-production gateway-smoke
curl -fsS http://127.0.0.1:18090/healthz

# Oversea SSH Profile
# Worker URL 是 Internal worker 读取 job、回写 report 的 Internal API base。
# 默认填 http://127.0.0.1:18090；Admin 触发的 worker 跟 Internal API 在同一运行面，不依赖外部网络。
# 如果以后 worker 挪到独立宿主机，再填那个 worker 宿主机能访问到的 Internal gateway，例如 http://192.168.31.121:18090。
# 不要填 http://mx-launcher-internal.mx-internal-shadow.svc.cluster.local:18090；
# svc.cluster.local 只适合 K8s Pod 内部 DNS，不适合 Mac/browser/Oversea host。
# Callback URL 可以留空，push-only 模式不要求 Oversea 反向访问 Internal。


### 删除smoke数据
bash scripts/manage.sh ops internal-production cleanup-smoke-fixtures
bash scripts/manage.sh ops internal-production cleanup-smoke-fixtures --apply
MX_K8S_CLEANUP_LEGACY_OVERSEA_MAIN_SMOKE=1 bash scripts/manage.sh ops internal-production cleanup-smoke-fixtures --apply


### 服务器本机wg
# 关闭
sudo launchctl bootout system /Library/LaunchDaemons/com.qpjoy.mx-launcher.internal.wireguard.mx-internal-svc.plist
# 启动
sudo launchctl bootstrap system /Library/LaunchDaemons/com.qpjoy.mx-launcher.internal.wireguard.mx-internal-svc.plist
# 防开机启动
sudo launchctl disable system/com.qpjoy.mx-launcher.internal.wireguard.mx-internal-svc


# 备份canddy
mkdir -p ./ops-backups

kubectl -n mx-internal-shadow get cm mx-internal-gateway-caddy -o yaml \
  > ./ops-backups/mx-internal-gateway-caddy.$(date +%F-%H%M%S).yaml

# 清理k8s数据
## 1. 只清这个 namespace 的 k8s 残留
kubectl -n mx-internal-shadow delete job mx-launcher-migrate --ignore-not-found

kubectl -n mx-internal-shadow delete pod --field-selector=status.phase=Succeeded
kubectl -n mx-internal-shadow delete pod --field-selector=status.phase=Failed
## 清这个 namespace 的 Pod 日志：
find /var/log/pods -type f \
  -path '/var/log/pods/mx-internal-shadow_*/*/*.log' \
  -exec truncate -s 0 {} \;

## 2. 只清当前脚本产生的 Docker 镜像/容器
docker image ls --filter label=dev.qpjoy.mx-launcher.project=mx-launcher
docker ps -a --filter name=mx-launcher-server-shadow
docker ps -a --filter name=mx-internal-postgres-shadow
## 3. 删除containerd
crictl images | grep -E 'qpjoy/mx-launcher-server|caddy|coredns|postgres'
crictl rmi --prune
```
