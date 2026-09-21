# Delta 原始媒体迁移方案（现场方案 v6，2026-09-22）

状态：已读取本机 Delta_Pub 全部现有分支快照、远端 po-infra 的 feat/new_delta 分支提交 cdf3e649d685ba708daae83ef8b81318d2bcfa24（2026-09-18）及用户提供的服务器输出；没有连接或修改服务器。架构、迁移对象和验收步骤已确定。最新回传已对应关键代码哈希、镜像身份和两套 env-file；线上 tasks.py 与本地不同；NAS 的 4 KiB 写入/基础属性/0:0 owner 保留探测已通过，下一步小批复制验证。详见 [现场结论](../evidence/2026-09-22-live-findings.md)。本文不是可以直接执行的一键迁移脚本。独立权限探测、小批复制等门槛通过后，才进入全量复制；停机和切换另按验收步骤推进。

用户已明确要求：先复制到 NAS，再切换；迁移期间保留原 Docker volumes 和旧媒体。本方案不执行源数据删除，空间回收仅列为以后单独决定的阶段。

## 1. 已确认的范围

| 线上实例 | 原 named volume | 原始媒体目录此前 du 占用 | NAS 目标（拟建） |
| --- | --- | --- | --- |
| delta_59202 | delta_59202_media_data | 930 GiB | /mnt/nas/mx-internal-server/data/docker/media-volumes/delta_59202_media_data/data_hub_raw_media |
| mx_data | po_infra_media_data | 498 GiB | /mnt/nas/mx-internal-server/data/docker/media-volumes/po_infra_media_data/data_hub_raw_media |

来源目录分别为 `/data/docker/volumes/<卷名>/_data/data_hub_raw_media`。两个原始媒体目录约 1.39 TiB，占两个卷几乎全部空间；du 输出经过取整，不应据此计算精确回收量。源卷 Driver=local、Options=null。整个卷不可删除，卷内其余 agent 目录仍需留在 SSD。

NAS 为 `nas-storage:/volume1/data1`，当前 NFSv3 挂载 `/mnt/nas`。最新 layout 报告可用 30,956,811,976,704 bytes（约 28.16 TiB）；主机子目录为 1003:10 / 2750，拟用 data/ 及两套目标不存在。导出根目录 uid/gid=0:0、mode=777 **不证明**应用 UID/GID 可写或 rsync 可保留 owner/ACL。存储池健康、配额、快照和独立备份状态仍待 NAS 管理端确认。

主机有 128 个逻辑 CPU、251 GiB 内存；最新 /data 已用 97%、剩余 58G，inode 已用 3%。保留旧副本不会释放空间；预复制和校验期间需限制媒体增长，不能在 /data 额外打一个 1.4 TiB 备份包。按 50 MiB/s 粗算，单遍复制 1,428 GiB 就需约 8 小时，校验再读两端，实际耗时取决于文件数量、NFS 和业务竞争。

## 2. 仓库、分支与线上部署不匹配

本地仓库 `/Users/qpjoy/workspace/mingxi/Delta_Pub`，origin=`mingxiinfo/Delta_Pub`，工作区干净。以下为本地 remote-tracking refs，未据此宣称远端没有更新：

| 分支 | 本地提交 |
| --- | --- |
| main / origin/main | 1e0eee6 |
| origin/customer/su-j | 62e37a4 |
| origin/customer/xiaobao | 444e894 |
| origin/customer/xidian | 3384b71 |
| origin/customer/zhililu | 5371986 |
| origin/customer/zhilu | 64f93b0 |

以上分支均未检出 `data_hub_raw_media`。main 的 `scripts/verify_distribution.sh` 明确禁止 data_hub 等完整平台模块及依赖；main Compose 只有 frontend/postgres/redis/web/worker，应用挂载 `/app/uploads`。su-j 有自己的媒体缓存逻辑，但不是这两个约 TB 级原始媒体库。`zhilu` 与 `zhililu` 也不是同一分支。

线上大卷实际所属：

- mx_data：`ghcr.io/mingxiinfo/po-infra:feat-new_delta`。
- delta_59202：`po-infra-local:delta-59202-feat-new_delta`。
- 两者都引用 `/home/lcy/test/Delta/mx_data/docker-compose.ghcr.yml` 和 `docker-compose.local-build.yml`；delta_59202 另有 `docker-compose.db-port.yml`。

