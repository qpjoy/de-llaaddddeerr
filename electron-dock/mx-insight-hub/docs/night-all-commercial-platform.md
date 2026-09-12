# Night-All 数据平台与客户收费

本次将 Night-All 作为第三个管理端数据平台，范围为 raw / crawl / user-info。保留全部旧 API 路径、授权、分页、原响应、幂等与快照合同。没有增加第二层付费预约或重新调用上游；现有兼容接口已经通过 Hub 客户账本结算。

## 成本与价格

- Night-All 对 Hub 的服务转移价定义为 0。这不代表 Night-All 内部供应商、计算、数据库及带宽成本为 0。
- 对客户按已交付请求计价，计费键 raw、crawl、user-info；不是按图片/返回条目，也不是平台转移价加成。每个业务平台仍需 API Key 授权。
- 在「外部数据平台 → Night-All」进入「套餐与配额」，发布套餐时可一次添加这三个计费键；输入合同价格，0 即免费。该快捷操作只填表，不发布、不分配、不扣款。
- 发布不可变套餐版本，再分配到对应调用身份。不同租户可分配不同套餐。租户模式 disabled 不扣款、shadow 只记录报价、enforced 按可用余额预约与结算。既有租户不自动变价。
- 相同请求/幂等键重放不重复扣款；未知结果沿用既有资金保持/对账语义。成功交付旧快照也沿用既有请求收费合同，不能误称为新上游采购。
- 小红书已经走 Hub 直连的分支使用 social.posts.search / social.users.resolve / social.users.posts 等已有键。不要把按执行器命名的 night-all.* 新键替换旧键，否则会破坏既有套餐。
- 价格为 0 不等于免鉴权、免配额、免工作预算。work_budget_exceeded 是独立的预检拒绝；现在支持按调用身份 × 平台配置 maxCrawlWork，但不自动提高已有租户的预算。

## 统计边界

统计从 serving.connector_calls 和 usage_requests 聚合，按操作、业务平台分组。只统计有 connector 证据的逻辑请求；不包含预检拒绝、重放 HTTP 次数、小红书直连、data/search、后台回填。调用记录创建早于网络调用，表示分发证据边界，不保证上游实际接收；超时/未知状态保留，不伪造成功率。

无调用时健康为 unknown，不主动探测或采集。当前不把 Night-All 部署凭据暴露为可编辑/可揭示的供应商 Key；相关修改入口返回明确的 409。服务转移价固定 0，客户售价走统一套餐，不使用 JustOne/TikHub 的采购价编辑器。

## 部署与验证

前后端一起发布；迁移 074 增加按时间查询 connector 记录的部分索引，避免新增平台总览只依赖以 consumer 开头的索引。既有大型表建议按运维规范在低峰构建同名索引，必要时先用 CREATE INDEX CONCURRENTLY 在迁移事务外构建，迁移再通过 IF NOT EXISTS 跳过。

验证覆盖三种操作的收费/零价与幂等重放、预算拒绝不触发采集、平台响应不泄露部署地址/凭据、独立 PostgreSQL 聚合及浏览器平台/套餐入口。未修改 Night-All 本体、MX-H2I 登录联网、数据回填或 mx-static。

## 采集总工作预算（迁移 075）

“开放能力”选择租户、调用身份，再配置 Twitter 等具体平台的 **采集总工作预算（crawl）**。该字段由管理端设置，不能由公开请求或 params 覆盖。范围 1–5000；默认 100；旧策略迁移取 min(maxPageSize,100)，避免自动提高原有平台工作量。API Key 套餐的 maxPageSize 仍限制单页条数；maxCrawlWork 为调用身份与平台共享的独立单请求预算，并非 Key 单页参数。修改或开关平台时省略此字段会保留已有预算。

工作量 = 身份数 × 有效每身份条数 × 活动类型数。count/pageSize/limit 按顺序取值，默认 20。仅去除同类别名中的完全相同值，不猜测用户名和用户 ID 是否对应同一账号。仍最多 50 个身份，单页仍不超过 100。两个账号各 100 条需要预算至少 200；一个账号一个活动类型的 100 条本身可通过默认预算。因此没有原始请求时不能声称 target_count=100 必然触发拒绝。

超出总预算返回 HTTP 400 work_budget_exceeded，并附 error.details：identityCount、pageSize、activityTypeCount、requestedWork、allowedWork、stage=admission、upstreamDispatched=false、retryable=false。拒绝发生在预留和上游调用之前，下游不应按原参数重试。调高预算不等于提高并发、超时或上游单页限制。价格 0 只影响费用；不要为解除预算错误取消鉴权/限流，也不要把预算自动映射为收费倍数。

部署先运行迁移 075，再发布后端与前端。按需将受影响调用身份的 Twitter maxCrawlWork 设置为例如 200/500，而不是全局提升。回退应用版本可保留新增数据库列；原版本仍按单页限额约束总工作量。迁移不修改 MX-H2I 登录、联网或 Night-All 服务。
