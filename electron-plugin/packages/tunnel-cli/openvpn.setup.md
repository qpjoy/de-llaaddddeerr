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

## CLI updates and installed instances

`npm i -g @qpjoy/tunnel-cli@latest` updates the CLI and its packaged management
scripts. It does not restart OpenVPN/WireGuard, upgrade the OS VPN binary or a
Docker image, replace `/etc` configurations, regenerate credentials, or re-enroll
clients. New lifecycle checks take effect on the next CLI invocation. A service
restart alone reloads existing configuration; it does not regenerate files from
new CLI templates. Apply a specific configuration change through its documented
reconfigure/enroll operation, not a forced reinstall.

The OpenVPN server firewall service retains a private helper copy under the
instance directory so boot does not depend on npm installation paths. After
installing a release containing `refresh`, update that copy without disconnecting
clients:

```bash
sudo qp-tunnel-cli open refresh --instance mx
```

This updates only the installed helper atomically; it does not alter PKI,
profiles, service templates, live firewall rules or restart services. Existing
rules will use the updated helper on the next firewall lifecycle operation.
There is no need to restart healthy tunnels merely because the CLI was updated.

OpenVPN lifecycle cleanup now fails closed: failed service/container stops or a
remaining Linux interface prevent configuration deletion. Server uninstall
checks that its NAT chains are gone before deleting state. Client pin cleanup
only deletes the recorded destination/gateway/device tuple. Failure preserves
recovery files. `--purge` remains explicit: it removes server PKI and issued
profiles after successful cleanup; normal server uninstall retains them.
Run lifecycle operations serially for each instance.

## One hub or two hubs

If a new overseas host only needs access to an existing internal spoke, enroll
it as another client of the existing server. Enable `client-to-client` on that
server when spoke-to-spoke access is intended; this is central forwarding, not
a direct peer mesh. The new host reaches the internal host using its tunnel IP.
The internal host needs no publicly reachable listening port.

For high-volume traffic between the new overseas host and the internal host,
the new host can instead run a second server and the internal host can enroll
as a second client instance. Give the two networks disjoint subnets, such as
`100.127.0.0/24` and `100.127.10.0/24`, after checking local routes, Docker/CNI,
WireGuard and other VPN networks. Use distinct instance names, for example
`mx` and `edge2`, especially for multiple clients on the same host:

```bash
# Internal host: add the profile issued by the second server.
sudo qp-tunnel-cli open enroll --instance edge2 --file internal-edge2.ovpn
qp-tunnel-cli open status --client --instance edge2
```

The internal host then has one tunnel address per network. Applications choose
the address belonging to the intended path. Dual enrollment does not combine
bandwidth, automatically fail over, or make the two networks transitively
reachable. Each flow is limited by its path, endpoint CPU and shared physical
uplink. A direct tunnel removes the relay hop but may still be slower if its
Internet path has higher loss or lower capacity; compare RTT and throughput.

A machine may be a client of one star and a server of another. Role-specific
interface names (`ovpn-*` versus `ovpns-*`) and directories are separate. Prefer
different instance names and use explicit `--client`/`--server` for lifecycle
commands. Avoid overlapping subnet routes and listening ports. Do not enable
`open egress on` on either client merely to connect the private network.

`route-nopull` plus generated pull filters preserves the normal default gateway
and DNS under ordinary enrollment; the tunnel interface still installs its own
subnet route, and the client may pin the VPN server's public /32 route. It is
not a promise of zero routing changes. Extra manual routes or opt-in egress can
change that behavior. Multiple attached networks also do not constitute a
security isolation boundary: inspect forwarding/firewall policy on shared hosts.

Access to the internal host's entire LAN is a separate site-to-site routing
requirement. It needs explicit destination routes, OpenVPN `iroute` where
applicable, forwarding/firewall policy and return routes (or deliberate NAT).
Enrolling that one host does not automatically expose the rest of its LAN.
