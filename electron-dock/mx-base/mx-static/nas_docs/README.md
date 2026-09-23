# NAS 迁移运维入口

最新现场（2026-09-24）：infra 曾因后续重建遗漏 NAS 覆盖而回到 SSD；现已完成双侧补齐和当前版本修复切换，新成功报告尾号 `33e5abb193d04e7595251a5e6a6046ae`，十个媒体服务已运行在 NAS，数据库/Redis 保持原 ID。用户尚未全部检查业务；恢复安装和新清理前核验待回传，SSD 保留。下一步见 [恢复登记与只读清理前核验](operations/part1-union-reclaim.md)。`nas infra storage check` 不能代替外部发布启动拦截，重启/重装/断电仍无实际演练回执。

前序 `mx-nas-part1-repair-copy-0096322ad3.service` 已成功补齐 5,289 个 / 2,892,300,834 字节（2.69 GiB）：本次新增 181 个，已存在并核验 5,108 个。随后 `mx-nas-part1-repair-switch-194cd1338d.service` 完成[维护切换](operations/part1-repair-switch.md)，最终停写差异、实际 NAS 挂载、HTTP 媒体读取和应用写探测均通过。此前失败证据保留在[修复记录](operations/no-ssd-fallback.md)，不要重跑旧复制/切换。

