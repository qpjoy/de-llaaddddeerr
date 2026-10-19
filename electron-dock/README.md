# MX 项目统一管理入口

`scripts/manage.sh` 在目标服务器上调用各项目已有部署脚本，统一项目选择、构建代理、只读检查、部署互斥和退出结果。当前支持已有 Internal 环境的逐项目发布；各项目继续负责自己的数据库迁移、凭据保留和就绪检查。原来的项目命令保持可用。本轮没有执行生产部署。

需要 Bash、Python 3.6+，以及各项目原来要求的 Docker、kubectl、Node 等工具；生产发布仍在原 Linux 部署主机执行。总入口不会安装或重启 Docker、Kubernetes，也不提供全量 `deploy`、通用 `restart`、备份恢复或自动回滚。Launcher 原部署流程已有的恢复动作仍然保留。

## 常用命令

以下命令均在服务器的 `electron-dock` 目录执行：

```bash
bash scripts/manage.sh list
bash scripts/manage.sh plan mx-launcher
bash scripts/manage.sh status
bash scripts/manage.sh doctor
bash scripts/manage.sh status mx-insight-hub
bash scripts/manage.sh doctor mx-pay
bash scripts/manage.sh etcd status
```

`plan` 离线显示将调用的子命令、入口覆盖参数和已知影响，不读取项目 `.env`，不验证线上配置，也不会执行子项目的 plan/deploy。

用户现有的五条部署命令可简化为：

```bash
PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy mx-launcher
PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy mx-insight-hub
PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy mx-dataport
PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy mx-device
PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy mx-pay
```

Device、Pay 若继续使用原来的 7789 代理，分别执行：

```bash
PROXY=127.0.0.1:7789 bash scripts/manage.sh deploy mx-device
PROXY=127.0.0.1:7789 bash scripts/manage.sh deploy mx-pay
```

同样支持 Rig：

```bash
PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy mx-rig
```

短名 `launcher`、`hub`、`dataport`、`device`、`pay`、`rig`、`common` 与完整项目名等价。每次只选择一个发布项目。

## 代理与部署参数

`PROXY` 支持 `127.0.0.1:7788` 或 `http://127.0.0.1:7788`，也支持带端口的 HTTPS 代理地址。`*` 只是主机占位，不能原样写成 `PROXY=*:7788`；`0.0.0.0`、`::` 是监听地址，也不能作为连接目标。本机代理使用 `127.0.0.1`，其他代理使用实际可访问的 IP 或域名。

| 项目 | 转交的原代理变量 | 原部署入口 |
| --- | --- | --- |
| mx-launcher | `MX_LAUNCHER_BUILD_PROXY` | `ops internal-production deploy` |
| mx-insight-hub | `MX_INSIGHT_BUILD_PROXY` | `ops internal-production deploy` |
| mx-dataport | `MX_HARBOR_BUILD_PROXY` | `ops internal-production deploy` |
| mx-device | `MX_DEVICE_BUILD_PROXY` | `deploy` |
| mx-pay | `MX_PAY_BUILD_PROXY` | `deploy` |
| mx-rig | `MX_RIG_BUILD_PROXY` | `deploy` |

- 显式 `PROXY` 优先于原项目代理变量，实际构建仍由各项目的代理实现负责。
- 未设置 `PROXY` 时，保留原项目环境变量和配置文件规则，不强制选 7788 或 7789。
- `PROXY=''` 清空本次专用构建代理；DataPort 的 Hub 代理回退变量也同时清空。它不会清除 Docker daemon、Docker 客户端配置或已有 `HTTP_PROXY` 等全局代理。
- 代理仅交给构建／下载流程。总入口不更改系统代理、运行中服务的出网配置或 MX-H2I 用户代理、登录与联网配置。

Launcher 默认带上用户当前服务器的以下参数；环境中**已经设置**的同名变量优先，不会被默认值覆盖。发布其他主机前应显式设置实际目标，先用 `plan` 查看：

