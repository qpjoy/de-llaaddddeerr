# Home-Domestic-Oversea Tunnel Design

本文记录 `home-domestic-oversea`（简称 HDO）模式的可行性、最佳实践和后续编码切入点。目标是后续只看这份文档，就能开始设计 `@qpjoy/electron-plugin-hdo` 插件、服务器脚本和订阅协议。

## 目标

HDO 有三类节点：

```text
用户 / Electron 客户端
        |
        v
国内 VPS: 公网入口 + 国内出口 + 控制中心
        | \
        |  \__ 海外 VPS: 外网出口
        |
        \____ 家里电脑: 家庭服务 / 家庭内网
```

用户只需要连国内 VPS。连上后不一定所有流量都走国内 VPS：

- 访问本地网络和国内普通网站：默认本机直连，或可选国内 VPS 直连。
- 访问家里电脑或家里内网服务：走国内 VPS，再经 WireGuard overlay 到家里电脑。
- 访问外网服务：本机能直连时可本机直连；需要稳定外网能力时走国内 VPS，再由国内 VPS 分流到海外 VPS。
- 首版允许 `IP + 端口` 访问家里服务；保留后续 `域名 + 服务名` 的能力。

## 关键结论

1. HDO 不是单一 WireGuard overlay，也不是 mihomo 集群，而是多协议链路编排。不同链路可以使用不同协议：H ↔ D 可用原生 WireGuard，Client ↔ D 可用 mihomo + WireGuard 订阅，Client ↔ O 可用 mihomo + Hysteria2，特定业务可切到 WireGuard 直连 O。
2. 国内 VPS 不应把默认路由整体切到海外 VPS，否则会影响国内公网入口和国内 IP 身份。应该做分流：`home -> wg-home`，`CN -> direct/domestic`，`foreign -> overseas`。
3. 现有 `electron-plugin-tunnel` 默认把 `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16` 直连。HDO 需要能覆盖这条逻辑：家里网段虽然是私网段，但应该走国内 VPS。
4. 国内服务器已有 OpenVPN 场景占用 `172.16.*`、`172.17.*`、`172.18.*`、`172.19.*` 等网段。HDO 不能再使用 172 网段。
5. WireGuard `wireguard.sh` 静态配置适合人工/固定 peer，不适合“端口被封后自动 +1 并自动分发”。HDO 需要自己的订阅/manifest 和 endpoint 更新机制。

## HDO 是常见三单机拓扑

`home + domestic + oversea` 不是特殊需求，而是很常见的个人/小团队网络拓扑：

- 家里或公司有一台长期在线电脑，但没有稳定公网入口。
- 国内 VPS 有稳定国内公网 IP，适合作为用户入口、域名入口和国内出口。
- 海外 VPS 有稳定外网能力，适合作为外网出口。

HDO 插件应该把这个拓扑产品化，而不是要求用户理解每条 WireGuard、mihomo、Hysteria2 配置：

- 用户只看到“家里服务”“国内直连”“海外出口”“当前业务走哪条链路”。
- 插件和 `electron-server` 负责把这些选择翻译成 WireGuard peer、mihomo rules、订阅和服务列表。
- 默认不接管全局网络；只有用户打开某个模式或某个业务 profile 时才接管对应流量。

这也是 HDO 适合做成市场插件的原因：它不是通用 VPN，而是面向一类非常明确的单人/小团队三节点网络。

## 链路矩阵

HDO 不是要求所有节点都在同一个 WireGuard overlay 里。推荐按链路选择协议：

```text
H(home/company) -> D(domestic)
  协议: 原生 WireGuard
  目的: 家里/公司节点主动连国内 VPS，暴露 home overlay IP 和服务。

Client -> D(domestic)
  协议: mihomo + WireGuard 订阅，或后续 Hysteria2/WG 混合订阅
  目的: 访问 domestic 入口、home 服务、国内出口。

Client -> O(oversea)
  协议: 默认 mihomo + Hysteria2
  目的: 长连稳定、常规外网能力。

Client -> O(oversea) for CC/Claude-like traffic
  协议: P0 为 mihomo TUN + WireGuard outbound；fallback 为系统 WireGuard 隧道直连 O
  目的: 某些软件无法使用本地端口代理时，提供系统级网络路径。

D(domestic) -> O(oversea)
  协议: Hysteria2 优先，WireGuard 可选
  目的: 国内 VPS 自己需要外网出口，或 tokens relay egress。
```

因此，HDO 客户端至少需要同时理解三类 profile：

- `domestic-wg-via-mihomo`: mihomo 的 `type: wireguard` 出站，连接 D。
- `oversea-hy2-via-mihomo`: mihomo 的 Hysteria2 出站，连接 O。
- `oversea-wg-via-mihomo`: P0，给 CC/Claude 等业务的 O WireGuard 路径。
- `oversea-wg-system`: fallback，HDO 控制系统 WireGuard 客户端。

可行的目标策略：

```text
访问 H/home 服务      -> Client -> D -> H
访问 domestic 服务    -> Client -> D
普通外网             -> Client -> O via mihomo+Hysteria2
CC/Claude 特殊流量    -> Client -> O via mihomo TUN + WireGuard outbound
国内普通流量          -> DIRECT
```

注意：如果 P0 不可用，fallback 到系统 WireGuard 客户端时，触发条件最终仍会落到 IP/CIDR 路由；域名识别和“只让 CC 走 WG”需要由 HDO 插件提前解析/注入路由或命令 wrapper 承接。

## 推荐网段规划

不要使用：

- `172.16.0.0/12`：现有 OpenVPN/Docker/历史 VPN 容易冲突。
- `198.18.0.0/15`：mihomo fake-ip 常用，当前 tunnel 已使用 `198.18.0.1/16`。
- 家里真实 LAN 网段，例如 `192.168.1.0/24`，只作为被访问目标，不作为 overlay 地址池。

推荐默认：

```text
HDO home overlay:      100.88.0.0/24
  国内 VPS wg-home:    100.88.0.1
  家里电脑:             100.88.0.10

HDO user overlay:      100.88.1.0/24
  预留给后续用户 WireGuard 直连国内 VPS

HDO overseas overlay:  100.89.0.0/24
  海外 VPS:             100.89.0.1
  国内 VPS wg-exit:     100.89.0.2

HDO service VIP:       100.90.0.0/24
  预留给服务名 / 域名映射
```

`100.64.0.0/10` 是 CGNAT 保留地址，通常比 172 段更不容易和 OpenVPN 冲突，但仍可能和运营商环境冲突。实现时必须支持配置，并在 setup 前检测：

- Linux: `ip route`
- macOS: `netstat -rn` 或 `route -n get`
- Windows: `route print`

如果发现 `100.88.0.0/16` 已被占用，提示用户换到 `100.96.0.0/16` 或其他未使用 CGNAT 子段。

## WireGuard Overlay 是什么

这里的 overlay 指“跑在现有公网/内网之上的虚拟三层网络”：

- 每台机器都有一个稳定的隧道 IP，例如国内 VPS `100.88.0.1`、家里电脑 `100.88.0.10`。
- 家里电脑即使在 NAT 后，也可以主动连国内 VPS，并靠 `PersistentKeepalive = 25` 保持 NAT 映射。
- 用户和服务看到的是 overlay IP，不关心家里电脑真实公网是否可达。
- overlay 不等于全局代理。它只解决“节点互通”和“路由下一跳”，具体哪些流量进入 overlay 仍由路由表、mihomo 规则或 Electron 插件模式决定。

## 国内 VPS 职责

国内 VPS 是 HDO 的中心节点：

- 暴露公网域名和 HTTPS 入口。
- 维护家里电脑 WireGuard peer。
- 维护到海外 VPS 的出口连接。
- 运行 `electron-server`，作为市场、游戏、订阅分发和 HDO 控制面的统一服务端。
- 可选运行 Caddy/Nginx，把公网域名反代到家里电脑服务。
- 可选运行 mihomo，做 `CN direct / home via wg-home / foreign via overseas` 分流。

国内 VPS 不应该依赖海外 VPS 才能被访问。即使海外出口不可用，下面能力仍应可用：

- 用户连接国内 VPS。
- 用户访问家里电脑服务。
- 用户访问国内 VPS 自己的国内公网服务。

## electron-server 作为统一控制面

HDO 配套的服务端不应另起一套孤立系统，而应该进入现有 `electron-server`。原因：

- `electron-server` 已经负责插件市场、游戏、用户登录、Postgres、远程同步。
- HDO 订阅分发需要用户、权限、设备、审计和版本管理，这些和市场账号天然相关。
- Electron 插件可以复用市场登录态，不需要再发明一套 HDO 账号。
- 国内 VPS 上的 gateway agent 可以只负责“应用配置”，控制面数据由 `electron-server` 管。

`electron-server` 后续新增职责：

- 管理 HDO 节点：
  - domestic node: 国内 VPS 自身。
  - home node: 家里电脑。
  - oversea node: 海外 VPS。
- 管理 HDO 设备：
  - Electron 客户端设备。
  - 家里电脑 agent。
  - 国内/海外 gateway agent。
- 管理订阅和 manifest：
  - 为每个用户/设备生成 HDO manifest。
  - 为 mihomo/Electron 客户端生成订阅 YAML。
  - 管理 endpoint generation、activePort、过期时间。
- 管理服务目录：
  - `home-web -> 100.88.0.10:8080`
  - 后续 `serviceName + domain + target`。
- 管理权限：
  - 哪个用户能访问哪个 home node。
  - 哪个用户能访问哪个 service。
  - 是否允许 foreign exit。
- 管理审计：
  - manifest 拉取。
  - 订阅刷新。
  - 节点上线/离线。
  - 端口轮换。

建议新增 API：

```text
GET  /api/v1/hdo/manifest/:deviceId
POST /api/v1/hdo/devices/register
POST /api/v1/hdo/nodes/:nodeId/heartbeat
GET  /api/v1/hdo/services
POST /api/v1/hdo/services
GET  /api/v1/hdo/profiles
POST /api/v1/hdo/profiles
GET  /api/v1/hdo/subscriptions/:deviceId/mihomo.yaml
POST /api/v1/hdo/admin/nodes/:nodeId/rotate-port
```

建议新增 Postgres 表：

```text
hdo_nodes
hdo_devices
hdo_services
hdo_profiles
hdo_profile_rules
hdo_subscriptions
hdo_node_heartbeats
hdo_access_grants
hdo_endpoint_generations
```

`docker/hdo-gateway-stack` 不应保存最终权威数据。它只做执行面：

- 从 `electron-server` 拉取 node config。
- 应用 WireGuard / mihomo / Caddy 配置。
- 上报 heartbeat 和健康检查结果。
- 在需要时按控制面指令切换端口或重载配置。

控制面要支持“服务端规则下发 + 客户端本地覆盖”：

- 服务端规则用于团队默认策略、权限、服务目录和危险规则禁用。
- 客户端本地覆盖用于用户临时选择某个业务走直连/国内/海外。
- 最终生效规则要写入本地 SQLite，便于问题复现和 UI 展示。
- 每次 manifest 都带 `generation`，客户端只在 generation 增加时重渲染配置。

