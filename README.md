# de-llaaddddeerr

OpenVPN + WireGuard 双 VPN 共存方案，实现公司内网与外网同时访问。

## 问题背景

在家远程办公时，我们经常遇到这样的困境：

```
场景：
- 连接公司 OpenVPN 后，可以访问公司内网，但外网受限（被公司网关过滤）
- 连接个人 WireGuard VPS 后，可以自由访问外网，但无法访问公司内网
- 两个 VPN 同时开启时，路由冲突，网络混乱
```

**本项目的目标**：让两个 VPN 和平共处，各司其职。

## 原理详解

### 网络拓扑

```
                          ┌─────────────────┐
                          │   公司内网       │
                          │  10.0.0.0/8     │
                          │  172.16.0.0/12  │
                          │  192.168.0.0/16 │
                          └────────▲────────┘
                                   │
                          ┌────────┴────────┐
                          │  OpenVPN 服务器  │
                          │   47.111.*.*    │
                          └────────▲────────┘
                                   │ utun (10.0.70.*)
                                   │
┌──────────────┐          ┌────────┴────────┐          ┌──────────────┐
│  家庭 Wi-Fi   │◄────────│     你的 Mac     │─────────►│   外网/互联网  │
│ 192.168.1.1  │   en0    │                 │   utun    │  Google/百度  │
└──────────────┘          └────────┬────────┘          └──────────────┘
                                   │ utun (10.7.0.*)
                          ┌────────┴────────┐
                          │  WireGuard VPS  │
                          │   23.225.*.*    │
                          └────────┬────────┘
                                   │
                          ┌────────▼────────┐
                          │    自由的外网    │
                          └─────────────────┘
```

### 核心原理：路由优先级

macOS 的路由表遵循 **最长前缀匹配** 原则：

```
路由规则                    匹配范围          优先级
─────────────────────────────────────────────────────
192.168.1.0/24             ~256 个 IP        最高 (掩码最长)
10.7.0.0/24                ~256 个 IP        高
10.0.0.0/8                 ~1600万 IP        中
0.0.0.0/1                  ~21亿 IP          低
128.0.0.0/1                ~21亿 IP          低
default (0.0.0.0/0)        所有 IP           最低
```

**关键技巧**：用 `0.0.0.0/1` + `128.0.0.0/1` 代替 `default`，可以覆盖默认路由但不删除它。

### 路由策略

| 目标网段 | 走向 | 说明 |
|---------|------|------|
| `10.0.0.0/8` | OpenVPN | 公司内网（10.x.x.x） |
| `172.16.0.0/12` | OpenVPN | 公司内网（172.16-31.x.x） |
| `192.168.0.0/16` | OpenVPN | 公司内网（192.168.x.x） |
| `192.168.1.0/24` | 本地网关 | 家庭 Wi-Fi（覆盖上条规则） |
| `10.7.0.0/24` | WireGuard | WireGuard 内部通信 |
| `47.111.*.*` | 本地网关 | OpenVPN 服务器（必须直连） |
| `23.225.*.*` | 本地网关 | WireGuard VPS（必须直连） |
| `0.0.0.0/1` | WireGuard | 外网（0-127.x.x.x） |
| `128.0.0.0/1` | WireGuard | 外网（128-255.x.x.x） |

### 为什么 VPN 服务器要走本地网关？

```
❌ 错误配置：VPN 服务器的流量走 VPN 隧道
   你 → WireGuard 隧道 → 要连接 WireGuard 服务器 → 死循环！

✅ 正确配置：VPN 服务器的流量走本地网关
   你 → 家庭路由器 → 互联网 → VPN 服务器 → 建立隧道成功
```

## 环境信息

| 配置项 | 值 | 说明 |
|-------|-----|------|
| 本地网关 | 192.168.1.1 | 家庭 Wi-Fi 路由器 |
| OpenVPN IP | 10.0.70.* | 连接后分配的内网 IP |
| OpenVPN 服务器 | 47.111.*.* | 公司 VPN 服务器 |
| WireGuard IP | 10.7.0.* | 连接后分配的内网 IP |
| WireGuard VPS | 23.225.*.* | 个人 VPS 服务器 |

