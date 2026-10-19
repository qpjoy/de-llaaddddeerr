# Telegram 搜索空结果与向量覆盖核对：2026-10-19

## 已确认的请求与证据边界

本次用户提供三个响应回执，涉及两个业务请求 ID：

- `d3a4c71c-4b06-4bea-b0ca-04de4226fa9e`：初始回执；之后的 `idempotent-replay: true` 回执仍为同一 ID，是历史交付重放。
- `96398363-af53-4e15-aae0-a9ebc75cc3ac`：后续 `idempotent-replay: false` 的新执行回执，仍返回空结果。

因此，不能把全部空结果解释成 curl 格式错误，也不能只归因为旧结果回放。已知请求体符合专用 Telegram 搜索合同：`query=领导人`、`sourceScope=all`、`scope=messages`、`matchMode=full_text`、`pageSize=20`。当前专用入口不需要、也不接受额外 `platform`。

原时间窗为 `2026-10-13T19:51:18.939036Z` 至 `2026-10-18T19:51:18.939036Z`，即北京时间 10 月 14 日 03:51 至 10 月 19 日 03:51，按消息事件时间筛选。当前参数归一化为 `.939Z` 毫秒精度；该极小边界差异不解释整个五天窗口为空。诊断沿用当前实际归一化时间，避免拿另一时间窗解释原请求。

`full_text` 是词法搜索，默认 balanced profile 的原文短语／HanLP 全词分支，不会自动把“领导人”扩展为人物姓名、职务或同义表达。向量召回与该词法入口是不同执行路径；即使历史消息已有向量，也不会使这个已有入口自动变成语义检索。

**当前根因未确定。** 需要分开核对：Hub 是否已收录窗口内消息；其中是否有字面关键词候选；当前 ES 读别名是否有对应数据及时间；词法分支能否命中；向量样本是否属于当前修订并进入当前 chunk 读别名。PG 现状、ES 现状和历史请求发生时的状态不是同一个时间截面。

## 运行一次有界只读诊断

使用本地更新后的脚本，通过 stdin 运行于实际 Public 容器；无需先更新业务镜像，脚本不导入新业务模块。以下命名空间、Deployment 和容器名来自当前仓库清单。进入 Hub 仓库目录后执行：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-public -c api -- \
  sh -lc 'cd /app && node --input-type=module -' \
  < server/ops/diagnose-telegram-search.mjs
