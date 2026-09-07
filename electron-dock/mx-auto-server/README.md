# mx-auto-server

`mx-auto-server` 是 MX Autotest 的独立 V0 服务。它部署在自己的 `mx-auto`
namespace，使用自己的 PostgreSQL、Secret、ServiceAccount、PVC 和服务地址。
它不导入、不修改也不部署 MX-H2I；唯一的产品级集成是通过 Launcher 的公开
身份接口校验登录 token。

V0 暂时通过动态 import 复用相邻的 `mx-test-framework` 已验证内核。旧目录是
保留的事实源，不会被部署脚本改写。以后内核独立成包时，只需要替换
`server/legacy.mjs` 这一层，`MX_AUTO_*` 配置和部署契约可以保持不变。

## 边界

- 对外配置只使用 `MX_AUTO_*`；wrapper 在进程内映射为旧内核读取的 `MXT_*`。
- Launcher audience 默认是 `mx-sdk`，用于复用 standalone launcher/桌面登录
  token；Launcher 只负责认证，Autotest 权限仍保存在自己的数据库。
- opaque token 只以 SHA-256 digest 作为内存缓存/并发表的 key；明确失效结论默认
  负缓存 3 秒，同 token 的并发校验合并为一次。unique token 的 introspection
  每来源默认 6 次/10 秒、2 并发，全局 emergency ceiling 为 30 次/10 秒、8 并发；
  单一来源耗尽后不会饿死其他来源。公开密码登录另用每来源/用户名 digest
  3 次/10 秒、1 并发，全局 10 次/10 秒、4 并发的独立预算，随机错误账号不会绕过
  保护放大到 Launcher OAuth；合法登录随后的 introspection 不会在同一预算里被重复
  计费。上游网络错误与 5xx 不会伪装或缓存成 401。
- 默认 NodePort 为 `30880`，ClusterIP 为 `http://mx-auto-server`。单节点 NodePort
  使用 `externalTrafficPolicy: Local` 保留真实 socket peer；限流不信任调用者可伪造的
  `X-Forwarded-For`，也不硬编码客户端 CIDR。
- K8s Runner 的源码拉取、依赖安装与执行发生在临时 Job，不经过 Launcher 或
  MX-H2I 的 Pod、Secret、数据库和 PVC。
- V0 server 的持久化 artifact mount 仍使用 `mx-test-framework-artifacts` 这个 claim
  名。本项目仅在 `mx-auto` namespace 内保留同名 PVC 兼容别名；Runner Job 不挂它，
  底层 PV 和路径也仍是独立的 `mx-auto` 资源。内核包化时应移除这个别名。

## 本地运行

要求 Node.js 22。V0 动态加载相邻目录，因此先确保旧内核依赖已经安装：

```bash
npm --prefix ../mx-test-framework install
cp .env.example .env
bash scripts/manage.sh dev
```

本地 `dev` 使用内存存储，不修改任何 Kubernetes 或 MX-H2I 资源。默认地址是
`http://127.0.0.1:8790`，默认开发密码是 `local-admin-change-me`。

## Kubernetes

内置清单使用 `hostPath`，因此 V0 deploy 会检查集群恰好只有一个节点。它适合
`docker-desktop`、`rancher-desktop` 和单节点 kind；多节点/生产集群应先把两个 PVC
换成 CSI StorageClass，而不是绕过检查。

### 单节点资源与磁盘硬边界

`08-resource-policy.yaml` 给整个 `mx-auto` namespace 设置 ResourceQuota，并用
LimitRange 拒绝无界容器。server、PostgreSQL、migration 和动态 Runner 都显式声明
CPU、memory、ephemeral-storage 的 request/limit；默认最多同时运行 1 个 K8s Runner。
server、migration 与 PostgreSQL 使用只读根文件系统，只把 `/tmp`、PostgreSQL socket
目录和各自数据卷设为有限的可写挂载。Cypress/Playwright 官方镜像仍需要可写根目录，
因此 Runner 依靠容器 CPU/memory/ephemeral limit 与两个有 `sizeLimit` 的 emptyDir 隔离，
而不是声明一个未经真实浏览器验证的 `readOnlyRootFilesystem`。