## 使用方法

### 0. 配置环境

首先编辑 `config.env`，填入你的实际 IP：

```bash
# config.env
OPENVPN_SERVER="47.111.x.x"    # 你公司的 VPN 服务器 IP
VPS_IP="23.225.x.x"            # 你的 WireGuard VPS IP
WG_GATEWAY="10.7.0.1"          # WireGuard 网关
OPENVPN_SUBNET="10.0.70"       # OpenVPN 分配的网段前缀
WG_SUBNET="10.7.0"             # WireGuard 分配的网段前缀
HOME_NETWORK="192.168.1.0/24"  # 家庭网络
```

### 1. 配置 OpenVPN（可选但推荐）

如果你希望“只让部分网段走 VPN”，可以在客户端配置里使用以下模式：

```bash
1. 全局 VPN：所有流量走 VPN
2. 自定义 CIDR 分流：只让指定网段走 VPN
3. 中国直连 / 国外走 VPN：保留默认 VPN 路由，在客户端内嵌一份粗粒度中国 IPv4 直连路由表
```

仓库里的 `scripts/ovpn-install.sh` 已经支持这三种模式。
其中模式 3 还会额外加载 [scripts/local-direct-domains.txt](/Users/qpjoy/workspace/qpjoy/de/de-llaaddddeerr/scripts/local-direct-domains.txt:1) 里的常用国内域名白名单，并在生成客户端时解析成本地直连的 `/32` 主机路由。

如果你要更新“中国 IP 段”列表，可以运行：

```bash
./scripts/update-cn-routes.sh
```

它会从 APNIC 官方数据生成两份文件：

```bash
scripts/china-ipv4.txt          # 精确版
scripts/china-ipv4-coarse.txt   # 粗粒度客户端版
```

默认粗粒度前缀是 `/10`，你也可以在更新时调整：

```bash
CHINA_COARSE_PREFIX=9 ./scripts/update-cn-routes.sh
```

前缀越小，客户端里的路由越少，但会有更多“其实不在中国、也被当成直连”的 IP。

域名白名单是“生成客户端时解析一次”的快照，不是实时动态更新。
如果某些站点切换了 CDN IP，重新运行一次 `./scripts/update-cn-routes.sh` 和 `./scripts/ovpn-install.sh` 生成客户端即可。

### 1.5 批量生成 WireGuard 客户端

如果服务器上的 WireGuard 已经通过 [scripts/wireguard.sh](/Users/qpjoy/workspace/qpjoy/de/de-llaaddddeerr/scripts/wireguard.sh:1) 部署好了，可以直接批量生成客户端，不需要改动现有 OpenVPN 服务，也不需要把 WireGuard 迁到 Docker。

```bash
sudo bash ./scripts/wg-batch-clients.sh \
  --count 10 \
  --prefix team \
  --output-dir /root/wireguard-clients
```

脚本会在服务器上做两件事：

1. 直接往对应的 WireGuard 配置文件追加 10 个新 peer，并用 `wg addconf` 立即生效
2. 在输出目录里生成每个客户端的文件：

```bash
team01.conf                   # 标准 WireGuard 客户端
team01.mihomo.yaml            # 可直接导入 Clash/Mihomo 的完整配置
team01.mihomo-provider.yaml   # 仅节点内容，适合高级用法
clients.csv                   # 客户端和导出文件汇总
```

如果你后面要把这些文件挂到一个受保护的下载地址，也可以在生成时带上 `--base-url`：

```bash
sudo bash ./scripts/wg-batch-clients.sh \
  --count 10 \
  --prefix team \
  --output-dir /root/wireguard-clients \
  --base-url https://vpn.example.com/wg
```

这样 `clients.csv` 里会额外写出每个客户端的导入 URL。由于这些文件包含私钥，不要直接暴露到公开静态站点，至少要放在鉴权后面。

如果你想直接用 Docker 托管这些客户端文件，仓库里带了一个只读的 Caddy 示例：

