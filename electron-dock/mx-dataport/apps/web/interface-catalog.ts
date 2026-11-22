// Source: Hub 数据接入进度表.xlsx, eight inventory sheets (2026-11-22).
// Paths and examples are reference metadata. Hub grants still determine availability.
export type InterfaceStatus = "supported" | "planned" | "unknown";

export type InterfaceOperation = {
  title: string;
  status: InterfaceStatus;
  path?: string;
  requestExample?: string;
};

export type InterfacePlatform = {
  slug: string;
  name: string;
  aliases?: string[];
  operations: InterfaceOperation[];
};

export const interfacePlatforms: InterfacePlatform[] = [
  {
    "slug": "x",
    "name": "Twitter / X",
    "aliases": [
      "Twitter",
      "Twitter（单帖/楼中楼）",
      "Twitter 用户邮箱"
    ],
    "operations": [
      {"title": "内容关键词搜索", "status": "supported", "path": "/api/v1/data/search", "requestExample": "{\n  \"platform\": \"twitter\",\n  \"query\": \"人工智能\",\n  \"pageSize\": 20\n}"},
      {"title": "获取某条内容下面的评论（单帖/楼中楼）", "status": "supported", "path": "/api/v1/search/post-comments", "requestExample": "{\n  \"platform\": \"twitter\",\n  \"contentId\": \"2116867399156662663\",\n  \"count\": 20\n}"},
      {"title": "获取某条内容下面的评论（单帖/楼中楼）（旧版）", "status": "supported", "path": "/api/v1/data/social/post-comments", "requestExample": "{\n  \"platform\": \"twitter\",\n  \"contentId\": \"2116867399156662663\",\n  \"count\": 20\n}"},
      {"title": "Twitter 用户邮箱", "status": "supported", "path": "/api/v1/data/twitter-user-email/search", "requestExample": "curl -sS -X POST \"$HUB_URL/api/v1/data/twitter-user-email/search\" \\\n  -H \"Authorization: Bearer YOUR_HUB_API_KEY\" -H \"Content-Type: application/json\" \\\n  -d '{\"mode\":\"email\",\"query\":\"name@example.com\"}'"},
    ],
  },
  {
    "slug": "xiaohongshu",
    "name": "小红书",
    "aliases": [
      "小红书（笔记专用）",
      "小红书电商",
      "小红书搜索建议/热词"
    ],
    "operations": [
      {"title": "内容关键词搜索", "status": "supported", "path": "/api/v1/data/search", "requestExample": "{\n  \"platform\": \"xiaohongshu\",\n  \"query\": \"人工智能\",\n  \"pageSize\": 20\n}"},
      {"title": "获取某条内容下面的评论（笔记专用）", "status": "supported", "path": "/api/v1/data/xiaohongshu/notes/comments", "requestExample": "{\n  \"note_id\": \"<24位真实笔记ID>\",\n  \"sort\": \"latest\"\n}"},
      {"title": "商品关键词搜索", "status": "supported", "path": "/api/v1/data/ecommerce/products/search", "requestExample": "{\n  \"marketplace\": \"xiaohongshu_ec\",\n  \"query\": \"耳机\",\n  \"deliveryMode\": \"cache_first\"\n}"},
      {"title": "小红书搜索建议/热词", "status": "planned"},
    ],
  },
  {
    "slug": "douyin",
    "name": "抖音",
    "aliases": [
      "抖音电商",
      "抖音热点榜"
    ],
    "operations": [
      {"title": "内容关键词搜索", "status": "supported", "path": "/api/v1/data/search", "requestExample": "{\n  \"platform\": \"douyin\",\n  \"query\": \"人工智能\",\n  \"pageSize\": 20\n}"},
      {"title": "商品关键词搜索", "status": "supported", "path": "/api/v1/data/ecommerce/products/search", "requestExample": "marketplace=douyin_ec"},
      {"title": "获取某条内容下面的评论", "status": "supported"},
      {"title": "抖音热点榜", "status": "planned"},
    ],
  },
  {
    "slug": "weibo",
    "name": "微博",
    "aliases": [
      "weibo",
      "微博热搜/话题榜"
    ],
    "operations": [
      {"title": "内容关键词搜索", "status": "supported", "path": "/api/v1/data/search", "requestExample": "{\n  \"platform\": \"weibo\",\n  \"query\": \"人工智能\",\n  \"pageSize\": 20\n}"},
      {"title": "获取某条内容下面的评论", "status": "supported"},
      {"title": "微博热搜/话题榜", "status": "planned"},
    ],
  },
  {
    "slug": "kuaishou",
    "name": "快手",
    "aliases": [
      "快手小店"
    ],
    "operations": [
      {"title": "内容关键词搜索", "status": "supported", "path": "/api/v1/data/search", "requestExample": "{\n  \"platform\": \"kuaishou\",\n  \"query\": \"人工智能\",\n  \"pageSize\": 20\n}"},
      {"title": "获取某条内容下面的评论", "status": "planned"},
      {"title": "商品关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "bilibili",
    "name": "哔哩哔哩",
    "aliases": [
      "B站",
      "B站排行榜/热榜"
    ],
    "operations": [
      {"title": "内容关键词搜索", "status": "supported", "path": "/api/v1/data/search", "requestExample": "{\n  \"platform\": \"bilibili\",\n  \"query\": \"人工智能\",\n  \"pageSize\": 20\n}"},
      {"title": "获取某条内容下面的评论", "status": "supported"},
      {"title": "B站排行榜/热榜", "status": "planned"},
    ],
  },
  {
    "slug": "zhihu",
    "name": "知乎",
    "operations": [
      {"title": "内容关键词搜索", "status": "supported", "path": "/api/v1/data/search", "requestExample": "{\n  \"platform\": \"zhihu\",\n  \"query\": \"城市\",\n  \"pageSize\": 20,\n  \"params\": {\n    \"sort\": \"created_time\"\n  }\n}"},
    ],
  },
  {
    "slug": "facebook",
    "name": "Facebook",
    "aliases": [
      "Facebook Marketplace"
    ],
    "operations": [
      {"title": "内容关键词搜索", "status": "supported", "path": "/api/v1/data/search", "requestExample": "{\n  \"platform\": \"facebook\",\n  \"query\": \"人工智能\",\n  \"pageSize\": 20\n}"},
      {"title": "获取某条内容下面的评论", "status": "unknown"},
      {"title": "商品关键词搜索（Facebook Marketplace）", "status": "planned"},
    ],
  },
  {
    "slug": "instagram",
    "name": "Instagram",
    "operations": [
      {"title": "内容关键词搜索", "status": "supported", "path": "/api/v1/data/search", "requestExample": "{\n  \"platform\": \"instagram\",\n  \"query\": \"人工智能\",\n  \"pageSize\": 20\n}"},
      {"title": "获取某条内容下面的评论", "status": "supported"},
    ],
  },
  {
    "slug": "youtube",
    "name": "YouTube",
    "aliases": [
      "YouTube（视频评论）",
      "YouTube（频道评论）"
    ],
    "operations": [
      {"title": "内容关键词搜索", "status": "supported", "path": "/api/v1/data/search", "requestExample": "{\n  \"platform\": \"youtube\",\n  \"query\": \"city\",\n  \"pageSize\": 20\n}"},
      {"title": "获取某条内容下面的评论（视频评论）", "status": "supported", "path": "/api/v1/data/youtube/comments"},
      {"title": "获取某条内容下面的评论（频道评论）", "status": "supported", "path": "/api/v1/data/youtube/channel-comments"},
    ],
  },
  {
    "slug": "reddit",
    "name": "Reddit",
    "operations": [
      {"title": "内容关键词搜索", "status": "supported", "path": "/api/v1/data/search", "requestExample": "{\n  \"platform\": \"reddit\",\n  \"query\": \"人工智能\",\n  \"pageSize\": 20\n}"},
      {"title": "获取某条内容下面的评论", "status": "supported"},
    ],
  },
  {
    "slug": "tiktok",
    "name": "TikTok",
    "operations": [
      {"title": "内容关键词搜索（标准）", "status": "supported", "path": "/api/v1/data/search", "requestExample": "{\n  \"platform\": \"tiktok\",\n  \"query\": \"城市\",\n  \"pageSize\": 20\n}"},
      {"title": "内容关键词搜索（原生）", "status": "supported", "path": "/api/v1/data/native/t.api_e806cdfabc136655", "requestExample": "{\n  \"params\": {\n    \"keyword\": \"城市\",\n    \"offset\": 0\n  }\n}"},
      {"title": "获取某条内容下面的评论", "status": "supported"},
    ],
  },
  {
    "slug": "telegram",
    "name": "Telegram",
    "operations": [
      {"title": "指定群/频道已有消息", "status": "supported", "path": "/api/v1/data/telegram/messages", "requestExample": "{\n  \"sourceScope\": \"all\",\n  \"chatId\": \"<真实群ID或chatKey>\",\n  \"pageSize\": 20\n}"},
      {"title": "命中消息双向时间线首屏", "status": "supported", "path": "/api/v1/data/canonical/items/{id}/timeline", "requestExample": "{\n  \"before\": 10,\n  \"after\": 10\n}"},
      {"title": "时间线续页", "status": "supported", "path": "/api/v1/data/canonical/items/{id}/timeline", "requestExample": "{\n  \"cursor\": \"<原方向返回的Hub cursor>\"\n}"},
      {"title": "关键词命中", "status": "supported", "path": "/api/v1/data/telegram/search", "requestExample": "{\n  \"query\": \"人工智能\",\n  \"sourceScope\": \"all\",\n  \"scope\": \"messages\",\n  \"matchMode\": \"full_text\",\n  \"pageSize\": 20\n}"},
    ],
  },
  {
    "slug": "wechat-official-accounts",
    "name": "微信公众号",
    "operations": [
      {"title": "内容关键词搜索", "status": "supported", "path": "/api/v1/data/wechat/search/search", "requestExample": "{\n  \"params\": {\n    \"keyword\": \"人工智能\"\n  }\n}"},
    ],
  },
  {
    "slug": "wechat-search",
    "name": "微信搜索",
    "operations": [
      {"title": "内容关键词搜索", "status": "supported", "path": "/api/v1/data/wechat/search/search", "requestExample": "{\n  \"params\": {\n    \"keyword\": \"人工智能\"\n  }\n}"},
    ],
  },
  {
    "slug": "news-sites",
    "name": "新闻/组织网站",
    "operations": [
      {"title": "内容关键词搜索", "status": "supported", "path": "/api/v1/data/news/search", "requestExample": "{\n  \"query\": \"人工智能\",\n  \"binding\": \"all\",\n  \"timeField\": \"publishedAt\",\n  \"pageSize\": 20\n}"},
    ],
  },
  {
    "slug": "wechat-channels",
    "name": "微信视频号",
    "operations": [
      {"title": "内容关键词搜索", "status": "supported", "path": "/api/v1/data/wechat/search/search-videos", "requestExample": "{\n  \"params\": {\n    \"keyword\": \"城市\",\n    \"sort\": \"latest\",\n    \"publish_time\": \"week\",\n    \"duration\": \"all\",\n    \"raw\": false\n  },\n  \"deliveryMode\": \"live_only\"\n}"},
    ],
  },
  {
    "slug": "凤凰号/凤凰新闻",
    "name": "凤凰号/凤凰新闻",
    "operations": [
      {"title": "内容关键词搜索", "status": "supported"},
    ],
  },
  {
    "slug": "腾讯新闻",
    "name": "腾讯新闻",
    "operations": [
      {"title": "内容关键词搜索", "status": "supported"},
    ],
  },
  {
    "slug": "网易新闻",
    "name": "网易新闻",
    "operations": [
      {"title": "内容关键词搜索", "status": "supported"},
    ],
  },
  {
    "slug": "新浪新闻",
    "name": "新浪新闻",
    "operations": [
      {"title": "内容关键词搜索", "status": "supported"},
    ],
  },
  {
    "slug": "澎湃新闻",
    "name": "澎湃新闻",
    "operations": [
      {"title": "内容关键词搜索", "status": "supported"},
    ],
  },
  {
    "slug": "threads",
    "name": "Threads",
    "operations": [
      {"title": "内容关键词搜索", "status": "supported"},
    ],
  },
  {
    "slug": "百度新闻",
    "name": "百度新闻",
    "operations": [
      {"title": "内容关键词搜索", "status": "supported"},
    ],
  },
  {
    "slug": "linkedin",
    "name": "LinkedIn",
    "operations": [
      {"title": "获取某条内容下面的评论", "status": "supported"},
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "taobao",
    "name": "淘宝",
    "operations": [
      {"title": "商品关键词搜索", "status": "supported", "path": "/api/v1/data/ecommerce/products/search", "requestExample": "{\n  \"marketplace\": \"taobao\",\n  \"query\": \"耳机\",\n  \"deliveryMode\": \"cache_first\"\n}\n\ncurl -sS -X POST \\\n  \"$HUB_URL/api/v1/data/ecommerce/products/search\" \\\n  -H \"Authorization: Bearer $HUB_KEY\" \\\n  -H \"Content-Type: application/json\" \\\n  -H \"Idempotency-Key: ecommerce-taobao-$(uuidgen)\" \\\n  -d '{\n    \"marketplace\": \"taobao\",\n    \"query\": \"AI录音笔\",\n    \"sort\": \"sales_desc\",\n    \"deliveryMode\": \"cache_first\"\n  }' | jq"},
    ],
  },
  {
    "slug": "tmall",
    "name": "天猫",
    "operations": [
      {"title": "商品关键词搜索", "status": "supported", "path": "/api/v1/data/ecommerce/products/search", "requestExample": "{\n  \"marketplace\": \"tmall\",\n  \"query\": \"耳机\",\n  \"deliveryMode\": \"cache_first\"\n}"},
    ],
  },
  {
    "slug": "jd",
    "name": "京东",
    "operations": [
      {"title": "商品关键词搜索", "status": "supported", "path": "/api/v1/data/ecommerce/products/search", "requestExample": "{\n  \"marketplace\": \"jd\",\n  \"query\": \"耳机\",\n  \"deliveryMode\": \"cache_first\"\n}"},
    ],
  },
  {
    "slug": "xianyu",
    "name": "闲鱼",
    "operations": [
      {"title": "商品关键词搜索", "status": "supported", "path": "/api/v1/data/ecommerce/products/search", "requestExample": "{\n  \"marketplace\": \"xianyu\",\n  \"query\": \"耳机\",\n  \"deliveryMode\": \"cache_first\"\n}"},
    ],
  },
  {
    "slug": "qixin",
    "name": "启信宝",
    "operations": [
      {"title": "企业数据获取", "status": "supported"},
    ],
  },
  {
    "slug": "email-directory",
    "name": "邮箱库",
    "operations": [
      {"title": "邮箱库", "status": "supported", "path": "/api/v1/data/email-directory/search", "requestExample": "curl -sS -X POST \"$HUB_URL/api/v1/data/email-directory/search\" \\\n  -H \"Authorization: Bearer YOUR_HUB_API_KEY\" -H \"Content-Type: application/json\" \\\n  -d '{\"mode\":\"domain\",\"query\":\"example.com\",\"limit\":50}'"},
    ],
  },
  {
    "slug": "phone-directory",
    "name": "手机号库",
    "operations": [
      {"title": "手机号库", "status": "supported", "path": "/api/v1/data/phone-directory/search", "requestExample": "curl -sS -X POST \"$HUB_URL/api/v1/data/phone-directory/search\" \\\n  -H \"Authorization: Bearer YOUR_HUB_API_KEY\" -H \"Content-Type: application/json\" \\\n  -d '{\"mode\":\"prefix\",\"query\":\"+1 415\"}'\n"},
    ],
  },
  {
    "slug": "百度贴吧",
    "name": "百度贴吧",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "百家号",
    "name": "百家号",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "搜狐号",
    "name": "搜狐号",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "网易号",
    "name": "网易号",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "企鹅号",
    "name": "企鹅号",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "观察者网",
    "name": "观察者网",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "雪球",
    "name": "雪球",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "BOSS直聘",
    "name": "BOSS直聘",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "汽车之家",
    "name": "汽车之家",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "nga",
    "name": "NGA",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "小宇宙",
    "name": "小宇宙",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "喜马拉雅",
    "name": "喜马拉雅",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "twitch",
    "name": "Twitch",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "pinterest",
    "name": "Pinterest",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "quora",
    "name": "Quora",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "medium",
    "name": "Medium",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "Snapchat Spotlight",
    "name": "Snapchat Spotlight",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "mastodon",
    "name": "Mastodon",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "dailymotion",
    "name": "Dailymotion",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "rumble",
    "name": "Rumble",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "kick",
    "name": "Kick",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "substack",
    "name": "Substack",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "WordPress.com",
    "name": "WordPress.com",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "bing",
    "name": "Bing",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "搜狗搜索",
    "name": "搜狗搜索",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "360搜索",
    "name": "360搜索",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "Google News",
    "name": "Google News",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "地方媒体网站",
    "name": "地方媒体网站",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "行业垂直媒体",
    "name": "行业垂直媒体",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "论坛站点",
    "name": "论坛站点",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "博客站点",
    "name": "博客站点",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "代码仓库",
    "name": "代码仓库",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "学术论文/预印本",
    "name": "学术论文/预印本",
    "operations": [
      {"title": "内容关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "拼多多",
    "name": "拼多多",
    "operations": [
      {"title": "商品关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "饿了么",
    "name": "饿了么",
    "operations": [
      {"title": "商品关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "amazon",
    "name": "Amazon",
    "operations": [
      {"title": "商品关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "ebay",
    "name": "eBay",
    "operations": [
      {"title": "商品关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "aliexpress",
    "name": "AliExpress",
    "operations": [
      {"title": "商品关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "temu",
    "name": "Temu",
    "operations": [
      {"title": "商品关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "shein",
    "name": "Shein",
    "operations": [
      {"title": "商品关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "etsy",
    "name": "Etsy",
    "operations": [
      {"title": "商品关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "shopee",
    "name": "Shopee",
    "operations": [
      {"title": "商品关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "Mercado Libre",
    "name": "Mercado Libre",
    "operations": [
      {"title": "商品关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "flipkart",
    "name": "Flipkart",
    "operations": [
      {"title": "商品关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "craigslist",
    "name": "Craigslist",
    "operations": [
      {"title": "商品关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "Shopify 独立站",
    "name": "Shopify 独立站",
    "operations": [
      {"title": "商品关键词搜索", "status": "planned"},
    ],
  },
  {
    "slug": "QQ群",
    "name": "QQ群",
    "operations": [
      {"title": "群聊关键词搜索及时间线获取", "status": "planned"},
    ],
  },
  {
    "slug": "信用中国",
    "name": "信用中国",
    "operations": [
      {"title": "企业数据获取", "status": "planned"},
    ],
  },
  {
    "slug": "企查查",
    "name": "企查查",
    "operations": [
      {"title": "企业数据获取", "status": "planned"},
    ],
  },
  {
    "slug": "天眼查",
    "name": "天眼查",
    "operations": [
      {"title": "企业数据获取", "status": "planned"},
    ],
  },
  {
    "slug": "爱企查",
    "name": "爱企查",
    "operations": [
      {"title": "企业数据获取", "status": "planned"},
    ],
  },
  {
    "slug": "ICP备案查询",
    "name": "ICP备案查询",
    "operations": [
      {"title": "企业数据获取", "status": "planned"},
    ],
  },
  {
    "slug": "WHOIS / ICANN Lookup",
    "name": "WHOIS / ICANN Lookup",
    "operations": [
      {"title": "企业数据获取", "status": "planned"},
    ],
  },
  {
    "slug": "DNS 记录",
    "name": "DNS 记录",
    "operations": [
      {"title": "企业数据获取", "status": "planned"},
    ],
  },
  {
    "slug": "SSL 证书透明日志",
    "name": "SSL 证书透明日志",
    "operations": [
      {"title": "企业数据获取", "status": "planned"},
    ],
  },
  {
    "slug": "builtwith",
    "name": "BuiltWith",
    "operations": [
      {"title": "企业数据获取", "status": "planned"},
    ],
  },
  {
    "slug": "similarweb",
    "name": "Similarweb",
    "operations": [
      {"title": "企业数据获取", "status": "planned"},
    ],
  },
  {
    "slug": "shodan",
    "name": "Shodan",
    "operations": [
      {"title": "企业数据获取", "status": "planned"},
    ],
  },
  {
    "slug": "UK Companies House",
    "name": "UK Companies House",
    "operations": [
      {"title": "企业数据获取", "status": "planned"},
    ],
  },
  {
    "slug": "Google Play",
    "name": "Google Play",
    "operations": [
      {"title": "应用程序搜索数据", "status": "planned"},
    ],
  },
  {
    "slug": "华为应用市场",
    "name": "华为应用市场",
    "operations": [
      {"title": "应用程序搜索数据", "status": "planned"},
    ],
  },
  {
    "slug": "小米应用商店",
    "name": "小米应用商店",
    "operations": [
      {"title": "应用程序搜索数据", "status": "planned"},
    ],
  },
  {
    "slug": "OPPO 软件商店",
    "name": "OPPO 软件商店",
    "operations": [
      {"title": "应用程序搜索数据", "status": "planned"},
    ],
  },
  {
    "slug": "vivo 应用商店",
    "name": "vivo 应用商店",
    "operations": [
      {"title": "应用程序搜索数据", "status": "planned"},
    ],
  },
  {
    "slug": "应用宝",
    "name": "应用宝",
    "operations": [
      {"title": "应用程序搜索数据", "status": "planned"},
    ],
  },
  {
    "slug": "百度指数",
    "name": "百度指数",
    "operations": [
      {"title": "百度指数", "status": "planned"},
    ],
  },
  {
    "slug": "Google Trends",
    "name": "Google Trends",
    "operations": [
      {"title": "Google Trends", "status": "planned"},
    ],
  },
  {
    "slug": "今日热榜类聚合站",
    "name": "今日热榜类聚合站",
    "operations": [
      {"title": "今日热榜类聚合站", "status": "planned"},
    ],
  },
  {
    "slug": "飞瓜数据",
    "name": "飞瓜数据",
    "operations": [
      {"title": "飞瓜数据", "status": "planned"},
    ],
  },
];
