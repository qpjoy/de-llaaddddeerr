# 将 NAS 约束接入原应用发布脚本

本入口补上 `deploy_public_ghcr.sh --local-build` 重建时遗漏 NAS 子挂载的问题。检查实现和声明由 mx-static 管理；应用只在统一 `compose()` 函数调用已安装入口。使用系统 Python 3 标准库和现有 Docker Compose，不增加常驻服务、pip 包、应用 API 或数据库查询依赖，也不依赖 mx-static 工作区路径或历史应用镜像。

## 当前现场与启用顺序

infra 当前仍是 SSD 写入状态。最新在线报告 `infra-1dfa9196bd8c4e32823ca73276630c74` 中有 864 个 SSD 独有文件待补齐，复制完成回执尚未回传。NAS 保护接入可以先安装；此时发布前检查应当**拒绝 infra 发布**，不能用原发布脚本直接遮住新 SSD 文件。

顺序是：安装工具和发布接入 → 完成本次在线 copy → 维护窗口停媒体写入并重新比较两侧、补齐新增文件 → 使用本次成功 copy 尝试执行修复切换 → 核对实际 NAS 挂载及业务 → 允许正常发布。`repair switch` 的最终 UNION 比较在媒体服务停止后执行，保留 NAS 独有文件和既有属性；数据库/Redis 不参加媒体停写。任意外部写入或同名冲突导致核验失败时停止，不自动覆盖或回滚 SSD。

**本地实现/测试通过不等于服务器已启用。** 部署接入和真实重启仍需现场确认；不要为了验证而立即执行完整应用发布、重启 Docker 或删除旧媒体。

## 安装

先同步本次 mx-static 文件。在服务器 mx-static 目录，以 root 执行（仅更新已有工具快照，不启动/重建业务）：

```bash
bash scripts/manage.sh nas recovery install
```

应用发布脚本改动保存在 `deploy/nas/integrations/po-infra-release.patch`，只涉及一个应用文件。若已通过应用仓库同步了该改动，就不要重复应用补丁。否则在服务器 mx-static 目录执行以下命令；任一步失败即停止，应用脚本版本不匹配时回传错误，不强制覆盖：

```bash
MX_NAS_PATCH="$(pwd)/deploy/nas/integrations/po-infra-release.patch"
git -C /home/lcy/test/Delta/mx_data apply --check "$MX_NAS_PATCH" &&
git -C /home/lcy/test/Delta/mx_data apply "$MX_NAS_PATCH" &&
bash -n /home/lcy/test/Delta/mx_data/scripts/deploy_public_ghcr.sh
```

补丁应随 po-infra 的发布脚本长期保留并纳入其版本管理。原两条发布命令及参数不用增加 NAS 开关；缺少已安装检查入口时脚本直接失败，不跳过保护。非 root 发布通过 `sudo -E` 调用检查入口，需要相应 sudo 权限；保留应用用于 Compose 插值的导出变量，Python 用 `-E -s` 忽略 Python 环境注入。Docker 连接固定为本机 socket，并核对主机和数据根目录。

仅核对 infra 接入是否可用，可在服务器运行以下只读命令。修复切换前应报告仍在 SSD；这不是要求直接重新部署：

```bash
/usr/bin/python3 -E -s -B /usr/local/lib/mx-static-nas/current/scripts/nas/release.py \
  -p mx_data \
  --env-file /home/lcy/test/Delta/mx_data/deploy/.env.ghcr \
  -f /home/lcy/test/Delta/mx_data/docker-compose.ghcr.yml \
  -f /home/lcy/test/Delta/mx_data/docker-compose.local-build.yml \
  -- mx-nas-check
```

## 行为与边界

