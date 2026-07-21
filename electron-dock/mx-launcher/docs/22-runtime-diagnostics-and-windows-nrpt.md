# MX-H2I 运行日志与 Windows NRPT 诊断

MX-H2I 在主进程中维护低开销的结构化运行日志，用于排查 WireGuard、PAC、split DNS、Windows NRPT 和模式切换错误。日志写入不进入连接关键路径：调用方只构造一条短事件，文件追加和轮转在异步队列中串行完成。

## 日志保留

- 目录：Electron `userData/logs/`
- 当前文件：`mx-h2i-runtime.ndjson`
- 单文件上限：2 MB
- 轮转：当前文件加 2 份历史文件
- 内存只保留最近 40 条事件，高级页面最多显示最近 5 条 warning/error
- 常见 token、密码、私钥、Cookie 和 Authorization 字段会在写入前隐藏

## 导出诊断包

高级选项中的“导出诊断包”会让用户选择父目录，再创建独立的 `MX-H2I-diagnostics-*` 文件夹。较重的系统命令只在用户点击导出时执行。

通用文件：

- `summary.json`：版本、平台、连接状态、最近错误和活动
- `network-diagnostics.json`：域名解析、PAC、WireGuard 和网络环境诊断
- `runtime-logs/`：滚动 NDJSON 日志
- `wireguard-route-audit.log`：WireGuard 服务审计日志（存在时）

Windows 额外文件：

- `windows-dns-nrpt.json`：`Get-DnsClientNrptGlobal`、有效 NRPT policy、NRPT rules、网卡 DNS 和 IP 配置
- `windows-ipconfig-all.txt`：`ipconfig /all`
- `windows-route-print.txt`：`route print`

## Windows DNS / NRPT 排查顺序

1. 查看 `summary.json` 的连接状态和最近 `wireguard.not-ready` / `network.diagnostics-problem`。
2. 查看 `wireguard-route-audit.log` 是否完整出现 `nrpt add start`、每个 namespace 的 `nrpt assert ... count=1` 和 `nrpt add complete`。
3. 查看 `windows-dns-nrpt.json`：全局 QueryPolicy 应允许 NRPT，目标 namespace 应存在且 NameServers 指向 MX-H2I DNS。
4. 若规则正确但仍解析到公网，结合 `windows-ipconfig-all.txt` 检查网卡 DNS，并检查浏览器 Secure DNS/DoH、第三方代理或企业组策略。
5. 若日志出现 `rules missing after add`、`global policy failed` 或 PowerShell stderr，优先按错误原文检查管理员权限、安全软件和组策略拦截。

Windows 会监控非 loopback 网卡地址、掩码和 MAC 组成的网络签名。切换 Wi-Fi/有线网络后，后台只做无提权的 WireGuard、路由和 Internal API 探测，不会突然弹 UAC。用户点击“修复网络”后才执行提权修复：

1. WireGuard 服务未运行时先恢复服务；已运行时保留当前 peer。
2. 根据当前 WireGuard profile 重建 overlay routes。
3. 重建 split-DNS NRPT namespace，并校验目标 NameServers。
4. 执行 `Clear-DnsClientCache`，再探测 overlay 路由和 Internal API。

`network-unavailable`、`lease-only` 和 `tunnel-only` 是可恢复状态，不再被“已经连接”的重复请求保护拦截；用户点击“重新连接”会真正进入恢复流程。

## macOS 长时间运行后切换网络

如果 Mac 未关机、未待机，直接从一个网络进入另一个网络，优先使用 MX-H2I 自带脚本：

```sh
electron-dock/mx-launcher/demos/mx-h2i/scripts/repair-macos-dns.sh
```

安装包中的位置是 `MX-H2I.app/Contents/Resources/repair/repair-macos-dns.sh`。脚本会先直接检查 `127.0.0.1:2053`：A 查询必须得到 IPv4，AAAA 查询不得错误得到 A；通过后才重建 `State:/Network/Service/com.qpjoy.electron-launcher.domain-proxy/DNS`、刷新 `dscacheutil` / `mDNSResponder` 缓存并复检。

默认不会改动 V1 HDO 留下的 `/etc/resolver/*`。确认 HDO 已断开且 MX-H2I 应接管相同域名时，可显式运行：

```sh
electron-dock/mx-launcher/demos/mx-h2i/scripts/repair-macos-dns.sh --remove-legacy-hdo-resolvers
```

脚本只移动带 HDO 标记或 `100.88.0.1` 的旧 resolver 文件，备份保留在 `/var/tmp/mx-h2i-dns-repair-*`；不会删除无关 resolver。`--check-only` 只诊断。

应用内的自动检查也不再只看 resolver 配置是否存在，而是向本地 relay 发送真实 A/AAAA 查询。MX-H2I 对内部 IPv4 ownership 只在 A/ANY 查询中合成记录，AAAA 返回合法的 NOERROR/NODATA。这样可避免 macOS `getaddrinfo` 同时请求 A/AAAA 时被错误响应拖入超时。

若 `dig @127.0.0.1 -p 2053 <host> A` 已正常、`http://<host>` 通过固定 IP 也能返回 HTTP，但浏览器仍失败，应继续区分 HTTPS/HSTS 与 443 vhost：443 上的 nginx reset/证书/转发错误是 TLS 层问题，不是 split DNS 本身。

诊断包仍可能包含本机 IP、网卡、DNS 后缀和路由信息，只应发送给可信的排查人员。
