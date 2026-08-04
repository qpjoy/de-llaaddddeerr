# Domestic / Internal Deployment Hardening

这份记录来自一次正式 CentOS Internal + Domestic 部署排障。目标是把现场问题沉淀为
Admin UI、host-runner 和 `manage.sh` 的防线，避免再次出现“worker passed 但真实链路没通”
或“脚本用模板配置把远端服务清掉”的情况。

## 链路边界

Domestic 负责公开 WireGuard relay、H2I/DNS 边缘入口和到 Internal 的转发能力。
Internal 负责配置真相、Admin、Config Center、site-slot artifacts，以及本机
`10.88.88.88` service peer。

一次完整 Domestic 2.0 部署必须同时满足：

- Domestic 上 `mx-domestic` 存在，能访问自身 `10.88.0.1`。
- Internal runtime host 上存在 `mx-internal-svc`，地址为 `10.88.88.88`。
- Domestic peer 和 Internal peer 公钥互相同步，并产生 WireGuard handshake。
- Domestic 到 `http://10.88.88.88:18090/healthz` 可达。
- Internal host runner 可达，并能执行本机 WireGuard apply。

如果只看到 Domestic worker report `passed`，不能代表 Internal service peer 已经安装。
Admin 必须继续显示 Internal Service Peer 状态，直到 handshake 和 healthz 通过。

## 已有稳定链路的复核边界

`New 2.0 Plan` 和默认的 `Materialize Domestic WG` 会复用 `domestic-main` 中已有且格式有效的
Domestic / Internal keypair。默认 action body 是 `rotateRelayKey=false`、
`rotateInternalServiceKey=false`、`confirmRotate=false`；只有显式进入 Rotate 流程并确认后
才允许换 key。

已有 `mx-domestic` / `mx-internal-svc` 正常握手时：

- `Internal Service Peer Status` 可以同步待检查的 artifact 到 host-runner 工作目录并读取
  runtime 状态，但不会执行 apply、`wg-quick` 或 `systemctl restart`。这里的同步只更新待检文件，
  不会把文件加载进正在运行的接口。
- `Internal Service Peer Handoff` 只返回 handoff 命令，不在宿主机执行。
- `Install / Restart` / `Apply` 才会修改 Internal runtime；不需要为了让 UI 变绿而点击。
- `Ensure K8s Host Runner` 会创建或更新 runner Service/DaemonSet，也不属于只读检查。

Status 会读取正在运行的接口公钥和 peer 公钥，并与 Config Center 当前 Internal / Domestic
公钥比较。结果以
`siteId + planId + WG materialDigest + workerReportId` 保存为健康证据；只有状态为 `passed`、
运行中公钥一致、并明确绑定当前 warning worker report 的证据才能解除 blocked。创建新 plan、
轮换 key，或出现更新的 reachability warning 后都必须重新验证，旧证据不会被误复用。

## 这次失败的根因

### 1. Domestic relay 已创建，但 Internal peer 没有安装

Domestic 上 `mx-domestic` 可以 ping 通 `10.88.0.1`，但 ping `10.88.88.88` 返回：

```text
From 10.88.0.1 Destination Host Unreachable
ping: sendmsg: Destination address required
```

这说明 Domestic 本机接口存在，但 peer `10.88.88.88/32` 没有有效下一跳。原因不是
Domestic 端口，而是 Internal runtime host 没有成功启动 `mx-internal-svc`，或者没有
handshake。

UI 防线：

- Domestic worker passed 后，如果 evidence 出现 `Destination address required`、
  `No route to host`、`Internal is not reachable`，不要把站点展示成可用。
- Admin 应把状态降为 `blocked`，Next Gate 指向 `Internal Service Peer Status`。
- UI 应明确告诉操作者：下一步是 Internal host runner / service peer，不是继续重跑
  Domestic worker。

### 2. K8s Pod 访问不到宿主机 host runner

Internal API pod 访问 `http://192.168.31.121:19190/healthz` 返回 `Host is unreachable`。
主机上 `19190/tcp` 已监听，firewalld 也打开端口，但 pod 走 CNI 网段
`10.244.0.0/16`，宿主机防火墙没有信任该来源。

现场判断：

```bash
kubectl get nodes -o wide
kubectl -n "$NS" exec deploy/mx-launcher-internal -- sh -lc 'hostname -i; ip route'
firewall-cmd --get-active-zones
```

脚本和 UI 防线：

- Execution Target 必须区分 `api-pod` 和 `host-runner`。
- `host-runner-unreachable` 时，不应展示 WireGuard runtime 缺失为主因；主因是 pod 到
  host runner 的网络不可达。
- UI 应提示可选修复：信任 CNI 源 `10.244.0.0/16`、信任 `cni0`，或使用 CNI gateway
  地址访问 host runner。

### 3. qp-tunnel-cli fallback runtime 不完整或陈旧

host runner 使用的不是工作区源码，也不是刚执行的 `refresh-tunnel-cli latest` 目录，而是
解压后的 fallback runtime：

```text
~/.qpjoy/mx-launcher/internal-host-runner/qp-tunnel-cli-runtime
```

