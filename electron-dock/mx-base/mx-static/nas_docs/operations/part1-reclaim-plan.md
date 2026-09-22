# 第一卷切换后的只读空间回收清单

第一卷 `po_infra_media_data` 已在现场切换成功，`mx-nas-cutover-po-2.service: Succeeded`、`phase=running_on_nas`。本页只准备空间清单，尚不删除文件、不记录业务验收通过。

## 当前结果

- 在线补复制 781 个文件，422,488,713 字节，约 402.92 MiB。
- 停写后的最终 rsync 没有需要传输的文件；逐路径 quick-check、源清单稳定性和 Docker NFS 身份检查通过。
- 总计 194,686 个普通文件、4 个目录，逻辑大小 534,838,192,708 字节，约 498.11 GiB。
- 十个媒体服务恢复，Web/聊天/gateway 健康检查通过；一个已有视频的 1024 字节 HTTP Range 请求返回 206 且内容匹配。PostgreSQL 与 Redis 容器身份保持不变。
- 没有 NAS 多余项被隔离，`quarantined_roots=0`。SSD 原数据完整保留，尚未释放空间。
- 记录的执行段从 `started_at_unix=1790036533.3219838` 到 `updated_at_unix=1790036693.634978`，约 160.313 秒，包含在线补增量时间；缺少停写起止时间戳，不能将它写成精确停机时长。

## 业务验收

实际打开旧图片、视频并拖动播放；新建一次媒体采集或上传，确认文件可读且任务结果正常，检查 Worker 和周期任务恢复。工具的健康检查与单文件 Range 成功不等于所有业务路径都已验收。用户回传的应用验收结果尚待补充。

NAS 已可能存在新的业务写入；不再运行 SSD → NAS 的旧预复制或直接恢复 SSD 数据源。旧 SSD 是保留副本，线上 NAS 已是该子目录的读写来源。后续发布须保留成功报告目录中的 `compose.nas.override.json`；仅用原 Compose 文件执行 up 会丢失 NAS 子挂载。正式发布集成见 [持久部署和重启说明](part1-cutover.md#业务验收持久部署和重启)。

## 生成清单

将本轮新增脚本提交并同步到服务器 mx-static 后执行：

```bash
sudo bash scripts/nas-reclaim-plan.sh \
  /var/lib/mx-static/nas-cutover/po_infra_media_data-830225384207402a8ba23a2364d252d1
```

这个命令：

1. 验证已完成的切换记录、原配置、NAS 卷定义、实际十个容器 ID/挂载/运行健康、数据库与 Redis 身份；检查是否有其他 Docker 容器通过卷或 bind 父路径访问旧 SSD。
2. 只读打开固定 SSD 源与 NAS 登记目录，核对封存 marker。只读取 NAS 的有限目录元数据，不遍历 NAS 媒体，也不读取全量内容。
3. 通过固定 SSD 目录描述符执行 `du -sx --block-size=1`，报告分配空间；对旧 SSD 媒体做两次元数据清单，拒绝链接、子挂载、扫描错误或期间变化。
4. 在原私有报告目录下新建 `reclaim-plan-<uuid>/files.jsonl` 和 `plan.json`。报告权限为 root 私有，保存每个原路径的设备/inode/属性以及清单 SHA256。这个 SHA256 是**元数据清单文件**的摘要，不是对 498 GiB 媒体做内容哈希。
5. 输出 `reclaim_plan_result`；不停止/重建服务，不复制或删除媒体，不改 NAS marker 和 `execution.json`。脚本没有删除参数，`deletion_supported=false`、`reclaim_ready=false`。

只回传终端 JSON 摘要。`du_allocated_bytes` 是旧目录的分配空间估计，`data_available_bytes` 是当时 /data 可用空间；实际删除后 df 的增加量还可能受打开文件、共享块和业务同时写入影响，不能保证恰好等于逻辑字节数。

## 后续释放范围

业务验收与现场清单通过后，再依据清单实施清理。范围只能是：

```text
/data/docker/volumes/po_infra_media_data/_data/data_hub_raw_media/ 内的旧 SSD 文件
```

保留这个根目录及其 inode，后续恢复工具仍用它核对迁移身份；不删除 named volume，不删除父级 `/app/media` 中的 agent_runs、uploads 等数据，不碰数据库/队列，不清理另一卷 `delta_59202_media_data`。本页没有 `rm` 或 volume 删除命令。

NAS 无独立备份的现状保持不变。本轮按用户决定暂缓 OSS；不将云备份或重做全量 SHA256 增加为新的迁移门槛。

## 本地验证

89 项 NAS 测试通过。新加 5 项覆盖切换完成条件、其他卷/bind 父路径消费者、服务健康拒绝、真实文件清单与内容保留、换行文件名、`.tmp` 和其他 media 子目录保留、私有权限、符号链接拒绝和删除参数拒绝。测试没有连接服务器或 NAS；实际分配空间由服务器 GNU du 读取，本机 macOS 没有运行这一 Linux du 命令。