用户最新顺序：**Part 1 完成 NAS 切换、业务验收、恢复基准登记和新 SSD 清理清单核验，保留 SSD 待日后删除；然后再将 Part 2 推进到同样状态。** Git 已改选新报告、取消旧清单；新只读核验入口已实现，尚待安装/核验回执及业务验收。Part 2 独立切换/回收执行能力仍未实现；详见 [完整迁移终点与当前阻塞](operations/no-ssd-fallback.md#完整迁移终点与当前阻塞)。

历史现场（2026-09-22）：恢复快照 `bd7b343be731926be9c8` 曾安装并启用已迁移项目统一策略；见 [成功回执](operations/systemd-239-recovery-fix.md)。这不是当前存储状态或真实重启演练的证明；业务验收及 SSD 回收仍待回执。

默认已改为中文易读输出，`--json` 保留原始事件。推荐 `nas recovery check` 统一检查全部项目，安装后用 `nas recovery enable --migrated` 启用已迁移项目统一模式；详见 [易读输出与统一恢复](operations/readable-recovery.md)。

先读 [生产数据安全约定](SAFETY.md) 和 [多项目 NAS 管理结构](operations/nas-platform.md)。推荐二级入口：`nas host ...`、`nas infra ...`、`nas delta ...`、`nas recovery ...`；旧 part1/part2 命令保留兼容。

统一入口已加入 `bash scripts/manage.sh nas`，配置和运维全部保留在 mx-static。查看 [统一管理、部署配置与开机恢复](operations/unified-management.md)。它自动定位成功报告和 NAS override；持久恢复须在服务器显式安装/启用，之前的 systemd-run 任务仍是临时任务。

第一卷历史上成功切换 NAS，但当前需先处理两侧增量并恢复正确挂载。旧 [SSD 回收流程](operations/part1-reclaim.md) 和 [只读清单](operations/part1-reclaim-plan.md) 保留作历史依据，不能按旧状态立即执行。[切换与恢复入口](operations/part1-cutover.md) 和下面的早期探测步骤保留作历史参考，不重复执行旧切换。

本目录记录部署证据、存储目录规划、迁移步骤和注意点。工具在 `scripts/nas/`，只读入口为 `bash scripts/nas-audit.sh`，独立显式写探测为 `bash scripts/nas-probe.sh`，小批复制入口为 `bash scripts/nas-sample-copy.sh`，完整在线预复制入口为 `bash scripts/nas-precopy.sh`，在线完整内容校验入口为 `bash scripts/nas-verify.sh`；不需要启动 mx-static 容器。静态文件服务仍由 [docs/README.md](../docs/README.md) 描述。

## 当前目标与状态

以下为 9 月 22 日迁移阶段记录；具体“下一步”已被上方 9 月 24 日现场覆盖。

先把 mx-internal-server 上两个媒体卷的原始媒体复制到 NAS。用户最新安排：先 po_infra，再 delta；po_infra 可安排 10–30 分钟维护窗口。后台预复制不设四小时退出，优先完成单卷；真实复制错误仍报告失败。原数据保留到校验、切换和业务验收通过，之后用户已授权回收对应旧 raw_media；原 named volume 和其他目录保留。SSD 上的数据库、队列、agent 工作区和其他 Docker/Kubernetes 数据保持原职责。**第一卷已完成预复制和生产切换；业务验收待回传，尚未删除原数据或回收 SSD。**

- 最新现场结论：[运行版本、临时文件占用和权限门槛](evidence/2026-09-22-live-findings.md)。两个目录合计 1,426.04 GiB，其中 tmp 960.46 GiB；保留全部文件，不凭名称清理。
- 第一卷 po_infra 预复制成功：497.71 GiB，3 小时 10 分 35 秒，退出 0。之后按用户选择，采用 rsync 传输校验加停写最终逐路径 quick-check，已完成 NAS 切换；本轮约 2 分 40 秒，包含在线补增量。十个媒体服务恢复、已有视频 Range 读回通过，PostgreSQL/Redis 保持原容器身份。现在执行 [业务验收和只读空间清单](operations/part1-reclaim-plan.md)，不重复预复制、准备或切换；第二卷暂不启动。[SHA256 工具](operations/online-verification.md) 保留为可选检查，不是本轮硬性前置条件。
- 两卷小批复制及 delta 短时吞吐均已通过：1.513 GiB / 31.708 秒，rsync 阶段 55.401 MiB/s。执行流程见 [两晚分卷执行与在线预复制](operations/two-night-migration.md)，无需重复试拷；po_infra 单遍算术外推约 2.55 小时，不是完整迁移时长承诺。
- 用户确认 NAS 没有独立备份，最新决定暂缓阿里云备份；服务器链路已确认千兆全双工，切换前最近一次 /data 回传为剩余 67G；群晖管理凭据遗忘且 SSH 超时，后端健康暂未确认。用户先前要求不等待管理端登录开展迁移，目前第一卷已切换；[后端检查](operations/nas-health-and-oss.md) 留待具备访问条件时补充。OSS 价格仅保留为历史预算，不作为本轮前置条件。
- 默认方向调整：[原生存储、启动边界与数据库扩展](operations/storage-platform.md)。优先 Docker NFS volume / K8s PV/CSI，保持 Docker 全局 NAS 依赖禁用。
- [旧 host-bind 启动方案](operations/boot-and-recovery.md) 仅作为兼容备选，不再默认每业务一套 systemd 控制程序。
- 主记录：[Delta 原始媒体迁移](migrations/2026-09-22-delta-raw-media.md)。
- 候选覆盖文件：[Docker 原生 NFS 子卷](templates/compose.delta-raw-media-nfs-volume.yml.example)；[旧 host-bind 子挂载](templates/compose.delta-raw-media-nas.yml.example) 为备选，两者不能叠加。通用示例仍须按实际部署核对；第一卷采用成功报告内专用 override，主机重启/NAS 晚启动演练尚未完成。
- 源码基准：[po-infra cdf3e649 的关键文件 SHA256](evidence/po-infra-cdf3e649-sha256.json)。最新现场报告中五个采样文件与基准匹配（含 media_storage.py），tasks.py 不同；不能宣称整个版本一致。

## 已看到的目录与拟用目录

2026-09-22 用户截图和 layout 回传确认了以下目录名称；不据此推断目录中的业务内容或用途：

```text
/mnt/nas/mx-internal-server/
  shared_archives/
  shared_dir/
  shared_media/

/data/                         # 服务器 2T SSD
  docker/
  k8s/
  models/
  mx-backup/
  mx-recovery/
  mx-runtime/
  shared-archives-20260909/
  tmp/
  uv-cache/
```

最初 layout 确认 NAS 的 `/mnt/nas/mx-internal-server/data/` 不存在；本轮第一卷已在该层级创建目标并成为正式媒体读写来源。主机根目录为 1003:10 / 2750，4 KiB 探测、两卷小样本及 delta 32 文件短时吞吐已通过；po_infra 整卷复制与 Docker NFS 访问也已验证。目录规划及本轮落地位置如下：

```text
/mnt/nas/mx-internal-server/data/
  docker/
    media-volumes/             # 第一卷已创建，按真实卷名隔离
      delta_59202_media_data/  # 第二卷整卷迁移未开始
        data_hub_raw_media/
      po_infra_media_data/     # 第一卷已切换
        data_hub_raw_media/
  k8s/                         # 预留；本次不迁 Kubernetes
  mx-static/                   # 预留独立归档位置，须另行配置 attach
```

`media-volumes` 是应用文件副本目录，不是 Docker data-root，也不冒充 Docker 自己的 `volumes/_data` 管理结构。若拟用位置已存在，先确认其来源与内容，不能直接覆盖或合并。`shared_media` 另有历史媒体链路，不能把它与 data_hub_raw_media 合并，也不能仅凭目录名判断可复用。mx-static 的归档目录与 Delta 媒体分开管理。

## 从 Git 获取后运行

由用户提交并在服务器获取相应 Git 分支后，进入 `electron-dock/mx-base/mx-static`，逐条执行：

```bash
sudo bash scripts/nas-audit.sh layout
sudo bash scripts/nas-audit.sh deployment
sudo bash scripts/nas-audit.sh media
```

直接粘贴上述命令即可，脚本通过 Bash 执行，不受交互 zsh 的 `#` 注释设置影响。工具需求：Linux、Python 3.6+、findmnt；deployment/media 需要能访问本机 Docker。systemd、rsync、SELinux、kubectl 的不可用项会在 deployment 报告中显示，不自动安装依赖。

| 命令 | 读取范围 | 输出用于确认 |
| --- | --- | --- |
| layout | 本机 `/data`、`docker`、`k8s` 一级名称，以及 NAS 中几个固定目录；每次列表至多 50 个名称 | 现存目录、拟用目标是否冲突、uid/gid/mode、是否有软链接 |
| deployment | 容器元信息、源文件哈希、进程 UID/GID、版本和 Kubernetes 路径 | 两套实例的身份、所有潜在消费者、线上代码是否与审查基准一致 |
| media | 两个已知本地卷的 raw_media 子树，只读文件元数据，降低扫描调度优先级 | 临时文件数量/逻辑字节、最大的 20 个文件、扫描错误 |
| network | 到 NAS 的本机路由、相关 NIC/sysfs 和本机内核 NFS 计数，不访问 NAS 文件 | 协商速率、下层设备、挂载参数和累计错误；不是峰值带宽测试 |

layout 先读取内核挂载表，只允许已挂载到 `/mnt/nas` 的指定 NFS 导出；未挂载、只有 automount、导出不符时拒绝访问 NAS 目录。发现路径经过软链接就跳过；不 mkdir、不遍历整个 NAS、不做 du。**hard NFS 的元数据读取仍可能等待，普通 timeout 不保证终止 D 状态进程；卡住时不要重复启动扫描，先报告位置。**

deployment 不输出完整容器环境变量、Secret 内容或连接凭据，只输出路径、构建身份和媒体参数白名单。它在相关运行容器内启动 Python 只读关键源码计算 SHA256，不导入应用、不执行数据库命令。完整输出仍含内部路径/主机名，保存在 `reports/`，不要直接提交 Git。它也报告源卷路径上下级的 bind mounts；这属于潜在消费者，仍需人工判定。没有 kubectl 权限不代表没有 Kubernetes 使用者。

media 验证 Driver=local、Options 为空、卷名/挂载路径及 `/dev/nvme0n1p1` 本地文件系统，拒绝来源经过软链接或变成 NFS。该脚本有意限定当前服务器，磁盘设备变动时先审查配置，不绕过检查。统计是活跃业务的瞬时元数据视图，逻辑字节会按文件路径计数；有硬链接时不等于实际物理占用。超过 24 小时的 tmp 也不自动视为可删除。

## 本机源码注意点

本机 `/Users/qpjoy/workspace/mingxi/po-infra` 的 `feat/new_delta` 为 `cdf3e649d685ba708daae83ef8b81318d2bcfa24`，与此前审查基准一致。Git 中存在：

```text
media/spiders_src/GetUserInfo.py
media/spiders_src/GetUserinfo.py
media/spiders_src/getuserinfo.py
```

默认不区分大小写的 macOS 文件系统无法同时正确呈现这三个路径；当前两处 Git 修改与截图警告相符。本轮不重置、不提交这些变化，不从本机 `media/` 作为迁移源。需要对照它们时读取 `git show HEAD:<精确路径>`；构建 Linux 发布物时使用区分大小写的干净 checkout。该问题与 NAS 迁移分开处理，绝不据此改名生产文件。

## 当前建议的只读检查

```bash
bash scripts/manage.sh nas project list
bash scripts/manage.sh nas host status
bash scripts/manage.sh nas infra status
bash scripts/manage.sh nas infra deployment audit
bash scripts/manage.sh nas infra permissions check
```

第一卷历史切换和旧只读清单不能用于当前漂移后的回收；先完成上述 Part 1 修复、验收和新清单，用户暂不执行删除。Part 1 达到约定终点后，第二卷从 `nas delta task part2 copy --unlimited` 开始独立迁移；该命令仅预复制，不代表已切换或可删 SSD。安装/启用恢复见 [统一管理](operations/unified-management.md)，NAS 进程与多项目分工见 [平台结构](operations/nas-platform.md)。

本地回归：`python3 -B -m unittest discover -s tests -p 'test_nas*.py'`。测试使用临时目录、模拟工具以及可用时的本地 rsync，不连接生产服务器或 NAS。
