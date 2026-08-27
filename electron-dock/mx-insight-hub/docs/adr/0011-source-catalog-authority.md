# ADR-0011: 数据源目录权威性、覆盖证据与数据计划边界

- 状态：Accepted
- 日期：2026-08-27

## 背景

Hub 当前的“外部数据源”页面管理物理 PostgreSQL/文件 source、版本化 mapping、import run，
并展示 Telegram monitor、Telegram SQLite API 和全国省份舆情等固定业务清洗管线。它适合
操作接入和清洗，但不能回答完整的平台覆盖、分类、区域、负责人、优先级、合规、计划和汇报问题。

用户提供的飞书多维表格材料包含同一平台清单的底表、已覆盖、未覆盖、当前支持和 15 字段详情。
这些文件适合成为一个 Hub-owned 业务目录的种子数据，不适合长期保留成四份可独立修改的事实。
当前材料有 215 条稳定序号，其中 29 条已覆盖、186 条未覆盖；两个状态文件精确分区底表，
`01.support_platform.txt` 是已覆盖集合的窄投影，`03.txt` 是一对一详情。序号 62 还存在
“抖音电商/抖音小店”名称冲突，证明导入需要 alias、review 和 evidence，而不是直接覆盖。

同时，目录中的“已覆盖”不能等同于：

- 一次数据库连接测试成功；
- Night-All 有一个 provider 标签；
- external source 为 `active`；
- ES 中存在文档；
- 某个人在 UI 中勾选完成；
- 整个平台的所有 capability 都已发布。

Hub 已接受 [ADR-0005](./0005-authoritative-data-and-search-projections.md)：PostgreSQL 保存规范事实、
checkpoint、发布、权限和账本，Elasticsearch 是可重建查询投影。Hub 也已在
[ADR-0007](./0007-managed-data-sources-and-change-watermarks.md) 中把 physical source、immutable
mapping、cursor 和 import evidence 建模。需要一个新决策说明业务目录如何复用这些事实，
以及它不能接管哪些 Launcher、Night-All 和 MX-H2I 职责。

详细产品行为见
[数据源目录、多维管理与数据计划](../product/source-catalog-and-data-plans.md)。

## 决策

### 1. 建立一个 Hub-owned 业务数据源目录

Hub PostgreSQL 保存唯一权威的 platform entry、taxonomy、region/tag、capability、owner、
coverage assertion、evidence、saved view 和 data plan。

“数据源”在目录语境中表示业务平台/能力，例如抖音评论、Telegram messages 或淘宝商品；
`catalog.external_sources` 继续表示一张物理外部表、一个文件 family 或一个可拉取输入。
两者的目标模型通过稳定引用关联，不合并成一张表。Phase 1 先以目录规范名称与唯一归属的 alias
归一匹配，平台改名自动保留旧名；显式 source/dataset binding 在后续 relation migration 中补齐。

现有五份文本只用于可审计的基线导入：

- `02.base.txt` 生成 215 条目录草稿；
- `02.fugai.txt`、`02.weifugai.txt` 和 `01.support_platform.txt` 生成系统 saved view/初始
  coverage evidence，不生成重复目录行；
- `03.txt` 按序号合并详情字段；
- 名称、列语义或重复冲突生成 warning/alias proposal，必须审核；
- 原始 input hash、parser/mapping version 和人工修正永久可追溯。

目录项的删除语义是**软归档/恢复**，管理 API 不提供物理 `DELETE`。归档只把平台移出活动目录、
默认汇总和选择列表，不删除 `core.canonical_records`、`catalog.external_sources`、mapping、import
run、dataset、文档或 ES 投影。平台详情按规范名称与 alias 汇总既有 canonical 数据、物理 source
和索引分块；平台改名必须保留旧名称为 alias，避免显示名变化切断既有数据的查询入口。

大类、细分场景、区域和 tag 是有稳定 key、revision、审计和归档状态的独立治理词条，不再只从
现有目录行临时 `distinct`。新词条可以在目录编辑器中选择；仍被任意活动或已归档目录引用的词条
不能重命名或归档，服务端返回 409 和引用数量，必须先显式迁移引用。词条变更绝不级联删除平台、
canonical 数据或历史证据。

### 2. 覆盖在 capability 粒度记录

平台目录项至少包含一个 versioned capability。`content.search`、`comments.list`、
`profile.get`、`commerce.product`、`live.segment` 等分别记录 coverage、owner、priority、
compliance、access path 和 evidence。

平台级“覆盖率/已支持”是版本化汇总口径，不是可单独编辑的事实。没有定义 in-scope
capability 的平台不能显示 100%。目录显示名和 tag 也不能直接成为公共 API capability/grant；
公共能力仍遵循 Hub module contract 和 consumer authorization。

### 3. 状态分轴，不保存一个万能 `status`

Phase 1 目录明确区分四条已落地的强类型轴：

