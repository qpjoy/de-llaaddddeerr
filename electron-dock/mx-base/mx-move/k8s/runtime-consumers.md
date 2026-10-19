# 独立 Kubernetes containerd 的调用者适配

更新日期：2026-10-20。**中性解析器、下表产品 wrapper 和正式切换事务已实现，尚未进行业务切换后的生产验收。** `install-runtime` 已回传候选成功，但不发布 active 描述、不切换 kubelet；因此这些适配不会把当前普通发布提前导向候选实例。后续 `migrate` 在持久提交之后才正式激活；执行步骤见[正式切换说明](cutover.md)。

目标仍是仅迁 Kubernetes：Docker 数据、卷与原共享 containerd 保留原位。曾经存在的默认 socket 调用会使“镜像导入旧 `k8s.io` 并验证成功，但新 kubelet 看不到镜像”；适配为各入口显式使用经过验证的 K8s endpoint。

## 已实现的入口

下表路径相对仓库的 `electron-dock/`；用函数名定位，避免后续增行导致历史行号失效。

| 产品 | 文件 / 入口 | 已实现行为 |
| --- | --- | --- |
| Launcher 镜像与 CRI | `mx-launcher/scripts/k8s-production-recovery.sh` 的 `k8s_containerd_address`、`k8s_ctr`；`manage.sh` 的 `k8s_crictl` | 每次 managed 调用解析并显式指定 K8s 地址；`MX_K8S_CONTAINERD_ADDRESS` 与描述不一致即拒绝。镜像导入、缓存检查、静态 Pod 日志/诊断/停启使用同一入口。 |
| Launcher 服务与容量 | `k8s-production-recovery.sh` 的 `k8s_containerd_service`、`k8s_containerd_root`、`k8s_prepare_production_host`、`k8s_production_disk_preflight` | 启动所选 K8s 服务后恢复 kubelet；容量检查使用该实例 root。构建需要时仍可启动原 Docker，但不把其服务作为 K8s runtime 重启。 |
| Launcher CNI 修复 | `mx-launcher/scripts/manage.sh` 的 `ops_internal_production_repair_cni` | 重启所选 K8s runtime 和 kubelet，通过匹配的 CRI 检查；managed 场景不重启旧 containerd/Docker。 |
| Launcher kubeadm 恢复 | `manage.sh` 的 `ops_internal_production_reinit_kubeadm`；`install-k8s-centos.sh` 的 `configure_runtime_selection`、`configure_containerd`、`restart_runtime_after_cni` | reinit 显式传入受验证的 CRI_SOCKET；无法验证运行实例时停止。安装器在主机改动前拒绝 managed 节点默认重写 Docker containerd；CNI reload 使用所选服务。这不是本次迁移命令，不应通过 reinit 迁移。 |
| Hub | `mx-insight-hub/scripts/manage.sh` 的 `run_ctr` | 缓存查询、镜像导入统一传入 managed endpoint；无标记时保留旧节点行为。 |
| common | `mx-common/scripts/manage.sh` 的 `common_ctr`、`common_containerd_root` | 数据库与 HanLP 镜像查询/导入采用统一地址；容量检查取同一实例 root，拒绝冲突的 `MX_COMMON_CONTAINERD_ROOT`。 |
| Rig | `mx-rig/scripts/manage.sh` 的 `run_ctr`；`build-proxy.sh` 的 `rig_proxy_namespace_ctr`、`rig_proxy_postgres_image` | 服务器镜像导入及 PostgreSQL 的 `k8s.io` 预取选择 K8s 实例；Docker BuildKit namespace 保持旧实例。 |
| Pay | `mx-base/mx-pay/scripts/runtime.mjs` 的 `ctrCommand` / `ctrScript`；`build-proxy.sh` 的 `pay_proxy_namespace_ctr`、`pay_proxy_postgres_image` | 本地与 SSH 交付在目标节点解析地址，避免把部署发起机的 socket 传给其他节点；未迁移节点保留 k3s 适配。PostgreSQL 预取和 Docker bootstrap 按用途分开。 |

没有修改登录、SSO、数据库用户或网络配置来实现这些选择。离线回归覆盖 managed/未迁移节点、缺失或无效解析结果、sudo/远端交付和 Docker bootstrap 分流；这些测试不能代替生产 Pod、CNI 和用户功能验收。

## 中性主机描述协议

正式激活标记固定为 `/etc/mx-k8s-runtime/active.json`，解析器固定为 `/usr/local/lib/mx-k8s-runtime/resolve.py`，由 `python3` 调用。标记存在或是悬空符号链接时，都进入 managed 分支；描述无效、helper 缺失或检查失败时不得回退旧共享 socket。Pay 不依赖 Launcher 源码或 mx-move 仓库位置。