**镜像 tag 含分支名不等于已证明镜像提交；本地构建镜像也不一定来自服务器当前 checkout。** 先记录容器的 image ID、RepoDigest、OCI revision、Compose project/service/env-file 标签、服务端 HEAD/dirty 状态。部署无 OCI revision 时，需与运行镜像内相关源文件哈希比对。

用户补充后已拉取正确仓库 git@github.com:mingxiinfo/po-infra.git 的 feat/new_delta。其 Dockerfile 将 GIT_COMMIT/GIT_BRANCH/BUILD_DATE 写入环境和 /app/.build_info.json，并不保证有 OCI revision 标签，因此采集器也读取这些非敏感版本字段，以及运行容器中的关键源码 SHA256。`nas_docs/evidence/po-infra-cdf3e649-sha256.json` 保存本次审查的文件哈希供比对。

2026-09-22 再次核对用户本机 `/Users/qpjoy/workspace/mingxi/po-infra`：分支和提交一致，上述 7 个关键文件的 Git blob 哈希全部匹配。工作区中的两个修改来自克隆时 GetUserInfo.py/GetUserinfo.py/getuserinfo.py 大小写碰撞警告，本轮未重置或改动它们；生产迁移使用 Linux 上的卷，不能把 macOS 的 media/ 当作完整源数据。

根据最新目录截图，将此前拟定的 `/mnt/nas/delta-media/...` 布局更新为第 1 节的 `/mnt/nas/mx-internal-server/data/docker/media-volumes/...`。最新 layout 已证实 NAS 主机目录下有 shared_archives/shared_dir/shared_media，data/ 本身及拟用的子目录不存在。路径仍为拟用，只读审计脚本不会创建或覆盖；新增权限探测也只使用独立随机测试目录。

本次不改 Delta_Pub 分支，不用其部署脚本替换完整平台，也不把存储切换与拉取新镜像、构建、代码升级、数据库 schema 迁移混在一起。最终改动应落在真实完整平台的部署配置分支，并固定线上原镜像。

## 3. 推荐架构及应用代码检查

**多项目扩展调整：不再默认每实例维护 systemd 启动程序。优先验证 Docker 原生 NFS volume 的子卷挂载，长期采用 K8s PV/CSI；普通 Compose 初始挂载失败后的重试与 daemon 就绪延迟必须实测，不能只靠 restart policy 承诺自动恢复。详见 [统一存储方案](../operations/storage-platform.md)。**

保持所有容器中原来的父挂载：`<原卷> -> /app/media`（SSD）。新增子挂载：`<实例专用 NAS 目录对应的新 NFS named volume> -> /app/media/data_hub_raw_media`。NAS 目标物理目录不变；旧宿主机 bind 方式降为兼容备选。Nginx gateway 的父、子挂载均只读。数据库、Redis、staticfiles、agent 工作区、执行日志和运行附件继续使用原 SSD 卷。

这样保留现有文件路径和 URL，不需要为了换存储更改 Dockerfile。挂载会遮住 SSD 子目录中的旧数据，并不会移动或清理它；观察期内旧数据仍然占空间。必须给所有消费者加同一子挂载，否则会出现不同容器读写 NAS 与旧 SSD 两份库。

每套现有实例有 10 个消费者，其中以下 9 个可写：web、worker、beat、worker-agent-short、worker-agent-long、worker-agent-interactive、worker-agent-data-hub、worker-strategy-draft、chat-gateway；gateway 只读。最终名单必须以 live inventory 中的 Compose service 标签为准，不只凭容器名猜测。另查宿主机定时任务、脚本及 Kubernetes hostPath/PV 引用；Docker 的引用数不能证明不存在外部写入方。

### 3.1 已核实的应用行为