- `mx_data`：渲染当前应用配置并最后加入 `part1.release.json`，所有媒体服务含原生 NFS 子卷和 nocopy，gateway 只读。现有应用启动命令、环境变量、镜像、API、数据库配置不由存储接入重写。改变媒体角色/路径或项目/卷身份须重新核对。
- `delta_59202`：仍处预复制阶段，保持本地存储，绝不使用 infra 卷；以后有切换记录或 NAS 声明时，未支持的发布适配会拒绝执行，不能静默继续 SSD。
- 注册、NAS 声明、NFS 卷定义或必需数据卷缺失时失败；所有 infra 数据卷作为 external 引用。已有数据库/Redis 的卷映射与当前模型不同时拒绝发布。不会创建空数据卷修复 `down -v`、Docker 重装或缺失元数据。[Docker external 卷说明](https://docs.docker.com/reference/compose-file/volumes/#external)
- 每次 Compose 调用前检查现有媒体消费者的挂载声明与运行容器的内核 NFS 来源。仍有 SSD 媒体消费者时拒绝发布，避免直接加挂载遮住未合并数据。不存在的媒体容器可由显式应用 `up` 创建；末尾检查要求十个角色齐全。
- 临时 `compose run` 同样携带 NAS 声明，禁止通过其 `--volume`、`--entrypoint` 等额外选项绕过审核模型。原应用命令及业务参数按数组原样传递；不打印私有渲染配置。
- 应用脚本在修改 `.env`、git pull、构建、任务维护之前先检查；NAS 模式下，其媒体权限处理会跳过整个 raw-media 子树；发布后再次检查挂载。delta 原权限行为不变。
- 复用现有迁移/恢复锁，正在复制、切换或清理时，接入命令失败而不等待后突然发布；锁覆盖每次 Compose 执行，不把整段应用业务发布变成数据库事务。发布期间不要并发编辑配置或从其他入口部署。
- 本入口不提供 `down`、`rm`、prune，不删除 NAS 文件、SSD 文件或数据库/队列，不自动执行任何业务初始化、构建、重启或回滚。只有应用脚本明确调用的命令才会透传执行。原应用发布自身的数据库迁移、管理员初始化和任务维护仍归应用管理；本接入不代替登录验收，也不能拿完整发布来测试 NAS 修复。

## 重启为什么不会重新选择 SSD

普通容器 restart 使用现有容器配置，不重新应用 Compose 文件；原生 NFS 子卷已在容器配置中时，restart 不会因覆盖文件未出现在命令行就移除它。此前两次事故发生在重新创建容器的路径，这正是本接入覆盖的入口。[Docker restart 说明](https://docs.docker.com/reference/cli/docker/compose/restart/)

服务器冷启动仍由 Docker 原生 NFS 挂载和已安装的 mx-static 恢复策略负责。NAS 不可用时挂载失败或等待，不由本工具降级到父 SSD；恢复只补启动已有依赖，不能创建替代本地卷。不需要启用全 Docker 的 `RequiresMountsFor=/mnt/nas` 来向容器添加子卷；Docker 原生 NFS 卷与宿主机 `/mnt/nas` 是两种挂载。真实断电/重启演练尚未进行。

本接入保护的是保留补丁的应用发布入口，以及 mx-static 恢复/维护入口。任意 root 原始 `docker compose up`、`docker run`、删除补丁或回退旧应用脚本仍可绕过；本轮没有安装全局 Docker API 授权插件。原始 `down -v` 若使用不含 external 声明的旧配置，仍可能删除数据库/其他卷，不能把本接入视为全主机防删系统。

## 验证

本地 332 项 NAS 测试、31 个 Python 3.6 语法检查、10 个 mx-static Bash 脚本及实际应用脚本的 Bash 语法检查通过。回归覆盖 NAS/数据库卷缺失、SSD 消费者、错误卷选项、NAS 不可达、数据库卷映射漂移、修复占锁、声明/环境变化、挂载遮盖、缺登记/维护未完成、新镜像和业务 env 保留、delta 隔离、命令参数绕过、后置挂载失败及不存在容器的显式重建。真实 Compose CLI 离线验证覆盖文件合并，保留环境/命令/数据库设置；补丁在应用脚本临时副本通过 git apply，获得用户明确授权后已应用到本地 po-infra 的这一个脚本，并验证两个实例的参数传递。其他本地已有修改保留；没有对生产服务器执行发布或重启。
