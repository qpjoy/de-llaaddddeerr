# OpenVPN 反向接入设计（`qp-tunnel-cli open`）

本文记录 `@qpjoy/tunnel-cli` 中 `open` 命令族的设计依据、边界和验收口径。
目标读者是后续维护这条链路的人：看完这一篇就能理解为什么每个约束存在，
而不需要回溯讨论过程。

## 1. 要解决的问题

海外服务器需要主动连到一台内网机器。内网机器只有出方向连通性，没有公网入口，
并且它的网络已经很拥挤：

```text
default via 192.168.1.1 dev eno2          物理出口
10.8.0.0/24  dev tun0                     另一套 OpenVPN server（openvpn-server@server.service，正在运行）
10.88-10.91  dev mx-internal-svc          MX Launcher WireGuard overlay
100.88-100.91 dev hdo-internal            HDO V1 overlay
172.17-172.31 dev docker0/br-*            15 个 Docker bridge，默认池已耗尽
192.168.0.0/20 等                          Docker 溢出到 192.168 的地址池
192.168.224.0/24 dev cni0 + flannel.1     k8s CNI（非默认的 10.244）
7788 / 7890                                两套 mihomo/clash 实例
```

因此这条链路的第一约束不是"能连上"，而是**接入之后上面这些一个都不能变**。

## 2. 结论

用 OpenVPN 做**反向可达**是合适的：它有成熟的 client-config-dir 固定地址、
证书身份和多 remote 故障转移，做"多个 spoke 汇聚到一个 hub"比 WireGuard 好管理。

用 OpenVPN 做**抗封锁**则没有理论优势——裸 OpenVPN 的握手指纹比 WireGuard 更容易
被识别。但现场有一年以上的实测稳定记录，所以默认链路仍然是裸 UDP OpenVPN；
把它套进已有的混淆载体是备用手段，不是默认路径（见 §8）。

## 3. 角色与命令

一个动词、两个角色，因为它们是同一条链路的两端：

| 角色 | 位置 | 脚本 | 状态目录 |
| --- | --- | --- | --- |
| server | 海外服务器 | `scripts/openvpn-server.sh` | `/etc/qp-openvpn-server/<instance>` |
| client（spoke） | 内网服务器、或本机 Mac | `scripts/openvpn-client.sh` | `/etc/qp-openvpn/<instance>` |

```bash
# 海外
qp-tunnel-cli open preflight --server --subnet 100.127.0.0/24
qp-tunnel-cli open install --host 203.0.113.10 --port-range 20000-20100
qp-tunnel-cli open create internal-01 --ip 100.127.0.10 --oversea
qp-tunnel-cli open list
qp-tunnel-cli open reachable

# 内网 / 本机
qp-tunnel-cli open preflight --file internal-01.ovpn
qp-tunnel-cli open enroll --file internal-01.ovpn
qp-tunnel-cli open doctor
qp-tunnel-cli open egress on --mode cn-direct
qp-tunnel-cli open egress off
```

`up/down/restart/status/logs/uninstall` 两端同名。角色由本机实际装了哪一端推断
（`server.env` vs `client.conf`），两端都装时必须显式给 `--server` / `--client`。

`--instance` 是命名空间，默认 `mx`，**一台海外服务器一个 instance**。每个 instance
独占接口名、systemd unit、iptables 链和状态目录，所以一台内网机器可以同时连多台
海外服务器而互不干扰。

## 4. 网段：为什么是 `100.127.0.0/24`

排除掉上面路由表里的所有网段之后：

- **`172.66`–`172.88` 不能用**。RFC1918 在 172 段只有 `172.16.0.0/12`
  （172.16.0.0–172.31.255.255）。`172.64.0.0/13` 是 Cloudflare 的公网段，
  拿来当内网会把大量 HTTPS 打进黑洞。
- `172.16.0.0/16` 是 172 私网里唯一空闲的 `/16`（Docker 默认池从 `172.17` 起算，
  不会回头要 `172.16`），但海外侧危险：**AWS 默认 VPC 就是 `172.31.0.0/16`**。
