# 数据源目录、多维管理与数据计划

- 状态：Phase 1 已实现；能力级目录、团队视图、公式/自动化等按本文后续阶段演进
- 日期：2026-08-27
- 关联决策：[ADR-0011：数据源目录权威边界](../adr/0011-source-catalog-authority.md)

## 1. 目标与产品定位

MX Insight Hub 需要一个面向内部运营、数据治理、接入交付和汇报的
“数据源目录”。它回答的不是“有哪些数据库连接”，而是以下业务问题：

- 我们关注哪些平台、区域、场景和能力；
- 哪些能力未覆盖、探索中、实施中、验证中或已经完成；
- 每项覆盖由哪条 Night-All capability、Hub source、文件、数据库或人工证据支撑；
- 谁负责，优先级、合规边界、质量、时效和最新证据是什么；
- 下一步要获取什么数据、怎样清洗、怎样归档、怎样发布；
- 大屏、汇报、查询和 Agent 当前能使用哪一个已发布 dataset version。

该模块不是 Night-All provider registry 的复制品，也不是
`catalog.external_sources` 的换皮页面。它是一个业务目录和治理控制面，向下关联物理
source、mapping、plan、run、dataset 和 evidence，但不把这些对象压成一张无法解释的宽表。

现有“外部数据源”页面继续承担 PostgreSQL/文件 source、mapping、import，以及固定
Telegram/省份舆情业务管线的操作。它在导航和文案上改称 **接入与清洗计划** 更准确；
新的 **数据源目录** 作为独立左侧入口，先展示大屏，再提供多维表格与管理视图。

本文遵守以下既有边界：

- Hub 是独立数据产品，不是 Night-All 反向代理别名，见
  [System context](../architecture/system-context.md)；
- PostgreSQL 是目录、canonical、checkpoint、policy 和 lineage 真相，ES 是可重建投影，见
  [数据平台存储、检索与服务架构](../architecture/data-platform-storage-and-serving.md)；