## 家里电脑职责

家里电脑作为 `home node`：

- 主动 WireGuard 连接国内 VPS。
- 暴露自己的 HDO overlay IP，例如 `100.88.0.10`。
- 首版只要求访问家里电脑本机服务，例如 `100.88.0.10:8080`。
- 后续可选转发整个家里 LAN，例如 `192.168.1.0/24`。

家里电脑访问外网有两种策略：

1. 默认本机直连。最少干预，适合家里电脑本来访问外网可用的场景。
2. 通过国内 VPS 分流到海外 VPS。适合家里电脑也需要稳定访问外网，例如 Claude Code / GitHub / npm。

如果要访问整个家里 LAN，需要二选一：

- 在家里路由器加静态路由：`100.88.0.0/16 via 家里电脑局域网 IP`。
- 在家里电脑上对来自 HDO overlay 的流量做 NAT masquerade。

MVP 先做“访问家里电脑本机 IP + 端口”，不强制支持整个 LAN。

## 海外 VPS 职责

海外 VPS 只做外网出口：

- 国内 VPS 访问国外目标时，走海外 VPS。
- 海外 VPS 做 NAT 出口。
- 海外 VPS 不承担用户入口，避免用户直接依赖海外线路。

海外出口协议可选：

1. Hysteria2：推荐作为第一版外网出口。已有 `hysteria2-mihomo-stack`，订阅更新和端口变更更容易和 mihomo 结合。
2. WireGuard：性能好、简单，但 UDP 端口可能被封，且静态 `wireguard.sh` 配置不适合自动端口轮换。
3. 其他代理协议：后续可扩展，不放入 MVP。

## AllowedIPs 不能简单用 0.0.0.0/0

访问 Claude Code / GitHub / npm 这类外网服务时，如果国内 VPS 到海外 VPS 使用内核 WireGuard，常见配置会把海外 peer 的 `AllowedIPs` 写成 `0.0.0.0/0`。这有两个问题：

- `wg-quick` 可能自动改默认路由，影响国内 VPS 自己的国内公网入口。
- 不符合 HDO 的分流目标：国内 VPS 仍要保留国内 IP 和国内直连能力。

可选方案：

### 方案 A：WireGuard + Table off + 策略路由

WireGuard peer 的 crypto ACL 可以允许 `0.0.0.0/0`，但不能让 `wg-quick` 自动接管默认路由：

```ini
[Interface]
Address = 100.89.0.2/24
PrivateKey = <domestic_private_key>
Table = off

[Peer]
PublicKey = <oversea_public_key>
Endpoint = oversea.example.com:52080
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
```

然后由国内 VPS 上的 mihomo 或 policy routing 决定哪些流量进入 `wg-exit`。这样不是“全局走海外”，而是“允许这条隧道承载任意目标，但路由层只把 foreign 目标送进去”。

优点：性能好，隧道通用。

缺点：实现复杂，需要管理 `ip rule` / `ip route` / `fwmark`，并且端口被封时仍要做 endpoint 更新。

### 方案 B：国内 VPS 上 mihomo 使用海外代理出站

国内 VPS 上 mihomo 负责分流，海外出口用 Hysteria2 等代理协议：

```text
CN / domestic service -> DIRECT
home overlay -> DIRECT via wg-home route
foreign -> HY2-OVERSEA
```

优点：域名感知强，订阅和端口轮换更自然，避免内核默认路由风险。

缺点：不是纯 WireGuard 外网出口。

MVP 推荐方案 B。后续如果确实需要 WireGuard 到海外，再实现方案 A。

如果“海外 WireGuard peer 的 `AllowedIPs` 绝对不能出现 `0.0.0.0/0`”，那内核 WireGuard 就不适合作为任意外网出口：它只能承载显式列出的目的网段。Claude Code / GitHub / npm 这类服务背后是 CDN 和动态 IP，靠静态 IP 列表会很脆。此时应优先用 Hysteria2/mihomo 这类域名感知代理作为海外出口。

## 端口被封与自动 +1

如果使用 WireGuard 到海外 VPS，端口被封后，“客户端自己 +1”不够，服务端也必须同步切换监听端口。正确模型是“端口轮换由控制面协调”：

```text
oversea server listens on currentPort
domestic node uses Endpoint = overseaHost:currentPort
control manifest records currentPort/generation
health checker detects failure
manager rotates currentPort + 1
oversea applies new ListenPort
domestic pulls manifest and updates peer endpoint
```

不推荐继续依赖 `scripts/wireguard.sh` 生成静态配置来解决这个问题。它的问题：

- 生成的是一次性 `.conf`，没有订阅更新机制。
- endpoint 端口变更后，需要重新分发或手工改文件。
- 对 Electron 客户端和家里电脑不友好。

HDO 应新增自己的 manifest：

```json
{
  "version": 1,
  "generation": 12,
  "updatedAt": "2026-05-18T00:00:00Z",
  "nodes": {
    "domestic": {
      "publicHost": "cn.example.com",
      "hdoAddress": "100.88.0.1"
    },
    "home": {
      "hdoAddress": "100.88.0.10",
      "routes": ["100.88.0.10/32"]
    },
    "oversea": {
      "publicHost": "oversea.example.com",
      "protocol": "hysteria2",
      "ports": [52080, 52081, 52082],
      "activePort": 52081
    }
  },
  "services": [
    {
      "name": "home-web",
      "host": "100.88.0.10",
      "port": 8080,
      "domains": []
    }
  ]
}
```

WireGuard endpoint 更新可以不重发私钥/公钥，只更新 endpoint：

```bash
wg set wg-exit peer <oversea_public_key> endpoint oversea.example.com:52081
```

如果必须改服务端 `ListenPort`，oversea 节点也需要一个 agent 或远程管理脚本安全地应用配置。

## Electron 插件形态

建议新增市场插件：

```text
@qpjoy/electron-plugin-hdo
plugin id: qpjoy.electron-plugin-hdo
```

`@qpjoy/electron-plugin-hdo` 是 HDO 的唯一产品入口。用户不应该先去理解 `docker/hdo-gateway-stack`、`scripts/hdo-*`、WireGuard、mihomo、Hysteria2 的细节；这些能力都应该从插件 UI 进入。

不要一开始直接塞进 `electron-plugin-tunnel`。原因：

- HDO 是拓扑模式，不只是单机代理模式。
- HDO 需要管理国内 VPS / 家里电脑 / 海外 VPS 三类节点。
- HDO 的“私网段规则”与当前 tunnel 默认私网直连逻辑冲突。
- HDO 后续需要服务列表、端口轮换、节点健康、manifest、服务名等新概念。

但可以复用 `electron-plugin-tunnel` 的能力：

- 复用 mihomo core 分发和启动逻辑。
- 复用 admin UI 模式切换经验。
- 复用 TUN 权限处理。
- 复用订阅导入、端口配置、日志、流量统计。

后续可抽公共包：

```text
@qpjoy/electron-tunnel-core
  - mihomo engine locator
  - TUN privilege helpers
  - config rendering helpers
  - traffic/status API

@qpjoy/electron-plugin-tunnel
  - 普通代理市场插件

@qpjoy/electron-plugin-hdo
  - Home-Domestic-Oversea 拓扑插件
```

插件首屏应该是详细拓扑图：

```text
                ┌──────────────────────┐
                │   @qpjoy/electron    │
                │   plugin market      │
                └──────────┬───────────┘
                           │
                 HDO control / status
                           │
          ┌────────────────┴────────────────┐
          │                                 │
┌─────────▼─────────┐             ┌─────────▼─────────┐
│ domestic VPS      │◄───────────►│ oversea VPS       │
│ electron-server   │  egress     │ hy2 / wg exit     │
│ hdo gateway       │             │ hdo worker        │
└─────────┬─────────┘             └───────────────────┘
          │
          │ wg-home overlay
          │
┌─────────▼─────────┐
│ home/company node │
│ services          │
└───────────────────┘
```

拓扑图必须显示：

- 每个节点在线/离线。
- 每条链路协议：WG / Hysteria2 / mihomo sidecar / direct。
- 当前用户客户端的模式：home-only / home+foreign / global gateway。
- 当前规则命中统计：home、CN direct、oversea、blocked。
- 服务列表：`100.88.0.10:8080`、后续服务名/域名。

## HDO 插件安装向导

`@qpjoy/electron-plugin-hdo` 需要内置安装向导，而不是只给 README 命令。向导按步骤推进，每一步都有状态检测和“一键安装/修复”按钮。

推荐步骤：

1. 连接 `electron-server`
   - 检查市场登录态。
   - 检查 `serverBaseUrl`。
   - 检查 HDO API 是否可用。

2. 配置 domestic VPS
   - 输入公网 IP/域名、SSH 用户、密码或私钥。
   - 一键上传内置脚本。
   - 远程执行 `hdo-gateway install domestic`。
   - 安装 `electron-server` HDO migration/API、WireGuard、mihomo/Caddy 依赖。

3. 配置 home/company node
   - 生成 home peer。
   - 提供家里电脑安装命令。
   - 可选通过 SSH 远程安装 home agent。
   - 检查 `100.88.0.10` 是否可达。

4. 配置 oversea VPS
   - 输入公网 IP/域名、SSH 用户、密码或私钥。
   - 一键安装 Hysteria2/WireGuard exit。
   - 注册到 `electron-server`。
   - 检查 domestic -> oversea 出口。

5. 配置客户端策略
   - 选择默认模式：home-only / home+foreign / global gateway。
   - 导入服务端 profiles。
   - 本地覆盖 Claude/Codex/npm/GitHub 等业务出口。

6. 验证
   - home service ping / TCP connect。
   - domestic public IP 检测。
   - oversea egress IP 检测。
   - DNS 路径检测。
   - tokens relay streaming 检测。

每一步 UI 都要展示：

- 当前状态。
- 将要执行的命令。
- 执行日志。
- 成功后的下一步。
- 失败时的修复按钮和可复制命令。

## 内置命令行与远程安装

HDO 插件需要内置命令行能力，类似图形化 `tunnel-cli`：

- 用户可以点击按钮执行。
- 也可以在内置终端里看到完整命令。
- 每条命令都能复制到服务器手动执行。
- 支持把内置脚本通过 `scp` 上传到远程服务器。
- 支持通过 SSH 执行远程安装。

远程安装交互方式：

1. 弹窗表单：
   - Host/IP
   - Port
   - Username
   - Password 或 private key
   - sudo password 可选

2. 内置命令行脚本图形化：
   - 用户在终端式 UI 中输入。
   - 插件捕获 stdout/stderr，展示进度。

3. 手动模式：
   - 插件生成命令和脚本。
   - 用户自行复制执行。
   - 执行完回到插件点“检测”。

安全要求：

