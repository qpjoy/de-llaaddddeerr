# 快手电商目录与统一商品默认路由（2026-10-13）

状态：本地实现、迁移回归与浏览器验收完成，生产发布仍由操作员执行。本轮没有付费供应商请求，没有修改线上价格、余额或授权，没有改动 Launcher / MX-H2I 登录与联网。

## 官方接口与接入范围

核对 [TikHub OpenAPI](https://api.tikhub.io/openapi.json) 的快手 App/Web 共 38 个路径，其中 36 个固定读取接口已经注册于 Hub 原生目录。另两项是分享链接生成，不属于本次电商读取接入范围。已有社媒路径、权限和价格保持兼容。

从现有官方读取合同中增加两项独立电商操作：

| 类型 | Hub POST 路径 | 上游 GET 路径 / 官方说明 |
| --- | --- | --- |
| 购物榜单 | `/api/v1/data/native/t.kuaishou_ecommerce_shopping_top_list` | `/api/v1/kuaishou/app/fetch_shopping_top_list`，[官方文档](https://docs.tikhub.io/467698492e0) |
| 品牌榜单 | `/api/v1/data/native/t.kuaishou_ecommerce_brand_top_list` | `/api/v1/kuaishou/app/fetch_brand_top_list`，[官方文档](https://docs.tikhub.io/467698493e0) |

两项归入「电商数据 → 快手电商」，要求 `ecommerce` 数据域及对应 `native.t.kuaishou_ecommerce_*` 操作授权。旧社媒键 `t.api_382901fb0fa68660`、`t.api_fb5e49d31884ca14` 继续原样存在；旧授权不会自动变成新电商授权。普通 Key 按现有 Consumer/Key 授权交集检查，原始 managed_full 身份由既有迁移同步机制管理。

请求体示例（示例未执行）：

```json
{
  "deliveryMode": "live_only",
  "params": { "subTabId": 0, "subTabName": "" }
}
```

`subTabId` 是整型子分类 ID，`subTabName` 是字符串子分类名称；它们不是页码和游标。合同无关键词商品搜索、page、count、cursor 或 pcursor，额外参数在派发前返回 400。保留原生 `data`，不推测商品 ID、商品链接、总数、终页或统一 `items/page`，不自动翻页或付费重试。两项未做线上付费样本校准，不能据此声称实际业务载荷已验证。

原生派发现在优先按供应商选网关：TikHub 的电商操作进入 TikHub 网关，JustOne 的电商操作继续原网关。授权、操作控制、采购预算、计费、幂等和归档仍由既有网关执行。

拼多多以及快手关键词商品搜索仍缺少可执行的官方商品合同；不会把社媒视频搜索、Temu 或榜单作为商品搜索替代。之前授权的各一次付费校准尚未消耗。

## Admin 默认路由

入口：`#/data-platforms?domain=ecommerce`，也可从「电商数据」中的 Admin 链接进入。仅 Admin Token 会话可读取供应商详情和修改配置。

- 展示业务平台、供应商、上游路径、适配器版本、下游合同和原生接口列表。
- 默认控制的是 `POST /api/v1/data/ecommerce/products/search` 的后端适配器，不只是调试页的初始选项。
- 六个平台当前各只有一个经过适配的 JustOne 候选：淘宝、天猫、京东、闲鱼、小红书电商、抖音电商。可保存默认配置，但目前没有第二个兼容候选供切换。候选须先在代码中实现同一商品结构、排序/筛选和分页语义，不能填写任意供应商 URL，也不能将原生接口键直接保存成默认适配器。
- 淘宝原生 V2 不具备 V1 的完整排序、价格与天猫筛选合同，因此继续作为平台专用接口。
- 配置保存要求 `expectedRevision` 和非空 `reason`；事务同时写配置与审计，版本过时返回 409，审计失败整笔回滚。跨副本从数据库读取，不依赖进程内配置缓存。
- 新采集使用已保存默认；已有游标绑定原适配器，无 adapterId 的历史游标按原默认解释。公开请求不能提交 adapterId。已提交幂等请求继续精确重放，cache_only/cache_first 的有效缓存不依赖新默认。
- 默认缺失、未注册或数据库读取失败时，新采集返回 `503 ecommerce_route_unavailable`，不发起上游请求。管理目录显示无效配置，允许选择兼容候选后修复。

管理接口：

```http
GET /internal/v1/admin/ecommerce-routing
PUT /internal/v1/admin/ecommerce-routing/jd
Content-Type: application/json

{"adapterId":"justone:jd.product-search.v1","expectedRevision":1,"reason":"确认当前兼容接口"}
```

供应商详情仅在 Admin 目录中出现；下游统一商品合同保持供应商无关。运行时 OpenAPI、静态 OpenAPI、平台专用页面和电商接入指南已同步。

## 发布与启用

新增迁移：

- `147_kuaishou_ecommerce.sql`：两项已发布合同，初始 `disabled`，不覆盖旧价格或人工状态。
- `148_ecommerce_product_routes.sql`：六个平台的原默认配置及初始审计。

在服务器经过审阅的 `electron-dock/mx-insight-hub` checkout 中执行既有 Internal 发布流程：

```bash
bash scripts/manage.sh ops internal-production deploy
kubectl -n mx-insight-hub rollout status deployment/mx-insight-hub-public --timeout=180s
kubectl -n mx-insight-hub rollout status deployment/mx-insight-hub-admin --timeout=180s
```

正常 deploy 会执行迁移和既有 missing-price defaults 流程；该流程只补缺失价格，并只激活有完整 bootstrap 审计的初始禁用操作，保留已有价格、预算及人工暂停。TikHub 缺失采购价格的既有默认是 **USD 0.01**，不能解释为客户 CNY 0.01 或供应商实际账单价格。发布后在「上游供应商 → TikHub」复核这两项操作的实际价格、凭据、启停与预算，在 API Keys 检查所需授权交集。

仅增加新接口不会自动给普通客户 Key 扩权，也不会重新发出历史失败请求。不部署 Launcher，不重建库、重置 Key 或修改 MX-H2I 网络。未执行本说明的生产部署和线上付费验收。

## 验证证据

- 电商合同、JustOne 适配器、网关、原生接口、产品目录、公开文档和路由配置回归：148 项（含 PGlite 实际执行 147/148）。覆盖迁移重复执行保护、修订冲突、审计回滚、错误候选、旧/新游标、精确重放、缓存、撤权及禁用。
- 能力目录检查无问题；生产构建通过，保留原有大 bundle 提示。
- 当前没有 Browser 插件，使用现有 Playwright + 本机 Chrome。在隔离内存 API 和 5185 前端验证 Admin 登录、京东默认保存/刷新、快手两项目录、调试深链接和两个参数；1440px 桌面与 390px 手机布局无页面横向溢出（表格在内部横向滚动）。零浏览器运行错误、零数据采集 POST；这些是本地证据，不是生产或供应商可用性证明。
- 验收环境没有供应商适配器或凭据；现有 5184 开发页面及其服务未重启。
