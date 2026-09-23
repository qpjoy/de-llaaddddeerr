# 媒体恢复与按需重建

2026-09-24：实现代码均在 mx-static，未修改 po-infra、MX-H2I 或服务器 Docker 配置。以下功能已做本地模拟/文件测试；服务器尚未登记/安装本版，也未进行重启、NFS 故障或真实构建演练。

## 两条独立路径

| 场景 | 入口及依赖 |
| --- | --- |
| 日常状态、开机补启动 | 独立媒体登记 + 当前 Docker 元数据/内核挂载；按依赖补启动已有 PostgreSQL/Redis 和媒体服务，不读应用目录、Compose 文件、`.env` 或历史镜像/ID |
| 普通镜像/env/API 改动后，当前容器已有正确 NAS 挂载 | 直接核对现有媒体容器；不重建，不重新登记历史迁移报告 |
| 媒体容器被删、需要重建，或明确要求 `--build` | 显式维护入口读取当前应用 Compose/`.env`，使用当前镜像或构建结果，自动加入 NAS 挂载；不改应用源文件 |
| NAS 卷/媒体父卷或其他数据卷缺失 | 拒绝用空卷替代；恢复原数据/卷身份后再处理 |
| 数据库/Redis 容器已停止 | 核对已有本地数据卷后补启动；依赖要求 healthy 时等待健康检查，不重启已运行服务 |
| 数据库/Redis 容器也被删除 | 由业务部署恢复原数据及这些服务；本入口不创建空库、空队列或替代卷 |
| 原始应用发布入口遗漏 NAS 子挂载 | 只读检查能发现；本工具不拦截任意外部 Docker 命令，也不自动停当前业务或重建修正 |

此处 `web` 是 mx_data 业务容器，不是 mx-static 静态文件服务；整个操作使用命令行，无须启动 mx-static Web。

## 重启后的统一项目入口

完成一次性登记、安装和启用后，服务器开机由持久恢复服务检查已纳入的项目。当前容器已运行且 NAS 挂载正确便不再启动；尚未启动的已登记媒体容器按顺序补启动并核对实际挂载。NAS 暂未就绪时恢复失败并由 systemd 重试，不换用 SSD；成功后不持续干预业务容器的运行状态。

日常无需先切换到 po-infra 再回来验证，mx-static 提供：

```bash
bash scripts/manage.sh nas infra status
bash scripts/manage.sh nas infra start
```

`status` 同时显示项目内各服务状态、健康、Docker 重启策略、NAS 挂载和独立接管核对，不再依赖旧迁移报告可读。`start` 和开机恢复使用同一项目恢复逻辑，包含已登记的 PostgreSQL/Redis 和十个媒体服务，启动后自动核对挂载；不构建、重建或复制文件。当前仅 infra 完成该适配，未迁移的 delta 不会被启动。