```bash
cd docker/wg-client-files
cp .env.example .env
```

把 `.env` 里的 `WG_EXPORT_DIR` 改成你实际生成客户端文件的目录，按需调整端口和用户名。

先生成一个 Basic Auth 密码哈希：

```bash
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'ChangeMe123!'
```

把输出结果填到 `.env` 的 `WG_EXPORT_PASSWORD_HASH`，然后启动：

```bash
docker compose up -d
```

这个容器只负责受保护地分发 `/root/wireguard-clients` 里的文件，不参与 WireGuard 转发，也不会影响现有 OpenVPN/WireGuard 服务。

### 1.6 10 个客户端要不要限速

通常不用。

- 如果只是 10 个员工或设备共用一台 VPS，先直接跑，通常 WireGuard 本身就够轻，没必要一开始就上 `tc`
- 只有在你明确需要“每人固定上限”“防止单个客户端下载把带宽跑满”“做计费/配额”时，才值得加 `tc`
- 真要做限速，建议按每个 peer 的隧道 IP 做，例如 `10.7.0.2`、`10.7.0.3` 这种，在 `wg0` 上按 IP 分类；这属于后置优化，不是生成 10 个可用客户端的前置条件

这次仓库里先没有把 WireGuard 改成 Docker 版，是因为你已经有在线运行的宿主机部署。直接在现有 `wg0` 上追加 peer 的风险最小，也不会影响 OpenVPN。后面如果你只是想“分发配置文件”，可以单独再加一个 Docker 静态文件服务去托管 `/root/wireguard-clients`，但 WireGuard 服务本身不建议为了这个目的迁移。

### 1.7 Docker WireGuard + Mihomo 订阅 URL

如果你准备切到“Docker 里的 WireGuard 服务端 + 每个用户一个 Mihomo 订阅 URL”，仓库里已经补了一套独立栈：

```bash
docker/wg-mihomo-stack/
```

如果你不想再手工改 `.env`、重启容器、导出订阅、重挂限速，现在优先推荐直接用：

```bash
docker/wg-mihomo-stack/manage.sh
```

这个脚本会统一处理：

- 初始化 `.env`
- 生成订阅 Basic Auth 哈希
- 修改 `WG` / 订阅端口、认证和带宽默认值
- 启动 / 重启 `subscriptions` 和 `wireguard`
- 批量新增 / 删除用户
- 自动重新导出 Mihomo YAML
- 自动重挂 `tc/ifb` 上下行限速

最常用的命令是：

```bash
sudo bash ./docker/wg-mihomo-stack/manage.sh setup
sudo bash ./docker/wg-mihomo-stack/manage.sh reconfigure
sudo bash ./docker/wg-mihomo-stack/manage.sh reset-auth
sudo bash ./docker/wg-mihomo-stack/manage.sh stop all
sudo bash ./docker/wg-mihomo-stack/manage.sh destroy --wipe-data --wipe-env --yes
sudo bash ./docker/wg-mihomo-stack/manage.sh reinstall
sudo bash ./docker/wg-mihomo-stack/manage.sh add-user --names test01,test02
sudo bash ./docker/wg-mihomo-stack/manage.sh del-user --names test02
sudo bash ./docker/wg-mihomo-stack/manage.sh set-limit --names test01 --down-ceil 9mbit --up-ceil 9mbit
sudo bash ./docker/wg-mihomo-stack/manage.sh status
```

其中：

- `stop all`：只停容器，不删数据
- `destroy --wipe-data --wipe-env --yes`：删除容器并清掉当前栈生成的配置、订阅、限速文件
- `reinstall`：先完整清空当前 `wg-mihomo-stack`，再重新执行交互式 `setup`
- `reconfigure`：不用手改 `.env` 或 `peer-limits.env`，直接交互式修改端口、订阅账号密码和全局带宽默认值，再由脚本重建栈
- `reset-auth`：只重置订阅用户名 / 密码，重建 `subscriptions`，并尝试在本机用新的明文密码校验一个现有的 `.mihomo.yaml`

