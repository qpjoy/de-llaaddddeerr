# Twitter 账号自动识别与手动查询方式

日期：2026-10-30（Asia/Shanghai）。状态：本地实现，未部署。

## 问题与修改

策略搜索的账号资料/账号内容工作台已提供 Twitter 单输入框，但隐藏了原来的账号字段选择。用户要求保留自动识别，同时允许手动指定参数，并确保 `1952056883877212160` 这样的 19 位 ID 不被当成超过 15 位的用户名。

当前后端 `normalizeHubSocialCompatRequest` 已在 username/ID 别名中把纯数字识别为 ID（见 10 月 21 日修复），本次保留该合同和历史回放行为。前端自动模式改为明确发出 `userId` 字符串，用户名则发出 `username`，不做 Number 转换。用户名是账号 handle，不是显示昵称。

新增「账号查询方式」下拉框，默认自动识别：

| 方式 | 请求与校验 |
|---|---|
| 自动识别 | 纯数字 → userId（1–19 位）；其他文本 → username（去 @ 后 1–15 位英文字母、数字、下划线） |
| username | 强制用户名；纯数字值自动加 @，使后端按用户名解释 |
| userId / user_id / uid | 原样使用所选 ID 字段；只接受 1–19 位数字 |
| url | 通过 url 提交 Twitter/X 账号主页链接 |

账号资料与账号内容复用同一逻辑。切换方式、平台或业务接口不发请求；下一页使用原请求参数与返回游标、新幂等键。相同参数仍重放原请求；未知结果仍锁定原平台的输入及方式。

从接口调试/历史回执/未完成请求恢复时，显示「原请求参数」，保留原字段和值，包括历史 username 数字值或 user_id 非数字别名。不能在渲染时悄悄把原请求改成另一个付费意图。用户主动选择其他方式后才应用新解释。

批量账号、活动类型及其他支持参数仍可在接口调试中提交。内容关键词搜索原有类别、filters 和时间戳选项保留。

## 验证与边界

- 115 项定向测试通过：strategy-search-experience、strategy-search-interaction、hub-social-compat、social-account-workflow、hub-social、social-accounts-http。
- HTTP 回归使用给定 ID，确认 username 输入兼容路由到 `/user/users/by/ids`、内容查询路由到 `/user/1952056883877212160/tweets`，不经 Night-All；模拟供应商的帖子及 author ID 被完整交付。
- `npm run typecheck`、`npm run build` 通过；构建仍提示既有大 chunk 警告。
- Chrome + Playwright 浏览器验证通过（Browser plugin not available）：1440×1100 与 390×844；真实页面路由与标题、非空渲染、无框架错误覆盖、控制台无错误、移动端无横向溢出。验证自动长 ID、手动 numeric username/user_id、原键重放、资料/内容切换及下一页新键；6 次请求全部由本地 fixture 接收，外部网络请求为零。截图位于 `/tmp/hub-twitter-routing-desktop.png` 与 `/tmp/hub-twitter-routing-mobile.png`，不入仓库。
- 无数据库迁移、无 Delta 修改、无生产部署或真实供应商调用。测试证明请求路由与响应处理，不能证明该账号当前在线存在、可访问或一定有帖子。
- 不修改 Launcher、MX-H2I 登录、SSO、WireGuard、DNS、联网配置、授权、计费或供应商选路策略。
