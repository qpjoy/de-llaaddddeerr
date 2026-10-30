# 数据源治理目录

由 `scripts/generate-data-inventory.mjs` 离线生成；请勿手改。仅含仓库合同，不读取生产数据库、不请求上游。运行状态统一为 `not_checked`。供应商信息用于内部协作，不是租户公开说明。

[总览与统计口径](README.md) · [机器可读明细](inventory.json)

## 统计边界

共 223 个源码初始化条目（原始目录 215 + 供应商补充 8）。这是治理范围，**不是全部已接入来源**，也不包含部署后由管理员或动态发现新增的目录。coverage/delivery 是初始化声明，不能当作当前覆盖率或健康状态。

“映射 native 合同”按代码的 providerCatalogKeys 稳定映射统计；0 仅表示此映射无命中，不证明没有文件/数据库/其他业务接口数据。一个合同可能关联多个目录条目，各行数量不可累加为接口总数。未显式映射的别名不根据名称猜测归属。

| 类别 | 初始化目录条目数 |
| --- | --- |
| 主体追踪与资质数据源 | 24 |
| 国内垂直社区与论坛 | 31 |
| 国内电商与本地生活 | 27 |
| 国内社媒与内容平台 | 31 |
| 广告投放与第三方监测数据 | 14 |
| 应用商店与评论 | 10 |
| 搜索引擎与开放网络 | 25 |
| 海外电商、跨境与独立站 | 27 |
| 海外社媒与内容平台 | 26 |
| 群聊与私域线索（可选） | 8 |

## 全部目录条目

