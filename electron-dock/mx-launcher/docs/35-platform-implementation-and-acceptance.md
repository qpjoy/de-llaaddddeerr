# MX 平台分阶段实现与验收

日期：2026-10-03。依据：[目标架构](33-mx-platform-identity-and-sustainable-architecture.md)、[总部署与恢复契约](34-platform-deploy-and-recovery-contract.md)。

用户已授权开始实现，按可独立验收的小阶段交付。首期界面归纳，以及随后要求的四服务部署工作区与独立执行器，已在本地实现并验证。2026-10-03 增加 Launcher 个人管理账号的 OIDC 客户端、持久化会话与已有密码账号绑定试点，默认关闭，见第 6 节。本次没有部署生产或建立真实身份提供方；身份引擎兼容适配、邀请注册、Hub 新登录、飞书关联，以及证书/备份/总编排仍待后续交付。文档 33 中的 P1 包含更完整的可观测能力，不能把当前界面和单服务操作当作全部完成。

## 1. 持续保护的基线

- 线上 Luopan 为外部仓库 `po-frontend` 的 `feat/yjj/hdo_v2`，本轮不改其文件、SDK、补丁、业务登录或更新渠道；`demos/luopan` 不能代表线上产品验收。
- MX-H2I 的旧账号、密码/飞书/访客入口、已有 token、SDK 协议、网络地址、lease 和 peer 保持兼容。
- Hub 原 member、tenant、membership、API Key、余额和历史记录保持不变；新入口不创建同一人的第二个成员。
- 新路径以增量配置启用；未就绪的公共注册与新登录不在生产开放，旧路径继续可用。
- 导航与统一页面不替代领域授权，不把 Ops Token 暴露给公共注册或其他中心。

## 2. 阶段与交付顺序

| 阶段 | 用户可验收的结果 | 实现重点与放行条件 |
| --- | --- | --- |
| 1. Launcher 界面归纳 | 工作台、功能搜索、应用目录、成员/网络/发布/运维/设置入口 | 本次本地完成；复用原页面和路由，不改业务 API |
| 2. 账号开通基础与邀请注册 | 在 Launcher 管理注册模式、邀请码、成员邀请；一个入口完成账号和产品开通 | 身份唯一写入者、独立 create-only 注册事务、邀请码并发/限额/到期/撤销；隔离环境验收后再启用 |
| 3. 标准 SSO 与兼容适配 | 新 Web 应用统一登录，应用间切换复用会话，旧客户端仍正常工作 | 先验证身份引擎与原账号/密码/主体映射，再接 OIDC code + PKCE、客户端登记、会话及撤销 |
| 4. Hub 自助开通 | 从 Hub 注册后直接进入正确工作空间；已有成员无感使用新 SSO | 原租户复用、可信预绑定、幂等 onboarding、登录回跳、旧地址/旧 token 兼容 |
| 5. 飞书登录注册与账号绑定 | Hub 通过现有飞书应用登录；本地账号可关联飞书；重复身份有明确处理入口 | 保留 H2I 回调与飞书网络 profile；新增 Web callback；绑定需身份验证，冲突不能自动提权 |
| 6. 运维可观测与日常操作 | 域名/证书、服务风险、部署任务、有限重启/重部署和备份入口 | 四服务部署工作区与独立执行器已先行实现，见 36；真实主机验收、证书及备份等继续推进 |
| 7. 总 deploy 与恢复演练 | 一份安装清单、一个入口，按依赖恢复已选中心 | 锁定版本、保留 Secret/存储身份、重跑幂等；同机与换机分别验收，不重复初始化业务 |

阶段 2 的注册 UI 与政策可以先实现，但公共入口的发布必须等待阶段 3 的身份验证结论与恢复能力，避免先形成一套密码/注册真相，接 SSO 时又建第二套。Hub 开通策略与邀请码在接口设计阶段一起确定，实现仍分小批交付。运维只读盘点可穿插推进，不阻塞身份试点。

## 3. 本次界面实现

