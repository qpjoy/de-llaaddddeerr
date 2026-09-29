## 同一条 HTTPS 订阅，按端口固定出口

以下 `--node` 是本次源码新增选项；先构建/安装包含该选项的版本，用 `qp-tunnel-cli help` 确认。历史命令里固定的旧 npm 版本没有此能力。

`h2i enroll` 用于登录并建立 H2I 隧道；Mihomo 订阅代理用 `install`。`--instance` 区分本地服务，`--mixed-port` 区分监听端口，`--node` 填订阅 YAML 中完整的节点 `name`，不是自定义简称。没有 `--xjp` 选项。

若 7788 已由 Internal 的 `mx-internal-egr` 管理，保留它，只新增 XJP 实例：

```bash
sudo apt-get install -y python3-yaml
# 在 Bash 中读取 Admin「Copy 外网」或 H2O 本次有效分享链接，不写入 shell 历史。
read -rsp 'HTTPS subscription URL: ' OVERSEA_SUB_URL; printf '\n'
sudo qp-tunnel-cli install \
  --instance xjp01 --mixed-port 7789 \
  --node mx-oversea-xjp01-hysteria2 \
  --url "$OVERSEA_SUB_URL" --no-auth
unset OVERSEA_SUB_URL

sudo qp-tunnel-cli status --instance xjp01
sudo qp-tunnel-cli update-subscription --instance xjp01
# 应用的 HTTP/HTTPS 代理填 http://127.0.0.1:7789；SOCKS5 填 socks5h://127.0.0.1:7789。
```

在**没有现有 7788 服务的新服务器**，可用同一个 `$OVERSEA_SUB_URL` 再安装 `--instance jp01 --mixed-port 7788 --node mx-oversea-jp01-hysteria2`。订阅对应的用户须有 JP/XJP 两个站点的授权和已同步账号。HTTPS token 链接不需要 Basic Auth。

绑定保存在实例自己的 `client.env` 中，刷新和重启保留。运行配置仅保留指定代理，代理组均只指向它；原订阅的 DIRECT/REJECT 分流规则保留。该节点故障时代理请求失败，不自动改走其他地区或 DIRECT。新订阅缺少指定节点或核心校验失败时，拒绝替换配置并保留上一次配置。节点自身公网 IP 的固定仍取决于服务器是否保持同一公网地址。

`xjp01` 使用 `/etc/mihomo-client/instances/xjp01` 和 `mihomo-client@xjp01.service`。命名实例绑定节点时清除订阅携带的额外代理、DNS 和控制端口监听，避免与 7788 实例冲突。无需对这个应用专用实例运行 `egress-on` / `tun-on`。本功能支持订阅中内联的 `proxies`，不支持通过 `proxy-providers` 或 `dialer-proxy` 链间接指定节点。

如需主动恢复自动策略：

```bash
sudo qp-tunnel-cli update-subscription --instance xjp01 --node auto
```

Admin 与 H2O 为**同一用户**管理同一份分享链接。增减授权后刷新原订阅即可；只分配 JP 也应返回有效的单节点订阅。Admin Rotate 或 H2O 重新生成都会使该用户上一条分享链接失效，选一处生成一次，再更新所有消费者的 URL。不要用 H2O「分配系统默认」修复 404，它会重设站点授权；「刷新系统默认」才是读取当前授权。服务端仅保存 token 摘要，Admin 已签发的明文不能由 H2O 再查询回来。

## subscriptions 系统聚合链接

Internal Admin → User Center → `subscriptions` →「生成聚合链接 / 复制 HTTPS 聚合链接」提供一个无需 Basic Auth 的 URL。新 Oversea 同步就绪后刷新同一链接即可；只包含已部署就绪节点。可直接使用上面的 `--instance xjp01 --mixed-port 7789 --node mx-oversea-xjp01-hysteria2` 安装命令。

