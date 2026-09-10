# 专题洞察数据产品

## 定位

专题洞察把已经同步到数据中心的 `data_center_saved_records_*` canonical records
组织成一个可追溯的异步报告。第一版优先回答“某个主题在给定时间窗内有哪些变化、集中在哪些
类别/地域/作者、哪些标签共同出现、证据来自哪里”，而不是生成不可核验的长篇结论。

Internal 管理面提供“创建专题报告 / 任务进度”工作台；外部客户通过
`/docs/topic-reports` 和 OpenAPI 使用同一份结果合同，自行实现 Web、移动端、BI 或报告导出产品。

## 数据链路

```text
saved_records_* 分区
        │ 现有清洗计划
        ▼
core.canonical_records (PostgreSQL truth)
        │ publication-eligible + 授权平台 + 时间窗 + 主题词
        ▼
insights.topic_reports durable queue
        │ classifier workload 内的独立 topic-report loop
        ▼
摘要 / 趋势 / 维度排行 / 共现关系 / 公开安全证据
```

报告链路不读取 Elasticsearch projection，不调用 HanLP，也不调用外部采集或 LLM Provider。
因此：

- 新增同步记录后可以直接创建新报告，无需等待搜索索引重建；
- deploy 只自动执行普通数据库 migration，不会自动严格重建 Elasticsearch；
- 人工点击的严格重建仍只负责搜索 projection，不是专题报告门禁；
- 大数据量下的压力主要由 PostgreSQL 有界证据选择和 `sampleLimit` 控制。

## 持久化与状态机

Migration `067_topic_insight_reports.sql` 创建 `insights.topic_reports`。任务状态为：

```text
queued → running/selecting_evidence → running/building_associations → succeeded/complete
   ▲                    │                          │
   └──── lease retry ───┴──────────────────────────┘
                                                └→ failed（最多 3 次）
```

worker 通过 `FOR UPDATE SKIP LOCKED` 单条领取，使用 lease/heartbeat 避免多副本重复执行；进程退出时
释放当前任务，过期 lease 会被回收。公开任务在创建时固化 tenant、consumer、API Key 与完整平台授权
快照，结果不会因为之后的授权变化或新同步数据而被静默改写。

## 结果边界

`mx-insight-hub.data-products.topic-report.v1` 返回：

- `executiveSummary`：确定性摘要和三条主要发现；
- `timeline`：按 canonical 事件时间聚合；
- `dimensions`：类别、标签、地域、作者排行；
- `associations`：主题与维度、类别与标签的证据共现边；
- `evidence`：最多 80 条 allowlist 投影，保留 canonical ID 与可核验 URL；
- `methodology`：数据基准、匹配方法和必须展示的限制。

关系边只表示同一批证据中的共现，不表示因果、人物关系或事实认定。结果不包含 raw payload、
connector credential、内部源身份、数据库坐标或 lineage。

## 扩展方向

后续可以在保持 v1 合同兼容的前提下增加：事件簇、跨时间窗对比、实体消歧、引用式 LLM 叙事、
人工编辑与审批、PDF/Slides 导出、订阅式定期报告。成本较高的模型分析应作为新的显式能力和
独立 quota，不能悄悄加入当前 1 unit 的确定性报告。

