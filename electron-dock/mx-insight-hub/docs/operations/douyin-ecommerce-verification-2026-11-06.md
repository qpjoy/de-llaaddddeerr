# 抖音电商接口与字段核验（2026-11-06）

结论：JustOne 现行抖音电商目录的 6 个接口，Hub 已全部登记，方法、路径和参数合同与当日官方 OpenAPI 一致。本次授权的两次实际调用分别验证了**商品搜索和基础详情可用**；不代表 SKU、评论、店铺列表及完整商品字段均已实时验收。

本次使用 Night-All 本地既有 JustOne 凭据，通过 Hub 的 `JustOneAdapter.searchProducts` / `forwardNative` 直接调用供应商；没有经生产 Hub Public API，也没有生产 Hub requestId 或客户账单。因此不据此推定生产 Hub 当前凭据、授权、报价、运行开关或熔断已通过验收。未部署、未操作生产数据库，未修改 Launcher、Auth、MX-H2I 登录或联网。

## 接口覆盖

Hub 原生入口均为 `POST /api/v1/data/native/<键>`，参数放入 `params`；供应商接口均为 GET，下表路径前缀为 `/api/douyin-ec/`。`itemId` / `shopId` 必须使用对应商品/店铺的字符串 ID，不能混用 `promotion_id`、关键词或 JavaScript 已舍入的长整数。

| 接口 | Hub 原生键 | 上游路径 | 参数 | 本次实时验证 |
| --- | --- | --- | --- | --- |
| 商品搜索 V1 | `j.api_f6ea6dfd00969e8f` | `search-item-list/v1` | 必填 `keyword:string`；可选 `page:string`、`searchId:string`（默认空） | 成功，30 条 |
| 商品详情 V2 | `j.api_428cf0b9fc142162` | `get-item-detail/v2` | 必填 `itemId:string` | 基础信息成功，扩展模块不完整 |
| SKU V1 | `j.api_6cbe0d4d445175a6` | `get-item-sku-info/v1` | 必填 `itemId:string` | 未调用 |
| SKU V2 | `j.api_da0ada7f35b91baa` | `get-item-sku-info/v2` | 必填 `itemId:string` | 未调用 |
| 商品评论 V1 | `j.api_906cfcd9d2654192` | `get-item-comments/v1` | 必填 `itemId:string`；可选 `page:string` | 未调用 |
| 店铺商品 V1 | `j.api_9278fa14334f6fb2` | `get-shop-item-list/v1` | 必填 `shopId:string`；可选 `page:string` | 未调用 |

六份官方 OpenAPI 均 HTTP 200，与本地登记的参数类型、必填性和默认值 6/6 匹配；其业务响应 `data` schema 均为 `{}`，只能证明接口合同覆盖，不能证明业务字段完整。官方 SKU V1 说明完整度较高但成功率低，SKU V2 说明可能不完整、不支持的商品可能返回 202；两者不能视为同等的完整 SKU 保证。

