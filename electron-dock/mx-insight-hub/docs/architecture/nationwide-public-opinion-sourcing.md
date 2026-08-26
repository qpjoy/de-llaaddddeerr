# 全国省级舆情召回与地理证据策略

Last reviewed: 2026-08-26.

## 结论

不应用一个免费搜索源承诺“每省每天 10 条”。可运营的目标是：每省维护固定优质源，
先形成候选池，再做去重、时效、事件地理和质量审核。产品 SLA 定义为“滚动 72 小时每省
至少 10 条可用数据”；24 小时内不足时返回真实 `coverage_gap`，不用重复、过期或弱相关
内容硬凑数。

## 源组合与降级顺序

1. 每省的政府门户“要闻/政务动态/通知公告”，优先使用原生 RSS/Atom 或明确开放 API。
2. 新华网、人民网对应的省级频道，作为链接型候选发现源。
3. 省市公共数据开放平台中的应急、气象、生态、监管等结构化事件，作为高置信信号。
4. 当某省候选不足时，才调用自建 SearXNG，并限制在已审核的官方/媒体域名内搜索。
5. GDELT 用于补漏和海外事件；ADM1 只是地点提及证据，不是事件主发生地真值。
6. RSSHub 只是无原生 feed 站点的自建适配层，需固定版本、Redis 缓存、路由契约测试与失败降级。
7. NewsNow/TrendRadar 类热榜聚合只作热点种子，不承担省份覆盖。

一手资料：[中国政府网地方政府网站目录](https://big5.www.gov.cn/gate/big5/www.gov.cn/home/2023-03/29/content_5748954.htm)、
[新华网及地方频道](https://www.news.cn/?lang=zh)、[人民网及地方频道](https://www.people.com.cn/index.html)、
[GDELT 开放数据](https://www.gdeltproject.org/data.html)、[GDELT GEO 2.0 误差边界](https://blog.gdeltproject.org/gdelt-geo-2-0-api-debuts/)、
[SearXNG](https://github.com/searxng/searxng)、[RSSHub](https://github.com/DIYgod/RSSHub)、
[NewsNow](https://github.com/ourongxing/newsnow)。

## 地理证据合同

必须分开三组字段：

- `publisher_province`：固定省级频道、官方站点 registry 或发布者实体的省份。
- `event_province`：标题、正文证据窗口、结构化 city/adcode 或事件主体支持的主发生省份。
- `mentioned_provinces`：文中提及但非主事件地的其他省份。

固定江苏频道可以直接给 `publisher_province=江苏`，但不能把其中的全国/海外稿件直接标成
`event_province=江苏`。只有结构化的江苏城市码、事件栏目合同或原文地点证据才能直接形成
事件省份事实。搜索词中的省名只是 recall hint，不得直接持久化。

## Night-All 与 Hub 的分工

- Night-All 现有 `political_terror_daily_brief` 是严格涉政/涉恐 Agent，负责召回、证据化省份、分类和
  `monitor_strategy_results` 单写。它的“每省 10 条”是软目标，不能通过放宽质量规则兑现。
- Hub 负责增量同步、canonical/revision、派生 Agent 证据、覆盖统计、发布门禁与按省服务。
- 当业务需要宽于“涉政/涉恐”的全国新闻池时，新建独立 `national_public_opinion` Agent/存储桶，
  不改写现有 Agent 的语义。早期只接入固定白名单站点，覆盖稳定后再开放搜索补漏。

## 地区切换消费面

用户界面先请求 `GET /api/v1/data/public-opinion/province-coverage`获取 34 个地区、可用数和缺口，
选中地区后请求 `GET /api/v1/data/public-opinion/provinces/:province/items?sort=latest`。浏览器/
Electron renderer 不保存 Hub API key；正式产品通过 AppCenter/BFF 以 consumer key 访问。该读链路不修改
MX-H2I 的登录、lease、WireGuard、route、DNS/PAC 或用户联网状态机。

## 内容权利边界

开源代码许可不等于被采集内容的转载授权。对未明确授权的站点，优先只存标题、URL、时间、来源与
自有分析字段；公开展示全文前另行核权。若将来面向社会公众提供互联网新闻信息，需额外评估新闻信息
服务许可与转载合规，不能把内部 BI 使用的边界直接外推。
