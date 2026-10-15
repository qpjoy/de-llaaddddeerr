# 策略搜索字段、分页与兼容性核查

更新：2026-10-15。核查本机 Hub、Night-All 与 po-infra 源码，并使用纯合同、合成供应商响应及隔离服务测试；没有重新采集或修改生产历史。用户没有保留截图中 Bilibili 请求 ID，因此本轮不能证明该次原供应商响应的具体字段和值。

本轮后续显式要求已将 Facebook 标准补页及 Bilibili／抖音／快手／知乎关键词搜索迁入 Hub；下列 Night-All 章节保留为迁移前故障分析。当前实现与验收见 [直连迁移记录](content-search-direct-migration-2026-10-15.md)。

## 分页与媒体

| 项目 | Hub 当前行为 | 核查边界 |
| --- | --- | --- |
| Twitter 标准搜索 | 余量优先、跨已交付记录去重、有界补页；每请求最多 3 次实际采购 | 不把 raw/social/crawl 一并改成自动补页，历史交付不重写 |
| Facebook 标准搜索 | 余量优先、去重、有界补页；每请求最多 3 次实际派发 | 首次 429 保底也计入上限，取得页后供应商固定；raw 仍单页 |
| 普通社交帖 title | Twitter/Facebook/微博/Instagram 标准为 null、raw 为空字符串，正文保留 | 不删除 Bilibili 原生视频标题，不把账号名称当内容标题 |
| Twitter 媒体 | 标准投影保留真实图片，按明确视频封面与播放来源区分；视频已有格式按现有选择规则呈现 | raw 与标准媒体字段不同，不把原始来源证据抹掉 |
| Facebook 媒体 | 新标准投影使用明确 video_thumbnail/既有 cover 字段，播放视频存在时精确移除相同封面 URL，保留混合照片 | 只按完整 URL 去重，不剥离签名、不猜 photo.php 的 CDN 直链；旧 raw、canonical 入库投影保持原样 |

Night-All 的统一分页服务确实有缓冲与去重机制，但其 Facebook RapidAPI 分支把 providerCallLimit 固定为 1，底层 Facebook Python 执行器也只取一页。不能把“共享分页服务存在”表述成 Facebook 已经自动补齐。

Night-All 共享媒体标准化还有“有视频就把第一张图片当封面并从图片中移除”的逻辑。纯本地混合图片＋视频复现表明，这会把真实照片误当封面；Hub 没有照搬此推断。此次只修复明确来源支持的 Facebook 标准媒体投影，无法证明的附件引用继续保留，原始凭证不动。

## 迁移前 Bilibili 指标修复位于 Night-All

迁移前 Bilibili 标准搜索链为 Hub `/api/v1/data/search` → Night-All `/api/v1/data/search` → 既有 TikHub 映射／清洗 → v1 标准投影。Hub 收到的已经是规范化结果，无法从填成 0 的指标反推出原值；不为此附加详情调用或重新采购。

本地复现两个缺口：原生 Bilibili 字段未被映射，且 `cleanTikHubItem` 将缺失 like/comment/collect/share 转成 0。修复只针对 Bilibili 内容及其标准指标可用性。标准搜索组装通过内部函数参数启用缺失值保留，不增加 HTTP 请求字段、不改变供应商参数、指纹或调用次数。旧 raw 的嵌套 metrics 与 flat 字段名称、数值默认值和 JSON 字符串格式继续保留；真实原生数值映射后可正确反映在新结果中，其他平台行为不改。

| 指标 | 已有标准字段 | 新增的已核实 Bilibili 字段 |
| --- | --- | --- |
| 点赞 | like_count | like、stat.like |
| 评论 | comment_count | review、stat.reply |
| 收藏 | collect_count | favorites、stat.favorite |
| 播放 | view_count | play、stat.view |
| 分享 | share_count 等既有字段 | 没有凭证支持的新别名，不把硬币或弹幕当分享 |

