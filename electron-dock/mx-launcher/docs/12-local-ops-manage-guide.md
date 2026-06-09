# Local Ops Guide for manage.sh

这份文档给“不熟 K8s 的运维”使用。先在本机把 Docker Compose 跑熟，再进入 K8s
dry-run，最后才做 K8s apply。

所有命令都在仓库根目录执行：

```bash
cd /Users/qpjoy/workspace/qpjoy/de/de-llaaddddeerr/electron-dock/mx-launcher
```

## 0. 先看总指南

```bash
bash scripts/manage.sh ops guide
```

这个命令只打印建议路径，不会启动服务。

## 1. 本机环境检查

```bash
bash scripts/manage.sh ops doctor
```

重点看：

- `node` 和 `pnpm` 是否存在。
- `docker` 是否存在。没有 Docker 就不能跑 Compose shadow。
- `kubectl` 是否存在。没有 kubectl 也可以先跑 Compose shadow。
- `server package`、`shadow compose`、`k8s internal-shadow manifests` 是否 OK。

如果 Docker/K8s 检查不通过，先打开 Docker Desktop。要跑 K8s，还需要在 Docker
Desktop 里启用 Kubernetes。

## 2. 不碰 K8s：先跑 Compose shadow

Compose shadow 是最容易理解的路径：它会启动两个容器：

- `mx-internal-postgres-shadow`: PostgreSQL。
- `mx-launcher-server-shadow`: Internal API。

看计划：

```bash
bash scripts/manage.sh ops local-shadow plan
```

一键构建、启动、smoke、看状态：

```bash
bash scripts/manage.sh ops local-shadow cycle
```

成功时应看到 HTTP smoke：

```text
OK healthz
OK app-center apps
OK platform kernel smoke
```

查看状态：

```bash
bash scripts/manage.sh ops local-shadow status
```

查看日志：

```bash
bash scripts/manage.sh ops local-shadow logs
```

停止容器：

```bash
bash scripts/manage.sh ops local-shadow down
```

注意：`down` 会停掉容器，但保留 PostgreSQL Docker volume。这是为了模拟服务重启后
数据仍然存在。

## 3. K8s 先 dry-run，不创建资源

当 Compose shadow 跑熟后，再看 K8s 路径。

看 K8s 部署计划和概念解释：

```bash
bash scripts/manage.sh ops k8s-shadow plan
```

做 dry-run：

```bash
bash scripts/manage.sh ops k8s-shadow dry-run
```

dry-run 会让 kubectl 解析这些对象，但不会创建资源：

- Namespace
- ConfigMap
- Secret
- PostgreSQL Service + StatefulSet
- Migration Job
- Internal API Service + Deployment

如果 dry-run 报 `connect: operation not permitted`，通常是当前执行环境访问不了
Docker Desktop Kubernetes API；在本机终端直接执行通常可以。

## 4. 真正部署到本机 K8s

确认 Docker Desktop Kubernetes 已启用后执行：

```bash
bash scripts/manage.sh ops k8s-shadow apply
```

这个命令会按顺序执行：

1. 创建 namespace。
2. 创建 Internal API ServiceAccount。
3. 创建 Internal API ConfigMap。
4. 创建 `mx-dns` namespace 和 baseline `coredns` ConfigMap。
5. 从本地环境变量生成 Secret。
6. 启动 PostgreSQL StatefulSet。
7. 创建 CoreDNS ConfigMap writer RBAC。
8. 等 PostgreSQL ready。
9. 跑 TypeORM migration Job。
10. 等 migration Job complete。
11. 启动 Internal API Deployment。
12. 等 Internal API rollout 完成。

可选设置数据库密码：

```bash
PG_USER=mx_internal PG_PASSWORD=your-password PG_DB=mx_internal_shadow \
  bash scripts/manage.sh ops k8s-shadow apply
```

不设置时使用 shadow 默认值，只适合本机测试。

也可以一键跑完整 K8s 验证：

```bash
bash scripts/manage.sh ops k8s-shadow cycle
```

`cycle` 会执行 `build image -> apply -> rollout restart -> status -> smoke -> db-summary`，
最后保留环境运行，方便继续看日志或手动访问。K8s smoke 会真实调用 CoreDNS apply API，
把签名 zone snapshot 写入 `mx-dns/coredns`。确认完成后再执行 `down`。

## 5. Domestic / Oversea 插槽计划

Internal API 运行后，可以先让脚本生成 site slot plan。这个动作只调用 Internal 管理面，
不会 SSH 到远端，也不会使用 root 改机器。Executor V1 也是这个边界：它生成可审计的
preflight/apply 执行清单和门禁，不直接执行远程命令。

