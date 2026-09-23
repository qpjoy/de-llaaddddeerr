# NAS 存储约束：重启、重装与断电恢复

状态（2026-09-24）：本文区分现有能力和待实施的发布约束。服务器 02:04 回传 `b713ae7` 的 `nas infra storage check` 已生效，确认全部十个媒体服务实际在 SSD；未进行断电/重装演练，未封住外部发布入口。后续当前版本核对和 `nas infra repair prepare` 均已通过，报告见本文末尾。现新增 `repair copy` 只补清单缺失文件，尚无复制完成回执；它不重建业务，不能凭本文宣布“已恢复 NAS”或“已防止回退”。

## 约束的对象

一旦一个媒体子目录正式迁到 NAS，它的存储意图持续为 NAS：NAS 不可用、卷声明丢失、报告缺失或身份不匹配时，拒绝启动依赖它的媒体服务；不自动用 SSD、空目录或新建普通本地卷替代。旧 SSD 只可作为待核对的数据，不自动恢复成权威源。

infra 约束覆盖十个消费者的 `/app/media/data_hub_raw_media`，目标是 `mx_data_raw_media_nfs_v1`。父卷 `po_infra_media_data` 的其他目录及 PostgreSQL/Redis 仍保留原职责。delta 尚未切换，不能现在就强制它使用尚未验收的 NAS 数据。以后新增项目必须经审核登记相同的约束，不能把全机 Docker 卷全部迁到 NAS。

“不回到 SSD”是数据位置保证，不是 NAS 故障时业务始终可用的保证。与媒体服务共处进程或网关的登录接口仍可能受到 NAS 故障影响；不能通过更改登录、密码、数据库初始化或认证配置来掩盖存储问题。修复验收必须包含 MX-H2I 现有用户登录和联网。

## 已确认的事故与剩余数据

9 月 22 日的切换成功记录有效；9 月 24 日回传却确认所有十个媒体容器缺少 NAS 子挂载。容器于 9 月 23 日 16:33–16:34（北京时间）重建，九个应用镜像变化，Compose 文件列表只有原来的两份文件，没有 NAS 覆盖；`.env.ghcr` 已变化，两份基础 Compose 文件未变化。内核显示媒体实际由 XFS `/app/media` 父卷提供。

因此，这是**重建时遗漏存储声明**，不是原生 NFS 挂载失败后 Docker 自动切换为 SSD。谁触发发布、是否运行了初始化脚本仍未确认；静态审查匹配到脚本行为不等于这些行为已执行。

最新只读核验是在线快照，未停写：

| 差异 | 结果与处置要求 |
| --- | --- |
| SSD 独有 | 5,219 文件，2,867,924,180 字节（约 2.67 GiB）；其中 tmp 1,036 个。仍待保全与补齐，不能删除 |
| NAS 独有 | 1,032 文件，358,919,683 字节；其中 tmp 348 个。必须保留，禁止带 `--delete` 镜像同步 |
| 共享文件 size/mtime 差异 | 79 个文件，双侧 SHA256 全部相同；无内容冲突，不需要覆盖现有 NAS 文件 |
| 仅权限不同 | 1,681 个 tmp；SSD `0644 0:0`，NAS `0600 0:0`。保留 NAS 权限，不传播 SSD 的宽权限 |
| 类型冲突/核验错误 | 均为 0；`live_snapshot=true`、`cleanup_ready=false`，不能替代停写后的最终核对 |

Part 2 约 932.07 GiB（其中 tmp 649.04 GiB）仍在 SSD，尚未整卷 rsync。这是用户所说的“900 多 G”，不是可删除的独立磁盘。Part 1 当前约 500.84 GiB；历史清理清单已不足以描述最新写入。

## 场景与边界

| 场景 | 正确行为 | 现有覆盖及缺口 |
| --- | --- | --- |
| 主机重启，原容器/卷完整，NAS 已在线 | 原生 NFS 卷挂载成功后启动原容器 | 原生卷及已安装开机恢复已有；尚无真实重启验收。当前漂移必须先修复 |
| 主机先启动，NAS 晚到或双方断电后同时开机 | Docker、本地 DB 可独立启动；媒体等待正确 NAS，不能暴露 SSD 子目录给应用 | 已有开机补启动在失败后重试；成功后不持续巡检。实际服务/容器身份须符合登记 |
| NAS 在运行中断电/断网 | hard NFS 的读写可能等待或报错；保留原存储来源 | 不自动切 SSD，不强卸载、不改 soft。NAS 恢复后核对任务和 I/O，不能承诺中断写入绝不损坏 |
| 仅重启 Docker | 检查原容器、卷及当前挂载；不依赖宿主机 `/mnt/nas` 是否先挂载 | 当前 boot helper 成功后不会因 Docker 再次重启自动巡检；原生卷阻止静默本地替代，自动恢复时机仍须验证 |
| 重装 Docker，保留 `/data/docker` | 先核对 daemon data-root、原卷 driver/options、容器及挂载 | 现有工具检查固定 data-root 和部署身份；不将“Docker 装好了”视为业务恢复完成 |
| 重装/误删使 Docker 元数据丢失 | 停止自动恢复；人工核对并重新登记 NAS 卷和当前版本媒体容器 | `external: true` 缺卷会报错；恢复工具不会凭旧报告重建容器。DB/Redis 原卷必须独立核实，禁止启动空库初始化 |
| 系统盘/配置也丢失 | 先恢复声明、私有配置/证据，再核对原 NAS 导出与标记 | 仅有 Docker 卷名不够；缺少恢复材料时保持阻止，不能自动从旧 SSD“恢复业务” |
| 普通发布遗漏 NAS 覆盖 | 在创建/启动容器之前拒绝 | **当前未实现强制拦截。** 只读检查和 recovery 拒绝漂移，无法阻止其他入口创建 SSD 容器 |