如果你现在想把服务器上这套 `wg-mihomo-stack` 完全交给 `manage.sh` 接管，最直接的迁移方式就是：

```bash
sudo bash ./docker/wg-mihomo-stack/manage.sh destroy --wipe-data --wipe-env --yes
sudo bash ./docker/wg-mihomo-stack/manage.sh setup
```

后面再做任何管理，都尽量走：

```bash
sudo bash ./docker/wg-mihomo-stack/manage.sh add-user --names user02,user03
sudo bash ./docker/wg-mihomo-stack/manage.sh del-user --names user03
sudo bash ./docker/wg-mihomo-stack/manage.sh set-limit --names user02 --down-ceil 9mbit --up-ceil 9mbit
sudo bash ./docker/wg-mihomo-stack/manage.sh reconfigure
sudo bash ./docker/wg-mihomo-stack/manage.sh restart wireguard
sudo bash ./docker/wg-mihomo-stack/manage.sh status
```

这套方案的定位是：

- 服务端协议仍然是 `WireGuard`
- 用户端仍然用 `Clash/Mihomo`
- 每个用户拿到的是自己的 `xxx.mihomo.yaml` 订阅 URL
- 不需要在宿主机安装 `wireguard-tools` 包，但宿主机内核仍然要支持 WireGuard

这里有两个完全不同的端口，不要混在一起：

- `WG_SERVER_PORT`：给客户端实际连接的 WireGuard `UDP` 端口，例如 `52080`
- `WG_EXPORT_SITE_ADDRESS` 对应的 `443/3434`：只是下载 `user01.mihomo.yaml` 的订阅分发端口

也就是说，如果用户侧走的是 `WG` 协议，真正承载 VPN 流量的是 WireGuard 端口，不是 Mihomo/Caddy 的端口。
这套服务端也不需要对外开放 `7890` 这类 Mihomo 本地代理端口。

需要特别说明的是：`mihomo` 官方文档里，`WireGuard` 出现在 `Proxies`，而不是 `listeners/inbounds`。也就是说，`mihomo` 本身并不是一个“WireGuard 入站服务端”。如果你坚持用户侧用 `WG` 协议，服务端仍然需要一个真正的 WireGuard 端点；这里用的就是 Docker 里的 WireGuard 容器。

如果你的服务器已经像你现在这样，直接用 [scripts/wireguard.sh](/Users/qpjoy/workspace/qpjoy/de/de-llaaddddeerr/scripts/wireguard.sh:1) 在宿主机上稳定跑起来了，那我更推荐：

- 继续保留宿主机 WireGuard
- 不再启动 Docker 里的 `wireguard` 服务
- 只使用“把标准 `.conf` 转成 Mihomo YAML”这一层
- 再单独启动 `subscriptions` 服务做 HTTPS / Basic Auth 分发

这是当前更稳、更贴近你现网验证结果的路径。

宿主机稳定版的最短流程是：

1. 继续用 `scripts/wireguard.sh` 添加客户端，拿到生成的标准 `.conf`
2. 把这些 `.conf` 放到一个目录，例如 `/root/wireguard-clients`
3. 运行转换：

```bash
bash ./scripts/export-lsio-wireguard-mihomo.sh \
  --input-dir /root/wireguard-clients \
  --output-dir ./docker/wg-mihomo-stack/data/subscriptions \
  --base-url https://vpn.example.com
```

4. 只启动订阅分发：

```bash
cd docker/wg-mihomo-stack
docker compose up -d subscriptions
```

如果你的服务器还是 `docker-compose 1.x`：

```bash
docker-compose up -d subscriptions
```

也就是说，对你现在这台机子，更推荐的实际架构是：

```text
宿主机 WireGuard (稳定)
        +
Mihomo YAML 导出脚本
        +
Caddy 订阅分发容器
```

初始化步骤：

```bash
cd docker/wg-mihomo-stack
cp .env.example .env
```

先把 `.env` 里的这些值改掉：

