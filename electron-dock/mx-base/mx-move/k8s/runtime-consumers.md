# 独立 Kubernetes containerd 的调用者兼容审计

审计日期：2026-10-20。**以下是待实现的切换前要求，不表示应用调用者已经适配。** `prepare-runtime` 只准备隔离配置、校验回执和 Kubernetes 镜像归档，不安装或启动服务，不修改 kubelet endpoint，也不完成本页的兼容改造。

目标是仅迁移 Kubernetes：Docker 数据、卷及原共享 containerd 保持原位。新 K8s 实例使用独立 root、state、socket、配置和 systemd service。仅把镜像导入新实例仍不足以完成迁移；后续普通发布、诊断、恢复必须继续连接 kubelet 实际使用的实例。

## 必须修改的入口

下表路径相对仓库的 `electron-dock/`；行号为审计时位置，函数名是后续定位依据。

| 产品 / 入口 | 文件与行号 | 当前行为与最小改造 |
| --- | --- | --- |
| Launcher 地址发现 | `mx-launcher/scripts/k8s-production-recovery.sh:32`，`k8s_resolve_containerd_address` | 已支持 `MX_K8S_CONTAINERD_ADDRESS` 与发现值一致性检查，但只由生产 `deploy/cycle` 的准备过程调用（`manage.sh:6076`）。提取无恢复副作用的地址发现，覆盖所有 K8s wrapper。 |
| Launcher 镜像操作 | `mx-launcher/scripts/k8s-production-recovery.sh:74`，`k8s_ctr` | 默认旧 socket。`manage.sh:1393/:1418/:1467` 的导入、缓存检查和打标都经过此处。统一显式传递经验证的 K8s 地址。 |
| Launcher CRI 操作 | `mx-launcher/scripts/manage.sh:225`，`k8s_crictl` | 默认旧 socket，找不到 socket 时裸调用 crictl。影响 `:702/:718/:734/:741` 的静态 Pod 日志、诊断和停启。迁移节点必须显式设置 runtime/image endpoint，不能静默回退。 |
| Launcher 服务恢复 | `mx-launcher/scripts/k8s-production-recovery.sh:21` | 固定启动 `containerd kubelet docker`，不能启动新的 K8s runtime service。应先取得目标服务身份；Docker 启动仍是构建需要，与 K8s runtime 分开。 |
| Launcher CNI 修复 | `mx-launcher/scripts/manage.sh:5983`，`ops_internal_production_repair_cni` | `:5998` 固定重启旧 containerd；`:6003/:6016` 裸调用 crictl。迁移后会干扰 Docker 且未重启目标 K8s runtime。改用目标服务和 endpoint，核对对应 CNI 路径。 |
| Launcher 磁盘检查 | `mx-launcher/scripts/k8s-production-recovery.sh:94/:108/:113` | 固定检查 `/var/lib/containerd`，迁移后检查的是旧实例磁盘。改为目标 K8s runtime root。 |
| Hub 镜像操作 | `mx-insight-hub/scripts/manage.sh:360`，`run_ctr` | `:1693/:1707` 的缓存查询、镜像导入集中经过此处；只需在 wrapper 内明确选择目标 endpoint，无须扩大 Hub 修改范围。 |
| common 镜像操作 | `mx-common/scripts/manage.sh:1405/:1407`、`:1476/:1481`、`:1663/:1667` | root/sudo 分支直接调用默认 ctr，覆盖数据库镜像和 HanLP。抽取统一 K8s wrapper 后替换这些调用。 |
| common 容量检查 | `mx-common/scripts/manage.sh:1739` | 已有 `MX_COMMON_CONTAINERD_ROOT`，仅用于容量检查。需与 endpoint 来自同一实例，不能只修改 root。 |
| Rig 镜像导入 | `mx-rig/scripts/manage.sh:481`，`run_ctr` | `:506/:512/:513` 的可达性、导入和验证使用旧地址。调整集中 wrapper。 |
| Rig PostgreSQL 预取 | `mx-rig/scripts/build-proxy.sh:127`，`rig_proxy_postgres_image` | `:132/:135` 的 `k8s.io` 缓存查询与拉取必须使用新实例；不能把整个 proxy ctr 函数无差别切换。 |
| Pay 节点镜像交付 | `mx-base/mx-pay/scripts/runtime.mjs:210`，`ctrCommand` / `ctrScript` | `imagePlan` 的 `:221`、`importImage` 的 `:238/:241` 覆盖本地和 SSH 目标节点。应在每个目标节点解析 endpoint，不能把部署发起机的地址传给所有节点。保留普通 k3s 节点分支。 |
| Pay PostgreSQL 预取 | `mx-base/mx-pay/scripts/build-proxy.sh:97`，`pay_proxy_postgres_image` | `:103/:106` 的缓存查询与 `k8s.io` 拉取改用新实例。 |
| Launcher kubeadm 恢复 | `mx-launcher/scripts/install-k8s-centos.sh:13`、`:593/:639/:788` | 已有 `CRI_SOCKET`，默认旧地址。`manage.sh:5975` 的 reinit 调用未传实际地址，迁移后可能把 kubelet 指回旧实例。必须使用受验证的目标 socket。 |
| Launcher runtime 重配 | `mx-launcher/scripts/install-k8s-centos.sh:361`，`configure_containerd`；`:925`，`restart_runtime_after_cni` | 固定写旧 `/etc/containerd/config.toml`、重启旧服务。生产 reinit 默认禁用这两项，但新安装/显式开启仍需防护：迁移节点拒绝默认重配，或显式选择已验证的新实例。 |

