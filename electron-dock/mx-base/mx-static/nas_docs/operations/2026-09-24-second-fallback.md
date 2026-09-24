# 9 月 24 日 11:04 重建后再次回到 SSD

## 已确认事实

17:08 起的现场回传证明，infra 十个媒体服务均缺少原生 NFS 子卷、nocopy 声明和内核 NFS 子挂载，媒体路径由 `/app/media` 的 XFS 父卷提供，设备 `/dev/nvme0n1p1`。此前 SSD 回收就绪状态不再适用。

- 九个应用服务镜像从 `45f5a0e5cae63bd1bc6215bcdbbe6531ba149ccc86dc47e11fcb55d1a9f5e0bf` 变为 `f0b13dc7f35c2d317a48be2ff3b6ef97e62b8f007d32c0c8af422377d7b07446`；gateway 仍为 `6769dc3a703c719c1d2756bda113659be28ae16cf0da58dd5fd823d6b9a050ea`。
- 十个容器于 11:04:11–11:04:39 新建；部署目录仍为 `/home/lcy/test/Delta/mx_data`，Compose 标签只列 `docker-compose.ghcr.yml` 和 `docker-compose.local-build.yml`。
- 结合实际挂载，确认这次重建没有保留 NAS 子挂载；仅凭标签不能确定执行者或具体命令。
- `/data` 99%，约 34 GiB 可用。恢复检查因媒体挂载不符而阻止 infra；安装快照与当前声明不一致。
- 回传的最后 80 条 `mx-nas-part1-reclaim-*` 日志均为只读 `reclaim-check`，其中的 NFS `ok=true` 属于旧容器。没有实际 `reclaim_result` / `ssd_files_reclaimed`；不能据此排除其他时间、入口或手工删除。
- `20-requires-nas.conf.bak` 不在 Docker 已加载的 drop-in 中，`RequiresMountsFor=` 为空，`NeedDaemonReload=no`。它控制宿主机挂载启动依赖，不给容器添加媒体子挂载，恢复它不能修复本次问题。

## 当前只读入口

同步本次 mx-static 改动，在服务器 mx-static 目录执行：

```bash
bash scripts/manage.sh nas infra repair inspect --json
```

该命令检查当前 SSD 媒体消费者、Compose 与运行容器的一致性，比较 Web/Worker 启动脚本 SHA256、启动字段及可写层应用代码修改；核对 PostgreSQL/Redis 容器身份和健康状态，不查表、不操作队列。读取当前本地切换报告下的 SSD 删除完成收据和删除意图日志，检查前后部署文件、容器及收据是否稳定。只输出差异键名和摘要，不输出 env 值或完整配置。

它不扫描 NAS/SSD 媒体，不创建候选、不写报告、不复制、不清理、不重启业务。无需先安装恢复快照即可诊断。`snapshot_stable=true` 或退出 0 只表示本次诊断一致，不是迁移或删除许可。新镜像的 `existing_repair_images_match=false` 是预期结果；原修复执行路径继续拒绝未经审核的新镜像。缺少删除收据不证明从未手工删除。

回传 `nas_repair_inspect_service` 和 `nas_repair_inspect_complete` 摘要。失败时保留错误，不修改旧收据或镜像常量绕过检查。

## 后续修复边界

本地 `profiles.json` 已取消旧清理清单的选用（`plan=null`），保留切换报告、清单文件、NAS 标记和独立存储登记。此前已验收清单只是历史证据，不能继续用于本次新写入后的删除。

先审查当前版本，再生成新的 SSD/NAS 差异清单；保留 NAS 独有数据和原属性，禁止同名覆盖。补齐新确认的 SSD 独有文件后，在维护窗口停写复核、使用当前版本受控切换。不能先加挂载把新 SSD 文件遮住，不能重复旧 rsync/cutover，也不能退回旧应用镜像。

再次切换前需明确发布入口如何固定携带 NAS 声明。现有恢复 timer 和只读检查没有拦截外部原始 Compose 重建。新版本审查、数据补齐、部署入口约束及再次切换尚未完成，不能把本次工具交付写成生产修复成功。修改范围限 mx-static，保护 MX-H2I 登录、数据库/队列及其他项目。
