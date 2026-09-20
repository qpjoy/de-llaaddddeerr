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
先单独验证数据库及凭据，再恢复 API 和后台 worker。不要只运行 Hub 的 `down`：
它目前仅停止 Admin/Public，后台 worker 仍会运行。Launcher、MX-H2I 和用户网络不在
该恢复范围内，不能借此重启或修改它们。

参考：[PostgreSQL pg_controldata](https://www.postgresql.org/docs/16/app-pgcontroldata.html)、
[Kubernetes Retain PV](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#retain)。
