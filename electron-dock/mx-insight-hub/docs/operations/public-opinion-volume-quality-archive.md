# 全国舆情数量、质量与归档排查手册

状态：仓库运维契约；截至 2026-08-26。运行环境是否已经部署同版本，必须由本文的
只读接口重新确认，不能由仓库文件或截图推断。

本文聚焦 `public-opinion.province.v1` 的数量、候选质量、地理覆盖、版本归档和安全回放。
固定源的激活与 writer 合同见
[全国省份舆情固定源运维手册](province-public-opinion-ingestion.md)，公共响应的完整字段见
[Public API v1](../contracts/public-api-v1.md)，备份恢复见
[Backup and restore](backup-restore.md)。

本文所有诊断命令均为 `GET`。示例只使用占位地址和通过受控方式注入的 token，不要把
真实 API Key、Admin Token、Night-All service token、数据库 URL 或 provider 配置提交到
仓库、工单和 shell history。本文不要求也不允许操作 MX-H2I、Domestic/Internal、用户、
登录、DNS、WireGuard、Launcher Secret、网络路由或 Launcher workload。

```bash
HUB_URL='https://<hub-public-host>'
HUB_ADMIN_BASE='https://<hub-admin-host>'
NIGHTALL_BASE='https://<night-all-host>'

# 通过本机 secret manager 或受控会话注入；这里不要填写真实值。
HUB_API_KEY='<injected-public-api-key>'
HUB_ADMIN_TOKEN='<injected-admin-token>'
```

## 1. “最新入库 18 条”的正确含义

数据中心“任务与清洗记录”中的一行是一次固定源 import run，不是省份统计。截图中的
`读取=18、入库=18、变更=18、删除=0、拒绝=0` 应解释为：

| 字段 | 当前实现语义 | 不能解释成 |
| --- | --- | --- |
| 读取 `rowCount` | 本次从 Night-All 水位之后读到并提交的源行数 | 当前总量、18 个省或 18 条高质量舆情 |
| 入库 `ingestedCount` | 本批经过 mapping 后执行幂等 canonical upsert 的记录数；当前计数是 `records.length` | 只计算 SQL `INSERT` 的净新增数 |
| 变更 `changedCount` | 本批新写入的 canonical revision 数；首次出现的 revision 1 也计入 | 只计算既有行的 `UPDATE` 数 |
| 删除 `deletedCount` | 本批带可观察删除语义的记录数 | Night-All 已经 hard delete、因而 Hub 根本看不到的行 |
| 拒绝 `rejectedCount` | mapping/合同校验明确拒绝的源行数 | Night-All collector、规则或 LLM 在入 Hub 前过滤掉的数量 |

因此 `18` 是增量处理量，不代表 18 条都具有省份，也不代表当前表只有 18 条。截图同时
显示首次 5,158、随后 20 和 18，而 canonical current 总数为 5,189；这至少说明 run 计数
不能与 current distinct 做简单加法。只有在“首次运行前为空、首次 5,158 行形成 5,158 个
distinct、期间无其他运行/删除”都成立时，才可进一步推断后两批 38 行中有 7 行合并到了
既有 canonical identity。这是截图对账提示，最终仍应以 Admin 汇总和 import run 为准。

只读查看最近运行：

```bash
curl -fsS \
  -H "x-mx-insight-admin-token: $HUB_ADMIN_TOKEN" \
  "$HUB_ADMIN_BASE/internal/v1/admin/sources/province-opinion-results/imports" \
| jq -e '.data[:10] | map({
    id, status, startedAt, finishedAt,
    read: .rowCount,
    upserted: .ingestedCount,
    canonicalRevisions: .changedCount,
    deleted: .deletedCount,
    rejected: .rejectedCount,
    cursorStart, cursorEnd,
    error: .lastError
  })'
```

不要把各 run 的 `ingestedCount` 相加当成当前 distinct 总量；同一 identity 的后续 revision
会再次出现在 run 计数中。

## 2. 全国 coverage → 省份下钻

