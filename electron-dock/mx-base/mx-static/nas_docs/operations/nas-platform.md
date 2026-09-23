# mx-static NAS 管理结构与多项目接入

最新统一模式及易读显示见 [易读输出与已迁移项目恢复](readable-recovery.md)。无需逐个维护 enable 清单；项目仍须成功切换、审核适配并登记到安装快照。

用户已决定：NAS 运维及业务存储适配统一放在 mx-static，不散落到 po-infra 等业务仓库。生产安全基线见 [SAFETY](../SAFETY.md)，具体开机机制见 [统一管理](unified-management.md)。

## 目录与职责

```text
mx-static/
  AGENTS.md                         后续维护必须读取的生产安全约束
  deploy/nas/
    profiles.json                   项目索引、迁移任务与报告/清单登记
    hosts/mx-internal-server.json    NAS 地址、导出、宿主挂载和受查服务
    projects/infra.json              infra/mx_data：Part 1 及已审核能力
    projects/delta.json              delta_59202：Part 2，仅预复制
    part1.storage.json              已应用 NAS 子卷声明
    mx-static-nas-boot.service       统一开机恢复单元模板
    mx-static-nas-boot.timer
  scripts/manage.sh                  唯一公共入口：nas ...
  scripts/nas/
    display.py                      中文显示 / 原始 JSON / 格式化 JSON
    manage.py                       调度、安装、恢复、兼容旧命令
    recovery.py                     统一核对成功迁移和恢复覆盖，保留暂停项
    catalog.py                      项目登记校验与二级命令路由
    host.py                         本机 NFS 挂载/进程/服务诊断
    action_log.py                   root 私有操作审计
    projects/infra.py               infra 发布风险/应用权限检查
    projects/infra_probe.py         容器内有界权限探测
    precopy.py / cutover.py / ...    已验证的迁移/清理引擎
  nas_docs/
    SAFETY.md                       首次迁移成功后的数据安全约定
    projects/infra.md               业务特有行为与运维边界
    operations/                     公共流程、恢复、故障处理
    evidence/                       已收到的现场证据与未知项
```

这里 `infra` 是受管业务项目名，对应 Compose `mx_data`；`host` 是宿主机/NFS 客户端层，两者不同。`part1` / `part2` 是迁移任务，不作为所有业务项目的永久命名方式。

## 二级命令

所有命令在 mx-static 目录执行。用户使用 root 时不必加 sudo。旧的 `nas status part1` 等命令保持兼容。

```bash
bash scripts/manage.sh nas project list
bash scripts/manage.sh nas host status
bash scripts/manage.sh nas host processes
bash scripts/manage.sh nas host mount-check
bash scripts/manage.sh nas host network

bash scripts/manage.sh nas infra status
bash scripts/manage.sh nas infra locate
bash scripts/manage.sh nas infra logs
bash scripts/manage.sh nas infra recovery
bash scripts/manage.sh nas infra permissions check
bash scripts/manage.sh nas infra deployment audit
```

`infra ...` 等价于 `project infra ...`；`delta ...` 同理。`project list` 可离线查看 Git 登记，不依赖 Node、Docker daemon 或 NAS。

宿主机命令读取本地挂载表、NFS/RPC 相关进程及 D 状态进程、指定 systemd 单元和网络路由。它不 stat NAS、不 kill 进程、不启动 mount、不修改 fstab。D 状态不一定由 NFS 导致；进程列表只输出 PID、comm、状态、等待点，不输出可能含密钥的完整命令行。Docker 暂不可用时也可以运行这些宿主诊断。

项目名已定位各自登记任务，无需重复写 `task part1` / `task part2`；显式任务写法仍兼容。回收任务归属与能力照常检查：

```bash
bash scripts/manage.sh nas infra status
bash scripts/manage.sh nas infra cleanup check
bash scripts/manage.sh nas infra cleanup --business-accepted
bash scripts/manage.sh nas delta copy --unlimited
```

其中 `cleanup check` 只核验；不带 `check` 的 `cleanup --business-accepted` 是真正删除旧 SSD 文件的操作，只有业务验收正常后执行。其底层仍是已验证的限定清单清理工具，使用已登记计划，不自动选择“最新目录”。Part 2 尚无切换/清理回执，`delta cleanup` 会拒绝，待第二卷正式迁移后再添加相应已审核能力，不能绕过。

