```bash
# Fresh server without Node:
# scp resources/manage.sh root@server:/tmp/qp-tunnel-bootstrap.sh
# ssh root@server 'bash /tmp/qp-tunnel-bootstrap.sh'
# Or run all prerequisites explicitly:
# ssh root@server 'bash /tmp/qp-tunnel-bootstrap.sh bootstrap 22 @qpjoy/tunnel-cli@latest'

npm i -g @qpjoy/tunnel-cli@0.3.0

# Ubuntu -> MX H2I V2（账号）
sudo apt-get install -y wireguard-tools
read -rsp 'H2I password: ' H2I_PASSWORD; export H2I_PASSWORD; printf '\n'
qp-tunnel-cli h2i enroll --bootstrap-url 'https://h2i.example.com' --username 'user@example.com'
unset H2I_PASSWORD
qp-tunnel-cli h2i status

# Ubuntu -> MX H2I V2（匿名）
qp-tunnel-cli h2i enroll --bootstrap-url 'https://h2i.example.com' --anonymous

# 停止本地隧道；保留 lease 供重连
qp-tunnel-cli h2i down

# 以下 hdo 命令是 legacy V1，不要把 --server-url 与 V2 --internal-url 混合用于生产连接
qp-tunnel-cli hdo enroll --internal-url 'http://127.0.0.1:18090' --product-id h2o --identity-kind anonymous --lease-only
HDO_PASSWORD='...' qp-tunnel-cli hdo enroll --server-url 'https://domestic.example.com' --internal-url 'http://127.0.0.1:18090' --product-id h2o --username internal-i

qp-tunnel-cli install --url 'http://user:pass@host:3434/peer_xxx.mihomo.yaml'
# Domestic bootstrap can use an Internal-pushed local YAML before WG relay reaches Internal.
qp-tunnel-cli install --file '/opt/mx/current/qp-tunnel-cli/domestic-bootstrap-subscription.yaml'

# 更新系统脚本和进程
sudo qp-tunnel-cli install-script
sudo qp-tunnel-cli upgrade-systemd
sudo qp-tunnel-cli egress-on

sudo qp-tunnel-cli tun-off
sudo qp-tunnel-cli egress-on
sudo qp-tunnel-cli status

qp-tunnel-cli curl google.com

# 删除mac的HDO进程
qp-tunnel-cli hdo down --interface hdo-client

# tunnel-cli
qp-tunnel-cli install --url 'http://download:qpjoy@23.225.161.60:3434/peer_intelligent01.mihomo.yaml'

# K8s/containerd 镜像预热：Docker 能拉，但 kubelet/containerd 不能拉时用
sudo qp-tunnel-cli tun-on
sudo qp-tunnel-cli k8s preload-images
sudo qp-tunnel-cli tun-off




qp-tunnel-cli k8s preload-images --from-cluster
```

# V2 enroll
```bash
# 用户密码
unset H2I_ACCESS_TOKEN H2I_USER_ID

read -rsp 'H2I password: ' H2I_PASSWORD
export H2I_PASSWORD
printf '\n'

qp-tunnel-cli h2i enroll \
  --bootstrap-url https://h2i.www.com \
  --username '你的用户名'

unset H2I_PASSWORD

# 访客登录
# --anonymous
unset H2I_USERNAME H2I_PASSWORD H2I_ACCESS_TOKEN H2I_USER_ID

qp-tunnel-cli h2i enroll \
  --bootstrap-url https://h2i.www.com \

# qp-tunnel-cli h2i status
# wg show mx-h2i
# systemctl is-enabled qpjoy-h2i@mx-h2i.service
# systemctl status qpjoy-h2i@mx-h2i.service --no-pager


git -c http.proxy=http://127.0.0.1:7788 -c https.proxy=http://127.0.0.1:7788 pull

# docker拿到代理
systemctl show docker --property=Environment | tr ' ' '\n' | grep -i proxy

# update-subscription
qp-tunnel-cli update-subscription --url ''
```
