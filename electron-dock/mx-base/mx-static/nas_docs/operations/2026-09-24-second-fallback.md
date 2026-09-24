# 9 月 24 日 11:04 重建后再次回到 SSD

> 本次已修复：`8610f8a…` 切换完成，当前 NFS 挂载及独立恢复检查通过。下面保留事故处理顺序，旧 copy/switch 命令不要重复执行；最新状态和下一步见末尾“本次切换与恢复已确认”。业务验收尚未完成，SSD 保留。

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

最新复制回执与切换命令见下方“本次在线补齐已完成”。下面的入口说明不代表应用脚本已经在服务器更新。

两张用户截图均在 `/home/lcy/test/Delta/mx_data` 执行 `./scripts/deploy_public_ghcr.sh --local-build`：

| 环境 | 关键参数 | 当前 Docker 项目 / 媒体父卷 |
| --- | --- | --- |
| infra / part1，图 2 | 无 `--instance`，`--port 59201`，公开地址 `http://delta.mxinfo-inc.cn` | `mx_data` / `po_infra_media_data` |
| delta / part2，图 1 | `--instance delta-59202`，`--port 59202`，`--db-port 55432`，公开地址 `http://dev.delta.mxinfo-inc.cn` | `delta_59202` / `delta_59202_media_data` |

端口用于说明现场，存储关联必须以核对后的项目/卷身份为准。按照本地同名发布脚本的默认规则，infra 使用 `deploy/.env.ghcr`，delta 使用 `deploy/.env.delta-59202.ghcr`；环境变量可覆盖默认值，不能靠截图推断服务器实际文件内容。

本地只读审查发现 `compose()` 显式追加 `docker-compose.ghcr.yml`、local-build 文件，以及启用数据库端口时的 db-port 文件，没有添加 NAS 声明。这与服务器 Compose 标签及 SSD 实际挂载一致；不能据此推断具体执行者。原命令中的 `--no-pull` 不声明媒体存储位置。

若保留这两条用户命令，发布脚本需一次性接入存储约定；业务 API 不需要感知 NAS。用户随后明确授权修改这一个部署脚本，下列范围现已本地实现并提供补丁，**服务器安装和接入尚未确认**，见 [发布入口接入步骤](release-guard.md)：

1. 在统一 `compose()` 构造处为已切换项目始终携带纯存储覆盖，包括 `config/build/up/run`；不复用迁移报告中的旧镜像、旧环境或维护启动配置。两个实例分别选择各自卷，delta 正式切换前不得强制使用 infra 的 NAS 卷。
2. 发布前核对项目、登记、外部 NFS 卷及合并挂载。已登记项目缺少必需声明或 NAS 卷时必须失败，不能把“文件不存在”解释为允许 SSD；`.env` 的普通业务值仍由应用管理，改变项目/媒体卷身份则需重新核对。
3. 原脚本的 `find /app/media ... chmod` 会递归遍历子挂载，必须排除 NAS raw-media 子树，不能只加一个 `-f` 后照旧运行权限修复。临时 `compose run web` 也必须使用相同的 NAS 子挂载和 nocopy。
4. 发布后核对全部媒体消费者的实际 NFS 来源；存储接入本身不得删除 NAS 文件或数据库/队列，不创建空数据卷替代已有存储，不自动退回 SSD。

应用正式发布仍包含数据库迁移、索引/任务维护等自身步骤；本地 Web 启动脚本还调用 `bootstrap_admin`，因此 mx-static 的媒体维护入口不能代执行整个发布脚本并承诺没有业务副作用。现有 `nas infra deployment recreate` 是媒体维护路径，不能直接替代完整正式发布。此次获准改动仅接入 po-infra 发布脚本，未修改其业务/API/登录代码，未执行发布或安装 Docker 全局拦截。现有恢复 timer 自身仍不拦截绕过接入的原始 Compose 命令。

## 后续修复边界

本地 `profiles.json` 已取消旧清理清单的选用（`plan=null`），保留切换报告、清单文件、NAS 标记和独立存储登记。此前已验收清单只是历史证据，不能继续用于本次新写入后的删除。