变更位于 `desktop/index.html`、`desktop/renderer.js`、`desktop/styles.css`，继续使用原 Admin 静态资源打包路径，无新运行依赖。已有网络 UI 测试仅更新菜单名称断言。

### 导航归类

| 页面入口 | 复用的既有功能 |
| --- | --- |
| 工作台 | 新增常用任务、功能/应用搜索、应用管理入口；尚未整合中心标明待接入 |
| 应用与工作空间 | 原 AppCenter 动态应用树、MX-H2I、Hub、Luopan 等已登记应用 |
| 成员与访问 | 原 Internal 的 User Center、RBAC |
| 网络与设备 | 原 Launcher Network Dashboard，保持按 ProductNetwork 管理 |
| 发布与交付 | 原 Release Center、E2E Gate、Evidence 中的 Release Gate |
| 运行与维护 | 原 I-HDO 概览、Oversea/Domestic/Internal 部署、Observability、Admin/Runner |
| 日志与记录 | 原执行、Runner/Worker、报告、回滚与审计证据 |
| 平台设置 | 原 Internal 概览、Config Center、DNS、Mihomo、SDK Gateway；AWX 暂作为兼容入口保留 |

导航分组是表现层映射。后台的 `internal/operations/evidence` 路由及业务数据归属没有改名；原页面中的交叉跳转仍按原路由解析到新分组。AWX 未删除服务或凭据，完整退役仍需核对真实引用。

服务器地址和 Ops Token 放入“连接与应急访问”折叠区，当前连接状态保持可见。Token 仍是会话内使用、绑定单一服务器 origin；改变服务器地址仍清除 Token，同时清除工作台旧目录展示，防止把上一环境的应用当作当前环境。

工作台区分“已登记”“内置入口”“管理界面待接入”。这些是入口整合状态，不是在线/健康断言。目录请求失败显示未知，不发起自动修复。搜索覆盖当前功能与应用名称，不提供全平台用户枚举。

首期导航批次没有新增邀请注册按钮、SSO 表单或运维重启按钮。随后用户要求的部署增量见第 5 节。Hub 与 Luopan 的“管理应用”进入现有产品管理页，不代表它们已完成新的 SSO 或业务管理整合。

### 本地验收记录

- `pnpm --dir electron-dock/mx-launcher/desktop run build`：类型检查、脚本语法、包契约及现有 UI 回归通过，含 Ops Token origin、订阅隔离、发布产品身份与 ProductNetwork 管理回归。
- 浏览器采用 Playwright + 临时 Chrome 配置；Browser 插件/skill 未提供，使用本机已有运行时，没有安装新依赖。
- 验收服务为 `http://127.0.0.1:18119`，仅模拟数据，拒绝非 GET/HEAD 请求；未连接生产。该服务是临时验收工具，不进入产品包。
- 1440 × 1000 桌面、390 × 844 窄屏检查：工作台、搜索/空结果、目录刷新、菜单分组、折叠侧栏、Luopan 管理入口和原网络面板可操作；窄屏工作台没有横向溢出。
- 交互覆盖跨旧菜单的“发布 → 发布门禁”、从工作台的折叠侧栏进入 RBAC、切换服务器后 Token 清空与目录失效。
- 无页面 JavaScript 异常、无框架错误覆盖、无写请求、无访问本地验收服务之外的请求。故意注入目录 503 时，浏览器记录对应失败请求，UI 正确显示暂不可用。

这是前端兼容验证，不是生产登录、真实 VPN 连通或客户端升级验收。没有重启服务、部署服务器或生成/推送新 Luopan 安装包。

### 人工验收步骤

1. 打开工作台，确认无需选择角色即可找到常用任务；搜索“发版”“Hub”，再清空搜索。
2. 从成员进入用户列表与 RBAC，从发布进入版本/灰度及发布门禁，确认仍是原有业务内容。
3. 打开网络与设备，确认原 ProductNetwork 过滤、连接详情和 Luopan 产品入口仍存在；本期验收无需执行网络变更。
4. 展开连接与应急访问，确认原服务器与 Token 操作仍可找到；在隔离环境验证地址改变清除 Token。
5. 收起侧栏后进入成员/设置，再返回工作台；检查键盘 focus、窄窗口和滚动。
6. 确认未接入中心不会显示为健康，不会提供无实现的重启/SSO 按钮。

