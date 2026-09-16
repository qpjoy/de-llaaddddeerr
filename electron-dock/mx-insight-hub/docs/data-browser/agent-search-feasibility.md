# Agent、Text2ES 与契约驱动转发：稳定性评估

日期：2026-09-16。结论：固定契约执行＋Agent 离线诊断/提案可行；让 Agent 在实时转发中自行改 URL、鉴权、字段或重试付费请求，不具备当前上线条件。本次仅实现确定性的只读浏览，不启用自适应转发。

## 实际基线与参考项目

- `mx-launcher/docs/26-mx-insight-hub-integration-architecture.md`：Internal 是 MX-H2I 配置与用户真相中心。Hub 是独立数据面；Luopan 是 standalone 测试产品，不是网络 owner。
- Hub `server/agent-studio/` 和 ADR-0012：已有 Project/CAS Draft、代码注册节点、编译后的不可执行 Artifact 和静态 assurance；通用 Sandbox、运行账本、Eval、Release、Deployment 未完成。现有固定 runtime 和专题报告不等于通用 Studio 执行器。
- `Night-All/specs/README.md`、`docs/README.md`：采集/源数据与 Hub 公共产品边界可复用；其中“Hub 待实现”等历史结论已经过时，以当前 Hub 代码为准。此次不修改 Night-All 或接入新的远程采集。
- `Delta_Pub/README.md`、`assistant_runtime/tool_loop.py`：可借鉴任务/对话区分、资源与 Prompt 快照、任务取消、事件日志、有限工具轮次和重复调用签名。其 Django/Celery/Python 部署与工具重试语义不直接复制，尤其不能把模型规划重试等同付费工具重试。
- `rock-agents/package.json` 和 LangChain 第 09 课：已有 Node.js LangChain/LangGraph/Zod 的可运行学习案例，适合验证状态、节点、边和结构化输出；教学内存状态不是生产持久化执行器。

## Node.js 技术路线

采用 LangGraph JS 的状态图、checkpoint、interrupt/resume；LangChain JS 的模型/工具适配与结构化输出；Zod 定义输入、节点结果和业务契约。包版本需要根据 Hub Node 22 环境锁定并跑兼容测试，不直接照抄学习仓库 semver。

Hub 继续拥有 UI、Project/Artifact/Run/Eval/Release 真相，LangGraph 是独立 Worker 内的库，不新建第二套控制台/身份系统。LLM 必须通过已有批准的 Sequence；没有默认 Sequence 时任务 blocked，不能偷偷选择第一个 Provider。不要为了分析增加 Hub 登录/readiness 的外部依赖。

最小生产执行闭环：

1. 冻结 Artifact、Prompt、输入 revision、Sequence revision、工具/契约版本。
2. 有界任务 admission、队列与持久化 checkpoint，Worker lease、heartbeat、取消、超时、预算。
3. 每次模型和工具调用 append-only Run/Event Ledger；checkpoint 保存恢复位置，账本保存业务副作用事实，两者不能互相代替。
4. Zod 校验输出后，另做引用存在性、revision 一致性、字段权限、逻辑约束和质量评估。
5. 固定评测集＋故障注入＋人工审核＋shadow→canary→active，发布不可变 Release 与可回退 Deployment 指针。

恢复/重放节点必须幂等；模型超时可按预算重试，但付费请求的未知结果先核对已有调用证据，不能由图引擎自动重发。Tool allowlist 只接受代码注册能力，不接受来源文本里的指令、任意 URL/SQL/脚本。

## Zod＋固定 API 文档能否承接转发

**可以提升可维护性和结构稳定性，但不能单独保证语义正确。** Zod 可以约束对象形状、类型和取值；无法证明字段真义、完整性、授权合法性或上游是否已经扣费。固定 API 文档也会过期，应保存 spec hash、契约 release 和验证证据。

建议双通道：

| 同步业务路径 | 异步治理路径 |
| --- | --- |
| 授权/限额/幂等→已批准 operation→固定 destination→请求 schema→一次派发→响应分层校验→归档/标准化→返回 | 收集 schema drift、错误率、缺字段和样本→Agent 读取版本化文档与去凭据证据→产出修复提案→沙箱回放→确定性评估→人工批准→灰度发布 |

文档、模型生成的对象及上游内容都只是数据，不授予执行权限。候选契约需要 `operationKey/specHash/schemaVersion/adapterVersion/effectiveAt`，兼容范围和证据明确；Agent 无权直接改活跃映射、账单价格、消费者授权或重试策略。

响应分层：transport success、供应商已计费、业务 envelope success、schema success、canonical completeness 各自记录。未知新增字段保留原始业务载荷并进入扩展区，不因为 `.strict()` 丢业务数据；schema 严格应用于 Hub 自有执行命令和关键字段。关键字段漂移进入隔离/降级，已获原始响应和当前计费证据不能丢弃。错误码、幂等和 historical replay 继续遵守现有接口。

## 是否必须每次经过 Agent 检查