```bash
WG_SERVER_HOST=你的公网IP
WG_SERVER_PORT=52080
WG_STACK_SUBNET=10.253.0.0/24
WG_STACK_GATEWAY=10.253.0.1
WG_PEERS=user01,user02,user03,user04,user05,user06,user07,user08,user09,user10
```

如果你继续测试 Docker 版 WireGuard，建议优先用 `52000-53000` 之间的高位 UDP 端口，例如 `52080`、`52123`、`52888`。如果宿主机上原来的 `wg0` 还在跑，要么先停掉它，要么保证两个实例不要占同一个 UDP 端口。

另外，建议把 Docker 这套栈自己的 bridge 子网固定下来，不要让 Docker 自动挑一个新的 `172.x` 网段。`WG_STACK_SUBNET` / `WG_STACK_GATEWAY` 就是干这个的。更稳的默认值是：

- `WG_STACK_SUBNET=10.253.0.0/24`
- `WG_STACK_GATEWAY=10.253.0.1`

这样至少能明确避开：

- OpenVPN 默认服务端网段 `10.8.0.0/24`
- 这套 Docker WG 客户端网段 `10.13.13.0/24`
- Docker 自动分配的随机桥接网段

订阅分发这层有两种模式：

1. 没有域名，先用 IP：

```bash
WG_EXPORT_SITE_ADDRESS=:8080
WG_EXPORT_BASE_URL=http://你的公网IP:3434
WG_EXPORT_FALLBACK_PORT=3434
```

2. 有域名，直接自动 HTTPS：

```bash
WG_EXPORT_SITE_ADDRESS=vpn.example.com
WG_EXPORT_BASE_URL=https://vpn.example.com
```

如果你走域名模式，还需要：

- 把域名的 `A` 记录指到这台服务器公网 IP
- 在 `docker-compose.yml` 里把 `subscriptions` 的 `80/443` 端口映射加回来
- 放通服务器的 `80/tcp` 和 `443/tcp`
- 首次启动 `subscriptions` 容器时让 Caddy 可以正常连外网申请证书

这种情况下你不需要手动写证书，Caddy 会自动签发和续期 HTTPS 证书。

`WG_KEEPALIVE_PEERS=all` 默认已经开着，这个设置对移动网络和 NAT 场景更稳，适合“隔一段时间断开”的场景先作为默认值。

Docker 版 WireGuard 现在也已经改成了更保守的方式：

- 不再使用 `host network`
- 通过 `宿主机 ${WG_SERVER_PORT}/udp -> 容器 51820/udp` 显式映射

这样即使容器里的 WireGuard 出问题，也比直接共享宿主机网络命名空间更容易隔离。

为了兼容更多环境，这份 compose 现在默认只保留了 `NET_ADMIN`。`SYS_MODULE` 和 `/lib/modules` 挂载在 LinuxServer 文档里本来就是可选项；对 macOS 的 Docker Desktop 来说，去掉它们通常更省事。

如果你非常担心再次触发 IDC 风控，我建议先按下面的灰度顺序做，而不是先删宿主机 WG：

1. 先保留宿主机 WG，当作回退
2. Docker WG 只开一个新端口，例如 `52080/udp`
3. 先只生成 1 个测试用户，连续观察一段时间
4. 确认稳定后，再迁移更多用户
5. 最后再决定是否删除宿主机 WG

如果你有 IDC 控制台 / KVM / 带外登录，那再做“先删宿主机 WG”会更安全；如果没有，建议不要把唯一的回退路径先砍掉。

在远程 Ubuntu 上，推荐先跑一遍只读检查，不动现网服务：

```bash
bash ./scripts/check-vpn-stack.sh
```

更稳的顺序是：

1. 先跑一次 `check-vpn-stack.sh` 记基线
2. 只启动 `subscriptions`
3. 再跑一次 `check-vpn-stack.sh`
4. 如果宿主机 WireGuard 已经稳定，优先停在这里，不要再启 Docker WireGuard
5. 只有在带外控制台可用时，才继续灰度测试 Docker WireGuard