先规划 Oversea：

```bash
SITE_SLOT_RELEASE_REVISION=shadow-001 \
  bash scripts/manage.sh ops site-slot materialize oversea

MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
  bash scripts/manage.sh ops site-slot oversea-plan oversea.example.com
```

Oversea plan 会先产出 `prepare-access-stack`、`configure-oversea-access`、
`publish-oversea-subscription` 和 `deploy-slot-services` 阶段。V1 仍不在 Internal 里直接
裸跑 SSH；它生成给 runner worker / site-agent 执行的部署清单。Internal 先让
Release Center materialize 模块化 artifact set，不同步整个仓库：Oversea 只接收
`./artifacts/site-slots/oversea/mx-oversea-access-stack.tar.gz` 和最小 site-agent /
forwarder 组件，通过 `rsync` over OpenSSH 推到 `/opt/mx/incoming`
（没有 `rsync` 时才用 `scp` 兜底），再解到 `/opt/mx/releases/.../<release-revision>`
并切换 `/opt/mx/current/...` 指针。随后在 Oversea 只启动 Docker-managed
`hysteria2-access-stack`，注入 `HY2_*` env 和 tunnel-state，执行
`@qpjoy/tunnel-cli register --role oversea --service hysteria2` 完成控制面注册。
mihomo、DNS authority、账号/订阅存储仍由 Internal 托管；H 端通过 Domestic/WG relay
访问 Internal DNS 和 mihomo 订阅，再直连 Oversea 的 hysteria2 服务。Oversea 的 access-stack
源包保存在 `electron-dock/mx-launcher/site-slots/oversea/hysteria2-access-stack`，
materializer 只从 mx-launcher 内部取材，不读取仓库根的 `docker/` 目录。

如果是一台空 Ubuntu，推荐先在 Admin 的 `SSH Profiles` 中输入 site、host、user、一次性
password，然后点击 `Bootstrap Key`。Internal 会在默认 key root 生成并托管 SSH key、
known_hosts 和 profile；password 只用于把公钥写入远端 `authorized_keys`，不会保存到
Config Center。K8s Shadow 默认关闭真实密码注入，做真机 bootstrap 前显式打开：

```bash
bash scripts/manage.sh ops k8s-shadow ssh-bootstrap enable
```

完成 key 注入后，回到 Admin 执行 `Check Readiness`，再走 `Create Plan -> Preflight ->
Confirm Apply -> Runner -> Worker Job -> Worker Run -> Evidence`。如果 key 失效或重装机器，
重新输入 username/password 再点一次 `Bootstrap Key` 即可复写远端公钥。bootstrap 完成后
建议关闭门禁：

```bash
bash scripts/manage.sh ops k8s-shadow ssh-bootstrap disable
```

Domestic 的 artifact set 和 Oversea 不同，只包含 `mx-domestic-wg.conf`、
H2I/API proxy、snapshot cache 和 observability forwarder 等薄模块。`@qpjoy/tunnel-cli`
首选在目标机上通过 `npm i -g @qpjoy/tunnel-cli` 安装；Internal 只在 Domestic 无出站时推送
`mx-domestic-qp-tunnel-cli-fallback.tar.gz` 作为离线兜底。目标机不需要 `git clone` /
`git pull`，也不需要保留完整 monorepo。

每次 `@qpjoy/tunnel-cli` 重新发包后，Internal 有 npm 出站时先刷新 mx-launcher 内部
fallback 源包，再重新 materialize Domestic artifact：

```bash
bash scripts/manage.sh ops site-slot refresh-tunnel-cli latest
SITE_SLOT_RELEASE_REVISION=shadow-001 \
  bash scripts/manage.sh ops site-slot materialize domestic
```

如果 Internal 也没有 npm 出站，就使用当前
`electron-dock/mx-launcher/site-slots/domestic/qp-tunnel-cli` 中已缓存的 fallback 版本。没有
Oversea 订阅时，Domestic plan 会停在 `resolve-domestic-bootstrap-subscription`：Internal
只先准备 fallback artifact，不让 Domestic 自己 npm 拉包，也不执行 `server-on`。

再规划 Domestic。如果 Domestic 不能直接访问外网，把 Oversea host 一起传入，plan 会进入
`oversea-assisted` 模式，并提示使用 `@qpjoy/tunnel-cli server-on` / `egress-on`
完成受控外网引导。mihomo 订阅仍由 Internal 托管，Domestic 只保留 WG relay、proxy、
snapshot cache 和 observability forwarder 等薄组件。公网 Domestic 不要长期 `tun-on`；
常驻服务应保留原公网回程，国内目标 `cn-direct`，外网目标经 H 端订阅到的 Oversea：