| sourceKey | 名称 | 类别 | 种类 | 初始覆盖声明 | 初始交付声明 | 映射 native 合同 |
| --- | --- | --- | --- | --- | --- | --- |
| source-catalog-0001 | 抖音 | 国内社媒与内容平台 | platform | covered | doing | 187 |
| source-catalog-0002 | 快手 | 国内社媒与内容平台 | platform | covered | doing | 45 |
| source-catalog-0003 | 微信视频号 | 国内社媒与内容平台 | platform | covered | doing | 17 |
| source-catalog-0004 | 小红书 | 国内社媒与内容平台 | platform | covered | doing | 57 |
| source-catalog-0005 | 微博 | 国内社媒与内容平台 | platform | covered | doing | 68 |
| source-catalog-0006 | B站 | 国内社媒与内容平台 | platform | covered | doing | 93 |
| source-catalog-0007 | 知乎 | 国内社媒与内容平台 | platform | covered | doing | 54 |
| source-catalog-0008 | 百度贴吧 | 国内社媒与内容平台 | platform | not_covered | planned | 0 |
| source-catalog-0009 | 豆瓣 | 国内社媒与内容平台 | platform | not_covered | planned | 6 |
| source-catalog-0010 | 今日头条 | 国内社媒与内容平台 | platform | not_covered | exploring | 12 |
| source-catalog-0011 | 西瓜视频 | 国内社媒与内容平台 | platform | not_covered | planned | 7 |
| source-catalog-0012 | 好看视频 | 国内社媒与内容平台 | platform | not_covered | planned | 0 |
| source-catalog-0013 | 百家号 | 国内社媒与内容平台 | platform | not_covered | exploring | 0 |
| source-catalog-0014 | 搜狐号 | 国内社媒与内容平台 | platform | not_covered | planned | 0 |
| source-catalog-0015 | 网易号 | 国内社媒与内容平台 | platform | not_covered | planned | 0 |
| source-catalog-0016 | 企鹅号 | 国内社媒与内容平台 | platform | not_covered | planned | 0 |
| source-catalog-0017 | 大鱼号/UC | 国内社媒与内容平台 | platform | not_covered | planned | 0 |
| source-catalog-0018 | 一点资讯 | 国内社媒与内容平台 | platform | not_covered | planned | 0 |
| source-catalog-0019 | 凤凰号/凤凰新闻 | 国内社媒与内容平台 | platform | not_covered | planned | 0 |
| source-catalog-0020 | 腾讯新闻 | 国内社媒与内容平台 | platform | not_covered | planned | 0 |
| source-catalog-0021 | 网易新闻 | 国内社媒与内容平台 | platform | not_covered | planned | 0 |
| source-catalog-0022 | 新浪新闻 | 国内社媒与内容平台 | platform | not_covered | planned | 0 |
| source-catalog-0023 | 澎湃新闻 | 国内社媒与内容平台 | platform | not_covered | planned | 0 |
| source-catalog-0024 | 观察者网 | 国内社媒与内容平台 | platform | not_covered | planned | 0 |
| source-catalog-0025 | 微信公众号 | 国内社媒与内容平台 | platform | not_covered | exploring | 27 |
| source-catalog-0026 | 微信搜一搜 | 国内社媒与内容平台 | platform | not_covered | exploring | 3 |
| source-catalog-0027 | 虎扑 | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0028 | 雪球 | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0029 | 东方财富股吧 | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0030 | 同花顺社区 | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0031 | 脉脉 | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0032 | 看准网 | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0033 | BOSS直聘 | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0034 | 职友集 | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0035 | 懂车帝 | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0036 | 汽车之家 | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0037 | 易车 | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0038 | 车质网 | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0039 | 什么值得买 | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0040 | 得物社区 | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0041 | NGA | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0042 | TapTap | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0043 | 17173 | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0044 | 游民星空 | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0045 | 小宇宙 | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0046 | 喜马拉雅 | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0047 | 荔枝FM | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0048 | 蜻蜓FM | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0049 | 猫眼 | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0050 | 淘票票 | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0051 | 宝宝树 | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0052 | 妈妈网 | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0053 | 美柚 | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0054 | 丁香园 | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0055 | 丁香医生 | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0056 | 好大夫在线 | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0057 | 春雨医生 | 国内垂直社区与论坛 | platform | not_covered | planned | 0 |
| source-catalog-0058 | 淘宝 | 国内电商与本地生活 | platform | covered | doing | 16 |
| source-catalog-0059 | 天猫 | 国内电商与本地生活 | platform | covered | doing | 16 |
| source-catalog-0060 | 京东 | 国内电商与本地生活 | platform | covered | doing | 8 |
| source-catalog-0061 | 拼多多 | 国内电商与本地生活 | platform | covered | doing | 0 |
| source-catalog-0062 | 抖音电商 | 国内电商与本地生活 | platform_module | covered | doing | 6 |
| source-catalog-0063 | 快手小店 | 国内电商与本地生活 | platform | covered | doing | 0 |
| source-catalog-0064 | 小红书店铺 | 国内电商与本地生活 | platform | covered | doing | 1 |
| source-catalog-0065 | 视频号小店 | 国内电商与本地生活 | platform | not_covered | exploring | 0 |
| source-catalog-0066 | 微店 | 国内电商与本地生活 | platform | not_covered | planned | 0 |
| source-catalog-0067 | 有赞 | 国内电商与本地生活 | platform | not_covered | planned | 0 |
| source-catalog-0068 | 小鹅通 | 国内电商与本地生活 | platform | not_covered | planned | 0 |
| source-catalog-0069 | 1688 | 国内电商与本地生活 | platform | not_covered | planned | 2 |
| source-catalog-0070 | 京喜 | 国内电商与本地生活 | platform | not_covered | planned | 0 |
| source-catalog-0071 | 唯品会 | 国内电商与本地生活 | platform | not_covered | planned | 0 |
| source-catalog-0072 | 苏宁易购 | 国内电商与本地生活 | platform | not_covered | planned | 0 |
| source-catalog-0073 | 闲鱼 | 国内电商与本地生活 | platform | covered | doing | 2 |
| source-catalog-0074 | 转转 | 国内电商与本地生活 | platform | not_covered | planned | 0 |
| source-catalog-0075 | 得物 | 国内电商与本地生活 | platform | not_covered | planned | 0 |
| source-catalog-0076 | 孔夫子旧书网 | 国内电商与本地生活 | platform | not_covered | planned | 0 |
| source-catalog-0077 | 美团 | 国内电商与本地生活 | platform | not_covered | exploring | 0 |
| source-catalog-0078 | 大众点评 | 国内电商与本地生活 | platform | not_covered | exploring | 0 |
| source-catalog-0079 | 饿了么 | 国内电商与本地生活 | platform | not_covered | planned | 0 |
| source-catalog-0080 | 携程 | 国内电商与本地生活 | platform | not_covered | planned | 0 |
| source-catalog-0081 | 飞猪 | 国内电商与本地生活 | platform | not_covered | planned | 0 |
| source-catalog-0082 | 同程旅行 | 国内电商与本地生活 | platform | not_covered | planned | 0 |
| source-catalog-0083 | 去哪儿 | 国内电商与本地生活 | platform | not_covered | planned | 0 |
| source-catalog-0084 | 马蜂窝 | 国内电商与本地生活 | platform | not_covered | planned | 0 |
| source-catalog-0085 | TikTok | 海外社媒与内容平台 | platform | not_covered | exploring | 105 |
| source-catalog-0086 | X / Twitter | 海外社媒与内容平台 | platform | covered | doing | 30 |
| source-catalog-0087 | Instagram | 海外社媒与内容平台 | platform | covered | doing | 102 |
| source-catalog-0088 | Facebook | 海外社媒与内容平台 | platform | covered | doing | 5 |
| source-catalog-0089 | YouTube | 海外社媒与内容平台 | platform | covered | doing | 38 |
| source-catalog-0090 | Reddit | 海外社媒与内容平台 | platform | covered | doing | 25 |
| source-catalog-0091 | LinkedIn | 海外社媒与内容平台 | platform | not_covered | planned | 10 |
| source-catalog-0092 | Threads | 海外社媒与内容平台 | platform | not_covered | planned | 12 |
| source-catalog-0093 | Twitch | 海外社媒与内容平台 | platform | not_covered | planned | 0 |
| source-catalog-0094 | Pinterest | 海外社媒与内容平台 | platform | not_covered | planned | 0 |
| source-catalog-0095 | Quora | 海外社媒与内容平台 | platform | not_covered | planned | 0 |
| source-catalog-0096 | Medium | 海外社媒与内容平台 | platform | not_covered | planned | 0 |
| source-catalog-0097 | Tumblr | 海外社媒与内容平台 | platform | not_covered | planned | 0 |
| source-catalog-0098 | Snapchat Spotlight | 海外社媒与内容平台 | platform | not_covered | planned | 0 |
| source-catalog-0099 | VK | 海外社媒与内容平台 | platform | not_covered | planned | 0 |
| source-catalog-0100 | Mastodon | 海外社媒与内容平台 | platform | not_covered | planned | 0 |
| source-catalog-0101 | Dailymotion | 海外社媒与内容平台 | platform | not_covered | planned | 0 |
| source-catalog-0102 | Vimeo | 海外社媒与内容平台 | platform | not_covered | planned | 0 |
| source-catalog-0103 | Rumble | 海外社媒与内容平台 | platform | not_covered | planned | 0 |
| source-catalog-0104 | Kick | 海外社媒与内容平台 | platform | not_covered | planned | 0 |
| source-catalog-0105 | Substack | 海外社媒与内容平台 | platform | covered | doing | 0 |
| source-catalog-0106 | Blogspot/Blogger | 海外社媒与内容平台 | platform | not_covered | planned | 0 |
| source-catalog-0107 | WordPress.com | 海外社媒与内容平台 | platform | not_covered | planned | 0 |
| source-catalog-0108 | Amazon | 海外电商、跨境与独立站 | platform | not_covered | exploring | 5 |
| source-catalog-0109 | eBay | 海外电商、跨境与独立站 | platform | not_covered | exploring | 0 |
| source-catalog-0110 | AliExpress | 海外电商、跨境与独立站 | platform | not_covered | exploring | 2 |
| source-catalog-0111 | Temu | 海外电商、跨境与独立站 | platform | not_covered | exploring | 0 |
| source-catalog-0112 | Shein | 海外电商、跨境与独立站 | platform | not_covered | planned | 0 |
| source-catalog-0113 | Etsy | 海外电商、跨境与独立站 | platform | not_covered | planned | 0 |
| source-catalog-0114 | Shopee | 海外电商、跨境与独立站 | platform | not_covered | planned | 18 |
| source-catalog-0115 | Lazada | 海外电商、跨境与独立站 | platform | not_covered | planned | 0 |
| source-catalog-0116 | Walmart Marketplace | 海外电商、跨境与独立站 | platform | not_covered | planned | 0 |
| source-catalog-0117 | Target Plus | 海外电商、跨境与独立站 | platform | not_covered | planned | 0 |
| source-catalog-0118 | Mercado Libre | 海外电商、跨境与独立站 | platform | not_covered | planned | 0 |
| source-catalog-0119 | Rakuten | 海外电商、跨境与独立站 | platform | not_covered | planned | 0 |
| source-catalog-0120 | Coupang | 海外电商、跨境与独立站 | platform | not_covered | planned | 0 |
| source-catalog-0121 | Tokopedia | 海外电商、跨境与独立站 | platform | not_covered | planned | 0 |
| source-catalog-0122 | Bukalapak | 海外电商、跨境与独立站 | platform | not_covered | planned | 0 |
| source-catalog-0123 | Flipkart | 海外电商、跨境与独立站 | platform | not_covered | planned | 0 |
| source-catalog-0124 | Facebook Marketplace | 海外电商、跨境与独立站 | platform | not_covered | planned | 0 |
| source-catalog-0125 | Instagram Shop | 海外电商、跨境与独立站 | platform | not_covered | planned | 0 |
| source-catalog-0126 | TikTok Shop Global | 海外电商、跨境与独立站 | platform | not_covered | planned | 2 |
| source-catalog-0127 | Craigslist | 海外电商、跨境与独立站 | platform | not_covered | planned | 0 |
| source-catalog-0128 | Gumtree | 海外电商、跨境与独立站 | platform | not_covered | planned | 0 |
| source-catalog-0129 | Shopify 独立站 | 海外电商、跨境与独立站 | platform | not_covered | exploring | 0 |
| source-catalog-0130 | WooCommerce / WordPress 商城 | 海外电商、跨境与独立站 | platform | not_covered | planned | 0 |
| source-catalog-0131 | Magento / Adobe Commerce | 海外电商、跨境与独立站 | platform | not_covered | planned | 0 |
| source-catalog-0132 | Wix 独立站 | 海外电商、跨境与独立站 | platform | not_covered | planned | 0 |
| source-catalog-0133 | Squarespace 独立站 | 海外电商、跨境与独立站 | platform | not_covered | planned | 0 |
| source-catalog-0134 | Webflow 独立站 | 海外电商、跨境与独立站 | platform | not_covered | planned | 0 |
| source-catalog-0135 | 百度搜索 | 搜索引擎与开放网络 | source_class | not_covered | exploring | 0 |
| source-catalog-0136 | Google Search | 搜索引擎与开放网络 | source_class | not_covered | exploring | 0 |
| source-catalog-0137 | Bing | 搜索引擎与开放网络 | source_class | covered | doing | 0 |
| source-catalog-0138 | 搜狗搜索 | 搜索引擎与开放网络 | source_class | not_covered | planned | 0 |
| source-catalog-0139 | 360搜索 | 搜索引擎与开放网络 | source_class | not_covered | planned | 0 |
| source-catalog-0140 | 百度指数 | 搜索引擎与开放网络 | source_class | not_covered | planned | 0 |
| source-catalog-0141 | Google Trends | 搜索引擎与开放网络 | source_class | not_covered | planned | 0 |
| source-catalog-0142 | 微博热搜/话题榜 | 搜索引擎与开放网络 | source_class | covered | doing | 0 |
| source-catalog-0143 | 抖音热点榜 | 搜索引擎与开放网络 | source_class | not_covered | exploring | 0 |
| source-catalog-0144 | 小红书搜索建议/热词 | 搜索引擎与开放网络 | source_class | not_covered | exploring | 0 |
| source-catalog-0145 | B站排行榜/热榜 | 搜索引擎与开放网络 | source_class | not_covered | planned | 0 |
| source-catalog-0146 | 百度新闻 | 搜索引擎与开放网络 | source_class | not_covered | planned | 0 |
| source-catalog-0147 | Google News | 搜索引擎与开放网络 | source_class | not_covered | planned | 0 |
| source-catalog-0148 | 今日热榜类聚合站 | 搜索引擎与开放网络 | source_class | not_covered | planned | 0 |
| source-catalog-0149 | 新闻网站 | 搜索引擎与开放网络 | source_class | covered | doing | 0 |
| source-catalog-0150 | 地方媒体网站 | 搜索引擎与开放网络 | source_class | not_covered | planned | 0 |
| source-catalog-0151 | 行业垂直媒体 | 搜索引擎与开放网络 | source_class | not_covered | planned | 0 |
| source-catalog-0152 | 论坛站点 | 搜索引擎与开放网络 | source_class | not_covered | planned | 0 |
| source-catalog-0153 | 博客站点 | 搜索引擎与开放网络 | source_class | not_covered | planned | 0 |
| source-catalog-0154 | 问答站点 | 搜索引擎与开放网络 | source_class | not_covered | planned | 0 |
| source-catalog-0155 | 资源站/下载站 | 搜索引擎与开放网络 | source_class | not_covered | planned | 0 |
| source-catalog-0156 | 百科站点 | 搜索引擎与开放网络 | source_class | not_covered | planned | 0 |
| source-catalog-0157 | 网盘资源页 | 搜索引擎与开放网络 | source_class | not_covered | planned | 0 |
| source-catalog-0158 | 代码仓库 | 搜索引擎与开放网络 | source_class | not_covered | planned | 0 |
| source-catalog-0159 | 学术论文/预印本 | 搜索引擎与开放网络 | source_class | not_covered | planned | 0 |
| source-catalog-0160 | Telegram 公开频道 | 群聊与私域线索（可选） | platform_module | covered | complete | 7 |
| source-catalog-0161 | Telegram 公开群组 | 群聊与私域线索（可选） | platform_module | covered | complete | 7 |
| source-catalog-0162 | QQ群 | 群聊与私域线索（可选） | platform_module | not_covered | planned | 0 |
| source-catalog-0163 | 微信群 | 群聊与私域线索（可选） | platform_module | not_covered | planned | 0 |
| source-catalog-0164 | Discord 公开服务器/频道 | 群聊与私域线索（可选） | platform_module | not_covered | planned | 0 |
| source-catalog-0165 | WhatsApp 群 | 群聊与私域线索（可选） | platform_module | not_covered | planned | 0 |
| source-catalog-0166 | Line 群/频道 | 群聊与私域线索（可选） | platform_module | not_covered | planned | 0 |
| source-catalog-0167 | 企业微信/飞书群 | 群聊与私域线索（可选） | platform_module | not_covered | planned | 0 |
| source-catalog-0168 | 国家企业信用信息公示系统 | 主体追踪与资质数据源 | registry | not_covered | exploring | 0 |
| source-catalog-0169 | 信用中国 | 主体追踪与资质数据源 | registry | not_covered | planned | 0 |
| source-catalog-0170 | 中国执行信息公开网 | 主体追踪与资质数据源 | registry | not_covered | planned | 0 |
| source-catalog-0171 | 中国裁判文书网 | 主体追踪与资质数据源 | registry | not_covered | planned | 0 |
| source-catalog-0172 | 企查查 | 主体追踪与资质数据源 | registry | covered | doing | 0 |
| source-catalog-0173 | 天眼查 | 主体追踪与资质数据源 | registry | covered | doing | 0 |
| source-catalog-0174 | 爱企查 | 主体追踪与资质数据源 | registry | not_covered | exploring | 0 |
| source-catalog-0175 | 启信宝 | 主体追踪与资质数据源 | registry | not_covered | planned | 0 |
| source-catalog-0176 | ICP备案查询 | 主体追踪与资质数据源 | registry | not_covered | exploring | 0 |
| source-catalog-0177 | 公安联网备案 | 主体追踪与资质数据源 | registry | not_covered | planned | 0 |
| source-catalog-0178 | 商标局/商标查询 | 主体追踪与资质数据源 | registry | not_covered | planned | 0 |
| source-catalog-0179 | 专利检索系统 | 主体追踪与资质数据源 | registry | not_covered | planned | 0 |
| source-catalog-0180 | WHOIS / ICANN Lookup | 主体追踪与资质数据源 | registry | not_covered | planned | 0 |
| source-catalog-0181 | DNS 记录 | 主体追踪与资质数据源 | registry | not_covered | planned | 0 |
| source-catalog-0182 | SSL 证书透明日志 | 主体追踪与资质数据源 | registry | not_covered | planned | 0 |
| source-catalog-0183 | Wayback Machine | 主体追踪与资质数据源 | registry | not_covered | planned | 0 |
| source-catalog-0184 | BuiltWith | 主体追踪与资质数据源 | registry | not_covered | planned | 0 |
| source-catalog-0185 | Similarweb | 主体追踪与资质数据源 | registry | not_covered | planned | 0 |
| source-catalog-0186 | SecurityTrails | 主体追踪与资质数据源 | registry | not_covered | planned | 0 |
| source-catalog-0187 | Censys | 主体追踪与资质数据源 | registry | not_covered | planned | 0 |
| source-catalog-0188 | Shodan | 主体追踪与资质数据源 | registry | covered | doing | 0 |
| source-catalog-0189 | OpenCorporates | 主体追踪与资质数据源 | registry | not_covered | planned | 0 |
| source-catalog-0190 | SEC EDGAR | 主体追踪与资质数据源 | registry | not_covered | planned | 0 |
| source-catalog-0191 | UK Companies House | 主体追踪与资质数据源 | registry | not_covered | planned | 0 |
| source-catalog-0192 | Apple App Store | 应用商店与评论 | platform | not_covered | planned | 0 |
| source-catalog-0193 | Google Play | 应用商店与评论 | platform | not_covered | planned | 0 |
| source-catalog-0194 | 华为应用市场 | 应用商店与评论 | platform | not_covered | planned | 0 |
| source-catalog-0195 | 小米应用商店 | 应用商店与评论 | platform | not_covered | planned | 0 |
| source-catalog-0196 | OPPO 软件商店 | 应用商店与评论 | platform | not_covered | planned | 0 |
| source-catalog-0197 | vivo 应用商店 | 应用商店与评论 | platform | not_covered | planned | 0 |
| source-catalog-0198 | 应用宝 | 应用商店与评论 | platform | not_covered | planned | 0 |
| source-catalog-0199 | 酷安 | 应用商店与评论 | platform | not_covered | planned | 0 |
| source-catalog-0200 | 七麦数据 | 应用商店与评论 | platform | not_covered | planned | 0 |
| source-catalog-0201 | 点点数据 | 应用商店与评论 | platform | not_covered | planned | 0 |
| source-catalog-0202 | Meta Ad Library | 广告投放与第三方监测数据 | provider | not_covered | planned | 0 |
| source-catalog-0203 | Google Ads Transparency Center | 广告投放与第三方监测数据 | provider | not_covered | planned | 0 |
| source-catalog-0204 | TikTok Creative Center | 广告投放与第三方监测数据 | provider | not_covered | planned | 0 |
| source-catalog-0205 | 巨量创意/巨量算数 | 广告投放与第三方监测数据 | provider | not_covered | planned | 0 |
| source-catalog-0206 | 磁力引擎/快手商业化线索 | 广告投放与第三方监测数据 | provider | not_covered | planned | 0 |
| source-catalog-0207 | 新榜 | 广告投放与第三方监测数据 | provider | not_covered | planned | 0 |
| source-catalog-0208 | 飞瓜数据 | 广告投放与第三方监测数据 | provider | not_covered | planned | 0 |
| source-catalog-0209 | 蝉妈妈 | 广告投放与第三方监测数据 | provider | not_covered | planned | 0 |
| source-catalog-0210 | 千瓜数据 | 广告投放与第三方监测数据 | provider | not_covered | planned | 0 |
| source-catalog-0211 | 灰豚数据 | 广告投放与第三方监测数据 | provider | not_covered | planned | 0 |
| source-catalog-0212 | DataEye | 广告投放与第三方监测数据 | provider | not_covered | planned | 0 |
| source-catalog-0213 | AppGrowing | 广告投放与第三方监测数据 | provider | not_covered | planned | 0 |
| source-catalog-0214 | 克劳锐 | 广告投放与第三方监测数据 | provider | not_covered | planned | 0 |
| source-catalog-0215 | 西瓜数据 | 广告投放与第三方监测数据 | provider | not_covered | planned | 0 |
| source-platform-lemon8 | Lemon8 | 海外社媒与内容平台 | platform | unknown | planned | 14 |
| source-platform-pipixia | 皮皮虾 | 国内社媒与内容平台 | platform | unknown | planned | 17 |
| source-platform-youku | 优酷 | 国内社媒与内容平台 | platform | unknown | planned | 3 |
| source-platform-imdb | IMDb | 海外社媒与内容平台 | platform | unknown | planned | 18 |
| source-platform-vcg | 视觉中国 | 国内社媒与内容平台 | platform | unknown | planned | 0 |
| source-platform-pixabay | Pixabay | 海外社媒与内容平台 | platform | unknown | planned | 1 |
| source-platform-qq-huxuan | 腾讯互选 | 国内社媒与内容平台 | platform | unknown | planned | 6 |
| source-platform-douyin-xingtu | 巨量星图 | 国内社媒与内容平台 | platform | unknown | planned | 33 |