```

若同一 Deployment 有多个 Public 副本，这条命令选择其中一个 Pod；输出的 runtime SHA 仅证明被选 Pod 的文件，不能代替全部副本版本一致性验证。要核对特定 Pod，应将 `deployment/mx-insight-hub-public` 换成已有明确 Pod 名。

脚本行为：

- 仅使用容器已有 `DATABASE_URL` 建立单连接，在 `REPEATABLE READ READ ONLY` 事务中查询；每条 SQL 的 statement timeout 为 3 秒、lock timeout 为 1 秒，最后 rollback。
- 只读取两个固定请求 ID 的有限字段和参数匹配布尔值。未打印原请求体、响应正文、Key、用户名、数据库地址或任意错误消息。
- 对两个 TG messages 数据集分别读取最多一个已有记录、一个时间窗记录、一个窗内标题／正文包含关键词的候选、一个不限时间的字面候选；无全库 count。
- 对每个数据集再取最多一个 `source_revision=current_revision`、canonical 未删除且有 vector 的 chunk 样本，只读取 UUID、修订、模型标识、维度、投影文档标识和时间，不返回正文或向量。
- 仅使用既有 `MX_COMMON_ELASTICSEARCH_URL/USERNAME/PASSWORD` 读取 ES；未配置 URL 且为 Kubernetes 时使用与 Hub config 相同的 mx-common 服务默认地址。拒绝 HTTP 重定向，每次请求连同正文读取最多 5 秒、正文最多 1 MiB。
- ES 全部使用 GET：读取 content 读／写别名和 chunk 读别名、相关有限字段类型，以及 `size=1`、`track_total_hits=false`、`timeout=3s` 的存在性探针。不会打开 PIT、refresh、重建、启动历史任务、调用 embedding 或供应商，也不会重放业务 POST。

超时、缺表、连接失败、部分 shard、`timed_out` 或响应不完整均标为 `incomplete`。**`incomplete` 表示未知，不是零条。** 脚本返回非零退出码时，仍需保留已经输出的报告，不应自动重新执行昂贵查询。

## 如何读词法诊断

| 报告字段 | 能说明什么 | 不能说明什么 |
| --- | --- | --- |
| `database.requests` | 两个已保存请求的状态、HTTP 状态、参数逐字段是否与预期相同、返回条数和降级告警 | 不把缺失历史 snapshot 当成参数不一致，也不回放请求 |
| `datasets[].any` | 当前存在该来源的一条活跃消息 | 不代表总量或历史已补齐 |
| `datasets[].window` | 当前存在实际时间窗内的一条消息 | 不代表包含关键词 |
| `datasets[].windowLiteral` | 当前至少一条标题／正文包含“领导人”的窗内 canonical 消息 | 不证明 ES 已投影，也不等于完整 balanced 结果集 |
| `datasets[].literalAnyTime` | 不限时间时存在字面候选 | 若窗内为空，有助区分时间范围；不返回候选正文 |
| `projection.aliases/mappings` | 当前 content 读／写和 chunk 读别名绑定，以及相关字段类型／向量维度 | 不证明历史请求发生时同样绑定，也不证明投影完整 |
| `projection.probes.scope/window/rawPhrase` | 依次加上 TG 数据范围、时间窗、raw phrase 后是否仍有 ES 候选 | raw phrase 只是 balanced 的一个分支，不是全业务搜索重放 |
| `projection.canonicalSamples` | 从 PG 字面候选 UUID 检查当前 content 读别名是否存在该文档 | 存在不证明正文、HanLP 分词和全部字段正确 |

只在 `state=observed` 且 `rows=[]`，或完整 ES 结果 `found=false` 时，才能说“该次探针未发现匹配”。例如 PG 窗内字面候选存在而 ES 对应 UUID 缺失，支持进一步调查投影缺失／别名覆盖；不能由一次样本直接认定整个索引损坏，也不自动授权重建。

## 历史 Telegram 是否已向量化

源码中的历史初始化从 `core.canonical_records` 捕获固定 record/revision manifest；普通扫描／增量任务同样基于 canonical 数据，未以平台白名单排除 Telegram。当前文本资格要求标题与正文合计至少 24 字符，短消息不会全部进入向量化。worker 对符合条件的记录执行 chunk materialize、embedding、chunk projection，并核对当前修订和失败状态。**这证明 TG 属于代码可处理范围，不证明某个环境历史 TG 已完成全量向量化。**

历史初始化和后续增量使用不同的额度与进度范围。初始化是用户明确启动的固定清单任务，不能用普通部署或一次诊断自动补启动，也不能为了核对覆盖提高预算。已收录正文、已生成 chunk、已计算 vector、已投影 ES，是分别需要证据的状态。

本脚本提供最小样本证据：

- `datasets[].currentVector.rows[0]` 存在：该样本有保存在 PG 的向量，`sourceRevision=currentRevision` 且原记录未删除。`model`、`dimensions` 是样本的模型空间，不是当前在线查询配置。
- `embeddedAt` 仅说明该样本保存过计算结果；`projectedAt` 是数据库保存的投影时间，**不能证明它仍在当前 chunk 别名中**。
- `projection.vectorSamples[].found=true` 且样本 `documentMatches/recordMatches/revisionMatches/embeddingSpaceMatches` 都为 true：当前 chunk 读别名确实包含该 PG 样本的对应记录、修订和模型空间。ES 文档标识是 `recordId:chunkIndex:chunkerVersion`，不是 PG chunk UUID；模型空间按当前投影合同去掉模型标识首个冒号前的 provider 前缀后再拼维度。
- 当前 chunk mapping 的 `dimensions` 可与 PG 样本维度比较；向量空间不匹配时，不能将“存在向量”宣传为当前语义检索已就绪。
- 每来源最多一个样本，无精确覆盖率和任务完成证明。空样本仅表示这次有界且成功的查询未找到符合条件的当前向量；超时／失败必须保持未知。旧修订向量不会被算作当前样本。

诊断不读取模型凭据，也不发测试 embedding，所以不证明当前查询端使用同一模型、embedding Sequence 可用或真实语义召回质量。生产全量完成情况需结合用户已启动的初始化清单、当前 revision 覆盖和独立运行证据判断，不能由一条成功样本外推。

## 公共语义搜索与后续处理

本次已实现 `POST /api/v1/data/telegram/semantic-search`，合同及示例见[下游 TG 接入指南](../integrations/telegram-downstream-guide.md)。Telegram 会话产品同时提供接口调试及 RAG 语义展示入口。它返回有界 Top-K 消息证据，不生成回答，不承诺全量分页。`sourceScope`、作者和时间在向量召回前过滤；当前 chunk 索引没有 `chatId`，会话范围在最多 100 个候选 chunk 中复核，可能不足 Top-K，不等于检索该会话的全部向量。结果从 PG 当前消息与 chunk 读取，核对来源、删除、修订和模型空间。

Public 仍不读取模型凭据。独立 Public listener 将这一固定操作转交到 Internal executor；executor 使用原客户 Live API Key 重新校验 TG 权限、限额及预占，保存一份原路径的交付与计量记录。客户端只调用公共地址，不持有 Admin Token。请求查询向量使用现有 Embedding Sequence，后台暂停不会删除已保存向量；空结果不能证明历史覆盖完整。模型或索引失败返回 503，不自动改成全文成功。

Kubernetes 默认 executor origin 为 `http://mx-insight-hub-admin.mx-insight-hub.svc.cluster.local:18151`，固定路径 `/internal/v1/services/telegram/semantic-search`；非 Kubernetes 的拆分部署设置 `MX_INSIGHT_TELEGRAM_SEMANTIC_INTERNAL_URL` 为受信任 Internal origin。combined 开发模式直接执行同一服务。Hub 自有 NetworkPolicy 新增 Public Pod 到 Admin 18151 的访问；所有 Admin 路由仍要求原管理鉴权，新的 service 路由只接受客户 Key 执行固定 TG 操作。hostNetwork 下的实际策略执行取决于现有 CNI，应按当前部署验证。无 Launcher、SSO、MX-H2I、Pay 或共享集群网络修改。

