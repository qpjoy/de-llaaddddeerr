# MX Insight Hub 电商数据接口参考

本文面向 MX-H2I、Luopan、DataPort 及其他业务应用，说明 MX Insight Hub 当前电商数据接口的调用方式、参数、返回结构和平台覆盖范围。调用方只需要 Hub Public API Key；供应商地址、供应商密钥、代理和路由策略由 Hub 管理。

当前统一商品搜索支持淘宝、天猫、京东、闲鱼、小红书电商和抖音电商。其余平台按各自接口调用。第 9 节列出 21 个平台的入口、请求和验证结果，包括按城市搜索 Facebook Marketplace、按地区搜索 Craigslist 和按店铺搜索 Shopify。

> 当前文档对应 Hub 工作树中的最新接口注册表。通用 Apify 采集能力目前是 candidate、未部署或未自动授权的异步能力；是否可调用仍以线上 Hub 的能力检查、Key 授权、路由配置和凭据状态为准。

## 1. 基本约定

### 1.1 地址和认证

```bash
export HUB_URL="https://hub.example.com"
export HUB_KEY="mih_live_xxx"
```

公共接口统一使用：

```http
Authorization: Bearer <mih_live_...>
```

POST 请求使用 `Content-Type: application/json`。会触发采集或转发的 POST 请求必须使用新的 `Idempotency-Key`；同一请求的网络重试必须复用原 Key 和原 body，下一页或新一轮查询必须使用新的 Key。

电商外部采集只接受 `mih_live_` Key。`mih_test_` 不是电商沙箱；使用 Test Key 会在供应商调用前返回 `403 test_key_not_supported`。调用方不应提交 JustOne、TikHub、Apify 或其他供应商密钥。

### 1.2 能力预检

```bash
curl -sS "$HUB_URL/api/v1/data/capabilities" \
  -H "Authorization: Bearer $HUB_KEY" | jq
```

返回外层通常包含：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data.platforms[]` | array | 当前 Key 可见的平台能力。电商项的 `platform` 为 `ecommerce`。 |
| `data.platforms[].ready` | boolean | Hub 当前是否具备执行条件；不代表每个 marketplace 都可用。 |
| `data.platforms[].capabilities` | array | 已公开的操作能力或 grant。 |
| `data.platforms[].operations` | object | 某些版本会返回逐操作 readiness。 |
| `requestId` | string | Hub 请求 ID。 |

完整参数定义以当前账户 OpenAPI 为准：

```bash
curl -sS "$HUB_URL/docs/openapi.json" \
  -H "Authorization: Bearer $HUB_KEY" > openapi.json