全国页应先请求一次 coverage，而不是先发 34 个列表请求。coverage 在一个明确时间窗内
稳定返回全部 34 个省级行政区、全国汇总、每省 shortfall 和最多 8 个推荐展示省份；
省份卡片再用 ISO 代码下钻。目标数只是可观测目标，不能通过复制、猜省份或降低证据要求
来补齐。

以下窗口由调用方明确选择，`from`/`to` 均为 RFC3339：

```bash
FROM='2026-08-24T00:00:00Z'
TO='2026-08-25T23:59:59Z'
```

### 2.1 全国 formal-only 基线

省略 `includeCandidates` 是历史兼容的 formal-only，也是面向普通调用者的安全默认值：

```bash
curl -fsS --get \
  -H "Authorization: Bearer $HUB_API_KEY" \
  --data-urlencode "from=$FROM" \
  --data-urlencode "to=$TO" \
  --data-urlencode 'targetPerProvince=10' \
  "$HUB_URL/api/v1/data/public-opinion/province-coverage" \
| jq -e '.data | {
    contractVersion, from, to, includeCandidates, targetPerProvince,
    featuredProvinceCodes, totals,
    provinces: [.provinces[] | {
      code: .province.code,
      name: .province.name,
      formalCount,
      verifiedCount,
      availableCount,
      shortfall,
      meetsTarget
    }]
  }'
```

快速查看空省份和缺口最大的省份：

```bash
curl -fsS --get \
  -H "Authorization: Bearer $HUB_API_KEY" \
  --data-urlencode "from=$FROM" \
  --data-urlencode "to=$TO" \
  --data-urlencode 'targetPerProvince=10' \
  "$HUB_URL/api/v1/data/public-opinion/province-coverage" \
| jq -e '.data.provinces
| sort_by([.availableCount, .province.code])
  | map(select(.meetsTarget == false) | {
      province: .province,
      availableCount,
      verifiedCount,
      shortfall
    })'
```

### 2.2 全国 qualified 候选对照

要判断“formal 少但合格候选是否已经存在”，使用同一窗口、同一目标，只显式增加候选
模式。不要把两次不同窗口的结果直接相减。

```bash
curl -fsS --get \
  -H "Authorization: Bearer $HUB_API_KEY" \
  --data-urlencode "from=$FROM" \
  --data-urlencode "to=$TO" \
  --data-urlencode 'includeCandidates=qualified' \
  --data-urlencode 'minQualityScore=80' \
  --data-urlencode 'targetPerProvince=10' \
  "$HUB_URL/api/v1/data/public-opinion/province-coverage" \
| jq -e '.data | {
    totals,
    provinces: [.provinces[] | select(.availableCount > 0) | {
      province: .province,
      formalCount,
      qualifiedCandidateCount,
      candidateCount,
      qualifiedCandidateRate,
      verifiedCount,
      verifiedRate,
      availableCount,
      shortfall,
      averageQualityScore
    }]
  }'
```

`candidateCount` 是该窗口/省份中所有候选的诊断计数，`availableCount` 只按本次模式计算：
formal-only 只计 formal，`qualified` 计 formal + 达标候选，`all` 才计 formal + 所有候选。

### 2.3 江苏下钻

路径接受 `CN-JS`、`江苏` 或 `江苏省`；运维和程序调用推荐稳定的 `CN-JS`，避免路径编码
和名称别名问题。

```bash
curl -fsS --get \
  -H "Authorization: Bearer $HUB_API_KEY" \
  --data-urlencode 'sort=latest' \
  --data-urlencode "from=$FROM" \
  --data-urlencode "to=$TO" \
  --data-urlencode 'includeCandidates=qualified' \
  --data-urlencode 'minQualityScore=80' \
  --data-urlencode 'pageSize=50' \
  "$HUB_URL/api/v1/data/public-opinion/provinces/CN-JS/items" \
| jq -e '.data | {
    province, sort, pageInfo,
    items: [.items[] | {
      id, title, summary, url, publishedAt, collectedAt,
      province, heatScore, origin, quality, location
    }]
  }'
```

继续翻页时必须原样传回 `pageInfo.nextCursor`，且不能改变省份、排序、时间窗、page size、
候选模式或质量阈值。`hot` 会排除没有 heat score 的记录；排查“是否有数据”优先使用
`latest`。formal 的有界查询只按真实 `publishedAt`；显式候选缺失发布时间时才可按
Hub `collectedAt` 落入窗口，响应不会把该值伪装成 `publishedAt`。