- 默认不保存 SSH 密码。
- 私钥只存在本机安全存储或用户选择的 key 文件路径。
- 远程执行前展示脚本摘要和目标机器。
- 所有脚本必须 idempotent，可重复执行。
- 危险操作需要二次确认，例如清理 WireGuard、覆盖 Caddy、重启服务。

推荐内置命令：

```text
hdo doctor
hdo install domestic --server <url>
hdo install home --server <url> --token <token>
hdo install oversea --server <url> --token <token>
hdo status
hdo register-node
hdo render-mihomo
hdo rotate-port
hdo test home
hdo test oversea
hdo test tokens
```

插件 UI 调用这些命令，而不是把逻辑散落在按钮回调里。这样后续也能独立发布 `@qpjoy/hdo-cli`。

## 服务端/客户端统一视图

HDO 插件应该能同时看到：

- 服务端控制面状态：
  - electron-server reachable。
  - HDO migrations 版本。
  - nodes/devices/services/profiles。
  - subscriptions generation。

- domestic VPS 状态：
  - wg-home。
  - gateway mihomo。
  - Caddy/Nginx。
  - oversea egress。
  - public IP。

- home/company node 状态：
  - WireGuard handshake。
  - 本机服务端口。
  - 可选 LAN routes。

- oversea VPS 状态：
  - Hysteria2/WireGuard exit。
  - activePort/generation。
  - egress IP。

- 当前客户端状态：
  - 本机 mihomo/WireGuard 是否运行。
  - 当前模式。
  - 规则命中。
  - 本地覆盖规则。

所有状态都应从 `electron-server` manifest/API 和本地 runtime status 合并得到。`electron-server` 是权威控制面，本地插件是操作面和可视化入口。

## 节点安装形态：插件 UI + Headless Agent

用户看到的唯一入口是 `@qpjoy/electron-plugin-hdo`，但并不意味着 domestic/oversea VPS 必须跑 Electron GUI。VPS 通常是 headless Linux，最佳实践是：

```text
本地桌面 Electron 插件
  - 展示拓扑图
  - 生成安装计划
  - SSH/SCP 安装远程 agent
  - 查看和调整策略

domestic/oversea/home 节点
  - 运行 hdo-agent / hdo-cli
  - 向 electron-server 注册
  - 拉取 manifest
  - 应用 WireGuard / mihomo / Hysteria2 / Caddy 配置
  - 上报 heartbeat
```

也就是说：

- 桌面机器可以安装市场和插件，获得完整 UI。
- 服务器优先安装 `hdo-agent`，不强制安装 Electron。
- 如果服务器本身有桌面环境，也可以安装市场和插件，但这不是默认路径。
- 插件内置命令行最终调用同一套 `hdo-cli`，避免 UI 和 CLI 逻辑分叉。

建议包形态：

```text
@qpjoy/electron-plugin-hdo   # 市场插件，UI + 本机 runtime 控制
@qpjoy/hdo-cli               # 跨平台命令行，安装/诊断/注册
@qpjoy/hdo-agent             # Linux systemd agent，服务器/家里节点常驻
```

`electron-server` 是控制面，`hdo-agent` 是执行面，`electron-plugin-hdo` 是操作面。

## 插件内置 WireGuard 与 mihomo 的关系

HDO 插件可以模仿 WireGuard 客户端：由 Electron 写入 WireGuard 配置、启动/停止隧道，并展示每个 tunnel 的状态。可行，但要明确职责边界：

- WireGuard 负责 IP/CIDR 级别的三层连通。
- `AllowedIPs` 只能表达 IP/CIDR，不能表达域名、GeoIP 或“Claude 走这条、Codex 走另一条”。
- 业务级、域名级、GeoIP 级策略必须由 mihomo 或插件策略层实现。
- 如果插件同时集成 WireGuard client 和 mihomo client，应把 WireGuard 当作若干“底层链路”，mihomo/策略层再决定每个业务走哪条链路。

推荐客户端分层：

```text
electron-plugin-hdo
  control/UI: profiles, service list, route status
  policy: per-app/per-command/per-domain decisions
  mihomo: domain/geoip/proxy-group/TUN or mixed-port
  wireguard: home/domestic/oversea IP overlays
```

对于 WireGuard 写入方式：

- macOS/Windows 可以优先调用系统 WireGuard 客户端导入配置，降低权限和内核差异风险。
- 高级模式再考虑插件自己调用 `wg` / `wireguard-go` / system extension。
- HDO manifest 不应下发完整长期私钥给普通 UI；设备私钥应在本机生成，服务端只保存公钥。
- 服务端下发 endpoint、peer public key、AllowedIPs、DNS、generation。

典型 WireGuard profile：

```text
wg-home-client:
  Purpose: 访问家里电脑/公司内网
  AllowedIPs: 100.88.0.0/16, 可选 home LAN allowlist

wg-oversea-exit:
  Purpose: 固定海外出口
  AllowedIPs: 不建议客户端直接 0.0.0.0/0；优先交给 mihomo/mixed-port 选择

wg-business-direct:
  Purpose: 某个业务独占链路
  AllowedIPs: 由 electron-server 下发的明确 CIDR
```

如果用户选择“全局 WireGuard”，可以生成 `AllowedIPs = 0.0.0.0/0, ::/0`；但这应是显式高级开关，不能作为默认。

### Claude/Codex 这类软件的“直连 WG”问题

P0 优先验证方案：`mihomo TUN + wireguard outbound`。

如果该方案对 Claude/Codex/CC 类软件可用，它同时满足两个关键需求：

- 从应用视角不是本地端口代理，而是系统网络/TUN 接管。
- WireGuard endpoint 端口漂移后，可以通过 mihomo 订阅自动更新 `type: wireguard` 出站配置。

因此 HDO 的优先级应调整为：

1. P0: `mihomo TUN + wireguard outbound`
2. P1: `mihomo TUN + hysteria2 outbound`
3. P2: 系统 WireGuard 客户端由 HDO 插件控制
4. P3: 动态 /32 路由注入

如果某个软件不能使用本地 HTTP/SOCKS 代理，并且用户说“必须 WireGuard 直连”，需要拆成三种可实现路径：

1. mihomo TUN + WireGuard outbound
   - 从软件视角看不是本地端口代理，而是系统网络/TUN。
   - mihomo 内部用 `type: wireguard` 出站。
   - 可以做域名、GeoIP、规则分流。
   - endpoint/port 可通过 mihomo 订阅更新。
   - 这是 HDO 客户端默认推荐路径，必须优先验证。

2. OS WireGuard 全局/半全局模式
   - HDO 插件启动系统 WireGuard profile。
   - `AllowedIPs = 0.0.0.0/0, ::/0` 或大范围路由。
   - 同时为 domestic/oversea endpoint 加 escape route，避免隧道套死。
   - 缺点：很难做精细 `CN direct`，除非额外维护大量路由表。

3. 动态 /32 路由注入
   - 插件解析 `api.anthropic.com`、GitHub、npm 等域名。
   - 把解析出的 IP 临时加入 WireGuard 路由。
   - 缺点：CDN IP 动态变化，DNS 污染和缓存都可能导致不稳定，不适合作为默认。

结论：

- 如果要“业务级分流 + 不走本地端口代理”，优先用 `mihomo TUN + WG/HY2 outbound`。
- 如果必须使用系统 WireGuard 客户端，业务级分流会退化成 IP/CIDR 级分流。
- `AllowedIPs` 不能表达域名，也不能天然表达 `CN direct`。

P0 验证标准：

- 开启 mihomo TUN 后，CC/Claude 请求不配置 `HTTP_PROXY` / `HTTPS_PROXY` 也能走目标链路。
- 规则能把 CC/Claude 域名命中到 `oversea-wg-via-mihomo`。
- 国内网站仍然 `DIRECT`。
- home service 仍然 `Client -> D -> H`。
- oversea WG 端口从 `52080` 漂移到 `52081` 后，刷新订阅即可生效，不需要手工改系统 WireGuard profile。
- TUN DNS 不依赖本机 Clash 53 端口，继续使用 HDO/mihomo 自己的 DNS 配置。

### WireGuard 端口轮换与订阅

需要区分两种“订阅更新”：

1. mihomo YAML 订阅
   - 适合更新 `type: wireguard` / `hysteria2` outbound。
   - 客户端刷新 YAML 后，mihomo 可以用新端口连 oversea/domestic。
   - 适合 `mihomo TUN + wireguard outbound` 模式。

2. 系统 WireGuard profile 更新
   - 原生 WireGuard 客户端不会自动消费 mihomo YAML。
   - HDO 插件/agent 必须读取 HDO manifest，然后重写系统 WireGuard endpoint。
   - 例如执行：

```bash
wg set wg-cc peer <oversea_public_key> endpoint oversea.example.com:52081
```

因此，WireGuard 端口被封后的自动 +1 不能只依赖 mihomo 订阅。必须有 HDO manifest：

```text
electron-server activePort/generation
  -> hdo-agent applies oversea server ListenPort
  -> electron-plugin-hdo refreshes local manifest
  -> mihomo YAML and OS-WG profile both re-render
```

为了减少切换瞬断，oversea VPS 可以保留端口池：

- 当前端口 `activePort`
- 下一个端口 `nextPort`
- 最近几个端口短暂并行监听
- manifest 用 `generation` 标记新旧配置

## Per-command / Per-business Tunnel

参照 `tunnel-cli` 的思路，HDO 应允许“不同命令/业务走不同 tunnel”。这比“开关一个全局 VPN”更符合实际：

```text
claude-code  -> oversea-wg 或 oversea-hy2
codex        -> clash/mihomo subscription A
npm/github   -> oversea-hy2
home-web     -> domestic-vps -> wg-home
company-api  -> domestic-vps -> company/home overlay
cn websites  -> DIRECT
```

建议在 `electron-server` 下发 profile：

```json
{
  "profiles": [
    {
      "id": "claude-code",
      "match": {
        "processNames": ["claude", "node"],
        "domains": ["api.anthropic.com"],
        "commands": ["claude"]
      },
      "route": "oversea-hy2",
      "fallback": "oversea-wg"
    },
    {
      "id": "home-services",
      "match": {
        "cidrs": ["100.88.0.0/16"],
        "services": ["home-web", "home-ssh"]
      },
      "route": "domestic-home-wg"
    },
    {
      "id": "cn-direct",
      "match": {
        "geoip": "CN",
        "geosite": "cn"
      },
      "route": "direct"
    }
  ]
}
```

实现优先级：

1. MVP：按域名/IP/service 生成 mihomo rules。
2. 第二阶段：给命令提供 wrapper，例如 `hdo run --profile claude-code claude`，通过环境变量 `HTTPS_PROXY` / `ALL_PROXY` 指向指定本地端口。
3. 第三阶段：系统 TUN + 进程感知。这个较难，macOS/Windows 实现差异大，不能放进 MVP。

这样可以做到：

- Claude 走专用 WireGuard/海外出口。
- Codex 走另一个 Clash/mihomo 订阅。
- 家里服务走国内 VPS。
- 国内网站直连。
- 服务端 `electron-server` 可下发默认规则，客户端允许用户局部覆盖。

