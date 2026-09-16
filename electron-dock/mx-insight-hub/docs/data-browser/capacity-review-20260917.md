# 容量报告复核与 Embedding 配置说明

复核日期：2026-09-17。证据采集时间：2026-09-16 23:39（Asia/Shanghai），不是实时监控。

来源：用户提供的 `mx-hub-capacity-20260916-233927.tar.gz`，SHA-256：`5cacb6f18e5824817a5f77a8b144896ac8a1a68493cd79b0cd9bed8053b8e07a`。

本次仅离线读取报告、核对仓库实现和官方文档；没有启动线上重建、Embedding、清理索引或修改设置。

## 判断

- 截图的 `mx-default-chat` 是 Chat / Agent 默认 Sequence，不是后台向量化默认。截图请求顺序只有 `openai`，左侧其余 Provider 未加入请求链。
- 向量化直接调用独立 Embedding Sequence 的 `/embeddings`，不要求先配置或运行 Agent Market 的进阶搜索 Agent。
- 报告中向量维度为 null，向量 mapping 为空；不能视为向量索引已经就绪。报告不包含数据库中的完整 Provider/Sequence 配置，不能据此判断用户此后是否已配置。
- 抽样推算约 114 万条可向量化记录、142 万个切片、1.86 亿估算 token。数据本体未必需要 70 GiB，但尚不能证明当前磁盘足以安全完成两个全量任务。
- `/data` 可用约 174 GiB，但新增约 24 GiB 就会触及 ES 高水位。建议先为写入与业务增长留出空间，再由用户手动启动任务。

## 存储位置和实际空间

报告 `pv-paths.json` 的 hostPath 与 Pod PVC 引用对应如下：

| 服务 | 主机目录 | 所在文件系统 |
|---|---|---|
| ES 数据 | `/data/k8s/mx-runtime/mx-common/k8s/elasticsearch/data` | `/data` |
| PG 数据 | `/data/k8s/mx-runtime/mx-common/k8s/postgres/data` | `/data` |
| ES 快照 | `/data/k8s/mx-runtime/mx-common/k8s/elasticsearch/snapshots` | `/data` |
| HanLP 模型 | `/data/k8s/mx-runtime/mx-common/k8s/hanlp/models` | `/data` |

ES 实际报告磁盘总量 1,862.11 GiB，可用 173.73 GiB。PG、ES 共享这块盘，PG 向量/WAL 增长也会减少 ES 可用空间。`/home` 的 70 GiB 和根分区的 111 GiB 不能直接计入现有 PV 的可用空间。PVC 声明容量 50 GiB 不能替代底层 hostPath 文件系统的空间和配额检查。

容器 `df` 文件没有单独打印数据目录行；路径判断依据 PVC→PV→hostPath，并由 ES 自报的磁盘容量与主机 `/data` 对应交叉核验。旧 Hub PG PVC 虽仍列出，但不能把它的声明容量当作当前 mx-common PG 的额外空间。

ES 版本为 9.4.2。报告中的全部 Hub ES 索引合计约 14.42 GiB，远小于整盘已用空间。已有 `content-v6-current`：1,541,744 个 ES 文档、3.47 GiB；`content-v5-current`：1,780,978 个文档、3.98 GiB。报告未采集 alias 和重建任务完成状态，因此 **v6 存在不等于重建完成/读别名已切换**，也不能仅凭旧版本名字删除任何索引。

### 水位换算

报告 persistent/transient 无覆盖，defaults 为 low 85% / high 90% / flood 95%，max_headroom 分别为 200 / 150 / 100 GB。百分比阈值的所需空闲空间取百分比结果与 headroom 上限的较小者，按 Elastic 字节单位换算为 GiB：

| 水位 | 该磁盘所需空闲 | 相比采集时还可增长 |
|---|---:|---:|
| low | 200 GiB | 已低于该空闲要求约 26 GiB |
| high | 150 GiB | 约 23.73 GiB |
| flood-stage | 93.11 GiB | 约 80.63 GiB |