- physical source 与业务清洗任务不是同一个抽象，见
  [共享数据面 §8.5](../architecture/shared-data-plane-and-search.md#85-source-与清洗任务不是同一个抽象)；
- Launcher 登录、MX-H2I 联网和 Hub 数据产品授权彼此独立，见
  [Unified identity](../architecture/unified-identity-and-platform-modules.md) 和
  [Launcher/Hub 集成架构](../../../mx-launcher/docs/26-mx-insight-hub-integration-architecture.md)。

### 1.1 当前已交付边界（Phase 1）

Phase 1 已提供独立 `/source-catalog` 管理面、215 条确定性 seed、PG migration、Admin API、
乐观锁与审计、Hub 大屏总览，以及底表/已覆盖/未覆盖/进行中/P0/无负责人/归档等保存视图。
多维表格已经支持搜索、组合筛选、分组、排序、行高、浏览器私有视图、批量状态、CSV 导出、
tag 回车新增、详情编辑、软归档/恢复和变更历史。

这不把“超过飞书全部能力”虚报为一次性交付。团队共享视图、字段级权限、评论、提醒、公式、
跨表 relation/lookup、看板/日历、自动化和 Agent 建议仍是后续阶段；它们必须建立在 Hub 权限、
审计和版本合同上，不能通过任意 JSON 或修改 Launcher 登录来捷径实现。

Phase 1 使用四条互不覆盖的强类型状态轴：

- `coverage_status`：`unknown / not_covered / partial / covered`；
- `delivery_status`：`exploring / planned / doing / blocked / complete / paused / retired`；
- `review_status`：`needs_review / verified / rejected`；
- `runtime_status`：`not_configured / unknown / healthy / degraded / failed`。

其中 `02.fugai/02.weifugai` 只初始化 coverage；现有 29 个 covered 项中，只有具备 Hub 文档与
pipeline 证据的 Telegram 公开频道/公开群组初始化为 delivery `complete`，其余初始化为
`doing`。运行状态独立保持 `unknown`，避免把“已有交付证据”误报为“当前链路健康”。

## 2. 输入资料与解释规则

### 2.1 视觉和交互基线

视觉来源按以下优先级执行：

1. **当前 Hub Dashboard 的大屏语法是页面构图和信息层级的直接基线**：深色运营大屏、
   Neon Void token、数据密集但有明确主次、状态和证据可见。
2. `mx-launcher/demos/ui-design-neon-void` 与 `mx-launcher/ui-design` 继续是颜色、字号、
   间距、边框、按钮、下拉、分页和交互状态的设计系统来源。
3. 用户提供的飞书多维表格截图只提供多维表格的交互参考：字段类型、tag、下拉、筛选、
   分组、排序、行高、保存视图、内联编辑和表格/看板切换。不得复制飞书的浅色品牌视觉。
4. 现有 Hub“外部数据源”页面是待重组的功能输入，不是新目录首页的视觉基线。

大屏不是静态海报。每个数字、图表和状态都必须可以点击下钻到同一套目录筛选条件，
并显示 `asOf`、数据口径、筛选范围和 evidence freshness。

### 2.2 当前五份文本数据的合并口径

`spec_docs/data_source` 中的数据应按一套业务目录导入：

| 文件 | 解释 | 导入结果 |
| --- | --- | --- |
| `02.base.txt` | 215 条平台底表；29 条已覆盖、186 条未覆盖 | `platform_entry` 基线记录 |
| `02.fugai.txt` | 已覆盖保存视图 | `coverage_status=covered` 的派生视图，不复制记录 |
| `02.weifugai.txt` | 未覆盖保存视图 | `coverage_status=not_covered` 的派生视图，不复制记录 |
| `01.support_platform.txt` | 29 条当前支持平台的窄投影 | 由 complete capability/entry 派生的汇报视图 |
| `03.txt` | 与 215 个序号一一对应的 15 字段详情 | 合并到同一 entry/capability 详情，不作为第二事实表 |

导入必须保留以下已知质量事实：

- `fugai + weifugai` 按序号精确覆盖底表，二者是保存筛选，不是独立生命周期；
- `03.txt` 的序号 62 写作“抖音小店”，其余文件写作“抖音电商”；首次导入以审核后的
  canonical 名为准，另一个保存为 alias，并创建待处理的数据质量告警；
- 按用户确认，底表末两列的业务语义是“负责人、备注/待补充”。当前负责人为空；
  `tikhub`、`justone`、`rapid`、`apify`、`真机`、`自建` 及说明文字属于接入方式或备注，
  不能导入为人员负责人；
- `03.txt` 的 15 列按稳定序号合并：序号、大类、细分场景、区域、平台、代表入口/模块、
  可监测内容、可提取线索、主体追踪字段、建议接入方式、合规边界、优先级、当前覆盖状态、
  负责人、备注/待补充；
- 原始文件、导入 hash、parser version、逐行 warning 和人工修正都作为 import evidence 保留。

首次导入只建立目录草稿和保存视图，不自动注册数据库连接、启用 source、调用 provider、
启动 Agent 或发布 dataset。

## 3. 信息架构

数据平面导航建议调整为：

| 页面 | 默认视图 | 主要职责 |
| --- | --- | --- |
| 数据源总览 | 大屏 | 覆盖率、阶段、优先级、类别、区域、负责人、运行健康、计划和证据时效 |
| 数据源目录 | 多维表格 | 平台/capability 的增删改查、筛选、分组、排序、tag、保存视图和批量操作 |
| 接入与清洗计划 | 计划卡片/运行视图 | 现有 external source、mapping/import、Telegram/舆情业务管线和后续通用 plan |
| 数据中心 | canonical 记录 | 查看 PG 权威记录、revision、extensions、lineage 和 ES 检索 |
| 检索管线 | 运行状态 | outbox、ES、HanLP、embedding、reindex 和降级 |
| 中心 Agent | provider/任务 | 有界 mapping、分类、enrichment、审核和运行证据 |

“数据源总览”和“数据源目录”可以作为同一路由的两个一级子页。进入模块时默认显示总览，
保留最近使用的目录视图，但不能让一个用户保存的私人筛选改变其他人的默认汇报口径。

## 4. 领域对象

### 4.1 平台目录项 `platform_entry`

平台目录项代表一个稳定的业务对象，例如抖音、Telegram、淘宝或 Shodan。建议字段：

```text
id, stable_key, display_name, aliases[]
summary, primary_taxonomy_id, priority
coverage_status, delivery_status, review_status, runtime_status
owner_member_id, steward_member_ids[]
compliance_summary, notes
record_version, created_by, created_at, updated_by, updated_at
```

`stable_key` 不使用可变显示名或飞书序号。原序号保存为 `source_import_key`，用于追溯和
后续重导入，不作为跨系统主键。

一个平台目录项不是“已全部支持”的最小单位。平台下面至少有一个 capability；平台级覆盖率
由 capability 汇总而来，不能用一个勾选框把抖音搜索、评论、直播、商品锚点全部宣称完成。

### 4.2 分类和 tag

`taxonomy_node` 表达大类、细分场景和未来更深层级：

```text
taxonomy_id, parent_id, kind, stable_key, display_name
description, sort_order, status, version
```

- 每个 entry 有一个主分类，用于稳定汇报；
- 可以关联多个附加分类/tag，例如“内容电商”和“舆情监测”；
- tag 输入支持下拉搜索和在按 Enter 新建，但新建权限、重名/NFKC 归一化、层级和颜色由
  服务端校验；
- 合并/重命名 taxonomy 必须保留 alias 和审计，不静默改写历史 report 的口径。

区域使用独立 `region` + relation，不把“全球/中国大陆”长期保存成不可查询的单字符串。
可同时保存业务覆盖区域、数据驻留区域和合规适用区域；三者不得混为一个 tag。

### 4.3 平台能力 `platform_capability`

能力是覆盖与验证的最小单位：

```text
id, platform_entry_id, capability_key, display_name
entry_module, monitorable_content[], extractable_clues[]
tracking_fields[], recommended_access_modes[]
compliance_boundary, priority
coverage_status, delivery_status, review_status, runtime_status
freshness_slo, owner_member_id
record_version
```

示例 capability 包括 `content.search`、`content.detail`、`comments.list`、`profile.get`、
`commerce.product`、`live.segment`、`telegram.messages`。面向调用者的 capability 仍需通过
Hub versioned module contract 授权；目录中的文字标签不能直接成为公共 API grant。

### 4.4 接入路径 `access_path`

一个 capability 可以有多条接入路径：

```text
id, capability_id, path_kind
night_all_module_ref | external_source_id | manual_evidence_ref
provider_label, environment, readiness_state
contract_version, last_verified_at, evidence_ids[]
```

`path_kind` 初始允许：

- `night_all_capability`：引用经评审的 Night-All module/capability，不复制 provider secret；
- `hub_external_source`：引用现有 `catalog.external_sources`；
- `file_import`：引用已批准 mapping 和 import evidence；
- `manual`：只有说明/evidence，没有可运行 connector；
- `planned`：目标接入方式，明确尚未实现。

TikHub、JustOne、Rapid、Apify、真机和自建可以作为 `provider_label` 或规划标签，但 provider
选择、fallback、endpoint 与凭据仍由 Night-All 或对应 connector owner 管理。目录普通页面
只显示 `credentialConfigured`、contract/readiness 和受控说明，不返回 secret、DSN 或任意 header。

### 4.5 负责人和协作

负责人必须关联 Hub member/Launcher federated principal，而不是自由文本。为兼容尚未建档的
团队或外部责任方，可以先保存 `unresolved_owner_label`，但它不能被统计为已分配负责人。

最小角色关系：

- owner：对业务完成标准和发布负责；
- steward：维护 taxonomy、字段、质量和合规；
- source operator：操作连接、同步、checkpoint 和 run；
- reviewer：批准 mapping、coverage override 和发布；
- watcher：接收状态变化和到期提醒。

## 5. 状态模型

### 5.1 覆盖结论与交付阶段

覆盖结论是能力口径：

```text
unknown | not_covered | partial | covered
```

交付阶段是工作流口径：

```text
exploring -> planned -> doing -> complete -> retired
                      \-> blocked
                      \-> paused
```

| 阶段 | 含义 | 最低证据 |
| --- | --- | --- |
| `exploring` | 正在核对合法性、供应方、成本或技术可行性 | 调研记录/负责人 |
| `planned` | 已批准范围和计划，尚未实施 | plan version、owner、目标日期 |
| `doing` | connector/mapping/清洗正在实现或回填 | active plan run/evidence |
| `complete` | 已满足当前定义的完成标准 | accepted evidence 或人工 override |
| `blocked` | 有明确阻塞条件 | blocker、owner、复核日期 |
| `paused` | 已有计划或实施，但当前暂停 | 暂停原因、复核日期 |
| `retired` | 不再提供或不再规划 | 原因、替代项、retention 处理 |

`已覆盖/未覆盖` 只映射到 coverage，不自动决定 delivery。以后不再把中文显示值作为数据库
枚举本身；国际化文案在 UI 层映射。需要验收的条目可保持 delivery `doing`，同时通过
`review_status=needs_review` 表达尚未核验，避免再增加一个含义重叠的 `verifying` 值。

### 5.2 运行、健康和发布状态

交付阶段不能代替以下独立轴：

- coverage：`unknown | not_covered | partial | covered`；表示能力覆盖结论；
- field review：`needs_review | verified | rejected`；表示模板字段是否核验；
- runtime health：`not_configured | unknown | healthy | degraded | failed`；表示目录关联链路当前健康；
- external source runtime：`active | paused`；仍沿用现有 physical source 语义；
- publication：`draft | review | published | suspended`；表示能否进入 Hub dataset/query contract。

例如 Telegram 清洗交付可以保持 `delivery_status=complete` 和 `coverage_status=covered`，
同时因上游临时不可用显示 `runtime_status=degraded`；这比把“完成”改回“进行中”更准确。反过来，连接测试为 green 也不能使
coverage 自动变为 covered，因为连接成功不证明 watermark、mapping、删除和数据质量合同成立。

### 5.3 平台汇总规则

平台级状态必须带汇总口径：

- `completeCapabilities / inScopeCapabilities` 形成覆盖率；
- P0 capability 可以配置为发布硬门槛；
- 只要一个已发布 capability degraded，平台健康可以 degraded，但覆盖阶段不倒退；
- 没有定义 in-scope capability 的平台不得显示 100%；
- “当前支持平台”默认要求至少一个 `published + complete` capability；
- 报告可以另选“全部 P0 完成”“任一能力完成”等口径，但必须显示 filter/metric version。

## 6. Evidence 与人工标注

### 6.1 Evidence 类型

`evidence` 是可复用、带权限的对象：

```text
id, evidence_type, subject_type, subject_id
reference, digest, summary, captured_at, expires_at
producer, environment, visibility, created_by
```

初始 evidence 类型包括：

- Night-All capability/contract 和 live verification；
- external source schema/index/watermark probe；
- approved mapping、format-rule version；
- import/cleaning/agent run；
- canonical/dataset count 与质量结果；
- published dataset version；
- 文档、验收报告和人工取证；
- 合规批准、许可和过期复核。

“有文档”只是 evidence 的一种，不自动等于数据 ready。“有 provider 标签”也不自动等于
contract 已验证。大屏需要区分 declared、contract-verified、live-verified、ingesting、
published 等证据级别。

### 6.2 人工 override

允许有权限的用户人工把 Telegram 等项标为 `complete`，但必须保存：

```text
target stage, prior derived stage
reason, evidence IDs
actor, approved_by, created_at
effective_from, expires_at/null
```

- override 不删除派生状态；UI 同时显示“人工完成”和实际 runtime/readiness；
- 过期后进入 `review_required`，不静默回退或自动续期；
- 系统重新满足完成标准时可以关闭 override，但保留历史；
- 批量 override、降低合规等级和直接发布都需要二次确认与审计。

## 7. 数据计划

### 7.1 统一父对象

`data_plan` 表示一个有版本、有负责人、有输入输出和验收标准的工作计划：

```text
id, plan_key, plan_type, display_name, objective
status, owner, priority, target_date
scope_snapshot, current_version
created_by, created_at, updated_at
```

计划状态：

```text
draft -> review -> approved -> scheduled -> running -> verifying -> completed
                   \-> paused / blocked / canceled / failed
```

修改已批准计划创建新 version；历史 run 永远引用当时的 version。计划完成不物理删除 source
或 canonical 数据。

### 7.2 获取计划 `acquisition`

获取计划回答“怎样获得外部数据”：

- 平台、capability、区域、时间范围和预计体量；
- 接入路径、凭据引用、成本和调用预算；
- API/数据库/文件/对象桶的读取合同；
- pagination/checkpoint/CDC/删除语义；
- 调度、并发、超时、重试和停止条件；
- 合规依据、许可、retention 和数据驻留要求；
- 目标 raw/canonical dataset 和验收样本。

连接地址和 credential 属于受控 source/access path，不复制进 plan 自由文本。计划只保存稳定
引用和版本快照。

### 7.3 清洗计划 `cleaning`

清洗计划回答“怎样把已有输入变成可治理数据”：

- 一个或多个 source/dataset version 输入；
- schema/format-rule/mapping version；
- identity、去重、title/body/author/time/region 等规范字段；
- transform、校验、quarantine、tombstone 和迟到数据规则；
- PII/敏感字段处理、field policy 和合规检查；
- 可选规则/Agent enrichment 及人工审批；
- canonical、serving、aggregate 和 ES projection 输出；
- row/read/rejected/changed/deleted、质量、耗时和成本验收。

现有 Telegram monitor、Telegram SQLite API 和全国省份舆情是固定 business pipeline；它们可以
作为第一批 cleaning plan 模板呈现，但不能伪造尚未存在的通用 DAG。

### 7.4 归档计划 `archive`

归档计划针对已有数据和历史材料：

- backfill 范围和不可变 input manifest；
- raw/object storage 位置与 hash；
- retention、legal hold、删除和恢复策略；
- Parquet/export/dataset snapshot；
- PG/ES/object 间重建和对账；
- 完成后的 dataset version、as-of 和覆盖范围。

归档不是“把源文件移动走”。服务器路径 source 仍遵守既有规则：运行时 allowlist 将绝对路径
归一为 `rootId + relativePath`，重复使用 immutable format rule；Hub 不移动或删除源文件。

### 7.5 发布计划 `publication`

发布计划把已完成清洗的 canonical revision 变成受控 dataset version：

- schema、quality、lineage 和字段策略门禁；
- consumer/platform/capability grant 关系；
- freshness SLO、as-of、partial 和 stale 语义；
- materialized aggregate/search profile；
- 回滚到上一 dataset version 的条件。

BI、大屏、Text2SQL 和 Agent 只读取已发布 dataset version，不直接读取 running/quarantine 输入。

### 7.6 Plan run 与 durable lineage

每次 run 至少记录：

```text
plan_version, input snapshot/source run IDs
mapping/transform/rule/prompt/model versions
row/read/ingested/rejected/changed/deleted counts
checkpoint start/end, PG commit evidence
outbox/ES/aggregate projection state
quality/compliance decisions
status, partial/errors, started/finished/duration
```

input run 继续引用现有 import run。不能把两个已完成的 import run 事后拼成一个“原子父任务”，
也不能用 UI 汇总数字替代 durable lineage。

## 8. Agent 的边界

Agent 是受治理的 plan step，而不是连接器、事实库、计划 owner 或自动批准者。

允许的首批用途：

- 只基于列名建议 mapping；
- 对隔离样本提出 taxonomy/分类/enrichment assertion；
- 解释 schema drift、质量异常和待补字段；
- 为人工审核生成摘要和候选修复方案。

禁止：

- 持有或输出数据库密码、provider key、cookie、任意 header；
- 使用任意 Night-All route、任意 SQL、ES DSL、shell 或 URL fetch；
- 改写 external identity、watermark、checkpoint、tombstone 或 approved mapping；
- 把模型输出直接发布到 public dataset；
- 修改 grant、credit、price book、自己的 budget 或完成状态；
- 因 Agent/provider 不可用而阻塞 raw/canonical 基线 ingest。

Agent proposal 保存模型、prompt、input scope、cost、confidence 和 evidence，并保持
`proposed`，只有 reviewer 接受后才进入下一版本。敏感数据只允许进入批准的模型 deployment。

## 9. PostgreSQL 权威性与 ES 投影

### 9.1 PG 保存的真相

以下对象只以 Hub PostgreSQL 为权威：

- taxonomy、platform entry、capability、region/tag 和 alias；
- owner、role、permission、saved view、comment 和 audit；
- coverage stage、manual override、evidence 和 completion definition；
- access-path 引用、source/mapping、plan/version/run 和 lineage；
- dataset/schema/publication、quality 和 dashboard aggregate definition。

目录规模很小，第一阶段使用 PG typed columns、relation、必要的 JSONB extension、trigram
和普通索引即可。不要为多维表格搜索先引入 ES，也不要为每个 category/tenant 建表或索引。

### 9.2 ES 只做读投影

只有全文、复杂 facet、geo relevance 或与大语料 canonical 内容联合检索有实测需求时，目录
才通过 outbox 投影到 ES：

1. PG 事务提交目录变更、revision 和 outbox；
2. projector claim 后重读 PG 当前 truth；
3. 使用 record ID 作为 ES `_id`，使用单调 revision 做 external version；
4. 删除/tombstone 发 delete；失败保留 pending/DLQ；
5. ES 清空后从 PG 重建。

禁止在一个 HTTP 请求中分别写 PG 和 ES。大屏 authoritative count 和导出从 PG/物化 aggregate
读取；ES 的近实时 lag 不能改变“已覆盖 29”这类治理数字。ES down 时目录 CRUD、保存视图、
精确筛选和报告继续可用，全文能力显示 degraded。

## 10. 多维表格交互

### 10.1 第一屏和工作区

进入模块先显示大屏：

- 总平台、已完成、未覆盖、doing/exploring、P0 完成率、无负责人、证据过期；
- 按大类/细分场景、区域、优先级、coverage stage 的分布；
- capability 覆盖矩阵与最近变化；
- 接入/清洗/归档计划状态和最近 run；
- source health、freshness lag、质量告警和待审核 override；
- “已接入”和“已发布”分别统计，不能把连接成功当成可消费数据。

点击 KPI 或图形进入目录并携带可见 filter chips。返回大屏时保留全局时间/范围，私人视图不改变
公共 KPI 口径。

### 10.2 表格能力

目标交互至少覆盖：

- typed fields：文本、长文本、数字、日期、单选、多选、人员、关系、URL、状态、优先级；
- tag 下拉搜索、Enter 新建、颜色和合并；
- inline edit、详情 drawer、键盘导航、复制粘贴和批量编辑；
- 新建、复制、归档、恢复；物理删除需要单独 retention policy；
- filter、group、multi-sort、列显隐/冻结/宽度、行高和分页；
- grid、kanban、gallery/card、dashboard 和只读 report view；
- saved view 的 owner、共享范围、默认排序、锁定和 revision；
- relation/lookup/rollup 和受控 formula；公式只引用 allowlisted typed fields；
- comments、mentions、change history、乐观并发冲突和受控 undo；
- CSV/TSV/XLSX 导入预览、字段映射、dry-run、warning、导出水印；
- automation/reminder 以事件和受控 action registry 实现，不执行任意 webhook/shell。

“超过多维表格”的领域能力体现在：capability 级覆盖、运行健康与项目阶段分离、evidence、
contract/watermark/mapping/run lineage、合规和发布门禁，而不是仅增加更多表格按钮。

### 10.3 保存视图

首批系统视图：

- 底表；
- 当前支持平台；
- 已覆盖；
- 未覆盖；
- exploring / doing / verifying；
- P0 待完成；
- 无负责人；
- 证据过期；
- source degraded/down；
- 待审核 mapping/override/publication；
- 按大类、区域、接入路径和负责人分组。

系统视图只能由 platform admin 修改；普通用户可以复制为私人/团队视图。视图保存 query AST、
field/order/group config 和 metric version，不复制一份结果 JSON。

### 10.4 新建/编辑向导

类比“商品上架”，目录项的发布向导分为：

1. 基本信息：名称、alias、简介、优先级；
2. 分类规格：大类、细分场景、区域和 tag；
3. 能力明细：入口模块、监测内容、线索、追踪字段；
4. 接入路线：Night-All module/external source/文件/规划路径；
5. 数据计划：获取、清洗、归档和发布；
6. 负责人和合规：owner、steward、许可、边界和 retention；
7. 证据与验收：contract、run、quality、文档、manual override；
8. 审核发布：生成 immutable directory revision，不自动启动 source 或 provider 调用。

草稿可随时保存。发布前服务端返回按字段分类的 blockers/warnings，不能只在前端隐藏按钮。

## 11. 权限、审计和导出

### 11.1 权限

建议能力：

| 能力 | 典型角色 | 范围 |
| --- | --- | --- |
| `source_catalog.read` | viewer/report user | 授权目录、视图和汇总 |
| `source_catalog.write` | steward/editor | 业务元数据，不含连接 secret |
| `source_catalog.review` | reviewer | mapping/override/publication 审核 |
| `data_plan.operate` | source operator | 运行、暂停、重试允许的 plan |
| `source_connection.admin` | Admin Token | 查看/修改/测试连接和 secret |
| `source_catalog.platform_admin` | platform admin | taxonomy、系统视图、全局导入和归档 |

现有 source connection 管理继续是 Admin Token only。Launcher platform-admin 不能因为能编辑目录
就获得数据库密码。公共 API key 永远不能访问目录管理面。

目录读写复用 Launcher opaque-token introspection + Hub-local role，不共享 Launcher 用户表，
也不把 Launcher organization 自动当作 Hub tenant。后续若开放 tenant-specific 目录，需要显式
row scope，不从 membership 猜测。

### 11.2 审计和并发

所有 mutation 保存 actor、principal kind、tenant/scope、request ID、before/after digest、字段 diff、
reason 和时间。敏感值永不进入 diff、日志或 support bundle。

更新使用 `record_version`/ETag + `If-Match`；冲突返回 409 和最新安全快照。批量变更先 dry-run，
显示影响记录和 blocker，再用确认 token 提交。taxonomy 合并、批量 complete、降级合规、发布、
archive 和删除属于高风险操作。

### 11.3 导入与导出

- 导入先解析、归一 header、按 stable/source key 对齐、显示 create/update/conflict/warning；
- 同一 input hash + mapping version 幂等，不能重复创建记录；
- 未知字段先进入受控 extension/custom field proposal，不静默丢弃；
- export 绑定 saved view revision、filter、field policy、as-of、actor 和 export ID；
- 导出默认不含 source connection、credential、private evidence 和 raw rejected rows；
- 敏感或大批量导出走 approval、异步 job、过期下载和水印。

## 12. 建议的内部 API 边界

以下是目标 contract，不表示当前已经上线：

```text
GET  /internal/v1/admin/source-catalog/summary
GET  /internal/v1/admin/source-catalog/entries
POST /internal/v1/admin/source-catalog/entries
GET  /internal/v1/admin/source-catalog/entries/{id}
PATCH /internal/v1/admin/source-catalog/entries/{id}       If-Match

GET|POST|PATCH /internal/v1/admin/source-catalog/views/**
GET|POST|PATCH /internal/v1/admin/source-catalog/taxonomy/**
POST /internal/v1/admin/source-catalog/imports/preview
POST /internal/v1/admin/source-catalog/imports/{id}/commit
POST /internal/v1/admin/source-catalog/entries/{id}/overrides

GET|POST|PATCH /internal/v1/admin/data-plans/**
POST /internal/v1/admin/data-plans/{id}/runs
POST /internal/v1/admin/data-plans/{id}/pause
POST /internal/v1/admin/data-plans/{id}/resume
```

列表使用 allowlisted filter/sort AST、bounded page size 和稳定 cursor/分页。客户端不能提交 SQL、
table、ES index/DSL、arbitrary formula code、provider URL 或 credential。`summary` 使用与目录列表
相同的服务端 query definition，避免大屏和表格各算一套覆盖率。

## 13. 分阶段实施

### Phase 0：契约和基线导入

- 接受 ADR-0011，冻结术语、状态、权限和完成口径；
- 实现只读 parser/dry-run，合并 215 条记录并暴露序号 62 alias 冲突；
- 固化系统 saved views 和当前统计基线；
- 不改 external source、Launcher、DNS、登录或联网链路。

### Phase 1：目录 MVP

- PG 表、revision/audit/outbox；
- 大屏 summary、grid CRUD、详情 drawer、filter/group/sort/tag、系统/私人 saved views；
- capability-level coverage、owner、evidence 和 manual override；
- 导入 preview/commit、CSV/XLSX 安全导出；
- 现有“外部数据源”导航改称“接入与清洗计划”，行为保持兼容。

### Phase 2：数据计划和运行关联

- acquisition/cleaning/archive/publication plan version；
- plan input/output、run、quality 和 lineage；
- 关联现有 Telegram、SQLite、省份舆情和 generic source/import run；
- 审批、提醒、blocked/expiry、报告订阅。

### Phase 3：高级多维协作

- custom field、relation/lookup/rollup、受控 formula；
- kanban/gallery、评论/mention、批量 dry-run/undo；
- 受控 automation/action registry；
- field/row policy、团队共享和更完整 export approval。

### Phase 4：Agent 与语义 BI

- taxonomy/mapping/drift suggestion；
- evidence-backed assertion review；
- 已发布 dataset 的 Query Service、指标版本和 dashboard/report；
- Agent run budget、approval、eval 和 replay。

每一 phase 都必须独立可回滚；不能为了目录页面先引入 ClickHouse、任意数据库连接器、通用 DAG、
通用 Agent HTTP/SQL tool 或第二套生产 Night-All。

## 14. MX-H2I 零回归发布门禁

数据源目录是 Hub 内部数据产品功能，不得改变 MX-H2I 登录和用户联网。

### 14.1 禁止变更面

- 不修改 `demos/mx-h2i` connect/disconnect/recovery；
- 不修改 WireGuard、lease、route plan、PAC、2053、DNS、NRPT、resolver 或 ownership registry；
- 不为 Hub 创建 ProductNetwork、endpoint lease、WG peer 或 `launcher-network` capability；
- 不修改 HDO V1 `100.*`、Domestic 用户/DNS 或 `electron-server` 登录链路；
- 不把 Hub/PG/ES/Agent/source readiness 加入 Launcher readiness/connect gate；
- 不让 Hub source/Agent credential 进入 Launcher Secret、客户端或登录 session；
- 不新增/占用 MX-H2I 保留端口，不改变现有 host/path route。

### 14.2 部署和资源门禁

- 普通 Hub 发布保持 `MX_INSIGHT_SYNC_LAUNCHER=0`，只更新 Hub namespace；
- 目录 migration 只操作 Hub database/role，不触发 Launcher migration、Secret sync 或 rollout；
- summary/目录轮询使用一个有界聚合请求，不能让每个组件重复登录或无限 introspection；
- source import、backfill、reindex、aggregate 和 ES projection 有并发、速率、连接池和资源上限；
- 共享 PG/节点压力一旦使 Launcher OAuth/飞书/lease/ready P95 越界，立即停止 Hub rollout；
- Hub/ES/Night-All/Agent down 只降级 Hub 页面，已有 MX-H2I session 和 tunnel 不变。

### 14.3 必测矩阵

发布前后都保存机器可读证据：

- Hub namespace absent/down；目录 API/PG/ES/Agent 分别 down；
- guest connect、密码 staff login、飞书 login、guest → staff、reconnect、disconnect、正常退出；
- 目录导入、批量编辑、大屏并发读取、计划 run、backfill/reindex 压力；
- Launcher Deployment generation/ReplicaSet/Pod UID 在普通 Hub deploy 前后不变；
- WG profile、route、PAC、NRPT、resolver、2053 listener、network ownership diff 为零；
- Launcher OAuth/Feishu/lease 无新增 5xx/429/timeout，现有连接不被 teardown；
- Hub Admin sign-in/目录访问不能耗尽 MX-H2I 密码登录的 source/subject rate-limit bucket；
- public data route 无法访问目录 Admin API、source credential、Kibana、ES 或 Night-All raw route。

任何一项失败都回滚 Hub 自身变更并停止发布，不通过修改 MX-H2I 网络配置来适配目录功能。

## 15. 验收标准

- 215 条基线记录只存在一份权威目录，已覆盖/未覆盖/当前支持均由 saved view 派生；
- 序号 62 alias 冲突、负责人/备注列纠正和 import warning 可追溯；
- 平台覆盖可以下钻到 capability、access path、plan、run、dataset 和 evidence；
- complete、runtime health 和 publication 三条状态轴不会互相覆盖；
- 人工 complete 有理由、证据、操作者和可选过期时间；
- 大屏与目录使用同一个版本化统计 contract，并显示 as-of/口径；
- source secret 不出现在目录字段、导出、普通 Launcher 会话或日志；
- PG/ES 不双写，清空 ES 后目录和搜索投影可从 PG/outbox 重建；
- 获取、清洗、归档和发布计划有独立版本、输入输出、run 与 lineage；
- Agent 只能提案，不能改变 identity/watermark/checkpoint/tombstone/grant；
- Hub 缺失、故障和高负载时，MX-H2I 登录与已有用户联网仍通过完整回归矩阵。
