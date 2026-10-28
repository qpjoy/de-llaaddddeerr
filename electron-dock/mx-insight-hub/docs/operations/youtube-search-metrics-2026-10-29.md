# YouTube 搜索结果缺作者与播放量（2026-10-29）

## 结论

请求 `462579ff-1cd1-40a1-981c-d3cbb3e3b144`（“钱学森”）的结果卡片上，作者、点赞、评论、分享、播放、收藏、发布时间都显示“未提供”。原因有两类：

| 字段 | TikHub `youtube/web_v2/get_general_search_v2` 返回 | 判断 |
| --- | --- | --- |
| 作者 `author` | 纯字符串 | **Hub 缺陷**：只在 `author` 为对象时读取，字符串被丢弃 |
| 播放量 `view_count` | 带单位的精确数字文本（不是缩写） | **Hub 缺陷**：只解析原始渲染器的英文 `viewCountText` |
| 发布时间 `published_time` | 相对时间，如 “3 years ago” | 不是精确时间，按既有规则保持空 |
| 点赞 / 评论 / 分享 / 收藏 | 不返回 | YouTube 搜索本来就不提供，只有视频详情接口有 |

证据来自新增的只读诊断 `server/ops/diagnose-youtube-search.mjs`。该请求有两次 TikHub 调用，都是 HTTP/业务码 200，分别 13 条与 18 条视频。每条视频的字段为 `author`、`channel_id`、`description_snippet`、`duration`、`published_time`、`thumbnails`、`title`、`url`、`video_id`、`view_count`。诊断只输出键名和值的格式类别，不输出值、正文、链接或游标。

## 修改

`server/contracts/tikhub-content-search.mjs` 的 `youtubeRow`：

- 作者名在原有来源之外，增加读取纯字符串 `author`。
- 播放量增加从 `view_count` 文本解析精确整数：`12,345 views`、`6789次观看`、`次觀看`、`次播放`，以及 `No views` 记为 0。`1.2M`、`12万` 等缩写，以及小数，仍保持为空，不估算。
- 发布时间仍不把相对时间换算成日期。

已经保存的旧响应不会被改写。部署后需要新建一次查询（付费）才能看到作者和播放量。

## 诊断用法

只读、无需部署，从 Hub 源码目录执行：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- node --input-type=module - <YouTube 请求 ID> < server/ops/diagnose-youtube-search.mjs
```

## 验证

新增 YouTube 投影测试（字符串作者、精确与缩写播放量、No views、相对时间不变）和诊断测试。用 PGlite 0.2.17 跑完整服务端套件，除原有 45 项外，只有一项不稳定的 `wechat-self-hosted` 测试，单独重跑一次通过、一次失败，与本次修改无关。尚未部署。