`7890`、`7897` 这类端口是 Mihomo / Clash 客户端本地监听端口，不是服务器公网暴露的 WireGuard 端口。IDC 真正能看到的，通常是你对外开放的 `WG_SERVER_PORT/udp`，以及订阅分发用的 `3434` 或 `443`。

如果你的服务器上仍然保留 OpenVPN，这套 Docker WG 可以共存，但要同时满足下面 3 个条件：

1. 公开监听端口不能撞车  
   例如 OpenVPN 用 `334/udp`，Docker WG 用 `52080/udp`
2. 隧道内网网段不能重叠  
   OpenVPN 默认 `10.8.0.0/24`，Docker WG 默认 `10.13.13.0/24`
3. Docker bridge 子网也不能和上面两个重复  
   推荐单独固定成 `10.253.0.0/24`

如果 OpenVPN 正在占用 `443/tcp`，那你就不能同时让 `subscriptions` 容器绑定 `443/tcp`。这种情况下，先用：

```bash
WG_EXPORT_SITE_ADDRESS=:8080
WG_EXPORT_BASE_URL=http://你的公网IP:3434
WG_EXPORT_FALLBACK_PORT=3434
```

等 WireGuard 部分稳定了，再考虑单独给订阅分发切域名和 HTTPS。

如果你仍然想继续试“Docker 里的 WireGuard 服务端”，再启动：

```bash
docker compose up -d wireguard
```

如果你的服务器还是 `docker-compose 1.x`，把上面的命令替换成：

```bash
docker-compose up -d wireguard
```

这份 compose 现在已经不是 `host network`，而是：

- 宿主机 `WG_SERVER_PORT/udp`
- 映射到容器里的 `51820/udp`

也就是说，Docker WireGuard 现在走的是更保守的 `bridge + 端口映射`。它比早期的 `host network` 更容易隔离问题，也更适合做灰度。

如果你看到过下面这个报错：

```bash
sysctl "net.ipv4.conf.all.src_valid_mark" not allowed in host network namespace
```

那是更早一版 `host network` 配置下的现象，不是当前这版 compose 的行为。

LinuxServer 的 WireGuard 镜像会把每个 peer 的标准配置生成到：

```bash
docker/wg-mihomo-stack/data/wireguard/
```

接着把这些标准 `.conf` 翻译成每用户独立的 Mihomo 订阅文件。推荐直接用包装脚本，它会自动读取 `.env` 里的 `WG_EXPORT_BASE_URL`：

```bash
bash ./scripts/export-wg-mihomo-stack.sh
```

最后启动订阅分发服务：

```bash
docker compose up -d subscriptions
```

老版环境同理可用：

```bash
docker-compose up -d subscriptions
```

如果老版本 `docker-compose 1.x` 在这里报：

```bash
ERROR: for <container> 'ContainerConfig'
```

这通常不是 `Caddyfile` 配错，而是 `docker-compose` 在“重建旧容器”时踩到了自己的兼容性问题。最稳的做法是只删除 `subscriptions` 这个旧容器，然后重新拉起：

```bash
docker-compose stop subscriptions || true
docker-compose rm -f subscriptions || true
docker rm -f wg-mihomo-subscriptions 2>/dev/null || true
docker-compose up -d subscriptions
```

这组命令只动订阅分发容器，不会碰现有 OpenVPN，也不会影响还没启动的 Docker WireGuard。

用户实际拿到的链接类似：

```bash
http://你的公网IP:3434/user01.mihomo.yaml
# 或者
https://vpn.example.com/user01.mihomo.yaml
```

为了避免把私钥裸露在公网，订阅服务默认带 Basic Auth。你需要先生成一个密码哈希，填进 `.env` 的 `WG_EXPORT_PASSWORD_HASH`：

```bash
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'ChangeMe123!'
```

把输出写进 `.env` 时，建议这样保存：

```bash
WG_EXPORT_PASSWORD_HASH='$2a$14$...'
```

这里外层的单引号很重要。因为 bcrypt 哈希里本身带很多 `$`，如果你把它原样写进 Compose 的 `.env`，这些 `$` 很容易被插值机制吃掉，最后 Caddy 启动时就会报类似 `base64-decoding password` 的错误。

