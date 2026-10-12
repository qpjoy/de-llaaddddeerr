# 抖音电商接口诊断（2026-10-13）

## 生产证据

本次只读查询生产 Admin 的请求诊断、使用记录和 JustOne 操作配置，没有发起付费采集、重试、修改运行开关、价格或历史账单。

| 项目 | 商品搜索 | 商品详情 |
| --- | --- | --- |
| Hub requestId | `3e251e2f-df0b-4edc-97a7-d38f73f5efa8` | `74bb9f52-18ba-4bd0-b949-c72ee7f33e64` |
| 原生接口键 | `j.api_f6ea6dfd00969e8f` | `j.api_428cf0b9fc142162` |
| 请求时间（UTC） | 2026-10-12 16:37:56.911 | 2026-10-12 15:07:58.858 |
| 供应商 | JustOne | JustOne |
| 上游 HTTP / 业务码 | 200 / 301 | 200 / 301 |
| 上游 requestId | `abd207b94fb941e1b6daeaf0a981ea9f` | `57d6f394d47a459e8b28a694917e6f80` |
| 上游耗时 | 1236 ms | 3129 ms |
| Hub 响应 | 502 / `external_platform_rejected` | 502 / `external_platform_rejected` |
| 已保存原因 | `upstream_collection_failed` | `upstream_collection_failed` |
| 供应商 billed | false | false |
| 客户账本 | charged，1 CNY 最小单位（¥0.01） | charged，1 CNY 最小单位（¥0.01） |

受限响应已归档，但 Admin 未展示原始正文。301 只能证明供应商报告采集失败，不能推出其内部失败原因、关键词限制或后续恢复时间。应向 JustOne 提供上表中的上游 requestId 与 UTC 时间核查；本次没有发送对外消息。

搜索截图的请求体为：

```json
{"deliveryMode":"live_only","params":{"keyword":"小红书","searchId":""}}
```

官方合同中 `page` 可选，`searchId` 可选且默认空字符串，因此该首页参数形态符合文档。不能在没有额外证据时把省略 `page` 或空 `searchId` 当成 301 的原因，也不应以迁移价格来修复采集失败。

## 六个接口的检查范围

2026-10-13 读取六份官方 OpenAPI JSON 均为 HTTP 200；固定 GET 路径、参数名称、类型、必填性和默认值与 Hub 已登记合同逐项相同。生产 JustOne 管理页面中六项均显示“生效：正常”，预算仍有余量；这是运行配置证据，不是各接口实时可用性保证。

| 接口 | 原生接口键 | 必填字段 | 可选分页字段 | 已有调用证据 |
| --- | --- | --- | --- | --- |
| 商品详情 V2 | `j.api_428cf0b9fc142162` | `itemId` 字符串 | 无 | 上表请求返回 301 |
| 商品 SKU V1 | `j.api_6cbe0d4d445175a6` | `itemId` 字符串 | 无 | 近 24 小时用量统计未见调用 |
| 商品 SKU V2 | `j.api_da0ada7f35b91baa` | `itemId` 字符串 | 无 | 近 24 小时用量统计未见调用 |
| 商品搜索 V1 | `j.api_f6ea6dfd00969e8f` | `keyword` 字符串 | `page`、`searchId` 字符串 | 上表请求返回 301 |
| 商品评论 V1 | `j.api_906cfcd9d2654192` | `itemId` 字符串 | `page` 字符串 | 近 24 小时用量统计未见调用 |
| 店铺商品列表 V1 | `j.api_9278fa14334f6fb2` | `shopId` 字符串 | `page` 字符串 | 近 24 小时用量统计未见调用 |

Hub 入口均为 `POST /api/v1/data/native/<接口键>`，输入参数放在 `params` 中。详情/SKU/评论需要实际商品 ID，店铺列表需要实际店铺 ID，不接受用关键词代替 ID 的语义。原生接口保留供应商业务对象及分页字段；搜索后续页沿用上次响应的 `search_id` 作为 `params.searchId`。统一商品搜索仍使用 `/api/v1/data/ecommerce/products/search`、`marketplace=douyin_ec` 和 Hub cursor，不应混用两种分页合同。

官方来源：[抖音电商目录](https://docs.justoneapi.com/en/api/douyin-e-commerce/)、[商品搜索](https://docs.justoneapi.com/en/api/douyin-e-commerce/product-search-v1)、[详情](https://docs.justoneapi.com/en/api/douyin-e-commerce/item-details-v2)、[SKU V1 OpenAPI](https://docs.justoneapi.com/openapi/douyin-e-commerce/product-sku-info-v1-zh.json)、[SKU V2](https://docs.justoneapi.com/en/api/douyin-e-commerce/product-sku-info-v2)、[评论](https://docs.justoneapi.com/en/api/douyin-e-commerce/item-comments-v1)、[店铺列表](https://docs.justoneapi.com/en/api/douyin-e-commerce/shop-product-list-v1)。

## 计费及验证结论

`server/external-platforms/store.mjs` 当前把 JustOne 的确定拒绝保存为 `committed`、HTTP 502、0 数据单元；客户按请求费率因此仍可结算。供应商 `billed=false` 不会自动释放客户冻结。用量页将 `committed` 标为“成功”，不能用该标签判定本次实际交付成功；应结合 `response_status`、`error_code` 和上游账本。以上是现状说明，不是新计费政策或退款操作。

本地 `native-forwarding.test.mjs` 和 `external-platform-gateway.test.mjs` 共 81 项通过。另对六个抖音电商适配器做注入模拟响应的离线检查：固定 GET 路径及参数正确、301 分类为 `upstream_collection_failed`、供应商未计费、每次只派发一次。模拟数据不是线上商品样本，不能证明其他四项已实时验收。

本次未发现需要改动的 Hub 路径或参数映射，未改变运行时代码、下游合同、默认供应商、重放结果、MX-H2I 登录或联网。供应商内部 301 原因仍待 JustOne 核查。