本批产品改动仅涉及 Admin 资源及原菜单测试断言，无数据库、凭据或客户端迁移。2026-10-02 核对用户现用 `ops internal-production deploy`：该入口将网页装入服务镜像，并执行已有迁移任务、API rollout、默认 native host runner 重启和网关收敛，不能按“纯静态文件热更新”评估发布过程。API 的 RollingUpdate 策略有保留旧副本的保护，但本地模拟验收不能证明生产旧会话、网关和 VPN 在整个部署中无感。

若要求发布全程无影响，先验证现有生产发布流程的这些环节或补齐交付能力，不以此次前端测试替代。发布验收至少包括原账号/飞书登录、已连接 MX-H2I 与线上 Luopan 的联网保持及新建连接、Hub 原租户/Key 可用，以及旧业务管理入口；不能只检查新工作台能打开。前端代码回退可恢复本批之前的三份资源后按既有流程交付，不涉及本批新增的数据回滚；这不是自动回滚整个部署的承诺。

运维二级入口定为“运行与维护 → 服务与部署”。用户给出的 Launcher/Hub 部署参数、Embedding 的实际命令与 GPU 限制、自更新独立执行器要求见 [部署契约 9.6](34-platform-deploy-and-recovery-contract.md#96-服务与部署菜单归属和现有生产档案)。该入口随后已按用户要求实现，见第 5 节；没有执行生产部署。

## 4. 下一阶段的具体工程边界

邀请码和自助注册应新增专门的注册域 API，不公开现有管理员 upsert 方法。首先完成稳定账号映射、可信应用来源、注册政策版本、邀请码摘要/预占/兑换记录、产品开通幂等键及状态查询。已有账号使用原登录；邀请码政策只约束新统一注册路径。

首个端到端例子选择 Hub：注册事务创建账号 → Hub 复用/创建 member → 加入明确邀请的原租户或按政策建个人空间 → 回到 Hub。步骤失败可继续，同一码并发最后一个名额只成功一次，重复回调不产生第二个租户或权益。

飞书复用原 App ID/Secret/企业限制，增加独立 HTTPS 回调；原 H2I loopback 回调、网络 profile 和用户 ID 保留。绑定先验证双方主体；同邮箱或同姓名只能提示候选，不能自动归并权限。Luopan 当前双登录与匿名联网链路不参与这一批切换。

进入真实外部联调前需要实际域名/TLS、允许的飞书 Web 回调、身份引擎验证结论以及测试环境配置。实施时先读取已存在的可用配置；缺少必要字段再集中列明，不要求在每个阶段重复确认已接受的架构决策。

## 5. 四服务部署增量

用户补充 OCR 已验证、四服务同机同项目，并要求直接实现部署设计。已新增参数组件、命令预览/复制、按服务器隔离的草稿、主机配置保存、预检/计划/执行/记录 API，以及独立于 Launcher/native host runner 的 systemd 执行器。部署动作固定版本与参数，有效计划才可执行；不自动拉代码或部署兄弟服务。

这批已包含后端和可选 K8s 配置，不再只是首期三份静态资源。没有新增业务数据库迁移或修改旧登录/网络协议。新执行 API 使用原 Ops Token，独立执行器未配置时返回未接入；原管理与登录服务继续按旧配置运行。

完整操作、随 Launcher deploy 幂等安装/安全更新、测试与限制见 [服务与部署使用说明](36-service-operations.md)。正式发布需交付新增两份前端模块、服务端 controller/agent/install、K8s 可选 Secret 引用、mx-base 机器计划授权与 OCR 修正、Hub 代理优先级修正；只同步旧三份静态文件会缺少模块。本机真实子进程已验证任务结果落盘后切换版本，Linux systemd 实际托管与 GPU/联网验收仍待在目标环境完成。

## 6. Launcher 个人管理登录试点（2026-10-03）

### 已实现的范围

Launcher 管理站作为标准 OIDC 客户端（RP），新增“个人账号”入口、已有密码账号关联、管理会话和当前浏览器退出。使用固定版本 `openid-client@6.8.8` 实现 code + PKCE S256、state/nonce、issuer/audience/有效期和 RS256 签名验证；没有自建 OAuth 授权服务器。[标准客户端说明](https://github.com/panva/openid-client)。

这一步是管理站试点，不代表统一身份平台已部署。上游 IdP、原密码兼容桥、公共注册、Hub 接入、复用 H2I 飞书应用的 Web 登录与飞书账号关联尚未实现。现有用户无需切换、重新绑定或修改客户端；只有选择参加个人管理登录试点的操作人员需要首次关联。正式对用户推广前仍需完成第 3 阶段的身份唯一写入者验证，不能让两套账号系统独立注册并互相同步密码。

首轮流程：

1. 操作人员从同源 HTTPS `/admin/` 点击“个人账号登录”，进入已配置的 IdP。
2. IdP 验证成功后，没有映射的主体进入“关联已有 MX 账号”，验证原账号密码。这里调用原密码校验，不改密码哈希、不 upsert 用户、不按邮箱/姓名自动合并。
3. `(issuer, sub)` 原子绑定至已有 `userId`。同一个外部主体不能覆盖或换绑到另一个用户。多个副本同时关联只有一个成功，冲突提示重新登录。
4. 原用户具有 `mx-admin` 才能操作管理 API。普通用户可以完成登录/绑定，但显示“尚无管理权限”。上游传来的 role/email/name 不授予本地管理权限。历史 bootstrap 演示账号 `usr_demo_admin` / `usr_demo_user` 曾带预置密码，禁止参与此个人入口；试点请使用单独的个人账号，旧演示账号的原登录不改。
5. 再次登录直接复用映射；服务端每次请求检查原账号状态及当前角色，停用/移除 `mx-admin` 后下一次请求拒绝。该批只提供完整管理权限，不宣称已经具备细粒度分中心授权。

### 会话与兼容边界

- 浏览器仅保存 `__Host-`、Secure、HttpOnly、SameSite=Lax 的随机会话 cookie；无 Domain，Path 为 `/`。数据库记录会话 ID 摘要，浏览器不保存上游 access/refresh/ID token，也不获得 Ops Token。
- 登录事务与待关联会话有效期 5 分钟；管理会话闲置 30 分钟失效，绝对上限 12 小时。全部管理写操作要求上游 `auth_time` 在最近 5 分钟内；过期时点击“重新验证”，操作不会自动重放。
- 状态、事务、映射存于现有 PostgreSQL `mx_platform_records` 的三个新 kind：`admin-sso-transaction`、`admin-sso-session`、`admin-sso-binding`。复用原复合主键，不修改旧用户/租户记录，无新增 schema 迁移。登录事务用原子 DELETE RETURNING 消费，续期只 UPDATE 已存在且未过期记录，不恢复已退出的会话；过期瞬态记录在新会话/事务插入时回收。
- 管理请求改走同源 `/admin-api/internal/v1/*`，校验 cookie、CSRF、Origin、当前用户与角色后，在服务端请求上下文内授权。原 `/internal/v1/*` 不因为携带 SSO cookie 获得管理权限。旧 SDK token、密码、飞书、VPN 接口及网络 lease 不改。
- 每个 BFF 请求记录原 `userId`、服务端生成的 requestId、method、path 和响应状态；不记录密码、cookie、授权码或响应体。现有领域审计仍保留，可通过新入口审计辨认个人操作者。
- `/auth/admin/logout` 只撤销当前 Launcher 浏览器会话，不退出 IdP、不退出其他应用、不踢 VPN。全局登出、IdP back-channel logout、单个绑定的自助解除/恢复、细粒度授权后续实现。IdP 单方面撤销会话尚不会立即撤销此处已建立的会话，因此本批不开放公网广泛注册。
- 跨服务器地址、Electron 的 file 页面、旧站点不自动携带个人凭据；请从目标服务器同源 `/admin/` 使用个人登录。原“连接与应急访问”的 Ops Token 路径保留；显式提供有效 Ops Token 的请求仍走旧路径。

### 配置与部署

缺省不启用。启用时必须使用 Postgres；错误配置只关闭新增 SSO 入口并输出不含凭据的告警，不中断旧登录与管理服务。配置示例见 `server/.env.example`：

```dotenv
MX_ADMIN_SSO_ENABLED=1
MX_ADMIN_SSO_ORIGIN=https://launcher.example.com
MX_ADMIN_SSO_ISSUER=https://accounts.example.com/realms/mx
MX_ADMIN_SSO_CLIENT_ID=mx-launcher-admin
MX_ADMIN_SSO_CLIENT_SECRET=<独立 OIDC 客户端密钥>
```

`ISSUER` 必须与发现文档精确一致，不填 discovery 文档 URL；`ORIGIN` 只能是 HTTPS origin，无路径/查询。IdP 登记精确回调 `https://launcher.example.com/auth/admin/callback`，启用 confidential client、client_secret_basic、标准授权码流程、PKCE S256、RS256，并支持 max_age/auth_time；禁用 wildcard callback、implicit/password grant。此客户端密钥不是 H2I 的飞书 App Secret，也不是 Ops Token。登录域名与管理域名可以不同，但管理 UI、`/auth/admin/*` 和 `/admin-api/*` 必须同源。

K8s Deployment 新增可选 `mx-launcher-admin-sso` Secret 引用。初次创建 Secret 后运行原 `ops internal-production deploy` 即会读入；后续 deploy 保留 Secret。没有此 Secret 的现有部署继续禁用 SSO。Secret 更新需要滚动部署后生效；不把明文配置文件提交到仓库。管理页新增 `admin-session.js`，已加入管理静态资源同步与桌面打包清单，不能只替换 renderer.js。

首次实际联调还需要明确：IdP 实例/issuer、Launcher HTTPS 入口、精确回调、独立 client ID/secret、受信代理跳数，以及仅对该管理入口开放的反向代理规则。不要为启用个人登录直接把整个 Internal 端口暴露到公网。

回退时将 SSO 设置为关闭并重部署；旧 Ops Token 入口仍可用。回退不删账户或映射，不撤销旧 SDK/VPN 凭据。若需要撤销所有试点会话，应仅删除相应 environment 下 `admin-sso-session` 和 `admin-sso-transaction` 记录，保留 `admin-sso-binding`。

### 本地验收与下一批

- `pnpm --dir server run test:admin-sso`：真实 HTTP OIDC 测试提供方、JWT 签名/PKCE/nonce/state、过期与回放、验证旧密码、绑定并发、CSRF、普通账号拒绝、停用/角色撤销、近期验证、旧 Ops 路径及真实 Nest/Express 上下文隔离。
- PostgreSQL 用独立回环测试库验证。显式设置 `MX_SSO_TEST_DATABASE_URL`，数据库名必须包含 `sso_test`；不读取生产 `DATABASE_URL`。验证多连接单次消费、绑定唯一性、重建连接后会话保留、闲置/绝对过期及退出后不复活。没有测试库时该数据库测试明确跳过。
- 原 SDK 密码/飞书相关 46 项、网络产品隔离 5 项、lease 身份 1 项回归通过。构建、类型检查、桌面 Ops Token 来源保护、资源打包及服务操作 UI 检查通过。
- 在 `127.0.0.1:18119` 隔离预览，以浏览器测试响应检查默认关闭/登录入口/关联表单/错误清空密码/无管理权限/退出等状态；1440×960 与 390×844 无脚本异常。页面用测试响应的验收不等于真实 IdP 的浏览器联调。

下一批先完成身份引擎与现有账号/密码的兼容适配及真实 HTTPS 试点，再实现邀请码/公开注册策略与 Hub 的幂等开通，随后接入 H2I 的飞书 Web 回调和已存在账号关联。Hub、Luopan、H2I 生产用户继续使用原路径，直到各自完成独立兼容验收。
