# TikTok 账号请求无可交付数据的公共响应

日期：2026-11-20。状态：按用户要求更新本地公共契约；尚无此改动的部署或线上恢复回执。

## 已有证据与未确认项

用户截图中的 Hub 请求为 `802f613f-b148-47f9-8452-4f4792f7d0d7`，最终公开响应为 502。截图列出两次 TikHub 调用：

| 操作 | 本地登记用途与上游路径 | 截图中的结果 | 上游 request ID |
| --- | --- | --- | --- |
| `native.t.api_6db5411ea5e8c547` | 获取指定用户的信息；`GET /api/v1/tiktok/app/v3/handler_user_profile` | HTTP 200、业务码 200、`succeeded` | `398b1760-3b7b-4a26-9f27-c713bd830137` |
| `native.t.api_14b996eaa970430d` | 获取用户主页作品数据 V1；`GET /api/v1/tiktok/app/v3/fetch_user_post_videos` | HTTP 200、业务码 200、`succeeded_unusable`、`invalid_social_contract` | `0cefa366-649c-4d33-8dc0-fd609a09b145` |

两个操作均登记为 TikTok App V3 路线，契约版本为 `hub-provider-docs.2026-09-27`。标准 TikTok 账号内容工作流先解析账号资料，再以解析后的账号标识请求作品；作品操作支持 `sec_user_id` / `unique_id`、`max_cursor`、`count` 等参数。第二次错误发生在作品接口，不能仅据此解释为账号不存在。

现有截图没有给出原始请求快照、归档字节数/SHA256 或响应正文，因此尚不能确定本次是空作品集合、缺少已知集合字段、条目缺少稳定身份，还是其他格式不兼容。两次调用与具体账号、批量子任务及分页的关联仍应以原请求和调用序号核验。HTTP 与业务码均为 200 也不证明正文含可交付作品。

既有作品解析器接受 `aweme_list`、`itemList`、`item_list` 或 `items` 数组；缺少已识别集合、无损身份校验失败、矛盾分页信息等可触发 `invalid_social_contract`。另一 TikTok 关键词搜索接口已校准的 `search_nil_info` 空页形状，不是本次账号作品接口的无数据证据，不能直接套用。

## 新的公共响应约定

用户要求下游统一处理“此次没有取得所需数据”。标准账号 `POST /api/v1/data/social/user-info` 和 `POST /api/v1/data/social/crawl` 的首次请求，在上游返回 HTTP 200、但没有可交付数据时，公共响应使用 HTTP 404、`social_account_not_found`，并以 `error.details.reason: "social_data_not_found"` 表明这是交付结果。此约定包括首次请求确认已完成且无后续页的合法空集合，以及未形成任何可交付结果的 `invalid_social_contract` 投影失败。

```json
{
  "error": {
    "code": "social_account_not_found",
    "details": {
      "platform": "tiktok",
      "stage": "data_acquisition",
      "reason": "social_data_not_found",
      "outcome": "succeeded_unusable",
      "retryable": false
    }
  },
  "requestId": "本次新请求标识"
}
```

示例只列本规则的关键字段，表示作品投影失败的公共响应。`stage` 在账号解析阶段为 `account_lookup`，数据采集阶段为 `data_acquisition`；`outcome` 保留实际分类，投影失败为 `succeeded_unusable`，合法空集合为 `succeeded`。`social_data_not_found` 是 `details.reason`，不新增顶层错误码。404 表示此次没有取得可交付数据，既不证明账号永久不存在，也不把格式不兼容解释为供应商已确认账号不存在。`crawl` 仅成功取得账号资料，仍不等于已经交付其所请求的作品内容。

边界如下：

- 空集合的 404 要求首次请求没有历史页、缓冲内容或任何子任务已取得的行，全部子任务已完成且没有中途停止。空页仍有可继续游标时保留 200；续页和已取得内容的请求沿用原有的错误或部分成功规则，不增加新的批量逐项部分成功协议。例如 TikTok 已取得部分内容后再发生投影失败，仍可按原规则返回 502，不保证将已有条目作为成功结果交付。
- 已有明确账号未找到信号继续使用 `social_account_not_found`；明确被封、受保护等已有账号不可用分类保留原语义，不用此规则覆盖。
- 权限、余额、限流、未派发、非 200 上游拒绝、超时或结果未知继续按各自错误处理；不能把未知结果当成已知无数据。
- 本规则只调整标准账号接口的公共交付结果。关键词内容搜索、单帖、评论以及原生透传不套用此规则。
- 供应商原 HTTP/业务码、`outcome`、`errorCode`、归档正文和费用证据保持原值。例如本次截图中的 `succeeded_unusable` / `invalid_social_contract` 不因公共 404 被改写为供应商拒绝。
- 本规则不增加供应商调用、自动重试、切换渠道或账号探测。404 本身不证明未产生采购或客户费用，须按原请求账本核对。

本约定扩展了[当日较早的账号未找到统一规则](social-account-not-found-2026-11-20.md)：其中首次合法空页保持 200、首次投影失败保持 502 的旧公共行为，由这里的新约定覆盖；续页和部分成功的边界保留。

## 原请求诊断与发布边界

若继续定位本次供应商正文，应只读核验原请求所属 tenant/consumer/Key、原始操作和分页状态，以及两次调用的精确身份与序号；再核验对应归档长度与 SHA256。需要的最小正文信息是集合字段的存在性/类型/长度、分页字段及明确业务错误字段；如集合非空，再检查失败条目的身份字段类型。无需为识别这份旧回执重新采购。

原请求已保存的 502、幂等重放、供应商结果和历史账单保持不变。新规则只影响发布后按新代码处理的新请求，不迁移或重算旧记录。仅回放 `802f613f-b148-47f9-8452-4f4792f7d0d7` 不能验证新公共状态码。

本记录不声明已确认该账号不存在、已修复供应商格式或已恢复线上业务。本次工作未调用付费上游，不更改 MX-H2I 登录、联网、SSO 或供应商路由。部署后以明确发起的新请求及其回执验收。

## 本地验证

账号工作流及 Threads 回归共 71 项通过；状态存储和事务相关测试共 44 项通过，包括本地 PGlite 数据库事务路径。类型检查通过。标准账号的动态接口描述、HTML 指南与静态 OpenAPI 两处 404 已同步，并通过定向一致性和 diff 格式检查。

更广泛的测试运行仍有 3 项与本改动无关的失败：公开路径清单缺少 6 个 email-directory 接口、静态镜像测试所需的 `python3` 无法启动，以及旧 `searchAccounts` capacity `reasonCode` 断言不符。本记录不宣称全套测试通过；上述本地结果也不代替生产部署和新请求验收。