## Electron HDO 客户端模式

首版模式：

### local-direct-home-only

默认模式，只接管访问家里服务的流量：

- `100.88.0.0/16` -> 国内 VPS
- 已配置的家里服务 `IP + port` -> 国内 VPS
- 其他流量 -> DIRECT

适合用户只想访问家里电脑服务，不想影响本机上网。

### local-direct-home-foreign

访问家里服务走国内 VPS；访问外网可以走海外出口；国内和本地直连：

- home overlay/service -> 国内 VPS
- `GEOSITE,CN` / `GEOIP,CN` -> DIRECT
- foreign/geosite-gfw/手动外网站点 -> 国内 VPS，再由国内 VPS 到海外 VPS
- default -> DIRECT 或按用户选择

适合 Electron 客户端需要 Claude Code / GitHub / npm 能力，但不想全局代理。

### domestic-gateway-global

所有流量先进国内 VPS，再由国内 VPS 分流：

- home -> wg-home
- CN -> domestic DIRECT
- foreign -> oversea

适合需要统一审计、统一出口策略或远程办公环境。不是默认模式。

## HDO 规则与当前 tunnel 的冲突点

当前 `electron-plugin-tunnel` 的 `PRIVATE_DIRECT_RULES` 会把私网段全部 DIRECT：

```text
10.0.0.0/8 -> DIRECT
172.16.0.0/12 -> DIRECT
192.168.0.0/16 -> DIRECT
```

HDO 需要改成“私网不一定 direct”：

```text
100.88.0.0/16 -> HDO-DOMESTIC
home LAN allowlist, e.g. 192.168.1.0/24 -> HDO-DOMESTIC
other private ranges -> DIRECT
```

所以 HDO 的规则渲染器不能直接复用当前 `buildRules()`，至少要支持：

- home overlay CIDR
- home LAN CIDR allowlist
- service IP + port 映射
- optional foreign proxy group
- local direct fallback

## 订阅类型分层

HDO 不应只有一种“订阅”。至少要分三层：

### HDO Manifest

权威控制面数据，由 `electron-server` 下发：

- nodes
- devices
- services
- profiles
- routes
- endpoint generation
- activePort
- allowed features
- policy version

所有客户端、agent、gateway 都先消费 HDO manifest。

### Mihomo Subscription

从 manifest 派生的 YAML：

- 给 mihomo 客户端使用。
- 包含 domestic/oversea outbound。
- 包含 home/CN/foreign 规则。
- 适合 TUN、mixed-port、app proxy。

### WireGuard Profile

从 manifest 派生的系统 WireGuard 配置：

- 给系统 WireGuard 客户端或插件内置 WG helper 使用。
- 只表达 peer、endpoint、AllowedIPs、DNS、MTU。
- endpoint/port 变化时由 HDO 插件或 agent 更新。

```text
electron-server manifest
   ├─ mihomo.yaml
   ├─ wg-home.conf
   ├─ wg-oversea.conf
   └─ hdo local runtime config
```

这样才能同时支持：

- HDO 客户端用 mihomo TUN 做复杂分流。
- 某些业务用系统 WireGuard profile。
- domestic/oversea/home agent 用同一份控制面更新配置。

## 国内 VPS 分流模型

国内 VPS 上推荐跑一个 gateway config：

```text
route home overlay 100.88.0.0/24 -> wg-home
route home LAN allowlist -> wg-home
route CN -> main table / direct
route foreign -> oversea outbound
```

实现方式有两条：

1. Linux policy routing + ipset/nftables。
2. 国内 VPS 上跑 mihomo，以 TUN 或透明代理方式做分流。

MVP 推荐国内 VPS 上使用 mihomo，原因：

- 已经有 mihomo 配置生成经验。
- 容易表达 domain/geosite/gfw 规则。
- 容易切海外出口协议。
- 更适合后续从 Electron 管理面查看状态。

## 服务访问模型

MVP 先支持 `IP + 端口`：

```text
100.88.0.10:8080  -> 家里电脑 Web
100.88.0.10:3000  -> 家里开发服务
```

国内 VPS 可以可选暴露公网反代：

```text
home.example.com -> 100.88.0.10:8080
```

后续服务名模型：

```yaml
services:
  - name: home-web
    target: 100.88.0.10:8080
    domains:
      - home.example.com
    aliases:
      - home-web.hdo
```

Electron 客户端可以从 manifest 读服务列表，生成按钮或本地域名规则。

## 路由冲突与 Endpoint Escape Routes

HDO 的 overlay 网段避开 `172.16/12` 和 `10/8` 还不够。机器上可能已经有其他 VPN、Clash/Mihomo TUN、企业客户端、WireGuard 客户端在运行。需要额外处理：

1. Endpoint escape route
   - domestic VPS 和 oversea VPS 的公网 IP 必须始终能从物理网络直连。
   - 如果当前机器已有全局 VPN，HDO 要给 D/O endpoint 加 host route，避免控制链路被别的 VPN 接管。

2. Route priority
   - HDO home-only 模式只添加最小路由。
   - HDO 不应默认抢 `0.0.0.0/0`。
   - 系统 WireGuard 全局模式必须二次确认。

3. DNS split
   - home/company 服务名走 HDO DNS 或 manifest 映射。
   - CN 域名走国内 DNS。
   - foreign 域名跟随海外出口 DNS。

4. MTU
   - 多层隧道会导致 MTU 黑洞。
   - WireGuard/Hysteria2/mihomo TUN 叠加时需要自动探测或保守默认。
   - 建议默认 MTU 从 `1280` 或 `1380` 起步，再提供测速/调整。

5. Firewall
   - home 节点服务需要允许来自 `100.88.0.0/16` 的连接。
   - domestic VPS 需要限制管理 API，只允许已认证设备。

插件的 `doctor` 必须检查：

- 当前路由表。
- D/O endpoint 是否直连。
- HDO overlay 是否冲突。
- DNS 是否被其他 VPN 接管。
- MTU 探测。
- WireGuard handshake。
- mihomo controller。

## 安全边界

必须避免把家里电脑变成未鉴权公网入口：

- 国内 VPS 反代默认要求认证，至少 Basic Auth 或登录态。
- HDO manifest 需要签名或使用 HTTPS + token。
- 家里服务默认只对 HDO overlay 暴露。
- 家里 LAN 访问默认关闭，只开放显式 CIDR。
- 用户订阅按用户生成，不共享私钥。
- Electron 插件中保存 token/私钥要走本机安全存储或 market DB 加密方案；MVP 至少不要明文出现在日志里。

## 推荐 MVP

第一阶段只做“家里电脑服务访问”：

1. 国内 VPS 安装 HDO gateway。
2. 家里电脑安装 HDO home agent 或 WireGuard 配置，连国内 VPS。
3. Electron 插件导入国内 VPS manifest。
4. 插件启动 mihomo，本机只把 `100.88.0.0/16` 和已配置服务送往国内 VPS。
5. 用户能访问 `100.88.0.10:8080`。

第二阶段加入海外出口：

1. 海外 VPS 跑 Hysteria2 exit。
2. 国内 VPS mihomo 把 foreign 流量送海外。
3. Electron 插件增加 `home + foreign` 模式。
4. Claude Code / GitHub / npm 走 `foreign -> domestic -> oversea`。

第三阶段加入端口轮换：

1. 国内/海外节点都有 HDO agent。
2. agent 上报健康状态。
3. endpoint/port 写入 manifest。
4. 国内 VPS 和 Electron 插件定时拉取 manifest。
5. 端口失败时自动切换到下一个端口，并记录 generation。

第四阶段加入服务名：

1. 国内 VPS 管理 `services[]`。
2. Electron 插件渲染服务列表。
3. 可选本地域名 `*.hdo` 或公网域名反代。

## 建议目录

```text
electron-server/
  db/migrations/
    000x_hdo_control_plane.sql
  src/api/v1/hdo.ts
  src/data/pg/hdo...
  src/jobs/hdo-health.ts
  src/jobs/hdo-port-rotation.ts

docker/hdo-gateway-stack/
  docker-compose.yml
  manage.sh
  Caddyfile
  config/
  data/

scripts/hdo-gateway.sh
scripts/hdo-export-subscription.sh
scripts/hdo-health-check.sh

electron-plugin/packages/electron-plugin-hdo/
  package.json
  src/
    plugin.ts
    hdo/
      ManifestClient.ts
      HdoConfigRenderer.ts
      ServiceRegistry.ts
      NodeHealth.ts
    mihomo/
      reuse or extract from electron-plugin-tunnel
```

## Open Questions

1. 国内 VPS 到海外 VPS 第一版用 Hysteria2 还是 WireGuard？
   - 推荐 Hysteria2。
   - 如果坚持 WireGuard，需要同时实现 `Table = off`、策略路由和 endpoint manifest。
2. 家里电脑是否需要访问整个家里 LAN？
   - MVP 只支持家里电脑本机服务。
   - LAN 访问放第二阶段，避免路由器静态路由/NAT 复杂度提前进入。
3. Electron 客户端默认是否开启 TUN？
   - 默认不开。
   - 首版可以先用 App 模式或本地 mixed proxy，TUN 作为高级选项。
4. 用户访问外网时是否必须经过国内 VPS？
   - 不必须。
   - 默认本机直连；只有选择 `home + foreign` 或 `global gateway` 才走 HDO 外网出口。
5. 是否把 HDO 做成现有 tunnel 的一个模式？
   - 不建议第一版这么做。
   - 先新建 `electron-plugin-hdo`，成熟后再抽公共 `electron-tunnel-core`。
6. HDO 控制面是否放进 `electron-server`？
   - 是，作为后续默认方案。
   - gateway stack 和 Electron 插件都只消费 `electron-server` 的 manifest/API。

## Octelium 评估

Octelium 是一个开源零信任访问平台，目标是把内部服务、数据库、Kubernetes 服务、SSH、HTTP 等资源发布成受身份和策略控制的 `Service`。它和 HDO 的交集很大：

- 都有控制面 / 数据面 / 客户端概念。
- 都能表达“用户访问某个内部服务，而不是全局暴露内网”。
- 都适合做身份认证、服务访问控制、审计。
- 都能处理部分 NAT 后资源访问场景。

但 Octelium 不应作为 HDO MVP 的核心依赖：

- 它是完整的零信任平台，部署形态偏 Kubernetes/control-plane/data-plane，复杂度高于当前项目。
- 它会带来另一套用户、权限、Service、Connector/Client 管理模型，和现有 `electron-server` 的市场账号、插件、游戏、订阅控制面重复。
- HDO 特有需求包括国内 VPS 保留国内 IP、海外出口轮换、GFW 下端口切换、mihomo CN/direct 规则、Electron 插件市场集成，这些不是 Octelium 的主目标。
- 如果 tokens API 中转需要极高网络可控性，Octelium 可以作为访问控制参考或可选 adapter，但不能替代自研 egress routing、计费、模型路由、熔断、日志和限流。

