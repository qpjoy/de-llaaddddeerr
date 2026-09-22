# infra：mx_data 原始媒体

管理名 `infra`，Compose 项目 `mx_data`，任务 `part1`；不是宿主机基础设施层的通称。该业务仍在 po-infra 仓库维护，但其 NAS 运维适配集中在本仓库 `scripts/nas/projects/infra.py` 和 `deploy/nas/projects/infra.json`。

## 发布与权限风险

旧发布脚本可能执行整个 `/app/media` 的递归 chmod、数据库 migration、bootstrap_admin 和任务恢复。NAS 上目录已是生产媒体，不能把这些副作用当作普通存储维护。

```bash
bash scripts/manage.sh nas infra deployment audit
bash scripts/manage.sh nas infra compose config-check
```

audit 只读取三个固定部署脚本、输出风险规则与行号，不执行脚本、不显示密钥内容。它是启发式检查，不能证明“没匹配到就完全安全”。config-check 核对原部署与受管 NAS override。

现阶段同版本维护使用：

```bash
bash scripts/manage.sh nas infra redeploy --maintenance
```

这保留 NAS 子挂载、固定现有镜像，跳过原 Web 初始化并沿用已审核的 Worker 恢复开关；不会调用原业务发布脚本，不递归修改媒体权限。它会停十个媒体消费者并重建，因此只在约定维护窗口运行。程序正式升级仍需独立的候选配置、显式数据库迁移、应用验证和新的恢复基准，本轮未实现通用升级工具。

## 业务身份权限验证

```bash
bash scripts/manage.sh nas infra permissions check
```

在九个已登记写入消费者里，以 Docker 当前配置的默认用户/组执行 Python 只读检查，验证 NFS 子挂载及目标 inode，报告 UID/GID/groups、目录属性与有效访问判断；不使用运维 root 的 `--user` 覆盖业务身份。gateway 不写，使用已有媒体的 HTTP Range 读回来核对实际读服务。

需要实际验证写入时显式执行：

```bash
bash scripts/manage.sh nas infra permissions probe --write-test
bash scripts/manage.sh nas infra logs
```

该操作作为临时 systemd 任务运行并持有迁移锁；串行在九个应用消费者中各新建一个唯一私有探测目录，写入 4 KiB、fsync、同目录改名、读回、校验，随后只删除自己的文件/目录 inode。报告同时给出进程身份和新建文件的实际 NAS 所有者，不 chmod/chown 业务文件。不自动重复探测；hard NFS 卡住时保留进程/日志等待处理，不并发再启动。

Docker exec 的默认身份不一定覆盖应用内部再次降权后的所有子进程；mode/os.access 检查也不是完整 ACL 或业务测试。实际新上传/采集和新文件经 gateway 读取仍要业务验收。探测成功不代表所有文件、所有身份或整个 NAS 存储池健康均已验证。

权限失败时先看数值 UID/GID、补充组、目录逐级可执行权限、NAS 映射/ACL、挂载 ro/rw，以及应用创建文件 mode。保持当前已验证策略，不自动改 NAS export、不关闭 root_squash、不把所有目录改成 777。未来非 root 项目先规划独立目录和组/ACL，不能直接放宽现有迁移 marker 目录的保护规则。

## Part 1 清理与恢复

```bash
bash scripts/manage.sh nas infra task part1 status
bash scripts/manage.sh nas infra task part1 cleanup --business-accepted
bash scripts/manage.sh nas infra recovery
```

这三条分别是查看、业务验收后的 SSD 文件删除、补启动既有容器，不应无条件顺序执行。NAS 已是权威来源；cleanup 不删除 named volume，不动其他 media 目录，recovery 不把旧 SSD 复制回 NAS。完整清理规则见 [Part 1 回收](../operations/part1-reclaim.md)。