- `10.*` 归 Launcher ProductNetwork 规划，约定新增应用不超过 10 个，即 `10.100` 以下保留。
- `198.18.0.0/15` 是 mihomo fake-ip。
- `100.88`–`100.91` 是 HDO V1。

**默认取 `100.127.0.0/24`**（RFC 6598 共享地址空间）：Docker 的默认地址池永远到不了，
kubeadm 默认不用，离 HDO 占用的 100.88–100.91 足够远，而且 tunnel-cli 的
`defaultNoProxyEntries` 里已经包含 `100.64.0.0/10`，天然 no-proxy。

但**默认值只是默认值**。真正的保证来自 `preflight`：它枚举
`ip route show table all`、Docker network、CNI 和 WireGuard 的实际占用，
算出冲突就拒绝安装，并给出本机确实空闲的候选段。任何写死的排除表都会在
下一台定制过 CNI 的机器上失效——这台机器的 CNI 在 `192.168.224.0/24` 就是证据。

多台海外服务器各用一个 `/24`：`100.127.0.0/24`、`100.127.1.0/24`……
地址从 `.10` 开始分配，`.1` 是 server，低位留给固定用途。

## 5. 客户端的非侵入保证

生成的 `client.conf` 固定包含：

```
dev ovpn-<instance>          # 不抢 tun0；接口名由 instance 决定，绝不自动挑
dev-type tun                 # 接口名不以 tun/tap 开头，必须显式声明类型
topology subnet              # route-nopull 会连 topology 一起丢掉，必须本地声明
route-nopull                 # 只接受 ifconfig，不接受任何路由
pull-filter ignore "redirect-gateway"
pull-filter ignore "dhcp-option"
pull-filter ignore "route"
pull-filter ignore "route-ipv6"
pull-filter ignore "block-outside-dns"
pull-filter ignore "register-dns"
script-security 0            # 没有 up/down 钩子，谁都改不了 resolv.conf
```

`route-nopull` 保留 `ifconfig`，所以仍然拿到分配地址，内核只多一条
`100.127.0.0/24 dev ovpn-mx` 的直连路由。OpenVPN ≥ 2.5 已经把 `dhcp-option`
并入 `route-nopull`，显式 pull-filter 是为了让 RHEL 上的老客户端得到同样约束。

服务端也不 push 任何东西（`write_server_config` 里没有一行 `push`），所以就算有人
绕过本工具直接 `openvpn --config`，也一样拿不到路由和 DNS。

### 5.1 外拨包被本地代理劫持

如果本机 mihomo 处于 TUN 模式或 nft auto-redirect，OpenVPN 打给海外的 UDP 会被
吸进 mihomo。`enroll --pin-route auto`（默认）会先做 `ip route get <server>`：
只有当出接口不是物理默认接口、且看起来是隧道设备时，才加一条
`<server>/32 via <物理网关> dev <物理接口>` 的 pin 路由，并记进 `state.json`，
`down` 时精确删除。

当前这台内网机器的 `iptables -t nat` 里只有 KUBE/CNI/DOCKER 链，没有 7890 的
REDIRECT，说明 clash 是纯 env 代理，不劫持流量，所以 auto 模式下不会加任何路由。

配合使用：`MIHOMO_TUN_ROUTE_EXCLUDE_ADDRESS=<server>/32`（mihomo-client.sh 已支持）。

### 5.2 用快照证明，而不是声称

`enroll` 前先落一份 `snapshot-before.txt`：默认路由、`/etc/resolv.conf` 的
sha256、`iptables-save -t nat` 的 sha256、全部已路由网段。

`open doctor` 拿当前状态和它对比，逐项 PASS/FAIL。iptables 那项只报 WARN，
因为 Docker 和 kube-proxy 本来就一直在改这张表，判 FAIL 会是噪音。

## 6. 服务端

### 6.1 runtime 自动选择

约定：**海外机器上如果已经有 qp-tunnel-cli 托管的 `mx-oversea-hysteria2`，
OpenVPN 也装 docker 版；否则直接装宿主机。** `--runtime docker|host` 可覆盖。

