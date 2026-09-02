# 虚拟超市数据产品与公开契约

- 状态：Accepted
- 日期：2026-09-02
- 范围：MX Insight Hub 数据产品、`virtual_supermarket` Public API 与手机电商采集的发布投影

## 1. 产品目标

“虚拟超市”是 Hub 管理的商品发布面，不是原始采集表的立体化查询器。首个商品类型
来自 `mobile-commerce.collected-items.v1`，后续其他已治理商品源可以在不改变超市概念的前提
下加入。

产品确认三种视图：

1. **逛超市**：通过部门、通道和货架渐进式浏览；
2. **超市全景**：用空间化 renderer 展示相同的部门/通道/货架关系；
3. **目录模式**：用高密度列表、筛选和管理操作呈现同一份数据。

三种视图共享一个发布快照、筛选和商品 ID。全景只是 renderer；Hub 业务与 Public API
只表达 `department / aisle / shelf / position` 语义，不持久化或公开摄像机、WebGL 坐标、网格、
材质、灯光、LOD 或交互引擎参数。外部系统可以根据这套语义关系复刻业务等价的超市，
但不需要复制 Hub 的前端实现。

## 2. 采集观测与商品发布

必须分离两种身份：

- `mobile_commerce / commerce_capture` 是一次不可变采集观测；源 `id` 是 capture identity；
- virtual-supermarket product 是 Hub 拥有的发布记录，有独立 UUID、商品字段、分类、摆放、
  上下架状态和 revision。

`goods_id` 只有在对应 marketplace 的格式和稳定性已审核时才能帮助解析商品实体。
它为空时，发布记录保持 `capture-listing`，不按标题、价格、店铺名或页面位置合并。
任何概率/Agent 匹配只是待审言断，不改变 capture 或 publication identity。

“上架”是创建或激活发布记录；“下架”使它从 Public 投影中消失。下架/归档绝不删除
canonical capture、revision、源证据或 outbox 历史。对下架、归档或不存在的商品，Public
详情使用统一 404，避免通过存在性探测内部状态。

## 3. 商品分类与货架

源目录的“国内电商与本地生活 / 快手小店 / 淘宝”回答“数据来自哪里”，不是商品品类。
虚拟超市建立独立、有稳定 ID 和排序的商品 taxonomy：

```text
department 部门
└─ aisle 通道
   └─ shelf 货架
      └─ position 货位顺序
```

department/aisle/shelf 是语义容器，每层有稳定 ID/key、展示名称和有界排序。
`position` 是同一 shelf 内的 merchandising 顺序，不是三维坐标。商品的 marketplace 是可筛选
来源 facet，不决定货架。

初期分类可由运营人员手工确认，或由可重放确定性规则产生。Agent Studio 可对标题、已审核标签和
规格候选生成结构化建议，但建议必须带源 revision、证据、规则/Agent 版本和置信度，经人审
才能变成发布字段或货架摆放。Agent 不自动上架、下架、合并、删除或修改授权。

## 4. 价格、规格、品牌和图片

- 价格 amount 使用 decimal string，不使用浮点数。当前固定源没有 currency 字段，因此 source
  价格的 `currency=null`，不能凭平台或地区猜成 CNY；只有人工 curated price override 同时写入
  amount 和已审核的三位 ISO currency。商品外层 `collectedAt` 表明这次采集观测时间，不宣称是
  手机平台的实时成交价。
- sample `brand` 像采集任务/监测活动名，不能直接升格为商品品牌。v1 Public projection
  不发布 brand 字段；将来只有在品牌语义和审核规则稳定后才能通过新契约加入。
- 规格可能藏在标题、混合 `tags` 或 share text 中。只发布经审核规则解析或手工编辑的值；
  未确定时是 `null`，不根据标题自由生成。
- 当前固定源没有可发布图片字段，所以 v1 Public projection 不定义 media 字段，界面使用
  分类占位符且不伪造商品图。未来只允许通过已审核、可公开访问的 Hub media 投影和新契约发布。

## 5. Public API 授权与投影

Public 授权平台为 `virtual_supermarket`，与 `mobile_commerce` 采集读、`source_catalog` 源目录读
分离。授予虚拟超市不会赋予 capture API、源目录、Admin CRUD 或未来远程采集能力；反向也不成立。

Public 只返回已上架的安全 projection，并显式拒绝任意原始/执行字段。v1 allowlist 为：

