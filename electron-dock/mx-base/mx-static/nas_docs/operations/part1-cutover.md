# 第一卷：执行切换并恢复媒体业务

现场结果更新：`mx-nas-cutover-po-2` 已成功完成，`phase=running_on_nas`；不要再次执行本页 `--cutover`。记录的执行阶段约 2 分 40 秒，SSD 原副本仍在；继续 [业务验收与只读空间清单](part1-reclaim-plan.md)。

适用范围仅为 `mx_data` / `po_infra_media_data`。已回传成功准备目录：

```text
/var/lib/mx-static/nas-cutover/po_infra_media_data-830225384207402a8ba23a2364d252d1
```

`review_items=[]`、Docker NFS 子目录身份和 4 KiB 读写均通过。源预复制 job 为 `1e9cdad9efd741338d3fdcb82f327ba5`。这些结果允许进入停写切换，不代表已切换或可删除 SSD。

## 执行

用户已经同意这套业务安排 10–30 分钟维护窗口，并选择 rsync 传输校验加停写后逐路径 quick-check，不再全量复读 SHA256。执行下面命令即启动该维护流程。期间冻结这一套部署，并暂停任何宿主机、Kubernetes 或其他 NAS 客户端对迁移源/目标的额外写入；工具核对 Docker 已登记的消费者，不能锁住其他主机的任意进程。

用户提交本轮 mx-static 修改并在服务器获取后，在 mx-static 目录执行：

```bash
sudo systemd-run --unit=mx-nas-cutover-po-1 \
  --property=RuntimeMaxSec=infinity \
  --property=TimeoutStopSec=infinity \
  --property=ReadOnlyPaths=/data \
  /bin/bash "$PWD/scripts/nas-cutover.sh" --cutover \
  /var/lib/mx-static/nas-cutover/po_infra_media_data-830225384207402a8ba23a2364d252d1
```

`ReadOnlyPaths=/data` 约束迁移进程，SSD 源保持只读；Docker daemon 在自己的挂载命名空间中管理容器，不受这个单元的只读路径配置影响。报告写到 `/var/lib/mx-static`，目标写到 `/mnt/nas`。任务脱离 SSH 会话继续运行。

```bash
sudo journalctl -u mx-nas-cutover-po-1 -f -o cat
```

退出日志跟随可以按 Ctrl+C，不会终止后台任务。查看最后结果：

```bash
sudo journalctl -u mx-nas-cutover-po-1 -n 30 -o cat --no-pager
sudo systemctl show mx-nas-cutover-po-1 -p ActiveState -p SubState -p ExecMainStatus
```

只回传终端 JSON 摘要。私有容器配置、rendered Compose、命令错误报告可能包含凭据，不贴回、不提交 Git。同一个准备目录只允许执行一次 `--cutover`；已有 `execution.json` 时会拒绝盲目重跑。

## 具体动作与保护

