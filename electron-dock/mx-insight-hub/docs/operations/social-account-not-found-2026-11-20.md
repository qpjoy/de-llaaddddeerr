# 账号未找到响应统一

日期：2026-11-20。状态：本地修复与契约更新，未取得部署或线上恢复回执。

## 原请求证据

Hub 请求 `50fc80de-7cc1-4b1b-8426-8ca84bf88afc` 为 `committed`，公开响应 502，记录错误为 `invalid_social_contract`。唯一供应商调用 `f4c7cab4-5124-426f-b2f6-7268a5cbc534` 使用 RapidAPI 的 `native.r.threads_scraper_user_posts`，对应账号帖子读取 `GET /api/v1/users/posts`，不是关键词帖子搜索。

供应商返回 HTTP 200，调用结果为 `succeeded_unusable`，普通归档与受限原始归档均存在。操作者核验的完整原始正文为 88 字节，SHA256 为 `4ee7b883bbb9aab92b5dfab4ec1d59ea9b536c219442c253c61c2888ab0f0e71`。结构报告确认根层 `status: "ok"`、`data: { "user": null }`，另有一个未输出值的根层字段，`data` 没有其他字段。正文没有 `posts` 数组，旧账号帖子投影因此失败。

供应商 `billed` 为 null，采购估价为 1 个最小货币单位；客户账单记录已捕获 1 个最小货币单位。估价不证明供应商实际扣费，错误码调整也不修改这笔历史结算。

用户补充的账号标识为 `demo` 和 `whyyoutouzhele`。现有证据不足以判断它们来自同一批量请求还是两次独立请求，也不足以把该调用归属到其中一个账号。不得仅凭一条供应商调用推断另一个账号的结果。此事故也不能套用 2026-11-14 另一请求的 DNS 故障结论。

## 统一公共契约

用户要求账号资料和账号内容接口对明确的账号查找失败使用统一机器码，便于下游处理。新标准 `user-info` / `crawl` 请求按平台已确认的未找到账号信号返回 HTTP 404、`social_account_not_found`，并提供：

```json
{
  "error": {
    "code": "social_account_not_found",
    "details": {
      "platform": "threads",
      "stage": "account_lookup",
      "outcome": "rejected",
      "retryable": false
    }
  },
  "requestId": "本次请求标识"
}
```

`platform` 使用实际目标平台，`outcome` 保留该调用的实际分类。上例为 Threads；Threads/Twitter 新未找到结果为 `rejected`，旧小红书专用接口的既有 `succeeded_unusable` 保持不变。404 表示本次按该平台契约未取得目标账号，不宣称账号永久不存在。上例只列稳定错误字段，实际响应另有说明文本。

| 已确认信号 | 新请求公共结果 |
| --- | --- |
| Threads Scraper `user_detail` / `user_posts` 返回 `status: "ok"`、`data.user: null`，且没有矛盾的帖子内容 | 404 `social_account_not_found` |
| Twitter AIO 已有明确未找到信号，包括 `userExists: false` 的已校准空资料 envelope，以及 `UserUnavailable` 的 `NotFound` / `not_found` | 404 `social_account_not_found` |
| Twitter 明确返回 suspended / protected / deactivated / deleted / unavailable | 保持 422 `social_account_unavailable`，保留已知 reason |
| 旧小红书账号查找已经分类为 `upstream_user_unavailable` | 原公开码 `user_not_found` 统一为 `social_account_not_found`；details 使用 `platform: "xiaohongshu"`、`stage: "account_lookup"`、原调用 `outcome: "succeeded_unusable"`、`retryable: false`，原供应商判定与计费证据保持 |
| 合法 `posts: []`，或账号存在但本页没有内容 | 保持 200；分页依原契约解释 |
| 缺少字段、畸形资料、冲突身份、权限错误、超时、未知结果 | 保持对应错误；不得仅因未得到资料改成 404 |

统一公共码不表示所有平台的任意空值都具有相同语义。只有已确认的平台契约信号参与分类；搜索候选页没有命中不证明平台上永久不存在该账号，无法唯一确定的候选仍保持歧义错误。

批量仍按既有顺序执行。遇到未找到账号后整请求返回 404，后续账号不再派发，不新增逐项部分成功或额外账号探测。Twitter 裸数字账号的既有 ID / 同名用户名查找规则保留，不为其他场景新增自动重试或供应商切换。

## 历史与发布边界

已保存的 200 空资料、502、供应商回执、归档正文和客户账单保持原值；同一幂等键仍回放原响应。原生透传接口继续返回其来源协议，不套用标准账号接口的公共错误分类。

本次不需要数据库迁移，不更改 MX-H2I 登录、联网、SSO、供应商路由或历史结算。需要在 Hub 发布后用明确发起的新请求验证公共契约；仅重放原请求不能证明新规则生效。此文档不构成已部署、供应商健康或业务恢复的证明。

## 本地验证与发布命令

13 个相关测试文件共 170 项：169 通过、1 项依赖真实 PostgreSQL 的既有测试跳过。覆盖 Threads 资料/帖子真实本地 HTTP 404、单次采购、批量停止、空帖子 200、原生接口、分页、归档字节/SHA、旧 502 和新 404 精确回放；同时覆盖 Twitter 与小红书账号行为。类型检查和 diff 格式检查通过，未发起真实供应商调用。

两项相关公开文档内容测试及动态/静态 404 枚举校验通过。完整文档检查另有两个独立障碍：既有路径总清单少列 6 个 email/phone/twitter-user-email 接口，完整静态镜像测试在本机启动 `python3` 返回 `EACCES`；本次未扩展修改这些项目。

同步完整 Hub 改动到服务器，包含新增 `server/contracts/social-account-not-found.mjs`，然后在服务器的 `electron-dock/mx-insight-hub` 目录执行：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh deploy
```

这两个开关关闭 Launcher 联动和真实数据 smoke；现有 Hub 部署脚本仍执行正常的 Hub 发布流程。发布后用一次新请求验证 404 契约，记录新 requestId；原请求仍按原收据返回 502。
