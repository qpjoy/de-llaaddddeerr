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

## 首次接入配置

正式域名尚待确定。示例中的 `harbor.example.com` 必须统一替换；不能直接使用示例域名部署。

1. 使用 Launcher 已有接入应用流程登记 `mx-harbor`，origin 为正式 HTTPS 域名，audience 为 `mx-harbor`，选择 public entry。原 CLI 为：

   ```bash
   bash scripts/manage.sh ops identity app --app mx-harbor --origin https://harbor.example.com --audience mx-harbor --entry public --output ../mx-harbor/secrets/identity/profile.json
   ```

   该命令在 `mx-launcher` 运行，只登记配置。发布 Auth 仍走原流程；Harbor 日常 deploy 不自动执行它。Launcher App Center 也应登记 Harbor 展示条目，方便管理员从用户中心选择应用授权。

2. Harbor 的 `secrets/identity/profile.json` 保留原 clientSecret/sessionKey，权限 0600。新建独立 `secrets/gateway-token`，至少 32 字符，权限 0600；不要复用 Hub Admin Token。
3. 复制 `deploy/operations.example.json` 为 `secrets/operations.json`，明确 Kubernetes context、`kube-system` namespace UID、Internal 节点 hostname 和 Hub Admin Service origin。默认示例使用 `http://mx-insight-hub-admin.mx-insight-hub.svc.cluster.local:18151`；普通 Pod 中的 `127.0.0.1` 不是宿主机。
4. 已有 mx-common PostgreSQL 必须健康。Harbor 首次 deploy 仅调用 `mx-common provision mx-harbor`，捕获 DSN 写入 Harbor Secret，不输出密码、不部署整套共享服务。已有角色但遗失 Secret 时，沿用 mx-common 的拒绝自动换密码保护。
5. 在 Hub 的 namespace 创建 `mx-harbor-portal` Secret，包含同一 `profile.json` 与 `gateway-token`。Hub 需要能够验证这个独立 OIDC client；它不会签发 Harbor 浏览器会话。保留 Hub 原 SSO profile 及其 canonical audience。
6. 对兼容版本的 Hub Admin 进行一次性接入发布：使用 `deploy/k8s/hub-portal-enrollment.patch.yaml` 的环境变量/挂载，以及 `hub-portal-ingress.yaml` 的精确 namespace + Pod 标签入站规则。将补丁纳入 Hub 实际部署配置，避免后续 Hub 发布丢失接入。Harbor deploy 不替用户执行这次 Hub 发布。
7. 使用独立 Domestic/Internal vhost 模板配置正式域名。参考部署文件为用户指定的 `de-mingxi/compass/deploy/nginx/conf.d/40-hub.conf`；本批没有修改它。Harbor 新配置拒绝 `/internal/` 与 `/demos/`，SSO cookie 留在 Harbor 域名。机器 `/api/v1/` 保留原 Hub API 合同，Cookie 不转发，不重复计费。
8. 完成受控部署验收后，管理员在 Internal 单独打开 Harbor 邀请，保持 Hub 原开放注册设置。旧账号也必须获得 Harbor 邀请或直接授权。

初次依赖接入与日常部署是不同操作。Hub、Auth 的新能力必须先完成各自兼容发布；仅运行 Harbor deploy 不会使尚未发布的后端能力自动生效。

## K8s 管理合同

运行位置为固定 Internal 节点，需有 Node.js、Docker/Buildx、containerd `ctr`、kubectl 及相应本机权限。配置的 Kubernetes 节点 hostname 必须匹配本机；拒绝 cluster UID 漂移、不可调度节点和异常 taint，不猜测远程主机或修改集群 taint。

管理脚本不依赖宿主机的 `node_modules`，直接复用相邻 `mx-common/src/identity/profile.mjs` 的标准库校验；应用运行时继续通过已安装的 `@qpjoy/mx-common` 包加载 SSO。Docker 构建负责 `npm ci`，不需要人工先安装宿主依赖。冷启动回归从只复制源码的临时目录执行真实 `manage.sh`，避免已有本机依赖掩盖首次部署故障。

| 命令                  | 行为                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `plan`                | 读取本地非敏感操作配置，输出工作负载计划；不调用集群、不生成秘密                                                             |
| `status` / `logs`     | 校验 cluster UID 后只读                                                                                                      |
| `deploy`              | 持有 Harbor 专用锁，校验保留配置、构建/导入唯一镜像、幂等迁移、更新 Deployment/Service 并自动重启，等待 rollout 和 readiness |
| `migrate` / `restart` | 兼容旧命令，均执行完整 `deploy` 流程，不再只迁移或只重启                                                                     |