low 对新建索引的主分片有例外，因此不能把当前状态简单解释为所有新主分片都无法创建；high 会约束分配并触发迁移尝试，而报告中只有一个节点，无法向其他节点搬移。flood-stage 会导致受影响索引写保护。

若新增 70 GiB，只剩 103.73 GiB 空闲，距离 flood-stage 仅 10.63 GiB；PG WAL、ES 合并和其他业务写入都共享这部分余量。不要用调高/关闭水位代替空间治理。若暂按最多 70 GiB 新增规划，可把任务开始前约 300 GiB 空闲作为保守操作目标（200 GiB low 余量 + 70 GiB 新增 + 30 GiB 峰值余量），这不是实测占用保证。

依据：[Elastic 磁盘水位与 max_headroom](https://www.elastic.co/docs/reference/elasticsearch/configuration-reference/cluster-level-shard-allocation-routing-settings)。

## 数据量、token 和向量空间

`capacity.json`：canonical planner 行数约 2,488,854（包括删除等不适合向量化的记录，且不是精确计数）；采样 2,000 条，其中 919 条符合文本条件，没有样本裁剪。当前 chunker 计算：

- 预计符合条件记录：1,143,629；平均每条 1.244 个切片。
- 预计切片：1,422,381。
- 未扣除复用的预计输入 token：186,143,880。
- 维度未知，尚无实际向量索引大小；`record_chunks` 表本体仅 8 KiB，planner `-1` 表示缺少统计，不能当作精确记录数。

SYSTEM 页面采样加 LIMIT 可能受物理数据聚集影响，planner 行数也可能滞后。上述数字只适合初步规划，不是全库清单、供应商账单或置信区间。

当前代码把向量存为 PG float32 `real[]`，ES mapping 显式使用 `int8_hnsw`。PG 纯向量基数约 `4 × 维度 × 切片数`，ES 原始 float32 与 int8 量化值合计约 `5 × 维度 × 切片数`：

| 维度（情景假设） | PG 纯向量 | ES 原始与量化向量 | 合计 |
|---|---:|---:|---:|
| 768 | 4.07 GiB | 5.09 GiB | 9.16 GiB |
| 1024 | 5.43 GiB | 6.78 GiB | 12.21 GiB |
| 1536 | 8.14 GiB | 10.17 GiB | 18.31 GiB |
| 3072 | 16.28 GiB | 20.35 GiB | 36.63 GiB |

这些是未含压缩和结构开销的向量基数，不是最终磁盘预测。还需文本、元数据、HNSW 图、PG 行/索引/TOAST、WAL、ES translog/merge，以及全文重建新一代索引。报告中现有 ES 索引副本数为 0；增加副本或保留多代向量索引会另增占用。

因此，1024/1536 维情况下总新增落在 70 GiB 内有可能，3072 维余量更小；没有实际模型维度和一批真实入库测量，不能签发“70 GiB 足够”的结论。推荐模型确定后，以受控批次测量 PG/ES 字节增量与每条处理时间，再外推固定初始化范围。

历史初始化使用独立累计预算，0 表示不限额；日常增量额度保持原值。如果用有限额度，10 亿约为当前抽样估计的 5.37 倍，但实际重试/数据分布可能改变消耗，不能保证覆盖。每日额度耗尽的日常任务保留，代码在次日 UTC 00:00（北京时间 08:00）后继续；供应商自身余额和限流仍独立生效。

依据：[Elastic 量化向量仍保留原始 float 值](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/dense-vector)。

## HanLP 与完成时间

线上报告证实：1 个 HanLP Pod，16 CPU / 8 GiB 上限，Torch/OMP/MKL 16 线程，`MAX_CONCURRENT_INFERENCES=1`，最大批量 256，推理排队超时 30 秒。Hub 全文重建配置为并发 2、每批 16。

实现把 `texts: string[]` 传给 `_tokenizer(inputs)`，逐条对应返回结果，不是把不同记录连接成一篇正文。单推理槽表示同一时刻只接纳一个推理调用，不等于只使用一个 CPU 核；多个 HTTP 请求会排队。

三次顺序合成文本探测（均验证为 HanLP）：

| 输入条数 | 整批延迟 | 折算文本/秒，仅该次探测 |
|---|---:|---:|
| 1 | 30 ms | 33.3 |
| 8 | 65 ms | 123.1 |
| 16 | 140 ms | 114.3 |

批处理有收益，但仅三个样本不能证明持续吞吐或 batch=8 优于 16，也不能证明当前支持 100 QPS。HanLP 累计重启 21 次，报告没有退出原因/事件，不能认定 OOM。K8s Metrics API 不可用，所以缺少实际 CPU、内存、节流和峰值信息。

两个 retrieval Worker 都在同一个节点。每个进程一次处理一条记录，一条记录内部最多 16 个切片一批；没有跨 Worker 的多记录 Embedding 合批。多数短记录只有一个切片，外部模型延迟/RPM 可能比 HanLP 更早限制吞吐。仅调高 UI 集群并发上限到 16 不会把现有两个进程变成 16 个处理槽。

用抽样的 1,143,629 条记录、两个 Worker，忽略限流/排队/失败的理想敏感性计算：

| 每条记录端到端平均耗时（假设） | 总处理时间 |
|---|---:|
| 50 ms | 7.9 小时 |
| 200 ms | 31.8 小时 |
| 500 ms | 79.4 小时 |
| 1 秒 | 158.8 小时 |

这不是 ETA；模型尚未测试，不能据此承诺一晚完成。全文重建也不能直接套用这个表，它有不同的批处理、数据库和 ES 写入路径。初次先保留 Worker 并发 2；拿到端到端吞吐、模型限额和 HanLP 运行指标后再决定扩容/跨记录合批。保持严格 HanLP，不因压力改用其他分词器。

## Sequence 路由与模型不支持时的行为

| 环节 | 使用服务 |
|---|---|
| 全文分词索引 | HanLP，不使用 Chat/Embedding Sequence |
| 后台历史/增量向量化 | Embedding 业务默认 Sequence |
| 向量检索中的查询向量 | 同一 Embedding 向量空间 |
| Agent 意图分流、改写、生成回答 | 该功能显式指定的 Chat Sequence，未指定时使用 Chat 业务默认 |

Embedding Provider 可以显式复用 Chat Provider 的连接、凭证和兼容代理配置，但必须另选 Embedding 模型及维度，不继承 Chat 模型。Sequence 自身的网络策略参与实际路由。保存在目录中不代表加入请求顺序，也不代表已经设为业务默认。

模型不可用的处理分为：

1. 已知不支持的连接/协议在配置阶段不可用；未知兼容网关需要实际 Embedding 连接验证，Chat 测试通过不能证明 `/embeddings` 可用。
2. 没有可用 Embedding 默认 Sequence 或没有匹配的向量索引维度，启用/启动会被拒绝；Worker 保留队列，不改用 Chat 模型。
3. 运行中 HTTP 404、429、5xx、401/403 或网络故障可按选定顺序尝试下一 Provider；普通 400 等请求错误直接失败，不能承诺所有错误都依次降级。无效返回向量也不能写入。
4. Embedding fallback 必须保持同一模型和维度；维度相同但模型不同也不能混用向量空间。
5. 普通任务失败退避重试，达到 8 次进入需重试状态；未就绪、额度、暂停等暂时状态另行处理。已有数据保留；不会让 Agent 临时“猜”一个向量。

建议操作：在 LLM Provider 配置并验证 Embedding → 新建能力为 Embedding 的 LLM Sequence → 选择请求顺序和网络策略，验证并设为 Embedding 业务默认 → 确认部署向量维度一致且数据中心显示就绪 → 核验磁盘与重建状态 → 用户在数据中心手动启动。Agent Market 的 Dry Run 不是其中的前置步骤。

核对实现：`server/agent/runtime.mjs`、`server/agent/providers.mjs`、`server/agent/embedding-capabilities.mjs`、`server/retrieval/control.mjs`、`server/retrieval/worker.mjs`、`server/embedding/pipeline.mjs` 和 `mx-common/deploy/hanlp/server.py`。