## 全部固定初始化清洗输入（19 项）

这是源码注册范围，不代表当前都已配置、批准映射、启用或入库；动态发现和自定义输入须另读运行目录。

| sourceKey | 类型 | 源表/读取路径 | Hub dataset | Hub platform |
| --- | --- | --- | --- | --- |
| telegram-monitor-chats | database | public.tg_monitor_chats | telegram.monitor.chats.v1 | telegram |
| telegram-monitor-messages | database | public.tg_monitor_messages | telegram.monitor.messages.v1 | telegram |
| telegram-sqlite-api-chats | sqlite_api | GET /v1/chats | telegram.sqlite.chats.v1 | telegram |
| telegram-sqlite-api-messages | sqlite_api | GET /v1/messages?include_deleted=true | telegram.sqlite.messages.v1 | telegram |
| mobile-commerce-collected-items | database | public.mb_collected_items | mobile-commerce.collected-items.v1 | mobile_commerce |
| province-opinion-results | database | public.monitor_strategy_results | public-opinion.province.v1 | public_opinion |
| night-all-saved-records-automotive | database | public.saved_records_automotive | data-center.saved-records.automotive.v1 | data_center_saved_records_automotive |
| night-all-saved-records-finance | database | public.saved_records_finance | data-center.saved-records.finance.v1 | data_center_saved_records_finance |
| night-all-saved-records-forum | database | public.saved_records_forum | data-center.saved-records.forum.v1 | data_center_saved_records_forum |
| night-all-saved-records-hotspot | database | public.saved_records_hotspot | data-center.saved-records.hotspot.v1 | data_center_saved_records_hotspot |
| night-all-saved-records-local-news | database | public.saved_records_local_news | data-center.saved-records.local_news.v1 | data_center_saved_records_local_news |
| night-all-saved-records-media | database | public.saved_records_media | data-center.saved-records.media.v1 | data_center_saved_records_media |
| night-all-saved-records-news | database | public.saved_records_news | data-center.saved-records.news.v1 | data_center_saved_records_news |
| night-all-saved-records-other | database | public.saved_records_other | data-center.saved-records.other.v1 | data_center_saved_records_other |
| night-all-saved-records-recruitment | database | public.saved_records_recruitment | data-center.saved-records.recruitment.v1 | data_center_saved_records_recruitment |
| night-all-saved-records-research | database | public.saved_records_research | data-center.saved-records.research.v1 | data_center_saved_records_research |
| night-all-saved-records-social | database | public.saved_records_social | data-center.saved-records.social.v1 | data_center_saved_records_social |
| night-all-saved-records-technology | database | public.saved_records_technology | data-center.saved-records.technology.v1 | data_center_saved_records_technology |
| night-all-saved-records-web | database | public.saved_records_web | data-center.saved-records.web.v1 | data_center_saved_records_web |

