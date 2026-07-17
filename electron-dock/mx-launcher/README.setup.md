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

# Launcher
pnpm --dir electron-dock/mx-launcher --filter @qpjoy/mx-h2i-demo dev
pnpm --dir electron-dock/mx-launcher --filter @qpjoy/electron-launcher-app-h2o dev

# k8s install
cd ~/mx/workspace/de-llaaddddeerr/electron-dock/mx-launcher

kubeadm reset -f
systemctl restart containerd kubelet

# 安装host-runner
bash scripts/manage.sh ops site-slot native-host-runner install 19190
curl -sS http://127.0.0.1:19190/capabilities
CENTOS_LAN_IP="$(ip -4 route get 1.1.1.1 | awk '{for (i=1; i<=NF; i++) if ($i == "src") {print $(i+1); exit}}')"
curl -sS "http://${CENTOS_LAN_IP}:19190/capabilities"

bash scripts/install-k8s-centos.sh \
  --advertise-address "$CENTOS_LAN_IP" \
  --allow-cgroup-v1 \
  --image-repository registry.aliyuncs.com/google_containers

# 重新初始化K8s
# --reinit 会做这些事：
# 备份旧 /etc/kubernetes 到 /data/mx-backup/<timestamp>/kubernetes-conf
# 备份旧 /var/lib/etcd 到 /data/mx-backup/<timestamp>/etcd-old-cluster-backup
# 停止 kubelet
# 执行 kubeadm reset -f
# 清掉还占用 6443/10259/10257/2379/2380 的旧控制面进程
# 清理 /etc/cni/net.d、/run/flannel、/var/lib/cni、cni0、flannel.1
# 重新 kubeadm init
# 安装 Flannel，并把 Flannel Network patch 成 192.168.224.0/20
# 它不会删除 /var/lib/mx-launcher，所以 MX 的 PVC/Postgres/site-slots 数据还会留着给后续 deploy 使用。
POD_CIDR=192.168.224.0/20 \
SERVICE_CIDR=192.168.240.0/20 \
K8S_FLANNEL_IMAGE_REPOSITORY=docker.io/flannel \
bash scripts/install-k8s-centos.sh --advertise-address 192.168.1.4 --allow-cgroup-v1 --reinit

# 不重启docker，只重启k8s
export MX_K8S_APISERVER_ADVERTISE_ADDRESS=192.168.1.2
export PG_USER=mx_internal
export PG_PASSWORD=mx_internal
export PG_DB=mx_internal_shadow

bash scripts/manage.sh ops internal-production reinit-kubeadm
# 另起一个终端，repair-cni
bash scripts/manage.sh ops internal-production repair-cni

# 重新部署 MX：
TMPDIR=/data/tmp \
MX_K8S_OS_HOSTNAME=mx-internal-server \
MX_K8S_APISERVER_ADVERTISE_ADDRESS=192.168.1.2 \
MX_SHADOW_BUILDKIT_KEEP_STORAGE=2GB \
MX_SHADOW_BUILDKIT_PRUNE_UNTIL=24h \
bash scripts/manage.sh ops internal-production deploy
# deploy 会先把 192.168.1.2 和 K8s 本地网段加入 NO_PROXY/no_proxy，
# 再探活 kube-apiserver；不会先花时间构建、最后才在 Flannel apply 阶段暴露 API 不可达。
# 检查：
kubectl -n mx-internal-shadow get pods,svc,pvc -o wide
kubectl -n mx-dns get pods,svc -o wide
bash scripts/manage.sh ops internal-production status
curl -fsS http://127.0.0.1:18090/healthz



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

# 停k8s
bash scripts/manage.sh ops internal-production down
# 停宿主机侧 mx-internal-svc 和 native host-runner 
systemctl stop wg-quick@mx-internal-svc mx-internal-host-runner

bash scripts/manage.sh ops internal-production status
bash scripts/manage.sh ops internal-production gateway-smoke
curl -fsS http://127.0.0.1:18090/healthz

# 重启k8s里的Internal API
kubectl -n mx-internal-shadow rollout restart deployment/mx-launcher-internal
kubectl -n mx-internal-shadow rollout status deployment/mx-launcher-internal --timeout=180s

# rollout gateway
kubectl -n mx-internal-shadow rollout restart daemonset/mx-internal-gateway
kubectl -n mx-internal-shadow rollout status daemonset/mx-internal-gateway --timeout=180s

# rollout CoreDNS
kubectl -n mx-dns rollout restart deployment/mx-internal-coredns
kubectl -n mx-dns rollout status deployment/mx-internal-coredns --timeout=180s

# 验证
kubectl -n mx-internal-shadow get pods -o wide
kubectl -n mx-internal-shadow logs deployment/mx-launcher-internal --tail=120
curl --noproxy '*' -v http://127.0.0.1:18090/healthz
curl --noproxy '*' -v http://10.88.88.88:18090/healthz


# Oversea SSH Profile
# Worker URL 是 Internal worker 读取 job、回写 report 的 Internal API base。
# 默认填 http://127.0.0.1:18090；Admin 触发的 worker 跟 Internal API 在同一运行面，不依赖外部网络。
# 如果以后 worker 挪到独立宿主机，再填那个 worker 宿主机能访问到的 Internal gateway，例如 http://${CENTOS_LAN_IP}:18090。
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



# Test Luopan
LUOPAN_SDK_TEST_MODE=0 pnpm dev
# force standalone wg，可能会抢MX-H2I的的route，需要其重新连接才会回复。
LUOPAN_FORCE_STANDALONE_WG=1


# 测试发版功能
kubectl -n mx-internal-shadow create secret generic mx-release-oss \
  --from-literal=MX_RELEASE_OSS_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com \
  --from-literal=MX_RELEASE_OSS_BUCKET=mx-launcher \
  --from-literal=MX_RELEASE_OSS_ACCESS_KEY_ID=... \
  --from-literal=MX_RELEASE_OSS_ACCESS_KEY_SECRET=... \
  --from-literal=MX_RELEASE_OSS_PREFIX=mx-h2i/releases \
  --from-literal=MX_RELEASE_OSS_PUBLIC_BASE_URL= \
  --dry-run=client -o yaml | kubectl apply -f -

# 打包
pnpm --dir electron-dock/mx-launcher/demos/mx-h2i make:mac:dmg
pnpm --dir electron-dock/mx-launcher/demos/mx-h2i make:win


printf "mx-h2i oss smoke\n" > /private/tmp/mx-h2i-oss-smoke.txt

pnpm --dir electron-dock/mx-launcher/server release:publish -- \
  --base-url http://100.89.0.12:18090 \
  --kind installer \
  --storage oss \
  --platform darwin \
  --artifact /private/tmp/mx-h2i-oss-smoke.txt \
  --current-version 0.1.0 \
  --version 0.1.1-smoke \
  --channel smoke \
  --e2e-result passed

# 删除mihomo pid
pkill -TERM -f "$HOME/Library/Application Support/MX-H2I/h2o/mihomo-tunnel/bin/mihomo"

# Subscriptions
POST /internal/v1/user-center/users/{userId}/oversea/ensure-subscription
```