建议：

- MVP 不依赖 Octelium。
- 学习 Octelium 的概念：Service、User/Device、Policy、Session、Audit。
- `electron-server` 继续做 HDO 权威控制面。
- 未来如果发现需要通用零信任接入，可做 `hdo-octelium-adapter`，而不是重写 HDO 到 Octelium。

## Tokens API 中转网络设计

tokens API 中转和普通家里服务访问不同，对网络要求更高：

- 长连接 / SSE streaming 不能被中间层随意缓冲。
- 上游 API 的 IP 和域名变化频繁，不能靠静态 IP 列表。
- 用户请求需要认证、限流、计费、审计。
- 同一请求不能被盲目重试，尤其是流式生成已经开始后。
- 网络路径需要可观测：每个请求必须知道走了 direct、domestic、oversea-hy2、oversea-wg 还是 fallback。

推荐把 tokens API 中转做成独立服务或 `electron-server` 的独立模块，不要混在普通 tunnel 进程里：

```text
client
  -> domestic API endpoint
  -> tokens relay service
  -> explicit egress route
       direct
       oversea-hy2
       oversea-wg
       provider-specific proxy
  -> upstream model API
```

关键原则：

1. 不依赖全局默认路由。
   - 国内 VPS 的公网入口必须始终从国内 VPS 自己回包。
   - 海外出口只用于上游 API 请求。

2. 使用显式 egress。
   - 每个 provider/model 可以选择不同 route。
   - 应用层 HTTP 客户端通过 SOCKS/HTTP proxy、network namespace 或 sidecar 出口指定路径。

3. 不要叠太多 TUN。
   - `mihomo TUN + wg default route + Docker NAT + app proxy` 很难排障。
   - 服务端优先使用 sidecar proxy 或 network namespace。

4. 每条出口都要有健康评分。
   - latency
   - connect success
   - TLS handshake success
   - first-token latency
   - streaming stability
   - recent error rate

5. 流式请求要特殊处理。
   - 请求发出前可以选择最佳 route。
   - 已开始返回 token 后，不做自动重试。
   - 支持客户端断开后的上游 abort。

6. DNS 跟随出口。
   - 国内直连用国内 DNS。
   - 海外出口用海外 DNS / DoH。
   - 避免国内 DNS 解析到不可用或被污染地址后再走海外。

7. 日志不能泄漏 token。
   - 记录 provider、model、route、status、latency、token usage。
   - 不记录 Authorization 原文、prompt 全文或用户敏感数据。

建议 egress 抽象：

```ts
type EgressRoute =
  | 'direct'
  | 'domestic-wg-via-mihomo'
  | 'oversea-hy2-via-mihomo'
  | 'oversea-wg-system'
  | 'oversea-wg-via-mihomo'
  | 'home-via-domestic-wg'
  | 'custom-proxy';

interface RouteDecision {
  route: EgressRoute;
  reason: string;
  provider: string;
  model?: string;
}
```

服务端可以同时运行 mihomo client、WireGuard client、Hysteria2 client，但它们应该是受控出口，不是无序混合：

- `mihomo`：适合作为域名感知 sidecar 出口。
- `WireGuard`：适合稳定 overlay 或固定出口，不适合动态 CDN 靠静态 AllowedIPs。
- `Hysteria2`：适合国内到海外的抗丢包出口和端口切换。
- `network namespace`：适合把某个 relay worker 固定到某条出口。

tokens relay 的 MVP：

1. 国内 VPS 暴露 API 域名。
2. relay 服务按 provider 配置一个默认海外出口。
3. 使用 Hysteria2/mihomo sidecar 到海外 VPS。
4. 每个请求记录 route 和 first-token latency。
5. 后续再加多出口健康评分和自动切换。

## Tokens Relay 放 domestic 还是 oversea

tokens API 中转有两个候选部署点：

```text
方案 D: client -> domestic-vps relay -> oversea egress -> upstream API
方案 O: client -> oversea-vps relay -> upstream API
```

### 放在 domestic-vps

优点：

- 国内用户访问入口延迟低，域名和 TLS 终止在国内 VPS。
- 统一复用 `electron-server` 的用户、key、计费、审计、限流。
- 国内 VPS 可以同时访问 home/company overlay，便于把 tokens relay 和内部服务组合。
- 可以按 provider 动态选择 direct / oversea-hy2 / oversea-wg / custom proxy。
- 海外线路故障时，国内入口仍可返回可解释错误或切换其他出口。

缺点：

- relay 到上游 API 仍要跨境，流式响应路径更长。
- 国内 VPS 需要承受更多长连接和带宽。
- 需要非常小心不要让全局路由影响国内入口回包。

适合：

- 面向国内用户。
- 需要统一账号、tokens、配额、审计。
- 需要和 HDO home/company 服务打通。

### 放在 oversea-vps

优点：

- 到上游模型 API 路径短，first-token latency 和稳定性可能更好。
- 网络环境更接近上游 provider，DNS/TLS/HTTP2/SSE 问题更少。
- 国内 VPS 可以只做入口转发或控制面。

缺点：

- 国内用户到海外 relay 的入口链路不稳定，可能被 QoS 或阻断。
- 用户、计费、审计如果仍在国内 `electron-server`，需要跨节点强一致或异步同步。
- 如果 oversea relay 暴露公网入口，安全面和 DDoS 面变大。

适合：

- 面向海外用户。
- 国内入口不重要。
- relay 只服务少量内部任务或后台 job。

### 推荐

MVP 推荐放在 domestic-vps，但 egress 明确走海外 sidecar：

```text
client
  -> domestic-vps /api/tokens
  -> tokens relay
  -> local explicit proxy: oversea-hy2 or oversea-wg
  -> upstream API
```

后续可以增加 oversea worker：

```text
domestic control plane
  -> dispatch signed relay task
  -> oversea worker
  -> upstream API
```

也就是：

- 国内 VPS 是控制面和默认入口。
- 海外 VPS 是高质量 egress / worker。
- 不让客户端直接依赖海外 VPS。
- 不让国内 VPS 的系统默认路由整体切到海外。

如果未来 tokens relay 对 first-token latency 要求极高，可以做“双层 relay”：

```text
client
  -> domestic-vps auth/quota/control
  -> signed short-lived relay ticket
  -> oversea-vps stream worker
  -> upstream API
```

这样国内 VPS 保留账号、计费、审计和控制面，oversea VPS 负责高质量流式出口。需要注意：

- ticket 必须短有效期、一次性或低重放风险。
- oversea worker 回传 usage 和 trace。
- domestic 和 oversea 的日志要能按 requestId 合并。
- 如果 oversea worker 不可用，domestic relay 可以降级到本地 oversea sidecar。

## Marketplace Server 迁移与兼容

当前插件市场的 `electron-server` 过去只有一个远端，并且部署在 `oversea-vps`。HDO 之后推荐把控制面部署在 `domestic-vps`，但不能把“插件市场远端”和“HDO 控制面”硬绑定成同一个概念。

已确认的兼容边界：

- `electron-market` 的远端地址可以在插件市场设置页切换，host 启动时按优先级解析：
  - 宿主显式 `serverBaseUrl`
  - 环境变量
  - 插件市场设置页保存的 `settings.marketServer`
  - 内置默认
- 当前没有在线用户时，迁移风险主要不是会话中断，而是：
  - 老客户端保存的远端 URL 是否仍可访问。
  - `users`、`entitlements`、`refresh_tokens`、`audit_logs`、`game_high_scores` 是否迁移。
  - `JWT_SECRET` 是否保持一致；否则旧 refresh token 会失效。
- server API 层兼容方式：只追加 `/api/v1/hdo/*`，不要改现有 `/api/v1/marketplace/*`、`/api/v1/plugins/*`、`/api/v1/games/*`、`/api/v1/auth/*` 响应形状。
- Postgres migration 只追加新文件。当前游戏高分已经占用 `0004_game_high_scores.sql`，HDO 从 `0005_hdo_control_plane.sql` 开始。不要重写已应用 migration，因为 server migration runner 会校验 checksum。
- 最稳部署策略：
  - `marketServerBaseUrl` 保持是插件市场远端，可指向旧 oversea 或统一域名。
  - `hdoControlBaseUrl` 是 HDO 控制面，可指向 domestic。
  - 第一版 HDO 插件支持两个 URL 分离；默认可以相同，但 UI 和数据模型不要假设必须相同。
- 如果最终统一到 domestic：
  - 先部署同版本 `electron-server`。
  - 迁移 Postgres 和 `/app/data` 市场数据。
  - 保持旧域名反代或 DNS 指向 domestic 一段时间。
  - 新版 `electron-market` 再把默认生产 URL 指向统一域名，而不是写死某台 VPS IP。

## npm Sync 时效与发布流程

插件市场不会被 npmjs 主动推送通知。当前 `electron-server` 行为：

- boot 后约 3 秒跑一次 sync，受 `SYNC_ON_BOOT` 控制。
- 默认每 1 小时跑一次 sync，受 `SYNC_INTERVAL_MS` 控制。
- admin UI 的“立即同步 npm”调用同一个 scheduler mutex，可手动触发，不会并发写市场数据。
- server sync 完之后，客户端还需要执行“从服务器同步”或等 host 周期 sync，才会把新 index 写入本地 marketplace SQLite。

npm search 有索引延迟，刚发布的新包可能短时间搜不到。现有代码已经通过 `MARKETPLACE_ALLOWLIST` 绕过 search 延迟，但只对 allowlist 包有效。

推荐发布链路：

1. `pnpm publish` 成功。
2. 发布脚本把包名加入 server 端 `MARKETPLACE_ALLOWLIST`，或调用未来的精确同步 API。
3. 触发 `POST /api/v1/admin/sync`。
4. 插件市场客户端点击“从服务器同步”。

已在 `electron-server` 增加精确同步入口：

```text
POST /api/v1/admin/sync/package
body: { "name": "@qpjoy/electron-plugin-hdo" }
```

这个接口直接拉某个 npm 包 metadata 和 tarball，不依赖 npm search；适合发布完成后立刻让市场看到新版本。实现上会把目标包合并进现有 marketplace index，不会因为只同步一个包就清空其他插件或游戏。

## domestic-vps 出站策略

domestic-vps 是公网入口和控制面，必须保留自有公网 IP 的入站/回包路径。不能在 domestic 上常驻开启系统全局代理、默认路由到海外、或 `tunnel-cli tun-on` 这类主机级模式。

问题场景：

```text
@qpjoy/tunnel-cli / mihomo-client.sh proxy-on 或 tun-on
  -> 写入 shell/systemd daemon proxy 或启用 TUN
  -> npm/GitHub/Docker 能走 oversea
  -> 但 domestic 的所有服务出站/部分回包也可能被 overseas 接管
  -> 其他客户端访问 domestic-ip:port 可能异常
```

正确模型是“显式 egress”，只让需要访问海外资源的命令、进程或 network namespace 走 overseas：

