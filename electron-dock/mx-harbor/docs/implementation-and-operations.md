# Harbor 第一批实现与部署说明

2026-10-11。当前可验证的是界面、账号准入和客户权限读取。支付与查询写路径尚未开放；本批不能用于真实 ¥1 付款验收或对外销售。

## 已实现

| 范围          | 实际行为                                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DataPort 设计 | 保留原 CSS、基础交互组件、首页 IP 搜索布局和双栏登录弹窗；gallery 与业务入口独立。来源见 `ui-design/source-manifest.json`                                       |
| 统一账号      | 原生登录/邀请注册、托管账号选择、资料修改、改密、撤销会话使用 mx-common。没有迁入原型的自有账号库                                                               |
| Harbor 准入   | 所有账号要求明确 `allowedAppIds` 包含 `mx-harbor`，显式 deny 优先。新账号通过专用邀请创建；旧账号在可信登录 interaction 中认证后兑换                            |
| 注册设置      | Internal 注册与邀请增加 Harbor 的关闭/邀请码模式；旧管理客户端省略新设置时保留它；Hub 原 `hubMode` 和全局关闭优先级保留                                         |
| 邀请隔离      | 新 `admissionAppId: mx-harbor` 区别于旧 `appGrant`。专用邀请仅开通 Harbor，不能用于其他应用。旧通用邀请不能开通 Harbor；通用“全部应用”排除 Harbor，其余应用照常 |
| 历史兼容      | 不改旧账号密码、SDK、网络租约；只有新 Hub/Harbor 账号创建时使用已有 H2I/Luopan 默认拒绝策略                                                                     |
| 客户权限      | Hub Portal 双重校验 BFF 凭据和 Auth UserInfo。以可信 canonical issuer/subject 关联原 Hub member，返回实际 membership，始终为客户视角                            |
| 读取功能      | 空间概览、空间权限、Key 列表、已有订阅/订单和权限过滤后的 OpenAPI；不开放供应商、排障、商品管理、付款写接口                                                     |
| 独立发布      | Harbor 独立库、迁移 Job、固定节点镜像导入、部署锁、重启/状态/日志/离线计划；保留已有 Secret                                                                     |

邀请不授予 Hub 租户角色或商品权益，也不授予 Pay 管理权限。关闭注册不会封禁已经开通的账号。撤销 Harbor 访问不修改其 Hub/H2I 权限。

Harbor 注册当前仅支持关闭或邀请码两种模式；现有其他应用的开放注册保留。飞书注册和直接飞书登录动作在 Harbor 服务端拒绝，既有统一账号的历史绑定不被删除。忘记密码仍由管理员处理；“验证旧密码后改密”不是自助密码找回。

## 2026-10-11 登录界面修复发布

首页和独立 gallery 均恢复原型的 `public-query-main` 居中容器。登录/邀请码注册字段不再依赖已有 flow 才渲染；连接时暂时禁用，失败时在原弹窗重试。只有读到真实关闭策略才显示“暂未开放邀请注册”，网络/配置错误不能伪装为关闭注册。

Harbor 显式启用 mx-common `navigation.applicationForm`：同源 `POST /auth/sso/start` 先经服务端凭据校验 Auth `capabilities`（appId/origin/audience/nativeForm），再创建 PKCE/state/nonce 和 host-only 登录 cookie。浏览器短暂经过 Auth 建立 issuer cookie，自动返回数港填写账号密码/邀请码；密码仍交给原 Auth 校验，没有新增密码库。返回的 flow 失效时停止自动往返，用户点击重试才重建；表单 409/410 也可重试。账号选择仍使用带数港名称的 Auth 账号选择页，选定后的密码/邀请表单返回 Harbor。已有消费者未开启该选项的流程保持不变。

Auth 的 Harbor 错误页仅给出数港返回入口，不列其他应用；无法验证来源的错误页也不列出内部应用。返回目标只来自已登记应用或签名恢复上下文，不信任任意 return 参数。

本次只读线上检查：匿名 Harbor `/auth/sso/form` 为 410（尚无 flow）；Harbor 发起 `mx-harbor-web` 原生授权后，Auth 授权入口直接返回 400、尚未建立 interaction。需要核对 Auth 已发布的客户端登记，不能把这个 400 当成密码错误或邀请码关闭。以下在 **Internal 主机，项目仓库根目录**执行，保留原环境参数：