- `mx_data/settings.py:33-34` 固定 MEDIA_URL=/media/、MEDIA_ROOT=/app/media；不能只在 .env 新增 MEDIA_ROOT 就假定应用会读取该变量。
- `data_hub/media_storage.py:49,112,125-139` 把临时文件和最终文件都放在 raw_media/<media_type> 同一个目录，最终名为 SHA256+扩展名，用 os.replace 发布；数据库 RawMedia.local_path 保存相对路径，file_hash 保存 SHA256。整个 raw_media 子树一起挂 NAS 不跨越这段 rename 的文件系统边界。
- `data_hub/api.py:2452-2478` 从相对路径形成 /media/ URL；`deploy/nginx/templates/default.conf.template:13-19` 已直接 alias /app/media/。保留子路径后不需要批量改数据库路径或加一个新的静态服务器。这段现有 Nginx location 自身没有鉴权指令；保持现有外层访问控制，不因迁移扩大公网访问面。
- 这个下载链路当前直接写目标目录，切换后临时下载也写 NAS；不会自动获得“SSD 下载/处理后归档”的工作流。后续再改为 SSD 暂存时必须按下述同文件系统发布规则处理，不能只改 mkstemp 的 dir。
- 本机完整 checkout 还确认 `spiders/media_storage.py` 有独立的 `/shared_media` 存储链路，与 data_hub_raw_media 不同。NAS 的 shared_media 目录是否属于它尚未证明，本次不合并、不迁移它。
- 本地基准 `data_hub/tasks.py:74-106` 的下载任务在 tasks 队列，soft/hard 时间限制分别 120/150 秒；最新采样线上 tasks.py 哈希不同，路由和限制必须以运行版本重新核对。不要误以为只停止 worker-agent-data-hub 就停止了媒体下载；普通 worker 消费 tasks。NFS 卡顿可能与时间限制、downloading 状态的恢复相互影响，需验证。
- `scripts/run_web.sh:4-6` 启动时会执行 migrate、bootstrap_admin、collectstatic；`run_worker.sh:4-5` 默认会 recover_stale_agent_runs --requeue。必须固定原镜像、核对待执行迁移并保留原环境，切换前先做数据库检查点；不能把重建容器当作完全没有数据库副作用。
- `docker-compose.ghcr.yml:557-565` 用 MEDIA_VOLUME_NAME 等变量显式命名卷，默认媒体卷为 po_infra_media_data；delta_59202 尤其不能漏掉它原来的 env-file。`deploy_public_ghcr.sh` 还会 pull/build、初始化模型/任务并更新配置，本次不调用这个通用部署脚本。

### 3.2 临时文件占用风险：隔离复现已与线上关键代码对应

`media_storage.py:127-129` 只在目标不存在时 replace；目标已存在时，成功路径没有删除新下载的 tmp，清理代码仅在异常路径。用原函数、模拟 HTTP/数据库、独立临时目录做了两次相同内容的成功下载，结果为 **1 个正式文件 + 1 个遗留 raw-media-*.tmp**。最新报告中，两套实例各 web 和 worker-agent-data-hub 的此文件哈希均与该代码一致，确认采样运行代码存在相同泄漏路径。两个 raw_media 目录合计 1,426.04 GiB，其中 tmp 为 960.46 GiB（67.35%）；但不能断言全部 tmp 都由该缺陷造成或全部可删。函数也没有显式 fsync；本次不能宣称数据落盘持久性已额外加强。

用户已运行 `scripts/nas-audit.sh media`：两次扫描均无错误，未发现多硬链接或跳过路径；精确统计见 [现场结论](../evidence/2026-09-22-live-findings.md)。这个命令用于统计每个卷中临时文件、其他文件、超过 24 小时临时文件的数量/逻辑字节，以及最大的 20 个文件。它只扫描 SSD 元数据，跳过软链接和其他设备，不读取文件内容或删除文件。临时文件年限不能证明无人使用，正常下载/中断任务也可能留下它们。按用户要求第一份预复制保留全部文件，不凭名称排除 .tmp，也不顺带修复线上程序；后续如需清理，先比对正式文件哈希、数据库引用和在途任务，再独立处理。

关键文件匹配后仍需验收的边界（tasks.py 差异、线上脏工作区和其他入口并未因此消失）：

1. 原始媒体下载/上传入口、命名和去重规则、数据库保存绝对路径还是相对路径、Nginx alias/鉴权/Range 行为。
2. 临时下载和最终文件分别写在哪里；对跨 SSD/NFS 的 `os.rename`、`os.replace`、`Path.rename`、硬链接、目录交换等操作做检查。保持相同字符串路径并不保证跨挂载边界原子操作仍可用。
3. 若需要 SSD 暂存：先在 SSD 下载/处理，随后复制到 NAS 最终目录内的临时文件，完成校验/按持久性要求 fsync 后，在 NAS 同一文件系统内 rename 发布，再更新数据库完成状态。原子可见性不等于断电持久性，流程需可重试、失败不得提前清除源文件。
4. 递归清理、`rmtree`、整个 raw_media 目录替换或 chown 会受到挂载点影响；核对所有入口，含管理命令和定时任务。
5. 文件锁、SQLite/LMDB、可变索引等若藏在 raw_media 内，先拆出到 SSD。检查软链接和跨迁移边界硬链接，不能只复制链接后假定目标可用。

