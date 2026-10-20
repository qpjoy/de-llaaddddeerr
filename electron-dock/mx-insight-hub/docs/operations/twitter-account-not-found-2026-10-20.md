# Twitter 账号采集返回泛化 502：供应商报告未找到账号

## 生产证据

用户报告 prod Run #325083 对 `Brain6ur` 做人物画像，首页目标 30 条。
接口为 `POST /api/v1/data/social/crawl`，Request ID 为
`90d4bdcb-81bb-49f8-b254-9b71db95864d`。

2026-10-20，操作人员通过只读数据库查询返回以下已保存证据：

| 项目 | 已保存值 |
| --- | --- |
| 请求预留时间 | 2026-10-20 13:42:01.953 北京时间 |
| 完成时间 | 2026-10-20 13:42:05.285 北京时间 |
| Usage | `committed` / HTTP 502 / `social_upstream_response_unusable` |
| 供应商调用数量 | 1 |
| Provider call ID | `d2c85770-f61f-4b07-af0a-0c2dfc801bc3` |
| 供应商 / 操作 / 端点 | `rapidapi` / `social.profile.get` / `twitter-aio.user-info` |
| 上游 HTTP / 耗时 | 200 / 3222 ms |
| 旧分类 | `succeeded_unusable` |
| 供应商计费 | `billed: null`，未知 |
| 原始响应 | 30 字节，JSON 解析成功，长度及 SHA-256 校验通过 |

操作人员返回的已解析响应：

```json
{"data":{},"userExists":false}
```

这是解析后的 JSON 表示；操作人员未返回原始空白布局或 SHA-256 字符串，不能据此重建完整原始字节。

## 故障原因

Hub 新账号采集先查询资料，取得数字用户 ID 后才请求账号帖子。本次仅有资料查询回执，
尚未调用 `twitter-aio.crawl`。因此请求条数 30、帖子游标、标准内容搜索的 `Latest`
以及先前的准入失败都不是本次错误发生点。

RapidAPI 明确返回 `userExists: false` 和空 `data`。原实现未识别这个业务否定结果：
`normalizeTwitterResponse` 在 `user-info` 分支找不到有效 profile，抛出
`profile_unavailable_or_ambiguous`；适配器将其统一分类为
`social_upstream_response_unusable`，账号工作流再返回
`502 external_platform_response_unusable`。本地已用相同 JSON 结构复现。

证据只证明供应商当时未找到该账号。没有检查 X 本身，也不能据此判断账号永久不存在、
已改名、已删除或供应商缓存/数据源失准。`retryable: false` 表示不自动重新采购，
不是账号永久无效的证明。

## 修复范围

仅对新账号工作流的 RapidAPI `user-info` 步骤识别严格的
`userExists === false`、空对象 `data`、无错误冲突响应：

- 保存上游 HTTP 200、原始字节、哈希及 `billed: null`；
- 将采购结果归为 `rejected` / `social_account_not_found`，不增加故障熔断计数；
- 对新请求返回 HTTP 404 / `social_account_not_found`，消息明确为供应商报告未找到；
- 返回 `platform: "twitter"`、`stage: "account_lookup"`、`outcome: "rejected"`、
  `retryable: false`，不继续抓帖，不生成成功空列表；
- 空资料但没有明确否定标记、畸形或冲突响应继续按原失败规则处理。

保留既有原始响应和幂等语义。这笔历史请求及其他已保存的 502 不会被迁移或重写，
原幂等键仍回放原失败。修复不自动换键重试，不改标准内容搜索、旧 social 路径、
Night-All 转发、SSO、MX-H2I 登录联网、Pay 或部署配置。

现有客户计费规则保持不变。`committed` 和 `units_actual=0` 不能解释成客户免费，
`billed:null` 也不能解释成供应商未收费。

## 验证与上线状态

新增适配器回归覆盖明确未找到、缺失/错误类型/冲突标记、上游 HTTP 失败、
历史 social/search 与帖子阶段隔离，以及原始字节和哈希。
账号工作流回归覆盖两种公共操作、停止后续采购、归档、幂等回放及历史失败保留。

验证通过：适配器/原 social/路由/归档回归 32 项（含本地 PGlite 的现有失败持久化回归）、
完整账号工作流 34 项、OpenAPI 一致性 1 项；共 67 项。`npm run typecheck`、
`git diff --check` 通过。账号工作流使用合成 HTTP 和内存存储，未将其表述为生产数据库验收。

只运行本地合成响应回归；未重新调用供应商，未修改生产数据，未部署。