Runner **不再挂载 artifact PVC**：每次 Run 先写入自己的 2Gi 临时盘，再用 run token
通过上传 API 回传。服务端默认同时执行以下持久化硬限制：单文件 512Mi、单 Run 2Gi /
1000 文件、全部 Run 合计 20Gi / 100000 个文件或目录条目，并为 artifact 所在文件系统
至少保留 5Gi 和 10000 个 inode；达到逻辑上限或安全余量时返回 507，该 Run 会成为
blocked。不同 Run 的上传也在服务进程内串行核算，不能通过并发、零字节文件或深层空
目录越过总量；上传先进入同文件系统 staging，完整后原子落位，拒绝时不留下路径树。

清单中 artifact PV 的 `capacity: 50Gi` **不是 hostPath 文件系统配额**，不能拿它作为
“磁盘最多写 50Gi”的证据。20Gi/5Gi 与条目/inode 双限制才是 V0 应用层 enforcement；
生产仍应换成支持容量隔离的 CSI volume 或独立分区并设置磁盘告警。调整 ConfigMap 中任何 Runner 或
artifact 数值时，必须同步核对 ResourceQuota、LimitRange 与宿主磁盘容量，不能只放大
单项上限。

对应的公开配置键是 `MX_AUTO_MAX_CONCURRENT_SERVER_RUNS`、
`MX_AUTO_RUNNER_{CPU,MEMORY,EPHEMERAL_STORAGE}_{REQUEST,LIMIT}`、
`MX_AUTO_{WORKSPACE,RUNNER_ARTIFACT}_SIZE_LIMIT`，以及
`MX_AUTO_ARTIFACT_MAX_FILE_BYTES`、`MX_AUTO_ARTIFACT_MAX_RUN_BYTES`、
`MX_AUTO_ARTIFACT_MAX_FILES_PER_RUN`、`MX_AUTO_ARTIFACT_MAX_TOTAL_BYTES`、
`MX_AUTO_ARTIFACT_MAX_TOTAL_ENTRIES`、`MX_AUTO_ARTIFACT_MIN_FREE_BYTES` 和
`MX_AUTO_ARTIFACT_MIN_FREE_INODES`。Kubernetes 的事实源是
`deploy/k8s/internal/08-resource-policy.yaml`；其摘要进入 server Pod template，修改后
执行 deploy 会触发新 Pod 读取配置。

所有模式需要 `kubectl` 与 `openssl`；本地镜像模式还需要 Docker，kind 模式另外
需要 `kind` CLI。远程 digest 模式不在本机构建镜像。

本地 desktop context 会构建按 Docker image ID 命名的不可变标签；kind 还会自动
执行 `kind load docker-image`。其他 context 不会猜测镜像如何分发，必须提供集群
可拉取的 digest：

```bash
cp .env.example .env
# 至少修改 MX_AUTO_ADMIN_TOKEN；接入 Launcher 时再设置 MX_AUTO_LAUNCHER_URL
# 远程集群还需：MX_AUTO_IMAGE=registry.example/mx-auto-server@sha256:<digest>
bash scripts/manage.sh deploy
```

kind 默认不把 NodePort 映射到宿主机；除非创建集群时已经配置 `extraPortMappings`，
请另开终端执行 `kubectl -n mx-auto port-forward service/mx-auto-server 8790:80`，
再访问 `http://127.0.0.1:8790`。也可以显式设置实际可访问的
`MX_AUTO_PUBLIC_URL`。

`deploy` 的固定顺序是：验证单节点与镜像分发 → 创建 namespace → 复用/生成 Secret
→ 启动独立 PostgreSQL → 用同一不可变镜像执行迁移 Job → 启动服务 → readiness 与
鉴权验证。数据库 PVC 一旦存在，集群 Secret 中的 PostgreSQL 密码和凭据加密 key
就是事实源；普通 deploy 遇到 `.env` 中不同的值会拒绝继续，不会静默轮换或使旧
凭据失效。其他 Secret 设置的摘要写入 Pod template，变更会触发 rollout。

