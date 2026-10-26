# Luopan 用户更新投放与可选登录限制

2026-10-26。代码实现与本地验证；未部署生产，未对实际客户账号设置限制，也未用客户已安装的旧二进制做验收。

## 用户中心操作

Internal → 用户中心 → 编辑已有用户 →「罗盘更新与登录」。

- 「停止 Luopan 后续更新」默认关闭；开启后停止向能够识别的旧版安装投放新版。用户当前版本、登录、业务权限及网络保持正常。
- 「同时禁止 Luopan 登录」独立控制，默认关闭，已有禁止按实际状态回显。省略此字段保留原值；恢复更新不会同时解除登录禁用。
- 备注、策略状态、操作者、时间及安装关联情况仅供管理员查看。
- 此区域单独保存。普通「Save User」保留服务端当前 Luopan 登录设置，不会用旧表单覆盖刚保存的控制。
- 「已关联 N 个安装」只证明有效租约可唯一关联；没有证据时显示「尚未确认覆盖」，不承诺全部历史版本已受控。

## 兼容已经发布的旧客户端

正式 Luopan 的更新请求包含 `installId`，但其 `userId` 是 Java 本地业务账号 ID，不能直接当作 MX 用户 ID。

Release Center 选中 Luopan 发布计划后，按环境、`productId=luopan`、`installId` 查询服务端租约。仅当有效、未过期的租约唯一指向一个 MX 用户，且同一安装没有有效匿名租约时，才读取该用户的更新策略。多用户冲突、过期、缺失或无效身份不猜测关联；不按同名账号、同一公网 IP 或客户端自报的业务 ID 匹配。

限制命中时从本次决策中移除所有 Luopan 计划，再使用原发布决策逻辑。返回 HTTP 200、原 `up-to-date` 协议、空制品列表、空发布说明和正常签名；不返回限制字段、备注、403 或新错误码。旧客户端无需先升级，也不需要识别新的拒绝状态，沿用各版本原有的“无更新”显示。服务端不能远程修改旧版客户端的具体文案。

判断以服务端发布计划的产品归属为准，不依赖请求 `productId`；pre-V2 无产品字段的计划按既有 `luopan`/`luopan-*` 组件命名空间识别，并兼容历史发布写入器将 renderer 计划归属回填为 `luopan-renderer` 的情况。MX-H2I 的发布决策不查询此策略。

这是旧版正常更新流程的分发控制，不是新的下载凭据协议。以下情况不在本次保证范围内：

- 匿名公共更新文件、没有安装身份的版本历史请求、公开制品直链与外部转交的安装包。
- 已保存的更新决策、已下载或已暂存的包，或已交给操作系统的安装。
- 伪造安装 ID 的客户端、缺少唯一租约关联的旧版、一个安装在多个用户之间共享二进制的情况。

上线前必须取实际已发布版本验证请求字段、有效租约关联、自动/手动检查的普通无更新行为；当前源代码不能代替旧安装包的证据。

## 存储与管理 API

沿用 Launcher 数据库 `mx_platform_records`，新增独立 `user-app-update-policy` 记录，按环境、应用、MX 用户隔离。无需新数据库或迁移表。字段包括 `updatesBlocked/reason/revision/updatedBy/updatedAt`，无记录默认为允许、revision 0。

管理 API（现有个人管理 SSO/CSRF/近期验证或 Internal Ops Token）：

- `GET /internal/v1/user-center/users/{userId}/luopan-controls`
- `POST /internal/v1/user-center/users/{userId}/luopan-controls`

POST 必须带严格 boolean `updatesBlocked` 和整数 `expectedRevision`；可带 `reason` 与独立 boolean `loginBlocked`。并发修改返回409，刷新核对后重新保存。更新策略、可选应用禁止和审计在原账号写锁内原子提交，并锁定用户行以协调并发删除；操作人取已验证的管理上下文，不信任表单自报名字。GET/POST 均 `no-store`。

更新投放检查的身份关联和策略命中仅进入 Internal 审计，不加入客户端响应。策略不加入公开用户 DTO，不修改 `user.status`、密码、角色、token、SSO session、网络 lease 或 peer。

## 可选登录禁止

显式设置 `loginBlocked` 时只增删该用户 `appAccess.deniedAppIds` 的 `luopan`，保留其他应用。

正式 Luopan Java 后端新增登录携带 `appId=luopan`；存量通用 token 的受保护请求使用现有 `/internal/v1/sdk/gateway/access/evaluate`，服务端固定 `appId=luopan` 与身份读取路由，确认返回主体和应用准入。浏览器、HTTPS Electron 与原客户端无需更新前端。

Java 继续保留本地业务账号、资料与 MX 关联。明确拒绝清除其 token 检查缓存；成功缓存为原30秒，认证服务不可用时仍有原120秒宽限，因此不承诺故障时30秒内撤销。全局通用 token 和 MX-H2I 专属 token 不被批量撤销。

既有应用禁止还会拒绝 Luopan 后续用户网络申请、快照和 peer 同步；不是立即移除已建立 peer 的操作。MX-H2I 的用户登录、飞书、联网与资源 ownership 不变。

## 发布顺序与验收

1. 发布 Launcher 服务端及其 Admin 静态资源；无需发布 MX-H2I 或 Luopan 客户端。
2. 如需启用可选登录禁止，发布 `po-backend-java` 的应用准入检查，覆盖旧 token 与独立业务入口。
3. 用测试账号及真实旧版 Luopan 验证：更新前可发现版本 → 仅停止更新后无新版提示但登录/业务/网络正常 → 恢复后再次发现版本。
4. 同一账号回归 MX-H2I 密码/飞书登录、已有联网和续租；对其他 Luopan 用户确认正常投放。
5. 单独验证登录禁止与解除，检查已登录会话、Java 缓存时效及不影响其他应用。

本地测试覆盖正常无更新响应、伪造/缺省业务用户 ID、pre-V2/renderer 计划、匿名/过期/冲突身份、解除限制、权限鉴别、并发修订冲突及更新限制不改变用户/token/网络。PostgreSQL 用例只允许显式回环测试库；未配置时明确跳过。Java 测试使用受控 HTTP 上游，不代表生产已发布。