阶段一只做存储位置切换。计算仍在服务器，但直接打开 NAS 文件时，读取、解码输入、拖动播放仍受 NFS 影响；大内存页缓存不等于有容量约束和淘汰策略的 SSD 缓存。后续根据观测再做独立 SSD 暂存/热点缓存改进。

mx-static 可继续部署在独立目录，不能让它同时管理、淘汰 Delta 的 raw_media 目录。此次不改变业务的文件归属、授权或下载 URL。

## 4. 实施前检查门槛

- deployment 已回传；[现场结论](../evidence/2026-09-22-live-findings.md) 固定本次 image ID、env-file、服务与版本。服务器 d29a0bc2 checkout 有未提交修改，运行 tasks.py 不同于本地 cdf3e649，不使用本机代码盲目重建。正式切换前检查库存是否变化；kubectl 无权限/无命令不等于没有 Kubernetes 消费者。
- 从真实部署上下文取得两套实例的 env-file 路径与完整 Compose 文件顺序。原环境文件只在服务器保留，不上传凭据。分别渲染最终 Compose，核对父卷名称、子目录、端口、镜像、网络及 DB/Redis 均正确；只存储改动进入 diff。
- 确认 Docker/Compose/systemd/rsync 版本及 SELinux 策略；不能用最新文档假定 EL8 上每个选项可用。NFS 的 SELinux 访问应按实际策略配置，不对整个导出盲目加 `:Z`、不关闭 SELinux。
- NAS 管理端确认存储池/磁盘健康、配额、空闲容量和备份。用户已运行 `sudo bash scripts/nas-probe.sh permissions --write-test`，四项通过且测试对象已清理。现在使用 [小批复制工具](../operations/sample-copy.md) 验证真实文件内容和属性，之后再验证实际容器 UID/GID、Nginx 读取、代表性大文件和并发；小探测不能替代这些验收。
- 用代表性小批文件做复制、权限/校验和验证，再开始全量。NFS root squash 可能阻止 chown，不能忽略 rsync 的权限错误；按真实 UID/GID 和 NAS 导出策略解决，不默认 chmod 777 或递归改写源数据权限。
- 确定两个实例的业务优先级与维护窗口，一次只切一个。若业务风险相当，可先试 498 GiB 的 mx_data；不能仅因它较小就断定可随意停机。

## 5. 开机、NAS 晚启动与运行期中断

此前现状：fstab 条目已注释，用户已取得取消注释命令但尚未回传执行结果；`20-requires-nas.conf.bak` 不在 Docker 已加载的 drop-in 中，NeedDaemonReload=no。当前挂载是存量挂载，不能依赖它跨重启保留。未发现 mnt-nas.automount。用户已明确暂不恢复此 Docker drop-in，Docker 全局继续独立于 NAS。当前默认方向和原生启动能力边界见 [统一存储方案](../operations/storage-platform.md)；[旧 host-bind 启动设计](../operations/boot-and-recovery.md) 仅作备选。

宿主机管理/迁移工具所用的候选 fstab（Docker 原生 NFS volume 不依赖此路径）：保留现用 NFSv3 参数，增加 nofail/automount，在维护窗口确认本机 systemd 支持后使用；不在生产写入中为了应用配置而卸载/重挂。

```fstab
nas-storage:/volume1/data1 /mnt/nas nfs rw,_netdev,nofail,x-systemd.automount,hard,vers=3,proto=tcp,rsize=524288,wsize=524288,timeo=600,retrans=2,sec=sys,x-systemd.mount-timeout=60s 0 0
```

以下独立 systemd 启动/监督要求仅用于旧 host-bind 兼容备选，**不作为多项目默认实现**。若最终选择该备选，它应满足：

