# 48 · Internal 统一认证接入应用管理

状态：本地实现与回归完成，尚未部署生产。

## 管理入口与边界

Launcher Internal → 平台设置 → 统一认证 → 接入应用。

管理员可以查看内网、公网 Auth 的现有应用，为新应用登记名称、appId、HTTPS origin 和 audience，预览固定回调并保存。系统沿用现有 Identity 主机档案与通用接入 SDK，不增加服务或数据库。

- 回调固定为应用 origin 下的 `/auth/sso/callback`，应用账号交互地址为 `/auth/sso/interaction`；Launcher 仍使用原 `/auth/admin/callback`。
- `form-action` 自动从 Auth 自身及已登记应用 origin 生成，界面只读。页面不接受原始 CSP、通配域名、任意回调路径、客户端密钥或主机文件路径。
- 新应用使用独立 clientId、clientSecret、sessionKey。管理页只返回元数据；应用后端档案保存在主机 `/var/lib/mx-launcher/identity/applications/{public|private}/{appId}.json`，由运维安全地提供给应用后端。
- 现有应用只读；不允许用新增操作覆盖、删除或更改已登记应用。Launcher、Hub、MX-H2I 保留各自已有接入方式。域名迁移、凭据轮换另行规划。
- 登记认证应用不会授予业务权限，也不会自动创建租户。应用仍负责自身角色、租户及业务授权。

## 保存与发布

1. 填写信息并校验，核对客户端 ID 和固定回调。
2. 保存应用：独立运维执行器使用现有 `/run/mx-launcher-deploy.lock`，增量更新 Identity 档案与应用接入档案。保存不会部署或重启。
3. 点击“前往 Launcher 发布”，进入已有“服务与部署”，预选 Launcher 的部署操作。继续使用原版本预检、影响确认、执行与持久化任务记录。
4. 发布后回到本页刷新，核对 Auth 加载状态，再完成应用后端 SDK 配置和实际登录验收。

首次上线此页面需先按原流程部署新版 Launcher，以同步浏览器资源、服务端代理和主机运维执行器。执行器更新继续遵循任务排空机制；尚在更新时保存会被拒绝。

发布走现有完整 Launcher 部署，不提供新的热加载机制。新应用保存后，旧部署预检计划会因 Identity 档案摘要变化而失效，须重新预检。Hub 和 MX Common 无需为管理页功能单独部署。

## 状态含义

| 状态 | 判定 |
| --- | --- |
| 待发布 | 已保存的应用配置尚未出现在 Auth 运行 Secret 中，或入口/客户端配置不一致 |
| Auth 已加载 | 应用配置与运行配置匹配，Deployment 对应同一配置摘要且完成滚动状态核验 |
| 待核实 | 配置已匹配，但工作负载尚未就绪或旧发布版本没有配置摘要注解 |
| 状态未知 | 无法读取 Auth 运行配置；不能按已发布处理 |

保存时间来自本机变更记录。运行实例启动时间来自同配置摘要的就绪 Pod；它不是业务登录验收时间。“Auth 已加载”不代表应用 DNS、证书、SDK 或业务权限已就绪。

## 飞书与 CSP 的区别

页面展示每个 Auth 入口的 `/identity/feishu/callback` 地址，供管理员在飞书开发者后台登记。飞书后台回调列表仍由飞书管理，Launcher 不会代其修改。

飞书是上游身份来源，Hub/Pay 等是 Auth 的接入应用。新增应用时，CSP 自动增加应用 origin；无需将飞书授权域名当作业务应用登记。飞书跨域授权沿用专门的导航中转页，不依赖放宽表单 CSP。此功能不修改原 MX-H2I 飞书凭据、组织限制、桌面本机回调、用户登录或联网实现。

## 保护与恢复

- 个人管理会话沿用 mx-admin、应用准入、CSRF 与写操作近期认证检查；旧 Internal Ops Token 路径仍受原鉴权保护。
- 服务端仅代理固定执行器路由。写入与 CLI/部署共用主机锁，同时拒绝执行器任务运行、更新排空和未核对任务期间的保存。
- 保存要求页面读取的档案 revision 一致；旧请求收到冲突后需刷新校验。
- `console-changes.json` 在主机私有目录保存有限的变更记录和写入意图。中途退出或响应丢失时，原请求可以重试完成保存，保留已经生成的客户端凭据。
- 应用接入档案与变更记录使用 0600 文件、0700 目录。已有 issuer、签名密钥、Cookie 密钥、Launcher/Hub 凭据保持原值。
- 页面不重置档案、不重建身份数据；档案缺失、损坏或目标配置冲突时停止，由运维核对备份。

## 验证

`server` 下运行 `pnpm run test:service-operations`、`pnpm run typecheck`、`pnpm run build`。Launcher 根目录运行 `node --test scripts/identity-console.test.mjs scripts/identity-app.test.mjs scripts/identity-deploy.test.mjs scripts/identity-public.test.mjs`。

浏览器回归使用真实 Launcher 页面、本地模拟 API 和临时 Identity 档案；设置 `MX_SSO_BROWSER_MODULE` 为 Playwright 模块后运行 `node --test desktop/scripts/identity-applications.browser.test.mjs`。覆盖导航、BFF/CSRF 请求、校验失败后草稿保留、保存与待发布状态、发布入口、亮暗主题和窄屏。不会连接生产账号或执行部署。
