# 旧数据目录与当前空库的隔离核验

2026-09-21 服务器输出确认：当前 mx-common PV 位于根分区
`/var/lib/mx-common/k8s`，Hub 数据库仅 18 MB、无请求和 canonical 记录。
原 `/data/k8s/mx-runtime/mx-common/k8s` 位于 `/dev/nvme0n1p1`，仍保有约
31 GB PostgreSQL 和 55 GB Elasticsearch 文件。这证明数据目录没有接回，
但不证明旧文件完整或业务记录已经恢复。

生产 deploy 只从现有 PV 找回迁移后的路径；PV 元数据丢失时会回到默认路径。
不要使用 `relocate` 或 `migrate-storage` 接回旧数据：这些命令会从当前目录向目标
目录复制文件，可能覆盖旧库。也不要运行 reset、清理、全量索引或重新采集。

## 独立核验

将本脚本及依赖的 `server/core/key-vault.mjs` 同步到 Internal checkout 后，在
`electron-dock/mx-insight-hub` 目录以 root 执行（不需要重新部署应用）：

```bash
node scripts/inspect-retained-database.mjs \
  /data/k8s/mx-runtime/mx-common/k8s
```

要求 Linux、Node.js、GNU cp/find、kubectl 和本机 Docker；Docker 已缓存当前 PG16
镜像，且 kubectl 指向本机单节点集群。执行时不要并行部署、启动旧库或搬动数据目录。
脚本拒绝已被 postgres 进程、非终态 Kubernetes Pod 或可写 Docker mount 使用的目录，
拒绝链接 WAL/tablespace、其他 PG 版本及 standby/特殊恢复标记。

脚本只读检查原目录，并在 `/data/.mx-hub-inspect-*` 创建同文件系统的 reflink 副本。
源目录没有作为容器可写挂载，副本不支持 reflink 时直接停止，不自动复制几十 GB 文件。
启动前核对原 control file 未变化；副本允许 PostgreSQL 自己做崩溃恢复，原文件不变。
副本不能代替独立备份：它与原文件共享物理数据块，也会随着副本写入占用额外空间。
脚本要求至少 2 GiB 可用磁盘和内存，容器限制 1 CPU/1 GiB 内存；这不是磁盘配额或
对严重 WAL 恢复开销的保证。数据库恢复失败时停止核验，不修复或重置 WAL。

容器断网、不发布端口、不启动 Hub/worker，SQL 使用只读事务和 10 秒超时。
生产 PV/PVC、工作负载和 Secret 均不修改。原配置不用于启动副本；副本只允许本地
Unix socket，自动维护关闭。结束后移除临时容器，保留私有副本和 report.json。

报告包含旧库大小、租户/调用者/Key 数、存量记录存在性、最新请求时间以及 PostgreSQL
planner 的估计行数；估计值不是精确总数。最多取最近 10 个 vault 样本，在内存中
用当前 Kubernetes Hub Secret 的 Pepper 解密，并核对对应 Key 的认证摘要。

- `MATCHED_SAMPLES`：当前 Pepper 能解密所有所取样本且认证摘要一致。仅证明样本。
- `MIXED_SAMPLES`：只有部分样本匹配，需要继续核验历史密钥或损坏情况。
- `NO_MATCH_OR_DAMAGED_SAMPLES`：无匹配；无法仅凭此区分 Pepper 错误与样本损坏。
- `UNVERIFIED_NO_VAULT_SAMPLES`：没有 vault 样本，不得解释为 Pepper 正确或错误。

脚本不读取或执行 `.env.internal`。即使当前 Secret 匹配，恢复部署前也应私下核对
该文件仍沿用相同 Pepper。报告不包含 Pepper、API Key、摘要、密文或业务正文。
只分享终端汇总或 report.json；整个核验目录、原配置及日志可能包含凭据，不能分享。

这一步不是恢复完成。后续需保全原数据与配置、停止 Hub 所有写入者、重新绑定旧卷，
先单独验证数据库及凭据，再恢复 API 和后台 worker。旧版 Hub 的 `down` 仅停止
Admin/Public；本次修复后的 `down` 会缩容全部 Hub Deployment，并等待六种 API/worker
Pod 退出。它保留共享数据服务与持久卷。Launcher、MX-H2I 和用户网络不在该恢复范围内。