```bash
bash electron-dock/mx-harbor/scripts/manage.sh ops internal-production enroll
MX_LAUNCHER_BUILD_PROXY=http://127.0.0.1:7789 MX_INSIGHT_HUB_DEPLOY=0 bash electron-dock/mx-launcher/scripts/manage.sh ops internal-production deploy
MX_HARBOR_BUILD_PROXY=http://127.0.0.1:7789 bash electron-dock/mx-harbor/scripts/manage.sh ops internal-production deploy
```

本次修改需要先发布 Launcher/Auth，再发布 Harbor（镜像自动带上新版 mx-common），否则 capability 预检会留在数港报接入未完成。Hub 已有 Portal 版本时无需因此重发；若尚未接入，按下节完成 Hub 首次发布。无需重新运行证书签发或 Domestic 安装。不要重建 identity profile 或轮换现有密钥来处理未加载的客户端。

本次本地回归 43 项通过、0 跳过（Harbor 26、mx-common SSO 4、Launcher 身份/邀请/应用隔离 9、Hub Portal 4），生产构建和 Launcher 类型检查通过。浏览器验收覆盖首页 1280px 中心对齐、390px 无横向溢出、登录/确认密码/邀请码字段、注册关闭及接入失败重试；UI 使用本地接口替身，完整认证协议另用临时库和真实 HTTPS 测试。

