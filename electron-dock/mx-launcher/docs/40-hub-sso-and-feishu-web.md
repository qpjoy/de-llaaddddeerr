# Hub SSO、自动开户与飞书 Web 绑定

状态：2026-10-03 本地实现与隔离验收；没有操作生产服务，也未验证真实飞书租户或公网入口。本页更新 39 的后续实施状态，旧登录入口仍保留。

## 本批交付

- MX-H2I 将 `app_access_denied` / `launcher_product_user_access_denied` 视为终止状态：停止此次登录、自动恢复、系统代理刷新和后续 H2O 初始化；持久化禁止标记，重启不会再按网络故障重试。界面显示「账号访问已被禁止」并允许更换账号，不再显示恢复面板。成功的新登录重新建立正常状态。
- 此改动需要发布新的 **H2I 客户端/ASAR**。只 deploy Launcher 服务端能拒绝准入，但不能改变旧客户端的恢复界面。未修改实际 Luopan 产品，不全局重启 VPN，不删除原健康隧道。已建立 peer 的立即强制下线是另一项产品网络操作，不由本次拒绝登录触发。
- Identity 新增静态登记的 Hub OIDC 客户端；Launcher 管理客户端、原 issuer、签名密钥、CA 和客户端密钥保持原值。
- Hub 新增 Code + PKCE 登录、切换账号、退出与 HttpOnly 浏览器会话。ID Token 的签名/issuer/audience、state、nonce、精确回调及 UserInfo subject 都校验。OIDC Token 不交给前端、不存 localStorage。服务端会话与事务存入 Hub PostgreSQL，凭据加密，ID 以摘要索引，重启可恢复。
- 飞书 Web 授权复用 Internal 已有 Feishu App ID/Secret 和允许的 tenant_key；新 Web 回调不加入或替换 Electron SDK 回调列表。Web 身份验证不执行 SDK 的 H2I/H2O 自动开通逻辑。

## 原成员与租户的连续性

Identity 通过受信任 HTTPS UserInfo 返回原 `mx-user-center:<environment>`、`user:<userId>` 和 Hub 原 audience。Hub 必须与集中配置完全匹配，并确认 `userId` 与 OIDC 已验证的 subject 相同。

Hub 在同一数据库事务内先查原身份绑定，再登记新 OIDC issuer/subject/client 绑定。旧 member ID、tenant ID、membership、Key、consumer、钱包和余额均保留，不按邮箱、姓名或组织名称匹配。身份冲突、成员停用时停止自动开户。

首次进入 Hub 且从未建立原成员的新用户，默认创建一个个人空间和 owner membership。**不创建 API Key、服务授权、试用额度、充值或赠金**；钱包沿用 Hub 原有的零余额初始化逻辑。开户和绑定同事务，原登录与 SSO 的首次创建使用同一身份锁；失败重试不会重复开户。

已有成员即使目前没有租户，也不会被自动补一个空间，更不会恢复已撤销的 membership。这包括以前已登录过 Hub 的 `ssotest`；该账号仍应由 Hub 管理员明确分配租户。平台管理员角色继续使用原有的 Launcher scope allowlist。

SSO 会话每次读取 Hub 本地权限；Identity 状态/应用明确禁止的正向缓存最多 30 秒，会话最多 8 小时。Identity 不可达时拒绝受保护操作并保留会话供重试；原 Hub Admin Token 不依赖 Identity。客户端显式提交的坏 Token 不会回退到 Cookie 会话。

## 飞书登录和绑定

登录页在已有飞书配置可用时显示「使用飞书登录」和「绑定飞书到已有 MX 账号」。

1. 已绑定：验证飞书 tenant_key/open_id 后使用原 userId 登录；仍检查当前账号状态与应用禁用。
2. 未绑定：先完成飞书 OAuth 验证，再验证现有 MX 账号密码后绑定；或使用同一邀请码/开放注册策略创建并绑定账号。邀请码消费、建号、飞书绑定原子提交。
3. 已绑定其他账号：明确提示冲突，不覆盖另一账号、不合并权限或租户。两个已经各自有数据的账号归并，需要独立的资产和权限迁移流程；本批没有静默合并。

OAuth 使用一次性 state、浏览器绑定 Cookie、PKCE 和持久事务；失败/重放不创建用户。绑定要求双方身份验证，不接受邮箱相同作为依据。当前绑定已有 MX 账号需要其本地密码；不在此流程中替用户重置密码。

在复用的飞书应用开发者后台登记 **新的** 重定向 URL，保留所有原 H2I 回调：

```text
https://10.88.88.88:18443/identity/feishu/callback
```

