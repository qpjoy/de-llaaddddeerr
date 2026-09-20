# 停机后恢复服务与 2026-09-21 恢复复盘

## 已恢复的范围

本次服务器回传的最终阶段为 `data-and-api-restored-workers-paused`：

| 核验项 | 恢复结果 |
| --- | --- |
| PostgreSQL system identifier | `7671038612254789664`，接回旧实例 |
| 租户 / 调用者 / 所有 API Key | 9 / 10 / 13 |
| Dashboard 启用 Key | 10；与所有 Key 13 的口径不同 |
| 存量记录、请求历史 | 存在；恢复核验最近请求 `2026-09-20T06:46:40.663159+00:00` |
| Pepper | 4 个已保存 Key 的 vault 与认证摘要样本全部匹配 |
| Elasticsearch | green；原 v1–v6 内容索引及 chunk 索引重新可见 |
| 当前 v6 内容索引 | 当次输出 2,046,052 documents |
| 数据库认证 / schema / API | 检查通过，Admin/Public 可访问旧业务数据 |

这些证据支持“旧数据盘、旧库、旧索引和 API 已接回”，不能证明每一行、每个文件均与停机前逐字节相同，也不能证明上游数据完整。索引 documents 数不能代替 PostgreSQL 记录总数；多个历史索引不能相加作为业务数据量。Dashboard 的近 24 小时统计会随时间变化。

专用恢复脚本有意留下两类运行状态差异：

- ingest / projector / classifier / retrieval 四个 worker 为 0；尚未恢复后台处理。
- `control.search_settings.startup_rebuild=false`，禁止重启自动全量索引；Hub 专属数据库角色密码已与现存 Secret 对齐。

下一次正常 deploy 将恢复六种 Hub 工作负载（含四个 worker）的清单副本数。已有采集、分类、向量队列会按数据库中原有启停、预算和并发策略继续处理；这不创建新的全量索引或向量初始化任务。常规版本迁移仍按部署流程执行，因此“服务恢复”也不等于整个运行状态完全不变。

## 日常停机、重启、部署

前提：在原 Internal 单节点 Linux 主机执行，Kubernetes/containerd 已可用，原 `/data` 文件系统已挂载，保留 PV/PVC、Secret、原 `.env.internal` 和数据目录。共享存储检查需要 root 能读取 PGDATA；需要 Node.js、kubectl、findmnt、Docker、ctr。不要把数据目录或这些凭据作为构建缓存清理。

在服务器 `electron-dock/mx-insight-hub` 目录，代码更新后执行原命令：

```bash
MX_INSIGHT_BUILD_PROXY=http://127.0.0.1:7788 \
  bash scripts/manage.sh ops internal-production deploy
```

无需先手动 `mx-common ensure`。这条命令会：

1. 在启动依赖、provision 和构建之前核对 retained Hub Pepper、Hub DSN、mx-common 产品密码及显式密码配置；API 查询失败、Secret 丢失或不一致均停止，不打印密钥。
2. 从现有 PV 取得数据根路径，核对三组 Bound/Retain 静态 PV/PVC、claim UID、节点、真实目录、磁盘 UUID、PG16 system identifier 与 ES 元数据。显式路径变量也不能绕过绑定核验。
3. 首次核验成功，在 `/var/lib/mx-common/storage-identity.json` 保存无密钥的身份记录（0600）。它位于数据挂载之外；后续部署对比根路径、节点、文件系统挂载点/UUID、PG 身份。保留并备份该记录，不要为绕过错误而删除它。合法存储迁移也需要显式核验并更新记录，普通 deploy 不会自行接受新盘。
4. 自动复用或创建缺失的 mx-common Service/工作负载，明确恢复 PostgreSQL、Elasticsearch、Redis 副本数；先等就绪再部署 Hub。已安装的 HanLP Deployment 也会恢复为 1 并等待健康，不会自动构建模型或为从未安装的环境新装 HanLP。Hub 仍要求保留的 HanLP URL 可用；若其 Deployment 整个被删除，需要显式恢复该可选组件。
5. 保留已绑定的本地卷，即使后来增加了默认 StorageClass，也不改选空的新动态卷。PG 启动前验证旧身份，ES 启动前验证旧元数据，防止 Pod 重建时在空目录初始化；新建本地 PV 使用 `Directory`，不让 kubelet 自动创建缺失目录。
6. 检查 containerd 镜像；缺失时优先从 Docker 缓存流式导入，没有缓存才尝试拉取。核心服务默认单项等待上限 1200 秒，持续显示进度，失败说明具体 Pod 原因。可通过 `MX_COMMON_WAIT_TIMEOUT` 调整。
7. 执行既有版本迁移与 API 检查，恢复六种 Hub Deployment 的副本数，核验就绪。正常默认要求依赖和全部 Hub 工作负载就绪后才输出完整成功。

`MX_INSIGHT_BUILD_PROXY` 只控制 Hub 构建，不会替 Docker daemon/containerd 配置镜像仓库代理。新机器或镜像缓存被清理后，仍需可用的仓库网络、镜像镜像源或预导入镜像；脚本不修改全局 Docker 代理或 MX-H2I 网络。Elasticsearch 本次实际拉取耗时 15 分 22 秒，是当时等待的主要原因，不是搬运 55 GB 旧索引。