## 3. `includeCandidates` 的语义和边界

`includeCandidates` 是 Hub 读取当前 publication state 的可见性开关，不是 Night-All
采集参数，不会触发 collector、LLM、Agent、回填或重新评分。

| 值 | 可见记录 | 额外限制 |
| --- | --- | --- |
| 省略或 `false` | `sourceStage=formal` 且 `status=formal` | 历史兼容默认 |
| `true` | `qualified` 的兼容别名 | 不建议新客户端继续使用布尔别名 |
| `qualified` | formal + `status=qualified` 且达到 `minQualityScore` 的 candidate | `minQualityScore` 默认 80 |
| `all` | formal + pending/qualified/rejected/failed candidate | 省份 feed/coverage 必须给 `from`、`to`；stored/canonical search 还必须给精确地理条件 |

只有显式候选读取才返回有界的
`quality={stage,status,score,threshold,geographyVerified}` 和可选
`location={label,type,country,countryCode,geoScope}`。内部 raw、LLM reasoning、provider、
evidence、flags 和凭据不会因此公开。

这有两个常见误区：

1. Night-All 的 candidate writer 默认受
   `NIGHTALL_PUBLIC_OPINION_CANDIDATE_WRITER_ENABLED=false` 闸门控制。源端没有持久化
   candidate 时，Hub 的 `includeCandidates` 无法“找回”它们。
2. Night-All candidate 是确定性清洗后、语义审核前的 envelope；源端当前不会为每个
   candidate 保存 LLM reject reason。Hub 的 `pending/qualified/rejected/failed` 是 Hub
   自己基于 revision-fenced 分析形成的 publication state，不应与 Night-All 的
   `source_disposition=normalized` 混为一谈。

硬拒绝的广告/成人/博彩/聚合页/无 URL 等记录不会进入 candidate envelope，
`includeCandidates=all` 也不能返回它们。

## 4. Admin 质量汇总

仓库采用以下 Admin-only 只读端点作为数量、质量、地理和版本留存的统一排查入口：

```text
GET /internal/v1/admin/pipelines/province-opinion/quality-summary
```

它聚合 Hub 当前 PostgreSQL projection，不读取 Night-All、不调用 Agent、不返回受限 raw，
契约版本为 `mx-insight-hub.public-opinion.quality-summary.v1`。部署前的旧实例可能返回 404；
这表示运行版本尚未包含该契约，不能用 0 代替。

```bash
curl -fsS \
  -H "x-mx-insight-admin-token: $HUB_ADMIN_TOKEN" \
  "$HUB_ADMIN_BASE/internal/v1/admin/pipelines/province-opinion/quality-summary" \
| jq -e '.data as $d | {
    contractVersion: $d.contractVersion,
    pipelineKey: $d.pipelineKey,
    checkedAt: $d.checkedAt,
    canonical: $d.canonical,
    stages: $d.publication.stages,
    statuses: $d.publication.statuses,
    candidates: $d.publication.candidates,
    geography: {
      withProvince: $d.geography.withProvince,
      withoutProvince: $d.geography.withoutProvince,
      verified: $d.geography.verified,
      withLocation: $d.geography.withLocation,
      scopes: $d.geography.scopes,
      countries: $d.geography.countries,
      provinces: $d.geography.provinces
    },
    completeness: $d.completeness,
    analysis: $d.analysis,
    archive: $d.archive,
    time: $d.time
  }'
```

字段解释：

- `canonical.active` 是 Hub 当前未删除 distinct canonical 数，不是所有 import run 的累计
  upsert 数；`missingPublicationState` 非零是 materialization/迁移异常，应先修复。
- `publication.stages.formal|candidate` 说明源端真正送进 Hub 的两层供给；
  `statuses.pending|qualified|rejected|failed` 说明 Hub publication gate 的结果。
- 正式记录通常不需要 candidate quality score，因此不要把总 `unassessed` 当成质量失败；
  应观察 `publication.candidates.scored|unscored|qualifiedAtThreshold`、`scoreBuckets`、
  `qualityFlags` 和 `rejectionCodes`。这些是 Hub 质量规则的汇总，不是 Night-All 单条 LLM
  拒绝原因。
