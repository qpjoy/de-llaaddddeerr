# 电商统一合同校准与发布说明（2026-10-12）

状态：本地实现与离线回归完成，尚未部署生产。此次只修改 Hub；没有改动 Launcher、MX-H2I 登录、网络配置或现有身份/授权。没有新增数据库迁移，没有修改线上价格、余额、权限或启停状态。

## 下游应选择哪个入口

| 用途 | Hub 接口 | 返回与数据来源 |
| --- | --- | --- |
| 跨平台商品搜索 | `POST /api/v1/data/ecommerce/products/search` | 同一 `items/page` 商品合同；当前运行适配器为 JustOne；可按交付策略复用精确快照，实时成功会进入 canonical 入库链路 |
| 平台特有详情、SKU、评论或特定搜索版本 | 文档中的固定 `/api/v1/data/native/j.*`，以及已发布 `/data/ecommerce/…` 资源接口 | 各接口的业务结构；原生目录当前有 62 个电商接口，单独授权、定价及启用。原生调用保留归档，不自动转成统一商品库 |
| 已收录商品 | `GET /api/v1/data/ecommerce/products/items` | 当前 consumer 的成功交付历史；不采集，不等于全部 canonical 数据或清洗任务合集 |

平台原生目录不是其他供应商或清洗任务的电商合集；目录覆盖也不等于全部平台已接入统一搜索。电商调试页现在优先展示统一商品搜索，仍保留按具体接口的深链接选择与原权限过滤。

统一搜索现支持 `taobao`、`tmall`、`jd`、`xianyu`、`xiaohongshu_ec`、`douyin_ec`。当前固定合同及核对的 JustOne 官方目录未提供可直接接入的拼多多/快手商品搜索证据；不要用快手社媒搜索冒充商品搜索。后续接入需要明确供应商端点、价格和真实样本，仍映射到同一商品合同。

## 本次修复与兼容性

- 商品链接识别增加大小写精确的 `auctionURL`，`//host/path` 补 `https:`，保留签名参数。可用上游网页链接优先；保留已有 `url` 长度上限 2048 与精确数字商品 ID 派生规则。`urlSource=upstream|derived_from_id|null` 区分来源，不把派生地址冒充上游返回，也不承诺落地页可访问。
- 新增可选 `appUrl`，只保留商品身份匹配的 `xhsdiscover://goods_detail/<id>` 或 `fleamarket://item_detail?itemId=<id>`；网页地址仍放在 `url`。小红书本次只有 App 链接，因此 `url=null` 合法。产品展示提供明确的 App 打开操作；不会自动跳转。
- 小红书商品卡固定解析 `data.data.module.data` 中的 `cosmos_search_goods_card`：`content.id` 是商品 ID，`content.vendor.seller_id` 是店铺 ID，`vendor_id` 样本为头像地址，不可当店铺 ID。价格来自 `price_info.price/origin_price`，不用换算展示价 `rds_price/foreign_price`。保留旧 flat-list 形态。
- 小红书内层 `code/success` 失败不会被当成正常空列表。归档保存原卡片，非商品卡片计入 discardedCount。
- 原生转发归档补齐 UTC `capturedDate`、marketplace、endpointVersion、sourceKey、archivePath。原分支缺少这些元数据，可触发截图中的 `external_platform_archive_date_invalid`。成功和上游拒绝均修复；没有放宽存储日期校验。
- 抖音商品来自 `data.promotions`：只用 `product_id` 作字符串商品 ID，标题/网页/图片映射 `base_info.title/detail_url/main_img.url_list`。`promotion_id` 与商品 ID 不混用。本次所有价格都是 null；保持缺失，不填 0，不猜测未来价格对象的单位。翻页读取 `data.extra.search_id`，封装在 Hub 签名 cursor 内。
- 小红书、抖音第 2 页起要求 Hub cursor，不接受孤立 `page=2`；无已验证 hasMore 与 continuation 时不自动构造下一页。真实第 2 页未付费校准，续页参数/作用域/终页行为已用离线 fixture 验证。
- 淘宝/天猫统一搜索继续使用官方 V1，以保留 sort、price、tmall 语义。截图是原生 V2，其官方合同只有 keyword/page，因此不能直接替换 V1。V2 原始链接仍可从原生响应读取。
- 统一合同版本继续为 `mx-insight-hub.ecommerce-products.v1`；新增 marketplace 与可选 appUrl，既有必填字段、鉴权、幂等和计费语义不变。旧快照及旧幂等响应保持原样，不回写历史缺失链接。刷新结果需新请求标识；同一标识只会重放原结果。
- 小红书适配合同提升为 `justone.xiaohongshu-product-search.v2`，其余已有平台版本不动；canonical parser 提升为 `mxih-justone-product-search.v4`。供应商成功但无法解析仍按原有已计费/不可用规则处理，不自动重试。

## 一次性上游校准记录

用户允许各不确定接口一次付费校准；抖音第一次 301 后，用户单独允许再发一次。共实际发出 4 次请求：3 次 code=0，1 次 code=301。code=0 按官方规则计费，301 按官方规则不计费；本次没有查询供应商账单或确认实际金额。初次沙箱 DNS 失败未连接上游，不计供应商调用。此后没有追加重试或补页。