先审查当前版本，再生成新的 SSD/NAS 差异清单；保留 NAS 独有数据和原属性，禁止同名覆盖。补齐新确认的 SSD 独有文件后，在维护窗口停写复核、使用当前版本受控切换。不能先加挂载把新 SSD 文件遮住，不能重复旧 rsync/cutover，也不能退回旧应用镜像。

服务器已确认安装工具快照 `c5edb8b3fc3d38846657`，但应用发布脚本尚未拉取。用户选择先完成 mx-static 受控修复，再接入/测试应用发布保护；期间不运行旧发布脚本或原始 Compose 重建。发布接入不作为修复切换的额外门槛，现有数据和部署核验保持不变。新版本审查、新差异准备和本次在线补齐已经通过，再次切换及应用接入生效尚待回执，不能把工具安装/复制写成生产修复成功。修改范围为 mx-static 及新授权的单个 po-infra 发布脚本，保护 MX-H2I 登录、数据库/队列及其他项目。

## 本次在线补齐已完成

用户回传 `manifest_copy_complete`：成功尝试为 `/var/lib/mx-static/nas-repair/infra-1dfa9196bd8c4e32823ca73276630c74/copy-357ceceb606548e4b3cb3c528e9c341c`，`copied=864`、`already_present=0`、`logical_bytes=662942020`、`source_ctime_revalidated=0`。`production_restart=false`、`source_deleted=false`、`live_snapshot=true`、`stopped_writer_recheck_required=true`、`reclaim_ready=false`。

在服务器 mx-static 目录、允许业务访问暂停的维护窗口执行本次准确命令：

```bash
bash scripts/manage.sh nas infra repair switch \
  /var/lib/mx-static/nas-repair/infra-1dfa9196bd8c4e32823ca73276630c74/copy-357ceceb606548e4b3cb3c528e9c341c \
  --maintenance --write-test
```

会停写复核、补齐复制期间新增文件，并按已审查当前镜像重建/启动十个媒体服务；Web/gateway 暂停期间登录及访问可能不可用。不重启 PostgreSQL/Redis，不执行账号初始化、数据库迁移或清理旧 SSD。`--write-test` 仅创建和清理工具自身小探测。任务仍会重验部署、copy 收据和卷身份；失败时保留日志，不跳过检查或执行旧发布恢复。

提交后按输出中的精确 journalctl 命令观察。随后用户已回传 `nas_repair_switch_complete` 和 storage check，结果见下文；本节命令记录已完成操作，不应重复执行。

## 最新挂载核对已通过

用户随后回传 storage check：十个 infra 媒体服务全部匹配，内核媒体来源均为 `nfs /app/media/data_hub_raw_media`。这确认当前挂载位置已恢复到 NAS；不要因完成日志尚未回传而重复上面的切换命令。此检查本身不证明应用读写、停写增量补齐完成或 SSD 回收就绪。

当时请求只读收集本次 `nas_repair_switch_complete`（包含新报告目录）和当前恢复状态，用户现已回传：

```bash
journalctl -n 80 --no-pager -o cat -u 'mx-nas-part1-repair-switch-*.service'
bash scripts/manage.sh nas recovery check
```

按最新任务的完成收据核对，不能套用早前 `33e5…` 报告。业务侧需确认现有账号登录/联网、旧媒体读取、新媒体写入及后台任务；用户随后明确回复“尚未全部检查”。应用脚本尚未同步，旧发布/原始 Compose 重建的暂停约定继续生效。

## 本次切换与恢复已确认

服务器任务 `mx-nas-part1-repair-switch-1826dd377a.service` 成功：

