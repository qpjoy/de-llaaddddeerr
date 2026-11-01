# 帖子评论接口迁移

旧接口 `POST /api/v1/search/post-comments` 已接入 Hub 兼容入口，等价路径是：

- `POST /api/v1/search/post-comments`
- `POST /api/v1/night-all/search/post-comments`

请求至少提供 `postId`、`contentId`、平台专用帖子/视频 ID 或 `url` 之一。`postId`、`contentId`
和 `url` 可以按已有数据选择性提交；不要求三者同时存在。`count/pageSize/limit` 默认 20、单页最大
100，`includeRaw` 只接受 `false`。供应商、凭据、endpoint 和扩大评论工作量的控制字段由 Hub 管理。

```json
{
  "businessId": "data-hub:<策略标识>:weibo:评论",
  "platform": "weibo",
  "postId": "<平台正文ID>",
  "contentId": "<同一个平台正文ID>",
  "url": "<原文链接>",
  "count": 100,
  "page": 1,
  "includeRaw": false
}
```

响应继续使用 Night-All 的兼容 envelope。`raw_data` 应包含评论 ID、正文 ID、评论正文、作者、发布时间
和互动量；`data.page` 明确表示 `hasMore`、`nextCursor` 与当前页状态。续页只使用上一页返回的
`page.nextCursor`（或等价 `page.nextParams`），保持原查询和标识，并为下一页使用新的
`Idempotency-Key`。商品评论、搜索结果附带评论和 YouTube 频道评论使用各自合同，不能替代此单帖评论能力。

Hub 会记录请求审计、幂等重放和精确快照回退；调用方无需接触 Night-All provider 或 endpoint。该兼容入口
不改变 MX-H2I 的登录或联网路径。