这是当前私网身份地址对应的回调。实际飞书平台是否接受该入口、用户浏览器的证书信任和授权范围，需要用真实租户验收。参考[飞书授权码接口](https://open.feishu.cn/document/common-capabilities/sso/api/obtain-oauth-code)与[用户 Token 接口](https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token)。本地测试使用受控上游响应，不代表真实飞书已接通。

## 集中配置与部署

前提：已有托管 Identity，并确定 **Hub 管理/用户页面的 HTTPS origin**（SPA 与 BFF 同源，回调固定为 `/auth/sso/callback`）。现有 HTTP Hub 账号密码入口可以继续使用，但不能作为 Secure Cookie SSO 的回调。

在 Launcher 根目录一次性登记，替换示例为实际 Hub HTTPS 地址：

```bash
bash scripts/manage.sh ops identity hub https://hub.example.com
```

此命令在同一个生产部署锁内执行，只登记配置，不执行 Hub/Launcher 重启。读取既有环境和 audience，生成并持久保存客户端密钥、Hub 会话密钥及 CA。重复执行相同地址不会轮换密钥；地址、issuer、audience 或已有密钥不一致时停止覆盖。

随后依次执行已有 **Launcher deploy**、**Hub deploy** 命令（原代理、TMPDIR、Kubernetes 主机参数沿用）。不增加逐项环境变量开关。Launcher 部署发布新客户端配置；Hub 部署导入可选的 SSO Secret，并在原迁移流程中运行 `124_browser_sso.sql`。未配置 SSO 的 Hub 部署保持旧登录。

配置位置：

| 系统 | 持久来源 | 运行时 |
| --- | --- | --- |
| Identity | `/var/lib/mx-launcher/identity/profile.json` | `mx-identity-runtime` Secret + Launcher PostgreSQL |
| Hub SSO | `mx-insight-hub/secrets/identity/profile.json` | `mx-insight-hub-browser-sso` Secret + Hub PostgreSQL `iam.browser_sso_records` |

主机文件按私有权限保存，不写入镜像或 Git。Hub Secret 只挂载到 Admin/BFF Pod，不挂载公共数据 API/worker。新表只有有期限的会话/登录事务，写入时分批清理过期记录，不会随每次 deploy 生成新用户、租户或永久会话记录。

换服务器必须恢复 **两个身份配置文件、Launcher 数据库、Hub 数据库及原应用数据**，再运行部署。只备份镜像不够；丢失会话加密密钥无法恢复旧浏览器会话，丢失身份签名/CA/客户端密钥更不能通过重新初始化替代。Launcher 原恢复检查保护核心密钥；新增客户端允许追加，旧备份不能移除已经部署的客户端。

## 公网边界

Launcher 管理台和运维 API 可以继续只在内网。公网 Hub 的浏览器必须能访问它所信任的 Identity 登录地址；仅开放 Hub 不能使 `10.88.88.88` 对公网浏览器可达。

第一阶段先接入私网 Identity。后续已确定 Auth/Launcher/Hub 域名，并实现独立公网入口、集中配置与证书运维，见 [41 · 公网 Identity 与集中证书运维](41-public-identity-and-certificates.md)。仍不能把当前 18443 整体反代出去或直接改原私网 issuer；公网部署和真实飞书验收尚未执行。

## 验收依据

- H2I 完整 `pnpm check`：密码/飞书成功路径保留；明确拒绝、重启后的停止标记、恢复/H2O/代理短路及恢复面板隐藏。
- Launcher Server typecheck/build，旧 SDK 密码/飞书与限流回归；独立 Web proof 不建 H2I 用户、不签发 SDK token。
- 真实 HTTPS/OIDC + 临时 PostgreSQL：旧成员/租户/角色复用、并发首次开户、同名不合并、Cookie CSRF、回调重放、进程重建后会话、当前应用禁用、退出。
- PostgreSQL 注册/绑定：双方校验、冲突拒绝、并发唯一绑定、邀请名额原子提交、原短密码兼容及权限保持。
- Hub 原登录与权限、Admin/Public 路由隔离、坏显式凭证不借用 Cookie；原管理令牌应急入口独立。
- 配置重复登记、私有文件权限、旧密钥保持、配置缺失不启用、旧档案不删除已登记应用；shell 语法、Hub typecheck/build。
- 现有 Playwright + Chrome：统一登录、注册、飞书绑定、Hub SSO 入口的桌面/390px 布局，以及 H2I 禁止后无恢复面板。Browser plugin 不可用；浏览器 UI 测试分别使用真实本地身份服务与隔离界面响应。

真实飞书用户、客户设备、线上发布中断时长和公网联通性仍需部署后验收。本地通过不等同于线上已部署。