```bash
SITE_SLOT_RELEASE_REVISION=shadow-001 \
  bash scripts/manage.sh ops site-slot materialize domestic

MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
  bash scripts/manage.sh ops site-slot domestic-plan domestic.example.com oversea.example.com
```

拿到 `planId` 之后，先生成 preflight 清单：

```bash
MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
  bash scripts/manage.sh ops site-slot preflight slotplan_xxx
```

preflight 输出的是远端检查命令，例如 Docker、WireGuard、转发、防火墙、Internal
连通性。它是“检查清单”，不会执行 SSH。

再生成 apply 清单。默认不确认时会返回 `requires-confirmation`，用于后台审批或人工复核：

```bash
MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
  bash scripts/manage.sh ops site-slot apply slotplan_xxx
```

确认 preflight 证据后，再显式打开确认门禁：

```bash
SITE_SLOT_CONFIRM_APPLY=1 MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
  bash scripts/manage.sh ops site-slot apply slotplan_xxx
```

查看某个 plan 下已经创建过的 execution：

```bash
MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
  bash scripts/manage.sh ops site-slot executions slotplan_xxx
```

拿到 `runId` 之后，可以启动 Runner V1.1 的 simulate session。它会把每个 step 标记为
`simulated`，用于后台预览、审计和 E2E gate，不会 SSH：

```bash
MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
  bash scripts/manage.sh ops site-slot runner-start slotexec_xxx
```

`remote-ssh` 模式默认会被门禁挡住。真实打开时需要服务端配置
`SITE_SLOT_RUNNER_REMOTE_EXECUTION_ENABLED=1`，脚本侧还要显式确认：

```bash
SITE_SLOT_CONFIRM_REMOTE_EXECUTION=1 MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
  bash scripts/manage.sh ops site-slot runner-start slotexec_xxx remote-ssh
```

查看某个 execution 下的 runner session：

```bash
MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
  bash scripts/manage.sh ops site-slot runner-sessions slotexec_xxx
```

拿到 `sessionId` 之后，可以生成 Worker Contract V1 job。这个 job 是给未来
runner worker / site-agent 消费的任务包，包含审批、变更窗口、重试、回滚、step 超时和输出
脱敏策略：

```bash
MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
  bash scripts/manage.sh ops site-slot worker-job slotrunner_xxx
```

Worker Adapter V1 可以直接消费 job 并回写完整 step report。默认 `simulate` 只生成证据，
不会执行命令：

```bash
MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
  bash scripts/manage.sh ops site-slot worker-run slotjob_xxx
```

完成 materialize 后，可以先跑 `artifact-push-dry-run`。这个模式只读取 Internal 本地
`./artifacts/site-slots/.../manifest.json` 和对应 tar/conf 文件，校验 manifest sha256、
artifact sha256、module targetPath，并把每一步的 target、requiresRoot、commandKind、
rsync/scp/ssh 运输意图写入 worker report；它不打开 SSH、不执行 rsync/scp，也不修改
Domestic / Oversea：

```bash
SITE_SLOT_RELEASE_REVISION=shadow-001 \
  bash scripts/manage.sh ops site-slot materialize all

MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
  bash scripts/manage.sh ops site-slot worker-run slotjob_xxx artifact-push-dry-run
```

dry-run 证据确认后，才可以进入真正远程推送。`artifact-push-remote-ssh` 只执行计划里的
`ssh` / `rsync` / `scp` shell 步骤；`POST ...`、Release Center materialize、人工 smoke
描述等非 shell 意图会被记录为 skipped evidence。这个模式需要 runner remote gate、worker
remote gate、approvalId 和 change window 都齐全：

```bash
SITE_SLOT_RUNNER_REMOTE_EXECUTION_ENABLED=1 \
SITE_SLOT_CONFIRM_REMOTE_EXECUTION=1 \
MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
  bash scripts/manage.sh ops site-slot runner-start slotexec_xxx remote-ssh

SITE_SLOT_APPROVAL_ID=approval-123 \
SITE_SLOT_CHANGE_WINDOW_START=2026-06-08T16:00:00+08:00 \
SITE_SLOT_CHANGE_WINDOW_END=2026-06-08T17:00:00+08:00 \
MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
  bash scripts/manage.sh ops site-slot worker-job slotrunner_xxx

SITE_SLOT_WORKER_REMOTE_SSH=1 \
SITE_SLOT_CONFIRM_REMOTE_EXECUTION=1 \
MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
  bash scripts/manage.sh ops site-slot worker-run slotjob_xxx artifact-push-remote-ssh
```