实际邀请码与共享权限操作见 [当前可执行验收](acceptance.md#当前可执行邀请码准入与共享权限)。本地真实 PostgreSQL/HTTPS 回归覆盖 PKCE、同源/CSRF、旧登录兼容、邀请码准入与撤权、共享 member/space；生产账号、真实付款和实际 H2I 联网仍由管理员受控验收。

## 外部应用接入配置（可在部署后完成）

正式入口为 **https://harbor.minsight-ai.com**。Harbor 可先建库、迁移和发布，随后接入 Auth、Hub；外部依赖不是迁移前置条件。

1. 用户已确认 Harbor 首次 deploy 成功。服务器同步当前代码后，在 Internal 的 `electron-dock/mx-harbor` 运行：

   ```bash
   bash scripts/manage.sh ops internal-production enroll
   ```

   命令使用已经固定的集群与本机节点，持有 Harbor 部署锁；调用 Launcher 原有加锁的 `ops identity app`，登记独立 `mx-harbor` public client，固定 origin 与 audience。读取 Hub 原 SSO profile 核对同一身份来源，把同一 profile 和独立网关凭据同步至 Harbor runtime Secret 与 Hub `mx-harbor-portal` Secret。保留数据库、clientSecret、sessionKey、已有 Secret 其他字段，不授予账号或产品权限。

   可以重复执行，局部失败可重试。支持恢复遗失的本地私密文件；已有配置不一致、正式域名不一致、Hub 未接入 SSO 或集群漂移时停止，不自动轮换凭据。Secret 使用 resourceVersion 更新，避免覆盖并发变更。宿主无需 node_modules。`secrets/identity/profile.json` 和 `secrets/gateway-token` 为 0600，不提交仓库。

2. 首次登记后，在 `electron-dock/mx-launcher` 使用原来的 `bash scripts/manage.sh ops internal-production deploy` 及原有环境参数，发布新的 Auth client 和 Harbor 准入能力。`MX_INSIGHT_HUB_DEPLOY=0` 可保留；Hub 单独发布。不要重新初始化身份档案。登记与发布均复用既有凭据；真实发布仍需检查旧 MX-H2I 登录和联网。
3. 在 `electron-dock/mx-insight-hub` 运行原发布命令：

   ```bash
   MX_INSIGHT_BUILD_PROXY=http://127.0.0.1:7789 bash scripts/manage.sh ops internal-production deploy
   ```

   Hub Admin 正式 K8s 清单已包含可选的 `mx-harbor-portal` 文件挂载与 Harbor namespace/Pod 入站规则；日后 Hub deploy 保留此接入。缺少或损坏的 Harbor 配置仅让 Portal 请求返回 503，不影响 Hub 自身启动及登录。Public listener 不开放 Portal。`hub-portal-enrollment.patch.yaml` 仅供旧清单兼容参考，当前版本无需手工 patch。Hub 使用 hostNetwork，NetworkPolicy 的实际效果取决于 CNI，认证授权始终在服务端执行。
4. Harbor 当前支持运行时发现投影配置；更新 Secret 后需要等待 Kubernetes 投影同步，不必为接入再次发布 Harbor。普通代码更新继续使用原 Harbor deploy，自动完成迁移和重启。
5. `de-mingxi` 已加入独立网关与证书入口，详见该仓库 `compass/deploy/HARBOR.md`。先将域名 DNS 指向 Domestic 公网入口并开放 TCP 80/443，然后：

   ```bash
   # Internal 的 de-mingxi：仅校验本机 Harbor 的 health/ready，再安装独立 vhost
   bash scripts/manage.sh internal-harbor-install
   # Domestic 公网机的 de-mingxi：首签或按需续期、内网就绪检查、HTTPS、仅 Harbor 续期预演
   bash scripts/manage.sh harbor-install
   ```

   原 Hub 的 `40-hub.conf` 不变。Harbor 拒绝 `/internal`、`/demos`、`/admin`；`/api/v1/` 保留 Hub Public 的 Key、权限、计量与幂等协议，Cookie 不转发，禁止代理自动重试。证书没有签发前不将 Harbor TLS 模板放入有效 conf.d，避免影响既有站点。
6. 管理员在 Internal 单独打开 Harbor 邀请，保持 Hub 原开放注册策略。所有旧账号也要获得 Harbor 邀请或显式授权；邀请不授予产品权益。验收域名、回调、登录、撤权、共享空间与文档权限后再接后续商业闭环。

Harbor 自身发布不要求先发布 Launcher/Hub。启用真实登录和客户服务前，Hub、Auth 的新能力仍须完成各自兼容发布；仅运行 Harbor deploy 不会登记新的 Auth client 或启用 Hub Portal。

### enroll 失败定位

旧提示 `kubectl 执行失败；未输出可能包含凭据的子进程内容` 无法判断线上根因。当前脚本输出 `[具体步骤/资源] + 退出码 + 已识别的错误类型`，例如读取 Hub SSO Secret 时的 `Forbidden`，或获取部署锁时的 `AlreadyExists`。不回显可能包含 Secret 的 stdout/stderr。所有 Kubernetes 请求限制为 15 秒；解锁失败单独报告，不覆盖最初错误，也不再提前显示接入成功。

在 **Internal 的 `electron-dock/mx-harbor` 目录**同步代码后，直接重试：

```bash
bash scripts/manage.sh ops internal-production enroll
```

此目录下无需再加 `electron-dock/mx-harbor/` 前缀。本次仅更新宿主脚本，无需为获取诊断重建镜像、重发应用或续签证书。

- `context/kubeconfig`：恢复上次 deploy 使用的 `KUBECONFIG`；不要修改已固定的 context/cluster UID 来绕过检查。
- `Forbidden/Unauthorized`：检查当前 Kubernetes 身份对报错 namespace/资源的权限或凭据。脚本不会扩大 RBAC。
- 部署锁 `AlreadyExists`：先检查正在运行的 deploy、迁移 Job、enroll；不自动删除锁。迁移终止未确认时，旧 deploy 也会有意保留此锁。
- 同步 Secret `Conflict`：等待其他修改任务完成后重试，仍复用现有凭据。
- 同时出现原始错误和“解锁未确认”：两条都保留；先检查锁状态，不能把 Secret 同步成功当作整个 enroll 成功。

仅当报部署锁已存在时，可用以下只读命令检查锁和迁移 Job，不读取 Secret 内容：

```bash
harbor_context="$(node -p 'JSON.parse(require("node:fs").readFileSync("secrets/operations.json", "utf8")).context')"
kubectl --context "$harbor_context" --request-timeout=15s -n mx-harbor get configmap mx-harbor-deploy-lock -o 'custom-columns=NAME:.metadata.name,ACTION:.data.action,CREATED:.metadata.creationTimestamp'
kubectl --context "$harbor_context" --request-timeout=15s -n mx-harbor get jobs
```

本次回归：接入核心 6 项、CLI 错误与清理 6 项、部署 12 项，共 24 项通过。CLI 使用隔离 kubectl 替身，验证报错步骤、敏感输出隐藏、原锁 UID 保护及临时文件清理；没有据此宣称生产 enroll 已成功。

首次发现可用 `MX_HARBOR_KUBE_CONTEXT`、`MX_HARBOR_NODE` 和 `MX_HARBOR_HUB_ADMIN_ORIGIN` 指定目标；节点仍须匹配本机 hostname。也可按 `deploy/operations.example.json` 手工填写配置，其中 `node` 是 Kubernetes 节点名称。普通 Pod 中的 `127.0.0.1` 不是宿主机，不能作为 Hub 上游。已有操作配置无效、与显式环境变量冲突或原部署位于其他节点时，脚本停止，不覆盖配置或迁移目标。

首次缺少 `secrets/identity/profile.json` 或 `secrets/gateway-token` 时只提示外部接入待配置，继续建库、迁移和发布。已有但无效的本地文件仍需修复。后续补齐文件后执行同一 `deploy`，仅填充 runtime Secret 中缺失的接入字段，保留已有数据库、clientSecret/sessionKey 和网关凭据；不会自行生成未在 Auth 登记的 SSO client，也不会覆盖 Hub 正在使用的凭据。

Harbor Pod 将 runtime Secret 的 `profile.json` 与 `MX_HARBOR_GATEWAY_TOKEN` 作为可选文件投影到 `/run/harbor/profile.json`、`/run/harbor/gateway-token`，不使用 subPath。每次 Auth/BFF 请求重新读取，Kubernetes 发布 Secret 更新后会自动发现；投影更新可能有延迟。受信任管理员也可通过现有 Secret 管理流程补齐这两个字段，无需重启 Harbor。未挂载文件的本地服务可使用 `MX_HARBOR_SSO_PROFILE`、`MX_HARBOR_GATEWAY_TOKEN_FILE`，旧的 `MX_HARBOR_GATEWAY_TOKEN` 环境变量仍兼容。

Hub 固定地址由 `MX_HARBOR_HUB_ADMIN_ORIGIN` 指定，默认集群 DNS；请求失败返回 503，下次授权请求重新连接。Auth 使用可信 profile 中的 issuer 执行 OIDC 发现。没有跨 namespace 读取 Secret 的 Pod 权限，没有匿名业务数据或假登录。登录弹窗会显示不可用信息并支持重试。

## K8s 管理合同

运行位置为固定 Internal 节点，需有 Node.js、Docker/Buildx、containerd `ctr`、kubectl 及相应本机权限。配置的 Kubernetes 节点 hostname 必须匹配本机；拒绝 cluster UID 漂移、不可调度节点和异常 taint，不猜测远程主机或修改集群 taint。

管理脚本不依赖宿主机的 `node_modules`，直接复用相邻 `mx-common/src/identity/profile.mjs` 的标准库校验；应用运行时继续通过已安装的 `@qpjoy/mx-common` 包加载 SSO。Docker 构建负责 `npm ci`，不需要人工先安装宿主依赖。冷启动回归从只复制源码的临时目录执行真实 `manage.sh`，避免已有本机依赖掩盖首次部署故障。

| 命令                  | 行为                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `plan`                | 读取本地非敏感操作配置，输出工作负载计划；配置缺失时提示先完成首次发现，始终不连接集群                                       |
| `enroll`             | 复用 Launcher 登记正式域名与独立 client，同步 Harbor/Hub 接入 Secret；不发布其他应用 |
| `status` / `logs`     | 校验 cluster UID 后只读；缺少本地操作配置时只读发现，不保存文件                                                              |
| `deploy`              | 持有 Harbor 专用锁，校验保留配置、构建/导入唯一镜像、幂等迁移、更新 Deployment/Service 并自动重启，等待 rollout 和 readiness |
| `migrate` / `restart` | 兼容旧命令，均执行完整 `deploy` 流程，不再只迁移或只重启                                                                     |

首次安装和后续更新使用同一个命令（需要已有 mx-common PostgreSQL 健康）：

```bash
MX_HARBOR_BUILD_PROXY=http://127.0.0.1:7789 bash scripts/manage.sh ops internal-production deploy
```

每次新镜像都会更新 Pod 模板，自动替换旧 Pod 一次，不额外调用 `rollout restart` 导致二次重启。重复部署复用现存 Secret 和数据库，只执行尚未应用的迁移，重新校验已有迁移 SHA256，并补齐 Harbor namespace 自有标签。迁移失败保持旧应用；rollout 或 readiness 失败返回非零，不输出部署成功。

Harbor 采用一个副本、固定节点、`Recreate`，不是高可用/零停机部署。普通 Pod 的 hostPort 仅绑定 Internal 节点 `127.0.0.1:18220`，供本机 Nginx 访问；共享 PostgreSQL 使用集群 DNS。Pod 禁止自动挂载 service-account token，关闭 service links，以非 root 和只读根文件系统运行。

迁移只取得 DB Secret，不挂载 SSO/网关凭据。独立迁移记录保存 SHA256；已应用文件发生漂移会失败。即使释放锁失败也清理临时私密配置。迁移失败不替换运行中的应用；Job 终止未确认时保留锁，需先排查，不能盲目删除锁重试。锁释放使用原 ConfigMap UID precondition。

`mx-harbor-runtime` Secret 优先于本地文件。丢失本地 identity profile 不自动轮换会话密钥；已经安装但 runtime Secret 丢失时拒绝继续。缺少外部接入文件允许首次初始化；后续普通 deploy 只补充缺失字段，不替换已经登记的 identity/source。

`/health` 表示进程存活；`/ready` 校验 Harbor 数据库及迁移后的会话表，不等待 Auth/Hub。`/status` 仅返回外部接入配置状态：`pending`（尚未提供）、`configured`（本地配置有效）、`invalid`（配置无效），不泄露域名或密钥。该状态不宣称远端服务在线；真实接口仍执行认证、权限检查和网络调用。

## 本批验证证据

- Harbor：干净隔离目录安装与生产构建、裁剪开发依赖后的独立服务加载、TypeScript、BFF/固定上游/令牌不回传、受限路径、迁移并发与加密会话保留、部署命令替身与失败锁保护。
- Launcher：真实临时 PostgreSQL 的邀请并发/幂等/范围/deny；真实 OIDC 原生及托管登录、旧会话不绕过准入、撤权旧 token 失效；旧注册与密码登录回归。
- Hub：真实临时 PostgreSQL 的成员复用、并发仅建一个个人空间、旧平台管理授权保留；原 Hub HTTPS SSO 与身份/文档权限测试；Public listener 不开放 Portal。
- 兼容性：SDK Auth、Launcher 网络准入、身份管理台测试无失败。有测试环境条件的浏览器/独立网络数据库用例仍可能跳过，不能计作生产回归。
- 浏览器：桌面双栏邀请注册弹窗及窄屏滚动布局已检查。设计预览不创建账号，不调用供应商。

首批核心回归结果：Harbor 8 项通过；Launcher Auth/注册 15 项通过、1 项条件跳过；Hub Portal/原 SSO/身份 27 项通过。后续一键部署调整的 12 项操作回归均通过，覆盖首次安装、自动发现与保存操作配置、配置丢失后的恢复和节点保护、无接入配置时完成部署与后续补齐、连续部署保留凭据、兼容入口、迁移失败、rollout/readiness 失败和部署锁清理；使用命令替身与本地测试数据，未操作真实集群。

本次解耦外部依赖验证：12 项部署回归与 7 项服务回归通过；真实 PostgreSQL 迁移用例因未配置临时数据库跳过，生产构建通过。服务回归覆盖缺少接入配置时首页/就绪可用、受保护接口拒绝访问、运行中配置加入/移除/损坏及 Hub 连接失败后恢复。

本机没有执行真实 K8s 发布或生产操作。用户提供的服务器输出已确认 Harbor 迁移 Job 与 rollout 成功；这不代表域名、SSO、Hub 权限或支付已验收。此次没有创建生产账号、订单或付款。

正式域名接入增量验证：Harbor enrollment 6 项通过（包含真实 Launcher 登记逻辑、原客户端保留和遗失文件恢复）；原 12 项 deploy 回归通过。Hub Portal 3 项通过、1 项临时数据库用例因未配置跳过。网关证书管理 30 项、HTTP-01 安装 15 项、Harbor 公网安装 9 项、路由保护/回滚 12 项与原 Pay 安装 9 项均通过；这些使用隔离命令替身，不执行真实 ACME/Certbot、Nginx reload 或 systemd 操作。

## 下一批必须完成

1. Hub 多业务应用支付来源与 worker 隔离，按订单不可变来源恢复；保留原 Hub 路由、密文、fingerprint 和所有旧订单。
2. mx-pay 同渠道按业务 app 配置返回目标，写入新订单快照，Harbor 未配置独立返回地址时禁止激活。
3. Internal 的 Harbor ¥1 管理员验收入口、Harbor 订单付款/刷新/返回恢复、事件提交与权益发放的故障边界回归。
4. Harbor IP 网页查询、历史记录、真实定价卡/购买流程、Key 管理写入、团队邀请和其余客户功能；逐项复用 Hub 授权与计量。
5. 实际域名、集群、网关及受控上线验收，确认全流程不依赖 Hub 公网域名后再开放销售。

这一清单仍是项目未完成部分，不因本批构建或认证测试通过而自动视为完成。
