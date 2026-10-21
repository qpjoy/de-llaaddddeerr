# DataPort 第一批实现与部署说明

> 历史实施记录。2026-10-12 的域名迁移与可配置订阅规则以 [当前发布清单](../dataport.setup.md) 为准。

2026-10-11。已实现界面、账号准入、客户权限读取，以及复用 Hub 的商城、订阅、订单操作、IP 网页查询和历史记录。用户截图显示线上 DataPort 已展示已开通与待付款订单；这不是本轮独立验证的支付/供应商证据。本次新增订阅提示、到期状态与客户消息中心已做本地验证，尚未发布生产；完整对外销售验收仍按清单执行。

## 已实现

| 范围          | 实际行为                                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DataPort 设计 | 保留原 CSS、基础交互组件、首页 IP 搜索布局和双栏登录弹窗；gallery 与业务入口独立。来源见 `ui-design/source-manifest.json`                                       |
| 统一账号      | 原生登录/邀请注册、切换账号、资料修改、改密、撤销会话使用 mx-common。没有迁入原型的自有账号库                                                               |
| DataPort 准入   | 所有账号要求明确 `allowedAppIds` 包含 `mx-harbor`，显式 deny 优先。新账号通过专用邀请创建；旧账号在可信登录 interaction 中认证后兑换                            |
| 注册设置      | Internal 注册与邀请增加 DataPort 的关闭/邀请码模式；旧管理客户端省略新设置时保留它；Hub 原 `hubMode` 和全局关闭优先级保留                                         |
| 邀请隔离      | 新 `admissionAppId: mx-harbor` 区别于旧 `appGrant`。专用邀请仅开通 DataPort，不能用于其他应用。旧通用邀请不能开通 DataPort；通用“全部应用”排除 DataPort，其余应用照常 |
| 历史兼容      | 不改旧账号密码、SDK、网络租约；只有新 Hub/DataPort 账号创建时使用已有 H2I/Luopan 默认拒绝策略                                                                     |
| 客户权限      | Hub Portal 双重校验 BFF 凭据和 Auth UserInfo。以可信 canonical issuer/subject 关联原 Hub member，返回实际 membership，始终为客户视角                            |
| 客户功能      | 空间概览、空间权限、Key 列表、权限过滤的 OpenAPI、商城、订阅、订单创建/付款/刷新、网页查询与历史；供应商、排障、商品管理仍不开放                              |
| 独立发布      | DataPort 独立库、迁移 Job、固定节点镜像导入、部署锁、重启/状态/日志/离线计划；保留已有 Secret                                                                     |

邀请不授予 Hub 租户角色或商品权益，也不授予 Pay 管理权限。关闭注册不会封禁已经开通的账号。撤销 DataPort 访问不修改其 Hub/H2I 权限。

DataPort 注册当前仅支持关闭或邀请码两种模式；现有其他应用的开放注册保留。飞书注册和直接飞书登录动作在 DataPort 服务端拒绝，既有统一账号的历史绑定不被删除。忘记密码仍由管理员处理；“验证旧密码后改密”不是自助密码找回。

## 2026-10-11 登录界面修复发布

首页和独立 gallery 均恢复原型的 `public-query-main` 居中容器。登录/邀请码注册字段不再依赖已有 flow 才渲染；连接时暂时禁用，失败时在原弹窗重试。只有读到真实关闭策略才显示“暂未开放邀请注册”，网络/配置错误不能伪装为关闭注册。

DataPort 显式启用 mx-common `navigation.applicationForm`：同源 `POST /auth/sso/start` 先经服务端凭据校验 Auth `capabilities`（appId/origin/audience/nativeForm），再创建 PKCE/state/nonce 和 host-only 登录 cookie。浏览器短暂经过 Auth 建立 issuer cookie，自动返回数港填写账号密码/邀请码；密码仍交给原 Auth 校验，没有新增密码库。返回的 flow 失效时停止自动往返，用户点击重试才重建；表单 409/410 也可重试。DataPort 登录弹窗不展示 Auth 托管账号列表；可直接输入另一 MX 账号。账号页的“切换账号”重新发起原生登录，短暂 SSO 往返后回到 DataPort 表单。登录页的邀请码明确标为选填，已开通或管理员授权的账号无需填写；新账号注册仍必填。已有消费者未开启该选项的流程保持不变。

Auth 的 DataPort 错误页仅给出数港返回入口，不列其他应用；无法验证来源的错误页也不列出内部应用。返回目标只来自已登记应用或签名恢复上下文，不信任任意 return 参数。

后续界面调整（去掉托管账号列表入口、账号页改走原生登录、标明登录邀请码选填）只需重发 DataPort，不要求重发 Launcher/Hub。`npm run build` 通过；本地浏览器核对登录邀请码无 required、注册邀请码仍 required，账号页切换请求为 `POST /auth/sso/start?view=login` 并返回 DataPort 表单。该 UI 验证使用隔离接口替身，没有修改生产注册设置。

本次只读线上检查：匿名 DataPort `/auth/sso/form` 为 410（尚无 flow）；DataPort 发起 `mx-harbor-web` 原生授权后，Auth 授权入口直接返回 400、尚未建立 interaction。需要核对 Auth 已发布的客户端登记，不能把这个 400 当成密码错误或邀请码关闭。以下在 **Internal 主机，项目仓库根目录**执行，保留原环境参数：

```bash
bash electron-dock/mx-dataport/scripts/manage.sh ops internal-production enroll
MX_LAUNCHER_BUILD_PROXY=http://127.0.0.1:7789 MX_INSIGHT_HUB_DEPLOY=0 bash electron-dock/mx-launcher/scripts/manage.sh ops internal-production deploy
MX_HARBOR_BUILD_PROXY=http://127.0.0.1:7789 bash electron-dock/mx-dataport/scripts/manage.sh ops internal-production deploy
```

本次修改需要先发布 Launcher/Auth，再发布 DataPort（镜像自动带上新版 mx-common），否则 capability 预检会留在数港报接入未完成。Hub 已有 Portal 版本时无需因此重发；若尚未接入，按下节完成 Hub 首次发布。无需重新运行证书签发或 Domestic 安装。不要重建 identity profile 或轮换现有密钥来处理未加载的客户端。

