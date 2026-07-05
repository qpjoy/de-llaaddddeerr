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

- fallback runtime readiness 必须同时检查 `bin/qp-tunnel-cli`、core package
  `package.json` 和 `dist/index.js`。
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

## 下一次部署检查清单

1. Domestic worker report passed 后，不立即判定完成。
2. 打开 Internal Service Peer，确认 Execution Target 是 `host-runner`。
3. 确认 `config key` 是 `config key ready`，没有 placeholder/invalid key。
4. 确认 `wg runtime`、`core wg`、`core wg-quick` 可用。
5. 点击 `Install / Restart`，再 `Refresh Status`。
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