- `geography.withProvince` 是当前 display province；`verified` 只认 accepted event
  geography。publisher/dateline fallback 或 proposed geography 可以帮助候选探索，但不能
  算 verified coverage。
- `geography.provinces` 的 key 是 `CN-*`；`countries` 中的 `unclassified` 表示尚无可靠
  country。它们是当前总量，不带 coverage 的时间窗和 candidate mode，不能替代第 2 节。
- `completeness` 统计缺标题、URL、事件时间。缺事件时间不等于无效，但会使 formal 有界
  coverage 查不到该记录。
- `analysis.tasks.pending|dead` 用于判断 Agent 是否暂停、积压或失败；
  `analysis.errors` 只给安全错误码分布，不返回 provider 私密信息。
- `archive.priorSourceRevisions` 和 `priorCanonicalRevisions` 是当前对象之外保留的历史版本
  行数，不是冷存储对象数，也不是备份成功证明。

## 5. Night-All 供给漏斗

Hub 汇总只能说明“进入 Hub 以后发生了什么”。判断源少还是质量门槛，必须同时读取
Night-All 最近 Agent run 的漏斗。以下命令只读历史 run；不要用 `POST` 新建 run 来做
数量检查。即使某个 direct-run 参数名为 `dryRun`，源端仍可能创建审计 run、调用搜索
provider/LLM 并消耗额度。

```bash
curl -fsS --get \
  --data-urlencode 'agentType=political_terror_daily_brief' \
  --data-urlencode 'includeDetails=true' \
  --data-urlencode 'limit=1' \
  "$NIGHTALL_BASE/api/v1/agent-runs" \
| jq -e '
  .data[0] as $r
  | ($r.output // {}) as $o
  | ($o.sourceStats // {}) as $sources
  | def sum_field($field):
      ([$sources | to_entries[]? | (.value[$field] // 0)] | add // 0);
  {
    runId: $r.id,
    status: $r.status,
    generatedAt: $o.generatedAt,
    collected: sum_field("collected"),
    normalizedCandidates: ($o.candidateCount // 0),
    sentToReview: sum_field("reviewed"),
    semanticPassed: ($o.classifiedCount // 0),
    finalRows: sum_field("final"),
    persistedUpserts: ($o.persistedCount // 0),
    deterministicDrops: {
      junk: ($o.junkDropped // 0),
      lowQuality: ($o.lowQualityDropped // 0),
      noUrl: ($o.noUrlDropped // 0)
    },
    candidateEnvelope: {
      produced: ($o.sourceCandidateCount // 0),
      persisted: ($o.sourceCandidatePersistedCount // 0),
      writerEnabled: ($o.sourceCandidateWriterEnabled // false),
      skippedReason: ($o.sourceCandidatePersistSkippedReason // null)
    },
    provinceRecall: ($o.provinceRecall // null),
    reviewFailures: ($o.reviewFailures // [])
  }'
```

再看各 source channel 的失败、空结果和确定性丢弃：

```bash
curl -fsS --get \
  --data-urlencode 'agentType=political_terror_daily_brief' \
  --data-urlencode 'includeDetails=true' \
  --data-urlencode 'limit=1' \
  "$NIGHTALL_BASE/api/v1/agent-runs" \
| jq -e '(.data[0].output.sourceDiagnostics // {})
  | to_entries
  | map({
      source: .key,
      attempts: .value.attempts,
      success: .value.success,
      failed: .value.failed,
      empty: .value.empty,
      itemCount: .value.itemCount,
      dropped: .value.dropped,
      errors: .value.errors
    })
  | map(select(
      (.failed // 0) > 0
      or (.empty // 0) > 0
      or ((.dropped.junk // 0) + (.dropped.lowQuality // 0) + (.dropped.noUrl // 0)) > 0
    ))'
```

当前 Night-All 只显式归因 junk、low-quality 和 no-URL；短文本、hot noise、超龄、去重等
损失还没有完整的独立计数。因此 `collected - normalizedCandidates` 大于三类 drop 之和时，
应记录为“归因缺口”，不能武断地全部归为质量差。