这次 runtime 中有 engine binary，但缺少：

```text
node_modules/@qpjoy/electron-core-wireguard/dist/index.js
```

因此 host runner 报：

```text
Failed to load @qpjoy/electron-core-wireguard from qp-tunnel-cli
```

脚本和 host-runner 防线：

- fallback runtime readiness 必须同时检查 `bin/qp-tunnel-cli`、CLI package 的
  `package.json` / `dist/index.js` / `dist/h2i.js`，以及
  `@qpjoy/electron-core-wireguard`、`@qpjoy/mx-launcher-core`、
  `@qpjoy/mx-launcher-standalone` 各自的 package/dist。
- archive candidate 应优先使用当前 state/runtime artifact，再回退到项目 artifact，
  最后才考虑 `server/artifacts`，避免旧模板包覆盖新包。
- UI 的 `wg runtime` 必须展示 `missing / qp-tunnel-cli` 以及真实 module load error。

### 4. internal-service-peer-handoff 默认读到了模板 artifact

命令行手动执行：

```bash
bash scripts/manage.sh ops site-slot internal-service-peer-handoff apply
```

曾默认读取：

```text
server/artifacts/site-slots/domestic/mx-internal-service-peer.conf
```

这个目录包含模板 key：

```text
<internal-service-private-key-from-internal-secret>
```

所以 `wg-quick@mx-internal-svc` 启动失败：

```text
Key is not the correct length or format: '<internal-service-private-key-from-internal-secret>'
```

脚本防线：

- `internal-service-peer-handoff apply` 默认应读取运行时 artifact：
  `artifacts/site-slots/domestic`。
- 如果配置中仍含 `<...>` placeholder，脚本必须在调用 `wg-quick` 之前直接失败。
- 如果 `PrivateKey` 不是 WireGuard 私钥格式 `^[A-Za-z0-9+/]{43}=$`，脚本必须直接失败。
- apply script 本身也要做同样校验，不能只依赖上层 `manage.sh`。
- 不要用 `awk -F=` 读取 WireGuard key。标准 key 是 32 字节 base64，末尾包含一个
  padding `=`；按 `=` 拆字段会把 padding 吃掉，表现为 `length=43 invalid`。
  脚本应只删除第一个 `key =` 前缀，例如 `sub(/^[^=]*=/, "")`，保留值里的 `=`。
- Admin / Config Center materialize 必须把非 `^[A-Za-z0-9+/]{43}=$` 的历史 key 视为
  missing，点击 `Materialize Domestic WG` 时自动重建 keypair，避免导出不可 apply 的
  `mx-internal-service-peer.conf`。

正确 break-glass 顺序：

```bash
MX_INTERNAL_BASE_URL=http://10.88.88.88:18090 \
  bash scripts/manage.sh ops site-slot materialize-domestic-ready domestic-main

grep -n '<internal-service' artifacts/site-slots/domestic/mx-internal-service-peer.conf

MX_INTERNAL_SERVICE_ARTIFACT_DIR="$PWD/artifacts/site-slots/domestic" \
  bash scripts/manage.sh ops site-slot internal-service-peer-handoff apply
```

`grep` 应无输出。否则不要 apply。

### 5. `wg` 命令没有 mx-internal 不是服务名问题

`wg` 只显示已经启动的 interface。Internal service peer 的 systemd 单元是：

```text
wg-quick@mx-internal-svc.service
```

不是 `mx-internal.service`。只有配置有效且 `wg-quick up mx-internal-svc` 成功后，
`wg show mx-internal-svc` 才会出现。

如果失败时看到：

```text
ExecStart=/usr/local/lib/qpjoy/hdo/bin/wg-quick up mx-internal-svc
```

这说明系统 `wg-quick@.service` 仍可能被旧 HDO 路径覆盖。它不是这次 placeholder key 的
根因，但应作为兼容风险显示在 UI/诊断中。

## Ubuntu H2I V2 CLI 当前契约

Ubuntu 无桌面环境时使用 `qp-tunnel-cli h2i` 接入 V2。它不是 V1 `hdo enroll` 的延伸：
Internal 持有账号、Product Network lease、snapshot 和配置真相；Domestic 只暴露 HTTPS
bootstrap facade、同步 relay peer，并承载客户端到 Internal 的 WireGuard 数据面。

离线发布的 `mx-domestic-qp-tunnel-cli-fallback.tar.gz` 必须包含 Node.js CLI 的
`package/dist/h2i.js`、`@qpjoy/electron-core-wireguard`、`@qpjoy/mx-launcher-core` 和
`@qpjoy/mx-launcher-standalone` 的 package/dist；运行 H2I 还要求宿主机 Node.js 18 或更新版本。
缺少这些内容时 host-runner 必须把 archive 判为 not ready，CLI 入口必须给出明确错误，不能把
Node 16 的运行时 `ReferenceError` 暴露给操作者。非 H2I 的 legacy 命令仍可回退到
`resources/mihomo-client.sh`。

账号登录使用 Domestic 的 HTTPS bootstrap URL；密码放在环境变量或 root-only 文件中，避免写入
shell history：