官方来源：[目录](https://docs.justoneapi.com/en/api/douyin-e-commerce/)、[搜索](https://docs.justoneapi.com/en/api/douyin-e-commerce/product-search-v1)、[详情](https://docs.justoneapi.com/en/api/douyin-e-commerce/item-details-v2)、[SKU V1](https://docs.justoneapi.com/en/api/douyin-e-commerce/product-sku-info-v1)、[SKU V2](https://docs.justoneapi.com/en/api/douyin-e-commerce/product-sku-info-v2)、[评论](https://docs.justoneapi.com/en/api/douyin-e-commerce/item-comments-v1)、[店铺商品](https://docs.justoneapi.com/en/api/douyin-e-commerce/shop-product-list-v1)。各 OpenAPI URL、SHA-256 和参数对比见[结构化证据](evidence/douyin-ecommerce-verification-2026-11-06.json)。

## 两次实测及付费边界

| 项目 | 搜索 | 详情 |
| --- | --- | --- |
| 北京时间 | 2026-11-06 10:30:26 | 2026-11-06 10:31:15 |
| 输入 | `小米手机`，首页 | 前一响应中的首个真实 `product_id` |
| 上游 requestId | `ab4493888deb41ebb6a578d8dae8d512` | `9d57426502a54f3795c9fb7c5fd4f483` |
| HTTP | 适配器已接受 2xx；首次脚本未独立保存具体状态码 | 200，已记录 |
| 业务码 | 0 | 0 |
| 原始响应大小 | 186997 字节 | 5288 字节 |
| 结果 | 30/30 归一化，无丢弃；有续页信息 | 同一商品 ID/标题，基础商品与店铺信息存在 |

两次均单次派发、无重试，已用完本次最多 2 次请求额度。按 JustOne 的 `code=0` 成功调用计费口径，两次都归类为供应商计费成功；没有查询供应商余额流水，不填写推测金额。失败、不确定结果也不会触发自动补采。原始响应仅保留在本机私有临时目录；仓库证据只有哈希、结构和计数，不含凭据、查询令牌、真实商品 ID 或签名图片链接。

## 字段对齐和缺口

| 标准字段/语义 | 真实搜索来源 | 本次结果 |
| --- | --- | --- |
| `id:string` | `promotions[].product_id` | 30/30 为字符串，精确保留；不使用 `promotion_id` |
| `title` | `base_info.title` | 30/30；沿用标准文本去首尾空白 |
| `url` / `urlSource` | `base_info.detail_url` | 30/30，`upstream`；保留供应商链接 |
| `images` | `base_info.main_img.url_list` | 30/30 有图片 |
| `pricing.current/original` | `base_info.price` | 30/30 上游 `null`，不能推算价格或单位 |
| `shop.id/name`、销量 | 搜索样本未提供已校准字段 | 保持空值，不能当成 0 或伪造店铺 |
| `page.hasMore` | `data.has_more` | `true` |
| 下一页 | `data.extra.search_id` → Hub 签名 cursor → 上游 `searchId` | 离线验证转换正确；真实第 2 页未调用 |

统一入口仍为 `POST /api/v1/data/ecommerce/products/search`，`marketplace=douyin_ec`，公开合同 `mx-insight-hub.ecommerce-products.v1`。`query→keyword`；首页为 page 1，后续页使用 Hub cursor 并保持 query。抖音不支持该合同中的 sort、price 或自定义 pageSize，不接受直接 page 2 跳过 continuation。

详情原生返回 `data` 原样保留业务结构，本次样本与搜索的商品 ID、标题匹配：

- `model.product.product_base`：标题、封面、5 张 `images`、7 张 `big_imgs`。
- `model.shop.shop_id`、`model.shop.shop_base.shop_name`：店铺 ID 和店铺名均有值。
- `model.product.product_sales` / `product_comment`：有销量及好评相关字段；没有把这些独立详情字段自动补入统一搜索或额外计费采集。
- 整个详情样本未发现 price/amount/currency 字段；价格仍未核验。
- `promotion_data`、`comment_data`、`author_data`、`content_data`、`hot_content_data`、`shop_product_data`、`material_data` 七个模块均 `code=-1`。顶层成功不等于这些模块成功，也不等于独立评论/店铺接口失败。

若下游需要 SKU 价格、评论明细或店铺全量商品，应分别消费对应原生合同并单独验收；本次没有引入自动详情/SKU补采或改变既有计费行为。

## 本次修正与验证

1. 抖音投影拒绝不安全 numeric ID、布尔值、小数、零及负数，防止长数字被 JSON 解析舍入后发布成错误商品身份；继续接受原始字符串和正安全整数，原始响应与被丢弃条目证据仍保留。
2. 来源目录补入 `source-catalog-0062`，抖音显示“JustOne · 商品搜索已接”；同步文档和既有断言。该标记只说明合同覆盖，快手小店仍保持商品搜索接入线索。
3. 删除浏览说明中无日期的“尚待部署”结论，改为区分合同、运行配置及带日期的实测证据。

新增身份回归在修改前失败、修改后通过。8 个针对性测试文件合计 101 项：99 通过、2 项 PostgreSQL 环境测试跳过；本地端口测试最初受沙箱 EPERM 阻拦，允许 localhost 后重跑通过。类型检查通过。两份真实响应 SHA-256 验证后在修正后的适配器离线回放通过，核对 30 条身份/标题/链接/图片、空价格、cursor→searchId 以及详情业务对象保留；离线回放额外网络调用为 0。

以上修正仅在本地，尚未部署。没有为了验证而改动生产价格、余额、权限、路由或开关；MX-H2I 登录和联网相关代码未改动。

## 补充核验：真实第 2 页与 `summary_promotions`（2026-11-06 10:59）

另一轮授权的 2 次付费调用，同样使用 Night-All 本地 JustOne 凭据直连 `search-item-list/v1`，关键词 `手机`，不经生产 Hub：

| 调用 | 输入 | 上游 requestId | 业务码 | 结果 |
| --- | --- | --- | --- | --- |
| 第 1 页 | `page=1` | `34bc690cbfbe40a793da9c6d5b0266ec` | 0 | 30 条，`has_more=true`，`total=500`，`extra.search_id` 有值 |
| 第 2 页 | `page=2`，`searchId`=第 1 页 `data.extra.search_id`（Hub 现行续页写法，约 36 秒后） | `5c7b65f89e38460abe2a466ad32ca898` | 0 | **0 条，`has_more=false`，`total=0`，`extra=null`** |

账户余额在两次调用前后由 46.90 降至 45.40 CNY；该凭据可能同时被其他服务使用，因此不能精确归因到单次调用。可以确认的是，空的第 2 页同样返回 `code=0`，应按计费处理。

**翻页结论：** Hub 依据第 1 页的 `has_more=true` 签发 cursor，下一页按文档使用 `page=2` 和 `searchId`，但真实调用拿到的是计费空页。文档写法本身没有效果。在找到有效的续页参数之前，抖音的 `nextCursor` 会把调用方引向一次付费空页。是否另有可用写法，例如不带 `searchId`、页码从 0 开始或需要 `session_id`，尚未付费验证。

**字段结论：** 同一响应还带有 `data.summary_promotions[]`，与 `promotions[]` 按下标一一对应，30/30 的 `product_id` 和 `promotion_id` 完全相同。它提供了统一搜索目前留空的字段：

| 标准字段 | 来源（`summary_promotions[i].base_model`） | 样本情况 |
| --- | --- | --- |
| `pricing.current` | `marketing_info.price_desc.price.origin`（`price_text=到手价`） | 30/30；`origin` 恒等于展示值 × 100，即单位为分 |
| `shop.id` / `shop.name` | `shop_info.shop_id`（安全整数，`extend_info.data_report.shop_id` 为同值字符串）/ `shop_info.shop_name` | 30/30 |
| `signals.sales` | `product_info.month_sale.origin`（`month_sale_text=月销`） | 30/30；语义为月销量 |
| `attributes.category` | `product_info.category.first/second_category.category_name` | 30/30 |
| （无标准字段） | `product_info.good_ratio`（好评率） | 13/30 |

上一节「搜索样本未提供店铺、销量」「价格为空」只适用于 `promotions[].base_info`，不能代表整个响应。

**数据来源语义：** `extend_info.data_report.scene=PCSquareSearch`、`custom_model.selection_square_model`、佣金字段 `promotion_info.cos_info` 和合作达人数 `cooper_author_num` 都表明，这个接口搜索的是抖音**精选联盟选品广场**中可推广的商品，并非全量店铺商品。

Hub 解析器用当前本地代码离线回放第 1 页：30/30 条只填了 `id`、`title`、`url`、`images`，价格、店铺、销量和类目均为 `null`，并签发了指向第 2 页的 cursor。代码未改动。

### 翻页追加排查与修复（同日，本地，未部署）

用户随后授权最多 3 次付费调用，用于排查第 2 页：

| 调用 | 输入 | 上游 requestId | 结果 |
| --- | --- | --- | --- |
| 第 2 页（不带 `searchId`） | `手机`，`page=2` | `d9fc0ec2e8f9434385b428082fe48dfe` | `code=0`，0 条，`has_more=false`，`total=0`，`extra=null` |
| 新关键词首页 | `耳机`，`page=1` | `317ad71dca3c4a3e8e8a9d86de987405` | `code=301 COLLECT FAILED, SEND REQUEST AGAIN`（31.9 秒），未接着请求第 2 页 |

两次调用后余额由 45.40 降至 45.25 CNY。原计划用第 3 次调用验证「拿到 search_id 后立即续页」，但该次首页失败，剩余 1 次额度不足以重新取首页再续页，因此没有使用。结论是：第 2 页无论带不带 `searchId` 都是计费空页。即使紧接着续页可能有效，Hub 的下一页也来自调用方之后的另一次请求，36 秒后的尝试已经失败，Hub 无法保证续页时效。

修复（`server/contracts/justone.mjs`）：

- **只取首页**：`douyin_ec` 定义为 `singlePage`。首页即使上游 `has_more=true`，也返回 `hasMore=null`、`nextCursor=null`。`page>1` 和此前签发的抖音 cursor 在派发前返回 `400 pagination_unavailable`，不再付费拿空页。小红书电商的 continuation 不受影响。
- **字段映射**：`projectDouyinProduct` 读取同下标的 `summary_promotions`，只有 `product_id` 与 `promotion_id` 都完全一致时才使用。
  - `pricing.current`：`price.origin` 必须恰好等于展示的整数和小数部分 × 100，否则留空，避免误换算单位。
  - `shop.id`：安全整数直接转成字符串；超出安全整数时，只采用数值相同的 `data_report.shop_id` 文本。
  - `signals.sales`：取月销。
  - `attributes.category`：取最末一级非空类目名。
- **归档**：逐条归档仍保存原 `promotions[i]` 元素，选品卡留在整份响应归档中。

用真实首页离线回放，30/30 条的价格、店铺、月销和类目都有值。公开文档和「电商数据」页面的提示已同步。