```bash
TMPDIR=/data/tmp
MX_K8S_OS_HOSTNAME=mx-internal-server
MX_K8S_APISERVER_ADVERTISE_ADDRESS=192.168.1.2
MX_SHADOW_BUILDKIT_KEEP_STORAGE=2GB
MX_SHADOW_BUILDKIT_PRUNE_UNTIL=24h
```

Device 和 Pay 同样默认 `TMPDIR=/data/tmp`；其他项目保留原临时目录规则。总入口不创建 `/data/tmp`，部署主机需已有可写目录。

Hub 总入口强制 `MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0`；如果调用环境显式给出非 `0` 值，则停止。这样不会通过 Hub 命令联动发布 Launcher 或执行测试数据探测；Hub 原流程对 mx-common 的调用仍保留。

## 范围与检查含义

| 项目 | 当前支持与部署影响 |
| --- | --- |
| Launcher | 发布原 Internal 栈；涉及登录／网络相关组件，原地址恢复与身份保护保留，地址变化可能触发控制面修复 |
| Hub | 迁移及发布 Hub；原流程会 ensure mx-common，模板变化可能更新共享 PostgreSQL／ES |
| DataPort | 迁移及单副本 Recreate 发布，可能短暂不可用；不执行 enroll |
| Device | Compose 发布，排空自身 Worker 后更新 API／Worker；已有 PostgreSQL 使用 `--no-recreate` |
| Pay | 原迁移及 API／console 发布流程，保留已有 PostgreSQL；原 checkout 暂停／恢复行为保留 |
| Rig | Kubernetes 发布；PG 模板变化可能滚动重建数据库 Pod，需按 Rig 文档备份并安排维护窗口 |
| mx-common | 仅 `status`／`doctor`；不提供独立 deploy/ensure |
| etcd | 仅将 `etcd status` 转交 mx-move；迁移／回滚仍使用专用工具 |

`status` 和 `doctor` 的 Kubernetes 查询使用当前 `KUBECONFIG`／context；若未设置 `KUBECONFIG` 且本机存在 `/etc/kubernetes/admin.conf`，入口使用该文件。它们不读取各项目 `.env` 或保留的目标文件，也不调用 Launcher 可能修复 endpoint 的 status。Pay 在此按 Kubernetes 项目查询；Device 调用原 Compose status。

这些结果只反映**当前选择的集群**，不能证明它就是各产品保留配置中的目标，也不代表业务登录、联网、支付或数据请求验收通过。`doctor` 另外检查 API readyz（包含 etcd 就绪）、节点 Ready／压力条件，并显示 `/`、`/data`、`/var/lib/etcd` 中实际存在路径的空间；它不会做磁盘延迟测试或自动清理。查询失败显示 `UNKNOWN` 并返回非零。

Kubernetes 项目 deploy 前会检查当前集群 API／节点状态，随后子项目仍按自己的目标与身份规则执行；总入口尚未实现统一安装清单和跨项目目标绑定。

## 锁与结果记录

部署状态默认保存到当前用户的 `~/.local/state/mx-electron-dock`，可以用 `MX_MANAGE_STATE_DIR` 指定其他目录。目录须由当前用户持有、权限为 `0700`，不能是符号链接。每次部署保存私有 JSON，包含项目、阶段、时间、耗时与子命令退出码。执行时保留原脚本输出，每 15 秒补充仍在执行及累计耗时，不估算虚假的完成百分比。

部署互斥锁只保护**同一主机、同一用户、使用同一状态目录的总入口调用**；另一个部署不会排队，直接停止。使用不同状态目录、不同用户、其他主机或直接运行旧项目入口可绕过此锁；各项目原锁继续生效。不能据此宣称集群级统一锁。

记录中的 `child_succeeded` 表示原项目子命令退出码为 0，不是新增的跨项目验收证明。失败或中断后保留记录，由各产品原运维流程排查；总入口不会自动重试、恢复数据库或回滚。突然断电／强制终止留下的 `running` 记录也不能证明远端任务已经结束。

完整安装清单、锁定版本、多机部署和换机恢复仍属于[后续设计](mx-launcher/docs/34-platform-deploy-and-recovery-contract.md)，不属于这个薄入口的已实现能力。