然后用户访问时：

```bash
http://用户名:密码@你的公网IP:3434/user01.mihomo.yaml
```

更稳妥的做法是把“URL”和“账号密码”分开发，不把密码直接写在链接里。

如果你现在只有 `IP:端口`，没有域名和证书，这个订阅分发就是 `HTTP` 而不是 `HTTPS`。这种情况下 Basic Auth 只能做访问控制，不能提供传输加密；更适合临时分发或受控环境，不适合长期把带私钥的订阅暴露在公网。有域名时，优先走 `https://你的域名/...`。

### 1.8 WireGuard 用户限速

仓库里新增了：

```bash
scripts/wg-tc-limit.sh
docker/wg-mihomo-stack/peer-limits.csv.example
```

它沿用了 [scripts/iptables_tc.sh](/Users/qpjoy/workspace/qpjoy/de/de-llaaddddeerr/scripts/iptables_tc.sh:1) 现在的思路：

- 使用 `HTB`
- 按 peer 的隧道 IP `/32` 分类
- 下载方向用 `u32 match ip dst` 做 `wg0` egress 整形
- 上传方向可选通过 `ifb` + `u32 match ip src` 做 ingress 整形

示例：

```bash
sudo bash ./scripts/wg-tc-limit.sh apply \
  --if wg0 \
  --limits-file ./docker/wg-mihomo-stack/peer-limits.csv.example \
  --total-rate 100mbit \
  --base-rate 1mbit
```

如果你现在跑的是 Docker 版 WireGuard，`wg0` 在容器里，不在宿主机网络命名空间里。此时推荐直接加：

```bash
sudo bash ./scripts/wg-tc-limit.sh apply \
  --docker-container wg-mihomo-wireguard \
  --if wg0 \
  --limits-file ./docker/wg-mihomo-stack/peer-limits.csv.example \
  --total-rate 100mbit \
  --base-rate 1mbit
```

如果你要上下行都限速，加上 `--ingress` 即可：

```bash
sudo bash ./scripts/wg-tc-limit.sh apply \
  --docker-container wg-mihomo-wireguard \
  --if wg0 \
  --ingress \
  --limits-file ./docker/wg-mihomo-stack/peer-limits.csv.example \
  --total-rate 9mbit \
  --ingress-total-rate 9mbit \
  --base-rate 1mbit
```

对“服务器总带宽 10M、单用户最高给 9M”这类场景，比较稳的建议是：

- 把 `--total-rate` 设成 `9mbit`
- 把 `--ingress-total-rate` 也设成 `9mbit`
- 单用户 CSV 里把 `down_ceil` / `up_ceil` 都设成 `9mbit`

这样会给 WireGuard 封装、NAT、TCP/UDP 开销留一点余量。真实业务层看到的有效吞吐通常会略低于 9M，这属于正常现象。

查看当前规则：

```bash
sudo bash ./scripts/wg-tc-limit.sh show --if wg0
```

Docker 版对应：

```bash
sudo bash ./scripts/wg-tc-limit.sh show --docker-container wg-mihomo-wireguard --if wg0
```

清理：

```bash
sudo bash ./scripts/wg-tc-limit.sh clean --if wg0
```

Docker 版对应：

```bash
sudo bash ./scripts/wg-tc-limit.sh clean --docker-container wg-mihomo-wireguard --if wg0
```

如果 CSV 只有 4 列：

```bash
name,cidr,rate,ceil
```

脚本会把这个速率同时用于上下行。

如果你想给上下行不同的值，用 6 列：

```bash
name,cidr,down_rate,down_ceil,up_rate,up_ceil
```

### 2. 连接流程

```bash
# 步骤 1: 连接 OpenVPN
打开 OpenVPN 客户端 → 连接公司 VPN

# 步骤 2: 连接 WireGuard
打开 WireGuard 客户端 → 连接个人 VPS

# 步骤 3: 修复路由
sudo ./scripts/fix-routes.sh
```

### 3. 验证效果

脚本会自动测试，你也可以手动验证：