1. coverage：`unknown/not_covered/partial/covered`；
2. delivery：`exploring/planned/doing/blocked/complete/paused/retired`；
3. field review：`needs_review/verified/rejected`；
4. runtime health：`not_configured/unknown/healthy/degraded/failed`。

现有 physical external source 继续使用自己的 `active/paused` 运行状态，不写入目录 delivery。
未来 capability 与 dataset publication 再增加 `draft/review/published/suspended` 发布轴，而不是
复用上述任一字段。

一个已完成项目可以临时 degraded；一个 healthy connection 也可以仍未覆盖。任何 API、统计和
UI 都不得把这些轴折叠为一个通用 `status`。

### 4. 支持有证据的人工 override

具有 review 权限的用户可以人工设置覆盖阶段，包括将已有 Telegram 数据和文档产出标为
`complete`。override 必须记录 prior derived stage、目标阶段、理由、evidence、actor、approver、
时间和可选过期时间。

override 不删除派生 readiness/health，也不自动发布 dataset。UI 同时显示人工结论与运行事实。
到期 override 进入复核，不静默续期。

Phase 1 的平台级 `coverage_status` 与 `delivery_status` 是可直接人工维护、带 revision/audit 的
对外汇报口径；`runtime_status` 是系统观测事实。自动发现 source、canonical 数据或索引分块只能
补充运行证据和建议，不能静默覆盖人工覆盖结论或把“已有数据”自动宣称为 `covered/complete`。

### 5. acquisition、cleaning、archive 和 publication 是不同 plan type

一个 versioned `data_plan` 父对象承载负责人、优先级、范围、状态和验收标准，具体类型分别回答：

- acquisition：从哪里、以什么合同和预算获取数据；
- cleaning：使用哪些 mapping/transform/quality/Agent 规则规范化已有输入；
- archive：怎样 backfill、不可变留存、retention、恢复和形成 snapshot；
- publication：怎样通过 schema/质量/字段策略门禁发布 dataset version。

连接地址和 credential 属于 physical source；bucket/prefix 属于存储策略；title/body 等字段属于
mapping/schema version；规则属于 transform version。Plan run 绑定这些精确版本、输入快照、
PG commit、outbox/ES 状态、计数、质量和耗时。

现有固定 Telegram/舆情业务管线可以被目录引用和以 cleaning plan 视图呈现，但在通用 durable
plan schema 落地前，不把 UI 聚合伪装成已经存在的 DAG 或父事务。

### 6. Agent 只能作为有界、可审核的 plan step

Agent 可以建议 mapping、taxonomy、分类和 enrichment，或解释 drift/质量异常。它的输出是
带模型、prompt、input scope、cost 和 evidence 的 proposal/assertion，默认不批准。

Agent 不能获得 source/provider credential、任意 Night-All route、任意 SQL/ES DSL/shell，
不能改变 identity、watermark、checkpoint、tombstone、grant、credit 或 publication，也不能因
provider 不可用而阻塞 raw/canonical 基线同步。

### 7. PostgreSQL 是唯一事实，ES 只由 outbox 投影

目录 CRUD、覆盖统计、saved view、审计、导出和 authoritative Dashboard count 读取 PG 或由
PG 维护的物化 aggregate。目录规模不以 ES 为前置。

需要全文/facet/geo 时使用既有模式：同一 PG 事务写业务变更、revision 和 outbox，projector
重读 PG current truth 后以单调 revision 写 ES。禁止应用请求双写 PG/ES。ES 可完全删除并从
PG 重建；ES down 只降级全文，不能改变覆盖、计划或发布状态。

### 8. 保存视图不是复制表

底表、当前支持、已覆盖、未覆盖、doing、exploring、P0、无负责人、证据过期等都保存为
versioned filter/group/sort/column/view configuration。视图只保存 query AST 和展示配置，不复制
结果 JSON 或目录行。

系统视图由 platform admin 管理；用户可以创建私人/团队视图。大屏和目录必须使用同一个
versioned summary/query contract，显示 as-of 和口径。

### 9. 业务目录权限与 source secret 权限分离

Launcher 继续认证人员，Hub 用 federated principal + Hub-local role 授权目录。编辑 taxonomy、
平台元数据或覆盖状态不授予 source connection 管理权。

现有 physical source connection/secret 继续只对 Admin Token 可见和可修改。目录、custom field、
saved view、export、日志和普通 Launcher session 只得到稳定引用、健康和
`credentialConfigured`，不得得到 password、DSN、token、cookie 或 header。

公共 API key 不能访问目录管理面。若后续需要 tenant-specific row scope，必须新增显式模型和
migration，不从 Launcher organization 或 Hub membership 自动推导。

### 10. 导航和视觉采用 Hub 大屏语法

当前 Hub Dashboard 的大屏构图和 Neon Void 视觉是新模块的直接视觉基线。用户提供的飞书截图
只决定多维表格交互，不改变 Hub 品牌和暗色大屏语言。

