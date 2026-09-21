# NAS 迁移运维入口

本目录记录部署证据、存储目录规划、迁移步骤和注意点。工具在 `scripts/nas/`，只读入口为 `bash scripts/nas-audit.sh`，独立显式写探测为 `bash scripts/nas-probe.sh`；不需要启动 mx-static 容器。静态文件服务仍由 [docs/README.md](../docs/README.md) 描述。

## 当前目标与状态

先把 mx-internal-server 上两个媒体卷的原始媒体复制到 NAS，校验、停写并切换后，继续保留原卷和原数据。SSD 上的数据库、队列、agent 工作区和其他 Docker/Kubernetes 数据保持原职责。**本轮没有迁移、删除、挂载或重启服务器服务。**

- 最新现场结论：[运行版本、临时文件占用和权限门槛](evidence/2026-09-22-live-findings.md)。两个目录合计 1,426.04 GiB，其中 tmp 960.46 GiB；保留全部文件，不凭名称清理。
- 主记录：[Delta 原始媒体迁移](migrations/2026-09-22-delta-raw-media.md)。
- 候选覆盖文件：[Compose 子目录挂载模板](templates/compose.delta-raw-media-nas.yml.example)，暂不应用；启动监督、路径身份、权限和运行版本核对通过后才生效。
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

最新 layout 确认 NAS 的 `/mnt/nas/mx-internal-server/data/` **不存在**，其下拟用目标也不存在。主机根目录为 1003:10 / 2750，写入和 owner 保留待验证。按用户建议拟建结构：

```text
/mnt/nas/mx-internal-server/data/
  docker/
    media-volumes/             # 拟建，按真实卷名隔离
      delta_59202_media_data/
        data_hub_raw_media/
      po_infra_media_data/
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

## 下一步：独立权限写探测

三份只读输出已经回传，不必立即重复扫描。先获取当前 SSD 余量，再做一次独立写探测：

```bash
df -hT /data
df -i /data
sudo bash scripts/nas-probe.sh permissions --write-test
```

最后一条**会写入约 4 KiB 测试数据**，与只读 nas-audit 分开。它核对指定 NFS 导出和设备，拒绝软链接；仅在现有主机目录下新建 `.mx-static-probe-<随机值>`，测试写入/fsync/rename/read、mode/mtime/chown 0:0，之后只清理自己的文件和空目录。不创建 data/ 或迁移目录，不修改旧文件、权限或挂载。运行中不得卸载/替换 NAS 挂载；hard NFS 可能等待，不并发重试。

请回传完整输出。任一操作或清理失败返回非零退出码，留下具体阶段/路径。全部通过仍不等于允许直接切换：还需 NAS 健康/配额/备份、最终目录授权、小批 rsync 属性与 SHA256、真实容器读写、启动监督验收。root 映射/chown 失败时不绕过，不对旧共享目录执行 chmod/chown；[现场结论](evidence/2026-09-22-live-findings.md) 有详细判读。

复制和权限策略按回传结果确定。保留原卷，先复制全部 raw_media（含 tmp）；没有自动迁移或业务清理入口。线上代码存在临时文件泄漏，建议单独保存现场源码并修复发布；不能把代码升级混入存储切换。

本地回归：`python3 -B -m unittest discover -s tests -p 'test_nas*.py'`。测试只使用临时目录和模拟工具，不连接服务器或 NAS。