持久恢复同样归到统一入口：

```bash
bash scripts/manage.sh nas recovery install
bash scripts/manage.sh nas recovery check infra
bash scripts/manage.sh nas recovery enable infra
bash scripts/manage.sh nas recovery status infra
bash scripts/manage.sh nas recovery disable infra
bash scripts/manage.sh nas recovery run infra
```

以上是可选操作列表，不是要连续执行的安装脚本。install 安装/更新由 Git 管理的代码和单元；enable 才启用。更新 Git 工具后重新 install，使安装快照包含新增子目录适配器与声明。开机恢复只补启动已登记 NAS 容器，失败重试、成功后结束；运行中的短暂断线交给 hard NFS，异常再观察处理。数据库/队列继续原平台管理，关闭恢复 helper 不停止业务容器。

## 新业务的大媒体/冷数据如何接入

1. 先只读收集项目/容器/PVC、目录/卷、占用、所有读写者、数值 UID/GID、数据库引用的路径、发布与备份方式。冷数据也可能仍被任务或索引引用，不能按“很久没用”推断可删。
2. 在 Git 加独立项目和任务声明，明确源、独立 NAS 目标、容器内路径、权限与维护窗口。不合并进 infra，也不复用其他业务的已有媒体目录。所有任务必须归属一个项目，同一源卷不能被两个项目隐式登记。
3. 先按 `manual-review` 仅登记只读能力；复制、切换、恢复、清理须配套审核相应适配器。当前迁移引擎只支持已明确的两卷 Docker 原始媒体，不能把 JSON 记录直接当成通用 host-directory 或 K8s 迁移实现。新类型的目录/PV 要先实现其检查与测试。
4. 做实际业务身份的小批 I/O 测试，再在线预复制；停写窗口进行最终增量与逐路径检查，切换所有消费者，验证新旧媒体和任务。
5. 业务验收后单独生成并审核回收清单，保持同一任务的证据、权限与进度。删除动作从不挂到开机恢复或自动巡检里。

数据库、持久队列、模型缓存与媒体各自登记，不把整个 `/data/docker` 或 `/data/k8s` 搬去 NAS。数据库用其自身备份/复制与切换流程，不使用媒体目录清理脚本。

## 与未来静态文件服务器协作

当前已有业务通过各自 Docker NFS 子卷访问原始媒体，**NAS 管理工具不依赖 mx-static HTTP 服务启动**。mx-static 静态服务现有代码是 SSD 上 writer/reader/控制库，加独立 NAS 归档 worker；它有自己的对象、manifest 和校验生命周期，并不是可以直接管理任意 raw_media 的通用 NAS 网关。

后续可分两种接入：

- 已迁移的业务媒体：优先保留业务写入方，通过独立只读路径为静态/Nginx 服务提供读取；访问控制、URL/Range、缓存失效及新增文件的读权限需要单独验证。不要让归档 worker 清理业务目录。
- 新的受管对象：通过明确的导入/API进入 mx-static 自己的对象空间；热处理、临时文件、缓存与控制数据库在 SSD，归档到独立 NAS namespace，按其 manifest 生命周期管理。现有媒体不会因“attach”自动变成可回收对象。

目前尚未实施静态服务与这些业务目录的联动，也未把原始媒体自动导入。后续可复用同一 host/project 登记、权限探测和恢复规则，存储写入/清理所有权必须明确。

## 验证边界

本结构初版验证时 140 项 NAS 本地测试通过，其中新增 19 项覆盖二级路由与跨项目拒绝、显式验收/写探测边界、旧 CLI 兼容、目录穿越/符号链接和非法能力拒绝、离线登记查询、嵌套安装文件、主机挂载和进程解析、实际临时文件读写探测及失败清理、应用身份不被 root 覆盖、发布风险脱敏报告、私有操作日志。所有 Python NAS 子目录通过 3.6 语法检查。

后续易读输出和统一恢复版本共 166 项测试通过，见上方新文档。没有连接服务器执行探测、清理、安装或重启；EL8 Python 3.6、实际 NFS 权限与断线恢复仍以现场回执为准。