身份校验保护可在 `.env` 通过
`MX_AUTO_LAUNCHER_NEGATIVE_CACHE_TTL_MS`、
`MX_AUTO_LAUNCHER_INTROSPECTION_WINDOW_MS`、
`MX_AUTO_LAUNCHER_INTROSPECTION_MAX_STARTS` 和
`MX_AUTO_LAUNCHER_INTROSPECTION_MAX_IN_FLIGHT` 调整全局 emergency ceiling，并用
`MX_AUTO_LAUNCHER_INTROSPECTION_MAX_STARTS_PER_SOURCE`、
`MX_AUTO_LAUNCHER_INTROSPECTION_MAX_IN_FLIGHT_PER_SOURCE` 调整每来源额度；密码登录使用对应的
`MX_AUTO_LAUNCHER_PASSWORD_LOGIN_WINDOW_MS`、
`MX_AUTO_LAUNCHER_PASSWORD_LOGIN_MAX_STARTS` 与
`MX_AUTO_LAUNCHER_PASSWORD_LOGIN_MAX_IN_FLIGHT`，以及两个 `_PER_SOURCE` 变量。默认值适合单实例 V0，正常的
缓存命中与同 token 并发不会消耗新的启动额度。NodePort 保持可供 standalone 桌面端
访问，因此没有硬编码来源 CIDR；公网或跨网暴露时仍应在集群入口增加受控网络边界。

命令：

```text
bash scripts/manage.sh dev
bash scripts/manage.sh test
bash scripts/manage.sh migrate
bash scripts/manage.sh deploy
bash scripts/manage.sh verify
bash scripts/manage.sh status
bash scripts/manage.sh logs [server|migrate|postgres]
bash scripts/manage.sh down
```

`down` 只把服务缩到零；PostgreSQL、历史记录、Secret 和 PVC 会保留。真正删除
数据必须由运维人员显式处理。

### 幂等接入 Compass

下面的命令只登记配置，不会触发执行：

```bash
MX_AUTO_BASE_URL=http://127.0.0.1:30880 \
MX_AUTO_TOKEN="$MX_AUTO_ADMIN_TOKEN" \
node scripts/onboard-compass.mjs
```

它登记显式 `public` 分支、`workingDir=po-frontend`、
`cypress/included:15.19.0` 的 Cypress functional/demo
套件和任务。Functional 在 K8s 静默执行；demo 由本地 Runner 录制视频、结束后
上传，且始终为手动。Functional 默认也是手动，只有显式设置
`MX_AUTO_COMPASS_FUNCTIONAL_CRON` 才会变为 cron。脚本会更新同 slug 的 Suite
和同名 Task，因此可以重复执行。

Electron 不使用虚构 URL。只有设置真实的 `MX_AUTO_COMPASS_QA_REPO`，或将
`MX_AUTO_COMPASS_TEST_PACK` 指向一个 **Git checkout 根目录**，脚本才登记
Playwright Electron Suite 和手动 Task；普通子目录会被拒绝。本地路径不会被平台
上传到执行机，只有路径确实由目标机器共享时才可用，因此优先使用 Git remote。
Electron test-pack 默认命令是 `pnpm test`，可用
`MX_AUTO_COMPASS_ELECTRON_COMMAND_JSON='["pnpm","test:e2e"]'` 显式覆盖。仓库内置测试包应保持
`["pnpm","test"]`：同一个 `compass-electron-smoke` Suite 会创建 `profile=mock` 的启动冒烟
与 `profile=real` 的正式登录两个 manual Task，由测试包按 Profile 选择 lane，不能在两次 Run
之间临时修改 Suite command。脚本会先同步 Electron Catalog，再将两个 Task 的 `caseFilter`
分别固定为两个启动 Case 和一个登录 Case，避免另一条 lane 被错误计入 `notRun`。

V0 内核只能在 Suite 级声明密钥，因此该 Suite 会声明
`COMPASS_E2E_ACCOUNT` 与 `COMPASS_E2E_PASSWORD`：平台会向 mock 与 real 两条 Task
都签发这两个值。测试包的 bootstrap 控制器会在启动 Playwright 前主动剥离它们，
目标 Electron 子进程也只接收严格白名单环境变量；只有正式登录 lane 的控制器读取凭据。
后续正式内核应把 `secretRefs` 下沉到 Task/lane，消除 mock Task 的多余签发。

