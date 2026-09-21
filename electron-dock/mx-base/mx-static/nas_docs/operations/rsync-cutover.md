# 第一卷改用 rsync 常规切换流程

## 最新决定优先于此前的全量 SHA256 门槛

用户确认第一轮采用默认 60 MiB/s、没有中断、最终退出 0，明确要求取消额外全量 SHA256 比对并开始切换准备。本轮采用 **成功预复制 → 停写后增量 rsync → 逐路径 quick-check → 切换与业务验收**，不再要求先完成 500 GiB 的独立 SHA256 复读。这是用户选择的验证策略，不是绕过工具错误。

rsync 3.1.3 对实际传输的文件执行整文件校验；`--checksum/-c` 是“哪些文件需要重传”的额外内容比较，与传输自身校验不同。最后的 quick-check 使用路径、类型、size、mtime 和保留属性，不能宣称完成了独立 SHA256 验证，也不检测既有副本中 size/mtime 未变化的内容损坏。[rsync 3.1.3 原文](https://github.com/RsyncProject/rsync/blob/v3.1.3/rsync.yo)

原 SSD 副本保留至切换和业务恢复验收完成；不删除 named volume，不迁数据库或队列，不因原预复制退出 0 就直接清理源。

## 立即停止可选的在线复读

在服务器执行：

```bash
sudo systemctl stop mx-nas-verify-po-1.service
sudo systemctl show mx-nas-verify-po-1.service -p ActiveState -p SubState -p MainPID
```

这只停止校验单元；保留局部校验报告和已经复制到 NAS 的文件。若 hard NFS 阻塞导致停止未完成，先保留输出，不删除锁、不强制卸载。后续准备脚本与校验使用同一个锁，旧进程仍持锁时不会并发继续。

## 在线准备：不停止业务，不做全量复读

通过 Git 更新服务器 mx-static 后，在该项目目录执行：

```bash
sudo bash scripts/nas-cutover-prepare.sh po_infra_media_data --prepare
```

动作范围明确如下：

- 复用已验证的本机 Docker、SSD 源卷、10 个消费者、NAS 导出与已完成 precopy marker 检查；不要求 SHA256 校验报告通过。
- 用服务器实际的原 project/env-file/Compose 文件渲染配置，比较服务 config-hash 和运行环境值；输出仅列变化的键名，不输出凭据值。
- 检查应用容器可写层中的代码配置变化，以及实际运行的 Web/Worker 启动脚本哈希。原工作区/镜像不一致、文件组合不同或消费者变更会被报告或拒绝，不 pull/build。
- 创建或核对 **新的** `mx_data_raw_media_nfs_v1`，driver 为 local、type 为 nfs，device 固定到已复制的 NAS 子目录。既有同名卷必须选项完全一致，绝不删除重建它。
- 用当前 Web 的 image ID 运行一个隔离容器：关闭网络、镜像拉取和健康检查，根文件系统只读；NFS 挂在 `/nas`，禁用 volume 自动填充。检查实际 NFS 和根 inode；在 NAS 目标下排他创建随机名 4 KiB 文件，写入/fsync/读回后只删除该自建文件。它不导入应用、不连接数据库、不读全部媒体、不修改业务文件。
- 私有记录写入 `/var/lib/mx-static/nas-cutover/po_infra_media_data-<随机ID>/`。`containers.private.json` 和 rendered Compose **含运行凭据，留在服务器，不贴回、不入 Git**。`prepare-result.json` 与终端摘要不含环境变量值。

正常情况是元数据与少量探测操作，不再按媒体总容量等待几小时；hard NFS 不可用仍可能等待。最后回传 `cutover_prepare_result` 或具体失败输出。`review_items` 非空时解释差异，不忽略后直接重建业务。

退出 0 表示本次准备检查通过，退出 2 表示有配置/运行代码需要核对；两者都没有停止业务或执行切换。`cutover_ready=false`、`reclaim_ready=false` 继续保留，因为尚未停写做最终同步。这里的准备结果取代“必须先全量 SHA256 完成”的要求；**不是再要求一次审批**，需要现场结果是为了确认此前没有测试过的 Docker 子目录挂载及实际部署状态。

## 候选覆盖配置的具体变化

生成 `compose.nas.override.json`，只能作为原两份 Compose 的最后一份覆盖文件，并保持原 `--project-directory`、`-p mx_data`、`--env-file`。自动合并检查确认 PostgreSQL/Redis、其他环境、端口、SSD 父卷及静态卷没有变化。

1. 十个媒体消费者固定各自当前 image ID，新增 `/app/media/data_hub_raw_media` 的 external NFS 子卷、`nocopy=true`；gateway 子挂载只读。
2. Web 使用已验证启动脚本中相同的 gunicorn 命令及当前 Host/Port/Workers/Timeout，跳过 `migrate/bootstrap_admin/collectstatic`。原 `bootstrap_admin` 会执行 set_password，因此这次存储切换不重复它。
3. Worker 保留原启动命令，覆盖 `MX_RECOVER_STALE_AGENT_RUNS=0`，避免这次重建额外扫描并重新入队旧任务。仍需正常恢复队列消费，不能 purge 队列。

这两项启动调整服务于本次存储切换，不代表以后应用升级不需要数据库迁移或过期任务恢复。验收后应把 NAS 挂载纳入长期部署配置；下一次业务发布需明确处理启动覆盖和恢复策略，不能盲目继续使用临时镜像固定配置，也不能漏掉 NAS 覆盖而写回 SSD。

## 收到准备结果后的维护步骤

停写窗口仍为 10–30 分钟。以下顺序已经确定，具体执行参数使用准备结果中的真实容器和覆盖文件；本次交付的 prepare 工具没有自动执行这些生产动作：

1. 冻结部署和 NAS 外部写入；核对准备记录中的源身份、原文件哈希、所有消费者与当前配置。记录正在执行/等待的任务；不要为了赶窗口强杀长任务。
2. 停止该实例 gateway、beat、web、chat-gateway，关闭入口/生产者；再温和停止该实例 Worker，让在途任务完成。Docker `stop --timeout=-1` 等待退出，不自动 SIGKILL；长任务没结束时不能承诺窗口时长。数据库、Redis、另一套 Delta 继续运行。[Docker stop](https://docs.docker.com/reference/cli/docker/container/stop/)、[Moby 26.1.3 实现](https://github.com/moby/moby/blob/v26.1.3/daemon/stop.go)
3. 确认全部媒体写入者已停止，再对原 raw_media → 已登记 NAS 目标执行 `rsync -a --numeric-ids --one-file-system` 增量同步，不限速、不加 `-c`、不加真实 `--delete`、不删除源。保持挂载/路径保护，所有非零退出码都停止切换。
4. 再执行逐路径 dry-run/itemize 检查；需要用 `--dry-run --delete` **仅列出** NAS 多余路径，不能把 dry-run 的删除选项复制进实际同步命令。要求新增、缺失、属性变化和多余项均已解释/处理；不是只看总大小。发现多余旧文件时先列清单，必要时移到 NAS 上媒体目录外的隔离区，不自动删除。
5. 最终检查通过后封存预复制状态，避免旧 SSD 回写覆盖 NAS 新数据；用已核对的原配置 + 生成覆盖文件，只重建十个媒体消费者，禁止 pull/build 和 down -v。先启动 Web/聊天与 Worker，再恢复 gateway 和 beat；核对实际子挂载、UID/GID、健康检查、旧媒体读取/Range、上传与任务恢复。
6. NAS 新写入开始前失败，可以保留 NAS 副本并恢复原 SSD 容器；NAS 已开始新写入后，不能简单指回旧 SSD，须停写并反向合并新增/修改/删除状态。验收完成后才准备针对旧 raw_media 的空间回收清单。

完整 SHA256 已改为可选加严检查，不作为以上流程前置条件。NAS 无独立备份、开机晚到后初始挂载失败的恢复责任仍按 [存储平台说明](storage-platform.md) 记录；本次不恢复 Docker 全局 NAS 强依赖。

## 本地验证

64 项 NAS 测试通过，其中新增 7 项覆盖原卷与目标定义拒绝、原配置/环境漂移的脱敏输出、镜像与挂载覆盖范围、Compose 合并不得修改数据库/父卷/其他环境、私有文件排他写入、CLI 范围限制、隔离探针只读写删除自身文件与身份拒绝。

用本机 po-infra 的真实两份 Compose 文件及示例环境，在 Compose v2.34.0 中完成合并核验；Python 3.6 语法/API 兼容检查和 Bash 语法检查通过。没有本机 Docker daemon/NFS/EL8 现场执行，不能把这些测试写成生产已切换。服务器 Compose 2.27 与实际 NFS 结果由准备工具现场检查。
