# Twitter 账号标识兼容：19 位输入触发 username 长度限制

日期：2026-10-21（Asia/Shanghai）。状态：本地修复与验证完成，尚未部署。

## 原请求与证据边界

用户截图中的请求为 `d8ec86d0-8f18-4ee4-b24a-00baf448bc39`，业务上下文为 `data_query / search_crawl / twitter`，第一页、目标数量 500。截图记录 HTTP 400、`invalid_social_request`，详情为：

```json
{
  "platform": "twitter",
  "field": "username",
  "reason": "username_too_long",
  "actualLength": 19,
  "maxLength": 15
}
```

完整错误文字与 `server/contracts/hub-social.mjs` 的 `validateTwitterUsername` 一致。该校验由 Hub 生成；本次没有证据表明是供应商已经接收请求后拒绝。修复前的账号兼容正常化保留 `username/usernames` 字段类型，纯数字也仍按用户名校验；ID 别名中的纯数字才按 ID 处理。业务调用方不区分这些字段，因此一个通过 `username` 传入的 19 位数字字符串可以触发截图错误。

上述原因有代码依据，但截图没有原始请求体或账号值。`actualLength=19` 本身不能证明原字符串全为数字，也不能确认它属于有效账号。不得把构造的离线样例当作原请求参数。

本机 kubeconfig 只有 `docker-desktop`，没有已配置的生产集群或生产 SSH 主机。本轮没有读取生产数据库、容器日志或原请求快照；仓库与本地临时文件中没有找到该 UUID 的独立记录。因此当前结论来自用户截图和代码路径，未完成生产原请求取证。

## HTTP request_id 与业务记录

`social-account-delivery.mjs` 在构造账号计划时先正常化输入；`external-platforms/gateway.mjs` 的通用交付路径也在生成业务 UUID、调用 `usageStore.reserve` 之前执行正常化。按这条代码路径，用户名校验失败发生在当前尝试预留配额、生成供应商调用之前。

`app.mjs` 为 HTTP 请求建立独立 request ID；错误没有 `details.requestId` 时，响应顶层返回这个 HTTP ID。截图的详情没有业务 `requestId`，符合预校验失败的形式；不能仅用顶层 ID 假定一定存在同 UUID 的 `usage_requests` 记录。普通参数类 `AppError` 也不进入现有非预期错误日志分支。

如运维继续只读取证，应先用该 UUID 查询原请求记录和保留的 HTTP 日志，保存“未找到”与“查询失败”的区别。不应重新调用业务接口来制造证据，也不应把没有业务记录推广为此前同幂等键的请求从未派发。现有 Twitter 搜索对比脚本的参数投影和解释针对搜索/上游拒绝，不适合直接作为本次账号预校验事故的结论。

## 新请求的兼容规则

2026-10-21 核验的 X 官方定义区分两种标识：用户 ID 为字符串，模式 `^[0-9]{1,19}$`；用户名模式为 `^[A-Za-z0-9_]{1,15}$`，二者有不同的查询入口。来源：[Get Users by ID](https://docs.x.com/x-api/users/get-user-by-id)、[Get Users by Username](https://docs.x.com/x-api/users/get-user-by-username)。这些是标识规则依据，不表示本次把 Hub 供应商切换成直连 X 官方 API。

本次账号兼容修复应用于新发起的 Twitter `crawl` 和 `user-info` 请求：

| 输入 | 解释与处理 |
| --- | --- |
| 任一账号别名中的裸数字字符串，例如 `username: "1234567890123456789"` | 按用户 ID，验证 1–19 位，使用现有供应商的 ID 查询入口 |
| 含字母或下划线的账号字符串，例如 `userId: "example_user"` | 按用户名，保留 1–15 位及合法字符校验，使用用户名查询入口 |
| 显式 `@12345` 或合法 Twitter/X 个人主页 URL 的数字用户名 | 保留用户名含义；不会因去掉 `@` 或解析 URL 后只剩数字而变成 ID |
| 超过 19 位的裸数字、超过 15 位的用户名、非法字符 | 在派发前返回参数错误，不截断、不猜测账号、不自动换入口重试 |

ID 从输入、正常化到供应商参数始终保留字符串，避免 JavaScript 数值精度损失。数字用户名与数字 ID 均存在可表达的含义：裸数字采用业务兼容约定，明确的 `@` 或个人主页 URL 保留用户名意图。

## 历史、安全与发布边界

既有交付、未知结果、幂等键绑定及账务记录保持不可变。旧请求的精确回放和已签发游标保留原有身份含义；新规则不能把旧用户名任务静默改成 ID 任务，不能绕过原 unknown 或 in-progress 状态重新采购。身份解释变化时沿用现有历史校验和显式重启边界，不进行自动重试、历史修复或游标迁移。

本次只涉及 Hub Twitter 账号标识兼容。没有修改 MX-H2I 登录、用户联网、Launcher/Auth SSO、Pay 或共享基础设施；没有执行生产部署、数据库迁移或付费供应商验证。发布沿用正常 Hub 流程及 `MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0`，不把本地通过等同于生产已恢复。

## 验证

最终联合回归涵盖账号正常化、HTTP→gateway→adapter、供应商网关、分页、历史回执、策略搜索 UI/指南、公开文档、SSO 路由及 Launcher 客户端：269 项中 268 通过、0 失败、1 跳过。跳过项是需专用 PostgreSQL/OIDC 环境的真实 SSO 集成测试；本地 SSO 路由与客户端回归通过。

覆盖账号别名与批量别名、19 位字符串精度、20 位新请求拒绝、字母/下划线用户名、显式数字用户名、URL 身份和实际 ID 派发入口；历史回归覆盖两代旧解释、20/30 位旧 ID 的原样回放、游标身份绑定、unknown、过期 reserved 和无回执 released。历史解释发生变化的精确回执路径跳过通用维护清理，避免在只回放/阻塞时把过期预留状态改写；普通请求维护逻辑保持不变。

`npm run typecheck`、`npm run build`、`git diff --check` 通过，构建保留既有大 chunk 警告。静态 OpenAPI 与账号文档定向检查 3/3 通过。本地合成浏览器预览在 1440×1000 和 390×844 验证 Twitter 单输入框、19 位值原样提交、`@12345`、同请求幂等键、平台切换无自动请求和移动端无横向溢出；所有 API 使用内存 fixture，外部请求为零。

原请求参数仍未取得，没有生产回放或上线后验证结论。