## 使用已核验报告恢复本次旧卷

服务器已确认报告 `/data/.mx-hub-inspect-U5pAiZ/report.json`：原 PG system identifier
`7671038612254789664`，正常关闭，9 租户、10 调用者、13 Key；最近请求为
`2026-09-20T06:46:40.663159+00:00`；4 个 vault 样本全部匹配当前 Pepper。

同步新增的 `scripts/recover-retained-storage.mjs`（依赖已经运行过的 inspection 脚本），
在服务器 Hub 目录以 root 执行，不需要构建或 deploy：

```bash
node scripts/recover-retained-storage.mjs \
  /data/.mx-hub-inspect-U5pAiZ/report.json
```

这是显式生产恢复操作，按顺序执行：

1. 验证原盘仍挂载、PG16 原身份及 clean shutdown、ES 9.4.2、三组精确 Retain
   绑定、六个 Hub Deployment 和密码 Secret。拒绝活跃 Job、HPA、CronJob、旧目录
   上的活跃进程/Pod/可写容器挂载。取得与 Hub deploy 共用的本机锁。
2. 将当前 K8s 配置（包括 Secret）保存到 root 私有的 `/data/.mx-hub-recovery-*`。
   停止六个 Hub Deployment 并等待全部非终态 Hub Pod 退出。若当前默认目录的库
   已出现业务记录，停止并要求合并决策，不能直接覆盖或丢弃新数据。
   若新共享实例中还有其它产品数据库或非 Hub 业务索引，同样停止，不擅自切换其它产品。
3. 停止 mx-common PG/ES，保留 Redis、HanLP。原 PG/ES/快照目录用 reflink 保全，
   默认路径的新库也复制保全；不支持 reflink 时停止，不将新文件合并到旧目录。
   这些是本机回退副本，不是异机备份；恢复后写入可能使 COW 副本占用更多空间。
4. 给 PG 启动增加原 system identifier 检查，给 ES 增加现存 metadata 检查。
   只删除并重建这三组已经核对过的 Retain PV/PVC 元数据，主机数据目录不删除。
   新 PV 指向旧目录，hostPath 类型为 Directory，并固定原节点。
5. 先启动 PG，重新核对原身份、历史计数、最新请求及 Pepper。仅把 `mx_insight_hub`
   产品角色密码对齐到当前 Hub DSN 和 mx-common 产品 Secret；不轮换 Pepper、
   Admin Token、API Key 或其它角色，也不新建数据库。关闭重启自动全库索引开关。
6. 启动原 ES，等待 yellow/green 和非空内容索引。用现有 Hub 镜像运行短生命周期
   校验 Pod：只读验证产品密码和已应用 schema checksums，不运行迁移或应用入口。
7. 恢复 Public/Admin 各 1 副本，并用现有 Admin Token 验证页面统计显示旧库计数。
   ingest/projector/classifier/retrieval 保持 0，避免在 HanLP 尚未恢复和业务尚未核对时
   自动采集、索引、模型调用或继续历史向量化。原副本数保存在私有 state.json。

成功日志为 `data-and-api-restored-workers-paused`，不是所有后台流水线恢复完成。
旧 ES 的真实索引会恢复；缺失的 HanLP 服务不由本操作构建。确认页面与数据后，再
按原配置恢复 tokenizer 和适当的 worker，不直接运行 deploy 来跳过这一步。

任一步失败会保持/尝试恢复 Hub 停止状态，不自动回滚到空库、不强删 finalizer、
不修复/重置 WAL、不清理原数据。若已到 `retained-volumes-bound` 或后续阶段，
不要重复完整命令：根据 state.json 的阶段和错误继续处理。报告版本与镜像 schema
不匹配时也会停止，数据库升级是单独的操作。

同时同步两个 manage.sh 修复后，mx-common 在 PV 读取失败，或默认路径旁发现
原 `/data` PG 时以退出码 78 停止；Hub 将它作为存储错误，而非可忽略的搜索降级，
不会继续 provision 或 rollout。已有正确 PV 的后续部署继续复用原路径。

参考：[PostgreSQL pg_controldata](https://www.postgresql.org/docs/16/app-pgcontroldata.html)、
[Kubernetes Retain PV](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#retain)。