```bash
# 测试公司内网
ping 10.0.70.1

# 测试外网（通过 WireGuard）
curl https://api.ipify.org    # 应显示 VPS 的 IP

# 测试 Google
curl -I https://www.google.com
```

### 4. 恢复网络

如果网络出现问题，运行恢复脚本：

```bash
sudo ./scripts/restore-routes.sh
```

## 脚本说明

### fix-routes.sh

主要功能：
1. **加载配置** - 从 `config.env` 读取 IP 配置
2. **备份当前路由表** - 保存到 `~/.route_backup`
3. **自动检测网关** - 从 DHCP 获取本地网关地址
4. **自动检测接口** - 识别 OpenVPN 和 WireGuard 的 utun 接口
5. **设置精确路由** - 按优先级配置各网段的出口
6. **清理代理设置** - 关闭系统代理，刷新 DNS
7. **验证连接** - 测试公司内网和外网是否正常

### restore-routes.sh

主要功能：
1. **检测本地网关** - 多种方式尝试获取正确的网关
2. **清空路由表** - 删除所有自定义路由
3. **重建默认路由** - 恢复到标准网络配置
4. **验证恢复** - 测试网络是否恢复正常

## 常见问题

### Q: 为什么我的外网还是走 OpenVPN？

检查路由优先级：
```bash
netstat -rn | grep "^0/1\|^128\.0/1"
```
应该看到这两条路由指向 WireGuard 网关 (10.7.0.1)。

### Q: 公司内网连不上了？

1. 确认 OpenVPN 连接状态
2. 检查路由是否正确：
   ```bash
   route -n get 10.0.70.1
   # 应该显示 interface: utunX (OpenVPN 的接口)
   ```

### Q: 网络完全断了怎么办？

```bash
# 方法 1: 运行恢复脚本
sudo ./scripts/restore-routes.sh

# 方法 2: 手动恢复
sudo route -n flush
sudo route add default 192.168.1.1  # 换成你的网关

# 方法 3: 重启网络
关闭所有 VPN → 关闭 Wi-Fi → 重新开启 Wi-Fi
```

### Q: 如何修改配置适应我的环境？

编辑 `config.env` 文件：

```bash
# ============ VPN 服务器 ============
OPENVPN_SERVER="x.x.x.x"  # 改成你公司的 VPN 服务器
VPS_IP="x.x.x.x"          # 改成你的 VPS IP
```

## 文件结构

```
de-llaaddddeerr/
├── README.md              # 本文档
├── config.env             # 配置文件（包含实际 IP，不要提交到公开仓库）
├── docker/
│   ├── wg-client-files/   # 用 Caddy 受保护分发 WireGuard 客户端文件
│   └── wg-mihomo-stack/   # Docker WireGuard + Mihomo 订阅分发
├── scripts/
│   ├── fix-routes.sh      # 修复路由（主脚本）
│   ├── export-lsio-wireguard-mihomo.sh # 把标准 WG 配置转换成 Mihomo 订阅
│   ├── export-wg-mihomo-stack.sh # 读取 stack .env 并批量导出 Mihomo 订阅
│   ├── restore-routes.sh  # 恢复网络
│   ├── wg-tc-limit.sh     # 按 WireGuard peer IP 做 tc 限速
│   ├── wireguard.sh       # WireGuard 服务器安装脚本
│   └── wg-batch-clients.sh # 批量生成 WireGuard / Mihomo 客户端
└── network.restore.md     # 网络恢复笔记
```

## 技术细节

### 路由表查看命令

```bash
# 查看完整路由表
netstat -rn

# 查看特定 IP 的路由
route -n get 8.8.8.8
route -n get 10.0.70.1

# 查看网络接口
ifconfig -l
ifconfig utun0
```

### 手动路由操作

```bash
# 添加路由
sudo route add -net 10.0.0.0/8 -interface utun1
sudo route add -host 1.2.3.4 192.168.1.1

# 删除路由
sudo route delete -net 10.0.0.0/8
sudo route delete default

# 清空所有路由
sudo route -n flush
```

## License

MIT
