# openvpn qp-tunnel-cli

## 初次部署

```bash
# --instance 用于多实例，默认是 mx
## 文件在/etc/qp-openvpn-server/mx/clients
sudo qp-tunnel-cli open preflight --server --subnet 100.127.0.0/24
sudo qp-tunnel-cli open install --host <公网IP> --port-range 20000-20100
sudo qp-tunnel-cli open create internal-01 --ip 100.127.0.10

# 内网 Linux：先检查冲突，再 enroll
sudo qp-tunnel-cli open preflight --file internal-01.ovpn
sudo qp-tunnel-cli open enroll --file internal-01.ovpn
sudo qp-tunnel-cli open doctor
```

`route-nopull` 让客户端只增加 VPN 网段的直连路由，不替换默认路由，也不接管 DNS。
内网机器应始终用 CLI 的 `preflight`、`enroll` 和 `doctor`，不要绕过保护直接启动
profile。

## 在现有服务上安全开启客户端互访

发布并安装新版本后，只使用 `reconfigure`，不要用 `install --force` 重装现有实例：

```bash
# 外网 Linux（OpenVPN server）
sudo npm i -g @qpjoy/tunnel-cli@<新版本> --force
sudo qp-tunnel-cli open status --server --instance mx
sudo qp-tunnel-cli open reconfigure --server --instance mx --client-to-client
sudo qp-tunnel-cli open status --server --instance mx
sudo qp-tunnel-cli open reachable --server --instance mx
```

该命令只更新 `server.conf`/`server.env` 中 tunnel-cli 管理的 peer-mesh 配置，保留
endpoint、subnet、runtime、egress、PKI、CCD 固定地址、已签发 profiles、iptables
和 sysctl。服务正在运行时会短重启一次，现有内网客户端会用原证书和原地址自动重连，
不需要重新 enroll。若新配置启动失败，命令会恢复旧文件并再次启动旧服务。

开启后的服务端配置顺序是：

```text
ignore-unknown-option disable-dco
disable-dco
client-to-client
```

这样客户端互访固定走 OpenVPN 用户态，不需要新增 `ip_forward` 或 Linux `FORWARD`
规则。它是所有 enrolled 客户端的 full-trust mesh，只互通 VPN 固定地址；不会自动
暴露任一客户端的 LAN、Docker 或 Kubernetes 网段。

## 给外网 Windows 发放独立 profile

```bash
# 先用 list 确认地址未占用，再在 server 上签发独立身份
sudo qp-tunnel-cli open list --server --instance mx
sudo qp-tunnel-cli open create windows-01 --instance mx --ip 100.127.0.20
```

不要复用内网服务器的 profile，也不要仅因 Windows 位于海外而加 `--oversea`；该
参数表示“允许客户端后续选择服务端 egress”，与 peer mesh 无关。安全传输生成文件：

- Windows OpenVPN Community GUI 导入 `windows-01.ovpn`。
- Windows OpenVPN Connect 导入 `windows-01.connect.ovpn`。

导入前后分别在管理员 PowerShell 记录默认路由和 DNS：

```powershell
Get-NetRoute -DestinationPrefix 0.0.0.0/0
Get-DnsClientServerAddress
```

连接后确认两项没有被 VPN 替换，并用内网服务器的固定 VPN 地址验证实际端口：

```powershell
ipconfig
Test-NetConnection 100.127.0.10 -Port 22
```

把 `22` 换成真实业务端口。目标服务必须监听 `100.127.0.10` 或 `0.0.0.0`，内网
服务器防火墙也必须允许 Windows 固定 VPN 地址访问该端口。若还需要内网主动连接
Windows，应在 Windows Defender Firewall 中只给所需端口和 VPN 来源地址放行入站；
不要关闭整机防火墙。GUI 中也不要额外开启“所有流量走 VPN”或 DNS 接管。

## 回滚与日常命令

```bash
# 关闭 OpenVPN 用户态 peer mesh；同样只短重启，不改 firewall/sysctl
sudo qp-tunnel-cli open reconfigure --server --instance mx --no-client-to-client

# 状态与日志
sudo qp-tunnel-cli open status --server --instance mx
sudo qp-tunnel-cli open logs --server --instance mx

# 吊销 Windows 身份后重启服务加载最新 CRL
sudo qp-tunnel-cli open revoke windows-01 --instance mx
sudo qp-tunnel-cli open restart --server --instance mx
```

`--no-client-to-client` 只是关闭 OpenVPN 用户态转发，不是隔离防火墙。如果宿主机另有
内核转发规则，应单独审计；`reconfigure` 不会擅自修改这些现有规则。