不需要，也不建议。每次必须执行廉价确定性检查：身份/授权、限额、固定路由、请求 schema、关键响应字段和计费幂等。Agent 只做周期/事件驱动的语义复核。

初始运营建议（不是本次启用的定时器）：稳定接口每天聚合健康证据，每周对脱敏样本与 spec 做一次语义复核；刚上线或频繁变化的接口每天复核，出现 schema hash 变化、关键字段缺失、完整率下降或异常错误率立即失效旧证明并告警。低流量接口缺样本时保留 unknown，不因经过一周而自动通过。采样比例和阈值用历史流量标定，不能凭模型自评“合规”。

复核证据绑定 operation＋spec＋adapter＋credential revision＋相关配置。字段新增不必关闭全部平台；关键身份/金额/分页变化只暂停受影响 operation。对存量读取、其他平台及 MX-H2I 登录没有连带失败。

## Text2ES / RAG

用户所写 `test2es` 暂按 Text2ES（自然语言→ES 查询）理解；若指具体项目，需要另评估其许可证、维护和执行边界。

有帮助的场景：复杂筛选的参数解释、同义词展开、RAG 候选召回。建议 Text→Zod SearchIntent→确定性查询编译器→现有 Hub canonical search，而非 Text→任意 ES DSL。SearchIntent 只包含获准数据集/平台、关键词、时间范围、允许的排序、受控检索 profile；拒绝 scripts、任意索引、聚合路径、无限 size、客户端 ACL 和私有字段。权限过滤与 cost/timeout 在模型之后由服务器再次施加。模型不可用时退回普通搜索。

现有 PG canonical/revision/outbox 与 ES content/chunk projection 已适合作为 RAG 基础。Embedding Sequence、模型维度和 chunk/source revision 必须匹配；PG 回查当前权限和删除状态，再生成带 record/revision 引用的答案。缺少 embedding 默认时保留关键词检索，不为建立空壳 RAG 自动选择 Provider。

本期不将 Text2ES 加入生产请求：当前通用执行/评估闭环尚未完成。下一阶段先 Admin shadow，评估筛选正确率、授权泄漏（必须为零）、不支持意图拒绝率、超时、成本、引用准确性；通过后仍让用户能查看并修改解析的条件。

## ES 升级未全量重索引的影响

不能笼统说没有影响：

| 变更 | 旧记录行为 | 发布方案 |
| --- | --- | --- |
| 新增可选展示字段、扩展 JSON | PG 原始内容仍可用，ES 老文档可能缺值 | 双读兼容/null-aware UI；增量更新新记录；按需历史回填 |
| 新增 multi-field、分词字段、向量 | 老文档不会自动生成新字段，召回/排序/向量覆盖不完整 | 标注 coverage，保留旧检索分支，低峰按版本缺口分批回填 |
| 改字段类型、分析器或向量维度 | 原 mapping 不可直接作为同一语义继续使用 | 新物理索引、后台构建、追平 outbox、校验、原子 alias 切换 |
| 不兼容身份或归一化语义 | 简单 ES 重建未必能修复 PG 真相 | 独立 canonical 迁移与可回滚发布，单独审批执行 |

当前 `server/search/index.mjs` 已有 schema-only 启动、reconciled watermark、A/B 构建与 catch-up；`current-state.mjs` 有切换 fence；`profiles.mjs` 区分 target 与 active schema 的能力。普通启动不应强制全量重建。本次不改这些运行机制。

后续缺口：不仅看 alias schemaVersion，还应统计每种表示的历史覆盖率（eligible/indexed/current revision）；新增能力可以“部分覆盖”而不是误称全部 ready。未来新增数据类型走版本化 normalization 和 flattened extensions，避免每种来源都引入新顶层 mapping。projection version 与 canonical schema version 分开管理。

跨越式升级可以夜间执行，但不承诺一夜结束：先估算数据量、双索引空间、分词/embedding 吞吐和 outbox 积压；候选后台限速构建，完成后短暂 fence 并追平，验证计数、样本、删除 tombstone 和 revision 一致性后切换。保留旧索引用于回退，禁止构建失败就把 alias 指向空索引。不能因夜间维护重启 Launcher、WG、DNS 或用户认证。

## 可复核的外部技术依据

- [LangChain JS structured output](https://docs.langchain.com/oss/javascript/langchain/structured-output)：结构化响应与 Zod schema 接入。
- [LangGraph JS durable execution](https://docs.langchain.com/oss/javascript/langgraph/durable-execution)：持久化恢复以及确定性、幂等副作用约束。
- [LangChain JS tools](https://docs.langchain.com/oss/javascript/langchain/tools)：schema 定义工具输入。
- [Elasticsearch mapping](https://www.elastic.co/docs/manage-data/data-store/mapping)：新增 multi-field 不会自动补齐旧文档。
- [Elasticsearch update mappings](https://www.elastic.co/docs/manage-data/data-store/mapping/update-mappings-examples)：类型变更与重索引边界。

这些文档说明库的能力，不证明 Hub 已落地相应运行机制。稳定上线结论必须来自本项目测试、真实数据评估与发布证据。
