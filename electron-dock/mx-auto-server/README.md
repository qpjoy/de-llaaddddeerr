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
- `MX_AUTO_LAUNCHER_URL` 是服务端调用 Launcher OAuth/introspection 的基地址，
  不是本服务自身地址。Kubernetes deploy 会自动发现同集群标准 Service
  `mx-internal-shadow/mx-launcher-internal`；显式配置只用于覆盖自定义或集群外地址。
  未配置且未发现 Launcher 时服务仍照常启动、admin token 与任务/Runner API 照常
  可用，只关闭 Launcher 账号密码登录和 Launcher bearer token 校验。
- `MX_AUTO_PUBLIC_URL` 只用于通知/安装命令中的外部链接，并辅助选择 session cookie
  属性，不参与监听或健康检查。它可以留空；标准 deploy 会尽力推导 NodePort 地址，
  直接启动则从当前请求 Host 生成链接。留空时 wrapper 默认兼容直接 HTTP 登录；若实际
  只提供 HTTPS，可显式设置 HTTPS public URL 或 `MX_AUTO_INSECURE_COOKIES=false`。
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

所有模式需要 `kubectl` 与 `openssl`。通常不配置 `MX_AUTO_IMAGE`：deploy 会用 Docker
构建以完整 image ID 命名的内容寻址镜像，并按当前集群自动分发：desktop 直接使用，
kind 自动执行 `kind load docker-image`，当前主机就是唯一 K8s 节点的
kubeadm/containerd 则自动导入 `k8s.io` image store；containerd 会去重已有内容层。
在确认当前主机就是该 kubeadm/containerd 节点后，镜像构建会自动使用 Docker host
network，避开隧道环境中 bridge MTU 导致的 npm 包下载卡死；该设置只作用于 build
阶段，不改变 Pod 网络、Service 或运行时出站。desktop、kind 和显式远程镜像不使用
这一自动切换。

containerd 导入前会优先用节点 InternalIP 核对本机身份，无法枚举 IP 时才回退
hostname，避免 kubeconfig 指向远端时误把镜像导入本机。只有 kubectl 指向另一台
机器，或目标使用 CRI-O 等当前无法本地导入的 runtime，才需要显式提供集群可拉取的不可变
`registry/repository@sha256:<digest>`。本地自动构建需要 Docker；kubeadm/containerd
导入还需要 `ctr` 以及 root 或免密 sudo，kind 另外需要 `kind` CLI。

```bash
bash scripts/manage.sh deploy
```

标准部署不需要创建 `.env`：服务镜像、Launcher 地址、公开 NodePort 地址、管理员
token、PostgreSQL 密码和凭据加密 key 都会自动准备。生成的 secret 会保存在
`mx-auto/mx-auto-secrets`，后续 deploy 复用而不会静默轮换。只有集群外 Launcher、
远程镜像仓库、私有 Git token 或其他高级覆盖才需要 `.env`；示例见 `.env.example`。

需要调用管理员 API 时再显式读取 token，不会在 deploy 日志中泄露：

```bash
export MX_AUTO_ADMIN_TOKEN="$(bash scripts/manage.sh admin-token)"
```

deploy 会查询标准 Service `mx-internal-shadow/mx-launcher-internal` 的 `http` 端口，
发现后自动写入实际的集群 DNS 地址，不需要在 `.env` 重复配置。只有 Launcher 位于
其他集群、namespace 或使用非标准 Service 时，才显式覆盖：

```dotenv
MX_AUTO_LAUNCHER_URL=http://mx-launcher-internal.mx-internal-shadow.svc.cluster.local:18090
```

部署后 namespace、Service 和 Pod 存在，才能执行
`kubectl -n mx-auto port-forward service/mx-auto-server 8790:80`。

kind 默认不把 NodePort 映射到宿主机；除非创建集群时已经配置 `extraPortMappings`，
请另开终端执行 `kubectl -n mx-auto port-forward service/mx-auto-server 8790:80`，
再访问 `http://127.0.0.1:8790`。也可以显式设置实际可访问的
`MX_AUTO_PUBLIC_URL`。

`deploy` 的固定顺序是：验证单节点并自动构建/分发镜像 → 创建 namespace → 复用/生成 Secret
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
bash scripts/manage.sh admin-token
bash scripts/manage.sh status
bash scripts/manage.sh logs [server|migrate|postgres]
bash scripts/manage.sh down
```

`down` 只把服务缩到零；PostgreSQL、历史记录、Secret 和 PVC 会保留。真正删除
数据必须由运维人员显式处理。

### 在 Admin 中接入 Compass

不需要、也不应登录 Internal 节点执行登记脚本。打开 MX AutoTest Web，使用账号
`admin`、密码为部署生成的 admin token 登录，然后进入「应用与用例」，点击
「接入 / 对齐 Compass」。这个动作只登记或对齐配置，不会触发执行。

界面默认登记 `public` 分支、`workingDir=po-frontend`、
`cypress/included:15.19.0` 的 Cypress functional/demo
套件和任务。Functional 在 K8s 静默执行；demo 由本地 Runner 录制视频、结束后
上传，两者初次接入均为手动。服务端会更新同 slug 的 Suite 和同名 Task，因此按钮
可以重复点击；已有应用的 repo/branch 不会被静默覆盖，结果会在界面提示。

Electron 不使用虚构 URL。在同一个弹窗中填写测试团队维护的真实 Electron QA Git
仓库、分支、仓库内测试包目录和执行系统后，平台才登记 Playwright Electron Suite、
用例目录和手动 Task。独立 QA 仓库的目录填 `.`；monorepo 必须填写相对目录。
浏览器不能提交任意 command 或 Runner image；审核模板固定使用 `pnpm test`。同一个
`compass-electron-smoke` Suite 会创建 `profile=mock` 的启动冒烟
与 `profile=real` 的正式登录两个 manual Task，由测试包按 Profile 选择 lane，不能在两次 Run
之间临时修改 Suite command。平台会先同步 Electron Catalog，再将两个 Task 的 `caseFilter`
分别固定为两个启动 Case 和一个登录 Case，避免另一条 lane 被错误计入 `notRun`。

`scripts/onboard-compass.mjs` 仅保留给自动化迁移和兼容旧流程，不是日常部署或首次接入
步骤；Web Admin 与它复用同一份受控模板。

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
但不能在真实执行机上发起任务。这是独立于 Launcher 全局身份的本地授权边界。该用户
必须先成功登录一次，平台才会取得 Launcher `userId` 并创建成员记录；不需要手工填写或
复制 `principalId`。管理员随后用 `admin` + admin token 登录，在「成员」页面直接把权限
下拉框改为「测试工程师」即可。权限变化会审计，用户下一次请求立即生效。不要把 service
admin token 配进桌面端或发给普通测试人员。

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