docker 版必须 `network_mode: host`：

```yaml
network_mode: host
cap_add: [NET_ADMIN]
devices: ["/dev/net/tun:/dev/net/tun"]
```

这不是偷懒。bridge 网络下 tun 设备在容器自己的 netns 里，**海外宿主机和旁边的
hysteria2 容器都 ping 不到 `100.127.0.10`**，整个需求当场作废。代价是不能用
compose 的 `ports:`，也不能加入 `hy2_access` 网络——这恰好就是我们要的解耦。

镜像本地构建（`alpine:3.20` + `apk add openvpn`），不拉第三方 OpenVPN 镜像，
避免依赖一个已经停止维护的上游。

### 6.2 PKI

直接用 openssl + 一个小 CA 数据库，不用 easy-rsa：

- 安装过程不需要访问 GitHub（Nyr 脚本会去下载 easy-rsa）
- 有了 `index.txt`/`serial` 就能用 `openssl ca -revoke` + `-gencrl` 做真正的吊销
- EC prime256v1，签发快；tls-crypt 本来就要求 OpenVPN ≥ 2.4，EC 同样从 2.4 起支持
- 用 EC 证书时 ECDHE 直接协商，所以 `dh none`，安装不会卡在生成 dhparam 上

`revoke` 同时写 CRL 和在 ccd 里追加 `disable`，两者任一生效即拒绝，fail closed。

### 6.3 固定地址

`open create` 会写 `ccd/<name>`：

```
ifconfig-push 100.127.0.10 255.255.255.0
```

这是 Nyr 脚本缺的关键能力。没有 ccd，服务端发的是池子地址，重连就换，
海外侧就失去了固定目标。

### 6.4 端口

不做"端口被封就 +1 漂移"。漂移只防端口封锁，不防协议指纹和 IP 封锁，还要解决
"客户端怎么知道漂到哪了"的分发难题。改用：

- 服务端 `--port-range 20000-20100` → 一条 iptables REDIRECT，一个进程听 100 个端口
- 签发的 profile 里写多条 `remote` + `connect-retry 3 30`

OpenVPN 自己会依次重试。零协调成本。

所有防火墙规则都放在 `QP-OPEN-<instance>` 和 `QP-OPEN-<instance>-NAT` 两条专属链里，
`PREROUTING`/`POSTROUTING` 上只有一条跳转，卸载时精确删除。有测试守住这条规矩。

## 7. 红线

以下东西全程不碰，任何后续改动都不应该突破：

- `/etc/wireguard/*`、`wg-quick@*`
- **发行版的 `openvpn-server@.service` / `openvpn-client@.service` 模板**
  ——这台内网机器上 `openvpn-server@server.service` 正在跑，属于别人。
  我们只用 `qp-openvpn-client@`、`qp-openvpn-server@`、`qp-openvpn-firewall@`，
  而且发现同名文件不是自己写的就直接拒绝覆盖
- `/etc/resolv.conf`、`systemd-resolved`、任何 resolver
- `net.ipv4.ip_forward`（只有服务端为了 egress NAT 才开，写在独立的 sysctl.d 文件里）
- 上述两条自有链之外的任何 iptables 链

对 `@qpjoy/tunnel-cli` 自身：新增只有 `src/open.ts` 和两个 `resources/openvpn-*.sh`，
`index.ts` 只多一行 dispatch。`h2i.ts`、`hdo.ts`、`mihomo-client.sh` 一行未改，
`npm i -g` 之后的默认行为完全不变。

## 8. Egress（可选，默认关闭）

`enroll` 永远不开 egress。`open egress on` 是独立、可逆的命令，生成一份
附加配置后重启隧道，`open egress off` 删掉它再重启。

```
redirect-gateway def1 bypass-dhcp
route <server-ip> 255.255.255.255 net_gateway     # 隧道不能路由自己的传输
route <每一个本机已路由网段> ... net_gateway        # 从实时路由表读，不是静态表
route <中国 IP 前缀> ... net_gateway               # --mode cn-direct
```