| 接口 / UTC 采集时间 | 结果 | 结构核对 |
| --- | --- | --- |
| 淘宝 V2 / 13:41:46.168 | 成功，49 个列表元素 | 46 商品、3 推荐卡片；逐商品离线链接投影有 42 个上游网页链接、4 个派生网页链接。4 个原广告链接超过 2048 字符，未截断签名或放宽合同。不是声称 V2 已接入统一搜索 |
| 抖音第 1 次 | HTTP 200 / 业务码 301 | 采集失败，无商品样本；无自动重试 |
| 小红书电商 / 13:41:53.568 | 成功，20 商品 | 离线完整统一投影 20 条，20 个 App 链接、20 个图片/价格，0 个网页链接、0 丢弃 |
| 抖音获批第 2 次 / 13:43:28.486 | 成功，30 商品 | 离线完整统一投影 30 条，30 个网页链接/图片，价格均 null、0 丢弃 |

原始 HTTP body SHA-256（校准脚本未保留成功请求 ID，不补造）：

- 淘宝 V2：`05ebe6ae22d95e8ddf9f7936ab0c6298ccbab5f1268fd3f48aaee7c97519a955`
- 小红书：`f89e654a75ad0bd8af75ec706c7b58335f20dd17b9c97679eaa76c275e9b88c2`
- 抖音第 2 次：`61738978e80ec40a90bc6237163743ac8d2fa4aec4d80172315a916891bca630`

临时本地业务样本位于 `/private/tmp/mx-ecommerce-calibration-20261012/`，不包含凭据，未加入 Git。测试保存匿名合成 fixture，保留观察到的字段结构，不保存真实搜索会话、商品签名或供应商密钥。以上是适配器直连采样与离线验证，不是线上 Hub 已部署或下游已恢复的证明。

## 部署与启用

1. 在既有 Internal 部署主机、审阅后的 Hub checkout 使用 `bash scripts/manage.sh deploy` 同步 Public/Admin。沿用现有运行凭据、开关和价格；此增量无新增迁移。不要为本次改动部署 Launcher、重建历史数据或修改 MX-H2I。
2. 在「外部数据平台 → JustOne → 上游操作控制 → ecommerce.products.search」复核并发布包含 `douyin-ec.product-search.v1` 的采购价格表，保留其他端点原价格、货币、预算、启停及 canary 范围。价格必须来自经确认的供应商账单/合同；不从这次成功响应推算金额。管理 UI 已新增该可选端点说明。
3. 新抖音端点属于 optionalEndpointKeys：旧价格表不含它时原有五个平台继续工作；抖音实时调用在网络前返回 `external_platform_cost_control_unavailable`，不会用其他平台价格代替。`capabilities.marketplaces` 表示合同范围，平台 ready 不是每个 marketplace 都已就绪的保证。已有 ecommerce + ecommerce.products.search 授权按原 operation 范围生效，不自动扩大任何 Key 权限或客户计费。
4. 只读检查文档与当前配置；在另行获准的生产验收中，可使用已有 Live Key 发起一页 `live_only`，检查 url/urlSource/appUrl、requestId、sourceMode、归档及计量，再以同一幂等键重放验证没有第二次上游调用。不要为检验旧修复直接重发失败请求；先查其原请求状态和计费证据。本次校准额度已使用，不自动追加线上付费验收。

新抖音统一请求示例（占位 Key；该请求会采集，当前记录未执行此生产示例）：

```http
POST /api/v1/data/ecommerce/products/search
Authorization: Bearer <HUB_LIVE_KEY>
Idempotency-Key: <NEW_UNIQUE_KEY>
Content-Type: application/json

{"marketplace":"douyin_ec","query":"小米手机","deliveryMode":"live_only"}
```

后续页以 `cursor` 替换 page，保持 marketplace/query/sort/price，使用新幂等键。旧结果中的 null 链接不因代码部署自动改变。

## 验证与官方依据

相关回归 306 项：304 通过、0 失败、2 项独立 PostgreSQL 环境测试跳过。覆盖六平台合同、原始归档、日期边界、链接来源、幂等重放、成本/权限保护、HTTP 路由、文档与静态 OpenAPI 一致性、租户文档过滤。新增用例证明未定价抖音零派发、旧京东可用，以及定价后抖音重复请求只有一次真实适配器调用。类型检查与生产构建通过；构建保留现有大 chunk 提示。

- [淘宝/天猫搜索 V1](https://docs.justoneapi.com/zh/api/taobao-and-tmall/product-search-v1)
- [淘宝/天猫搜索 V2](https://docs.justoneapi.com/zh/api/taobao-and-tmall/product-search-v2)
- [抖音电商搜索 V1](https://docs.justoneapi.com/zh/api/douyin-e-commerce/product-search-v1)
- [小红书电商搜索 V1](https://docs.justoneapi.com/zh/api/xiaohongshu-e-commerce-rednote/product-search-v1)
- [JustOne 计费语义](https://docs.justoneapi.com/zh/usage)
