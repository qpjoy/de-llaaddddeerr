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

它不扫描 NAS/SSD 媒体，不创建候选、不写报告、不复制、不清理、不重启业务。无需先安装恢复快照即可诊断。`snapshot_stable=true` 或退出 0 只表示本次诊断一致，不是迁移或删除许可。初次诊断中 `existing_repair_images_match=false` 表示工具当时仍限定旧版镜像；下面记录本次回传审核及针对确切新镜像的适配。缺少删除收据不证明从未手工删除。

回传 `nas_repair_inspect_service` 和 `nas_repair_inspect_complete` 摘要。失败时保留错误，不修改旧收据或镜像常量绕过检查。

## 新版本诊断已回传，下一步只读准备

用户回传的第二次事件摘要已确认：

- `snapshot_stable=true`、`review_items=[]`；十个当前容器均运行，Compose 与 live 匹配，Entrypoint/Cmd/User/WorkingDir 与历史启动方式一致。
- 九个应用容器均为 `sha256:f0b13dc7f35c2d317a48be2ff3b6ef97e62b8f007d32c0c8af422377d7b07446`。Web 启动脚本摘要为 `f68d58be0ead560c3b06eac4b7c79dfc845fb218fc48f1c704492783f07fa91b`，Worker 为 `fd211830a63045583a8c4917ba86d457a116f2d513872ae0552736a2041f4573`，与已审查脚本一致；无可写层应用代码差异。
- PostgreSQL `2ff6f5855d39…`、Redis `210770e5ecab…` 与此前切换是同一容器，运行且健康。检查没有读取数据库内容。
- 当前历史报告仍为 `po_infra_media_data-33e5abb193d04e7595251a5e6a6046ae`，清理计划未选用；`execution_records_ssd_reclaim=false`、`reclaim_evidence=[]` 仅说明本报告下没有找到工具清理证据。

工具据此将本次修复限定为确切的 f0b13dc7… 镜像；每次 prepare 仍重新检查当前 Compose、脚本、启动字段、数据库身份和源消费者。复制/切换仍核对本次基准，不接受早前 45f5… 镜像的修复报告，不改变旧报告、NAS 标记或清理选择。

同步本次 mx-static 文件后，在服务器 mx-static 目录执行：

```bash
bash scripts/manage.sh nas infra repair prepare
```

此命令只读两侧媒体，创建新的 root 私有差异报告。目录元数据完整扫描；只对受数量/字节预算约束的共享差异文件读取内容。它不复制、不重启、不切换、不删文件，无传输限速设置。回传新的私有报告**路径**、分组统计及结束结果即可，不要贴私有配置文件。之前的 5,289 文件和 copy 成功收据不代表这次新增内容已补齐。后续复制继续不限速，但要使用这次新报告。

## 新差异准备已通过，下一步在线补齐

服务器已成功生成 `/var/lib/mx-static/nas-repair/infra-1dfa9196bd8c4e32823ca73276630c74`：198,783 个共享文件 quick-check 一致 / 500.33 GiB；SSD 独有 864 个 / 0.62 GiB（无 tmp）；NAS 独有 2,359 个 / 1.18 GiB；1,681 个仅属性不同 / 0.68 GiB；101 个共享差异文件哈希一致 / 0.16 GiB，双侧实际核验范围约 0.31 GiB。这是在线快照，未复制、切换或授权删除。

在服务器 mx-static 目录执行：

```bash
bash scripts/manage.sh nas infra repair copy /var/lib/mx-static/nas-repair/infra-1dfa9196bd8c4e32823ca73276630c74
```

此入口默认不限带宽，无需也不接受额外 `--unlimited`。仅补齐本次清单中的 SSD 独有文件，保留已存在的 NAS 文件与属性；不停止业务、不删除 SSD、不切换挂载。命令返回后台 unit 及 journalctl 查看命令，提交不等于成功。需要最终 `nas_repair_copy_complete` 中的 `attempt_directory`、`copied`、`already_present` 和结束状态，才能选择本次成功尝试；若源文件或部署发生变化则保留错误分析，不修改报告跳过检查。

复制期间避免再次发布或重建 infra，以保持本次部署基准。复制完成后仍需落实发布入口的 NAS 约束、维护窗口停写复核及切换；不能直接删除 SSD，也不能使用之前的修复尝试目录。

## 已确认的两个发布入口