远程 worker 会在执行前注入 OpenSSH profile。推荐先把站点级 profile 写入 Internal Config
Center，worker 会按 `job.siteId` 自动读取 active profile：

```bash
SITE_SLOT_SSH_IDENTITY_FILE=/opt/mx/ssh/oversea-sg-1_ed25519 \
SITE_SLOT_SSH_KNOWN_HOSTS_FILE=/opt/mx/ssh/known_hosts.oversea-sg-1 \
SITE_SLOT_SSH_HOST_KEY_ALIAS=oversea-sg-1 \
SITE_SLOT_SSH_STRICT_HOST_KEY_CHECKING=yes \
SITE_SLOT_SSH_CONNECT_TIMEOUT_SECONDS=10 \
MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
  bash scripts/manage.sh ops site-slot ssh-profile-upsert oversea-main oversea oversea.example.com

MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
  bash scripts/manage.sh ops site-slot ssh-profiles
```

紧急覆盖可以继续用环境变量；环境变量优先级高于 `SITE_SLOT_SSH_PROFILE_FILE`，profile file
又高于 Config Center managed profile：

```bash
SITE_SLOT_SSH_PROFILE_NAME=oversea-sg-1 \
SITE_SLOT_SSH_IDENTITY_FILE=/opt/mx/ssh/oversea-sg-1_ed25519 \
SITE_SLOT_SSH_KNOWN_HOSTS_FILE=/opt/mx/ssh/known_hosts.oversea-sg-1 \
SITE_SLOT_SSH_HOST_KEY_ALIAS=oversea-sg-1 \
SITE_SLOT_SSH_STRICT_HOST_KEY_CHECKING=yes \
SITE_SLOT_SSH_CONNECT_TIMEOUT_SECONDS=10 \
SITE_SLOT_WORKER_REMOTE_SSH=1 \
SITE_SLOT_CONFIRM_REMOTE_EXECUTION=1 \
MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
  bash scripts/manage.sh ops site-slot worker-run slotjob_xxx artifact-push-remote-ssh
```

也可以用 `SITE_SLOT_SSH_PROFILE_FILE=/opt/mx/ssh/profiles/oversea-sg-1.json`，字段名同上
的驼峰版本：`name`、`identityFile`、`knownHostsFile`、`hostKeyAlias`、
`strictHostKeyChecking`、`connectTimeoutSeconds`、`batchMode`。环境变量优先级高于
profile 文件。worker report 会记录 original command、effective command、identity file、
known_hosts、HostKeyAlias 和 StrictHostKeyChecking 状态。

如果确实要在当前机器执行 job command，必须显式打开本地执行门禁。这个模式只适合受控
worker / site-agent 环境：

```bash
SITE_SLOT_WORKER_EXECUTE_LOCAL=1 MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
  bash scripts/manage.sh ops site-slot worker-run slotjob_xxx local-exec
```

也可以由人工或外部 worker 执行完成后，手动回写 report：

```bash
SITE_SLOT_WORKER_STEP_ID=preflight-1 SITE_SLOT_WORKER_STDOUT="ok" \
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
  bash scripts/manage.sh ops site-slot worker-report slotjob_xxx passed
```

report 会驱动 Worker State Machine V1：`running` 保持 job/session 打开，`passed` 推进到
passed，`failed` 会保留失败证据并生成 rollback plan，`blocked` 会进入人工复核。

failed report 之后可以创建 Rollback Contract V1 execution：

```bash
MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
  bash scripts/manage.sh ops site-slot rollback-start slotreport_xxx
```

回滚 worker 或人工执行恢复后，回填 rollback report：

```bash
SITE_SLOT_ROLLBACK_STEP_ID=rollback-collect-evidence SITE_SLOT_ROLLBACK_STDOUT="restored" \
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
  bash scripts/manage.sh ops site-slot rollback-report slotrollback_xxx passed
```

查看 Admin 管理面聚合视图：

```bash
MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
  bash scripts/manage.sh ops admin dashboard
```

查看当前 principal 的 Admin 动作权限和门禁：

```bash
MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
  bash scripts/manage.sh ops admin actions
```

查看某个 Site Slot 的完整流水线：

```bash
MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
  bash scripts/manage.sh ops admin site-slot-pipelines slotplan_xxx
```

打开 Launcher Desktop 的管理面预览：

```bash
bash scripts/manage.sh ops local-shadow up
pnpm --dir desktop dev
```