顺序取自现有容器保存的 `com.docker.compose.depends_on` 标签；旧容器缺少标签时，使用已核对的 infra 依赖：PostgreSQL/Redis → Web、chat-gateway、Worker/beat，网关等待 Web/chat-gateway。没有依赖关系的服务采用登记顺序。同一批恢复固定当前容器集合，副本逐个检查，未登记依赖、循环依赖或一次性迁移任务会阻止操作，不能通过启动项目偷偷执行初始化任务。Dockerfile 和 YAML 书写顺序不是服务依赖。[Compose 启动顺序](https://docs.docker.com/compose/how-tos/startup-order/)

已运行的服务始终跳过；`service_started` 等待运行，`service_healthy` 等待 Docker 健康检查，最长 180 秒，超时保留现场，由开机服务后续重试。不会为了等待依赖而重启已有服务。全部运行时只核对存储，不以业务 unhealthy 为由强制重启。

补启动停止的 PostgreSQL/Redis 前，先确认是已有本地 named volume；PostgreSQL 还只读核对 `PG_VERSION` 和 `global/pg_control`，避免在空目录初始化新库。卷或容器缺失则停止，不创建替代品，不读取表数据、不执行 SQL 或 Redis 清空命令。

两边操作的是同一 Compose 项目和同一批 Docker 容器，不维护第二套副本。po-infra 的普通 `start/restart` 可继续管理现有容器；mx-static 不因其镜像/env/容器 ID 变化就采用旧快照重建。Docker 的 `start` 只启动现有容器，`restart` 不应用 Compose 配置更改。[Docker start](https://docs.docker.com/reference/cli/docker/compose/start/)、[Docker restart](https://docs.docker.com/reference/cli/docker/compose/restart/)

创建/重建时必须携带 NAS 挂载声明，或使用下文的维护入口；普通应用 `up` 可能按当前配置重建，因此遗漏 NAS 覆盖的原部署命令仍不受本工具保护。业务发布需要的迁移等步骤依旧归业务部署负责，不由开机恢复替代。[Docker up](https://docs.docker.com/reference/cli/docker/compose/up/)

## 初次启用新恢复模式

先同步本版 mx-static，确认 `deploy/nas/profiles.json` 选用新迁移报告 `33e5abb193d04e7595251a5e6a6046ae`，并有 `recovery_mode: media-v1`。`plan` 在验收前置空，现已依据成功验收回执显式选择清单 `reclaim-plan-a1dc4bb0dfea4d5d83ce143daaf052e9`；它不参与普通恢复，也不授权删除。服务器曾选择旧报告 `830225…`，不要改报告摘要掩盖登记差异。

在服务器 mx-static 目录执行，任一步失败即停止：

```bash
bash scripts/manage.sh nas infra storage check &&
bash scripts/manage.sh nas infra storage register &&
bash scripts/manage.sh nas recovery install &&
bash scripts/manage.sh nas recovery enable --migrated &&
bash scripts/manage.sh nas recovery check
```

`storage register` 首次读取成功迁移收据，并两次核对当前 NAS 媒体挂载；只向 `/etc/mx-static/nas/infra-media.json` 保存独立存储身份摘要和登记时间，不保存业务 env、镜像或容器 ID，不修改报告、不读写媒体内容、不启用 timer。重复登记相同约定是幂等操作；不同存储目标不会被覆盖采纳。

此后的开机恢复不再打开迁移报告或应用部署目录。缺少独立登记时会明确阻止，不偷偷回到依赖历史应用快照的旧恢复路径。`nas infra locate` 可查看登记、存储约束和仅重建时使用的部署定位。

恢复仅对 `mx_data` 已登记媒体角色的现存容器操作。普通重建后的新 ID 可被识别，同一角色多个实例逐一核对；缺少必需角色、新增未知媒体消费者、临时维护容器、错误 NFS 卷、错误读写属性、缺少 nocopy、遮盖媒体的子挂载/tmpfs 均阻止恢复。新增/改名/移除媒体角色需更新 mx-static 的存储适配；不因扫描到任意容器就自动接管。停止的容器先检查挂载声明，启动后检查实际内核 NFS 挂载。

自动恢复保留全局/项目暂停。显式 `nas recovery run infra` 可在尚未启用自动恢复时补启动，不改变未来开机策略；操作过程中新的暂停仍阻止后续启动。每次恢复期间锁定当次容器集合，发生并发替换即停止。正常重启跨越的新 ID 不被历史 ID 锁住。

全部已登记服务已运行且媒体挂载匹配时不执行 start/restart，也不访问应用 HTTP API。启动停止的服务时按依赖需要等待 Docker 健康检查；结果不等于登录验收或数据可删除。

## 需要构建或重建时

部署定位单独放在 `deploy/nas/part1.deployment.json`，平时的开机恢复不读取应用文件。目录变化时更新该定位并重新安装工具即可；普通 `.env` 内容变化不需要改迁移基准。

先只读预检：

```bash
bash scripts/manage.sh nas infra deployment check
```

确实需要重建时才安排维护窗口，选择一条：

```bash
bash scripts/manage.sh nas infra deployment recreate --maintenance
bash scripts/manage.sh nas infra deployment recreate --maintenance --build
```

这不是 Part 1 登记升级的必需步骤；当前十个容器已经在 NAS 上，无须为了启用解耦而重建。

入口提交独立后台单元，打印其 journalctl 命令；SSH 断开后可继续，主机重启不会自动续建。构建和创建的完整输出保存为本次 root 私有报告内的 `build.log` / `create.log`，不公开可能包含配置值的原始错误。执行顺序：

1. 确认独立存储登记、当前安装快照及恢复策略。渲染当前应用配置加纯 NAS 覆盖，核对角色与挂载；不比较历史 `.env`、镜像或应用 API。
2. 确认当前配置引用的数据卷都存在、NFS 原生卷定义正确；现存媒体容器不得已回到 SSD。数据库/Redis 只要求当前实例存在且运行，以确保本次维护不误接管它们；不会比较历史数据库 ID、版本或配置。
3. 保存 root 私有配置快照，所有数据卷标为 external。按需只构建媒体服务；构建失败不停止业务。核对本次选用的实际镜像与维护启动脚本，再固定本次镜像 ID，避免一次操作中标签变化。
4. 重新确认应用配置/当次容器集合未变化；写入持久维护标记，再优雅停媒体容器。只为明确的媒体服务执行 `--no-deps --no-start --no-build --pull never` 创建；先核对实际卷，再启动。
5. 核对最终 NAS 挂载和当次数据库/Redis ID 未被改变，保存独立维护收据。旧迁移报告、NAS 数据、旧 SSD 和清理清单均不改写；业务验收另行完成。

**维护启动边界：** 原 `run_web.sh` 会调用 `bootstrap_admin`，其当前实现会更新已有管理员密码；因此此入口沿用此前修复已采用的直接 Gunicorn 启动，跳过数据库迁移、账号初始化及 collectstatic。Worker 保留禁止任务恢复/重排的设置，不执行原发布脚本的递归 media chmod。普通业务环境变量仍采用当前配置，不覆盖登录密钥或密码。

配置快照保留 Compose 导出时已有的 `$` 转义，不再转义一次，避免含 `$` 的密码、令牌或命令在重新加载时改变。此行为已用真实 Compose CLI 离线重读验证，测试只使用合成配置。

这是一条媒体维护路径，不替代需要数据库 schema 迁移、静态资源更新等业务步骤的正式版本发布。应用 API/业务代码正常变化不会单独阻止 NAS 恢复；显式重建时若修改了启动脚本、entrypoint 或自定义启动命令，则需审核维护启动方式，不能直接运行未知的初始化行为。镜像脚本检查用不挂载媒体、无网络的临时 Python 容器读取脚本摘要，不运行应用入口。

失败保留私有报告，不自动 SSD 回滚或恢复旧镜像。开始停服务后，独立登记中的 `maintenance_report` 会阻止开机工具启动可能混合的容器；仅所属维护操作可继续启动，完整成功才清除此标记。进程中断后先查看报告和现场，再显式重新安排维护；新尝试保留原失败报告及关联，不手工删标记绕过检查。

## down -v、Docker 重装与外部入口

`docker compose down -v` 会删除配置中的普通 named volumes，external 卷除外。本工具没有 down、volume rm、prune 或创建数据卷命令；重建快照把已有数据卷全部视作外部资源，缺失便拒绝创建空替代品。[Docker 官方说明](https://docs.docker.com/reference/cli/docker/compose/down/)

如果用户用原应用配置执行 `down -v`，数据库卷、媒体父卷及其中的其他文件可能已被删除。NAS 文件仍在不等于业务可以立即恢复；先核实并恢复丢失的数据。Docker 重装丢失 NFS 卷元数据也不会自动改用 SSD，需要先恢复并核对原 NFS 卷定义。

本方案仅修改 mx-static，并为明确的构建/重建提供带 NAS 约束的命令行入口。它不能保证任意 root `docker run`、旧发布脚本或删除存储声明的命令也受控。要强制覆盖这些入口，需要另行接入 Docker API 控制；授权插件本身可能拒绝 Docker 请求，扩大故障影响范围，本轮未安装或启用。[Docker 授权插件说明](https://docs.docker.com/engine/extend/plugins_authorization/)

## 清理与当前验证范围

**日常禁止删除：** 重启、正式部署、容错恢复不得删除 NAS 文件，也不得删除/清空依赖应用的数据库、队列。恢复命令只调用已有容器的 `docker start`，不调用 `down -v`、删卷、SQL 删除、Redis flush 或队列 purge。恢复 helper 的 systemd 文件系统视图将 `/data`、`/mnt/nas` 设为只读；这个隔离不改变 Docker daemon 或正常业务进程的写权限，也不拦截用户在外部执行的 Docker 命令。

**迁移例外：** 用户明确授权的迁移流程可以按其清单、校验及验收条件进行清理（包括自身探测/暂存文件、明确登记的旧 SSD 文件）；普通 start/recovery/deployment 不会调用这些清理路径。当前 Part 1 仍未完成业务验收，不能由这条原则推断已经获准删 SSD。

mx-static 独立归档 worker 的 NAS purge 已停用：删除本地对象不再排队删除远端，旧 purge 队列原样保留且不领取；I/O 子进程直接收到 purge 也拒绝。常规归档不覆盖冲突的 NAS 对象/元数据，不自动清理 NAS 暂存文件；成功发布保留暂存硬链接（不多存一份内容），失败残留也保留，需要以后通过明确迁移维护处理。它没有接入 po-infra 的业务库或队列。

原迁移/切换/权限探测/SSD 清理入口仍使用严格迁移证据，没有解除逐文件校验或改写旧基准。新的媒体恢复通过不授权清理。若此后重建/升级，旧清理计划的应用身份校验仍可能拒绝，需重新核验，不可手改报告摘要绕过。

Part 1 当前继续保留 SSD，业务验收尚未全部完成；Part 2 仍仅有预复制能力，不能复用 Part 1 的卷、登记或维护入口。

本地验证覆盖新 env/镜像/容器 ID、部署目录及历史报告不可用、数据库变更、不依赖业务 API 健康、停机/NAS 离线/错误卷、并发替换、暂停、副本/临时容器、未完成维护标记、缺数据卷、构建失败、构建期间配置漂移以及仅媒体服务重建。模拟测试不能替代真实 EL8/Docker/NFS、构建或重启验收。

本地增加了整项目冷启动、部分服务停止、真实依赖标签、健康等待/超时、空数据库拒绝、并发替换及 NAS purge 保留测试。真实 Compose v2.34.0 的离线配置往返测试已通过；没有调用 Docker daemon 创建、构建或启动生产容器。

本次验证：304 项 NAS/Python 测试、75 项 Node 测试通过；29 个运行模块通过 Python 3.6 语法检查，11 个 Bash 脚本和 NAS JSON 检查通过。Node 测试只使用 localhost 和临时合成数据，不连接服务器或 NAS。