需按正常流程发布 Hub 的 Admin 和 Public 两个运行时及 Hub NetworkPolicy；本次未部署、未恢复后台任务、未启动向量初始化或索引重建。无需本次新增数据库迁移或向量索引版本。发布前继续遵守当前共享存储健康与部署保护流程，不能仅凭 Pod Ready 认定环境已恢复。原全文接口保留原语义；另补上 ES `timed_out`/失败分片完整性检查，首屏走带告警的既有 PG 降级，已有 ES 游标失败返回 503，不把部分执行当作完整零命中。

Public→Internal 交付超时、断连或响应不完整时，返回 `502 semantic_search_outcome_unknown`；执行端可能已完成，必须按原 Idempotency-Key 查状态，不能新建轮次盲目重发。语义查询已提交结果按原 key 固定重放，不沿用全文入口的 120 秒窗口；新轮次显式换 key。模型执行开始后发生无法确认结果的错误也保留 unknown，阻止同 key 重算；只有确定未派发模型的缺配置或并发槽繁忙才释放预占。查询完成与新鲜向量覆盖是不同状态。

收到以上只读报告后，按证据决定是否需要进一步核对 ingest、content projector、chunk projector 或查询模型空间。无论哪一层异常，本诊断均不修改 grant、历史账单、幂等记录、checkpoint、SSO、MX-H2I 登录或联网配置。

依据：`server/retrieval/control.mjs`、`server/retrieval/worker.mjs`、`server/embedding/pipeline.mjs`、`server/search/index-definitions.mjs`，以及 [下游 TG 接入指南](../integrations/telegram-downstream-guide.md)。

## 本地验证

TG 核心检索、PGlite 实际 SQL、只读诊断、契约和组件行为共 44 项通过；Public→Internal 交付、授权、幂等、unknown、真实 localhost 慢正文／重定向／响应上限与 Retry-After 共 10 项通过，均无跳过。既有 AdvancedSearch 24 项及公共文档 11 项通过；类型检查和生产构建通过，构建仍有既有大 chunk 提示。

扩展运行 Hub/Runtime/timeline 回归为 34 通过、2 失败。两项为 `hub.test.mjs` 的旧通用搜索／历史调用结果不确定路径，分别预期 200／502 而返回 503；在未修改的 HEAD `0dd1ef77` 独立导出目录中同样失败，未通过改变旧测试预期或其他平台路由掩盖。新增 TG 路由、原上下文及 Public/Admin 隔离检查均通过。测试与浏览器展示使用合成数据，不代表生产“领导人”语义召回或历史向量完整度已验收。

Chrome 使用实际组件及样式、合成 API 响应检查语义成功、当前会话、空结果、服务错误和移动端布局；没有页面异常，未向生产服务发送搜索或模型请求。