Docker Compose 的 `external: true` 表示卷由外部管理，缺卷时报错；直接用不存在的普通 named volume 创建容器则可能自动创建新卷。因此不能仅凭卷名包含 `nfs` 判定安全，必须核对 driver/options 和内核挂载。[Compose 外部卷](https://docs.docker.com/reference/compose-file/volumes/)、[Docker volumes](https://docs.docker.com/engine/storage/volumes/)。原生 NFS 是 `local` driver 加 NFS options，看到 `Driver=local` 本身也不等于媒体在 SSD。

## 发布入口还必须落实的防护

1. **持久存储意图独立于容器。** Git 保留无密钥的 NAS 强制声明；机器上的报告、NAS 标记与运行意图不能因删容器/重装 Docker 消失就默认为 SSD。报告缺失是阻止原因，不能当作“未迁移、走本地”。
2. **受控发布必须携带存储声明。** 对当前新版本生成新的经过审核的安全启动配置，把 `part1.storage.json` 作为必需输入；先检查合并后的十个 child mount、外部卷、gateway 只读、nocopy、父卷和 DB/Redis，再创建未启动容器，检查实际配置后才启动。检查失败不得重试为不带覆盖的命令。旧成功报告包含旧镜像 ID，不能直接拿旧 override 恢复当前新版本。
3. **覆盖所有实际启动入口。** 现有 root/CI/旧部署脚本仍能绕过 mx-static；仅换入口、设置 `COMPOSE_FILE` 环境变量或加一个 timer 都不是强制隔离。要声称技术上封住遗漏，必须让发布账户仅能使用受控入口，或经专门审核部署 Docker API 准入限制；若使用应用入口检查，它必须在被保护镜像的实际启动链中生效，不能只放在同样可能漏掉的 overlay 中。root 始终可以主动绕过机器上的策略。
4. **发布后检查与启动拦截职责不同。** 本次新增检查能及时发现事故，但检查通过之后状态仍可能变化，不能当作创建/启动全过程的事务锁，也不自动停正在提供登录的服务。

按当前约定，不改 po-infra、不接管 Docker daemon、不修改现有业务镜像。这意味着本轮只能交付检查和明确的落地要求，不能宣称已经为旧发布路径增加了强制拦截。后续实施应先完成当前版本的受控发布方案与隔离测试，再安排服务器切换；不能为验证方案直接重启生产 Docker。

## 恢复材料与演练

Git 的 `deploy/nas/` 保存声明，`/var/lib/mx-static/` 保存私有报告/清单，`/etc/mx-static/nas/auto.json` 保存恢复选择，`/usr/local/lib/mx-static-nas/` 保存已安装快照，`/var/log/mx-static-nas/` 保存审计。它们已在 Docker data-root 外；**这只能隔离 Docker 数据目录被重置，不能抵御系统盘损坏。** 系统重装恢复另需安全保存当前部署 env/密钥、Compose、镜像身份、NAS 标记对应证据，以及数据库自身的恢复材料；不把私有配置提交 Git，不用旧报告覆盖新版本凭据。离机恢复材料目前未确认，不追加本轮云备份硬门槛。

先用隔离项目/测试目录验证：NAS 先开、NAS 晚开、NAS 缺席、运行中断线恢复、仅 Docker 重启、卷缺失、同名卷被建成本地卷、遗漏覆盖、错误导出、应用元数据丢失。每项都要求媒体未获正确 NAS 时无 SSD 新写入；错误情形拒绝启动；DB/Redis 不被测试停止或初始化。真实突然断电还涉及 NAS 池/文件系统、数据库与任务一致性，挂载检查不能证明这些已恢复。

生产顺序：保全两侧独有文件 → 按当前版本准备合并与受控恢复方案 → 维护窗口停媒体写入并复核增量 → 保留 NAS 独有内容/权限、补齐 SSD 独有内容并验证 → 恢复十个 NAS 消费者 → 验收已有/新媒体、任务、MX-H2I 登录和联网 → 登记新部署与恢复基准 → 再准备 SSD 回收。原报告保留，不能改哈希绕过旧检查。

## 当前可以执行的只读命令

更新本地工具代码到服务器后，在 mx-static 目录运行：

```bash
bash scripts/manage.sh nas infra storage check
bash scripts/manage.sh nas infra status
bash scripts/manage.sh nas recovery check
```

`storage check` 读取 Docker 元数据与本机 `/proc/<pid>/mountinfo`，独立于旧 `.env`/镜像哈希，便于诊断重建后的漂移；不访问 NAS 文件、不重启、不创建卷、不改报告。缺容器、缺卷、错误 options、缺子挂载、错误读写属性或无法确认运行中的内核挂载均返回 1。`status` 显示同一核对结果，保留概览原有退出约定；自动化应使用独立的 `storage check`。

全部匹配只说明瞬时存储来源符合登记，不证明 NAS 健康、应用 I/O、登录、数据完整或可清理。正常停止的 NAS 容器也会因无法确认运行中的挂载返回 1，因此此命令不能直接作为冷启动的前置条件；冷启动仍走原有严格恢复检查。`recovery check` 的旧配置/身份检查继续生效，本次没有放宽它。

## 已通过当前版本核对；准备独立修复报告

用户回传已确认：十个媒体容器的 Compose hash、Entrypoint、Cmd、User 与对应核对目标一致；九个应用容器启动脚本符合已审查哈希、无可写层业务代码修改；Postgres/Redis 保持旧切换时的容器 ID 且健康；配置文件和消费者在检查期间稳定。

- 当前九个应用镜像：`sha256:45f5a0e5cae63bd1bc6215bcdbbe6531ba149ccc86dc47e11fcb55d1a9f5e0bf`。
- 当前 gateway 镜像：`sha256:6769dc3a703c719c1d2756bda113659be28ae16cf0da58dd5fd823d6b9a050ea`。

准备工具限定这组已核对镜像；未来升级要另行审核，不能悄悄接受任意新版本。更新本轮代码后，在 mx-static 目录运行（`b713ae7` 尚无此命令）：

```bash
bash scripts/manage.sh nas --help
bash scripts/manage.sh nas infra repair prepare
```

帮助中应先出现 `infra repair prepare`。该命令前台运行，期间保持 SSH 连接；通常每十秒输出目录扫描进度，hard NFS 不可用时仍可能等待。中断仅留下未完成的新报告，不会自动复制或恢复业务，不因中断改用 SSD。

准备内容：

1. 获取迁移锁，重核当前部署、启动脚本、实际镜像、健康及 DB/Redis 身份；发现额外 Docker 媒体消费者或运行中修改业务代码则拒绝。
2. 在 `/var/lib/mx-static/nas-repair/infra-<随机ID>/` 建立新的 root 私有目录（0700，文件 0600），保存当前配置/容器快照。报告可能含凭据，**只回传终端摘要和报告路径，不回传 private 文件**。
3. 生成固定当前镜像的 `compose.nas.candidate.json`；直接启动 Gunicorn 跳过旧 `run_web.sh` 中 migrate/bootstrap_admin 等初始化，Worker 设置 `MX_RECOVER_STALE_AGENT_RUNS=0`。调用 Compose **只渲染配置**，核对除了已列明的启动调整、固定镜像和 NAS 子卷外没有其他变化；DB/Redis、父卷、端口、凭据及认证环境保持当前值。没有创建或启动容器。
4. 核对现存 NFS 卷、历史成功报告和 NAS 标记、源/目标目录身份，再扫描两侧目录元数据；生成 `union-manifest.jsonl`。SSD 独有文件为待补入候选，NAS 独有文件保留，共享文件和目录的现有 NAS 属性保留。类型冲突、链接、跨文件系统对象、共享同名文件大小不同均阻止准备。
5. 对大小相同、整秒 mtime 不同的共享文件做双侧 SHA256；内容不同或读取期间变化则阻止。最多 1,000 对、双侧总计 512 MiB，不扩大为全量哈希。权限差异和 quick-check 一致文件不读取内容。新报告重新核对有限差异，不直接把之前终端的 79 对结果当作新的机器可执行凭证。
6. 最后复核配置、容器、DB 身份、目录、历史回执及 NAS 标记未变化；写入 `repair-plan.json` 并输出“修复清单已准备”。

准备只写本机私有报告和操作审计。没有 rsync、删除、改媒体权限、停服务、创建卷、NAS 写探测、重写旧报告/标记或更新恢复登记。两侧仍在线，清单明确 `live_snapshot=true`、`stopped_writer_recheck_required=true`、`execution_allowed=false`、`reclaim_ready=false`。

因此准备成功后仍需按回传报告制订增量补齐、维护切换和新基准登记步骤。不要将新报告交给旧 cutover/redeploy/reclaim，也不要手动执行其中候选 Compose 的 `up`。尚未提供 `repair apply` 命令。现有登录继续由当前运行服务提供；准备成功不能代替切换后的登录/媒体验收。

## 已准备的具体报告与在线补齐

用户已回传准备成功：

```text
/var/lib/mx-static/nas-repair/infra-a0131341096e4ba9b9e3e61c3e2581dd
```

这次在线快照的 SSD 独有文件增加到 **5,289 个 / 2.69 GiB**（tmp 1,036），NAS 独有仍为 **1,032 个 / 0.33 GiB**（tmp 348）；共享 quick-check 一致 193,005 个 / 497.42 GiB，仅属性不同 1,681 个 / 0.68 GiB，79 个共享差异文件双侧哈希一致。准备没有复制或改变业务挂载。

同步新增 `infra_repair_copy.py` 及相关入口代码后，在同一目录执行：

```bash
bash scripts/manage.sh nas infra repair copy /var/lib/mx-static/nas-repair/infra-a0131341096e4ba9b9e3e61c3e2581dd
```

`5beead17` 及之前的版本尚无此复制入口。命令显式授权**新增 NAS 文件**，创建唯一的后台 systemd 任务，打印精确的 journalctl 查看命令；SSH 断开不会停止该任务。`ReadOnlyPaths=/data` 保护 SSD，Nice=19；按用户要求默认不限速，已移除原 8 MiB/s 写入节流，保留逐文件校验和持久日志。任务不因主机重启自动续跑；hard NFS I/O 仍可能等待，不能靠不断重试制造更多阻塞进程。

后续约 900 多 GiB 的 `delta / part2` 继续使用独立入口 `bash scripts/manage.sh nas delta task part2 copy --unlimited`，该参数令 rsync 使用 `--bwlimit=0`。它是第二卷在线预复制，不复用本次 infra 差异修复清单；两项任务依次执行。

复制只读取原 `union-manifest.jsonl` 的 `ssd_only` 项，验证原摘要、逐文件元数据、父目录、设备、完整清单校验和、镜像/容器指纹、DB 身份、当前配置和原 NAS 标记。清单外新增文件留待最终停写核对，不扩为整卷同步。当前实现只支持准备时已经存在且身份/权限不变的 NAS 父目录；不自动创建业务目录或推断其权限。最多 10,000 个候选、16 GiB，超出需审核，NAS 还须有候选总量加 1 GiB 的可用空间。

每个缺失文件先进入卷目录下、raw-media **之外**的 `.mx-static-repair-copy-<本次ID>/` 私有目录；核对源文件未变化、内容与哈希文件名（适用时）一致、NAS 内容读回一致、新文件属性正确后才发布。发布使用不会覆盖既有名称的 `link`；如果目标在此期间出现，只允许验证同内容并保留其现有属性，内容不同则停止。已有 NAS 文件绝不被 chmod/chown，原目录权限保留，添加子文件自然会更新目录时间。完成后只移除自身私有临时名和空暂存目录。[Linux link 语义与 NFS 响应不确定性](https://man7.org/linux/man-pages/man2/link.2.html)

源文件始终保留，不运行 rsync 覆盖、NAS 删除同步、媒体初始化、Docker up/start/stop、数据库迁移或账号初始化，不改变旧报告、NAS 标记、恢复基准或当前 SSD 挂载。复制过程中定期复查登记和部署身份；变化就停止后续写入，不自动回滚任何已补入文件。

每次尝试在原准备报告下新建 `copy-<ID>/`，保存私有的 `started.json`、逐文件持久日志 `copy.jsonl` 和完成后的 `result.json`。失败/部分完成写 `failed.json`；突发断电可能来不及写失败记录，**没有 result.json 不能视为完成**。重试只对原候选检查，已经存在且内容相同的文件保持不变；源文件变化、目标冲突或异常硬链接时停止。

尤其是断电恰好发生在发布与清理临时名之间，NAS 可能保留两个指向同一 inode 的名称。工具会拒绝直接继续该项，保留原 SSD、NAS 文件、暂存目录及日志供核对，不猜测性清理，不执行 `rm -rf`。NFS 若不支持所需的链接/持久化操作，也不会退回可能覆盖文件的 rename 操作。

后台日志出现 `nas_repair_copy_complete` 才表示**该份清单**已完成补齐。此时仍需最终停写复核、新增文件补齐、NAS 消费者恢复和新基准登记；`reclaim_ready` 继续为 false，原 SSD 不能删除。不要再次运行旧 copy/cutover/redeploy 来完成剩余步骤。
