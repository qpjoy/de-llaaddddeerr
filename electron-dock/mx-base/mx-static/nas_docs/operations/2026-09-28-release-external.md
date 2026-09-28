# 9 月 28 日：业务正常，重新部署被 external 声明检查阻止

用户确认 infra 约 500 GiB 媒体已迁移，原 2 TiB SSD 上旧媒体已删除；业务正常运行。现有发布命令仍为 `/home/lcy/test/Delta/mx_data/scripts/deploy_public_ghcr.sh --local-build`，无 instance，端口 59201。截图错误为：

```text
NAS release blocked: All existing data volumes must be external for NAS releases.
```

## 报错含义

旧版 `scripts/nas/release.py` 已加入 `part1.release.json` 并渲染当前 Compose。NAS 子挂载模型验证之后，检查**所有顶层卷**是否 `external is True`，任一个缺失或为 false 就触发本条错误。此时还未执行数据卷存在性检查、当前容器挂载检查、NAS 2049 连通检查或实际 Compose 发布命令。

应用脚本先调用 `mx-nas-mode`，再更新 env、拉代码、构建或重建；本次截图符合在发布前检查被阻止，现有容器不因这项检查被停止。不能据此判断 NAS 掉线、数据丢失或 SSD 删除错误；当前运行挂载仍可用 `nas infra storage check` 独立确认。

`external` 是卷生命周期归属，不是磁盘位置。Compose 引用平台上已有卷，缺少时失败，不代为创建；本地 PostgreSQL/Redis 卷也可以 external，不需要迁至 NAS。[Docker 官方说明](https://docs.docker.com/reference/compose-file/volumes/#external)

## 已确认原因

本地应用 base/local-build 文件加当前 NAS 发布覆盖，在 Compose v2.34.0 下离线渲染得到五个卷全部 external：`media_data`、`mx_static_raw_media_nfs`、`postgres_data`、`redis_data`、`static_data`。使用临时复制和空 env 渲染，没有运行容器或修改应用目录。

服务器已回传 Compose v2.27.0。首次诊断中的 `sudo -E docker compose ...` 被 sudo 策略拒绝，后续 JSONDecodeError 仅为空输入，不是 NAS/模型错误。Compose `config` 不访问 Docker 守护进程，改为应用普通用户渲染，保留用户原有插值环境，不调整 sudoers。

随后普通用户诊断成功，确认唯一不满足项是新增应用卷：

```json
{"key":"claude_sessions","name":"mx_data_claude_sessions","external":false}
```

使用它的是 web、worker、worker-agent-data-hub、worker-agent-interactive、worker-agent-long、worker-agent-short、worker-strategy-draft。其余 `media_data`、`mx_static_raw_media_nfs`、`postgres_data`、`redis_data`、`static_data` 全部 external=true。因此此次原因已定位为新应用会话卷不在原五卷声明覆盖内，不是 NAS 媒体 external 声明丢失，也不是依据截图推断 Compose 版本不兼容。

普通用户 `docker volume inspect` 因 Docker socket 权限失败，改为 `sudo docker volume inspect`（不加 `-E`）后，服务器明确返回 `no such volume`：`mx_data_claude_sessions` 当前不存在。不能只补 `external:true` 就称问题解决，那样仍会被现有数据卷缺失检查阻止。

用户随后明确确认这是首次新增卷，并回传配置和现有容器挂载元数据：默认本地 driver、无 driver_opts，目标为 `/root/.claude/projects`，七个消费者相同，现有容器在该位置及其父/子目录没有其他挂载。十个媒体容器仍声明 NAS 子卷，数据库、队列及 static 卷单独保留。这些信息足以支持正常新增应用卷；不是从卷名推断旧会话可丢弃，也不代替发布时的内核挂载检查。

## 修复位置与规则

只改 mx-static 的 `scripts/nas/release.py` 及项目适配 `projects/infra_release_volumes.py`。应用已经接入统一检查器，原部署脚本、Compose 文件和发布命令无需再加新逻辑，也不需要把 `claude_sessions` 手工设为 external 或预先创建。

- 五个基础卷继续 external 且必须存在：NAS、media、static、PostgreSQL、Redis。额外显式 external 卷也必须存在。
- 新的 Compose 管理卷允许默认/local driver、无 driver_opts，名字须在当前项目命名空间；不得与其他卷声明同名。
- 新卷目标不能覆盖媒体/static、其他配置挂载/tmpfs 或现有容器挂载，不能将旧 bind/匿名卷或其他 named volume 悄悄替换为空卷。
- 如果新应用卷已经存在，核对本地驱动、Docker 数据路径和 Compose 项目/卷键归属；发现其他项目使用或容器引用一个缺失卷，仍拒绝发布。
- 只读预检、开机恢复、存储维护不创建卷；只有用户明确发起的应用 Compose 发布命令按原配置创建普通新卷。该规则不按 `claude_sessions` 写死，其他符合条件的新增应用卷也适用。

因此，会话卷仍是本地应用存储，媒体仍在 NAS。这个变更不执行 NAS/数据库/队列删除，也不新增账号初始化、数据库迁移或重启行为。应用完整发布原有的业务逻辑仍由应用脚本负责。

## 服务器更新步骤

先把 mx-static 修改及新增适配文件一起同步到服务器。在服务器 mx-static 目录，以 root 执行：

```bash
bash scripts/manage.sh nas recovery install &&
bash scripts/manage.sh nas recovery check
```

本次本地运行时快照摘要为 `aa1049b7eaba9364b176`；后续其他运行时代码/声明改动会改变摘要。安装保留原有启用策略，不启动或重建业务；无需重新登记存储或重复迁移、清理。然后以 root 运行只读发布预检（无 `sudo -E`，不创建会话卷）：

```bash
/usr/bin/python3 -E -s -B /usr/local/lib/mx-static-nas/current/scripts/nas/release.py \
  -p mx_data \
  --env-file /home/lcy/test/Delta/mx_data/deploy/.env.ghcr \
  -f /home/lcy/test/Delta/mx_data/docker-compose.ghcr.yml \
  -f /home/lcy/test/Delta/mx_data/docker-compose.local-build.yml \
  -- mx-nas-check
```

如果实际发布使用自定义环境文件或额外 Compose 文件，预检也使用相同文件与插值环境。预期输出 `NAS release preflight: mx_data / nas`。通过后，应用用户可以按原完整发布命令部署；发布入口会再次检查，并由 Compose 在需要时创建应用卷。发布结束后在 mx-static 目录核对：

```bash
bash scripts/manage.sh nas infra storage check
```

预检失败时按具体卷键/挂载错误处理，不改用未接入检查的旧部署入口。此规则不能拦截直接调用 Docker 的 root 操作；原始 `down -v` 仍可能删除 Compose 管理的应用卷。新应用卷也不因此自动获得 NAS 迁移记录或数据备份。

## 验证范围

本地 368 项 NAS 测试、33 个运行时 Python 文件的 Python 3.6 语法检查和 11 个 scripts 下 Bash 脚本语法检查通过。新增回归覆盖首次应用卷、后续复用、其他新增卷、基础卷缺失、卷名冒用、归属/驱动变化、跨项目使用、旧挂载替换、路径/tmpfs 遮盖，以及预检不创建任何卷。真实 Compose CLI 仅离线渲染，验证新增普通卷与原五个 external 卷、NAS nocopy 覆盖可共存，环境、命令和数据库声明保留。没有连接生产服务器，也没有在本地或服务器实际发布、创建卷或重启业务。