左侧新增“数据源目录/数据源总览”。现有“外部数据源”功能改称“接入与清洗计划”，其 source、
mapping、import 和固定 pipeline 行为保持向后兼容。改名不能扩大现有 API 或权限。

### 11. MX-H2I 登录和联网是零耦合硬门禁

本决策只增加 Hub 数据库、Admin API/UI 和可选 Hub worker/projector 行为。它不得：

- 修改 Launcher 用户表、密码/飞书登录、session、organization 或认证限流合同；
- 修改 MX-H2I connect/disconnect/recovery、lease、WG、route、PAC、DNS、NRPT、resolver、2053
  或 ownership；
- 为 Hub 创建 ProductNetwork、endpoint lease、peer 或 network capability；
- 修改 HDO V1 Domestic 用户/DNS/`100.*` 路径；
- 把 Hub/PG/ES/Agent/source readiness 加入 Launcher readiness/connect gate；
- 在普通 Hub deploy 中同步 Launcher Secret/ConfigMap 或 rollout Launcher。

普通发布保持 `MX_INSIGHT_SYNC_LAUNCHER=0`。目录大屏使用有界聚合 API，不因组件轮询重复密码
登录或放大 introspection。import/backfill/reindex/projector 有资源和速率上限。

发布必须按
[Launcher/Hub 回归矩阵](../../../mx-launcher/docs/26-mx-insight-hub-integration-architecture.md#10-回归门槛)
验证 guest、密码、飞书、切换身份、reconnect/disconnect，以及 WG/route/PAC/NRPT/resolver/
ownership diff。Hub absent/down、PG/ES/Night-All/Agent down 和压力场景都不能改变 MX-H2I 会话
或网络状态。

## 后果

### 正向后果

- 飞书材料成为一份可治理的目录，不再靠复制“已覆盖/未覆盖”表保持一致；
- 平台、能力、物理来源、计划、run、dataset 和 evidence 之间可以逐层下钻；
- 人工项目判断与真实运行健康可以同时表达；
- Dashboard、汇报、导出、BI 和 Agent 共享同一版本化口径；
- ES 故障或重建不会丢失目录和治理状态；
- source secret 权限不因多维表格功能而扩大；
- Hub 发布保持与 MX-H2I 登录/联网隔离。

### 成本和约束

- 需要新的 PG 目录/计划 schema、revision、audit、outbox 和权限能力；
- 从五份文本导入前必须解决 header 语义、alias 和人工修正流程；
- capability-level coverage 比单一平台勾选更精确，也需要更多初始建模；
- saved view、custom field、relation/formula、automation 要分阶段交付，不能用任意 JSON/代码
  快速绕过权限和审计；
- 现有 source connection 明文凭据仍是独立安全债务；本 ADR 不把它扩散到目录，也不声称已完成
  secret-store 迁移。

## 拒绝的方案

### 将五份文本导入为四张可编辑业务表

拒绝。它会使覆盖状态、名称、负责人和详情持续漂移；当前文件已经证明这些只是底表、筛选和
一对一扩展。

### 直接把 `catalog.external_sources` 当平台目录

拒绝。一平台可能有多个 capability、provider 和物理输入；一个数据库连接也可能服务多个表和
业务计划。连接健康不是业务覆盖。

### 只在平台行保存一个 `covered` boolean

拒绝。它不能表达能力差异、exploring/doing/verifying、运行降级、发布暂停、证据和人工 override。

### PostgreSQL 和 ES 同时作为可编辑事实库

拒绝。双权威需要跨存储一致性协议，仍无法为 ES 补足事务和完整审计；近实时 refresh 还会使
大屏数字与管理表短暂矛盾。

### 让 Agent 自动分类、批准、连接和发布

拒绝。模型输出不可作为 identity、水位、删除、授权或数据模型变更的不可审计真相。

### 把 source secret 放进 generic custom field

拒绝。自定义字段会进入表格、搜索、导出、revision 和审计面，显著扩大凭据泄露范围。

### 为目录新增 Launcher 网络 owner 或登录依赖

拒绝。目录是 Hub Admin 数据功能，Hub offline 必须继续只显示卡片/页面不可用，不能影响
Launcher 登录、MX-H2I connectivity 或 HDO V1。

## 兼容与实施说明

- 本 ADR 本身不修改 migration、API、代码或部署；实现按产品文档的 phase 分批提交；
- 现有 source、mapping、import、Telegram/SQLite/舆情 pipeline ID 和运行行为保持兼容；
- 现有 `/sources` API 不因导航改名而改路径；未来目录使用独立 namespaced Admin contract；
- 第一次目录 migration 只能新增 Hub-owned schema/table/index/outbox，不修改 Launcher/Night-All DB；
- 初次数据导入保持 draft，不自动启用 source、Agent、provider 调用或 dataset publication；
- 每阶段上线都执行 MX-H2I 零回归矩阵，并保留 Launcher deployment/network diff 证据。