审计样本（生成于 2026-08-09）为 `416 collected → 235 normalized/reviewed → 8 semantic
passed → 7 final`，已明确的 low-quality drop 只有 3。这个样本说明当时主损失是狭窄主题
语义门槛，而不是源端只采到 7 条；它不是永久 SLA，必须用上述命令检查当前 run。

## 6. 如何判定“源少”还是“质量门槛”

| 观察 | 首要结论 | 下一步 |
| --- | --- | --- |
| Night-All `collected` 本身低，且 source diagnostics 大量 `empty/failed` | 召回源少、查询窄或 provider 故障 | 修 source/query/provider；不要先降 Hub 阈值 |
| `collected` 高、`normalizedCandidates` 低，且 deterministic drops 高 | 源内容质量/格式问题 | 按 drop 类别修清洗或来源，不让垃圾进入 Hub |
| normalized/reviewed 高、`semanticPassed` 很低 | Night-All 主题/LLM gate 是主因 | 复核产品主题；一般全国舆情应新建独立 profile/agent，不应稀释政治/涉恐分类器 |
| candidate envelope `produced>0`，但 `persisted=0` 且 writer disabled/skipped | candidate writer 闸门未开 | 先完成 Hub formal-only/candidate 安全发布，再走变更审批 |
| Night-All 有持久化结果，Hub import 长期无新 run 或 cursor failed | Hub 固定源同步/checkpoint 问题 | 查 pipeline/progress/import error；不要重跑 Night-All Agent |
| Hub candidate 多、`unscored` 和 Agent `pending` 高 | Hub Agent 暂停、积压或 worker/provider 不可用 | 按第 9 节 gate 处理，不降低质量线 |
| candidate 已 scored，但 `rejected` 高、`qualifiedAtThreshold` 低 | Hub 质量规则/阈值是主因 | 抽样受限 evidence，版本化调整规则；不要把 `all` 设为默认 |
| qualified 足够但 `withoutProvince` 高 | 地理证据不足，不是内容数量不足 | 保留 `unknown/overseas/national`，补地理证据或受控 Agent，不猜江苏 |
| coverage 只在部分省有量，质量汇总的 `national/overseas/unknown` 高 | 内容不属于单一中国省份或尚未分类 | 分开展示范围；不能把它们均摊到 34 省 |

Night-All 当前 `political_terror_daily_brief` 的目标是政治/涉恐日报，省份 recall 查询也围绕
公安、纪委、群体事件、抗议、袭击、爆炸和反恐；它不是一般社会舆情全集。要解决“全国
一般舆情数量”，主方案应是新增独立 topic profile/agent、扩大来源与可审计召回，并保留
政治/涉恐数据集原有门槛。单纯降低 `minQualityScore` 只能放宽 Hub candidate 展示，既不会
增加 Night-All collection，也不会补齐已经被源端硬拒绝的记录。

## 7. 海外位置字段和当前局限

不要把 `province` 写成“海外”“其他”或国家名。`province` 只接受中国 34 个省级区域的
ISO 3166-2:CN code；无法由 accepted event evidence 证明时保持 `null`。当前候选位置契约
已经提供：

```json
{
  "province": null,
  "location": {
    "label": "南苏丹",
    "type": "country",
    "country": "南苏丹",
    "countryCode": "SS",
    "geoScope": "overseas"
  }
}
```

语义分工如下：

- `geoScope`：`province|multi_province|national|maritime|overseas|unknown`；
- `countryCode`：ISO alpha-2，非中国位置不要伪装成 CN province；
- `location.label/type`：有证据的 country/region/city 展示值；
- `geographyVerified`：accepted event geography，不能由媒体所在地或模型 proposal 直接
  置真；
- `publisherAdmin1` 与 event location 分开保存，江苏媒体不自动等于事件发生在江苏。

当前分析不能保证“较全面识别全球具体位置”：确定性行政区词典以中国为中心，海外主要
依赖源结构化字段、明确国家/地点文字和有界 Chat Agent；Agent 不使用外部 geocoder/tools，
输入也是有界 title、summary、source 和证据窗口。模糊地名、跨国事件、只有全文深处才有
地点、无 ISO code 或证据冲突时应返回 `unknown`，而不是猜测。