管理员需在触发正式登录前写入两个 **专用、低权限、非生产** 测试凭据；值为只写，读取
接口只会返回名称和更新时间：

```bash
curl -fsS -X PUT "$MX_AUTO_BASE_URL/api/v1/apps/luopan/secrets/COMPASS_E2E_ACCOUNT" \
  -H "authorization: Bearer $MX_AUTO_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"value":"<dedicated-test-account>","description":"restricted Compass E2E account"}'
curl -fsS -X PUT "$MX_AUTO_BASE_URL/api/v1/apps/luopan/secrets/COMPASS_E2E_PASSWORD" \
  -H "authorization: Bearer $MX_AUTO_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"value":"<dedicated-test-password>","description":"restricted Compass E2E password"}'
```

Electron Catalog 使用 schemaVersion 2。根级能力覆盖声明与逐 Case 的 `coverageMode`、
`automationState`、`prerequisites` 会由 V0 内核持久化，并可从
`GET /api/v1/apps/luopan/catalogs` 与 cases API 查询；不能把 unsupported 或
manual-witness 混进一个笼统的“覆盖率”百分比。

### 首次登录与执行权限

Launcher 账号第一次登录会以 `viewer` 加入 MX AutoTest：可以查看任务、Runner 和报告，
但不能在真实执行机上发起任务。这是独立于 Launcher 全局身份的本地授权边界。管理员先
查看成员并明确提升到 `operator`，桌面端的“运行”按钮才会启用：

```bash
curl -fsS "$MX_AUTO_BASE_URL/api/v1/members" \
  -H "authorization: Bearer $MX_AUTO_ADMIN_TOKEN"
curl -fsS -X PATCH "$MX_AUTO_BASE_URL/api/v1/members/<principalId>" \
  -H "authorization: Bearer $MX_AUTO_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"role":"operator"}'
```

请从第一条命令的结果复制准确的 `principalId`；不要把 service admin token 配进桌面端。

### 执行机与 Electron 安装包前置

demo 与 Electron 都由本地执行机认领。执行机需要 Node.js 22、Git、pnpm，以及
test-pack 自己声明的 Cypress/Playwright 依赖。先用 Launcher 账号登录，再显式登记
两种能力；Windows 执行机才能认领默认的 Electron suite：

```bash
node ../mx-test-framework/bin/mxt-runner.mjs login \
  --server http://127.0.0.1:30880
node ../mx-test-framework/bin/mxt-runner.mjs register \
  --name "Compass Windows Runner" \
  --kind local \
  --engines cypress,playwright-electron \
  --surfaces web,electron
node ../mx-test-framework/bin/mxt-runner.mjs watch
```

Electron test-pack 若启动已打包应用，执行前必须登记执行机可下载的安装包。平台把
当前 package 的 URL、版本和 sha256 固定到 run，并由执行机下载校验后通过
`MXT_APP_PATH` 交给 Playwright：

```bash
curl -fsS -X POST "$MX_AUTO_BASE_URL/api/v1/apps/luopan/packages" \
  -H "authorization: Bearer $MX_AUTO_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "url":"https://artifacts.example/compass/CompassSetup.exe",
    "sha256":"<64-hex-sha256>",
    "filename":"CompassSetup.exe",
    "version":"<version>"
  }'
```

URL 必须能从执行机访问；不要把构建机本地路径登记为 package URL。完成 package
登记后再手动触发 Electron task，才能保证报告指向可复现的安装包。V0 的外置 QA
仓库暂时不要在 package payload 填 `gitSha`：旧内核会错误地把被测应用分支用作 QA
仓库 checkout ref；这个兼容限制应在正式内核中拆成 app source 与 test source 两个
独立 ref 后移除。

## V0 限制

当前 API、数据表、调度器和旧 Web 管理界面仍来自 `mx-test-framework`，因此页面
文案中可能出现旧产品名。新功能应优先在 `mx-autotest`/`mx-auto-server` 的正式
契约中设计，而不是继续扩充旧单体。完整视频、对象存储、工具缓存和分布式调度
也不在这个过渡目录中实现。

静态验证不会连接生产服务：

```bash
bash scripts/manage.sh test
kubectl kustomize deploy/k8s/internal
```
