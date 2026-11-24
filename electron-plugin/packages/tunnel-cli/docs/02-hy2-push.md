# Hysteria2 一键推送设计（`qp-tunnel-cli hy2`）

本文记录 `@qpjoy/tunnel-cli` 中 `hy2` 命令族的设计依据、边界和验收口径。
目标读者是后续维护这条链路的人。

## 1. 要解决的问题

一台装了 `qp-tunnel-cli` 的机器（通常是 Internal 服务器）需要一个**本机端口**，
应用把流量交给这个端口，流量从**另一台主机**出去。那台主机只要能 SSH 登录即可：
可能在海外，也可能是国内机房；可能拉不到 GitHub 和 Docker Hub；可能是全新系统。

在此之前仓库里已有 `edge` 栈 `hy2-mihomo`（Docker 里的官方 hysteria + Caddy 订阅站），
但它为"对外发订阅"设计，推送前要手填 bcrypt 哈希、公网地址、用户列表，
目标机要装 Docker 并能拉镜像，本机还要再去订阅站取 YAML。对"给本机一个端口"来说，
步骤和依赖都太多。

## 2. 结论

```bash
qp-tunnel-cli hy2 up oversea-1 --host 203.0.113.10 --key ~/.ssh/id_ed25519
curl -x http://127.0.0.1:7891 http://api.ipify.org/
```

- 服务端：新的 edge 栈 `hy2`，mihomo 引擎 + systemd，**不用 Docker**。
- 引擎：两端都用团队已在 npm 发布的 `@qpjoy/electron-plugin-tunnel-engine-<platform>`
  （mihomo，含 hysteria2 入站监听）。推送机 `npm pack` 一次（支持镜像源），随 bundle
  上传；目标机**不下载任何东西**。
- 证书：自签 ECDSA P-256，10 年；客户端用 SHA-256 指纹固定（`fingerprint`），不需要域名和 CA。
- 本机：mihomo-client 的**命名实例** `hy2-<host>`，只听 127.0.0.1。
- 推送复用 `edge push` 的全部机制：release 不覆盖、state 分离、origin 归属、ledger、rollback。

为什么用 mihomo 而不是官方 hysteria 二进制：同一个引擎已经有 npm 分发渠道和镜像，
本机侧 mihomo-client 也是它，一份二进制两端通用；官方二进制只有 GitHub Release，
国内推送机拉取不稳定。实测 mihomo v1.19.28 的 hysteria2 监听器与客户端互通，
`allow-lan: false` 不影响监听器接受外部连接，错误指纹会被拒绝
（`certificate fingerprints do not match`）。

## 3. 文件

推送机（`<edge home>` 与 `edge` 相同，Linux 默认 `/var/lib/qp-tunnel/edge`）：

```text
<edge home>/hy2/<host>/hy2.json             设置与密钥（0600）：server、port、password、fingerprint、localPort、instance、pushed
<edge home>/hy2/<host>/client.yaml          本机客户端配置（mihomo-client 实例从这里安装）
<edge home>/state/<host>/hy2/               推送到目标机的 state：server.yaml、hy2.env、tls/server.{crt,key}
<edge home>/cache/engine/<target>/          npm 取回的引擎及解压后的本机二进制
```

客户端配置与 `hy2.json` 永远不进 bundle 或 state（测试锁定）。

目标机（edge 布局）：

```text
/opt/mx/releases/hy2/<rev>/engine/mihomo.gz   引擎（每个 release 一份，约 16 MB）
/opt/mx/releases/hy2/<rev>/bin/mihomo         deploy.sh 解压
/opt/mx/state/hy2/                            server.yaml、hy2.env、tls/、.hy2-applied
/etc/systemd/system/qp-edge-hy2.service       ExecStart=/opt/mx/current/hy2/bin/mihomo -d /opt/mx/state/hy2 -f .../server.yaml
/etc/sysctl.d/90-qp-hy2.conf                  rmem_max/wmem_max 提到 16 MiB（只升不降）
```

## 4. `hy2 up` 的步骤

1. 主机未保存：`--host` 直接保存（等同 `edge add`）；终端里没有 `--key` 时，用密码登录一次，
   把本机 edge key 放上去（等同 `edge key install`），密码只进 ssh 自己的提示符。