若产品下一版需要全球 admin1/city，下一个版本化合同可在 `location` 下增加
`admin1Code/admin1Name/cityName`，内部 evidence 层另存 `method/confidence/evidenceRefs`，
必要时再增加经审核的坐标。该扩展不能复用中国 `province` 字段，也不能把内部证据直接
暴露给公共 API。当前运行版本没有承诺这些未来字段。

## 8. 归档与安全回放

当前“归档”是 Hub PostgreSQL 中的版本化证据，不是搬文件：

- `ingest.source_objects` 保存源对象当前指针；
- `ingest.source_object_revisions` append-only 保存每次 semantic raw payload 变化；
- `core.canonical_records` 保存 current canonical；
- `core.record_revisions` 保存 canonical 内容 revision；
- classification assertions 绑定 source/canonical revision，Agent 只提交派生证据；
- transport-only 水位变化不会伪造新的语义 revision 或重复模型计费。

第 4 节的 `archive.*` 可核对 current 对象与历史 revision 数，但不能代替 PostgreSQL base
backup、WAL/PITR、加密逻辑备份和恢复演练。当前没有通用 cold archive/TTL；源库和 Hub
分别有备份 owner。Night-All 的 hard delete 无法由 `(updated_at,id)` 增量发现，删除必须先
成为带水位的 tombstone/change record。

### 8.1 普通恢复优先级

1. cursor `failed`：修复根因后用 `/resume`，保留 checkpoint；
2. projector/HanLP/ES 落后：恢复依赖并重试 projection，绝不 reset Night-All checkpoint；
3. Agent dead：先修 provider/input，再审批 `retry-dead`，不要重拉源；
4. 只有确认 current-table 需要从头对齐时，才进行 checkpoint reset。

省份舆情不能使用通用 `/internal/v1/admin/backfill`：该功能默认仅支持
`xiaohongshu,douyin,twitter` 的 Night-All export。省份舆情必须走固定
`province-opinion-results` 的只读 `(updated_at,id)` pipeline。

### 8.2 受控全量对齐

以下是会改变运行状态的高风险流程，不属于本文只读排查命令。只允许在批准的变更窗口
执行，并先保存 quality summary、progress、最近 import runs、Hub 备份和目标 Night-All
writer/watermark 证据：

1. 暂停 `province-opinion`，等待 cursor 到 `idle`，确认没有 worker/session lock；
2. 用精确 `confirmPipelineKey=province-opinion` reset checkpoint；该操作不删除 canonical，
   但会从源 current table 重新扫描并增加数据库/投影负载；
3. 当前仓库要求 `province-opinion.writer.v2`；仍必须使用本次 GET 返回的 v2
   version/digest 重新 attestation 并激活，不能复用 v1 或另一环境的 digest；
4. 以有界 batch 启动 sync，监控 import rejected、cursor、quality summary 和 projection；
5. 对账 current distinct、source objects、revision、34 省 coverage 和未分类/海外数，再结束
   变更窗口。

```bash
# 写操作示例：仅用于已经批准的恢复变更窗口，不能在排查时复制执行。
curl -fsS -X POST \
  -H "x-mx-insight-admin-token: $HUB_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"status":"paused"}' \
  "$HUB_ADMIN_BASE/internal/v1/admin/pipelines/province-opinion/status"

curl -fsS -X POST \
  -H "x-mx-insight-admin-token: $HUB_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"confirmPipelineKey":"province-opinion"}' \
  "$HUB_ADMIN_BASE/internal/v1/admin/pipelines/province-opinion/checkpoint/reset"
```

不要在文档中固化 attestation digest；它必须来自目标环境当次 GET。回放具有 canonical
identity/raw hash/task unique key 的幂等保护，但仍不是 frozen snapshot，也不能恢复上游已
hard-delete 的行。若需要迁移到新库或严格 frozen snapshot，应另建 staging、记录固定高水位、
全量加载后追增量、对账再原子切换；当前没有一个 Admin endpoint 自动完成这套切换。

## 9. 生产 Agent enable gate

必须区分四个相互独立的开关：

