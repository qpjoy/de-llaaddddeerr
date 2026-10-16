# 迁移

一个文件一次变更，按编号顺序执行，由 `@qpjoy/mx-common` 的迁移器跑
（`node server/migrate.mjs`，或 compose 里的 `migrate` 服务）。

## 一条铁规则：已经跑过的迁移不能再改

迁移器给每个文件算校验和存进 `schema_migrations`。**改动一个已应用的文件——哪怕只改
一个注释——都会让它拒绝往下走**，报 `Applied migration changed on disk`。

这不是洁癖。它挡住的是这样一类事故：有人改了 `003` 的建表语句，新环境建出来的库和老
环境不一样，而两边的迁移记录都显示"已应用"。校验和是唯一能发现这件事的东西。

实际踩过两次：

1. **注释也算。** `specs/` 改名成 `docs/` 时，一次 `sed` 顺手改了六个已应用文件里的
   路径注释。文件内容变了，校验和就变了，所有已部署的库当场无法迁移。
   **已应用的迁移里那些指向 `specs/…` 的注释因此保持原样**——它们是冻结的，
   而不是被漏掉的。
2. **换行符也算。** 库如果是在容器里（LF）迁移的，在 Windows 主机上（CRLF）再跑
   `node server/migrate.mjs` 会把每个文件都算成"改过"。同一个库要么一直在容器里迁移，
   要么一直在主机上，别换着来。

要改一个已应用迁移的效果，**加一个新文件**。

`023_mission_execution_epoch.sql` 为 Rig Mission 增加执行代次。部署时先暂停接收新 Mission、结束或回收旧执行实例，再迁移并统一升级服务。旧版写入代码没有代次条件，不能与新版长期混跑；仅添加数据库列不构成迟到写入保护。该变更不自动重放被回收任务。

`024_test_workbench.sql` 增加项目目录元数据和 Mission 的 `draft` 状态。先迁移数据库，再更新服务和桌面客户端，旧服务的同步校验不接受新草稿状态。用例版本通过现有 `rig_state` 文档存储（`cases-<mission UUID 去连字符>`），采用 CAS 拒绝跨副本的陈旧编辑；它不与 Runtime 整行写入共用 Mission 文档。登记目录不会授权服务端读取或执行该目录。此迁移不启动模型或测试。

`025_workbench_execution.sql` 为 Run 增加不可变的 `workbench` 快照和 Mission 查询索引。先迁移数据库，再统一升级所有调度/认领/结果接收服务，最后启用新派发入口。旧版调度器不会读取该快照，不能与新版共同处理新的工作台 Run；桌面客户端也需同步更新。已有 Run 的空快照继续使用原路径，不回填或自动重跑。数据库主键约束保证同一幂等请求只产生一个 Run。

`026_project_access.sql` 为 App 增加 `project_access` JSON 策略（所有者、范围、成员和权限版本）。NULL 表示历史部署共享，迁移不推断所有者、不公开私人 Mission。旧项目首次修改权限时由获授权的管理员取得所有者身份；新工作台项目显式创建为 private。策略采用项目行锁与 revision CAS，权限变更和审计同事务提交。先迁移，再统一升级全部 HTTP/Agent 服务及桌面客户端，之后启用私人项目和成员管理；旧服务不检查项目权限，不能在启用后继续接收请求。策略权限由应用层执行，迁移本身不提供数据库 RLS、多租户隔离或 Runner 隔离；长期机器凭据仍需作为可信执行基础设施管理。暂不支持删除包含规程历史的项目，避免规程失去项目关联后扩大可见范围。

## 已经不同步了怎么办

先弄清楚差在哪：库里的实际 schema 和文件说的是不是一回事。

```sql
select filename, applied_at from schema_migrations order by filename;
```

- **只是注释或换行符不同**（schema 一致）→ 更新那一行的 `checksum` 即可。
- **schema 真的不一样**（曾经有人改过已应用的文件）→ 先写 SQL 把库补齐到文件描述的
  样子，再更新校验和。**不要只更新校验和**：那等于把不一致签字确认了。
- **库里没有值得留的数据** → 直接重建最省事。

## 本地起一个干净的库

```bash
docker compose -f deploy/compose/docker-compose.yml up -d postgres
docker compose -f deploy/compose/docker-compose.yml run --rm migrate
```

Windows 上如果 55432 被 Hyper-V 的保留端口段占了（症状是
`bind: An attempt was made to access a socket in a way forbidden by its access
permissions`，看着像防火墙其实不是），换一个端口：`MXT_PG_PORT=55500`。
保留段用 `netsh interface ipv4 show excludedportrange protocol=tcp` 看。
