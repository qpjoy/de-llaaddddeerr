# Kubernetes 独立运行时：安装候选实例

`install-runtime` 复用已成功的预备归档，安装并启动独立 containerd，再导入 Kubernetes 镜像并核验 CRI 可见性。**这一步会写入主机配置并启动新服务，但不会切换当前业务。** kubelet 继续连接原共享运行时；不复制数据库、不修改挂载、不发布 `active.json`、不设置开机启用，也不复制 Docker 数据、卷或原共享 containerd。

目前适配已回传的 Internal：Linux、root、Python 3.6+、containerd 1.6.32、配置 v2 和预备工具支持的插件组合。沿用本机二进制，不下载或升级运行时。原 containerd 与 kubelet 必须正在运行，且仍使用原共享 socket；预备后的配置或镜像引用集合发生变化时，工具停止复核，不强行沿用旧归档。

## 本次复用的预备结果

用户已回传 `prepare-runtime` 成功摘要，以下是已生成的文件身份；**尚不表示候选实例已在服务器安装成功**。

| 项目 | 已回传结果 |
| --- | --- |
| 预备目录 | `/var/lib/mx-move/k8s-runtime-prep/mx-k8s-20261019-183524-ef985186` |
| 镜像引用数 | 172 |
| 归档大小 | 11,727,453,184 bytes |
| 归档 SHA256 | `62cf0ab4f2d96bd097316284292f7e24f81c1c2cbbdb8390767c6676f065f7cc` |

不需要重新导出，也不要删除此目录或归档；安装器会重新核验 `prepared.json`、隔离配置、归档大小/SHA256、本机平台内容及源运行时状态。

## 执行命令

先同步完整 `mx-move` 模块。以 root 在服务器的 **`electron-dock/mx-base` 目录**执行，首选此入口，避免旧父级管理脚本把子命令误认成应用名：

```bash
bash mx-move/scripts/manage.sh k8s install-runtime \
  --prepared /var/lib/mx-move/k8s-runtime-prep/mx-k8s-20261019-183524-ef985186
```

如果已经进入 **`electron-dock/mx-base/mx-move` 目录**，则使用：

```bash
bash scripts/manage.sh k8s install-runtime \
  --prepared /var/lib/mx-move/k8s-runtime-prep/mx-k8s-20261019-183524-ef985186
```

两条命令含义相同，按当前目录选择一条。不要在 `mx-base` 目录省略路径中的 `mx-move/`。

校验与导入阶段有进度提示。镜像解包会增加根卷占用并产生 I/O；导入期间持续保留至少 100 GiB，容量不足时停止本次导入客户端、保留已写内容。归档大小不等于解包大小，这个预留也不能代替完整业务迁移的数据库副本、备份和增长预算。

## 创建和验证的对象

| 对象 | 内容与边界 |
| --- | --- |
| `<预备目录>/data` | 新实例的独立数据根，0700；只导入归档中的 K8s 镜像，不复制原运行时可写层或业务数据库。 |
| `/run/mx-k8s-containerd` | 独立运行时 state，socket 为其中的 `containerd.sock`。 |
| `/etc/systemd/system/mx-k8s-containerd.service` | 新服务；执行 `daemon-reload` 和 `start`，不执行 `enable`，不停止或重启原 containerd、Docker、kubelet。 |
| `/etc/mx-k8s-runtime/environment` | 从原运行中 PID 的有效环境提取代理和证书信任项；0600，不输出其内容，并核对新 PID 实际继承值。 |
| `/etc/mx-k8s-runtime/candidate.json` | 私有候选事务记录，包含源实例身份、根卷 UUID、新根目录 device/inode 和配置/程序摘要。 |
| `/usr/local/lib/mx-k8s-runtime/candidate_guard.py` | 新服务的启动前检查；路径、权限、根目录、磁盘、校验和或 systemd unit/drop-in 状态不符即拒绝启动。 |
| `/usr/local/lib/mx-k8s-runtime/resolve.py` | 后续正式激活时供各产品调用的中性解析器。本步骤不创建 `/etc/mx-k8s-runtime/active.json`，因此普通产品发布不会开始选择候选实例。 |

候选阶段依次为 `allocating`、`starting`、`importing`、`ready`。分配未完成不能启动；后续启动仍须通过 guard。新服务和文件不是任意覆盖项：若已有未受管内容、权限不符或摘要变化，工具停止。

镜像导入显式指定候选 socket、`k8s.io`、本机平台和 `overlayfs` snapshotter；沿用 containerd 1.6.32 import 的解包流程。[官方实现](https://github.com/containerd/containerd/blob/v1.6.32/cmd/ctr/commands/images/import.go) 导入后检查镜像名称/摘要覆盖、CRI image ID/引用、`RuntimeReady` 以及候选实例没有 task、Pod sandbox 或容器；同时复核原运行时、kubelet、旧镜像集合、CRI 和代理/信任环境未改变。候选 CRI 检查**不等同于真实 Pod 启动、CNI 联网或现有用户登录验收**。

## 成功摘要与续跑

成功输出 JSON 的 `phase` 为 `candidate-ready`，并包含服务、目录、socket、镜像引用数和 CRI 镜像数，以及根卷剩余字节数、UUID、归档摘要和候选工作负载数（应为 0）。以下字段仍为 `false`：

- `kubelet_switched`
- `docker_data_moved`
- `database_data_moved`
- `active_descriptor_published`
- `cutover_supported`

只贴回终端摘要 JSON；失败时贴简短错误。不要贴 `containerd.toml`、环境文件、候选记录、证书、镜像归档或原始容器配置。

中断或失败时保留全部候选文件；原服务没有切换。新候选服务可能已启动，不能因为命令失败就把它当成不存在。修复已报告的问题后，可用**相同 `--prepared` 路径和同一条命令**续跑，工具先核对原记录、文件与源实例，再继续。已到 `ready` 的事务重新核验后跳过导入；其他可恢复阶段可能重新导入同一归档。

若已安装的 helper、unit、环境、二进制或预备内容发生变化，续跑会拒绝，不会自动覆盖或删除。保留记录并贴回简短提示；不要手工改记录、移动目录或执行旧迁移脚本来绕过校验。

## 完整业务切换仍未实现

当前已经实现候选安装、启动保护、中性解析器以及 Launcher、Hub、mx-common、Pay、Rig 的运行时调用适配；这些适配仍待正式切换后的生产验收。候选成功尚不足以安全切换 kubelet 或挂载。

完整切换执行器还需实现并验证：各数据库及私有配置备份与停写、原 `k8s.io` tasks/sandboxes 全部退出、kubelet 子挂载处理、数据复制与校验、Launcher/common/Pay 存储身份和启动保护同步，以及在允许新副本写入前持久化事务状态。之后才能切换 kubelet、挂载及 active 描述，并验收数据库身份、MX-H2I 原用户登录/联网、SSO 和 Pay。原共享 containerd 与 Docker 数据始终保留。详见[全量迁移约束](README.md)和[调用者适配状态](runtime-consumers.md)。