| 开关 | 作用 | 默认/安全边界 |
| --- | --- | --- |
| Night-All scheduled/direct Agent | 采集并做源端政治/涉恐语义审核 | direct run 可能调用 provider/LLM；只读排查不执行 |
| Night-All candidate writer env gate | 把清洗后、审核前 envelope 写成 `source_stage=candidate` | 必须在 Hub candidate 隔离部署并验证后才可开 |
| Hub `province-opinion` source pipeline | 从 Night-All current table 增量拉取 | 与分类 Agent 独立；当前需 `province-opinion.writer.v2` attestation |
| Hub `province-geography-v1` Agent pipeline | 对 Hub revision 做地理/质量派生分析 | migration 默认 `paused`；启用才 claim backlog |

先只读检查 Hub Agent：

该分类链路使用 Chat Provider；页面上 Embedding 未配置不会阻止省份地理分类。真正需要
确认的是 `.data.available`、Chat provider test 与独立 classifier workload 三者。

```bash
curl -fsS \
  -H "x-mx-insight-admin-token: $HUB_ADMIN_TOKEN" \
  "$HUB_ADMIN_BASE/internal/v1/admin/agent" \
| jq -e '.data as $d | {
    runtimeAvailable: $d.available,
    provincePipeline: (
      [$d.pipelines[]? | select(.pipelineKey == "province-geography-v1")][0]
      | {
          pipelineKey, status, revision, itemsPerMinute, maxInFlight,
          tasks, assertions, analysisVersion, taxonomyVersion,
          ruleVersion, promptVersion, updatedAt
        }
    )
  }'
```

生产启用 `province-geography-v1` 前必须同时满足：

- Hub migration、formal-only 默认门禁、candidate 显式可见性和 content projection 已部署；
- 固定源首次 current-table alignment 完成，import rejected 为 0，quality summary 可读取；
- backlog 已 materialize/估算，`itemsPerMinute`、token、时间和费用得到审批；默认 12
  items/min、全局单飞不等于 provider 账单上限；
- Chat provider 分别测试通过，classifier workload 的实际 Secret、egress、Pod/日志也有
  证据；Admin API 进程测试成功不能替代 worker 证据；
- 抽样验证 event province、publisher province、national/maritime/overseas/unknown 分离，
  proposed assertion 不进入 formal province feed；
- 先小速率观察 pending/succeeded/dead、qualification 和 coverage，再逐步调整；
- MX-H2I 登录/联网 smoke 独立通过。任何回归都停止 Hub 变更，不修改 MX-H2I 网络来适配。

真正启用是带 optimistic revision 的写操作，必须使用刚读取的 revision。下例只定义变更
合同，不授权执行：

```bash
# 写操作示例：仅在已批准的生产变更窗口执行。
curl -fsS -X PUT \
  -H "x-mx-insight-admin-token: $HUB_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"expectedRevision":<GET返回的revision>,"status":"active","itemsPerMinute":12}' \
  "$HUB_ADMIN_BASE/internal/v1/admin/agent/pipelines/province-geography-v1"
```

遇到 409 必须重新 GET 并评估他人的变更，不能覆盖 revision。启用 Hub Agent 不会自动打开
Night-All candidate writer；两个开关不得在同一未验证步骤中同时打开。

## 10. 一次排查的最小证据包

一次“全国数量不足”事件至少保存以下脱敏输出和同一时间窗：

1. 最近 10 条 Hub import runs，明确 `18` 是哪一个 cursor interval；
2. Hub quality summary；
3. formal-only 与 qualified 的同窗 province coverage；
4. 江苏 `latest` 第一页及 pageInfo（如问题涉及江苏）；
5. Night-All 最近 run 漏斗和 source diagnostics；
6. Hub Agent status/revision/backlog；
7. 结论标注为 source supply、deterministic quality、semantic topic gate、candidate writer、
   Hub ingest、Hub Agent、geography 或 projection 中的哪一层。

不要收集 token、连接对象、raw evidence、provider endpoint/credential 或用户数据。以上证据
足以区分“源少”和“质量门槛”，且不需要运行 Agent、重置 checkpoint、修改生产配置或
触碰 MX-H2I。