```text
client -> domestic-ip:8080          保持 domestic 主路由
electron-server sync npm           只这个任务走 oversea proxy
docker pull / buildkit pull         只 Docker daemon 出站走 oversea proxy
git clone github.com                只 GitHub SSH/HTTPS 走 oversea proxy
tokens relay upstream API           只 provider HTTP client 走 oversea proxy
```

推荐实现：

- domestic 上跑 `hdo-egress` sidecar，例如 mihomo/Hysteria2 client，监听 `127.0.0.1:7890` 或 Docker 内网地址。
- `electron-server` 不开 TUN、不改默认路由。
- `sync-npm.ts` 后续支持 `MARKET_SYNC_PROXY_URL`，只包装 npm registry metadata 和 tarball fetch。
- Docker 拉镜像用 Docker daemon drop-in：
  - 只设置 `docker.service` / `containerd.service` 的 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`。
  - 不影响已经发布到公网的容器端口入站。
- GitHub SSH 用 `~/.ssh/config ProxyCommand` 限定 `github.com`、`gitlab.com` 等 host。
- 临时运维命令用 `mihomo-client.sh run <cmd>` 或 `hdo egress run <cmd>`，不要写系统全局 profile。
- `NO_PROXY` 必须包含：
  - `localhost`
  - `127.0.0.1`
  - `::1`
  - `postgres`
  - domestic 公网 IP/域名
  - HDO overlay 核心地址和服务域名
  - 需要直连的内网服务

HDO 服务器面板需要有“服务器出站策略”：

- `market npm sync`: direct / oversea proxy
- `docker pull`: direct / oversea proxy / 临时开启
- `github ssh/https`: direct / oversea proxy
- `tokens relay upstream`: direct / oversea proxy / per-provider
- `public ingress`: 始终 direct，不能切到 oversea

domestic 角色下应禁用或强警告：

- `tun-on`
- host-wide proxy
- system default route to oversea

这些是客户端或临时运维能力，不是 domestic 公网入口的常驻能力。

## Home 机器 tunnel-cli 与 HDO 连接模型

可以让家里的 H 机器也安装 `@qpjoy/tunnel-cli`，用 `mihomo-client tun-on`
获得和普通用户机器一致的全局出站体验；但这不能替代 H 到 domestic 的
WireGuard 反向可达链路。

原因：

- `tunnel-cli` / Mihomo TUN 主要控制 H 机器的出站流量。
- HDO 需要 domestic 能稳定访问 H 机器上的服务，仍然需要 H 主动连到
  domestic 的 WireGuard peer，例如 `100.88.0.10`。
- domestic-vps 是公网入口和控制面，用户机器不应直接依赖 H 机器公网可达。

推荐模型：

```text
H 机器:
  WireGuard peer -> domestic wg-home        # 提供 domestic -> H 的稳定内网路径
  tunnel-cli/mihomo TUN -> HDO subscription # 提供 H 自己的全局出站体验

用户机器:
  HDO 插件 -> domestic electron-server      # 注册设备、拉 manifest/subscription
  electron-plugin-tunnel/mihomo -> HDO rules # 访问 home 服务时走 domestic/HDO overlay

domestic-vps:
  electron-server + HDO API
  wg-home server
  public ingress direct
  scoped oversea egress only