本机网段是**在开启的那一刻从实时路由表读出来的**，所以 LAN、Docker bridge、CNI、
WireGuard overlay 和那套已有的 OpenVPN server 全部保持直连。新增了本地网段之后
需要重跑 `egress on` 才会纳入。

cn-direct 用 IP 前缀近似，不等于 Clash 的域名规则——纯 OpenVPN 没有域名规则这个东西。
包里带的是粗粒度列表（`resources/china-ipv4-coarse.txt`），完整列表在仓库
`ovpn/china-ipv4.txt`，用 `--cn-routes` 指定。

macOS 当前只支持 spoke 模式，egress 未实现。

### 未来：把 OpenVPN 变成乘客

如果哪天裸 UDP 被封，不需要换协议，只需要换载体。OpenVPN 原生支持
`socks-proxy`，mihomo 暴露的是 mixed-port（HTTP + SOCKS5 同端口）：

```
proto tcp-client
socks-proxy 127.0.0.1 7890
```

GFW 只看到 hysteria2 的 QUIC 流量。代价是 TCP-over-TCP 队头阻塞，对一条管理/数据
反向通道可以接受。这条路径当前未实现，记录在此是因为它不需要任何新的混淆代码。

**注意区分两件事**：mihomo 的 outbound 协议列表里**没有也不会有 OpenVPN**
（OpenVPN 是内核 tun + 自有 PKI 状态机，不是 clash 那种用户态 stream proxy）。
上面这条路径里 mihomo 只是 OpenVPN 的一个 SOCKS5 跳板，隧道和地址分配仍然是
OpenVPN 做的。而"订阅"——从 URL 拉配置、落盘、装 systemd、查状态——从来就是
qp-tunnel-cli 自己做的，和 mihomo 无关。

## 8.1 用第三方 OpenVPN 客户端直接导入

签发的 `.ovpn` 是标准自包含 profile，**可以不经过 qp-tunnel-cli 直接导入**：
用的是通用的 `dev tun` 而不是 `ovpn-<instance>`，证书全部内联。

关键的一点：**隔离性写在 profile 里，不在工具里**。`route-nopull`、六条
`pull-filter` 和 `script-security 0` 都在文件中，服务端也一行 `push` 都没有，
所以直接导入同样拿不到路由、网关和 DNS。固定地址也照旧有效，因为它来自服务端的
client-config-dir，与客户端实现无关。

### 两份 profile

`open create` 一次签发**两个文件**，因为两代客户端对"有哪些选项"的认知不一样，
不是靠一份文件加兼容标记能糊过去的：

| 文件 | 目标 | 内容差异 |
| --- | --- | --- |
| `<name>.ovpn` | OpenVPN 2.4.7+、Tunnelblick、Windows 社区版 GUI、`open enroll` | 完整严格版：`topology subnet`、6 条 `pull-filter`、`script-security 0`、`ignore-unknown-option` + `cipher` 兼容行 |
| `<name>.connect.ovpn` | **OpenVPN Connect**、iOS/Android 官方 App | 只留 OpenVPN 3 认识的：`route-nopull` + `data-ciphers`，其余全部去掉 |

### OpenVPN 3 到底不认什么（实测）

2026-08-26 用 OpenVPN Connect 实测，它**不是忽略未知选项，而是整份 profile 拒绝**：

```
option_error: sorry, unsupported options present in configuration:
UNKNOWN/UNSUPPORTED OPTIONS
18 [topology] [subnet]
```

`UNKNOWN/UNSUPPORTED OPTIONS` 是分节标题，下面列的才是罪魁。确认结论：

- **`topology` 不被支持** —— OpenVPN 3 内部只实现 subnet 拓扑，`net30` 早已废弃，
  所以它根本没有这个指令。这是最初连不上的唯一原因。
- `pull-filter`、`script-security` 同样不支持（OpenVPN 3 无脚本钩子、无 pull 过滤器）。
- 同一份日志里 `14 [data-ciphers]`、`16 [connect-retry]` 都排在标题**之前**，
  说明它们解析正常——所以 cipher 相关的选项并不是问题，不要误删。