```

### 1.3 通用错误

| HTTP | 错误码 | 含义 |
| --- | --- | --- |
| `401` | `api_key_required` / `invalid_api_key` | 缺少、无效、过期或撤销的 Hub Key。 |
| `403` | `test_key_not_supported` | 电商外部采集不接受 Test Key。 |
| `403` | `platform_not_granted` | 当前 consumer 或 Key 没有 `ecommerce` grant。 |
| `403` | `operation_not_granted` | 平台原生接口没有单独的 operation grant。 |
| `400` | `unsupported_request_field` | body 含有合同未声明的字段。 |
| `409` | `idempotency_conflict` | 同一 Idempotency-Key 对应了不同 body。 |
| `429` | `consumer_quota_exceeded` / `rate_limited` | consumer、套餐或供应商限额。 |
| `502` | `external_platform_rejected` | 上游明确拒绝或响应无法按合同解析。 |
| `503` | `ecommerce_route_unavailable` / `external_platform_unavailable` | Hub 路由、凭据、运行开关或供应商暂不可用。 |

## 2. 接口总览

| 能力 | Hub 接口 | 交付方式 | 当前覆盖 |
| --- | --- | --- | --- |
| 查看电商能力 | `GET /api/v1/data/capabilities` | 同步 | 当前 Key 的授权和 readiness |
| 统一商品搜索 | `POST /api/v1/data/ecommerce/products/search` | 同步；可读缓存或实时 | 淘宝、天猫、京东、闲鱼、小红书电商、抖音电商 |
| 商品图片安全中继 | `GET /api/v1/data/ecommerce/products/media` | 同步 GET | 读取已提交成功搜索中的图片 |
| 已存商品读取 | `GET /api/v1/data/ecommerce/products/items` | 同步 GET | 当前 consumer 已成功查询过的商品 |
| 平台原生转发 | `POST /api/v1/data/native/{endpointKey}` | 同步、`live_only` | 见第 4 节完整目录 |
| 异步采集能力 | `GET /api/v1/data/collect/capabilities` | 同步 GET | candidate 能力和引擎 readiness |
| 提交异步任务 | `POST /api/v1/data/collect/jobs` | `202` + 轮询 | Apify/runner 能力 |
| Shopify 店内商品搜索 | `POST /api/v1/data/collect/query` | 同步完成返回 `200`，排队返回 `202` | 支持免令牌 Storefront 搜索的公开店铺 |
| 批量异步任务 | `POST /api/v1/data/collect/batches` | `202` + 轮询 | 最多 100 个 item |
| Night-All 历史兼容 | `POST /api/v1/night-all/search/{operation}` | 保留旧合同 | 逐步迁移中的历史接口 |

## 3. 统一商品搜索

### 3.1 `POST /api/v1/data/ecommerce/products/search`

Hub URL：

```text
${HUB_URL}/api/v1/data/ecommerce/products/search
```

请求头：

```http
Authorization: Bearer <HUB_KEY>
Content-Type: application/json
Idempotency-Key: <8–128 字符>
```

请求 body：

| 字段 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- |
| `marketplace` | string | 是 | `taobao`、`tmall`、`jd`、`xiaohongshu_ec`、`xianyu`、`douyin_ec`。 |
| `query` | string | 是 | trim 后 1–200 字符。 |
| `deliveryMode` | string | 否 | `cache_only`、`cache_first`、`refresh`、`live_only`；默认 `cache_first`。 |
| `page` | integer | 否 | `1..1000`，与 `cursor` 互斥。小红书电商从第二页起使用游标。抖音电商仅交付精选联盟首页。 |
| `cursor` | string | 否 | 上一页返回的 opaque `data.page.nextCursor`。不能解码或修改。 |
| `sort` | string | 否 | 淘宝/天猫：`relevance`、`sales_desc`、`price_asc`、`price_desc`；闲鱼：`relevance`、`recent`、`seller_credit`、`price_asc`、`price_desc`、`price_drop`、`newest`。京东、小红书电商、抖音电商不接受该字段。 |
| `price` | object | 否 | 只适用于淘宝/天猫；字段为 `min`、`max`，必须是 decimal string。 |

`cache_only` 不调用外部供应商；没有精确存量时返回 `404 stored_snapshot_not_found`。`refresh` 明确允许一次新的外部采集，必须使用新的 Idempotency-Key。`live_only` 只接受实时结果，不回退存量。

请求示例：

~~~bash
curl -sS -X POST \
  "$HUB_URL/api/v1/data/ecommerce/products/search" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ecommerce-taobao-$(uuidgen)" \
  -d '{
    "marketplace": "taobao",
    "query": "AI录音笔",
    "sort": "sales_desc",
    "price": {"min": "100", "max": "800"},
    "deliveryMode": "cache_first"
  }' | jq
~~~

抖音电商示例：

~~~bash
curl -sS -X POST \
  "$HUB_URL/api/v1/data/ecommerce/products/search" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ecommerce-douyin-$(uuidgen)" \
  -d '{
    "marketplace": "douyin_ec",
    "query": "无线耳机",
    "deliveryMode": "cache_first"
  }' | jq
~~~

成功输出：

~~~json
{
  "contractVersion": "mx-insight-hub.ecommerce-products.v1",
  "data": {
    "items": [
      {
        "id": "商品 ID 字符串",
        "marketplace": "taobao",
        "title": "商品标题",
        "url": "商品网页地址或 null",
        "appUrl": "经过校验的 App 地址，可选",
        "pricing": {
          "current": "199.00",
          "original": "299.00",
          "currency": "CNY"
        },
        "shop": {"id": "店铺 ID 或 null", "name": "店铺名称或 null"},
        "images": ["图片来源地址"],
        "signals": {
          "sales": "销量或 null",
          "reviewCount": "评价数或 null",
          "location": "位置或 null"
        },
        "attributes": {
          "brand": "品牌或 null",
          "category": "分类或 null"
        }
      }
    ],
    "page": {
      "page": 1,
      "returnedCount": 1,
      "discardedCount": 0,
      "hasMore": false,
      "nextCursor": null
    }
  },
  "meta": {
    "capturedAt": "2026-11-09T00:00:00.000Z",
    "servedAt": "2026-11-09T00:00:00.010Z",
    "sourceMode": "live",
    "ageSeconds": 0
  },
  "requestId": "Hub 请求 UUID"
}
~~~

`sourceMode` 可能是：

| 值 | 含义 |
| --- | --- |
| `live` | 本次真正调用了外部供应商。 |
| `fresh_cache` | 使用了同一规范化请求的有效缓存。 |
| `stored_fallback` | 实时请求失败后返回精确存量快照。 |
| `idempotent_replay` | 复用同一 Idempotency-Key 得到已提交结果。 |

下一页请求：

~~~bash
curl -sS -X POST \
  "$HUB_URL/api/v1/data/ecommerce/products/search" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ecommerce-next-$(uuidgen)" \
  -d '{
    "marketplace": "taobao",
    "query": "AI录音笔",
    "sort": "sales_desc",
    "cursor": "从上一响应复制的 data.page.nextCursor"
  }' | jq
~~~

### 3.2 `GET /api/v1/data/ecommerce/products/media`

Hub URL：

```text
${HUB_URL}/api/v1/data/ecommerce/products/media
```

该接口不是任意 URL 代理，只能读取同一 consumer 已成功提交的商品搜索响应中的图片。

| Query 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `requestId` | UUID | 是 | 商品搜索成功响应顶层的 `requestId`。 |
| `itemId` | string | 是 | 对应响应 `data.items[].id`。 |
| `imageIndex` | integer | 是 | `0..19`。 |

请求示例：

~~~bash
curl -sS -G \
  "$HUB_URL/api/v1/data/ecommerce/products/media" \
  -H "Authorization: Bearer $HUB_KEY" \
  --data-urlencode "requestId=<search-request-id>" \
  --data-urlencode "itemId=<product-id>" \
  --data-urlencode "imageIndex=0" \
  --output product-image
~~~

成功时直接返回 JPEG、PNG 或 WebP 二进制内容，不返回 JSON。响应包含实际 `Content-Type`、`Cache-Control: private, no-store` 和 `X-Content-Type-Options: nosniff`。

### 3.3 `GET /api/v1/data/ecommerce/products/items`

该接口读取当前 consumer 已成功查询过的商品，不触发外部采集。

常用 Query 参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `marketplace` | string | 否 | 平台筛选。 |
| `query` | string | 否 | 商品查询词筛选，最长 200 字符。 |
| `pageSize` | integer | 否 | 默认 10，上限 100。 |
| `cursor` | string | 否 | 已返回的存量游标。 |
| `minPrice` / `maxPrice` | decimal string | 否 | 价格范围，最多 12 位整数和 2 位小数。 |
| `from` / `to` | ISO 8601 string | 否 | 按记录时间筛选。 |

~~~bash
curl -sS -G \
  "$HUB_URL/api/v1/data/ecommerce/products/items" \
  -H "Authorization: Bearer $HUB_KEY" \
  --data-urlencode "marketplace=taobao" \
  --data-urlencode "query=AI录音笔" \
  --data-urlencode "pageSize=20" | jq
~~~

输出为当前 consumer 范围内的存量商品列表和 `pageInfo`：`returnedCount`、`hasMore`、`nextCursor`、`asOf`，并带 `sourceMode=stored_inventory`。每个 item 还可能带 `media[]`，其中包含 `originalUrl` 和对应的 Hub `hubUrl`。它不应用 Admin 管理端的编辑结果，也不重新调用供应商。

## 4. 平台原生转发

### 4.1 统一转发合同

所有平台原生接口都使用：

```text
POST ${HUB_URL}/api/v1/data/native/{endpointKey}
```

Hub 内部再按固定注册表转发到供应商的 method/path。调用方只能传注册表声明的参数，不能传 `token`、`cookie`、`authorization`、`proxy`、供应商 URL 或供应商选择字段。

请求 body：

~~~json
{
  "params": {
    "接口声明的参数": "参数值"
  },
  "deliveryMode": "live_only"
}
~~~

输出外层：

~~~json
{
  "contractVersion": "mx-insight-hub.native-forwarding.v1",
  "endpoint": "t.xxxxx",
  "data": "保留该原生接口业务结构",
  "meta": {
    "capturedAt": "2026-11-09T00:00:00.000Z"
  },
  "requestId": "Hub 请求 UUID"
}
~~~

`data` 不转换成统一商品 `items`。列表、详情、评论、SKU、榜单和店铺字段以各自 OpenAPI 合同为准；接口不会自动补详情、自动翻页、自动重试或切换供应商。原生接口的 `data` 在 Hub 代码中有意保持业务结构，不存在跨平台共享的字段表；因此本节表格列出每个接口的输入参数和业务输出类别，完整业务字段以 `/docs/openapi.json` 中对应的 `data` schema 为准。

统一 curl 模板：

~~~bash
NATIVE_KEY="j.api_xxxxxxxxxxxxxxxx"

curl -sS -X POST \
  "$HUB_URL/api/v1/data/native/$NATIVE_KEY" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: native-$(uuidgen)" \
  -d '{
    "params": {
      "keyword": "机械键盘"
    },
    "deliveryMode": "live_only"
  }' | jq
~~~

### 4.2 原生接口完整目录

说明：参数名后面的“必填”表示必须放在 `params` 内；显示“默认”的字段可以省略。上游 method/path 是 Hub 的内部固定转发目标，调用方只访问左侧 Hub URL。

| 平台 | 接口 | endpointKey | Hub URL | Hub 内部转发 | 输入参数 `params` | 输出 `data` |
| --- | --- | --- | --- | --- | --- | --- |
| 闲鱼 | 商品搜索 | `j.xianyu_search_v1` | `/api/v1/data/native/j.xianyu_search_v1` | GET `/api/xianyu/search-item-list/v1` | keyword（必填）<br>page | 原生商品或榜单列表，字段随上游合同返回 |
| 快手电商 | 快手购物榜单/Kuaishou shopping top list | `t.kuaishou_ecommerce_shopping_top_list` | `/api/v1/data/native/t.kuaishou_ecommerce_shopping_top_list` | GET `/api/v1/kuaishou/app/fetch_shopping_top_list` | subTabId，默认 0<br>subTabName，默认 "" | 原生商品或榜单列表，字段随上游合同返回 |
| 快手电商 | 快手品牌榜单/Kuaishou brand top list | `t.kuaishou_ecommerce_brand_top_list` | `/api/v1/data/native/t.kuaishou_ecommerce_brand_top_list` | GET `/api/v1/kuaishou/app/fetch_brand_top_list` | subTabId，默认 0<br>subTabName，默认 "" | 原生商品或榜单列表，字段随上游合同返回 |
| 小红书电商 | 搜索商品/Search products | `t.xiaohongshu_ec_search_products` | `/api/v1/data/native/t.xiaohongshu_ec_search_products` | GET `/api/v1/xiaohongshu/app_v2/search_products` | keyword（必填）<br>page，默认 1<br>search_id，默认 ""<br>source，默认 "explore_feed" | 原生商品或榜单列表，字段随上游合同返回 |
| 小红书电商 | 获取商品详情/Get product detail | `t.xiaohongshu_ec_product_detail` | `/api/v1/data/native/t.xiaohongshu_ec_product_detail` | GET `/api/v1/xiaohongshu/app_v2/get_product_detail` | sku_id（必填）<br>source，默认 "mall_search"<br>pre_page，默认 "mall_search" | 原生商品或榜单列表，字段随上游合同返回 |
| 小红书电商 | 获取商品评论总览/Get product review overview | `t.xiaohongshu_ec_product_review_overview` | `/api/v1/data/native/t.xiaohongshu_ec_product_review_overview` | GET `/api/v1/xiaohongshu/app_v2/get_product_review_overview` | sku_id（必填）<br>tab，默认 2 | 原生商品或榜单列表，字段随上游合同返回 |
| 小红书电商 | 获取商品评论列表/Get product reviews | `t.xiaohongshu_ec_product_reviews` | `/api/v1/data/native/t.xiaohongshu_ec_product_reviews` | GET `/api/v1/xiaohongshu/app_v2/get_product_reviews` | sku_id（必填）<br>page，默认 0<br>sort_strategy_type，默认 0<br>share_pics_only，默认 0<br>from_page，默认 "score_page" | 原生商品或榜单列表，字段随上游合同返回 |
| 小红书电商 | 获取商品推荐列表/Get product recommendations | `t.xiaohongshu_ec_product_recommendations` | `/api/v1/data/native/t.xiaohongshu_ec_product_recommendations` | GET `/api/v1/xiaohongshu/app_v2/get_product_recommendations` | sku_id（必填）<br>cursor_score，默认 ""<br>region，默认 "US" | 原生商品或榜单列表，字段随上游合同返回 |
| TikTok Shop | 搜索商品列表V1/Search products list V1 | `t.tiktok_shop_search_products` | `/api/v1/data/native/t.tiktok_shop_search_products` | GET `/api/v1/tiktok/shop/web/fetch_search_products_list` | search_word（必填）<br>offset，默认 0<br>page_token，默认 ""<br>region，默认 "US" | 原生商品或榜单列表，字段随上游合同返回 |
| TikTok Shop | 搜索商品列表V2(移动端)/Search products list V2 (Mobile) | `t.tiktok_shop_search_products_v2` | `/api/v1/data/native/t.tiktok_shop_search_products_v2` | GET `/api/v1/tiktok/shop/web/fetch_search_products_list_v2` | search_word（必填）<br>offset，默认 0<br>page_token，默认 ""<br>region，默认 "US" | 原生商品或榜单列表，字段随上游合同返回 |
| TikTok Shop | 获取搜索关键词建议V2(移动端)/Get search keyword suggestions V2 (Mobile) | `t.tiktok_shop_search_word_suggestion` | `/api/v1/data/native/t.tiktok_shop_search_word_suggestion` | GET `/api/v1/tiktok/shop/web/fetch_search_word_suggestion_v2` | search_word（必填）<br>lang，默认 "en-US"<br>region，默认 "US" | 原生商品或榜单列表，字段随上游合同返回 |
| TikTok Shop | 获取商品详情V1(桌面端-数据完整)/Get product detail V1(Full data) | `t.tiktok_shop_product_detail` | `/api/v1/data/native/t.tiktok_shop_product_detail` | GET `/api/v1/tiktok/shop/web/fetch_product_detail` | product_id（必填）<br>seller_id，默认 ""<br>region，默认 "MY" | 原生商品或榜单列表，字段随上游合同返回 |
| TikTok Shop | 获取商品详情V3(移动端-数据完整)/Get product detail V3 (Full Data) | `t.tiktok_shop_product_detail_v3` | `/api/v1/data/native/t.tiktok_shop_product_detail_v3` | GET `/api/v1/tiktok/shop/web/fetch_product_detail_v3` | product_id（必填）<br>region，默认 "SG" | 原生商品或榜单列表，字段随上游合同返回 |
| TikTok Shop | 获取商品评论V2/Get product reviews V2 | `t.tiktok_shop_product_reviews` | `/api/v1/data/native/t.tiktok_shop_product_reviews` | GET `/api/v1/tiktok/shop/web/fetch_product_reviews_v2` | product_id（必填）<br>page_start，默认 1<br>sort_rule，默认 2<br>filter_type，默认 1<br>filter_value，默认 6<br>region，默认 "US" | 原生商品或榜单列表，字段随上游合同返回 |
| TikTok Shop | 获取商家商品列表V1/Get seller products list V1 | `t.tiktok_shop_seller_products` | `/api/v1/data/native/t.tiktok_shop_seller_products` | GET `/api/v1/tiktok/shop/web/fetch_seller_products_list` | seller_id（必填）<br>search_params，默认 ""<br>region，默认 "US" | 原生商品或榜单列表，字段随上游合同返回 |
| TikTok Shop | 获取商家商品列表V2(移动端)/Get seller products list V2 (Mobile) | `t.tiktok_shop_seller_products_v2` | `/api/v1/data/native/t.tiktok_shop_seller_products_v2` | GET `/api/v1/tiktok/shop/web/fetch_seller_products_list_v2` | seller_id（必填）<br>searchParams，默认 ""<br>region，默认 "US" | 原生商品或榜单列表，字段随上游合同返回 |
| TikTok Shop | 获取商品分类列表/Get product category list | `t.tiktok_shop_category_list` | `/api/v1/data/native/t.tiktok_shop_category_list` | GET `/api/v1/tiktok/shop/web/fetch_products_category_list` | region，默认 "US" | 原生商品或榜单列表，字段随上游合同返回 |
| TikTok Shop | 根据分类ID获取商品列表/Get products by category ID | `t.tiktok_shop_products_by_category` | `/api/v1/data/native/t.tiktok_shop_products_by_category` | GET `/api/v1/tiktok/shop/web/fetch_products_by_category_id` | category_id（必填）<br>offset，默认 0<br>region，默认 "US" | 原生商品或榜单列表，字段随上游合同返回 |
| TikTok Shop | 通过分享链接获取商品ID/Get Product ID by Share Link | `t.tiktok_shop_product_id_by_share_link` | `/api/v1/data/native/t.tiktok_shop_product_id_by_share_link` | GET `/api/v1/tiktok/shop/web/fetch_product_id_by_share_link` | share_link（必填）<br>region，默认 "US" | 原生商品或榜单列表，字段随上游合同返回 |
| TikTok Shop | 通过分享链接获取店铺ID/Get Shop ID by Share Link | `t.tiktok_shop_shop_id_by_share_link` | `/api/v1/data/native/t.tiktok_shop_shop_id_by_share_link` | GET `/api/v1/tiktok/shop/web/fetch_shop_id_by_share_link` | share_link（必填）<br>region，默认 "US" | 原生业务 data |
| 淘宝和天猫 | 商品详情 | `j.api_94ac939c44fe1d61` | `/api/v1/data/native/j.api_94ac939c44fe1d61` | GET `/api/taobao/get-item-detail/v1` | itemId（必填） | 原生商品或榜单列表，字段随上游合同返回 |
| 淘宝和天猫 | 商品详情 | `j.api_856af60d77b45388` | `/api/v1/data/native/j.api_856af60d77b45388` | GET `/api/taobao/get-item-detail/v2` | itemId（必填） | 原生商品或榜单列表，字段随上游合同返回 |
| 淘宝和天猫 | 商品详情 | `j.api_039a09523216f2d9` | `/api/v1/data/native/j.api_039a09523216f2d9` | GET `/api/taobao/get-item-detail/v3` | itemId（必填） | 原生商品或榜单列表，字段随上游合同返回 |
| 淘宝和天猫 | 商品详情 | `j.api_fb7cfc135e34374a` | `/api/v1/data/native/j.api_fb7cfc135e34374a` | GET `/api/taobao/get-item-detail/v4` | itemId（必填） | 原生商品或榜单列表，字段随上游合同返回 |
| 淘宝和天猫 | 商品详情 | `j.api_9933ef1f928f96ed` | `/api/v1/data/native/j.api_9933ef1f928f96ed` | GET `/api/taobao/get-item-detail/v5` | itemId（必填） | 原生商品或榜单列表，字段随上游合同返回 |
| 淘宝和天猫 | 商品详情 | `j.api_ccbb3474dacf18c7` | `/api/v1/data/native/j.api_ccbb3474dacf18c7` | GET `/api/taobao/get-item-detail/v6` | itemId（必填） | 原生商品或榜单列表，字段随上游合同返回 |
| 淘宝和天猫 | 商品详情 | `j.api_1c8ddb34f2cf6626` | `/api/v1/data/native/j.api_1c8ddb34f2cf6626` | GET `/api/taobao/get-item-detail/v8` | itemId（必填） | 原生商品或榜单列表，字段随上游合同返回 |
| 淘宝和天猫 | 商品详情 | `j.api_b44544cdd226f6ce` | `/api/v1/data/native/j.api_b44544cdd226f6ce` | GET `/api/taobao/get-item-detail/v9` | itemId（必填） | 原生商品或榜单列表，字段随上游合同返回 |
| 淘宝和天猫 | 商品评价 | `j.api_0dc2bfde105a5728` | `/api/v1/data/native/j.api_0dc2bfde105a5728` | GET `/api/taobao/get-item-comment/v3` | itemId（必填）<br>orderType，默认 "feedbackdate"<br>page，默认 1 | 原生商品或榜单列表，字段随上游合同返回 |
| 淘宝和天猫 | 商品问答 | `j.api_3dc65f4dd618773f` | `/api/v1/data/native/j.api_3dc65f4dd618773f` | GET `/api/taobao/get-social-feed/v1` | itemId（必填）<br>page，默认 1 | 原生商品或榜单列表，字段随上游合同返回 |
| 淘宝和天猫 | 店铺商品列表 | `j.api_dd28817cc5305693` | `/api/v1/data/native/j.api_dd28817cc5305693` | GET `/api/taobao/get-shop-item-list/v1` | userId（必填）<br>sort，默认 "_sale"<br>page，默认 1 | 原生商品或榜单列表，字段随上游合同返回 |
| 淘宝和天猫 | 店铺商品列表 | `j.api_72e7bfeac9e68c9e` | `/api/v1/data/native/j.api_72e7bfeac9e68c9e` | GET `/api/taobao/get-shop-item-list/v2` | userId（必填）<br>shopId（必填）<br>sort，默认 "sales-des"<br>page，默认 1 | 原生商品或榜单列表，字段随上游合同返回 |
| 淘宝和天猫 | 店铺商品列表 | `j.api_05196b0e85f968d6` | `/api/v1/data/native/j.api_05196b0e85f968d6` | GET `/api/taobao/get-shop-item-list/v3` | userId（必填）<br>shopId（必填）<br>sort，默认 "new"<br>page，默认 1 | 原生商品或榜单列表，字段随上游合同返回 |
| 淘宝和天猫 | 店铺商品列表 | `j.api_ce9ba6bc817e6593` | `/api/v1/data/native/j.api_ce9ba6bc817e6593` | GET `/api/taobao/get-shop-item-list/v4` | sellerId（必填）<br>page，默认 1 | 原生商品或榜单列表，字段随上游合同返回 |
| 淘宝和天猫 | 商品搜索 | `j.api_96b80289a9d84cc8` | `/api/v1/data/native/j.api_96b80289a9d84cc8` | GET `/api/taobao/search-item-list/v1` | keyword（必填）<br>sort，默认 "_sale"<br>tmall，默认 false<br>startPrice<br>endPrice<br>page，默认 1 | 原生商品或榜单列表，字段随上游合同返回 |
| 淘宝和天猫 | 商品搜索 | `j.api_94b5e5c2efa737db` | `/api/v1/data/native/j.api_94b5e5c2efa737db` | GET `/api/taobao/search-item-list/v2` | keyword（必填）<br>page，默认 1 | 原生商品或榜单列表，字段随上游合同返回 |
| 小红书电商 | 商品搜索 | `j.api_615b215c08c1d291` | `/api/v1/data/native/j.api_615b215c08c1d291` | GET `/api/xiaohongshu-ec/search-products/v1` | keyword（必填）<br>page<br>searchId，默认 "" | 原生商品或榜单列表，字段随上游合同返回 |
| 抖音电商 | 商品详情 | `j.api_428cf0b9fc142162` | `/api/v1/data/native/j.api_428cf0b9fc142162` | GET `/api/douyin-ec/get-item-detail/v2` | itemId（必填） | 原生商品或榜单列表，字段随上游合同返回 |
| 抖音电商 | 商品SKU信息 | `j.api_6cbe0d4d445175a6` | `/api/v1/data/native/j.api_6cbe0d4d445175a6` | GET `/api/douyin-ec/get-item-sku-info/v1` | itemId（必填） | 原生商品或榜单列表，字段随上游合同返回 |
| 抖音电商 | 商品SKU信息 | `j.api_da0ada7f35b91baa` | `/api/v1/data/native/j.api_da0ada7f35b91baa` | GET `/api/douyin-ec/get-item-sku-info/v2` | itemId（必填） | 原生商品或榜单列表，字段随上游合同返回 |
| 抖音电商 | 商品搜索 | `j.api_f6ea6dfd00969e8f` | `/api/v1/data/native/j.api_f6ea6dfd00969e8f` | GET `/api/douyin-ec/search-item-list/v1` | keyword（必填）<br>page<br>searchId，默认 "" | 原生商品或榜单列表，字段随上游合同返回 |
| 抖音电商 | 商品评论 | `j.api_906cfcd9d2654192` | `/api/v1/data/native/j.api_906cfcd9d2654192` | GET `/api/douyin-ec/get-item-comments/v1` | itemId（必填）<br>page | 原生商品或榜单列表，字段随上游合同返回 |
| 抖音电商 | 店铺商品列表 | `j.api_9278fa14334f6fb2` | `/api/v1/data/native/j.api_9278fa14334f6fb2` | GET `/api/douyin-ec/get-shop-item-list/v1` | shopId（必填）<br>page | 原生商品或榜单列表，字段随上游合同返回 |
| 京东 | 商品详情 | `j.api_63b4b99a48b7bc39` | `/api/v1/data/native/j.api_63b4b99a48b7bc39` | GET `/api/jd/get-item-detail/v1` | itemId（必填） | 原生商品或榜单列表，字段随上游合同返回 |
| 京东 | 商品详情 | `j.api_d55f8dcb1fea30a2` | `/api/v1/data/native/j.api_d55f8dcb1fea30a2` | GET `/api/jd/get-item-detail/v2` | itemId（必填） | 原生商品或榜单列表，字段随上游合同返回 |
| 京东 | 商品详情 | `j.api_a406b538e602d61d` | `/api/v1/data/native/j.api_a406b538e602d61d` | GET `/api/jd/get-item-detail/v3` | itemId（必填） | 原生商品或榜单列表，字段随上游合同返回 |
| 京东 | 商品价格 | `j.api_8fd3c1555eaf0583` | `/api/v1/data/native/j.api_8fd3c1555eaf0583` | GET `/api/jd/get-item-price/v1` | itemId（必填） | 原生商品或榜单列表，字段随上游合同返回 |
| 京东 | 商品搜索 | `j.api_66a3df5200f1683d` | `/api/v1/data/native/j.api_66a3df5200f1683d` | GET `/api/jd/search-item-list/v1` | keyword（必填）<br>page | 原生商品或榜单列表，字段随上游合同返回 |
| 京东 | 商品评论 | `j.api_68d43409deb2b211` | `/api/v1/data/native/j.api_68d43409deb2b211` | GET `/api/jd/get-item-comments/v1` | itemId（必填）<br>page | 原生商品或榜单列表，字段随上游合同返回 |
| 京东 | 商品评论 | `j.api_c0a3297b1acb2089` | `/api/v1/data/native/j.api_c0a3297b1acb2089` | GET `/api/jd/get-item-comments/v2` | itemId（必填）<br>page | 原生商品或榜单列表，字段随上游合同返回 |
| 京东 | 店铺商品列表 | `j.api_ab6d33dda39c3a62` | `/api/v1/data/native/j.api_ab6d33dda39c3a62` | GET `/api/jd/get-shop-item-list/v1` | shopId（必填）<br>page | 原生商品或榜单列表，字段随上游合同返回 |
| 闲鱼 | 商品详情 | `j.api_6c7f5dfd3e897294` | `/api/v1/data/native/j.api_6c7f5dfd3e897294` | GET `/api/xianyu/get-item-detail/v1` | itemId（必填） | 原生商品或榜单列表，字段随上游合同返回 |
| 1688 | 商品详情 | `j.api_22bf63fc35164ed0` | `/api/v1/data/native/j.api_22bf63fc35164ed0` | GET `/api/1688/get-item-detail/v1` | itemId（必填） | 原生商品或榜单列表，字段随上游合同返回 |
| 1688 | 商品搜索 | `j.api_0bb09ff0dd5576c5` | `/api/v1/data/native/j.api_0bb09ff0dd5576c5` | GET `/api/1688/search-item-list/v1` | keyword（必填） | 原生商品或榜单列表，字段随上游合同返回 |
| AliExpress | 商品搜索 | `j.api_9458e09bf844496e` | `/api/v1/data/native/j.api_9458e09bf844496e` | GET `/api/aliexpress/search-products/v1` | q<br>page<br>sort，默认 "default"<br>catId<br>brandId<br>loc<br>switches<br>attr<br>startPrice<br>endPrice<br>locale<br>region<br>currency | 原生商品或榜单列表，字段随上游合同返回 |
| AliExpress | 商品概览 | `j.api_e5d8404172e7f021` | `/api/v1/data/native/j.api_e5d8404172e7f021` | GET `/api/aliexpress/get-product-detail/v1` | itemId（必填）<br>site，默认 "US" | 原生商品或榜单列表，字段随上游合同返回 |
| Shopee | 商品详情 | `j.api_a193c4b15dfcef12` | `/api/v1/data/native/j.api_a193c4b15dfcef12` | GET `/api/shopee/get-item-detail/v1` | site（必填）<br>itemId（必填） | 原生商品或榜单列表，字段随上游合同返回 |
| Shopee | 商品详情 | `j.api_1a8ba7192333c446` | `/api/v1/data/native/j.api_1a8ba7192333c446` | GET `/api/shopee/get-item-detail/v2` | site（必填）<br>shopId（必填）<br>itemId（必填） | 原生商品或榜单列表，字段随上游合同返回 |
| Shopee | 店铺资料和评分摘要 | `j.api_d38a576ca4118079` | `/api/v1/data/native/j.api_d38a576ca4118079` | GET `/api/shopee/get-shop-seo/v1` | site（必填）<br>shopId（必填） | 原生商品或店铺详情数据 |
| Shopee | 店铺商品列表 | `j.api_312c9f3cf612d9ff` | `/api/v1/data/native/j.api_312c9f3cf612d9ff` | GET `/api/shopee/get-shop-item-list/v1` | site（必填）<br>username（必填） | 原生商品或榜单列表，字段随上游合同返回 |
| Shopee | 商品 SKU 矩阵 | `j.api_2e53758d7ca94c51` | `/api/v1/data/native/j.api_2e53758d7ca94c51` | GET `/api/shopee/get-item-sku-matrix/v1` | site（必填）<br>shopId（必填）<br>itemId（必填） | 原生商品或榜单列表，字段随上游合同返回 |
| Shopee | 店铺基本资料 | `j.api_f9fd4a307fb2cb43` | `/api/v1/data/native/j.api_f9fd4a307fb2cb43` | GET `/api/shopee/get-shop-base/v1` | site（必填）<br>username（必填） | 原生商品或店铺详情数据 |
| Shopee | 商品搜索 | `j.api_bff4a8168dc76c37` | `/api/v1/data/native/j.api_bff4a8168dc76c37` | GET `/api/shopee/search-item-list/v1` | site（必填）<br>keyword（必填） | 原生商品或榜单列表，字段随上游合同返回 |
| Shopee | 商品 SKU 模型 | `j.api_c99744790fdff2ac` | `/api/v1/data/native/j.api_c99744790fdff2ac` | GET `/api/shopee/get-item-sku-models/v1` | site（必填）<br>shopId（必填）<br>itemId（必填）<br>offset<br>ratingType | 原生商品或榜单列表，字段随上游合同返回 |
| Shopee | 店铺详情 | `j.api_1e52a3238a5ab572` | `/api/v1/data/native/j.api_1e52a3238a5ab572` | GET `/api/shopee/get-shop-detail/v1` | site（必填）<br>username（必填） | 原生商品或店铺详情数据 |
| Shopee | 详细的店铺评价 | `j.api_fec5b56e802448dd` | `/api/v1/data/native/j.api_fec5b56e802448dd` | GET `/api/shopee/get-shop-reviews-rich/v1` | site（必填）<br>shopId（必填）<br>offset | 原生评论或评价数据 |
| Shopee | 商品展示快照 | `j.api_40a81e4c7edfcc76` | `/api/v1/data/native/j.api_40a81e4c7edfcc76` | GET `/api/shopee/get-item-snapshot/v1` | site（必填）<br>shopId（必填）<br>itemId（必填） | 原生商品或榜单列表，字段随上游合同返回 |
| Shopee | 店铺评价 | `j.api_49a581b24e03b06d` | `/api/v1/data/native/j.api_49a581b24e03b06d` | GET `/api/shopee/get-shop-reviews/v1` | site（必填）<br>shopId（必填）<br>offset<br>ratingType | 原生评论或评价数据 |
| Shopee | 商品评价 | `j.api_1cf49f6187c99616` | `/api/v1/data/native/j.api_1cf49f6187c99616` | GET `/api/shopee/get-item-reviews/v1` | site（必填）<br>shopId（必填）<br>itemId（必填）<br>offset<br>ratingType | 原生商品或榜单列表，字段随上游合同返回 |
| Shopee | 店铺分类 | `j.api_c8ba3233d3a05931` | `/api/v1/data/native/j.api_c8ba3233d3a05931` | GET `/api/shopee/get-shop-categories/v1` | site（必填）<br>shopId（必填）<br>offset | 原生业务 data |
| Shopee | 商品评价模型分布 | `j.api_4b4383e4c78cb69a` | `/api/v1/data/native/j.api_4b4383e4c78cb69a` | GET `/api/shopee/get-item-review-models/v1` | site（必填）<br>shopId（必填）<br>itemId（必填） | 原生商品或榜单列表，字段随上游合同返回 |
| Shopee | 商品评价标签 | `j.api_a2c6f151bd6690ae` | `/api/v1/data/native/j.api_a2c6f151bd6690ae` | GET `/api/shopee/get-item-review-tags/v1` | site（必填）<br>shopId（必填）<br>itemId（必填） | 原生商品或榜单列表，字段随上游合同返回 |
| Shopee | 搜索分类面 | `j.api_c793e94b005801ac` | `/api/v1/data/native/j.api_c793e94b005801ac` | GET `/api/shopee/get-search-facets/v1` | site（必填）<br>keyword（必填） | 原生商品或榜单列表，字段随上游合同返回 |
| Shopee | 商品分期与金额 | `j.api_b71061390b3a6111` | `/api/v1/data/native/j.api_b71061390b3a6111` | GET `/api/shopee/get-item-installments/v1` | site（必填）<br>shopId（必填）<br>itemId（必填）<br>detailLevel | 原生商品或榜单列表，字段随上游合同返回 |
| TikTok Shop | 商品搜索 | `j.api_b3ab50a3de0aa918` | `/api/v1/data/native/j.api_b3ab50a3de0aa918` | GET `/api/tiktok-shop/search-products/v1` | keyword（必填）<br>region，默认 "US"<br>offset，默认 0<br>pageToken | 原生商品或榜单列表，字段随上游合同返回 |
| TikTok Shop | 商品详情 | `j.api_3d0fff7470f75aa9` | `/api/v1/data/native/j.api_3d0fff7470f75aa9` | GET `/api/tiktok-shop/get-product-detail/v1` | productId（必填）<br>region，默认 "US" | 原生商品或榜单列表，字段随上游合同返回 |
| 亚马逊 | 商品搜索 | `j.api_d7013954da63d1ea` | `/api/v1/data/native/j.api_d7013954da63d1ea` | GET `/api/amazon/search-products/v1` | keyword（必填）<br>country，默认 "US"<br>sortBy，默认 "RELEVANCE"<br>productCondition，默认 "ALL"<br>isPrime，默认 false<br>dealsAndDiscounts，默认 "NONE"<br>page，默认 1 | 原生商品或榜单列表，字段随上游合同返回 |
| 亚马逊 | 商品详情 | `j.api_a982bbe41116f15e` | `/api/v1/data/native/j.api_a982bbe41116f15e` | GET `/api/amazon/get-product-detail/v1` | asin（必填）<br>country，默认 "US" | 原生商品或榜单列表，字段随上游合同返回 |
| 亚马逊 | 商品热门评论 | `j.api_b1529e459fa5c40a` | `/api/v1/data/native/j.api_b1529e459fa5c40a` | GET `/api/amazon/get-product-top-reviews/v1` | asin（必填）<br>country，默认 "US" | 原生商品或榜单列表，字段随上游合同返回 |
| 亚马逊 | 热销商品 | `j.api_41bde27821df8f7f` | `/api/v1/data/native/j.api_41bde27821df8f7f` | GET `/api/amazon/get-best-sellers/v1` | category（必填）<br>country，默认 "US"<br>page，默认 1 | 原生商品或榜单列表，字段随上游合同返回 |
| 亚马逊 | 按类别获取商品 | `j.api_95a329c79c736288` | `/api/v1/data/native/j.api_95a329c79c736288` | GET `/api/amazon/get-category-products/v1` | categoryId（必填）<br>country，默认 "US"<br>sortBy，默认 "RELEVANCE"<br>page，默认 1 | 原生商品或榜单列表，字段随上游合同返回 |
| 拼多多 | 商品关键词搜索 | `r.pinduoduo_search_products` | `/api/v1/data/native/r.pinduoduo_search_products` | GET `/pinduoduo/search` | keyword（必填），page（默认 1） | `data.data.items[]`，含 goods_id、goods_name |
| SHEIN 美国站 | 商品关键词搜索（待开通订阅） | `r.shein_search_products` | `/api/v1/data/native/r.shein_search_products` | GET `/search/products` | query（必填），country（US），page，limit | 发布者示例的商品位于 `data.data.products[]`，成功载荷待实测 |
| Facebook Marketplace | 按中心坐标搜索（初始暂停） | `r.facebook_marketplace_search` | `/api/v1/data/native/r.facebook_marketplace_search` | GET `/marketplace/search` | query、lat、lng 必填，cursor 可选 | `data.results[]`。两次实测均为空页并带有字符串游标。 |

### 4.3 原生接口 curl 示例

闲鱼原生搜索：

~~~bash
curl -sS -X POST \
  "$HUB_URL/api/v1/data/native/j.xianyu_search_v1" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: xianyu-native-$(uuidgen)" \
  -d '{"params":{"keyword":"机械键盘","page":1},"deliveryMode":"live_only"}' | jq
~~~

淘宝商品详情：

~~~bash
curl -sS -X POST \
  "$HUB_URL/api/v1/data/native/j.api_94ac939c44fe1d61" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: taobao-detail-$(uuidgen)" \
  -d '{"params":{"itemId":"商品ID"},"deliveryMode":"live_only"}' | jq
~~~

京东商品搜索：

~~~bash
curl -sS -X POST \
  "$HUB_URL/api/v1/data/native/j.api_66a3df5200f1683d" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: jd-search-$(uuidgen)" \
  -d '{"params":{"keyword":"无线耳机","page":1},"deliveryMode":"live_only"}' | jq
~~~

Amazon 原生搜索：

~~~bash
curl -sS -X POST \
  "$HUB_URL/api/v1/data/native/j.api_d7013954da63d1ea" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: amazon-search-$(uuidgen)" \
  -d '{
    "params": {
      "keyword": "wireless earbuds",
      "country": "US",
      "sortBy": "RELEVANCE",
      "page": 1
    },
    "deliveryMode": "live_only"
  }' | jq
~~~

TikTok Shop 原生搜索：

~~~bash
curl -sS -X POST \
  "$HUB_URL/api/v1/data/native/t.tiktok_shop_search_products" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: tiktok-search-$(uuidgen)" \
  -d '{
    "params": {
      "search_word": "wireless earbuds",
      "offset": 0,
      "page_token": "",
      "region": "US"
    },
    "deliveryMode": "live_only"
  }' | jq
~~~

## 5. 异步采集接口

通用采集合同定义在 `mx-insight-hub.collect.v1`。Apify 和 runner 任务不能作为统一商品搜索接口的同步 fallback；它们返回 `202`，调用方必须保存 `jobId` 并轮询。

### 5.1 `GET /api/v1/data/collect/capabilities`

~~~bash
curl -sS "$HUB_URL/api/v1/data/collect/capabilities" \
  -H "Authorization: Bearer $HUB_KEY" | jq
~~~

返回字段：

| 字段 | 说明 |
| --- | --- |
| `data[].capability` | 能力键，例如 `collect.ecommerce.temu.search`。 |
| `data[].stage` | 当前阶段，现有电商 Apify 能力为 `candidate`。 |
| `data[].granted` | 当前 consumer 和 Key 是否获授权。 |
| `data[].ready` | 是否存在已启用且未隔离的执行引擎。 |
| `data[].routes[]` | 能力对应的 route 和 slot readiness。 |

### 5.2 电商异步能力和输入参数

| capability | 平台 | 输入字段 | 约束和默认值 |
| --- | --- | --- | --- |
| `collect.ecommerce.temu.search` | Temu 美国站 | `keyword`、`sort`、`maxItems` | `sort`：`relevance`、`top_sales`、`most_recent`、`price_low_to_high`、`price_high_to_low`；`maxItems` 10–200，默认 40。 |
| `collect.ecommerce.amazon.search` | Amazon | `keyword` + `marketplace`，或 `urls`；`maxItems` | 两种模式二选一；站点支持 US/UK/DE/FR/IT/ES/CA/JP/AU/IN/MX；`maxItems` 1–100，默认 20。 |
| `collect.ecommerce.ebay.search` | eBay | `keywords`、`marketplace`、`maxItems`、`sort`、`condition`、`listingType`、`minPrice`、`maxPrice` | keywords 1–5 个；站点 US/UK/DE/FR/IT/ES/CA/AU；`maxItems` 1–200，默认 50。 |
| `collect.ecommerce.aliexpress.search` | AliExpress | `keyword`、`site`、`shipCountry`、`maxItems` | `shipCountry` 默认 US；`maxItems` 1–200，默认 50；详情和评论关闭。 |
| `collect.ecommerce.etsy.search` | Etsy | `keywords`、`country`、`sort`、`maxItems`、`minPrice`、`maxPrice`、`onSaleOnly`、`freeShippingOnly`、`handmadeOnly`、`includeAds` | keywords 1–5 个；`maxItems` 1–200，默认 48；`includeAds` 默认 false。 |
| `collect.ecommerce.shopee.search` | Shopee | `country`、`keywords` 或 `shopUrls`、`maxItems` | `country` 必填；keywords 和 shopUrls 二选一；`maxItems` 10–500，默认 50。 |
| `collect.ecommerce.shein.listing` | Shein | `url`、`maxItems` | 只接受 `www.shein.com` 分类或精选页 URL；`maxItems` 1–200，默认 20。 |
| `collect.ecommerce.flipkart.search` | Flipkart | `keyword` 或 `url`、`sort`、`maxItems` | keyword 和 url 二选一；`sort` 为 `relevance`、`popularity`、`price_asc`、`price_desc`、`newest`；`maxItems` 1–200，默认 20。 |
| `collect.ecommerce.mercadolibre.search` | Mercado Libre | `country`、`keyword`、`maxItems` | `country` 必填；支持 9 个国家；`maxItems` 1–200，默认 50。 |
| `collect.ecommerce.fbmarketplace.search` | Facebook Marketplace | `city` + `keyword`，或 `urls`；可传 `maxItems` | `city` 填 Marketplace 城市标识，例如 `sanfrancisco`，也支持数字位置 ID。链接模式接受 1–5 个 Marketplace URL。`maxItems` 1–200，默认 20。 |
| `collect.classifieds.craigslist.search` | Craigslist | `region` + `keyword`，或 `urls`；可传 `maxAgeDays`、`maxItems` | `region` 填地区站子域名，例如 `seattle`。关键词模式搜索该站的出售商品（`sss`）。链接模式接受 1–5 个地区站搜索 URL。`maxAgeDays` 1–30，默认 7。`maxItems` 1–200，默认 50。 |
| `collect.ecommerce.shopify.catalog` | Shopify 独立站 | `domains`、`maxItems` | 1–5 个域名；`maxItems` 1–500，默认 50；不含库存明细。 |

### 5.3 `POST /api/v1/data/collect/jobs`

请求 body：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `capability` | string | 是 | 上表中的能力键。 |
| `input` | object | 是 | 对应该能力的白名单输入。 |

Temu 示例：

~~~bash
JOB_RESPONSE=$(curl -sS -X POST \
  "$HUB_URL/api/v1/data/collect/jobs" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: temu-$(uuidgen)" \
  -d '{
    "capability": "collect.ecommerce.temu.search",
    "input": {
      "keyword": "wireless earbuds",
      "sort": "relevance",
      "maxItems": 10
    }
  }')

echo "$JOB_RESPONSE" | jq
JOB_ID=$(echo "$JOB_RESPONSE" | jq -r '.data.jobId')
~~~

提交成功返回 HTTP `202`，响应中的 `data` 常用字段：

| 字段 | 说明 |
| --- | --- |
| `jobId` | Hub 任务 UUID。 |
| `capability` | 能力键。 |
| `status` | `queued`、`running`、`succeeded`、`failed`、`unknown`、`cancelled` 或 `expired`。 |
| `links.self` | 任务状态 URL。 |
| `links.result` | 任务结果 URL。 |

建议轮询间隔取 HTTP 响应头 `Retry-After`。返回 `202` 时可保存 `data.jobId`，在任务成功后按 `data.links.result` 取商品结果。

### 5.4 查询、取结果和取消

```text
GET  ${HUB_URL}/api/v1/data/collect/jobs/{jobId}
GET  ${HUB_URL}/api/v1/data/collect/jobs/{jobId}/result
POST ${HUB_URL}/api/v1/data/collect/jobs/{jobId}/cancel
```

~~~bash
curl -sS "$HUB_URL/api/v1/data/collect/jobs/$JOB_ID" \
  -H "Authorization: Bearer $HUB_KEY" | jq

curl -sS "$HUB_URL/api/v1/data/collect/jobs/$JOB_ID/result" \
  -H "Authorization: Bearer $HUB_KEY" | jq
~~~

`GET /api/v1/data/collect/jobs/{jobId}/result` 的成功响应节选如下。

~~~json
{
  "data": {
    "jobId": "任务 UUID",
    "capability": "collect.ecommerce.temu.search",
    "status": "succeeded",
    "dataStatus": "success",
    "evidence": { "itemCount": 10 },
    "payload": {
      "provider": "apify",
      "items": ["采集器原始商品记录"]
    }
  },
  "requestId": "Hub 请求 UUID"
}
~~~

`payload` 保留采集器的业务结果；异步 Apify 结果不是统一商品搜索的 `data.items[]`，后续如需进入 Canonical 商品库，还需要经过映射和清洗流程。

### 5.5 批量任务

~~~bash
curl -sS -X POST \
  "$HUB_URL/api/v1/data/collect/batches" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: temu-batch-$(uuidgen)" \
  -d '{
    "capability": "collect.ecommerce.temu.search",
    "items": [
      {"clientRef":"a01","input":{"keyword":"无线耳机","maxItems":10}},
      {"clientRef":"a02","input":{"keyword":"机械键盘","maxItems":10}}
    ]
  }' | jq
~~~

批量接口：

```text
POST /api/v1/data/collect/batches
GET  /api/v1/data/collect/batches/{batchId}
GET  /api/v1/data/collect/batches/{batchId}/result
```

`items` 数量为 1–100，`clientRef` 在同一批次内必须唯一。

## 6. Night-All 历史兼容接口

Night-All 仍是历史同步兼容服务。新电商能力应优先使用 Hub-native 统一搜索或原生转发；历史业务迁移期间保留以下 Hub URL：

```text
POST ${HUB_URL}/api/v1/night-all/search/raw
POST ${HUB_URL}/api/v1/night-all/search/crawl
POST ${HUB_URL}/api/v1/night-all/search/user-info
POST ${HUB_URL}/api/v1/night-all/search/post-detail
POST ${HUB_URL}/api/v1/night-all/search/post-comments
```

兼容接口仍使用 `Authorization`、`Content-Type` 和 `Idempotency-Key`。Hub 保留 Night-All 的历史业务 body 和主要输出字段，同时增加 Hub 的 request ID、幂等和来源状态头。

### 6.1 raw 搜索

输入：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `platform` | string | 是 | Night-All 已支持的平台。 |
| `keyword` / `query` | string | 至少一个 | 单个查询词。 |
| `keywords` / `queries` | string[] | 至少一个 | 批量查询词；受 work budget 限制。 |
| `count` / `pageSize` / `limit` | integer | 否 | 页大小，受 consumer policy 限制。 |
| `page` | integer | 否 | 最大页数由兼容合同限制。 |
| `cursor` | string | 否 | Hub 返回的不透明游标。 |
| `includeRaw` | boolean | 否 | 兼容路径只接受 `false`。 |

~~~bash
curl -sS -X POST \
  "$HUB_URL/api/v1/night-all/search/raw" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: night-all-raw-$(uuidgen)" \
  -d '{
    "platform": "twitter",
    "query": "AI Agent",
    "count": 20,
    "includeRaw": false
  }' | jq
~~~

输出保留 Night-All 的 `raw_info`、`raw_data`、`meta` 和业务 correlation 字段；分页字段由 Hub 重新绑定到当前 consumer、operation 和查询条件。

### 6.2 crawl 和 user-info

`crawl` 至少提供一个用户、频道或 profile selector，例如 `username`、`userId`、`channelUrl`、`channelId` 或 `url`。`user-info` 至少提供 `username`、`userId`、`profileUrl` 或 `url`。

~~~bash
curl -sS -X POST \
  "$HUB_URL/api/v1/night-all/search/crawl" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: night-all-crawl-$(uuidgen)" \
  -d '{
    "platform": "twitter",
    "username": "example_user",
    "count": 20,
    "activityTypes": ["posts"]
  }' | jq

curl -sS -X POST \
  "$HUB_URL/api/v1/night-all/search/user-info" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: night-all-user-$(uuidgen)" \
  -d '{
    "platform": "twitter",
    "username": "example_user"
  }' | jq
~~~

## 7. Admin 和运行配置接口

以下接口不是普通业务调用，要求 Hub Admin Token：

```http
x-mx-insight-admin-token: <ADMIN_TOKEN>
```

查看电商路由目录：

```bash
curl -sS "$HUB_URL/internal/v1/admin/ecommerce-routing" \
  -H "x-mx-insight-admin-token: $ADMIN_TOKEN" | jq