本次本地回归 43 项通过、0 跳过（DataPort 26、mx-common SSO 4、Launcher 身份/邀请/应用隔离 9、Hub Portal 4），生产构建和 Launcher 类型检查通过。浏览器验收覆盖首页 1280px 中心对齐、390px 无横向溢出、登录/确认密码/邀请码字段、注册关闭及接入失败重试；UI 使用本地接口替身，完整认证协议另用临时库和真实 HTTPS 测试。

实际邀请码与共享权限操作见 [当前可执行验收](acceptance.md#当前可执行邀请码准入与共享权限)。本地真实 PostgreSQL/HTTPS 回归覆盖 PKCE、同源/CSRF、旧登录兼容、邀请码准入与撤权、共享 member/space；生产账号、真实付款和实际 H2I 联网仍由管理员受控验收。

## 注册完成后客户会话返回 404

DataPort 的认证与客户空间分两步加载：`/auth/sso/session` 验证本站 SSO，`/bff/v1/session` 再调用 Hub Admin 的 `/internal/v1/portal/session`，读取同一用户的空间和权限。前者成功、后者 404 时，先核对 Hub 运行镜像和部署模板已包含可选 Portal 挂载；DataPort 上游默认是 `http://mx-insight-hub-admin.mx-insight-hub.svc.cluster.local:18151`，不能指到 Public 18150 或 Hub 网页域名。

已成功 enroll 的环境，在 Internal 的 `electron-dock/mx-dataport` 目录先发布 Hub，再发布 DataPort：

```bash
MX_INSIGHT_BUILD_PROXY=http://127.0.0.1:7789 bash ../mx-insight-hub/scripts/manage.sh ops internal-production deploy
MX_HARBOR_BUILD_PROXY=http://127.0.0.1:7789 bash scripts/manage.sh ops internal-production deploy
```

此故障不要求重新登记 client、生成密钥或重建账号。Hub 部署会应用 Portal 环境变量、Secret 挂载和网络策略；缺失/无效配置应返回 503，缺少调用凭据返回 401，未部署路由或错误 listener 返回 404。不要通过开放管理路由或绕过网关凭据修复。更新后在原浏览器刷新或点击“重试连接”，确认 SSO active 且客户会话 200，核对 member、空间和权限。

DataPort 将固定客户会话上游的 404 转为 `503 / customer_session_unavailable` 并附本站 `requestId`；空间服务失败不再清掉页面的已验证身份，也不合成业务权限。网页区分身份未知、未登录、已登录但客户服务失败及完整就绪四种情况。原 SSO Cookie 与服务端权限检查不变。本地回归覆盖客户接口缺失、恢复、明确撤销、网关错误、非 JSON 响应；浏览器隔离验证证明重试只读取会话与空间，不触发新的注册或邀请码兑换。

## 外部应用接入配置（可在部署后完成）

正式入口为 **https://harbor.minsight-ai.com**。DataPort 可先建库、迁移和发布，随后接入 Auth、Hub；外部依赖不是迁移前置条件。

1. 用户已确认 DataPort 首次 deploy 成功。服务器同步当前代码后，在 Internal 的 `electron-dock/mx-dataport` 运行：

   ```bash
   bash scripts/manage.sh ops internal-production enroll
   ```

   命令使用已经固定的集群与本机节点，持有 DataPort 部署锁；调用 Launcher 原有加锁的 `ops identity app`，登记独立 `mx-harbor` public client，固定 origin 与 audience。读取 Hub 原 SSO profile 核对同一身份来源，把同一 profile 和独立网关凭据同步至 DataPort runtime Secret 与 Hub `mx-harbor-portal` Secret。保留数据库、clientSecret、sessionKey、已有 Secret 其他字段，不授予账号或产品权限。

   可以重复执行，局部失败可重试。支持恢复遗失的本地私密文件；已有配置不一致、正式域名不一致、Hub 未接入 SSO 或集群漂移时停止，不自动轮换凭据。Secret 使用 resourceVersion 更新，避免覆盖并发变更。宿主无需 node_modules。`secrets/identity/profile.json` 和 `secrets/gateway-token` 为 0600，不提交仓库。

2. 首次登记后，在 `electron-dock/mx-launcher` 使用原来的 `bash scripts/manage.sh ops internal-production deploy` 及原有环境参数，发布新的 Auth client 和 DataPort 准入能力。`MX_INSIGHT_HUB_DEPLOY=0` 可保留；Hub 单独发布。不要重新初始化身份档案。登记与发布均复用既有凭据；真实发布仍需检查旧 MX-H2I 登录和联网。
3. 在 `electron-dock/mx-insight-hub` 运行原发布命令：

   ```bash
   MX_INSIGHT_BUILD_PROXY=http://127.0.0.1:7789 bash scripts/manage.sh ops internal-production deploy
   ```

   Hub Admin 正式 K8s 清单已包含可选的 `mx-harbor-portal` 文件挂载与 DataPort namespace/Pod 入站规则；日后 Hub deploy 保留此接入。缺少或损坏的 DataPort 配置仅让 Portal 请求返回 503，不影响 Hub 自身启动及登录。Public listener 不开放 Portal。`hub-portal-enrollment.patch.yaml` 仅供旧清单兼容参考，当前版本无需手工 patch。Hub 使用 hostNetwork，NetworkPolicy 的实际效果取决于 CNI，认证授权始终在服务端执行。
4. DataPort 当前支持运行时发现投影配置；更新 Secret 后需要等待 Kubernetes 投影同步，不必为接入再次发布 DataPort。普通代码更新继续使用原 DataPort deploy，自动完成迁移和重启。
5. `de-mingxi` 已加入独立网关与证书入口，详见该仓库 `compass/deploy/HARBOR.md`。先将域名 DNS 指向 Domestic 公网入口并开放 TCP 80/443，然后：

   ```bash
   # Internal 的 de-mingxi：仅校验本机 DataPort 的 health/ready，再安装独立 vhost
   bash scripts/manage.sh internal-harbor-install
   # Domestic 公网机的 de-mingxi：首签或按需续期、内网就绪检查、HTTPS、仅 DataPort 续期预演
   bash scripts/manage.sh harbor-install
   ```

   原 Hub 的 `40-hub.conf` 不变。DataPort 拒绝 `/internal`、`/demos`、`/admin`；`/api/v1/` 保留 Hub Public 的 Key、权限、计量与幂等协议，Cookie 不转发，禁止代理自动重试。证书没有签发前不将 DataPort TLS 模板放入有效 conf.d，避免影响既有站点。
6. 管理员在 Internal 单独打开 DataPort 邀请，保持 Hub 原开放注册策略。所有旧账号也要获得 DataPort 邀请或显式授权；邀请不授予产品权益。验收域名、回调、登录、撤权、共享空间与文档权限后再接后续商业闭环。

DataPort 自身发布不要求先发布 Launcher/Hub。启用真实登录和客户服务前，Hub、Auth 的新能力仍须完成各自兼容发布；仅运行 DataPort deploy 不会登记新的 Auth client 或启用 Hub Portal。

### enroll 失败定位

旧提示 `kubectl 执行失败；未输出可能包含凭据的子进程内容` 无法判断线上根因。当前脚本输出 `[具体步骤/资源] + 退出码 + 已识别的错误类型`，例如读取 Hub SSO Secret 时的 `Forbidden`，或获取部署锁时的 `AlreadyExists`。不回显可能包含 Secret 的 stdout/stderr。所有 Kubernetes 请求限制为 15 秒；解锁失败单独报告，不覆盖最初错误，也不再提前显示接入成功。

在 **Internal 的 `electron-dock/mx-dataport` 目录**同步代码后，直接重试：

```bash
bash scripts/manage.sh ops internal-production enroll
```

此目录下无需再加 `electron-dock/mx-dataport/` 前缀。本次仅更新宿主脚本，无需为获取诊断重建镜像、重发应用或续签证书。

- `context/kubeconfig`：恢复上次 deploy 使用的 `KUBECONFIG`；不要修改已固定的 context/cluster UID 来绕过检查。
- `Forbidden/Unauthorized`：检查当前 Kubernetes 身份对报错 namespace/资源的权限或凭据。脚本不会扩大 RBAC。
- enroll 的部署锁 `AlreadyExists`：先检查正在运行的 deploy、迁移 Job、enroll；enroll 不自动删除锁。迁移终止未确认时，deploy 也会有意保留此锁。普通 deploy 对已完成操作留下的锁支持下述有限自动恢复。
- 同步 Secret `Conflict`：等待其他修改任务完成后重试，仍复用现有凭据。
- 同时出现原始错误和“解锁未确认”：两条都保留；先检查锁状态，不能把 Secret 同步成功当作整个 enroll 成功。

如果不确定是否还有任务在执行，先在同目录运行默认只读的检查命令：

```bash
bash scripts/manage.sh ops internal-production recover-lock
```

它核对原 cluster UID 与本机节点，显示锁的 action、创建时间、主机/PID，以及相关本机进程和迁移 Job/Pod 状态；不会输出进程完整命令行或读取 Secret。老锁没有持有进程记录，会显示 `legacy-unknown`，不能仅按存在时长判断过期。新 deploy/enroll 会在锁内写入 ownerHost/ownerPid；仍存活的 PID（包括 PID 被复用的情况）、异地主机、无法确认归属的进程、未结束的迁移都阻止恢复。

只有确认所有 DataPort deploy/migrate/enroll 已退出后，才执行：

```bash
bash scripts/manage.sh ops internal-production recover-lock --confirm-idle
bash scripts/manage.sh ops internal-production enroll
```

恢复会重新做检查，并以检查到的 UID **和 resourceVersion** 为删除前提；锁被其他任务修改或重建时拒绝删除，没有强制删除回退。确认参数不能绕过活跃进程/Job/Pod 检查。不会停止迁移、重启应用或改变身份数据。enroll 继续使用显式恢复；普通 deploy 仅自动恢复满足下面全部条件的锁。

原 deploy 在解锁前打印 `completed`，容易让解锁失败看起来像完整成功；现在仅在解锁完成后打印成功。意外终止进程、Kubernetes 连接中断等仍可能留下锁；未满足自动恢复条件时使用上述检查流程。

### deploy 自动恢复部署锁（2026-10-19）

部署锁是 `mx-harbor/mx-harbor-deploy-lock` ConfigMap，用来串行化 DataPort 的 deploy/migrate/enroll，避免并行迁移、应用发布与接入 Secret 更新。它不是数据库表锁，也不会让已经运行的 DataPort 停止服务。

新 deploy 创建锁时记录 `recoveryVersion=1`、`recoveryState=active`。只有镜像导入、迁移、rollout 和 `/ready` 全部成功后，才以当前 UID/resourceVersion 校验更新为 `releasable`，随后正常删除锁。临时目录在取得锁之前创建，避免 TMPDIR 不可写或空间不足直接留下锁。

下次 deploy 收到明确的 `AlreadyExists` 服务端响应后，自动恢复须同时满足：

- 锁属于 `action=deploy`，且存在上述版本和 `releasable` 完成标记；
- ownerHost 是当前固定节点，ownerPid 已退出；PID 复用仍视为存活并拒绝；
- 除当前部署命令自身外，没有 DataPort 操作进程或归属不明的相关进程；
- 相关迁移 Job 已终止、active 为 0，迁移 Pod 全部 Succeeded/Failed；
- 按检查到的 UID/resourceVersion 删除成功，确认旧锁消失，再获取锁一次。若竞争者已取得新锁，停止本次部署并保留新锁。

因此，**已完成部署但清理锁失败**可自动恢复；中途强杀、失败或状态未知、缺少完成标记的旧锁、enroll 锁、仍有任务的锁不会自动删除。进程退出并不证明它启动的 Docker/kubectl 子进程或已提交的 API 操作结束，因此不按锁龄、超时或单独的 PID 状态强行解锁。部署失败也不会自动重跑迁移或反复重试。

同步宿主脚本后，原统一命令保持不变，在 `electron-dock` 目录运行：

```bash
PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy mx-dataport
```

解锁功能只操作本项目的部署锁；后续正常 deploy 仍会执行 DataPort 迁移和单副本发布。没有新增 Launcher/Auth、Pay、etcd 或用户网络的重启操作。

本次回执中的旧锁创建于 `2026-10-19T05:43:48Z`，持有者和迁移任务已结束，操作者已用显式恢复释放。现有资料不能确定原进程在哪一步退出或为何未清理。主机此前确有 NVMe I/O timeout，可能通过控制面请求失败或进程中断间接导致留锁；不能据此认定它就是这把锁的成因。自动恢复锁不修复磁盘 I/O 异常。

本次本地验证：恢复策略/接入核心及 CLI 29 项、部署集成 25 项，共 54 项通过；覆盖两种明确的 kubectl AlreadyExists 格式、旧锁/活跃任务拒绝、竞争锁保护、失败不写完成标记及临时目录清理。脚本语法与 diff 检查通过。完整前端构建因本地缺少 `xlsx`、`exceljs` 依赖及其派生类型错误未通过；本次未改前端代码或安装依赖。新逻辑尚未在生产运行，未操作真实集群或业务数据。

锁恢复增量回归：恢复策略、CLI、接入核心和部署共 33 项通过；另用真实 kubectl 1.32.2 与本地隔离 HTTP 服务确认 DELETE 请求携带 UID/resourceVersion 前提。未连接生产集群或清理生产锁。

仅当报部署锁已存在时，可用以下只读命令检查锁和迁移 Job，不读取 Secret 内容：

```bash
harbor_context="$(node -p 'JSON.parse(require("node:fs").readFileSync("secrets/operations.json", "utf8")).context')"
kubectl --context "$harbor_context" --request-timeout=15s -n mx-harbor get configmap mx-harbor-deploy-lock -o 'custom-columns=NAME:.metadata.name,ACTION:.data.action,CREATED:.metadata.creationTimestamp'
kubectl --context "$harbor_context" --request-timeout=15s -n mx-harbor get jobs
```

本次回归：接入核心 6 项、CLI 错误与清理 6 项、部署 12 项，共 24 项通过。CLI 使用隔离 kubectl 替身，验证报错步骤、敏感输出隐藏、原锁 UID 保护及临时文件清理；没有据此宣称生产 enroll 已成功。

首次发现可用 `MX_HARBOR_KUBE_CONTEXT`、`MX_HARBOR_NODE` 和 `MX_HARBOR_HUB_ADMIN_ORIGIN` 指定目标；节点仍须匹配本机 hostname。也可按 `deploy/operations.example.json` 手工填写配置，其中 `node` 是 Kubernetes 节点名称。普通 Pod 中的 `127.0.0.1` 不是宿主机，不能作为 Hub 上游。已有操作配置无效、与显式环境变量冲突或原部署位于其他节点时，脚本停止，不覆盖配置或迁移目标。

首次缺少 `secrets/identity/profile.json` 或 `secrets/gateway-token` 时只提示外部接入待配置，继续建库、迁移和发布。已有但无效的本地文件仍需修复。后续补齐文件后执行同一 `deploy`，仅填充 runtime Secret 中缺失的接入字段，保留已有数据库、clientSecret/sessionKey 和网关凭据；不会自行生成未在 Auth 登记的 SSO client，也不会覆盖 Hub 正在使用的凭据。

DataPort Pod 将 runtime Secret 的 `profile.json` 与 `MX_HARBOR_GATEWAY_TOKEN` 作为可选文件投影到 `/run/harbor/profile.json`、`/run/harbor/gateway-token`，不使用 subPath。每次 Auth/BFF 请求重新读取，Kubernetes 发布 Secret 更新后会自动发现；投影更新可能有延迟。受信任管理员也可通过现有 Secret 管理流程补齐这两个字段，无需重启 DataPort。未挂载文件的本地服务可使用 `MX_HARBOR_SSO_PROFILE`、`MX_HARBOR_GATEWAY_TOKEN_FILE`，旧的 `MX_HARBOR_GATEWAY_TOKEN` 环境变量仍兼容。

Hub 固定地址由 `MX_HARBOR_HUB_ADMIN_ORIGIN` 指定，默认集群 DNS；请求失败返回 503，下次授权请求重新连接。Auth 使用可信 profile 中的 issuer 执行 OIDC 发现。没有跨 namespace 读取 Secret 的 Pod 权限，没有匿名业务数据或假登录。登录弹窗会显示不可用信息并支持重试。

## 迁移等待超时与失败诊断（2026-10-21）

截图中的 `timed out waiting for the condition on jobs/mx-harbor-migrate-...` 只能确认脚本没有等到 Job 的 `Complete`。原实现只等待成功条件，即使 Job 早已失败，也会继续等到 310 秒；随后删除 Job/Pod，再抛出统一的 `DataPort migration failed`，丢失现场原因。因此约 408 秒的整次部署耗时不能证明数据库执行了 300 秒，更不能据此判定数据库损坏。

DataPort 自身迁移只有 `001_sso.sql`：维护独立 `mx_harbor` 库的迁移记录与 `app_auth.browser_sso_records` 会话表；已应用时校验 checksum 后跳过。Hub 的业务迁移、Launcher 身份库均不在这个 Job 内。

Kubernetes 的 `Complete` 与 `Failed` 是不同终态；较新版本还可能先出现 `FailureTarget` 再等待 Pod 终止，见 [Job 终止条件](https://kubernetes.io/docs/concepts/workloads/controllers/job/#terminal-job-conditions)。诊断使用的数据库错误码对应 [PostgreSQL SQLSTATE](https://www.postgresql.org/docs/current/errcodes-appendix.html)。

本次修复：

- 同时观察 `Complete` 与 `Failed`/`FailureTarget`，明确失败立即结束等待；API 请求失败单独标为 `unavailable`。等待上限继续为 310 秒，Job 的 300 秒期限保持原值。
- PostgreSQL 连接 10 秒、锁等待 10 秒、语句 30 秒、客户端查询 35 秒上限，仅作用于迁移连接；失败连接销毁，避免网络故障后 `ROLLBACK` 继续排队等待。原迁移 SQL 和已应用 checksum 保留。
- 清理前打印 `DataPort migration diagnostics`，包含安全的 Job/Pod 状态、Warning 原因，以及迁移 `stage/status/code`。原始日志、错误详情、Secret 和连接串不回显。采集失败显示 `Unavailable` 标记，不能当作数据库检查通过。
- 只有 Job 明确完成才更新应用；失败后仍以前台级联删除确认迁移终止，终止未确认继续保留原部署锁。没有重跑迁移或自动修改数据库凭据。

新诊断中的典型分支：

| 输出 | 含义与下一步 |
| --- | --- |
| `scheduled: False` / `Unschedulable` | Pod 未调度；检查节点资源、taint 和调度事件，尚不能认为已执行数据库迁移 |
| `ErrImageNeverPull` | 固定节点的容器运行时未找到镜像；检查本次导入位置和节点匹配 |
| `FailedCreatePodSandBox` / `FailedMount` | 检查对应 Pod 的 CNI、卷或 Secret 引用事件 |
| `connect` + `ENOTFOUND` / `EAI_AGAIN` | 数据库 DNS 解析失败 |
| `connect` + `ECONNREFUSED` / `CONNECTION_TIMEOUT` | 检查 mx-common PostgreSQL、Service/端点和 Pod 到数据库的连通性 |
| `connect` + `28P01` / `3D000` | 分别为数据库认证失败、目标数据库不存在；核对原配置，不重新初始化或轮换 Secret |
| `lock` + `55P03` | 迁移 advisory lock 等待超时；核对仍在执行的迁移/数据库事务 |
| `history` / `apply` + `55P03` / `57014` | DDL 锁或语句超时；核对数据库阻塞事务 |
| `checksum` + `CHECKSUM_MISMATCH` | 已应用文件与当前 SQL 不一致；恢复正确迁移文件，不改写历史校验值 |
| `unavailable` | Kubernetes API/权限/响应读取失败，不能据此判断数据库状态 |

在服务器的 **`electron-dock/mx-dataport` 目录**先执行以下只读检查。旧脚本已删除失败 Job 时 `logs` 返回 `NotFound` 属于预期，Warning 事件也可能已经过期；无需为获取旧日志重复部署。

```bash
dataport_context="$(node -p 'JSON.parse(require("node:fs").readFileSync("secrets/operations.json","utf8")).context')"
kubectl --context "$dataport_context" --request-timeout=15s -n mx-harbor get pods,jobs -o wide
kubectl --context "$dataport_context" --request-timeout=15s -n mx-harbor logs job/mx-harbor-migrate-cf91aed0 --all-containers=true --tail=100
kubectl --context "$dataport_context" --request-timeout=15s -n mx-harbor get events --field-selector type=Warning --sort-by=.lastTimestamp
kubectl --context "$dataport_context" --request-timeout=15s -n mx-common get pods,services -o wide
```

后续正常发布沿用服务器原参数，仅发布 DataPort 即可让宿主脚本和镜像内迁移 runner 同时生效。在 **`electron-dock` 目录**的统一命令示例：

```bash
PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy mx-dataport
```

无需发布 Launcher/Auth、Hub 或 Pay，本次未修改 MX-H2I 登录、网络授权及路由。实际服务器根因与发布结果仍需以上只读回执/新诊断核实；本地替身测试不能替代生产验收。

本地验证：部署/锁恢复/接入/迁移回归 65 项、登录会话 20 项和迁移 Pod 隔离 1 项通过；真实 PostgreSQL 会话保留用例因未配置测试库跳过。新增异步数据库断连测试确认 stage/code 日志仍可输出，原始错误不会绕过日志保护。脚本语法与 diff 检查通过。完整前端构建因本机缺少原有 `xlsx`、`exceljs` 依赖及其派生类型错误未通过；本次未修改前端、依赖或 lockfile。未执行生产部署或数据库写入。

## K8s 管理合同

运行位置为固定 Internal 节点，需有 Node.js、Docker/Buildx、containerd `ctr`、kubectl 及相应本机权限。配置的 Kubernetes 节点 hostname 必须匹配本机；拒绝 cluster UID 漂移、不可调度节点和异常 taint，不猜测远程主机或修改集群 taint。

管理脚本不依赖宿主机的 `node_modules`，直接复用相邻 `mx-common/src/identity/profile.mjs` 的标准库校验；应用运行时继续通过已安装的 `@qpjoy/mx-common` 包加载 SSO。Docker 构建负责 `npm ci`，不需要人工先安装宿主依赖。冷启动回归从只复制源码的临时目录执行真实 `manage.sh`，避免已有本机依赖掩盖首次部署故障。

| 命令                  | 行为                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `plan`                | 读取本地非敏感操作配置，输出工作负载计划；配置缺失时提示先完成首次发现，始终不连接集群                                       |
| `enroll`             | 复用 Launcher 登记正式域名与独立 client，同步 DataPort/Hub 接入 Secret；不发布其他应用 |
| `recover-lock`       | 默认只读检查部署锁、相关进程及迁移任务；确认空闲后用 `--confirm-idle` 尝试受 UID/resourceVersion 保护的恢复 |
| `status` / `logs`     | 校验 cluster UID 后只读；缺少本地操作配置时只读发现，不保存文件                                                              |
| `deploy`              | 持有 DataPort 专用锁，校验保留配置、构建/导入唯一镜像、幂等迁移、更新 Deployment/Service 并自动重启，等待 rollout 和 readiness |
| `migrate` / `restart` | 兼容旧命令，均执行完整 `deploy` 流程，不再只迁移或只重启                                                                     |

首次安装和后续更新使用同一个命令（需要已有 mx-common PostgreSQL 健康）：

```bash
MX_HARBOR_BUILD_PROXY=http://127.0.0.1:7789 bash scripts/manage.sh ops internal-production deploy
```

每次新镜像都会更新 Pod 模板，自动替换旧 Pod 一次，不额外调用 `rollout restart` 导致二次重启。重复部署复用现存 Secret 和数据库，只执行尚未应用的迁移，重新校验已有迁移 SHA256，并补齐 DataPort namespace 自有标签。迁移失败保持旧应用；rollout 或 readiness 失败返回非零，不输出部署成功。

DataPort 采用一个副本、固定节点、`Recreate`，不是高可用/零停机部署。普通 Pod 的 hostPort 仅绑定 Internal 节点 `127.0.0.1:18220`，供本机 Nginx 访问；共享 PostgreSQL 使用集群 DNS。Pod 禁止自动挂载 service-account token，关闭 service links，以非 root 和只读根文件系统运行。

迁移只取得 DB Secret，不挂载 SSO/网关凭据。独立迁移记录保存 SHA256；已应用文件发生漂移会失败。即使释放锁失败也清理临时私密配置。迁移失败不替换运行中的应用；Job 终止未确认时保留锁，需先排查，不能盲目删除锁重试。锁释放使用原 ConfigMap UID precondition。

`mx-harbor-runtime` Secret 优先于本地文件。丢失本地 identity profile 不自动轮换会话密钥；已经安装但 runtime Secret 丢失时拒绝继续。缺少外部接入文件允许首次初始化；后续普通 deploy 只补充缺失字段，不替换已经登记的 identity/source。

`/health` 表示进程存活；`/ready` 校验 DataPort 数据库及迁移后的会话表，不等待 Auth/Hub。`/status` 仅返回外部接入配置状态：`pending`（尚未提供）、`configured`（本地配置有效）、`invalid`（配置无效），不泄露域名或密钥。该状态不宣称远端服务在线；真实接口仍执行认证、权限检查和网络调用。

## 本批验证证据

- DataPort：干净隔离目录安装与生产构建、裁剪开发依赖后的独立服务加载、TypeScript、BFF/固定上游/令牌不回传、受限路径、迁移并发与加密会话保留、部署命令替身与失败锁保护。
- Launcher：真实临时 PostgreSQL 的邀请并发/幂等/范围/deny；真实 OIDC 原生及托管登录、旧会话不绕过准入、撤权旧 token 失效；旧注册与密码登录回归。
- Hub：真实临时 PostgreSQL 的成员复用、并发仅建一个个人空间、旧平台管理授权保留；原 Hub HTTPS SSO 与身份/文档权限测试；Public listener 不开放 Portal。
- 兼容性：SDK Auth、Launcher 网络准入、身份管理台测试无失败。有测试环境条件的浏览器/独立网络数据库用例仍可能跳过，不能计作生产回归。
- 浏览器：桌面双栏邀请注册弹窗及窄屏滚动布局已检查。设计预览不创建账号，不调用供应商。

首批核心回归结果：DataPort 8 项通过；Launcher Auth/注册 15 项通过、1 项条件跳过；Hub Portal/原 SSO/身份 27 项通过。后续一键部署调整的 12 项操作回归均通过，覆盖首次安装、自动发现与保存操作配置、配置丢失后的恢复和节点保护、无接入配置时完成部署与后续补齐、连续部署保留凭据、兼容入口、迁移失败、rollout/readiness 失败和部署锁清理；使用命令替身与本地测试数据，未操作真实集群。

本次解耦外部依赖验证：12 项部署回归与 7 项服务回归通过；真实 PostgreSQL 迁移用例因未配置临时数据库跳过，生产构建通过。服务回归覆盖缺少接入配置时首页/就绪可用、受保护接口拒绝访问、运行中配置加入/移除/损坏及 Hub 连接失败后恢复。

本机没有执行真实 K8s 发布或生产操作。用户提供的服务器输出已确认 DataPort 迁移 Job 与 rollout 成功；这不代表域名、SSO、Hub 权限或支付已验收。此次没有创建生产账号、订单或付款。

正式域名接入增量验证：DataPort enrollment 6 项通过（包含真实 Launcher 登记逻辑、原客户端保留和遗失文件恢复）；原 12 项 deploy 回归通过。Hub Portal 3 项通过、1 项临时数据库用例因未配置跳过。网关证书管理 30 项、HTTP-01 安装 15 项、DataPort 公网安装 9 项、路由保护/回滚 12 项与原 Pay 安装 9 项均通过；这些使用隔离命令替身，不执行真实 ACME/Certbot、Nginx reload 或 systemd 操作。

## 数港界面与登录流程恢复（2026-10-11）

数港已经采用应用内定制 SSO 表单：账号密码与邀请码在 DataPort 页面填写，由 DataPort BFF 调用共享 Auth。OIDC 的顶层浏览器往返仍用于建立 issuer Cookie、state、PKCE 与回调绑定；不复制用户库，不以 iframe 绕过该流程。

- 单次登录事务与 Auth Interaction 有效期为 **5 分钟**，从发起时计时，不因获取表单而续期。
- 已登录会话及应用 access token 上限为 **30 天**；DataPort 取该上限与 token `expires_in` 的较小值。退出、撤销、修改密码或撤销准入仍可能提前失效。登录表单超时不代表已登录会话只有 5 分钟。
- 本地事务过期返回 `410/account_flow_expired`；issuer Interaction 过期可返回 `410/account_request_failed`。DataPort 对两者使用同一恢复流程：首次普通打开或用户明确重试时启动新事务；回调后的失败停留在数港表单显示错误，避免跳转循环。
- 超时或服务不可用时输入框保持可编辑。未取得有效 `formId` / CSRF 不提交凭据；重连不自动重放注册或登录请求，不保存密码与邀请码。表单读取、发起与提交请求有 15 秒网络等待上限，这不是会话有效期。
- 本次仅需部署 DataPort。共享 Auth 时限、Launcher / Hub / MX-H2I 服务端和准入规则均未改动。
- 客户页面按页面和空间重新挂载，切换时不再用上一页的数据渲染不同结构的卡片或表格，避免 `.map` 异常白屏，也不短暂展示上一个空间的数据。

本地验证：DataPort 51 项测试通过、1 项依赖临时 PostgreSQL 的迁移测试跳过；生产构建通过。浏览器使用本地替身验证 issuer 410 → 重试 → 新表单、输入可编辑及响应式布局，不代表生产账号/付款验收。

## 2026-10-11 商城、已购查询与账户安全

原“准备中”是 DataPort 前端固定关闭查询、BFF/Portal 仅允许读取造成的，不是 IP 查询正在执行。现在根据当前空间的真实订阅、角色、Key 授权和产品可用状态显示“去选购 / 启用查询 / 查询 / 暂不可用”。恢复入口只在连接失败或服务不可用时显示；加载、切路由和刷新权限不会自动查询供应商。

路由：`/#/market` 为数据商城，`/#/services` 为我的订阅，`/#/orders` 为支付订单，`/#/intelligence` 为新查询和历史，`/#/account` 为账户安全。公开定价入口登录后进入商城。商品价格、修订、期限和次数来自 Hub 目录，不采用原型旧价格；普通客户不能指定金额或创建验收价订单。

使用步骤：进入有相应权限的空间 → 商城确认商品并创建订单 → 在新页面打开收银台 → 回到 DataPort 查询原订单状态 → Hub 收到并提交真实付款事件后发放权益 → 我的订阅 → 开始使用 → 首次显式启用网页查询 → 输入 IPv4 并查询。创建订单和浏览器回跳均不视为付款成功。新空间复用 Hub 已有个人空间开通接口，开通空间不会赠送商品。

购买沿用当前空间的 `billing.read`、`recharge.create`、`apikey.write`；网页查询使用已获产品授权的 Live Key，由 Hub 签发绑定成员的短期凭据，凭据仅驻留页面内存。Hub Public API 继续检查成员、租户、调用者、Key、订阅、额度和服务状态。已过期或用尽的订阅不允许新查询，历史只读原 Key 保存的结果。缺失风险字段显示“未提供”，空标签不等于安全。

查询和订单都有幂等请求编号。订单创建响应不确定时保留编号；同一空间/Key/IP 在当前浏览器标签页重新加载后仍复用原查询编号，只有已确认结果的“查询详情”内、“重新查询此 IP”旁有计次说明的显式操作才创建新查询。编号及必要的输入定位保存在 sessionStorage，凭据和画像不持久化。未知结果显示待核对，不自动重试；历史列表/详情是 GET，不重放供应商请求。

BFF 与 Hub Portal 仅增量允许：`POST /demo-credentials`、`POST /payments/personal-account`、`POST /commerce/tenants/:id/access`、`POST /commerce/tenants/:id/orders`、`POST /commerce/tenants/:id/orders/:orderId/{checkout,refresh}`；增加 `GET /payments/return-order` 定位原订单。BFF 写请求重新验证 SSO、同源和 CSRF，限制 JSON 大小；Hub 再检查服务凭据、真实成员和目标空间权限，始终没有平台管理身份。没有开放任意 Admin 代理、Key 明文读取、验收价或商品编辑。

**支付边界：沿用 Hub 已有支付来源及 worker。** 2026-10-11 回跳修复增加按次 checkout 选择已登记 DataPort 返回地址，详见下节；没有新建 DataPort 支付应用或覆盖原订单身份。购买权益继续由原 Hub Commerce 事务发放，不新增支付账本；这不代表独立支付来源及 worker 隔离已经完成。

账户安全原三列大卡片并非原型现有页面。现在使用与原型比例一致的账号摘要和资料、密码、会话三个折叠分组；改密增加前端确认密码，服务端仍只接收原合同。资料修改、密码验证、会话撤销、切换账号继续走 mx-common，不改 SSO / MX-H2I 登录和联网逻辑。

已 enroll 且现有登录正常的环境，需要先更新 Hub 的 Portal 白名单，再更新 DataPort。在 Internal 的 `electron-dock/mx-dataport` 目录执行：

```bash
MX_INSIGHT_BUILD_PROXY=http://127.0.0.1:7789 bash ../mx-insight-hub/scripts/manage.sh ops internal-production deploy
MX_HARBOR_BUILD_PROXY=http://127.0.0.1:7789 bash scripts/manage.sh ops internal-production deploy
```

商城首次接入不要求重发 Launcher/Auth 或 mx-pay；下面的付款返回修复需要 Pay 同步升级。发布代码本身不会配置支付渠道、授予权益或产生查询；上线前仍需核对 Hub 已发布商品、Live 支付接入、产品可用性和受控商业验收。测试记录与视觉范围见 [验收文档](acceptance.md) 和 [界面验证](visual-verification.md)。

## 2026-10-11 付款后返回 DataPort

用户已确认 ¥1 验收单真实支付及权益开通，但支付宝返回了 Hub。原因是原 Pay 签名收银台链接使用渠道统一 `returnUrl`。修复后 Hub 仅对已验证 DataPort Portal 请求生成登记 origin 下的 `/payment/return`，Pay 校验该应用/环境/原渠道的精确返回白名单后签名；普通 Hub checkout 仍使用原默认地址。现有 Hub 创建的验收订单在 DataPort 继续付款也按入口返回，不改变业务单、支付单、金额、付款窗口、通知、交付事务或 MX-H2I。

在 Internal 的仓库根目录按顺序执行：

```bash
MX_PAY_BUILD_PROXY=http://127.0.0.1:7789 bash electron-dock/mx-base/mx-pay/scripts/manage.sh deploy
```

Pay 发布成功后，在支付中心「支付渠道 → 编辑原支付宝渠道 → 额外付款返回地址」填写：

```text
mx-insight-hub https://harbor.minsight-ai.com/payment/return
```

第一项是 Hub 当前支付接入的机器应用 ID，若实际配置不同则按原值填写；不是支付宝 APPID，也不是新建 DataPort 应用。保留原「付款后返回地址」及通知地址，保存草稿并发布，不复制支付宝渠道。随后发布：

```bash
MX_INSIGHT_BUILD_PROXY=http://127.0.0.1:7789 bash electron-dock/mx-insight-hub/scripts/manage.sh ops internal-production deploy
MX_HARBOR_BUILD_PROXY=http://127.0.0.1:7789 bash electron-dock/mx-dataport/scripts/manage.sh ops internal-production deploy
```

旧 Pay 缺少能力或原渠道未发布额外目标时，DataPort checkout 返回明确错误并保留原单；前端也拒绝缺失、重复或不匹配的 `return_url`，不会再静默跳往 Hub。回跳只定位当前成员有权读取的原订单，不能证明付款成功；状态和权益继续由原 Pay 事件及 Hub 事务确认。已经付款的 ¥1 单无需重付。已打开的旧签名链接仍保留旧地址；未付款且仍在原付款窗口内的订单，应回到 DataPort 重新打开原收银台。

本次本地验证：独立真实 PostgreSQL 下 Pay 37 项、Hub 35 项通过，均零跳过；DataPort 5 项 commerce UI helper 测试及生产构建通过。Hub 旧查询测试夹具补齐当前 gateway 所需的 migration 138，没有修改生产查询。支付控制台在本机隔离样例验证多行配置保存/回显及原默认值保留；未执行本次正式部署或真实再次付款。

## 2026-10-11 查询工作区与订单体验

`/tmp/dataport` 包含具体界面，不只是公开首页；控制台部分通过内部状态切换，未全部表现为独立 URL。原型中的样例数据、旧价格和账号实现不作为 DataPort 的业务合同。

| 原型源码 | DataPort 采用的结构 | 真实业务来源 |
| --- | --- | --- |
| `app/intelligence-overview.tsx` | 搜索、风险概览、基础资料、分类标签、最近查询及空/错误状态 | Hub 的已购权益、网页查询凭据和 IP 画像/历史接口 |
| `app/screens.tsx` 的 `Orders` / `Services` | 紧凑订单表格、订单详情弹窗及订阅卡片 | Hub 商品与不可变订单快照、原支付/交付状态 |
| `app/customer-console.tsx` / `app/platform.tsx` | 控制台导航、用量与服务入口 | 当前空间及成员权限；后续页面继续逐项接入 |

公开首页保留三栏功能介绍。登录后的查询工作区以查询和历史为主，移除三栏介绍及常驻“重新检查 / 查看订阅”操作条；订阅管理留在侧栏“我的订阅”。正常状态只展示本期用量和到期日。未购买时主按钮引导选购，首次启用只建立查询接入，不自动发送 IP 查询。

连接失败或服务暂不可用时，在搜索区就地展示“重新连接”，恢复后消失。历史读取失败只影响历史区，不清除有效凭据或阻止查询；其重载入口也只在失败时出现。点击历史记录会同步搜索框 IP 并定位画像。结果按真实风险等级、可选评分、归属地等字段和上游标签类别展示，缺失信息不补造；请求编号、异常细节和再次计次查询收进“查询详情”。

订单列表不再为每笔订单铺满大卡片，也不常驻刷新条。列表展示产品、金额、时间和状态，打开详情后才显示继续付款、查询付款状态或查看订阅。保留已有的原订单只读轮询；列表初次加载失败时提供局部重载，不显示误导的“暂无订单”。续订入口放在对应订阅卡片内。

本批仅修改 DataPort 前端及文档，不变更 Hub/Pay 的金额、权益、授权、支付返回校验或查询计量合同，也不修改 Launcher / MX-H2I 的登录和联网功能。仅需重新部署 DataPort；本地验证及其限制见 [界面验证](visual-verification.md)。

## 后续业务功能

1. Hub 多业务应用支付来源与 worker 隔离，按订单不可变来源恢复；保留原 Hub 路由、密文、fingerprint 和所有旧订单。
2. 独立支付来源若后续启用，应另行定义新来源及历史订单兼容合同；当前返回修复采用原渠道按次签名目标，不改写订单快照。
3. DataPort 独立来源的管理员验收入口与全链路回归仍待实现；当前共享来源的 ¥1 付款及权益已由用户确认，修复后的正式返回地址尚待上述部署后验证。
4. Key 管理写入、团队邀请和其余客户功能；逐项复用 Hub 授权与计量。
5. 实际域名、集群、网关及受控上线验收，确认全流程不依赖 Hub 公网域名后再开放销售。

这一清单仍是项目未完成部分，不因本批构建或认证测试通过而自动视为完成。

## 2026-10-11 客户订阅消息与重复购买

- `/#/messages` 新增客户站内消息、侧栏未读数、按时间分页和逐条标为已读。读取及操作都要求当前目标空间 `billing.read` 和真实成员身份；已读仅影响当前成员，不能用请求体指定别人。Hub Admin Token 的供应商告警没有开放给客户。
- Hub 迁移 `144_customer_subscription_messages.sql` 只增加 `hub_commerce.messages` 与 `message_reads`。消息不变记录关联原订阅；唯一 `(subscription_id, kind)` 防止副本并发或重启重复生成。消息体只保存产品名、原订单 ID、期限、次数与作用范围，没有支付凭据或供应商信息。
- Admin 进程每分钟最多生成 200 条本地提醒；Public 进程不启动该任务。待生效、生效、7 天内到期、24 小时内到期、到期各一条。离线跨过多个阶段时只生成当前阶段，不补发已失效警告；已有旧订阅首次运行也只得到当前阶段消息。后台故障不阻断登录、订单、查询和已保存消息，下一轮继续幂等处理。量大时分批完成，不承诺精确到秒。
- 消息生成只读已由原付款事务成功交付的正式订阅。未付和 test 订单没有客户权益消息；不向 Pay/供应商发送请求，不写钱包、不改订阅。打开页面不会触发消息收集。没有新增邮件、短信、飞书或浏览器推送发送。
- 商城与购买确认展示当前订阅/待生效续订的最晚到期日，允许继续购买；存在未完成订单时提供原订单入口。我的订阅显示 7 天/24 小时到期提示。当前规则仍是顺延生效，次数不结转；不新增自动扣费、钱包超额消费，也不重写旧套餐。

发布此增量时，在 Internal 主机仓库根目录依次运行（沿用当地原有构建代理配置）：

```bash
(cd electron-dock/mx-insight-hub && bash scripts/manage.sh ops internal-production deploy)
(cd electron-dock/mx-dataport && bash scripts/manage.sh ops internal-production deploy)
```

Hub 原 deploy 先执行幂等迁移再发布进程，之后再更新 DataPort。此增量不需重新发布 Launcher/Auth、mx-common 或 mx-pay；既有支付返回配置保持不变。原支付首次接入的 Pay → 渠道发布 → Hub → DataPort 顺序仍适用，但不是新增消息的前置重做步骤。

本地最终验证：DataPort 全套 59 项与 Hub 商城/Portal 22 项全部通过，无跳过；补测了原 Hub/DataPort 共享身份映射和 DataPort 加密会话迁移。商城与 SSO 使用真实一次性 PostgreSQL，覆盖原支付重复交付、并发额度、到期，以及新增消息去重、分页、跨空间拒绝、个人已读、停机跨期恢复、迁移重跑与不可变记录。DataPort 构建、Hub 类型检查通过。浏览器在 1440×1000 与 390×844 的隔离样例中验证消息、已读、重复购买提示和订单入口；无横向溢出及控制台错误。未发起真实付款、供应商查询或生产发布。