系统聚合订阅不含 Oversea-Auto，Clash 首次导入需手动选择节点；固定 CLI 实例启动前由 `--node` 明确选择。默认 `?bandwidth=unlimited` 对服务端已选「不限速」的节点省略固定速率；也可用 `?bandwidth=50` 设置客户端提示。JP01 原服务端限速和 50 Mbps 提示不变，不能通过 URL 参数取消。旧的各站 Basic 链接仍保留原限速提示。

节点服务端策略在新建或编辑 Oversea SSH 信息时设置，保存后对目标节点执行 Sync Remote 才生效。聚合链接发放、轮换与普通用户/H2O 分享链接相互独立。对这份手动配置执行 `--node auto` 只是清除 CLI 绑定，仍须按订阅策略手选节点。

## 旧版 PyYAML 的 `sort_keys` 报错

若 `--node` 报 `Cannot apply --node: dump_all() got an unexpected keyword argument 'sort_keys'`，这是旧系统 PyYAML 与 CLI 的兼容问题，和节点授权、限速及前一条 geox-url 日志无关。2.1.14 已移除该参数，不要求升级系统 Python / PyYAML。安装修复版后重试原来的 XJP 安装命令；已有实例也可执行 `sudo qp-tunnel-cli update-subscription --instance xjp01 --node mx-oversea-xjp01-hysteria2`。

配置生成仍先写临时文件并通过 Mihomo 校验，再替换当前配置。失败时不替换旧运行配置、不重启该实例；2.1.14 同时修复失败后临时文件清理。不要用重新分配用户默认站点或轮换订阅链接处理此错误。

## 历史操作记录

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
# 独立给其他应用消费的系统订阅；不会改动现有 7788 默认实例
npm i -g @qpjoy/tunnel-cli@2.0.8
qp-tunnel-cli install --instance subscriptions --mixed-port 7890 \
  --url 'http://user:pass@host:3434/peer_subscriptions.mihomo.yaml'
qp-tunnel-cli status --instance subscriptions
# Domestic bootstrap can use an Internal-pushed local YAML before WG relay reaches Internal.
qp-tunnel-cli install --file '/opt/mx/current/qp-tunnel-cli/domestic-bootstrap-subscription.yaml'

# 默认不加--instance subscriptions，加了--instance subscriptions，则只更新指定的实例，不更新系统默认7788实例
qp-tunnel-cli install \
  --instance subscriptions \
  --mixed-port 7890 \
  --url '<刚 Reveal 的完整 URL>'

qp-tunnel-cli update-subscription --instance subscriptions
qp-tunnel-cli status --instance subscriptions

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

# docker pull
qp-tunnel-cli docker-build-proxy on
qp-tunnel-cli docker-build-proxy off
# git pull
git -c http.proxy=http://127.0.0.1:7788 -c https.proxy=http://127.0.0.1:7788 pull

# docker拿到代理
systemctl show docker --property=Environment | tr ' ' '\n' | grep -i proxy

# subscriptions 首次安装（之后才能 update）
qp-tunnel-cli install --instance subscriptions --mixed-port 7890 --url '<subscription-url>'
# 刷新已保存的 URL；更换 URL 时再追加 --url '<subscription-url>'
qp-tunnel-cli update-subscription --instance subscriptions

# docker环境变量目录
/etc/systemd/system/docker.service.d/
# k8s 代理位置
/etc/systemd/system/kubelet.service.d/proxy.conf
```

# V2 订阅
### 新增7789端口代理
```bash
# 添加订阅
qp-tunnel-cli install \
  --instance xjp01 --mixed-port 7789 \
  --node mx-oversea-xjp01-hysteria2 \
  --url '<系统聚合订阅URL>' --no-auth

QP_TUNNEL_MIXED_PORT=7789 qp-tunnel-cli curl -I https://www.google.com

# 更新订阅
qp-tunnel-cli update-subscription \
  --instance xjp01 \
  --node mx-oversea-xjp01-hysteria2

# 启动
qp-tunnel-cli start --instance xjp01
qp-tunnel-cli status --instance xjp01
```