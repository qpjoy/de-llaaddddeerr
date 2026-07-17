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

诊断包仍可能包含本机 IP、网卡、DNS 后缀和路由信息，只应发送给可信的排查人员。
