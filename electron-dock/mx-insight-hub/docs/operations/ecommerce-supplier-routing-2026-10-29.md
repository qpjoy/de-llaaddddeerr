# 电商数据：上游供应商可切换、淘宝/天猫备用通道、TikHub 电商接口（2026-10-29）

状态：本地实现与测试完成，未部署，没有发起付费请求，没有修改线上路由、价格、授权或 Delta。MX-H2I 登录与联网不受影响。

## 现状与原因

- Delta 通过 `POST /api/v1/data/ecommerce/products/search` 采集京东、淘宝、天猫、闲鱼、小红书电商（`po-infra/data_hub/product_collection.py`），校验 `contractVersion=mx-insight-hub.ecommerce-products.v1` 与统一 `items/page`。
- 这些平台的统一商品搜索此前只有 JustOne 一个供应商。10-28 的 Instagram 诊断已确认 JustOne 连续返回 `601 upstream_balance_exhausted`（HTTP 200、未计费，上千次），而 JustOne 熔断按供应商共享，所以 JustOne 的所有电商平台都会被拒。
- TikHub 当前目录（OpenAPI V5.3.2，10-29 实测）没有淘宝、京东、天猫、闲鱼接口；只有小红书电商商品和 TikTok Shop。
- 交接文档中的 RapidAPI 通道 `taobao-tmall-all-api1.p.rapidapi.com` 是同一 JustOne 后端（同路径、同参数、同返回），只是认证和计费不同，只覆盖淘宝/天猫。主机已确认在线（无 Key 返回 401）。

**结论：** 淘宝、天猫可以切到 RapidAPI 通道继续使用。京东、闲鱼、小红书电商、抖音电商目前没有第二个兼容供应商，只能等 JustOne 充值。

## 改动

### 1. 统一商品搜索的供应商路由（管理可切换或固定）

每个平台一条路由，存于 `control.ecommerce_product_routes`（迁移 `167` 新增 `mode`、`fallback_adapter_id`）：

| 方式 | 行为 |
| --- | --- |
| 固定（`fixed`，现有行均为此方式） | 只用所选供应商；不可用时返回失败，不调用其他供应商。 |
| 主用 + 备用（`priority`） | 主用不能执行，或明确拒绝且未计费时，同一请求改由备用执行一次。 |

- “不能执行”：熔断中、凭据未配置、操作未启用/暂停、Hub 限流。
- “明确拒绝且未计费”：JustOne 非零业务码（如 601 余额、100 鉴权、302/303 限流配额）；RapidAPI 网关自己返回的 401/402/403/429（带 `x-rapidapi-proxy-response: true`）；System Proxy 无可用出口。
- **不切换**：已计费（含返回 200 但无法解析）、结果未知（超时、断连、代理 5xx）、请求参数错误。避免同一页重复付费。
- 切换时，主用调用按原样记账（未计费、计入主用自己的熔断），备用调用作为同一 usage request 的第 2 次调用（`call_ordinal=1`）。主用先释放派发租约、采购冻结和并发槽，备用才能接手。
- 对调用方完全透明：请求、返回结构、游标、幂等回放都不变，公开文档和响应中不出现供应商名称。游标绑定的是上游接口合同，不绑定供应商，切换后旧游标照常续页。
- 只有淘宝、天猫有两个候选（JustOne 直连、RapidAPI 通道），其他平台只能固定 JustOne。

入口：「电商数据 → 管理」顶部，或「数据清洗中心 → 数据平台 → 电商平台」。每次保存需要填写原因，按修订号防并发覆盖，并写入审计事件。

### 2. RapidAPI 淘宝/天猫通道

- 复用 JustOne 适配器和解析：只换主机为 `taobao-tmall-all-api1.p.rapidapi.com`；Key 放在 `x-rapidapi-key`/`x-rapidapi-host` 请求头，不带 query token；经现有 RapidAPI System Proxy 出网。该通道只允许商品搜索。
- 使用与 Twitter/Facebook 相同的 RapidAPI Key（上游供应商 → RapidAPI 中的凭据）。**这个 Key 需要先在 RapidAPI 订阅该淘宝/天猫 API**，否则返回 403，记为 `upstream_permission_denied`。
- 熔断按平台隔离：这个通道的失败和恢复只记在 `rapidapi/taobao`、`rapidapi/tmall` 的平台熔断上，不读也不写 RapidAPI 全局熔断，不会连带暂停 Twitter/Facebook；反之亦然。
- 运营操作：迁移 `168` 新增 `rapidapi / ecommerce.products.search` 发布，初始 `disabled`。在「上游供应商 → RapidAPI」里审核采购价（端点 `taobao-tmall.product-search.v1`）并启用。正常 deploy 的补价流程只补缺失价格，并只激活带审计的初始禁用项；没有改路由前不会被调用。