上述默认 ctr 调用可能在旧 `k8s.io` 中“导入成功、检查也成功”，而新 kubelet 仍看不到镜像。因此不能把命令退出码或旧实例的镜像列表当作迁移验收。

次要诊断也应随后修正：`mx-launcher/scripts/k8s-control-plane.sh:70/:79` 固定检查旧服务并提示裸 crictl；`mx-launcher/scripts/k8s-database-inventory.mjs:207` 只有旧 runtime 路径候选。旧 `mx-launcher/scripts/k8s.migrate.sh` 整体搬动共享 containerd，不适用于本次迁移。

## 现有 Launcher 解析的陷阱

可复用“显式覆盖值必须与 kubelet 实际 CRI 一致”的原则，但不应直接 source 整个生产恢复模块。

- 当前先读 `/var/lib/kubelet/config.yaml`，再读 `instance-config.yaml`，后者会覆盖前者；instance-config 是 kubeadm 实例信息，不能无条件压过 kubelet 实际配置。
- 当前读取固定 config 路径，未跟随运行进程的 `--config`。应先读取运行 kubelet 的完整参数，CLI `--container-runtime-endpoint` 优先，再读取其实际配置文件。
- 当前用 `pgrep -xo kubelet` 选进程。应核对预期 systemd unit 的 MainPID、进程身份与配置，避免多个 kubelet 时选错。
- socket 存在且 `ctr version` 成功，只证明某个 containerd 可达；还需要 kubelet endpoint 一致性和显式 CRI 查询。用于停启的 service、用于容量检查的 root 也必须与同一实例绑定。
- kubelet 停止时不应猜测新旧实例。使用受保护的迁移回执及配置验证；信息冲突即停止依赖操作，不能回退旧共享 socket。

## 建议的中性主机描述协议（尚未实现）

由 mx-move 在正式切换事务中原子发布 root-owned 描述文件和只读 helper；具体路径在实现时固定，不要求 Pay 或其他产品依赖 Launcher。`prepare-runtime` 的候选配置不是生效描述。

描述至少包含 schema 版本、阶段（prepared / active）、节点与集群身份、K8s runtime address/root/state/systemd service、有效配置摘要及迁移回执标识。仅正式切换并验证完成的 active 描述可供普通应用使用。文件及父目录不得由普通用户写入，作为数据解析，不通过 `source` 执行。

应用仍保留现有业务 wrapper，只把 K8s runtime 选择委托给中性 helper：

1. 有 active 描述时，验证描述、目标配置、运行 kubelet endpoint 一致；显式传入 `ctr --address ... -n k8s.io` 或 crictl 两个 endpoint。
2. 显式 `MX_K8S_CONTAINERD_ADDRESS` 不能绕过一致性检查。服务和 root 必须来自同一描述，不能各自独立猜测。
3. 描述存在但不完整、不一致、socket 不可用或 helper 缺失时，迁移节点失败退出，不回退旧实例。
4. 未迁移节点维持现有环境适配，包括 k3s；Pay 通过 SSH 在目标节点执行发现和检查。
5. 不在全局 PATH 放置 ctr 替身，不更改全局 containerd 默认 socket；避免把 Docker 的工具调用一并重定向。

## Docker BuildKit 必须继续使用旧实例

以下调用先在独立 namespace 拉镜像，再 `docker load`，属于 Docker 构建流程：

| 入口 | 保留的 namespace |
| --- | --- |
| `mx-launcher/scripts/launcher-build-proxy.sh:72/:79/:81` | `mx-launcher-build-proxy` |
| `mx-base/mx-pay/scripts/build-proxy.sh:46/:47` | `mx-pay-build-proxy` |
| `mx-rig/scripts/build-proxy.sh:81/:82` | `mx-rig-build-proxy` |

Pay/Rig 的 proxy ctr 通用函数同时服务 Docker bootstrap 和 K8s PostgreSQL，需按用途选择实例；不能全局追加新 K8s 地址。Docker root、卷和既有 namespace 均不搬迁。

`mx-launcher/scripts/k8s-recovery-state.mjs:54` 对旧 `/var/lib/containerd` 的身份记录继续保留，因为旧实例确实不动。新 K8s runtime 增加独立身份记录；不得把旧记录无条件替换为新路径而掩盖 Docker 存储变化。

## 正式切换前后的验收要求

- 自动化覆盖默认节点、新独立 socket、CLI/config 冲突、kubelet 停止、描述损坏、sudo 参数传递、Pay 远端节点解析及 k3s 兼容。
- 用各产品的普通发布入口验证镜像交付；在新实例导入后，通过 kubelet 对应 CRI 验证镜像并确认 Pod 实际启动。仅查 ctr 列表不算通过。
- 镜像导入后的镜像 GC / 磁盘检查指向新 root；旧共享 runtime 的 namespace 与 Docker 卷保持不变。
- `repair-cni` 的测试应证明只选择新 K8s service 与 endpoint，不重启旧 containerd 或 Docker；验证后节点和网络恢复 Ready。
- 保留并核对 Launcher、common、Pay、Rig 的数据库身份、PV/PVC UID、Secret 和用户凭据；完成 MX-H2I 原用户登录与联网回归。
- 这些兼容改造和验收完成前，不能把“prepare-runtime 成功”视为允许执行完整切换。