`MX_INSIGHT_REQUIRE_SEARCH` 默认由 0 改为 1。旧 `.env.internal` 若显式设置为 0，仍代表操作员允许降级，不能把这种 deploy 当成全部服务恢复。常规恢复请删除该旧覆盖或设为 1。降级模式同样不能绕过磁盘/凭据保护。

部署完成后，可贴回以下不含 Secret 的状态：

```bash
bash ../mx-common/scripts/manage.sh status
kubectl -n mx-insight-hub get deployments
kubectl get pv -l app.kubernetes.io/part-of=mx-common \
  -o custom-columns='NAME:.metadata.name,STATUS:.status.phase,PATH:.spec.hostPath.path'
```

三组数据 PV 应继续指向 `/data/k8s/mx-runtime/mx-common/k8s/...`。六种 Hub Deployment 应达到各自期望副本数，后台积压消化不要求在启动时全部完成。

Hub 的 `down` 现在停止并等待全部六种 Hub Pod，保留共享数据服务、PVC、namespace 和 Secret。若还要停止共享数据服务，应先确认其他使用 mx-common 的产品已停，再执行 `bash ../mx-common/scripts/manage.sh down`；正常 deploy 会把这些依赖重新启动。`down` 不是卸载，不删除数据。

## 必须停止而不能假装恢复的情况

- `/data` 未挂载、换了 UUID、PG 身份不符、旧文件缺失：先恢复正确磁盘，不向根分区初始化另一个库。
- PV/PVC 被删除、Released、terminating、claim UID/目录不同：不会自动删除绑定或选择另一份库，使用[显式 retained-data 恢复流程](retained-data-inspection.md)。普通工作负载停机/被删与持久元数据丢失不是同一种恢复。
- Secret、原 Pepper 或产品密码丢失：使用保留的配置/备份核验恢复；普通 deploy 不再生成新密码替换旧角色。
- 镜像下载、Kubernetes、磁盘容量、数据库崩溃恢复等问题超时：保留原盘、卷和凭据，修复具体原因后重复同一 deploy。超时不会自动回滚到空库，也不要删除 PV/PVC 或使用 reset/relocate 来“重试”。

宿主机文件系统自动挂载属于主机配置。此命令能核验挂载并拒绝错误盘，不能替代 `/etc/fstab`、磁盘硬件修复或 Kubernetes 控制面的恢复。

## 本次故障与改进

| 问题 | 现象 / 原因 | 处理与后续保护 |
| --- | --- | --- |
| 旧盘未接回 | 新 PV 指向根分区 `/var/lib/mx-common/k8s`；31 GB PG / 55 GB ES 仍在 `/data` | 隔离核验旧库，保留两份数据，显式重绑；部署核对绑定、文件系统、PG 身份并保存记录 |
| `down` 不完整 | 旧脚本只停 Admin/Public，后台仍可能写入 | 停全部六种 Hub Deployment 并等 Pod 退出 |
| Linux kubectl 补丁输入失败 | `/dev/stdin` 与 Node 子进程管道不兼容，错误被隐藏 | 恢复脚本使用私有临时文件，按阶段记录；普通 deploy 无须重跑恢复脚本 |
| 镜像长时间未启动 | Docker 与 containerd 缓存分离；ES 拉取超过旧等待上限 | 优先缓存导入、显式进度/诊断、延长等待；支持数据库恢复之后单独续跑 |
| 空 StorageClass 检查误判 | API 省略 PV 空字符串，原检查将其与 `""` 当成不同值 | 仅对 PV 的缺省空值归一；PVC 与其余绑定字段继续严格核对 |
| 旧 API Key 是否可用不确定 | `.env.internal` 来源不明确，Pepper 变更会破坏旧 Key/vault | 恢复时抽样解密并校验摘要；正常部署前比较 retained Secret，不自动轮换 |
| 有 API 不代表全部服务已恢复 | 专用恢复有意暂停四个 worker；旧 deploy 可在搜索降级时显示成功 | 普通 deploy 明确恢复副本数，默认检查全部依赖/Hub 就绪 |

原私有恢复目录 `/data/.mx-hub-recovery-ljwH6x` 与核验目录 `/data/.mx-hub-inspect-U5pAiZ` 暂时保留；不要分享其中配置、日志或 Secret 备份。同盘 reflink 副本不构成独立备份；本次没有执行全库行级比对、全页校验或离机恢复演练。后续备份按[备份恢复文档](backup-restore.md)单独验证，不以本次页面恢复替代。

PG 身份读取依据 [PostgreSQL 16 的 control file 格式](https://raw.githubusercontent.com/postgres/postgres/REL_16_STABLE/src/include/catalog/pg_control.h)，只用于辨认实例；容器启动另由 `pg_controldata` 检查。hostPath 类型语义见 [Kubernetes 文档](https://kubernetes.io/docs/concepts/storage/volumes/#hostpath)。首次应用新版 PG/ES 启动保护会触发这两个服务滚动，单节点期间 Hub 请求可能短暂等待或失败；不是所有服务零停机升级。

本次脚本和文档变更限于 Hub/mx-common。Launcher 登录、MX-H2I、VPN、用户订阅和全局代理不属于本流程；普通独立 Hub 命令会忽略 `.env.internal` 中遗留的 Launcher 同步开关；只有调用方显式传入 `MX_INSIGHT_SYNC_LAUNCHER=1` 才保留原委托能力，不要为本次恢复添加该开关。