### 3. TikHub 电商接口接入「电商数据」

按 10-13 快手电商的做法，基于已审核的 TikHub 读取合同新增 17 个电商域键（`authorizationPlatform=ecommerce`，原生转发，不归一为统一商品结构）。原社媒键、授权和价格不变。

- 小红书电商（5 个）：`t.xiaohongshu_ec_search_products`、`_product_detail`、`_product_review_overview`、`_product_reviews`、`_product_recommendations`
- TikTok Shop（12 个）：`t.tiktok_shop_search_products`（及 `_v2`）、`_search_word_suggestion`、`_product_detail`（及 `_v3`）、`_product_reviews`、`_seller_products`（及 `_v2`）、`_category_list`、`_products_by_category`、`_product_id_by_share_link`、`_shop_id_by_share_link`

迁移 `168` 为它们创建发布，初始 `disabled`。需要在「上游供应商 → TikHub」审核价格并启用，并给 Key 授予 `ecommerce` 数据域及对应 `native.t.*` 操作。未做付费样本校准，不宣称字段已验证。

### 4. 接口调试与文档

- 统一商品搜索新增示例：淘宝按销量（含天猫商品）、仅天猫、淘宝价格区间、闲鱼最新；接口调试页新增「请求示例」下拉，选择后只填入请求体，不会发送。
- 契约说明补充供应商切换规则（不含供应商名称）。
- 电商数据页说明淘宝/天猫可在「管理」切换供应商，以及小红书电商、TikTok Shop 的专用接口。
- RapidAPI 网关拒绝对外的错误码与 JustOne 同类错误一致：余额 → `external_platform_capacity_unavailable` + `reasonCode=ecommerce_service_credit_exhausted`；鉴权或未订阅 → `external_platform_capacity_unavailable`；限流 → 429 `external_platform_capacity_exceeded`。电商公开错误继续不暴露上游原始业务码（10-15 的决定）。原始码在诊断中心和下方诊断里可查。

## 只读诊断：电商供应商现状

`server/ops/diagnose-ecommerce-search.mjs`（`ecommerce-search-diagnostic.v1`）读取：

- 各平台路由（部署前后都可读）
- JustOne 熔断、各平台熔断、两个供应商的操作启停状态
- 两个供应商最近 N 小时（默认 24，最多 168）按平台、结果、HTTP、业务码、错误码、是否计费分组的调用数
- 最近一次成功时间

只读事务，不读凭据、响应体或查询词，不调用上游。不需要先部署：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - 24 < server/ops/diagnose-ecommerce-search.mjs
```

判读：

- `justone` 出现 `businessCode=601` / `upstream_balance_exhausted`：JustOne 余额不足，需要充值。
- `rapidapi` 出现 `httpStatus=403`：Key 未订阅淘宝/天猫 API。`401`：Key 无效。`429`：套餐额度用尽。

## 部署与启用顺序

1. 部署（含迁移 167、168）：

   ```bash
   MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh ops internal-production deploy
   ```

2. 在 RapidAPI 控制台，用 Hub 当前的 RapidAPI Key 订阅 `taobao-tmall-all-api1`。注意套餐是否会产生超额扣费。
3. 「上游供应商 → RapidAPI」：核对「电商商品搜索 · 淘宝/天猫」的采购价并启用。
4. 「电商数据 → 管理」：淘宝、天猫改为「主用 + 备用」（JustOne 主用、RapidAPI 备用），或在 JustOne 充值前直接固定 RapidAPI。
5. 用接口调试发一次淘宝搜索确认，再用上面的诊断复核 `rapidapi` 调用为 `succeeded`。

不做第 4 步时，线上行为与部署前完全一致。

## 测试

- 新增 `tests/server/ecommerce-supplier-routing.test.mjs`（9 项）：
  - 候选与游标规则
  - 路由校验、修订和审计
  - RapidAPI 请求头认证和网关拒绝分类
  - 余额拒绝在同一请求内切到备用：调用序号 0/1，租约已释放，幂等回放不再调用
  - 熔断时派发前切换；固定路由、已计费或未知结果不切换
  - RapidAPI 主用失败只计入淘宝平台熔断
  - 17 个 TikHub 电商键
  - 诊断只读且不输出未知值
  - 迁移 167/168 可重复执行（PGlite 实际执行）
- 平台熔断恢复用的 Postgres SQL 已在 PGlite 上验证：只清除本平台。
- 完整服务端套件：失败项与原有 45 项一致（原 148 迁移的 PGlite 路由测试已补上 167）。类型检查通过。
- 本机开发界面（内存存储）验证：「电商数据 → 管理」可把淘宝改为主用 JustOne、备用 RapidAPI 并保存；接口调试的「请求示例」下拉只填入请求体；无控制台错误，未发出任何数据请求。