- 在服务启动前拉起 mount；检查实际 mountpoint、fstype=nfs/nfs4、export、NAS 根的预先登记标识，以及该实例已完成校验的就绪记录。标识放在媒体目录外，避免被 Nginx 暴露、被 rsync 覆盖。
- 所有相关容器 Compose 设置 `restart: "no"`，避免现用 unless-stopped 在 Docker/系统重启时绕过检查。systemd 负责受控重启和失败重试；如果采用前台 Compose 监督，需验证单容器退出、Docker 重启时 supervisor 的退出/回收/恢复行为，不用一个执行 `up -d` 后永远 active 的 oneshot 假装进程监督。
- DB/Redis 留在独立的本地启动路径；媒体 supervisor 不依赖 NAS 就启动它们是允许的。已有混合 Compose 不必拆业务代码，但最终命令必须明确选择媒体服务，禁止误停数据库。
- 明确支持失败重试。`RequiresMountsFor` 失败时服务可能根本没有执行，单有 `Restart=on-failure` 不保证 NAS 晚到后重试；应配 timer 或具有重试的受控 launcher，且防止重复启动和并发检查。具体 unit 需按服务器 systemd 版本生成并验证。
- 子挂载使用长语法 `create_host_path: false`；这只能避免创建不存在的源目录，不能识别一个已经存在但未挂 NAS 的本地目录，仍需以上检查。NAS 挂载期间不得卸载/换源；若挂载被替换，重新检查并重建消费者，不假定旧容器自动切到新 mount。
- runtime NAS 断线：hard NFS 可能让已发出的 I/O 持续等待，systemd timeout/普通 shell timeout 不保证终止 D 状态进程。停止接收新任务、告警并修复 NAS/网络，不自动退回旧 SSD 目录，否则可能双写分叉。网络恢复与重新挂载是不同场景，分别验证恢复方式。

`hard,timeo=600,retrans=2` 不是最多 120 秒就报错；mount-timeout 也不是文件读写超时。不要以改为 soft 规避等待而牺牲文件完整性。

## 6. 预复制、停写与最终校验

以下命令仅描述经过检查后要执行的动作；本方案没有自动执行它们。所有多行脚本都通过 `bash script.sh` 或 `sudo bash <<'BASH' ... BASH` 运行，避免当前交互 zsh 不将 `#` 当注释的问题。

1. 冻结本次部署版本、记录镜像身份和原配置。先阻止会让剩余 58G 快速耗尽的批量采集，规划单批带宽和现场观察；不顺带执行 prune。
2. 创建目标实例独立目录及迁移记录，先验证确实位于预期 NFS 导出。所有准备、复制和检查都经挂载保护，不允许 mkdir 在未挂载的 `/mnt/nas` 上静默落到本地。
3. 推荐通过已经审核且固定镜像的复制工具容器挂源 named volume 为只读、NAS 目标为可写；源卷必须先 inspect 存在，避免拼错名称创建空卷。只复制其中 raw_media 子目录。工具镜像及 rsync 支持在切换前准备，不现场拉取任意 latest 镜像。不直接重排 Docker 的 `_data` 或做宿主机覆盖挂载。

   如果“复制一份”还希望包含整个媒体卷，可另外在 NAS 的迁移备份目录保存完整卷副本；这两个卷除 raw_media 外的数据量很小。完整卷备份不作为应用的新 `/app/media` 挂载，且在线复制 agent 文件仍需停写后的最终同步才形成一致检查点。无论复制范围如何，原卷和原始媒体均保留。
4. 预复制可以在线限速进行；用同一 job 独立保存日志及退出码，任何 vanished/权限/读写错误均记录并解决，在线副本尚不是一致备份。示意：

```bash
# /source 为原 named volume 的只读挂载；/target 为本实例 NAS raw_media 目录。
# 先核实确实需要且支持硬链接、ACL、xattr；下面不盲目添加 -HAX。
rsync -a --numeric-ids --info=progress2 --bwlimit=51200 /source/data_hub_raw_media/ /target/
```

5. 停写窗口先关闭入口及外部生产者、停止 beat，依据真实 Celery 配置/长任务状态选择完成在途任务或受控重试；不能只看容器退出码就断言任务没有丢失。待任务稳定后停止所有 9 个可写服务，gateway 也切到维护入口或停止，保证验证期间没有新流量。确认宿主机/Kubernetes 无其他写入。不要 `down -v`，不清空 Redis 队列，也不停止整个 Docker daemon。
6. 保留 PostgreSQL 运行，使用原生一致备份（如 pg_dump），与媒体停写检查点一起记录。队列/任务状态也要纳入恢复说明。备份不写入即将耗尽的 /data；优先独立备份介质，若先落 NAS，仍需独立备份策略和访问保护。pg_dump 完成不等于恢复验证通过；至少检查归档可读，并安排隔离数据库恢复演练。
7. 最终同步使用 checksum，避免在线预复制中的同大小/同时间戳变化被 quick-check 漏过：

