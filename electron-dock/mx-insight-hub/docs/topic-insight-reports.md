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



## 动态类别发现（2026-09-17）

调用前通过 `GET /api/v1/data/platforms` 获取全部已知类别及当前 Key 的
`authorized` 标记。`platforms` 使用目录返回的 `platform`，不要写死 13 类、显示名称或源表名。
`sourceScope=selected` 要求至少一类且每类均已登记并有效授权；`all_granted` 固化创建时的
授权集合，后续新增类别不会改变已创建任务。目录接口无 usage 计费，无需 Idempotency-Key。

清洗计划来源为 Night-All-A，历史内部标识为兼容保留；公开目录与专题报告继续使用 Hub 中性合同。
详见 [Night-All-A 清洗与发现](operations/night-all-saved-records-ingestion.md)。

## 主题、关键词与分页（2026-09-17）

`platforms` 表示数据来源类别，不是研究主题。POST 必填 `topic`，可选 `keywords`
（最多 12 个，每个 1–80 字）和 `matchMode=any|all`。关键词填写后以标题/正文的
不区分大小写字面子串匹配替代主题自动拆词；未填时保持原来的主题匹配逻辑。
新增 migration 093 保存关键词，旧报告兼容空关键词。

GET `/api/v1/data/topic-reports?keyword=选举&status=succeeded&page=1&limit=10`
搜索当前 consumer 的已有报告，支持 topic、keyword、status、platform 组合筛选，返回
items/page/limit/hasMore。topic 匹配报告主题，keyword 匹配主题或保存的关键词；
这些条件不搜索报告全文，也不会创建新报告。查询与翻页不计费、不触发上游采集。
实时倒序分页期间新增任务可能移动页边界，调用方按 id 去重。单报告证据最多 80 条，
分页报告列表不代表分页遍历原始数据全集。原始数据查询使用 canonical search 合同。

Hub 页面支持动态类别多选、自定义时间、关键词匹配模式与报告搜索分页。
所有改动限定 Hub 专题链路；MX-H2I 登录、网络及 Launcher 身份路径不变。

## 动态类别数据库约束修复（2026-10-17）

Delta 今日政治简报报告 `news_topic_search / hub_topic_report` 返回500，关联 HTTP 请求
`54920019-fc63-4536-a77a-c8772677cd46`，耗时516ms。新查询先读 `/data/platforms`，
再用全部已授权类别创建报告；已有报告恢复则直接读取报告。`hub_topic_report` 是调用方的
通用阶段名称，单凭截图不能区分目录读取、创建或已有报告读取失败。

本地已确认并复现一个数据库缺陷：动态类别的请求校验允许14类以上，但 migration067的
`topic_reports_authorized_platforms_check` 仍要求 `cardinality(authorized_platforms) BETWEEN 1 AND 13`。
真实报告 INSERT 因而抛出 PostgreSQL `23514`，HTTP层返回截图同形的 `500 internal_error`。
原测试仅检查动态类别参数，HTTP测试使用内存报告替身，没有实际执行此约束。

新增 migration `156_topic_report_dynamic_platforms.sql`，只将该约束改为至少一类；
不另设14类上限，不截断已授权平台，不修改历史报告、权限、计费、身份或联网。
18项相关回归通过、0跳过，包含真实PGlite约束与HTTP创建链路：迁移前14类500，迁移后202，
完整授权集合保留，同幂等键重试保留原失败记录，成功重放不重复创建，未授权和跨consumer访问仍拒绝。
Delta另有15项离线适配测试通过。本地验证不代表该生产请求已经归因或恢复。

最初尝试按原请求读取日志，Public容器名为 `api`：

```bash
kubectl -n mx-insight-hub logs deployment/mx-insight-hub-public -c api --since=24h --timestamps=true --tail=-1 \
  | grep -F -B 2 -A 30 '54920019-fc63-4536-a77a-c8772677cd46'
```

该未处理异常响应中的 `requestId` 是HTTP关联ID，未必等于 `usage_requests.id`。
日志应检查真实 error/code/constraint，不能用查不到同UUID的usage记录推断没有创建尝试。

操作者反馈上述当前Public日志查询无输出。随后返回的只读数据库回执时间为
`2026-10-16T20:14:32.391Z`（北京时间2026-10-17 04:14:32）：报告表和迁移表都存在，
该约束 `convalidated=true`，定义仍为 `cardinality >= 1 AND cardinality <= 13`，
`156_topic_report_dynamic_platforms.sql` 的迁移记录为空。已确认线上仍有这个数据库阻断，
且本次迁移尚未应用；回执没有原请求的分类集合或堆栈，仍不能将它单独视为该历史500的精确归因。
无需继续重复同一当前日志查询；按以下流程发布已验证的修复。

同步包含新增156文件的完整代码，并在Hub目录运行既有发布流程以执行新迁移；
仅重启旧镜像不会改数据库约束：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh ops internal-production deploy
```

发布后查看迁移Job日志，应出现 `applied 156_topic_report_dynamic_platforms.sql`：

```bash
kubectl -n mx-insight-hub logs job/mx-insight-hub-migrate -c migrate
```

随后复用只读数据库检查，
预期该约束只保留 `cardinality(authorized_platforms) >= 1`，且156记录包含 `applied_at`。
通过后再由操作者显式恢复原业务请求；HTTP202表示创建受理，报告最终成功仍需后续业务回执。

操作者后续回执时间为 `2026-10-16T20:22:32.764Z`（北京时间2026-10-17 04:22:32）：
156的 `applied_at` 为 `2026-10-16T20:21:08.821Z`，该约束定义已变为
`CHECK ((cardinality(authorized_platforms) >= 1))`，且 `convalidated=true`。
已确认生产数据库迁移生效、13类上限解除；尚未收到原简报任务恢复或报告最终成功的业务回执，
因此不能据此将原请求标记为已恢复。

生产迁移由操作者执行，代理未执行线上任务重试。既有失败响应重放与unknown保护继续生效；
保留原请求体和幂等键，不通过改历史状态、清账或新建幂等键绕过原请求证据。