1. 复核准备目录权限、原 Compose/环境文件哈希、两份原配置与候选配置、镜像 ID、十个消费者、应用可写代码、PostgreSQL/Redis 健康与身份、源/目标 inode 和预复制 marker。任何差异都在停业务前拒绝。
2. 持有同一个迁移锁；写入本机 `execution.json` 和 NAS 封存 marker，阻止旧预复制脚本在切换后覆盖新数据。在线执行一次不限速增量 rsync，业务此时仍运行，以减少后续停写时间。
3. 依次优雅停止 gateway/beat、web/chat-gateway、六个 Worker。使用 `docker stop -t -1`，等待在途任务退出，不使用强杀，不 purge 队列。数据库、Redis、Delta 59202 及其他项目不在命令目标中。长任务或 hard NFS 阻塞可能超过预计维护窗口，脚本没有硬超时杀任务。[Docker stop](https://docs.docker.com/reference/cli/docker/container/stop/)
4. 确认十个原消费者均停止，拒绝 OOM/137 异常退出；做源元数据清单、最终增量 rsync、目标元数据清单。只支持同一文件系统上的普通单链接文件和目录；链接、设备或扫描错误会拒绝继续。
5. NAS 多出的文件/目录不直接删除，而是在同一 NAS 上重命名至该卷目录下 `.mx-static-extras-<uuid>/`，位于 live `data_hub_raw_media` 之外。`quarantine.jsonl` 在每次重命名前后持久化原相对路径与保留位置，整目录移动保留内容。只因源端已不存在而移出 live 树，不根据 `.tmp` 名称或年龄删除数据。
6. 如移动了多余项，再做一次增量同步恢复目录属性。执行带 `--dry-run --delete` 的逐路径 quick-check，要求输出为空；实际同步命令不带 `--delete`。源清单前后必须相同。重新打开登记的源/目标路径检查身份，再用只读隔离容器核对 Docker 实际 NFS 根 inode。这些步骤不做全量内容哈希。
7. 使用成功准备目录中的 `compose.nas.override.json`，仅创建十个 NAS 媒体消费者，先不启动；固定现有镜像，不拉取、不构建，不修改或重建依赖服务，不移除其他容器。核对实际父卷、NFS 子卷、gateway 只读、nocopy、镜像、环境和启动命令。[Compose 2.27 实现](https://github.com/docker/compose/blob/v2.27.0/cmd/compose/up.go)
8. **在第一次启动 NAS 应用前**持久化 `nas_may_have_writes=true`。依次启动 Web/聊天并等健康，启动 Worker，再启动 gateway 并等健康，最后恢复 beat；检查所有服务仍在运行。通过 gateway 的实际发布端口，对一个已有媒体文件执行 1024 字节 Range 请求，要求 HTTP 206、Content-Range、长度和读回内容与停写时的 SSD 样本一致。
9. 成功输出 `cutover_result`、`phase=running_on_nas`，NAS marker 保持封存。`business_acceptance_pending=true`、`reclaim_ready=false`：工具检查不代替业务任务验收，也不自动释放 SSD。

数据库健康检查和 Redis 健康检查不等于应用任务已完成。此轮 Worker 保留原队列配置，`MX_RECOVER_STALE_AGENT_RUNS=0` 避免启动时额外重新入队旧任务；不承诺分布式任务“恰好一次”语义。

## 失败与恢复

先读 `cutover_failed` 的 `phase` 和 `nas_may_have_writes`。不自动回滚，不执行 `docker compose down -v`、volume rm、SSD 清理或手工修改 marker。报告目录与所有副本保留。后台单元尚在运行/停止中时，不并行发起恢复；同一个全局锁也会拒绝并行操作。

- `phase=preflight`：生产尚未停止，先处理明确指出的配置/身份差异。
- `nas_may_have_writes=false` 且已经停了业务：可以使用下方 `--restore-ssd`。工具还会检查 NAS 消费者是否实际启动过；一旦存在启动痕迹即拒绝回旧副本。
- `nas_may_have_writes=true`：可能已有新数据，只能用 `--resume-nas` 继续启动同一组已核对的 NAS 容器；不会重新 rsync 或重建已运行的容器。如果没有完整的已核对容器集合、容器被替换、配置漂移或数据库不健康，会拒绝自动恢复并保留现状，需看具体错误处理。

在原单元结束且确认属于前述情形后，二选一执行，不能两条都执行：

```bash
sudo systemd-run --unit=mx-nas-restore-po-1 \
  --property=RuntimeMaxSec=infinity --property=TimeoutStopSec=infinity \
  --property=ReadOnlyPaths=/data \
  /bin/bash "$PWD/scripts/nas-cutover.sh" --restore-ssd \
  /var/lib/mx-static/nas-cutover/po_infra_media_data-830225384207402a8ba23a2364d252d1
```

```bash
sudo systemd-run --unit=mx-nas-resume-po-1 \
  --property=RuntimeMaxSec=infinity --property=TimeoutStopSec=infinity \
  --property=ReadOnlyPaths=/data \
  /bin/bash "$PWD/scripts/nas-cutover.sh" --resume-nas \
  /var/lib/mx-static/nas-cutover/po_infra_media_data-830225384207402a8ba23a2364d252d1
```

SSD 恢复同样固定镜像、保留 Web 的安全启动覆盖和 Worker 恢复开关，不重新执行 migrate/bootstrap_admin/collectstatic；只重建这十个消费者。成功后 `phase=restored_ssd`，原迁移记录仍封存，需要根据新容器身份制定下一次尝试，不能重跑旧预复制。两个恢复模式也验证 NAS marker，NAS hard 挂载完全不可用时可能等待，不能把恢复命令当成保证限时成功的急救按钮。

## 业务验收、持久部署和重启

切换成功后，实际检查：旧图片/视频能打开与拖动播放；新增一项媒体任务/上传，确认应用记录和文件可读；检查 Worker 消费、任务结果与周期任务，确认没有持续 permission denied、NFS I/O 或数据库错误。回传终端结果与业务验收情况后，再制定只针对 SSD 旧 `data_hub_raw_media` 的释放清单。没有本轮 SSD 删除命令。

运行配置的原文件集合新增了报告目录中的 NAS override。`/var/lib/mx-static/nas-cutover/...` 是持久报告，不是临时目录，不能清理。后续 Compose 发布必须带这份 NAS 覆盖，遗漏它会重新回到旧 SSD。覆盖中的镜像固定、Web 启动和 Worker 恢复开关是此次切换的选择；正式应用升级时需显式调整，不能把旧 image ID 无期限当成最新镜像。

Docker NFS volume 直接挂载指定 NAS 子目录，初次挂载失败会阻止相应容器启动，避免误用宿主机空目录。保留 Docker 全局 `20-requires-nas.conf.bak` 禁用状态；不让其他 SSD 数据库/队列等待 NAS。NAS 晚于服务器启动时，不保证 Docker 对首次挂载失败无限重试；NAS 恢复且数据库就绪后可依据已封存记录使用 `--resume-nas`，它只启动已验证的现有容器。`hard` NFS 运行中断连仍可能使 I/O 等待；不切成 `soft`、不强制卸载来冒险赶时间。参见 [平台存储说明](storage-platform.md)。

## 测试边界

84 项 NAS 本地测试通过，新增 14 项覆盖：CLI/路径拒绝、精确服务范围和 no-start/no-build/no-pull、无限等待优雅停止、SSD 覆盖的启动行为、NAS 首次启动前持久化回滚边界、禁止旧副本覆盖新写入、恢复不复制/不重建、实际挂载与环境/ID 差异拒绝、真实本地 rsync 增量/逐路径检查、含换行文件名与整目录的 NAS 多余项保留、原文件内容不变、原子状态文件、完整成功和失败流程顺序，以及 HTTP Range 返回校验和重复调用保持既有写入边界。

另外使用本机真实 Compose v2.34 配合 po-infra 的两份 Compose 文件和示例环境，验证了 NAS 候选与 SSD 恢复配置的合并结果，未启动容器。真实文件与 rsync 测试在 macOS 临时目录进行；Docker/NFS 操作为模拟。Python 3.6 语法检查不等于已在 EL8 Python 3.6 执行。生产 NFS 和 Compose 2.27 的具体结果仍以服务器输出为准。
