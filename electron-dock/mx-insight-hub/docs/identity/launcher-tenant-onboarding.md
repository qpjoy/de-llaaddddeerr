# Launcher 身份与 Hub 租户

## 当前可用的绑定流程

1. 在 MX Launcher 用户中心建立普通用户。服务器接口为 `POST /internal/v1/user-center/users`，使用 Launcher 自己的内部运维令牌；支持 account/username、displayName、email、password、roleIds、orgIds 等字段。不要赋予 Hub 平台管理员 scope 来代替租户成员绑定。
2. 用户在 Hub 登录页用 Launcher 账号密码登录一次。Hub 向 Launcher 验证，以 issuer + subject 建立 Hub member。首次验证不自动创建租户、不自动授权。
3. Hub 平台管理员在「调用者 → 登录成员与租户绑定」刷新成员，核对成员 ID，选择 Hub 租户与角色，保存绑定。成员显示名不作为绑定主键。
4. 用户刷新 Hub 页面，自己的「我的访问」视图依据 Hub membership 展示租户、调用者和授权。一个用户可以加入多个租户；一个租户可以有多个成员。普通成员不能看管理员跨租户数据产品演示。
5. Hub 的调用者属于租户，API Key 属于调用者。撤销 Key 不等于停用调用者或解绑用户，也不应自动删除调用者。Key 历史和用量仍可审计。

密码由 Launcher 管理，Hub 不复制密码。Launcher 已有管理员重设密码接口 `POST /internal/v1/user-center/users/:userId/password`；这不代表已经具备邮件找回密码流程。

## 现状与下一阶段设计

现有绑定、租户、角色、API Key 与业务数据都由 Hub 自己保存。数据 API 请求不依赖 Launcher。当前控制台仍使用 Launcher opaque token 并进行短缓存的在线 introspection，缓存默认 30 秒；Launcher 中断会影响缓存过期后的控制台会话。这次没有把现有登录替换为永不过期会话。

建议长期保留身份绑定，但登录状态采用 Hub 自有可撤销会话：

- 首次登录在 Launcher 验证后，Hub 签发自己的随机会话和轮换 refresh token，仅在数据库中存令牌哈希；浏览器使用 HttpOnly/Secure cookie，并为状态变更实施 CSRF 防护。
- 建议会话空闲期限 7 天、绝对期限 30 天。有效 Hub 会话访问普通数据只检查本地成员、租户、角色和撤销状态；不逐次访问 Launcher。权限不得固化在长期令牌中。
- 新增/轮换 API Key、修改身份、成员授权及账户恢复要求最近 5 分钟的重新验证。Launcher 不可用时保留有效会话的普通读取，敏感操作暂不可用。
- 提供 Hub 本地撤销全部设备、成员停用、设备会话列表；通过事件同步 Launcher 的账户禁用信号。无法同步时以会话绝对期限限制风险。
- 会话到期、用户主动退出或换设备后须重新登录。绑定永久保存不等于某个浏览器永久取得身份。管理员紧急通道保持独立。

这样即使 Launcher 暂时故障，Hub API Key 业务调用和有效 Hub 本地会话仍可继续；同时可以撤销失窃设备。该会话迁移需要独立 schema、刷新令牌竞争/重放测试、撤销与敏感操作校验，不能仅延长 introspection 缓存冒充离线认证。