```

因此 HDO 插件不应“直接连 H 机器公网”。它应连接 domestic 控制面，拿到：

- H 节点 overlay IP，例如 `100.88.0.10`
- 可访问服务列表，例如 `home-web -> 100.88.0.10:8080`
- Mihomo 规则，把 HDO service domain/IP 路由到 domestic/HDO overlay

如果未来要做 P2P/直连 H：

- manifest 可增加 `homePeerCandidates`。
- HDO 插件为用户设备生成独立 WireGuard peer。
- domestic 仍作为 rendezvous/control plane。
- 但 NAT、权限、撤销和审计复杂度明显更高；当前阶段优先 domestic 中继模型。

## HDO Mesh 与公共网络底座包

HDO 后续升级为 `HDO Mesh`：D 机器是控制面、WireGuard hub、订阅/路由编排
和 ACL 强制点；H 机器、O 机器、User 机器都可以是 mesh peer。

公共能力拆包：

- `@qpjoy/electron-core-mihomo`
  - 稳定的 Mihomo route compiler、订阅 YAML 校验、DNS/TUN/runtime 配置渲染。
  - `@qpjoy/electron-plugin-tunnel` 依赖它，后续基本不再把 Mihomo 逻辑散在插件里。
  - `@qpjoy/electron-plugin-hdo` 可用它编译 overlay、oversea、provider、cc 服务路由。
- `@qpjoy/electron-core-wireguard`
  - 稳定的 WireGuard peer/interface 配置渲染、HDO mesh 地址规划、常用端口/ACL 类型。
  - HDO 插件可在客户端内置 WireGuard-like agent，先生成配置，后续自动启停 interface。
  - 其他插件也可以依赖它加入 HDO mesh。

HDO 插件职责：

- 管理本机 mesh 身份：keypair、deviceId、overlay IP、角色、可见端口。
- 图形化控制：加入/断开 mesh、开放/关闭本机端口、访问其他成员公开端口。
- 统一路由编排：WireGuard overlay 负责 mesh 可达；Mihomo 负责本机出站、oversea、
  provider、cc 服务等策略路由。
- Three.js 可用于把 D/H/O/User 和连接状态画成可交互拓扑，让用户理解“现在谁能访问谁”。

可信 mesh 端口策略：

- User 之间不是完全公网隔离，而是 `trusted-mesh` 默认互信。
- 仍然不建议全端口开放；用户可以打开常用端口组：
  - dev: `3000, 5173, 8000, 8080`
  - web: `80, 443`
  - ssh: `22`
  - database: `5432, 3306, 6379` 等需要显式开启
- D 端用 nftables/iptables 强制 ACL：
  - trusted-mesh 允许已公开端口互访。
  - 默认拒绝未公开端口。
  - User 不能访问 D 的内部管理端口，只能访问 HDO API/proxy/WireGuard 必需端口。

O 机器部署：

- 全局 `scripts/manage.sh deploy` 后续也要支持 `deploy oversea`。
- O 机器可安装 WireGuard peer、mihomo/hysteria2 或其他 provider egress。
- cc 服务即使在 wg 直连场景，也不应散落到脚本外；由 HDO 客户端拿 manifest
  后统一编排：选择直连 WG、D 中继、O 出站或 provider-specific egress。

## HDO 部署菜单

根 `scripts/manage.sh` 新增单独部署入口：

```text
scripts/manage.sh deploy
scripts/manage.sh deploy hdo
scripts/manage.sh hdo
```

`deploy hdo` 会进入 `docker/hdo-gateway-stack/manage.sh deploy-domestic`：

- 从 `docker port qpjoy-market 8080/tcp`、`docker ps`、`electron-server/.env`
  推断 server 端口。
- 从 `ip route`、`hostname -I`、`ifconfig` 推断 domestic 公网/出口 IP。
- 交互确认 `server-url`、`public-host`、WireGuard 端口和 domestic overlay IP。
- 生成 `wg-home.conf`，可直接调用 `sudo` 启用 `wg-quick@hdo-home`。
- 可生成首个 home peer 和 scoped egress 模板。

## 编码起点

推荐先写最小闭环：

1. `electron-server` HDO schema + API
   - 新增 HDO 节点、设备、服务、订阅表。
   - 新增 manifest API。
   - 先支持手工录入 home node 和 service。
   - 当前已完成：
     - `0005_hdo_control_plane.sql`
     - JSON/Postgres 双存储实现
     - `/api/v1/hdo/readiness`
     - `/api/v1/hdo/devices/register`
     - `/api/v1/hdo/manifest/:deviceId`
     - `/api/v1/hdo/subscriptions/:deviceId/mihomo.yaml`
     - `/api/v1/hdo/admin/nodes|services|profiles|rate-limits`

2. `docker/hdo-gateway-stack/manage.sh setup-domestic`
   - 生成 `wg-home`。
   - 选择默认 `100.88.0.0/24`，检测冲突。
   - 生成家里电脑 peer 配置。

3. `docker/hdo-gateway-stack/manage.sh add-home`
   - 生成 home peer。
   - 输出家里电脑 WireGuard 配置，含 `PersistentKeepalive = 25`。
   - 同步注册到 `electron-server`。

4. `electron-server` manifest/subscription
   - 输出 `/api/v1/hdo/manifest/:deviceId`。
   - 包含国内节点、家里节点、服务列表。
   - 包含 profiles/rules，支持服务端下发默认策略。
   - 输出 `/api/v1/hdo/subscriptions/:deviceId/mihomo.yaml`。

5. `electron-plugin-hdo`
   - 导入 manifest。
   - 渲染本机 mihomo config。
   - 默认只路由 `100.88.0.0/16` 到国内 VPS。
   - UI 显示服务列表和节点状态。
   - 支持本地 profile 覆盖，例如 Claude/Codex/npm/GitHub 走不同出口。
   - P0 验证 `mihomo TUN + wireguard outbound`，确认 CC/Claude 不依赖本地端口代理也能走 oversea WG。
   - 当前已完成：
     - 新增 `@qpjoy/electron-plugin-hdo`，面板端口 `127.0.0.1:23459`。
     - HDO 插件面板拆成 `总览 / 客户端 / 服务器 / 安装 / 出站` 左侧管理 tabs。
     - 总览面板显示 HDO 完成路径，能直接提醒“插件已安装但 domestic 服务端尚未部署/不可达”，并跳转到安装命令或服务器登记页。
     - 客户端面板支持 HDO 控制面 URL、设备注册、readiness、manifest 和 Mihomo 订阅拉取。
     - 服务器面板支持节点、服务、限速记录写入 `electron-server` HDO API。
     - 安装面板集中展示 Domestic/Home/Oversea 命令；出站面板只保留 domestic scoped egress 规则，避免用户误开 host 全局代理。
     - `@qpjoy/electron-plugin-hdo@0.1.1` 已可在 `electron-demo/hdo` 开发态启用；下一次包含组织级控制面、mesh 许可、插件清单上报和任务模型的版本建议发布 `0.1.2`。
     - `electron-demo` 开发态从 workspace seed HDO；打包态从 `node_modules/@qpjoy/electron-plugin-hdo` seed HDO。
     - `electron-server` 默认 `MARKETPLACE_ALLOWLIST` 已包含 `@qpjoy/electron-plugin-hdo`，发布后可绕过 npm search 延迟。
     - `pnpm --dir electron-demo package` 已验证 packaged app 内包含 HDO 插件。
     - `@qpjoy/electron-market` 下一版建议发布 `0.3.18`，包含左侧菜单收缩/展开、插件详情基本信息/权限折叠。

6. `scripts/manage.sh hdo`
   - 当前已完成：
     - `setup-domestic` 生成 domestic `wg-home` 配置。
     - `add-home` 生成 home peer 配置并追加到 domestic `wg-home`。
     - `apply-domestic` 将配置安装到 `/etc/wireguard/hdo-home.conf` 并启用 `wg-quick@hdo-home`。
     - `setup-oversea-egress` 生成 scoped egress env 示例。

7. `tokens relay` MVP
   - 国内 VPS 暴露 API 域名。
   - relay 使用 explicit egress proxy 到海外 VPS。
   - 每个请求记录 route、provider、model、first-token latency。
   - 不依赖系统默认路由。

8. 测试：
   - 用户机器访问 `100.88.0.10:8080`。
   - 断开家里电脑 WG 后状态变离线。
   - OpenVPN 仍运行时，`172.16/17/18/19` 不受影响。
   - Claude profile 走海外出口，CN profile 直连。
   - tokens relay 流式响应不被代理层缓冲。

## 2026-05-19：HDO 组织级控制面与统一插件后台

本轮把 HDO 从“单用户设备订阅”推进到“组织/企业网络控制面”的第一版。新的原则是：

- `electron-server` 是 HDO mesh 的权威控制面；用户是否能入网、能拿哪些 profile、能收到哪些订阅，由登录账号和 mesh 许可决定。
- HDO 客户端只持有本机运行所需的配置和私有材料；服务端只保存用户、设备、公开状态、插件清单、profile/订阅生成物和管理任务，不应要求用户把本机私钥上传到服务端。
- 管理员通过服务器后台创建 mesh group，把用户加入 mesh group，设置角色和状态；用户登录插件市场后，HDO 插件自动复用市场 token 拉取 readiness、manifest、mihomo 订阅和待处理任务。
- 多个 mesh group 可以共用同一套 `electron-server`。节点、服务、profile 后续可通过 `metadata.meshGroupIds` 或 `metadata.meshGroups` 限定可见范围；未配置该 metadata 时默认对所有已授权 mesh 可见。
- 远程“帮用户安装/启停插件”先以设备任务模型落地：服务端创建任务，客户端拉取并展示。实际执行任务必须再接入插件市场 host 的安装/启停 API，并在客户端本地做确认、执行日志和回执。

### 新增服务端数据模型

新增迁移：

```text
electron-server/db/migrations/0006_hdo_org_control.sql
```

新增表：

- `hdo_mesh_groups`
  - 组织网络分组，字段包括 `name`、`slug`、`default_profile_id`、`enabled`、`metadata`。
  - 一个 server 可以承载多个 mesh 组。
- `hdo_mesh_memberships`
  - 用户入网许可，字段包括 `mesh_group_id`、`user_id`、`role`、`status`、`profile_id`。
  - `role`: `member | admin | support`。
  - `status`: `active | suspended | revoked`。
  - 只有 `active` 且所属 mesh group `enabled=true` 的 membership 才能生成有效 manifest/订阅。
- `hdo_device_plugin_states`
  - 客户端上报的本机插件清单，字段包括 `device_id`、`plugin_id`、`npm`、`version`、`state`、`manifest`、`health`。
  - 用于服务器后台查看某个用户/设备安装了哪些插件。
- `hdo_device_tasks`
  - 管理端下发给用户或设备的任务。
  - `kind`: `install-plugin | uninstall-plugin | activate-plugin | deactivate-plugin | apply-hdo-profile`。
  - `status`: `pending | claimed | done | failed | cancelled`。

JSON 存储同步扩展了 `hdo.json` 的 `meshGroups`、`memberships`、`pluginStates`、`deviceTasks` 字段，旧文件缺字段时会自动按空数组兼容。

### 新增/调整 HDO API

客户端 API：

```text
POST /api/v1/hdo/devices/register
POST /api/v1/hdo/devices/:deviceId/plugin-states
GET  /api/v1/hdo/device-tasks?status=pending
POST /api/v1/hdo/device-tasks/:id/complete
GET  /api/v1/hdo/readiness
GET  /api/v1/hdo/manifest/:deviceId
GET  /api/v1/hdo/subscriptions/:deviceId/mihomo.yaml
```

管理端 API：

```text
GET  /api/v1/hdo/admin/overview
GET  /api/v1/hdo/admin/mesh-groups
POST /api/v1/hdo/admin/mesh-groups
GET  /api/v1/hdo/admin/memberships
POST /api/v1/hdo/admin/memberships
GET  /api/v1/hdo/admin/device-plugin-states
GET  /api/v1/hdo/admin/device-tasks
POST /api/v1/hdo/admin/device-tasks
```

`readiness` 现在会返回 mesh 许可状态。没有有效 mesh 许可时，`blockers` 包含 `No active HDO mesh license`，HDO 客户端总览会提示“缺 mesh 许可”。

`manifest` 现在按 mesh 许可过滤：

- 没有有效 membership：`license.active=false`，`nodes/services/profiles` 为空，仍返回设备和许可状态，方便 UI 解释原因。
- 有有效 membership：返回该用户可见的 nodes/services/profiles/rateLimits，并包含 `license` 和 `mesh` 摘要。
- `metadata.meshGroupIds` 或 `metadata.meshGroups` 存在时，只对对应 mesh group 可见。

### 新增服务器后台页面

新增页面：

```text
electron-market/packages/admin-ui/src/pages/ServerHdoPage.vue
```

入口：

```text
/admin/#/server/hdo
```

左侧服务器导航新增 `HDO`。当前页面包含四个 tab：

- `Mesh`
  - 创建/更新 mesh group。
  - 快速创建默认组织网络。
  - 选择默认 HDO profile。
- `许可`
  - 把用户加入 mesh group。
  - 设置 `member/admin/support` 角色。
  - 设置 `active/suspended/revoked` 状态。
- `设备`
  - 查看所有已注册 HDO 设备。
  - 查看设备上报的插件清单。
- `任务`
  - 给用户或指定设备创建远程任务。
  - 当前只创建任务，不自动执行安装；客户端执行器后续接入插件 host API。

这页是 HDO “服务端和客户端同一管理界面”的第一步：服务器后台能看到用户、设备、插件、许可、任务；客户端 HDO 面板也能显示自己的许可和任务状态。后续可把其他官方插件的管理 UI 作为 server-side admin panel 注册到这里，实现“管理员从服务器后台进入某个用户/某个插件的管理视图”。

### HDO 插件客户端改动

`@qpjoy/electron-plugin-hdo` 新增能力：

- `HdoController.snapshot()` 返回：
  - `localPlugins`: 本机已安装插件清单。
  - `deviceTasks`: 当前用户待处理 HDO 任务。
  - 管理员登录时的 `admin.overview` 摘要，包括 users、meshGroups、memberships、devices、pluginStates、tasks。
- `registerDevice()` 会把 `localPlugins` 一并提交给服务端。
- `snapshot()` 在已注册设备时会尽力上报插件清单，失败只写日志，不阻塞页面。
- 本地 HDO 面板新增：
  - mesh 许可状态。
  - 待处理任务数量。
  - “上报插件清单”按钮。
  - 本机插件清单表。
  - 服务端待处理任务表。

上一阶段只完成了任务的控制面和展示面；下面的“远程任务执行器”已继续补上客户端执行闭环。执行器仍依赖这些前提：

- 插件市场 host 暴露安全的安装/启停 API。
- HDO 插件按任务 `kind` 调用 host API。
- 客户端显示任务执行日志、失败原因、用户确认。
- 完成后调用 `/api/v1/hdo/device-tasks/:id/complete` 回写结果。

### 2026-05-19 续：HDO 远程任务执行器

已补齐“服务端创建任务，HDO 客户端领取并执行”的第一版闭环。

插件市场 host 新增受控能力：

- `PluginHostBridge.pluginManager`
  - `listInstalled()`
  - `install({ id, npm, version, tarballUrl, autoGrant, activate })`
  - `uninstall(id)`
  - `activate(id)`
  - `deactivate(id)`
  - `upgrade(id, version)`
- 新增权限 `marketplace:plugins`。该权限是高危权限，代表插件可以安装、卸载、启停或升级市场插件。
- `@qpjoy/electron-plugin-hdo` 从 `0.1.1` 升到 `0.1.2`，manifest 增加 `marketplace:plugins`。已有安装需要重新授权该权限后，HDO 才会执行服务端下发的插件任务。

服务端任务状态流：

```text
pending -> claimed -> done
                   \-> failed
                   \-> cancelled
```

新增客户端 API：

```text
POST /api/v1/hdo/device-tasks/:id/claim
POST /api/v1/hdo/device-tasks/:id/complete
```

`claim` 解决多客户端并发问题：

- HDO 客户端只执行 `pending` 任务。
- 执行前先调用 `claim`。
- 如果任务指定了 `deviceId`，只有对应设备可以领取。
- 如果任务是用户级任务且没有 `deviceId`，第一台领取成功的客户端会把任务变为 `claimed`。
- 执行完成后客户端调用 `complete` 写回 `done/failed` 和执行结果。

HDO 客户端新增：

- `executePendingTasks()`
  - 拉取当前用户 `pending` 任务。
  - 过滤当前设备可执行任务。
  - 逐个 claim。
  - 按 `kind` 调用 `host.pluginManager`。
  - 执行后回写 `done/failed`。
  - 最后重新上报本机插件清单。
- `snapshot()` 在 `autoRunDeviceTasks !== false` 且存在可执行任务时，会后台触发执行器；不会阻塞 UI。
- 本地 HDO 面板新增“执行待处理任务”按钮，并显示 `lastTaskRun` 摘要。

当前支持的任务 payload：

```json
{
  "kind": "install-plugin",
  "pluginId": "qpjoy.electron-plugin-tunnel",
  "payload": {
    "version": "0.1.16",
    "autoGrant": "manifest",
    "activate": true
  }
}
```

`install-plugin` 规则：

- `pluginId` 优先按 marketplace entry id 查找。
- 如果 `payload.npm` 存在，则按 npm 包名查找。
- `autoGrant: "manifest"` 或 `autoGrant: true` 会授予目标插件 manifest 中声明的全部权限。
- `activate: true` 会在安装/授权后立即激活。
- 默认不自动授权、不自动激活，除非 payload 明确要求。

其他任务：

- `activate-plugin`: 激活指定插件。
- `deactivate-plugin`: 停用指定插件。
- `uninstall-plugin`: 停用后卸载指定插件。
- `apply-hdo-profile`: 写入 HDO 本地 `activeProfileId`，后续接入本地 profile 渲染。

安全边界：

- 远程任务执行依赖用户本地已经授权 HDO 的 `marketplace:plugins` 权限；没有该权限时，任务会失败并回写错误。
- 服务端只下发 intent，不直接拿到用户本机文件系统或私钥。
- `autoGrant` 必须由服务端 payload 显式给出；默认安装不会静默授予目标插件权限。
- 管理后台创建任务时应优先给指定设备创建任务；用户级任务适合“任选一台在线设备执行一次”的场景，不适合“所有设备都执行一次”。

### 2026-05-19 续：客户端 WireGuard peer 与本地路由探测

旧 `scripts/wireguard.sh` 的模型是服务端生成完整客户端配置，用户下载后导入 WireGuard 客户端。HDO 新模型改成：

- 客户端本机生成 WireGuard 私钥/公钥。
- 服务端只保存公钥、设备信息、本地路由探测摘要和 overlay IP。
- 私钥不上传到 `electron-server`，也不进入 manifest。
- manifest 只下发 domestic peer、公钥、endpoint、HDO route CIDR 和服务列表。

这带来两个好处：

1. 安全边界更清楚：服务端可以禁用用户、吊销 mesh 许可、停止下发新配置，但不会持有用户设备私钥。
2. 客户端能看到本机真实网络：可以探测 macOS/Linux/Windows 本地 IPv4 route，提前发现与 HDO 默认 `100.88/100.89/100.90` 网段冲突，给出“切换 mesh overlay 网段”的提示。

实现边界：

- `@qpjoy/electron-core-wireguard` 新增：
  - WireGuard 配置渲染 `renderHdoClientWireGuardConfig()`。
  - 本地路由探测 `buildHdoRouteProbe()`。
  - CIDR overlap 检测。
  - WireGuard runtime 解析 `resolveWireGuardRuntime()`。
- WireGuard CLI 不依赖用户本地环境。HDO 默认只使用：
  - 插件资源目录里的 `resources/wireguard/<platform-arch>/wg(.exe|.gz)`。
  - 或平台 engine 包 `@qpjoy/electron-core-wireguard-engine-<platform-arch>`。
  - 复制/解压到插件 `userData/bin` 后再执行。
- 系统 PATH 里的 `wg` 只允许作为显式开发兜底；正式插件流程不能要求 Windows/macOS/Linux 用户预装命令行工具。

HDO 不是内置插件，因此 WG 引擎不打进 `@qpjoy/electron-market` 主体。正确分发链路是：

```text
用户安装 @qpjoy/electron-plugin-hdo
  -> npm 安装 @qpjoy/electron-core-wireguard
  -> npm 按 os/cpu 自动选择一个 @qpjoy/electron-core-wireguard-engine-<platform-arch>
  -> HDO 启动时把 engine 包中的 wg/wg.exe 复制/解压到 userData/bin