- 新报告：`/var/lib/mx-static/nas-cutover/po_infra_media_data-8610f8a08acd40dc983a14d515aa2ec5`。
- `phase=running_on_nas`、`final_sync_passed=true`、`nas_may_have_writes=true`；最终停写证据位于该目录的 `repair-final-fa297c7ef6cc4b41a4e0ae5731903aee`。
- 十个新媒体容器 ID 已记录，当前挂载核对全部通过。成功入口已完成现有媒体 HTTP 读取和应用身份的小范围写入/读回探测；这不代替实际业务验收。
- PostgreSQL `2ff6f5855d39…`、Redis `210770e5ecab…` 保持原容器；无 SSD 删除。
- 同次恢复检查：infra 已核对/已纳入，全局未暂停，安装快照与当时服务器代码/声明一致，timer active/running 且 enabled。delta 仍等待迁移。

Git 只将 Part 1 的 `report` 更新为本次 `8610f8a…`，`plan` 保持为空，旧报告/清单/NAS 证据保留。独立媒体恢复不绑定历史报告或容器 ID，因此恢复检查已经通过并不表示迁移/清理入口已选择最新报告。无需重新 storage register、enable 或切换；也不要手改完成收据的 pending 字段。

同步本次 mx-static 声明后，在服务器 mx-static 目录执行：

```bash
bash scripts/manage.sh nas infra locate &&
bash scripts/manage.sh nas recovery install &&
bash scripts/manage.sh nas recovery check
```

`locate` 应显示上述 `8610f8a…` 报告，清理计划为空。install 的原因是报告选择属于安装声明快照；它保留启用设置，不启动或重建业务。恢复检查仍应通过且安装快照一致。然后可以先进行本次技术核验：

```bash
bash scripts/manage.sh nas infra cleanup check
```

保留 **check**，不加 `--business-accepted`：只读核对旧 SSD 与本次停写证据、对应 NAS 文件和当前部署，生成新的私有清单，不删除、不停业务。回传任务最终 `nas_reclaim_check_complete`。用户明确业务尚未全部检查，故预期 `business_acceptance_recorded=false`、`reclaim_ready=false`；这是待验收状态，不是要求绕过检查。待实际业务验收完成，再按现有流程记录验收和新的就绪清单，之后另行决定删除。

## 本次技术回收核验通过，待业务验收

服务器此前仍显示 `33e5…` 是代码未同步，用户已确认并完成同步。随后安装快照为 `6e4a415baafa584072a6`，与本地运行工具/声明摘要一致；恢复检查 infra 已核对/已纳入、timer active/enabled。无需因本次文档记录再次安装。

`mx-nas-part1-reclaim-check-99079f6660.service` 成功，产生本次 `8610f8a…` 报告下的 `reclaim-plan-7cc46138ae5e4421b2b8f131d5cd80b0`：

- 201,521 个普通文件，538,881,503,921 逻辑字节，约 501.87 GiB；4 个目录（包含保留的根目录）。
- 201,403 个 quick-check 匹配，加上 118 个差异文件哈希一致，合计覆盖全部普通文件；双侧哈希读取 346,818,790 字节。另有 1,681 个文件保留 NAS 属性，该数量是上述文件的子集。
- SSD 清单与停写证据摘要相同：`6148b46aadf99058534a91422113056ee200a97500606da2a0635b3a57eb01cd`。
- `files_verified=true`、`recovery.verified=true`；`business_acceptance_recorded=false`、`reclaim_ready=false`、`deletion_authorized=false`、`source_deleted=false`。

技术核验已经通过；不将 quick-check 描述为全量内容哈希。用户尚未完成本次业务检查，因而这个计划不选入 Git，`plan=null` 继续保留，SSD 未删。检查现有账号登录/联网、旧媒体读取、新媒体写入及后台任务，全部正常后才执行：

```bash
bash scripts/manage.sh nas infra cleanup check --business-accepted
```

该命令仍是 **check**，重新核验并记录业务验收，不删除文件。回传新 `nas_reclaim_check_complete` 后再选择就绪清单，实际删除仍是后续单独操作。当前不需要重复复制、切换或普通未验收核验；应用发布脚本接入和测试仍待用户稍后同步，期间继续暂停旧发布入口及原始 Compose 重建。

最近代码验证：332 项 NAS 测试通过，覆盖修复/发布入口及逐文件、数据库和恢复保护。此次仅记录服务器回执，不修改执行逻辑或声明，不重复运行测试；技术回执不代替业务验收。