```bash
rsync -ac --numeric-ids --info=progress2 --bwlimit=51200 /source/data_hub_raw_media/ /target/
rsync -anc --numeric-ids --delete --itemize-changes /source/data_hub_raw_media/ /target/
```

最后一条**必须保留 `-n`**：`--delete` 只在 dry-run 中报告目标额外文件，实际不删除。同步命令不带 delete/inplace/remove-source-files。目标额外文件可能是在预复制期间被源端删除的内容，须核对清单后移至 NAS 隔离区，不能让它们未经评估重新暴露给业务；再校验至无差异。属性差异也必须解释，不能把无内容差异当成权限正确。若使用 H/A/X，最终同步与校验都保持相同选项。

8. 要求最终退出码均为 0、内容/文件集合/软链接和所需元数据无未解释差异，再出具两端相对路径、文件数、逻辑字节及内容校验记录。`du` 实际块数可因不同文件系统而不同，不能只比 du 或文件数量判断完整。校验期间源和目标保持停写。

若停写窗口不足以完成全量 checksum，需先从真实代码证明已完成媒体不可变，再设计预先校验的不可变批次与最终增量；当前不能预设这个条件成立。

## 7. Compose 切换与业务验收

优先验证 `nas_docs/templates/compose.delta-raw-media-nfs-volume.yml.example`：保留父卷、添加 external NFS 子卷及 nocopy，继承原 restart policy，不定义/重建 PostgreSQL 或 Redis 卷。每个实例使用独立 DELTA_NAS_RAW_VOLUME_NAME，新卷的 type/device/options 必须与第 1 节 NAS 目标对应，并已完整校验。

旧 `compose.delta-raw-media-nas.yml.example` 仍用 DELTA_NAS_RAW_MEDIA_PATH 和宿主机 bind，仅作兼容备选；需要配套控制入口。两份覆盖文件互斥，不能叠加。

切换前的配置检查：

- mx_data 必须保留 po_infra_media_data，delta_59202 必须保留 delta_59202_media_data；数据库 named volume 也与原始 inspect 完全一致。
- 所有 10 个消费者拥有 NAS 子挂载，gateway 子挂载为 ro；其余挂载不变。
- 原生 NFS 候选必须复查 external 卷确实为 NFS，不能仅凭名称判断；验证 NAS 允许直接挂载该导出子目录，不改旧 media_data 卷的 driver 定义。
- 新配置 service 名必须等于 live Compose labels。完整文件列表按原顺序加载，迁移覆盖文件放最后，复用原 env-file 和 project name。
- 原镜像 ID 不变；不 build/pull、不运行 Delta_Pub 的部署脚本。检查真实 entrypoint 是否会在重建时自动迁移 schema 或修改文件，必要时先处理。
- 在本机 Compose 版本验证 merge 后的结果，不能只肉眼检查单个覆盖文件。`${...:?}`、nocopy/external 或 bind 备选的 create_host_path 等不支持时先调整方案，不静默退化为会创建目录的短语法。

按已经完成启动故障验证的平台部署流程重建媒体消费者（普通 restart 不应用新挂载；选择 bind 备选时才使用其配套 supervisor）。先以维护模式逐项验证：容器实际 mountinfo、路径来源、旧文件读出 hash、真实 UID/GID 新文件写入、跨目录发布、worker 处理、删除策略、Nginx 私有鉴权、Content-Length、HTTP Range/206、拖动播放。测试写入用独立测试对象，验证没有写到被遮住的 SSD raw_media。再开放入口/beat/任务生产者，观察错误率、延迟、D 状态、RPC 重传、磁盘增长和任务堆积。

用测试栈先验收“NAS 先启动”“主机先启动/NAS 延迟”“NAS 缺席时拒绝服务且不落盘”“Docker 重启”“运行期 NAS 断线并恢复”，通过后才安排生产维护窗口验证重启。不能为了演练直接对正在承载业务的 /mnt/nas 强制卸载。

## 8. 回滚和以后单独决定的空间回收

切换前：SSD 始终为权威源；复制失败只暂停迁移，不破坏原服务数据。

切换后尚无新写入：停止媒体栈，恢复原部署配置与原启动策略，确认子挂载已移除后重建。数据库不因存储回滚而恢复旧 dump。