```

查看采集引擎目录：

~~~bash
curl -sS "$HUB_URL/internal/v1/admin/collect/catalog" \
  -H "x-mx-insight-admin-token: $ADMIN_TOKEN" | jq

curl -sS "$HUB_URL/internal/v1/admin/collect/engines" \
  -H "x-mx-insight-admin-token: $ADMIN_TOKEN" | jq
~~~

采集引擎管理接口包括：

```text
GET  /internal/v1/admin/collect/catalog
GET  /internal/v1/admin/collect/engines
POST /internal/v1/admin/collect/engines
GET  /internal/v1/admin/collect/engines/{id}
PUT  /internal/v1/admin/collect/engines/{id}
PUT  /internal/v1/admin/collect/engines/{id}/credential
PUT  /internal/v1/admin/collect/engines/{id}/egress
POST /internal/v1/admin/collect/engines/{id}/probe
POST /internal/v1/admin/collect/engines/{id}/recover
POST /internal/v1/admin/collect/engines/{id}/slots/{slot}/recover
GET  /internal/v1/admin/collect/jobs/{id}
```

供应商密钥只能通过 Admin 凭据管理写入，不能放入公共 API body、curl 文档或普通日志。

## 8. 调用方实现建议

1. 启动时只读取一次 `GET /api/v1/data/capabilities`，不要用 readiness 检查触发实时采集。
2. 统一商品搜索使用 `marketplace` 和统一 `data.items[]`；需要平台特有详情、SKU、评论时再调用原生 endpoint。
3. 原生接口每页新建 Idempotency-Key；同页网络重试保留原 Key。
4. 异步采集保存 `jobId`、`status`、`dataStatus` 和 `evidence`，不要把 Apify `payload` 直接当成统一商品合同。
5. 不在调用方保存或转发供应商密钥，不通过 MX-H2I Internal 路径代理 Hub 公共数据接口。
6. Hub 电商接口位于数据平面；MX-H2I 的登录、Internal AppCenter、WireGuard、DNS/PAC 和用户联网链路保持独立。

## 9. 商品关键词搜索核对（2026-11-23）

| 平台 | Hub 入口与请求 | 验证结果 |
| --- | --- | --- |
| 淘宝、天猫、京东、小红书电商、闲鱼、抖音电商 | 统一搜索见第 3 节。分别传 `taobao`、`tmall`、`jd`、`xiaohongshu_ec`、`xianyu`、`douyin_ec` | 已有统一商品合同。抖音仅精选联盟首页。 |
| 拼多多 | `POST /api/v1/data/native/r.pinduoduo_search_products`，`{"params":{"keyword":"茶杯","page":1}}` | 新增。RapidAPI 返回 HTTP 200、业务码 0，9 件商品均有 ID、标题和商品链接。取 `data.data.items[]`。首页页容量为 10，响应没有总数或末页标记。价格保留上游数值，单位待核。 |
| Amazon | `POST /api/v1/data/native/j.api_d7013954da63d1ea`，`{"params":{"keyword":"wireless earbuds","country":"US","page":1}}` | JustOne 实返 16 件。首件 ASIN 为 `B0FQFB8FMG`，标题为 Apple AirPods Pro 3 无线耳机，标价 USD 149.00。取 `data.products[]`。 |
| AliExpress | `POST /api/v1/data/native/j.api_9458e09bf844496e`，`{"params":{"q":"wireless earbuds","page":"1","region":"US","currency":"USD","locale":"en_US"}}` | JustOne 实返 20 件，首件为无线睡眠耳塞。取 `data.result.resultList[].item`。此接口的 `page` 是字符串。 |
| Shopee | `POST /api/v1/data/native/j.api_bff4a8168dc76c37`，`{"params":{"site":"TW","keyword":"coffee"}}` | 已登记；官方 SDK 台湾站成功样本在 `data.cards[]` 中有 20 条。见[发布者样本](https://github.com/justoneapi-official/justoneapi-python/blob/main/docs/api-examples/getApiShopeeSearchItemListV1.json)。 |
| SHEIN | `POST /api/v1/data/native/r.shein_search_products`，`{"params":{"query":"summer dress","country":"US","limit":1}}` | 本地实现已校验发布者示例。RapidAPI 网关返回 403、提示当前 Key 未订阅。迁移初始暂停，启用前需开通对应订阅并核对一页商品。见[接口文档](https://rapidapi.com/belchiorarkad-FqvHs2EDOtP/api/shein-data-api/playground/apiendpoint_a11fb5ba-a228-438c-b58a-8f976638bd4c)。 |
| eBay、Temu、Etsy、Mercado Libre、Flipkart | `POST /api/v1/data/collect/jobs`，各自的 `capability` 和 `input` 见第 5 节 | 已有 Apify 异步候选。调用前以当前 Key 的 `granted` 和引擎 `ready` 为准。Temu 现有 JustOne 同步 V1 已标记废弃。见[供应商目录](https://docs.justoneapi.com/en/api/temu/keyword-product-search-v1)。 |
| 快手小店 | 无已接入的商品关键词接口 | TikHub 的两个现有电商入口分别返回购物榜和品牌榜，仅支持子分类参数。另有西瓜猪联盟商品搜索，需接入独立签名凭据。见[联盟接口](https://s.apifox.cn/ccf0c9d4-09ac-4792-95a5-ab53ad908804/461771773e0)。 |
| 饿了么 | 无已接入的商品关键词接口 | 官方混合搜索要求位置和关键词，接入还需合作应用签名凭据。见[饿了么接口文档](https://openapi-doc.faas.ele.me/v2/api/search.html)。 |

前 18 个平台的核验有 4 次请求到达上游。Amazon、AliExpress、拼多多返回商品，SHEIN 在订阅检查时被拒。测试使用供应商凭据，未取得生产 Hub 的调用回执或账单。两条新增路由随 Hub 迁移 195 发布，使用 `ecommerce` 数据域及各自的 `native.r.*` 操作授权。首次上线日期以生产发布记录为准。

### 9.1 第 19–21 行的请求和响应示例

下表的请求体可直接用于对应的 POST 路径。请求头使用 Hub Key、`Content-Type: application/json` 和 `Idempotency-Key`。同一页重试时复用原幂等键，翻页使用新键。响应为 JSON 字段节选。

| 平台和方式 | API 接口 | API 请求示例 | 响应示例 |
| --- | --- | --- | --- |
| Facebook Marketplace · 经纬度 | `/api/v1/data/native/r.facebook_marketplace_search` | `{"params":{"query":"guitar","lat":40.7128,"lng":-74.006}}` | `{"data":{"results":[]}}`。两次实测空页均带 `data.cursor`，此处省略游标。 |
| Facebook Marketplace · 城市 | `/api/v1/data/collect/jobs` | `{"capability":"collect.ecommerce.fbmarketplace.search","input":{"city":"sanfrancisco","keyword":"guitar","maxItems":1}}` | 提交返回 `202` 和 `data.links.result`。取结果后为 `{"data":{"status":"succeeded","payload":{"items":[{"id":"1189200412268517","marketplace_listing_title":"Ashthorpe Full-Size Dreadnought Acoustic-Electric Guitar","listing_price":{"formatted_amount":"$65"}}]}}}`。发布者样本在本地 Hub 回放。 |
| Craigslist · 地区站在售商品 | `/api/v1/data/collect/jobs` | `{"capability":"collect.classifieds.craigslist.search","input":{"region":"newyork","keyword":"bicycle","maxItems":1}}` | 提交返回 `202` 和 `data.links.result`。取结果后为 `{"data":{"status":"succeeded","payload":{"items":[{"id":"7528462760","title":"21 Speed CANNONDALE QUICK 6 Road Bicycle 18 inch frame","price":"$300"}]}}}`。发布者历史样本在本地 Hub 回放。 |
| Shopify 独立站 · 店内搜索 | `/api/v1/data/collect/query` | `{"capability":"collect.ecommerce.shopify.search","input":{"domain":"www.deathwishcoffee.com","keyword":"coffee","maxItems":1}}` | `{"data":{"job":{"status":"succeeded"},"result":{"dataStatus":"success","payload":{"items":[{"title":"Dark Roast Coffee","priceRange":{"minVariantPrice":{"amount":"19.99","currencyCode":"USD"}}}],"pageInfo":{"hasNextPage":true}}}}}`。真实店铺经本地 Hub 返回 HTTP 200。 |

Facebook Marketplace 同步入口需要 `ecommerce` 和 `native.r.facebook_marketplace_search` 授权。纽约坐标的 `guitar`、`iphone` 两次请求都返回 HTTP 200 和空列表。迁移 197 将操作登记为暂停，待获得有商品的实测页后再启用。[实测记录](operations/evidence/facebook-marketplace-search-2026-11-23.json)

两条城市或地区异步入口分别需要对应 `collect.*` 授权、已启用的引擎路由和 Apify 凭据。保存提交响应的 `data.links.self` 查询进度，成功后 GET `data.links.result`，读取 `data.payload.items[]`。本次用发布者样本验证了本地 HTTP 提交、幂等重放和取结果，未运行线上 Actor。Craigslist 的 RapidAPI 备选返回 HTTP 403，当前账号未订阅。[Facebook Marketplace 样本](https://apify.com/apify/facebook-marketplace-scraper) · [Craigslist 在售商品样本](https://apify.com/ivanvs/craigslist-scraper-pay-per-result#data-output-example---for-sale)

Shopify 每次只搜索一个店铺，`domain` 填完整主机名，`maxItems` 为 1–50，默认 20。下一页保持店铺和关键词，将 `data.result.payload.pageInfo.endCursor` 原样传入 `input.after`。公开店铺验证中，第二页返回 Medium Roast Coffee，无匹配查询返回 `dataStatus: "no_data"`。若返回 HTTP 202，按异步结果路径取回商品。迁移 196 为既有标准原生引擎补充路由，调用方需获 `collect.ecommerce.shopify.search` 授权。[本地 Hub 实测三页响应](operations/evidence/shopify-storefront-search-2026-11-23.json) · [Shopify Storefront 搜索](https://shopify.dev/docs/api/storefront/latest/queries/search)