- Hub publication ID/revision、上架状态和数据版本；
- title 与已审核 specification；
- decimal price、nullable currency、display/provenance 与外层 collection time；source currency
  保持 null，curated override 才携带已审核的三位 ISO currency；
- category path 与 department/aisle/shelf/position；
- 只含 approved public directory identity/name 的 marketplace `{id,name}`、shop 显示名称和 sales signal；
- title/specification/price 的 `curated | source | missing` provenance。

不得返回 capture/source row ID、marketplace product/shop source ID、marketplace raw label/映射状态/内部
source key/revision、task/run/keyword/campaign label、raw tags/signals/share payload、metadata/device/`is_reported`、
source table/profile/checkpoint/run、Admin actor/audit、SQL/ES index/DSL 或凭据。未有 approved marketplace
mapping 时 Public `marketplace.id/name` 均为 null；完整治理证据只留在 Admin DTO。

## 6. 快照、排序和游标

metadata 与每个商品页返回 `storefrontRevision`。不透明 cursor 绑定：

- 完整规范化 filters；
- sort 和商品分类/货架范围；
- page size；
- `storefrontRevision`。

调用方只能原样回传 `nextCursor`。当前 v1 不保留旧发布快照；发布 revision 变更后，旧 cursor
返回 `409 storefront_revision_changed`，调用方重新读取 metadata 并从首页开始，不能静默混合两个 revision。

商品列表默认使用 `newest`；v1 还支持 `title_asc / price_asc / price_desc`，不提供服务端
merchandising sort。外部应用要复刻完整超市时，必须在同一个 `storefrontRevision` 下从无 cursor
的首页逐页读取到 `nextCursor=null`，再按 metadata 中 department/aisle/shelf/category 的
`sortOrder` 和 item 的 `placement.position` 在客户端陈列；position 相同或为空时以稳定 publication
UUID 作为 tie-breaker。metadata revision 与任一商品页不一致，或分页中收到
`409 storefront_revision_changed`，都必须丢弃未完成的本地快照，重新读取 metadata 和首页。

Admin 商品库存还包含未发布 capture，因此它使用独立、不透明的 `inventoryRevision`。Admin cursor
同时绑定 storefront 与 inventory revision；canonical inventory 在分页间插入或更新时返回
`409 virtual_supermarket_inventory_changed`，管理端从无 cursor 首页重拉。这个内部库存 fence 不进入
Public DTO，也不会因尚未上架的新 capture 而无意义地打断 Public storefront 分页。

搜索可以使用 Elasticsearch 的可重建投影，但 PostgreSQL 发布快照仍是权威。Public 请求只选择
产品筛选/profile，不接受 index、field、DSL、script 或 boost。

## 7. Agent Studio 的可复用经验

`mobile-commerce-data-processing` 仍是 compile-only 映射建议模板。为虚拟超市和后续商品源累积以下结构化经验：

1. **源格式**：字段字典、空值/类型/长度/基数、平台差异、时区、share-text 与混合字段语法、漂移样本；
2. **分类**：“来源平台目录”与“商品 taxonomy”分离，候选 category path、原值、证据、置信度、审核决定和 taxonomy revision；
3. **身份**：capture identity、marketplace goods ID 可靠性、source-product/capture-listing 边界、合并/拆分反例和结果可逆性；
4. **价格与规格**：decimal/nullable-currency/time 规则（不得从平台猜币种），标题/tags/share-text 解析证据，原值、parser version、confidence/error，品牌/规格不确定性；
5. **发布与安全**：上下架、货架摆放、Public allowlist、敏感字段、快照/revision、人审与 rollback 证据。

这些经验可用于训练/eval 未来的数据处理 Agent，但当前生产仍使用固定映射、人审分类和显式发布。
文档和界面不得暗示 Agent 已能自动发布或保证身份/分类准确性。

## 8. 隔离性与验收

虚拟超市只属于 MX Insight Hub 的数据产品和 Public API 边界。它不修改 MX Launcher/MX-H2I
登录、Domestic/Internal 路由、WireGuard、DNS 或现有用户联网。

验收至少证明：三种视图读取同一份发布数据；全景缺失时目录模式仍可完整使用；下架不删除
capture；Public 只看到已上架 allowlist；cursor 不混合 revisions；只有明确 `virtual_supermarket`
grant 的 consumer 可以发现和读取该产品。