Desktop 默认读取 `http://127.0.0.1:18090`。进入 `Admin` 标签后可以看到 Three.js
H/D/I/O 拓扑、平台指标、Site Slot pipeline 列表、Action Gates 和 worker/rollback
时间线。点击允许的 Action Gate 会打开确认区；需要确认字段的动作必须先勾选对应 gate，
然后通过 `/internal/v1/admin/actions/execute` 触发已有 Internal 执行契约。ready worker job
会出现 `Run Simulated Worker`，用于自动生成完整 step evidence。`remote-ssh`、真实 K8s
写入和回滚仍受服务端开关、RBAC、确认字段和 worker report 约束。

可选环境变量：

- `SLOT_SSH_USER=root`
- `SLOT_SSH_PORT=22`
- `SLOT_ROOT_ACCESS=1`
- `SLOT_HAS_DOCKER=1`
- `DOMESTIC_HAS_OUTBOUND=0`
- `OVERSEA_SITE_ID=oversea-sg-1`
- `SITE_SLOT_CONFIRM_APPLY=1`
- `SITE_SLOT_CONFIRM_REMOTE_EXECUTION=1`
- `SITE_SLOT_WORKER_ID=worker-domestic-1`
- `SITE_SLOT_WORKER_KIND=internal-runner`
- `SITE_SLOT_WORKER_EXECUTE_LOCAL=1`
- `SITE_SLOT_WORKER_CWD=/opt/mx-worker`
- `SITE_SLOT_APPROVAL_ID=approval-xxx`
- `SITE_SLOT_RETRY_LIMIT=2`
- `SITE_SLOT_ROLLBACK_STRATEGY=restore-previous-compose`

## 6. 查看 K8s 状态、日志和 smoke

查看资源：

```bash
bash scripts/manage.sh ops k8s-shadow status
```

查看 API 日志：

```bash
bash scripts/manage.sh ops k8s-shadow logs
```

跑 smoke：

```bash
bash scripts/manage.sh ops k8s-shadow smoke
```

这个命令会临时执行 `kubectl port-forward`，把本机 `127.0.0.1:18090` 转发到 K8s 里的
`mx-launcher-internal` Service，然后跑同一套 HTTP smoke。

查看数据库迁移和平台记录：

```bash
bash scripts/manage.sh ops k8s-shadow db-summary
```

这个命令会显示：

- `mx_schema_migrations` 中 migration 记录数量。
- `mx_platform_records` 中不同平台对象的记录数量，例如 `test-run`、`audit-event`、
  `launcher-network-snapshot`。

## 6. 停止 K8s shadow

```bash
bash scripts/manage.sh ops k8s-shadow down
```

它会删除：

- Internal API Deployment + Service。
- Migration Job。
- PostgreSQL StatefulSet + Service。
- ConfigMap。
- 由脚本生成的 Secret。

它会保留：

- Namespace。
- PostgreSQL PVC。

保留 PVC 是为了安全。删除数据盘应该做成单独 purge 动作，并要求二次确认。

## 7. 常见问题

### Docker Compose smoke 失败

先看：

```bash
bash scripts/manage.sh ops local-shadow logs
bash scripts/manage.sh ops local-shadow status
```

常见原因：

- Docker Desktop 没启动。
- `18090` 端口被别的进程占用。
- 镜像还没 build 完。

### K8s apply 失败

先看：

```bash
bash scripts/manage.sh ops k8s-shadow status
bash scripts/manage.sh ops k8s-shadow logs
bash scripts/manage.sh ops k8s-shadow db-summary
```

常见原因：

- Docker Desktop Kubernetes 没启用。
- 集群拉不到 `qpjoy/mx-launcher-server:shadow` 镜像。
- PostgreSQL PVC 创建失败。
- Migration Job 没完成。

### 已验证的本机 K8s 路径

当前本机 Docker Desktop K8s 已验证：

```bash
bash scripts/manage.sh ops k8s-shadow apply
bash scripts/manage.sh ops k8s-shadow status
bash scripts/manage.sh ops k8s-shadow smoke
bash scripts/manage.sh ops k8s-shadow db-summary
bash scripts/manage.sh ops k8s-shadow down
```

验证结果：

- Postgres StatefulSet `1/1 Running`。
- Migration Job `Complete 1/1`。
- Internal API Deployment `1/1 Available`。
- HTTP smoke 通过 `healthz`、AppCenter apps、platform kernel smoke。
- `mx_schema_migrations` 有 1 条记录。
- `mx_platform_records` 有 smoke 写入的平台对象。

### 本地镜像和 K8s 镜像

Docker Desktop 本地 K8s 通常能使用本机镜像。远程 Internal 集群不能直接使用本机镜像，
必须先 push 到 registry，再把 manifest 里的 image 改成远程 registry 地址。