```

平台包目录：

```text
electron-plugin/packages/wireguard-engines/darwin-arm64
electron-plugin/packages/wireguard-engines/darwin-x64
electron-plugin/packages/wireguard-engines/linux-arm64
electron-plugin/packages/wireguard-engines/linux-x64
electron-plugin/packages/wireguard-engines/win32-x64
```

这些包已有发布骨架、真实 `wg`/`wg.exe` 资源和 `prepack` 校验；缺少二进制时不能打包发布，避免发出空 engine 包。

当前已填入的 WG 资源来源：

- `darwin-arm64` / `darwin-x64`：从 Homebrew `wireguard-tools` bottle `1.0.20260223` 提取 `wg`。
- `linux-arm64` / `linux-x64`：从官方 `wireguard-tools-1.0.20260223.tar.xz` 在 Alpine 容器中静态编译 `wg`。不要直接使用 Homebrew Linux bottle，因为其 ELF interpreter 指向 Linuxbrew 环境，不适合作为普通 Linux 发行包。
- `win32-x64`：从官方 WireGuard Windows MSI `wireguard-amd64-1.1.msi` 提取 `wg.exe`。
- 每个 engine 包都带 `COPYING`，license 为 `GPL-2.0-only`。

插件市场安装注意：

- HDO 通过 npm/下载安装，不作为 host seed 内置。
- 如果服务端给的是 HDO tarball URL，插件市场也必须用 npm 安装而不能只解包 tarball；否则 HDO 的 `@qpjoy/electron-core-wireguard` 和平台 optional engine 不会进入插件目录。
- `PluginStore` 已把 `@qpjoy/electron-plugin-hdo` 标记为需要 package-manager 安装的插件。
- HDO 插件调用服务端 API 时复用插件市场本地登录态。access JWT 默认 7 天过期，refresh token 默认 30 天过期，可通过 `JWT_ACCESS_TTL_SECONDS` / `JWT_REFRESH_TTL_SECONDS` 调整；插件必须在 access 即将过期或收到 401 时用 refresh token 调 `/api/v1/auth/refresh` 静默续期，并把新 token 写回 marketplace session。只有 refresh token 失效、被吊销或服务器数据被清空时才要求用户重新登录。
- `@qpjoy/electron-plugin-hdo@0.1.3` 增强内嵌管理页操作反馈：保存节点、保存服务、注册设备、拉取订阅等按钮都会显示处理中、成功或失败原因，避免请求失败时只在 iframe 控制台里报错。
- Web 后台 `/admin/#/server/hdo` 已承接组织级 HDO 配置：Mesh、许可、节点、服务、Profile、限速、设备和任务都在服务端后台统一管理。Electron HDO 插件里的“服务器”页保留为本机辅助入口，长期应退到只做当前客户端视角和跳转提示。
- Web 后台节点表单比插件内嵌页更完整：支持 `metadata.wireGuard.publicKey`、`endpointHost`、`listenPort`，domestic 节点保存这些字段后，客户端 `prepareWireGuardPeer()` 才能从 manifest 生成有效 WireGuard 配置。
- Home 节点接入分两层：先在 D 上生成 Home peer 配置并在 H 机器导入/启用 WireGuard，确认 `D -> H overlay IP` 可 ping/ssh；再到 Web 后台 `HDO -> 节点` 登记 Home 节点，到 `HDO -> 服务` 添加 `home-ssh` 等服务。D 作为 hub 支持 H/H/User 互访时需要开启 IP forwarding，`hdo apply-domestic` 会写入 `/etc/sysctl.d/99-hdo-forwarding.conf`。

发布顺序：

1. `prepare-engine`：先发布五个 `@qpjoy/electron-core-wireguard-engine-<platform-arch>` 包。
2. `prepare-core`：发布 `@qpjoy/electron-core-mihomo`，供 `@qpjoy/electron-plugin-tunnel` 和 HDO 复用 Mihomo 路由编译能力。
3. `prepare-core`：发布 `@qpjoy/electron-core-wireguard`，它的 optionalDependencies 指向平台 engine 包。
4. `prepare-host`：发布 `@qpjoy/electron-plugin-sdk` 与 `@qpjoy/electron-market`。
5. `prepare-plugin`：最后发布 `@qpjoy/electron-plugin-hdo`，确保安装时能解析到 core 与 engine 依赖。

HDO 客户端新增本地 API：

```text
POST /api/client/wireguard/prepare
```

该 API 做这些事：

1. 运行本地 route probe。
2. 使用内置 WG CLI 生成或轮换 key pair。
3. 调用 `/api/v1/hdo/devices/register` 注册设备，只上传 public key 和 route probe。
4. 服务端按用户设备分配默认 `100.89.0.x` overlay IP。
5. 拉取 manifest。
6. 如果 manifest 已包含 domestic WireGuard 公钥和 endpoint，则渲染本机 WireGuard profile。

服务端设备注册变化：

- `/api/v1/hdo/devices/register` 如果收到 `publicKey` 且设备还没有 `overlayIp`，会从默认 user CIDR 中分配 `100.89.0.10+`。
- 注册时如果同一个 device id 已属于其他用户，会返回 `409`，避免设备 id 被抢占。
- `buildManifest()` 新增 `wireGuard` 段：

```json
{
  "wireGuard": {
    "routeCidrs": ["100.88.0.0/16", "100.89.0.0/16", "100.90.0.0/16"],
    "client": {
      "publicKey": "...",
      "overlayIp": "100.89.0.10",
      "address": "100.89.0.10/32"
    },
    "domestic": {
      "nodeId": "domestic-main",
      "publicKey": "...",
      "endpointHost": "121.43.253.179",
      "listenPort": 51888,
      "endpoint": "121.43.253.179:51888",
      "overlayIp": "100.88.0.1"
    }
  }
}
```

domestic 节点需要在 `metadata.wireGuard` 中保存：

```json
{
  "wireGuard": {
    "publicKey": "<domestic wg public key>",
    "listenPort": 51888
  }
}
```

如果 domestic 节点还没有这段 metadata，客户端仍能生成本机 key pair 并注册公钥，但只显示“等待 domestic 节点补齐 WireGuard endpoint”，不会生成可导入的 profile。

路由规则原则：

- 默认 WireGuard `AllowedIPs` 只包含 HDO overlay/service 网段，不使用 `0.0.0.0/0`。
- 外网访问仍优先交给 Mihomo/Hysteria2/显式 egress；“全局 WG”必须是高级显式开关。
- 如果用户本机 LAN/VPN 与 HDO overlay 冲突，客户端只告警，不静默覆盖本机路由。
- 后续可以根据 route probe 为不同客户端生成更细的服务路由，例如避开用户本地 `192.168.x.0/24`，或在 home LAN 冲突时提示改用 service VIP/NAT 模式。

### 安全边界

- mesh 许可由服务端统一管理，比把 WireGuard peer/订阅直接手工分发给用户更可控。
- 禁用用户账号或把 membership 改为 `suspended/revoked` 后，新的 manifest/订阅不会再下发有效 nodes/services。
- 已经下载到客户端本地的旧配置仍可能短时间可用；后续需要在 gateway/mihomo/WireGuard 层增加短 TTL、generation 校验和服务端撤销同步。
- 插件清单上报只应保存管理必要信息：plugin id、npm、version、state、manifest 摘要和 health。不要上传插件私有数据、用户文件路径、token 或本机私钥。
- 服务端创建“远程安装插件”任务只是 intent。真正执行必须在客户端本地经过 host 权限校验，并限制为官方/已允许插件来源。

### 兼容性

- 旧 HDO 表 `hdo_nodes`、`hdo_devices`、`hdo_services`、`hdo_profiles`、`hdo_rate_limits`、`hdo_subscription_artifacts` 保持不变。
- 新增 mesh 许可后，已有用户如果没有 membership，会看到“缺 mesh 许可”，manifest/订阅不会再包含有效服务。部署后管理员需要先在 `/admin/#/server/hdo` 创建默认 mesh 并给用户发放 active membership。
- JSON 存储旧 `hdo.json` 可继续读；缺少的新数组会自动补空。
- Postgres 通过 `0006_hdo_org_control.sql` 迁移新增表，不改历史 migration checksum。

### 下一步实现顺序

1. 在 `electron-server/scripts/manage.sh deploy hdo` 成功后可选自动调用 admin API 创建默认 mesh、domestic node 和管理员 membership。
2. 按 `prepare-engine -> prepare-core -> prepare-host -> prepare-plugin` 顺序发布 npm 包，并在 `electron-server` 执行 sync/精确同步。
3. 为 `metadata.meshGroupIds` 做服务器后台表单支持，让节点、服务、profile 可以明确归属某些 mesh group。
4. 增加短 TTL/撤销策略，避免用户被禁用后旧订阅长期可用。
5. 把 HDO `activeProfileId` 接入本地 mihomo/WireGuard 渲染，让 `apply-hdo-profile` 不只是记状态，而是实际切换本机网络策略。
