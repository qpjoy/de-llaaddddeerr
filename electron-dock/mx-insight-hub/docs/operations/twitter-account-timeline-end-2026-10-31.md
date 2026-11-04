# Twitter 账号内容：时间线到底按正常结束返回

日期：2026-10-31（Asia/Shanghai）。状态：本地实现，未部署。

## 现象

Delta 人物画像报「预期获取 500 条，实际获取 33 条；停止原因：hub_social_pagination_incomplete」，Hub 请求 `8c042908-78ce-4c85-9854-444e96fe3712`（`POST /api/v1/data/social/crawl`，`usernames=direcenergy`，`count=100`）。

## 证据

`scripts/inspect-social-account-request.sql` 的线上结果：

| 调用 | 帖子 | 续页游标（md5 前 8 位） |
| --- | --- | --- |
| `twitter-aio.user-info` | — | — |
| `twitter-aio.crawl` 第 1 页 | 20 | `75bc9d5d` |
| `twitter-aio.crawl` 第 2 页 | 12 | `052d85d3` |
| `twitter-aio.crawl` 第 3 页（用 `052d85d3` 请求） | 0 | `052d85d3` |

- 三页的 Bottom 游标都在 `TimelineAddEntries` 里，Hub 全部读到（`bottom_seen_by_hub = 1`），没有 `TimelineReplaceEntry`。
- 整个请求 9.4 秒，预算 180 秒；没有超时、限速或调用次数的停止警告。
- Hub 交付 32 条、`hasMore: false`，并附 `upstream_pagination_stopped`，状态 `partial`。

第 3 页只有游标、没有帖子，游标与请求的相同，这是 Twitter 时间线结束的返回。账号资料 `statuses_count = 922`，但 Hub 的 Twitter 账号内容只接了 `/user/{id}/tweets`（「帖子」页：原创和转推，不含回复）。该账号 2 个粉丝、13 个关注，很可能多数是回复，Hub 不能核实。

## 修改

`server/external-platforms/social-account-workflow.mjs`：上游返回空页且续页游标与本次请求相同（`stopReason = repeated_cursor` 且本页 0 行）时，按时间线结束处理，不再附加 `upstream_pagination_stopped`，交付状态为 `ok`。`hasMore`、字段、HTTP 状态、计费和调用次数不变。

仍保留警告的情况：游标重复但本页有数据（异常停滞），以及其他 `stopReason`。YouTube 评论的 `continuation_unproven` 不受影响。

## 验证

- `tests/server/social-account-workflow.test.mjs` 新增「空页重复自身游标按正常结束」，撤掉修改时该用例失败；原有「重复游标但有数据仍警告」用例不变。文件 47 项通过。
- 社交、Twitter、YouTube 评论相关 55 个测试文件：553 通过、60 跳过、10 失败；10 项失败在撤掉修改后同样出现（`social-accounts-gateway` 电商额度文案、`twitter-search-diagnostic-bundle` 诊断包、`twitter-strategy-ui` 表单），与本次无关。

## 发布

按既有 Hub 部署命令发布，不需要数据库迁移，不影响 MX-H2I 登录与联网。已保存的历史响应不变；重放旧请求仍返回原来的 `partial` 和警告。