当前描述 schema 版本为 1，phase 必须为 `active`，字段包括 hostname、根文件系统 UUID、address/root/state/service、config_path/config_sha256、kubelet_config_path。它不含凭据；描述须为 root 所有的 0644 普通文件，目标 TOML 为私有 0600，祖先路径受保护。工具把文件作为数据解析，不 `source` 执行。**候选 `candidate.json` 与 prepared 回执不等于 active 描述；只有正式切换事务提交后才发布 active.json，不能手工伪造来提前激活。**

解析器提供 `address`、`root`、`service`、`cri-endpoint` 四个字段；返回前核对描述、配置摘要和有效路径、根卷身份、服务进程/参数，以及 kubelet 实际使用的 socket。地址不是仅凭“文件存在”或 `ctr version` 成功就被采纳。

`--allow-stopped-kubelet` 仅用于 `service` / `root` 的启动恢复。停止的服务仍须满足配置与身份约束，运行中的进程仍需核验；它不允许跳过 endpoint 核验取得 address，也不允许旧实例回退。没有标记时保留各产品原有环境适配，不安装全局 ctr 替身，不改变 Docker 默认 socket。

Launcher 停止服务后的恢复若带有显式 `MX_K8S_CONTAINERD_ADDRESS`，会提示先 `unset MX_K8S_CONTAINERD_ADDRESS`，再由受保护描述选择实例。普通在线调用仍核对显式值与已验证地址一致。

## Launcher 旧解析问题的处理

未迁移节点的发现顺序现为：运行 kubelet 的 `--container-runtime-endpoint`，其次其实际 `--config` 文件，最后才是 kubeadm `instance-config.yaml` 的回退。后者不再覆盖已发现的 kubelet 配置。优先读取 systemd MainPID；保留旧节点所需的进程发现回退。

managed 节点使用中性解析器核对 systemd 服务、进程和 socket 身份，不依赖上述固定路径猜测。配置/CLI 冲突、描述异常或缺盘不能用默认 socket 掩盖。辅助的历史数据库目录探测等入口不属于切换依据，实际迁移仍以本机盘点和事务记录为准。

## Docker BuildKit 保留旧实例

以下拉取后 `docker load` 的构建流程继续使用旧运行时：

| 文件 / 函数 | namespace |
| --- | --- |
| `mx-launcher/scripts/launcher-build-proxy.sh` 的 bootstrap 拉取/导出 | `mx-launcher-build-proxy` |
| `mx-base/mx-pay/scripts/build-proxy.sh` 的 `pay_proxy_bootstrap_image` | `mx-pay-build-proxy` |
| `mx-rig/scripts/build-proxy.sh` 的 `rig_proxy_bootstrap_image` | `mx-rig-build-proxy` |

Pay/Rig 仅把 `k8s.io` 调用导向 managed 实例。Docker root、卷和原 namespace 都不搬迁；不能对整个 proxy ctr 函数或全局 PATH 无差别替换地址。

Launcher `k8s-recovery-state.mjs` 对旧 `/var/lib/containerd` 的身份记录继续保留，因为旧实例确实不动。新 K8s runtime 使用独立记录；不能通过删除旧身份文件或停用保护绕过检查。旧 `mx-launcher/scripts/k8s.migrate.sh` 会整体移动共享 containerd，不适用于本次迁移。

## 切换后的验收仍待完成

- 各产品普通发布应在新实例导入镜像，并通过 kubelet 对应 CRI 核对 image ID/引用及实际 Pod 启动；仅查 ctr 名称列表不算通过。
- 检查容量/镜像 GC 使用新 root，同时旧共享 runtime 的 namespace、Docker 容器和卷保持原身份。
- 在维护范围内验收 `repair-cni` 的服务选择、节点 Ready、DNS 和联网；离线“不重启旧服务”断言不能替代现场验证。
- 正式切换事务必须通过各数据库停写、etcd/ES 快照和私有备份、原 `k8s.io` tasks/sandboxes 归零、kubelet 子挂载处理、冷副本校验、Launcher/common/Pay 身份与启动保护同步，以及允许新副本写入前的持久记录。
- 切换后核对数据库 system ID、PV/PVC UID、Secret 和用户凭据连续性，并实测 MX-H2I 原用户登录、联网、SSO 与 Pay。不得以候选 `candidate-ready` 替代这些结果。

候选安装已经成功，本现场下一步是[正式切换预检](cutover.md)，维护窗口再执行 `migrate`；业务迁移、真实用户验收、最新数据回迁及灾难恢复并未因候选成功自动完成。