```bash
read -rsp 'H2I password: ' H2I_PASSWORD; export H2I_PASSWORD; printf '\n'
qp-tunnel-cli h2i enroll \
  --bootstrap-url 'https://h2i.example.com' \
  --username 'user@example.com'
unset H2I_PASSWORD
```

匿名接入不走账号 OAuth，但仍由 Internal 分配匿名 lease、生成 snapshot 并同步 Domestic peer：

```bash
sudo qp-tunnel-cli h2i enroll \
  --bootstrap-url 'https://h2i.example.com' \
  --anonymous
```

首个 Linux V2 实现固定为 relay-only：

```text
Ubuntu mx-h2i -> Domestic mx-domestic:51280/UDP -> Internal 10.88.88.88
```

当前不启用 client-to-Internal direct/hybrid 路径。成功不能只以获得 lease 为准；还必须完成
Domestic peer sync、WireGuard handshake，并能访问 Internal healthz。

H2I 默认不向生成的 WireGuard profile 写入 DNS，也不接管 Ubuntu 的全局 resolver。确实需要
Internal DNS 时可显式传 `--dns`；当前实现通过 `wg-quick`/`resolvconf` 做全局 resolver 接管，
不是 split DNS，因此宿主机必须先提供 `resolvconf` 或 `openresolv`。不要把 DNS 接管当作
enroll 的隐含副作用。

H2I 为每个 interface 写入独立 unit（默认
`/etc/systemd/system/qpjoy-h2i@mx-h2i.service`），不会读取、覆盖或信任全局
`wg-quick@.service`。后者可能仍由 V1 HDO 安装指向旧路径；独立 unit 也避免多个 H2I
interface 的 runtime 路径互相覆盖。CLI 会拒绝覆盖不属于当前 H2I state 的现有 WireGuard
config；迁移时应先确认并移走旧 config，或者为 H2I 指定独立的 state、config 和 interface。
自定义 config 目录时，basename 必须仍为 `<interface>.conf`；CLI 会在整个 enroll/down 期间
同时锁定 state、config 和 Linux interface，避免并发 capability 轮换或同名接口互相 restart。

生命周期命令为：

```bash
sudo qp-tunnel-cli h2i status
sudo qp-tunnel-cli h2i down
```

`h2i down` 只停止本地隧道并保留 lease，方便同一 installation/device/WireGuard identity 重连。
当前不得提供或调用 lease release：只有 Internal release 与 Domestic peer 删除成为同一个原子边界
后，才可以开放释放能力，否则会留下可路由的陈旧 peer。

## 下一次部署检查清单

1. Domestic worker report passed 后，不立即判定完成。
2. 打开 Internal Service Peer，确认 Execution Target 是 `host-runner`。
3. 确认 `config key` 是 `config key ready`，没有 placeholder/invalid key。
4. 确认 `wg runtime`、`core wg`、`core wg-quick` 可用。
5. 如果 Status 已经 `passed`，直接完成复核，不执行 Install / Restart；只有明确显示
   interface/config 缺失时才审批 `Install / Restart`，然后再 Refresh Status。
6. Internal 上确认：

```bash
systemctl status wg-quick@mx-internal-svc --no-pager
wg show mx-internal-svc
ip addr show mx-internal-svc
curl -fsS --max-time 5 http://10.88.88.88:18090/healthz
```

7. Domestic 上确认：

```bash
wg show mx-domestic
ping -c 3 10.88.88.88
curl -fsS --max-time 5 http://10.88.88.88:18090/healthz
```

只有第 6、7 步都通过，Domestic/Internal 2.0 链路才算真正完成。

## AWS 上的 legacy `wireguard.sh`

根目录 `scripts/wireguard.sh` 是 legacy/传统 road-warrior WireGuard 的兼容安装入口，生成
`wg0` 和 `10.7.0.0/24` 客户端配置。它不是 V2 `mx-domestic` / `mx-internal-svc` 的配置
真相；V2 仍应由 Internal 的 plan、artifact 和 host-runner 驱动。

EC2 的公网 IPv4 是 AWS NAT 映射，不会出现在实例网卡列表中。例如实例同时显示
`172.31.4.205`、`10.8.0.1`，AWS 控制台显示公网 `44.222.88.94` 时：

1. 在 `Which local IPv4 address...` 菜单输入私网出口地址对应的**编号**，通常是
   `172.31.4.205` 对应的 `1`，不能输入 `44.222.88.94`。
2. 脚本判断该地址位于私网后，会单独询问 public IPv4/hostname。它会先用 IMDSv2
   自动读取 EC2 public-ipv4；若 metadata 不可用，再使用外部地址探测，并允许手工覆盖。
3. 客户端配置中的 `Endpoint` 使用公网地址，服务端 SNAT 仍使用 EC2 网卡上的私网地址。

安装后还需要在 AWS Security Group 放通所选 WireGuard UDP 端口（默认 `51820`）。如果
隧道有 handshake 但不能转发流量，再检查 EC2 source/destination check、系统
`ip_forward`、iptables/firewalld 和 VPC/子网路由；不要把公网 NAT 地址写成服务端本地
SNAT 地址。