搜索别名来自本机 `po-infra/media/spiders_src/bilibili-content-by-keywords.py`；stat 形状依据 [TikHub Bilibili 示例](https://tikhub.io/bilibili-api)。回归 fixture 明确标为合成样本，不是截图请求归档。`video_review` 为弹幕，不映射为评论；硬币不映射为收藏或分享。明确数值 0 保留为 0，缺失／null／无效值在新标准 metrics 中为 null。Bilibili 既有 nullable metrics 优先于 legacy flat 默认 0，重复标准化不再覆盖缺失状态。

已修改 Night-All 的五个运行文件：`lib/integrations/tikhub/normalizer.js`、`lib/domains/search/tikhub-payload-normalizer.js`、`lib/domains/search/data-search-item-normalizer.js`、`lib/domains/search/raw-search-service.js`、`lib/domains/search/search-service-assembly.js`。新增 `tests/bilibili-metrics.test.js` 与注明来源的 fixture，并验证 raw service 与标准分页 service 的实际边界。这一修复已同步移入后续 Hub 直连投影，新的 Hub 关键词搜索不再依赖 Night-All 部署；仍直接使用 Night-All 的旧客户端可独立发布其修复。 Hub 的 null 显示为“未提供”。此前已提交的 stable 零值响应保持原样，本轮不自动重放或改历史数据。其他未改平台与历史结果仍可能存在上游默认 0，不能单凭 0 证明指标已经取得。

## 接口与旧用户

动态 OpenAPI、静态 `docs/contracts/openapi.yaml`、按当前授权过滤的 `/docs/strategy-search` 与公共 curl 指南已补充 Twitter/Facebook 分页差异、日期参数、字段语义及错误边界。每个新页面使用新 Idempotency-Key，保持 Key、查询、type、路径和页大小；客户端只传回原游标，不解析或转换供应商 token。

标准 `items/pageInfo`、旧 raw JSON 字符串、既有路径和已提交幂等响应保留；平台策略变更不重写旧账单或把现有分页切换给另一供应商。兼容不等于所有旧游标都可续接：已退役 Twitter mxnc1、Instagram 历史／无标签游标、Facebook 无法验证归属的旧游标，仍按既有 restart/invalid_cursor 边界要求显式重启。微信已退役路径仍返回 410，原专项合同不改。

没有修改 MX-H2I 登录联网、客户价格、平台授权、支付或历史凭证。Hub 与 Night-All 的源码修改均未在生产发布；正常 Hub 部署继续限定 `MX_INSIGHT_SYNC_LAUNCHER=0`，新的四平台关键词搜索仅需 Hub 发布；仍直连 Night-All 的客户端独立按原项目流程发布字段修复。

## 本地验收

- Hub 相关回归：305 通过、0 失败；7 项既有集成测试需要独立且已迁移的真实 PostgreSQL，本机未配置而跳过。已运行的隔离 PGlite 覆盖 Twitter 来源、预留、原子结算与真实计费触发器。
- Night-All 实际仓库：123/123 通过、无跳过，覆盖 Bilibili 映射、缺失／零值、旧 raw 默认值、标准分页 service 边界、幂等标准化及其他平台回归；新增内部选项不出现在 HTTP 或供应商请求里，没有增加采购次数。
- 动态／静态 OpenAPI 镜像与按平台授权过滤的指南检查通过；类型检查、Vite 构建与两仓库差异格式检查通过。
- 本机 Chrome 渲染真实产品组件的合成响应：1440×900 与 351×750 的页面、结果卡和 JSON 区域均无横向溢出。217082 字符的完整 JSON 未截断，区域高度受限并可独立用键盘滚动；没有 Key、业务接口请求或真实图片加载。

这些验收不表示生产已发布，也不证明没有保留凭证的 Bilibili 截图对应哪些原始字段。旧 stable 响应与采购账单不回填或重写。