切换后已有 NAS 新写入：先停写，NAS 是权威源；比较新建、修改和删除清单，在空间足够且校验通过后将增量合回 SSD，保留冲突副本并处理删除语义，再切回。/data 最新剩余 58G，不能假定一定有空间；不足时优先修复 NAS 服务或加临时存储。NAS 不可访问时不能宣称无损切回旧 SSD；必须等待可读或依据业务确认的备份/RPO 恢复。

旧数据清理单独进行，绝不删除整个 named volume。先完成业务观察、独立可恢复备份、检查所有容器确实使用 NAS，确认没有外部消费者和旧文件句柄。通过受控挂载原卷的维护工具只处理旧 raw_media 子目录内容，防止命令路径解析到 NAS 子挂载；保留父卷与必要挂载点。没有把自动删除命令放进本方案。

NAS 同池 snapshot 可用于快速撤销误操作，但不是独立备份。旧副本留在 SSD 时仍占 1.39 TiB；删除后才可能释放相应块空间，硬链接或未关闭句柄会影响实际回收。第二套实例复制/切换沿用第一套验收结果，但重新完成其自己的停写、数据库检查点、内容校验与路径核对。

## 9. 当前交付和下一步

已交付架构、明确源/目标、迁移/回滚步骤、Compose 覆盖模板、源码基准、现场证据和探测工具。用户已回传三份只读诊断，NAS 空间和目标无重名已确认，关键下载代码泄漏与线上采样一致；临时文件不自动清理。

用户已回传权限探测，四项全部通过；无需重复。下一步提交并通过 Git 更新服务器上的 mx-static 后，先运行：

```bash
sudo bash scripts/nas-sample-copy.sh po_infra_media_data --copy-test
```

退出码 0 且最后 passed=true 后，再对 delta_59202_media_data 运行同一工具。每次最多 8 个文件/选择时 256 MiB，rsync 限速 10 MiB/s，校验内容与基础属性并保留独立测试副本，不创建正式目标、不删除、不切换。详见 [小批复制说明](../operations/sample-copy.md)。NAS hard I/O 卡住时不要并发重试。

实际全量复制入口与最终启动恢复策略仍待后续实施：小批真实文件复制、原生 NFS volume 的现场故障测试和容器访问尚未完成。两卷样本通过后，按已验证的权限/复制参数建立独立目标并准备全量预复制全部 raw_media（含 tmp）。预复制可早于正式切换，停写完整校验、备份与所选平台的启动/故障恢复验收必须在切换前完成；不提供源数据删除脚本。

方案、模板和脚本统一维护在 mx-base/mx-static，随 Git 提交分发。服务器实际输出、现场环境配置和迁移检查点只写入已忽略的 reports/ 或 nas_docs/local/，不提交凭据或运行报告。不上传压缩包、不从本机复制业务媒体，也不修改 Delta_Pub 或 po-infra 当前工作区。

本地验证：入口和诊断代码通过 Bash 与 Python 3.6 语法检查；部署采集器用模拟 Docker 数据确认只输出白名单环境字段；媒体扫描器在临时目录验证统计、跳过软链接和拒绝 NFS 源。使用真实 po-infra Compose 文件及本地 Compose v2.34.0，分别验证两套实例覆盖合并：10 个媒体消费者均增加正确子挂载，gateway 只读，原挂载/镜像/DB/Redis 定义保持不变。最新现场回传已对应运行镜像和关键文件，NAS 的小文件写入/0:0 owner 保留也已由用户验证；Linux 上最终 Compose 合并、代表性复制、容器权限及业务恢复仍待现场验收。新增写探测经过挂载不符、设备不符、软链接、chown/fsync 失败、只清理自身对象的本地回归；这些测试不连接 NAS。临时文件泄漏复现使用原函数和模拟 HTTP/数据库，未改项目应用代码。

参考：[Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)、[Compose volumes](https://docs.docker.com/reference/compose-file/services/#volumes)、[Compose merge](https://docs.docker.com/reference/compose-file/merge/)、[Docker restart](https://docs.docker.com/engine/containers/start-containers-automatically/)、[systemd mount](https://github.com/systemd/systemd/blob/main/man/systemd.mount.xml)、[NFS](https://man7.org/linux/man-pages/man5/nfs.5.html)、[rsync](https://download.samba.org/pub/rsync/rsync.1)。文档语义须与现场旧版本一起核对。
