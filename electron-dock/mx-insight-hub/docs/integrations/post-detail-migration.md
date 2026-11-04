# 帖子详情接口迁移

旧接口 `POST /api/v1/search/post-detail` 现在可以经由 Hub 的兼容入口调用，等价路径是：

- `POST /api/v1/search/post-detail`
- `POST /api/v1/night-all/search/post-detail`

两种路径共享同一个 Hub 幂等身份和请求指纹。请求必须带 `Idempotency-Key`、一个明确的 `platform`，以及 `postId`、`contentId` 或 `url` 之一；`includeRaw=true`、`provider`、凭据、endpoint 和其他供应商控制字段会在 Hub 边界拒绝。

```json
{
  "businessId": "agent:<Agent标识>:data_query:search_post_detail:twitter",
  "platform": "twitter",
  "postId": "<平台帖子ID>",
  "url": "<帖子链接>",
  "count": 1,
  "includeRaw": false
}
```

返回继续使用 Night-All 的兼容 envelope，`raw_data` 中应包含完整正文、发布时间、作者以及图片、视频和封面等媒体字段。Hub 会保留请求审计、幂等重放和精确快照回退语义；供应商、凭据和上游 endpoint 不向调用方公开。

小红书已经有 Hub-native `POST /api/v1/data/post` 合同。新的小红书集成应使用该接口；本兼容入口只保留旧调用的过渡能力。其他平台仍按平台逐步接入 Hub-native 详情适配器，当前兼容入口不改变 MX-H2I 的登录或联网路径。