2. 只读探测（一次 SSH）：`uname -m`、`qp-edge-<component>.service` 状态、`current` 指向、`ss -lun`。
3. 生成/更新设置：端口默认 443，被占用依次 8443、10443、20443、30443；自己的单元占着自己的端口不算冲突；
   显式 `--port` 被别人占用则直接拒绝。本机端口默认 7891 起找空闲。
4. 计算摘要（state 文件 + 栈文件 + edge lib + 引擎 sha256）。与上次推送相同、单元 active、
   `current` 指向上次的 revision → 不推送。
5. `edge push --stack hy2`，附加 `engine/mihomo.gz`、`engine/target`、`engine/source`。
6. 本机：`mihomo-client.sh install --instance hy2-<host> --mixed-port <p> --file client.yaml --binary-path <缓存二进制>`（sudo）。
7. 检查：经本地 SOCKS5 请求目标机视角的 `127.0.0.1:<ssh 端口>`，拿到 `SSH-` 横幅即证明整条链路通；
   再经 HTTP 代理取 `http://api.ipify.org/` 显示出口地址（尽力而为，`--no-ip` 关闭）。

## 5. 红线

- **不碰 MX-H2I 与已有实例**：本机永远是命名实例；端口 7788（默认实例 / MX-H2I 出口）与
  7890（subscriptions 实例）被拒绝；实例名 `default`、`subscriptions` 被拒绝。
  安装命名实例不会改宿主代理、SSH、Docker 或 TUN（那些是 `egress-on` 等单独命令）。
- 本机端口默认只听 127.0.0.1。`--bind` 改成其他地址时只放行回环与私网来源（`lan-allowed-ips`），
  并提示该端口没有认证。
- 目标机：不开防火墙端口（只报告 ufw/firewalld 状态）；不覆盖非本工具写的 unit；
  端口被其他进程占用则停止；`mihomo -t` 不通过则不重启任何东西。
- 普通 `edge push --stack hy2` 没有引擎：本地在连接前拒绝（`STACK_BUNDLE_REQUIRED`），
  远端 preflight 在切换前再拒绝一次。

## 6. 已知行为

- **服务端重启后，客户端约 30 秒才恢复**（实测：QUIC 空闲超时，服务端重启后旧连接状态丢失）。
  因此 deploy.sh 只在引擎、server.yaml、证书或 unit 变化时重启；`hy2 push` 成功后立即重启本机实例。
  导出到其他机器的客户端会在约 30 秒内自愈。
- 服务端 `MATCH,DIRECT`：经隧道可以访问目标机自身的 127.0.0.1 服务（检查正是靠这一点）。
  只有持有密码的客户端能用；密码泄露时 `hy2 push --rotate-password`。
- 服务端 `ipv6: false`：出口地址稳定为 IPv4。
- 每个 release 带一份引擎（约 16 MB），按 edge 原则不删除旧 release；推送不频繁，可接受。
- 一台已保存主机只放一个 hy2（`--component` 固定）；同一地址要第二个，用另一个名字再 `edge add` 一次。

## 7. 验收

自动测试（`tests/hy2.test.cjs`，macOS/Linux 均可跑）：

- 生成的 `server.yaml` / `client.yaml`（含 obfs、带宽、SNI、`--bind 0.0.0.0`）被真实引擎 `-t` 接受；
- 本机端到端：生成的服务端 + `hy2 run` + `hy2 test` 拿到横幅与出口地址；停掉服务端后 `hy2 test` 失败并给出原因；
- 推送：探测到 443 被占改用 8443；bundle 有 linux 引擎和栈文件、无任何客户端密钥；state 只有服务端四个文件；
  未变化时不重推；显式占用端口被拒；不支持的架构在探测后停止；
- deploy.sh（systemctl/ss/sysctl 替身）：解压并校验引擎、写 unit、未变化不重启、变化才重启、
  他人占端口拒绝、自己占不算、坏配置不重启、错架构引擎拒绝、外来 unit 拒绝；health.sh 通过。

上线前在真实主机上还需要看一次：

```bash
qp-tunnel-cli hy2 up <host> --host <ip>        # 端到端检查应为两个 ok
qp-tunnel-cli edge status <host> --health      # hy2 healthy
qp-tunnel-cli status --instance hy2-<host>     # 本机实例 active，监听 127.0.0.1:<port>
qp-tunnel-cli status                           # 默认实例（7788）未受影响
```