## Night-All-A saved_records 固定初始化来源

以下 13 个叶表各自有检查点、映射和失败状态。新 source_type 可通过发现机制增补；实际数量须读取运行数据库。内部键沿用 night-all，清洗任务归属 Night-All-A。

| sourceKey | 源表 | Hub dataset | Hub platform |
| --- | --- | --- | --- |
| night-all-saved-records-automotive | public.saved_records_automotive | data-center.saved-records.automotive.v1 | data_center_saved_records_automotive |
| night-all-saved-records-finance | public.saved_records_finance | data-center.saved-records.finance.v1 | data_center_saved_records_finance |
| night-all-saved-records-forum | public.saved_records_forum | data-center.saved-records.forum.v1 | data_center_saved_records_forum |
| night-all-saved-records-hotspot | public.saved_records_hotspot | data-center.saved-records.hotspot.v1 | data_center_saved_records_hotspot |
| night-all-saved-records-local-news | public.saved_records_local_news | data-center.saved-records.local_news.v1 | data_center_saved_records_local_news |
| night-all-saved-records-media | public.saved_records_media | data-center.saved-records.media.v1 | data_center_saved_records_media |
| night-all-saved-records-news | public.saved_records_news | data-center.saved-records.news.v1 | data_center_saved_records_news |
| night-all-saved-records-other | public.saved_records_other | data-center.saved-records.other.v1 | data_center_saved_records_other |
| night-all-saved-records-recruitment | public.saved_records_recruitment | data-center.saved-records.recruitment.v1 | data_center_saved_records_recruitment |
| night-all-saved-records-research | public.saved_records_research | data-center.saved-records.research.v1 | data_center_saved_records_research |
| night-all-saved-records-social | public.saved_records_social | data-center.saved-records.social.v1 | data_center_saved_records_social |
| night-all-saved-records-technology | public.saved_records_technology | data-center.saved-records.technology.v1 | data_center_saved_records_technology |
| night-all-saved-records-web | public.saved_records_web | data-center.saved-records.web.v1 | data_center_saved_records_web |
