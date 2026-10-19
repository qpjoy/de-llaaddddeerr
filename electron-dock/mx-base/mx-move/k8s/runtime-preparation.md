# Kubernetes 独立运行时：离线预备

这一步准备后续切换需要的私有配置与镜像文件，**不会完成业务数据迁移**。它不安装 systemd 服务，不启动第二个 containerd，不更改 kubelet endpoint，不停止容器，也不移动 Docker 卷或共享 containerd 目录。

当前实现针对已回传的 Internal：Linux、root、Python 3.6+、containerd 1.6.32、配置 v2、overlayfs、单一 runc v2 handler、SystemdCgroup=true。沿用当前二进制，不下载或升级组件。其他版本、未知插件、外置运行时写入目录或未核验的监听配置会停止预备，输出脱敏错误。

## 本次预备已成功

用户已回传 `phase=artifacts-prepared`：目录 `/var/lib/mx-move/k8s-runtime-prep/mx-k8s-20261019-183524-ef985186`，172 个镜像引用，归档 11,727,453,184 bytes，SHA256 `62cf0ab4f2d96bd097316284292f7e24f81c1c2cbbdb8390767c6676f065f7cc`。随后候选安装也已回传 `candidate-ready`，71 个 CRI 镜像、工作负载 0。保留目录与归档，无需重复导出或导入；本现场下一步是[正式切换预检](cutover.md)。

## 执行

以下保留尚未完成预备时的命令，本现场不必重跑。同步整个 `mx-move` 模块，保留目录结构。以 root 在服务器的 **`electron-dock/mx-base`** 目录执行：

```bash
bash mx-move/scripts/manage.sh k8s prepare-runtime
```

如果已进入 `electron-dock/mx-base/mx-move`，命令为：

```bash
bash scripts/manage.sh k8s prepare-runtime
```

导出和校验会读取镜像内容并写入根卷，耗时取决于缓存大小及磁盘速度；不会重新扫描数据库。长阶段每 15 秒输出进度。导出期间持续检查根卷空间，至少保留 100 GiB；这不包含后续数据库副本、解包后的运行时和备份预算，不能据此宣布全量容量验收通过。

成功后输出简短 JSON：`phase=artifacts-prepared`、私有目录、镜像数量、归档字节数/SHA256 和隔离摘要。**只贴回终端 JSON 和简短错误即可**；不要贴目录里的 TOML、归档或任何凭据。无需再运行全量 `plan --measure`。

## 写入内容和验证

默认在 `/var/lib/mx-move/k8s-runtime-prep/` 下创建独立随机目录，不覆盖历史预备。目录为 0700，文件为 0600；仅接受 root 所有且其他用户不可写的父路径，并核对它位于根文件系统。

| 文件 | 用途 |
| --- | --- |
| `containerd.toml` | 从当前合并配置生成的隔离配置；可能含原有 registry 凭据，仅保存在服务器私有目录。 |
| `images.json` | 当前旧实例 `k8s.io` 的镜像引用和摘要。 |
| `intent.json` | 原运行时/目标文件系统身份、配置摘要与本次预备范围。 |
| `k8s-images.tar` | 通过镜像 API 导出的本机平台 OCI 归档。只选择 `k8s.io`；不复制 `moby` 或构建 namespace，也不复制容器可写层。 |
| `prepared.json` | 所有本次预备检查通过后才写入的回执。 |

配置生成会清空 `imports`，隔离 root/state/gRPC/ttrpc/temp/opt/runc Root，关闭 gRPC TCP/debug/metrics 监听，CRI streaming 使用 loopback 动态端口，保留 registry 和 CNI 配置。随后使用当前运行中 containerd 的同一二进制重新加载配置，核对隔离摘要。**这一验证只加载配置，不启动 daemon。**

containerd 1.6 的 `config dump` 会把主配置本身列入 Imports；因此原文件 `imports=[]`、dump 报 present 可以同时成立。若直接复制 dump 而不清空该字段，新实例可能重新导入旧配置，覆盖隔离路径。[官方 LoadConfig 实现](https://github.com/containerd/containerd/blob/release/1.6/services/server/config/config.go)

镜像导出固定旧 socket 和 `k8s.io`，指定本机平台，生成 OCI 归档。检查包括选定摘要覆盖、blob SHA256、本机平台可达 manifest/config/layers，以及落盘后整体 SHA256；完成后再次核对源运行时和镜像集合。它仍标记 `import_verified=false`：`install-runtime` 负责后续导入、新 daemon 启动和 CRI image ID/引用覆盖验证；真实 Pod 启动与业务联网仍须在正式切换后验收。[官方 export 命令](https://github.com/containerd/containerd/blob/v1.6.32/cmd/ctr/commands/images/export.go)

## 中断与后续

失败或 Ctrl-C 保留本次私有文件，不生成成功回执，也不影响原容器；重跑会创建另一个目录。当前不自动删除旧的或不完整归档，重跑前需注意这些文件占用的根卷空间。工具不提供强行忽略校验失败的参数。

`artifacts-prepared` 不代表可以手工启动新 containerd 或修改 kubelet。现在可用 [`install-runtime --prepared <成功目录>`](runtime-installation.md) 受控安装候选实例，复用同一归档完成导入和 CRI 检查。候选安装中断后使用同一命令核验续跑；不要把 `prepare-runtime` 的“另建预备目录”与安装器续跑混为一谈。

中性 helper、[各项目部署入口适配](runtime-consumers.md)和[正式切换事务](cutover.md)已实现，生产业务切换尚未执行。后续须先 `cutover-check`，维护窗口内由 `migrate` 完成停写与备份、存储身份和 guards 同步、kubelet 子挂载处理与原 K8s 任务退出核验，再恢复数据库并验收 MX-H2I 登录、联网、SSO 与 Pay。原共享 containerd 和 Docker 数据继续保留。
