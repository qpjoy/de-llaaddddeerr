# mx-base：独立基础设施

2026-09-12：用户确认尚未线上部署。此前仅预留 Jenkins 构建基础设施；现在按应用分别部署和管理。仓库内容不是线上状态证明，后续用 `status` 查看目标主机的实际状态。

| 应用 | 职责 | 部署与状态 |
| --- | --- | --- |
| mx-static | 多媒体持久采集、缓存、文件读取与签名预览 | 独立 Docker Compose，writer + reader，默认 18200 / 18201 |
| jenkins | 可选的制品构建 | 原 Kubernetes `mx-base` namespace，默认 NodePort 30880，未自动启用 |

mx-common 复用代码；mx-test-framework 调度测试和构建作业；mx-insight-hub 管数据产品、原始响应、租户授权和计费；mx-base 承载可独立运行的基础服务。MX-H2I 登录、网络、DNS 不依赖 mx-static。

## 统一入口

在目标 Internal 主机、`electron-dock/mx-base` 目录执行：

```sh
bash scripts/manage.sh                  # 展示状态 → 选择应用 → 选择操作
bash scripts/manage.sh status           # 当前主机 / Docker / Kubernetes 上下文及所有登记应用
bash scripts/manage.sh deploy           # 交互选择，非交互必须指定应用
bash scripts/manage.sh deploy mx-static # 生成首次凭据、准备目录、构建、等待健康
bash scripts/manage.sh jobs mx-static   # 项目任务状态计数、writer 内存缓存指标
bash scripts/manage.sh logs mx-static
bash scripts/manage.sh restart mx-static
bash scripts/manage.sh stop mx-static   # 保留文件、队列、凭据
bash scripts/manage.sh start mx-static
bash scripts/manage.sh doctor mx-static
```

Jenkins 使用相同的 `操作 jenkins`；额外支持 `password jenkins`、`agent-cmd jenkins`。不提供全量部署、全停或删除数据命令。Docker 不可用、集群访问失败显示 UNKNOWN；只有查询成功且没有对应资源才显示 NOT DEPLOYED。`status` 只读，不会启用任何应用。Jenkins 停止仅缩容为零。

## 首次部署 mx-static

```sh
cp mx-static/.env.example mx-static/.env
# 按主机规划编辑数据目录、本机队列目录、UID/GID、绑定地址。
bash scripts/manage.sh deploy mx-static
bash scripts/manage.sh status
```

默认 `/srv/mx-static/data` 放文件，`/srv/mx-static/state` 放 SQLite 队列。使用 root 执行管理命令时只负责创建目录并交给配置 UID/GID，容器仍以 1000:1000 运行。非 root 部署须预先准备可写目录，UID/GID 与服务进程一致。重复部署不会轮换凭据。

当前暂停 Hub 接入，先验收独立静态服务。可选 NAS 使用 `attach mx-static` / `detach mx-static` / `storage mx-static`，不会替换主服务数据卷。详细步骤、接口、故障恢复和 NAS 管理见 [mx-static 运维文档](mx-static/docs/README.md)。首次部署需保证主机有 Docker Compose v2、镜像仓库网络和足够磁盘空间。

## 目录边界

- `scripts/manage.sh`：应用选择和通用入口；`scripts/apps/jenkins.sh` 保留 Jenkins 原有生命周期实现。
- `mx-static/`：该应用自己的源码、Compose、环境配置、文档和测试；独立凭据及两套数据挂载。
- `jenkins/`、`deploy/k8s/internal/`：现有 Jenkins 结构与资源名称保留，避免不必要迁移。
- `docs/adr/`：跨应用边界和架构决策；新增基础设施应拥有独立部署、数据、凭据和状态操作。

相关文档：[分层决策](docs/adr/0002-independent-apps-and-media-storage.md)、[Jenkins 说明](docs/jenkins.md)。