首次配置完成后，日常部署只需一个命令：

```bash
MX_HARBOR_BUILD_PROXY=http://127.0.0.1:7789 bash scripts/manage.sh ops internal-production deploy
```

每次新镜像都会更新 Pod 模板，自动替换旧 Pod 一次，不额外调用 `rollout restart` 导致二次重启。重复部署复用现存 Secret 和数据库，只执行尚未应用的迁移，重新校验已有迁移 SHA256，并补齐 Harbor namespace 自有标签。迁移失败保持旧应用；rollout 或 readiness 失败返回非零，不输出部署成功。

Harbor 采用一个副本、固定节点、`Recreate`，不是高可用/零停机部署。普通 Pod 的 hostPort 仅绑定 Internal 节点 `127.0.0.1:18220`，供本机 Nginx 访问；共享 PostgreSQL 使用集群 DNS。Pod 禁止自动挂载 service-account token，关闭 service links，以非 root 和只读根文件系统运行。

迁移只取得 DB Secret，不挂载 SSO/网关凭据。独立迁移记录保存 SHA256；已应用文件发生漂移会失败。即使释放锁失败也清理临时私密配置。迁移失败不替换运行中的应用；Job 终止未确认时保留锁，需先排查，不能盲目删除锁重试。锁释放使用原 ConfigMap UID precondition。

`mx-harbor-runtime` Secret 优先于本地文件。丢失本地 identity profile 不自动轮换会话密钥；已经安装但 runtime Secret 丢失时拒绝继续。首次初始化需要本地配置，后续配置变更需明确操作，不通过普通 deploy 暗中替换 identity/source。

## 本批验证证据

- Harbor：干净隔离目录安装与生产构建、裁剪开发依赖后的独立服务加载、TypeScript、BFF/固定上游/令牌不回传、受限路径、迁移并发与加密会话保留、部署命令替身与失败锁保护。
- Launcher：真实临时 PostgreSQL 的邀请并发/幂等/范围/deny；真实 OIDC 原生及托管登录、旧会话不绕过准入、撤权旧 token 失效；旧注册与密码登录回归。
- Hub：真实临时 PostgreSQL 的成员复用、并发仅建一个个人空间、旧平台管理授权保留；原 Hub HTTPS SSO 与身份/文档权限测试；Public listener 不开放 Portal。
- 兼容性：SDK Auth、Launcher 网络准入、身份管理台测试无失败。有测试环境条件的浏览器/独立网络数据库用例仍可能跳过，不能计作生产回归。
- 浏览器：桌面双栏邀请注册弹窗及窄屏滚动布局已检查。设计预览不创建账号，不调用供应商。

首批核心回归结果：Harbor 8 项通过；Launcher Auth/注册 15 项通过、1 项条件跳过；Hub Portal/原 SSO/身份 27 项通过。后续一键部署调整的 6 项操作回归均通过，覆盖首次安装、连续部署保留凭据、兼容入口、迁移失败、rollout/readiness 失败和部署锁清理；使用命令替身与本地测试数据，未操作真实集群。

Docker daemon 在本机不可用，因此没有构建容器镜像或执行真实 K8s 发布。未连接生产数据库，未进行生产 DNS/TLS/回调验收，没有创建生产账号、订单或付款。

## 下一批必须完成

1. Hub 多业务应用支付来源与 worker 隔离，按订单不可变来源恢复；保留原 Hub 路由、密文、fingerprint 和所有旧订单。
2. mx-pay 同渠道按业务 app 配置返回目标，写入新订单快照，Harbor 未配置独立返回地址时禁止激活。
3. Internal 的 Harbor ¥1 管理员验收入口、Harbor 订单付款/刷新/返回恢复、事件提交与权益发放的故障边界回归。
4. Harbor IP 网页查询、历史记录、真实定价卡/购买流程、Key 管理写入、团队邀请和其余客户功能；逐项复用 Hub 授权与计量。
5. 实际域名、集群、网关及受控上线验收，确认全流程不依赖 Hub 公网域名后再开放销售。

这一清单仍是项目未完成部分，不因本批构建或认证测试通过而自动视为完成。