两张用户截图均在 `/home/lcy/test/Delta/mx_data` 执行 `./scripts/deploy_public_ghcr.sh --local-build`：

| 环境 | 关键参数 | 当前 Docker 项目 / 媒体父卷 |
| --- | --- | --- |
| infra / part1，图 2 | 无 `--instance`，`--port 59201`，公开地址 `http://delta.mxinfo-inc.cn` | `mx_data` / `po_infra_media_data` |
| delta / part2，图 1 | `--instance delta-59202`，`--port 59202`，`--db-port 55432`，公开地址 `http://dev.delta.mxinfo-inc.cn` | `delta_59202` / `delta_59202_media_data` |

端口用于说明现场，存储关联必须以核对后的项目/卷身份为准。按照本地同名发布脚本的默认规则，infra 使用 `deploy/.env.ghcr`，delta 使用 `deploy/.env.delta-59202.ghcr`；环境变量可覆盖默认值，不能靠截图推断服务器实际文件内容。

本地只读审查发现 `compose()` 显式追加 `docker-compose.ghcr.yml`、local-build 文件，以及启用数据库端口时的 db-port 文件，没有添加 NAS 声明。这与服务器 Compose 标签及 SSD 实际挂载一致；不能据此推断具体执行者。原命令中的 `--no-pull` 不声明媒体存储位置。

若保留这两条用户命令，发布脚本需一次性接入存储约定；业务 API 不需要感知 NAS。接入应覆盖以下范围，目前**尚未实现或安装**：

1. 在统一 `compose()` 构造处为已切换项目始终携带纯存储覆盖，包括 `config/build/up/run`；不复用迁移报告中的旧镜像、旧环境或维护启动配置。两个实例分别选择各自卷，delta 正式切换前不得强制使用 infra 的 NAS 卷。
2. 发布前核对项目、登记、外部 NFS 卷及合并挂载。已登记项目缺少必需声明或 NAS 卷时必须失败，不能把“文件不存在”解释为允许 SSD；`.env` 的普通业务值仍由应用管理，改变项目/媒体卷身份则需重新核对。
3. 原脚本的 `find /app/media ... chmod` 会递归遍历子挂载，必须排除 NAS raw-media 子树，不能只加一个 `-f` 后照旧运行权限修复。临时 `compose run web` 也必须使用相同的 NAS 子挂载和 nocopy。
4. 发布后核对全部媒体消费者的实际 NFS 来源；存储接入本身不得删除 NAS 文件或数据库/队列，不创建空数据卷替代已有存储，不自动退回 SSD。

应用正式发布仍包含数据库迁移、索引/任务维护等自身步骤；本地 Web 启动脚本还调用 `bootstrap_admin`，因此 mx-static 的媒体维护入口不能代执行整个发布脚本并承诺没有业务副作用。现有 `nas infra deployment recreate` 是媒体维护路径，不能直接替代完整正式发布。只修改 mx-static 且继续原封不动调用当前应用脚本，现有恢复 timer 无法把 NAS 声明自动塞进该脚本的 Compose 调用；本轮未改 po-infra 源文件，也未安装 Docker 全局拦截。

## 后续修复边界

本地 `profiles.json` 已取消旧清理清单的选用（`plan=null`），保留切换报告、清单文件、NAS 标记和独立存储登记。此前已验收清单只是历史证据，不能继续用于本次新写入后的删除。

先审查当前版本，再生成新的 SSD/NAS 差异清单；保留 NAS 独有数据和原属性，禁止同名覆盖。补齐新确认的 SSD 独有文件后，在维护窗口停写复核、使用当前版本受控切换。不能先加挂载把新 SSD 文件遮住，不能重复旧 rsync/cutover，也不能退回旧应用镜像。

再次切换前需落实上述发布入口的 NAS 声明与权限保护。现有恢复 timer 和只读检查没有拦截外部原始 Compose 重建。新版本审查和新差异准备已经通过，数据补齐、部署入口约束及再次切换尚未完成，不能把本次工具交付写成生产修复成功。修改范围限 mx-static，保护 MX-H2I 登录、数据库/队列及其他项目。

本地验证：313 项 NAS 测试通过，覆盖新镜像生成候选、旧镜像混入拒绝、旧修复计划在复制和切换入口拒绝且不访问 NAS，以及原有逐文件/数据库/恢复保护。模拟和本地文件测试不代表服务器已经修复。
