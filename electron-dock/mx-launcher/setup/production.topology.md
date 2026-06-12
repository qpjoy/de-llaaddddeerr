# MX Launcher Production Topology

## Shadow 和生产的边界

`internal-shadow` 是本机或预生产验证环境，用来跑 K8s rollout、HTTP smoke、DB summary、
Internal Shadow Gate、浏览器手测和 Evidence Drawer 验证。它验证的是同一套 Internal 动作模型，
但不代表最终站点形态。

正式交付按生产拓扑建模：

- 1 个 Internal 控制面，是 User Center、RBAC、Config Center、DNS、Release、Runner、
  Observability、Test Center 和 Admin 的唯一真相。
- 默认 1 台 Domestic，站点名建议 `domestic-main`，承担公网入口、WG relay、H2I proxy、
  Internal DNS 转发、snapshot cache 和 observability forwarder。
- 多台 Oversea，站点名建议 `oversea-<region>-<n>`，例如 `oversea-sg-1`、
  `oversea-jp-1`。每台 Oversea 独立部署 hysteria2 access stack 和 site-agent。

## 默认网络段

新版本不继续使用旧 HDO v1 的 `100.88.*`、`100.89.*`、`100.90.*`、`100.91.*`。

- `10.88.*`：Domestic relay / H2I 网段，默认 Domestic IP 是 `10.88.0.1`。
- `10.89.*`：登录后的设备/用户网段。
- `10.90.*`：预留给 Internal 服务和受控系统互联。
- `10.91.*`：匿名网络默认分配，类似旧版 `100.91.*`。

DNS 仍由 Internal CoreDNS authority 管理。H 端命中 Internal 白名单的域名走 Internal DNS；
未命中部分保持 `cn-direct`，外网走订阅/mihomo 策略。

## 数据面访问路径

H 端不直接控制系统网络，也不直接写 Internal 主数据。

1. H 端通过 Domestic WG relay 进入 H2I。
2. H 端通过 H2I 访问 Internal DNS、Internal API、配置快照和 mihomo 订阅。
3. Internal 生成并存储订阅、账号、release/evidence 和 DNS/config snapshot。
4. H 端拿到订阅后，可以直连多台 Oversea 的 hysteria2 服务。
5. Domestic 只做 relay/proxy/cache/forwarder，不成为用户、权限、配置或订阅真相源。

在 Domestic/WG/H2I 未完成前，Oversea 部署完成也只是 Internal 层面的对外输出：
Internal 能生成账号和订阅，H 端还不能稳定从公网拿到 Internal DNS/mihomo 订阅。

## Oversea 交付路径

Oversea 是多实例 slot。后台应以站点为主入口，而不是以历史 pipeline 为主入口。

每台空 Ubuntu 的推荐流程：

1. 在 Admin 的 Oversea 模块创建或选择 `oversea-<region>-<n>`。
2. 输入 host、user、port 和一次性密码；Identity、Known Hosts、Host Alias 默认由 Internal 生成。
3. 开启 `ssh-bootstrap` 闸门后执行 Bootstrap Key。
4. Internal 在持久化 SSH 目录生成私钥和 known_hosts，并把公钥写入远端
   `~/.ssh/authorized_keys`。
5. 关闭 `ssh-bootstrap` 闸门。
6. 开启 `readonly-probe` 闸门，执行只读 Probe：`whoami`、`hostname`、`pwd`、`df -h /`、
   `docker version`。
7. 只读 Probe 通过后，进入 plan-only、artifact push dry-run、remote worker handoff。
8. 最后才允许真正安装 Docker、hysteria2、site-agent，并回传 worker report/evidence。

Oversea 不需要加入 Domestic WG relay 才能给 H 端提供 hysteria2 出口。Oversea 加入控制网络的好处
是 site-agent 可以更稳定地回连 Internal、上报健康和拉取配置；但 H 端最终访问 Oversea hysteria2
仍然是直连公网入口。

## Domestic 交付路径

Domestic 当前默认只需要 1 台，站点名建议 `domestic-main`。

1. 先完成 Internal 生产控制面。
2. 部署 Domestic WG relay、H2I proxy、Internal DNS 转发、snapshot cache 和 observability
   forwarder。
3. Domestic 默认 IP 固定为 `10.88.0.1`。
4. H 端登录后进入 `10.89.*`，匿名态使用 `10.91.*`。
5. Domestic 不保存主配置，只缓存 Internal 签名快照。

后续如需要多 Domestic，应作为高可用/区域扩展能力单独设计，不改变当前默认一台 Domestic 的产品假设。

## 持久化和安全要求

生产和 shadow 都不能依赖 Pod 临时文件保存 SSH key。

- SSH 私钥和 known_hosts 要放在 K8s Secret 或受控 PVC 中。
- 当前本机 K8s shadow 使用 `/app/artifacts/ssh` PVC 验证这条路径。
- SSH Profile 只保存路径、host、user、port、strict、batch、timeout、hostAlias 等元数据。
- 一次性密码只用于 Bootstrap Key，不应作为长期登录凭据保存。
- Rotate 不会自动修改云厂商/root 随机密码；它只表示 Internal 生成/替换自己管理的 SSH key。

## 本机 shadow 对应命令

```bash
bash scripts/manage.sh ops k8s-shadow cycle
bash scripts/manage.sh ops k8s-shadow ssh-bootstrap enable
bash scripts/manage.sh ops k8s-shadow readonly-probe enable
bash scripts/manage.sh ops k8s-shadow remote-runner enable
```

Bootstrap Key 成功后建议关闭一次性密码闸门：

```bash
bash scripts/manage.sh ops k8s-shadow ssh-bootstrap disable
```

真机只读 Probe 或远程 worker 测试结束后，再关闭执行闸门：

```bash
bash scripts/manage.sh ops k8s-shadow readonly-probe disable
bash scripts/manage.sh ops k8s-shadow remote-runner disable
```
