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

在 OpenVPN 配置文件中添加以下内容，避免服务器推送的路由与本方案冲突：

```bash
# ===== 关键：不接受服务器推送的路由 =====
route-nopull

# 只路由公司内网
route 10.0.0.0 255.0.0.0 vpn_gateway
route 172.16.0.0 255.240.0.0 vpn_gateway
route 192.168.0.0 255.255.0.0 vpn_gateway

# 家庭 Wi-Fi 网段走本地
route 192.168.1.0 255.255.255.0 net_gateway
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
├── scripts/
│   ├── fix-routes.sh      # 修复路由（主脚本）
│   ├── restore-routes.sh  # 恢复网络
│   └── wireguard.sh       # WireGuard 服务器安装脚本
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