### openvpn3 变体损失了什么

隔离性有三层，只掉了最外面一层：

1. **服务端一行 `push` 都没有** —— 服务端侧，客户端伪造不了。**完全保留**
2. **`route-nopull`** —— OpenVPN 3 支持。**保留**
3. `pull-filter` 冗余层 —— 防的是"服务端被改坏或被入侵后乱 push"。**OpenVPN 3 无法表达**

所以：**内网生产服务器走 `open enroll`（完整三层），手机/Mac 上的 Connect 用
`.connect.ovpn`（两层）**。后者对临时接入是够的。

### 直接导入会失去什么

1. **preflight 网段冲突检查**。这是最危险的一条。Internal 那台机器有 15 个 Docker
   bridge、定制 CNI（192.168.224.0/24）、两套 WG overlay 和一套别人的 OpenVPN
   server，签发的段一旦撞上，直接导入会静默破坏现有网络而没有任何提示。
2. **pin 路由**。当前 clash 是纯 env 代理不劫持流量，所以暂时无影响；一旦启用
   mihomo TUN，握手包会被隧道吸走。
3. **doctor 快照对比**。没有 enroll 前的基线，就无法证明"什么都没被改"。
4. **确定的接口名**。profile 里是 `dev tun`，内核会分配 `tun0`/`tun1`。那台机器上
   `tun0` 已被别人的 OpenVPN server 占用，所以会拿到 `tun1`——但这个编号依赖启动
   顺序，不稳定。工具链固定成 `ovpn-<instance>` 就是为了让防火墙和脚本有确定目标。
5. **私钥权限与生命周期**。`.ovpn` 内联私钥；工具链落盘时 chmod 0600 并记录状态，
   手工分发容易留下宽权限副本，且没有对应的 `down`/`uninstall` 回滚路径。

### GUI 客户端自己的开关会覆盖 profile

这一条最容易被忽略：**profile 里的 route-nopull 管不了客户端自身的设置。**
Tunnelblick 有 per-config 的 "Set nameserver" 和 "Route all traffic through the
VPN" 勾选项，**默认的 Set nameserver 就会改 DNS**。Windows GUI 以服务方式运行时也
有自己的 DNS 处理。导入后必须逐项确认这些开关是关的。

### 建议

- **内网生产服务器：用 `qp-tunnel-cli open enroll`。** 那台机器的网络复杂度正是
  preflight 和 doctor 存在的理由。
- **临时验证、手机、别人的电脑：直接导入没问题**，profile 本身就是安全的。
- 直接导入前至少手动做一次冲突检查：把 profile 头部的 `# qp-open-subnet:` 拿出来，
  和目标机器的 `ip route show table all` 比一遍。

## 9. 验收

海外侧，唯一硬指标：

```bash
qp-tunnel-cli open reachable          # ping 每个已配置 spoke 的固定地址
curl http://100.127.0.10:<port>/healthz
```

内网侧，不靠声称靠 diff：

```bash
qp-tunnel-cli open doctor             # 与 enroll 前快照逐项对比
```

再加一轮业务冒烟：k8s pod 健康、既有 WireGuard handshake 未断、mihomo status 正常、
Hub API 可达。

## 10. 未决项

- 海外新服务器的云厂商与 VPC 网段（AWS 默认 VPC 是 `172.31.0.0/16`，
  会影响候选段判断；`preflight --server` 会实测）
- 是否需要多台内网机器接同一个 server（决定要不要开 `client-to-client`）
- `10.8.0.0/24` 上那套已有 OpenVPN server 的归属与去留（当前一律不碰）
- 是否把 `open` 收进 `site-slots/oversea/` 做成可推送模块，以及 Admin UI 入口。
  materializer 的 `materializeOversea()` 本身就是一个 modules 数组，
  新增一个与 `hysteria2-access-stack` 平级的模块是加法改动，不影响现有推送。
