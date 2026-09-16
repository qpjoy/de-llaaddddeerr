# 历史初始化独立预算与容量检查

2026-09-16。本次代码已完成本地验证，尚未部署新初始化逻辑；未启动任何线上重建或模型任务。

## 初始化语义

- `retrieval.settings.daily_token_budget` 始终是正常增量日额度，范围 1,000–10 亿。
- 新任务 `retrieval.runs.token_budget` 是本次初始化累计额度，默认 10 亿，0 为不限额。额度耗尽可在原任务修改，已累计使用量保留。
- `retrieval.run_items` 捕获当前可检索记录 ID、current_revision、projection_revision；不复制正文。单条 INSERT SELECT 获得一致 MVCC 范围，不锁 canonical 行。该显式维护步骤有一次扫描和清单写入成本，statement_timeout 60 秒；超时事务回滚。
- UUID 是随机值，仅保存最大 UUID 不能实现时间水位。固定清单不会纳入后续新增的任意 UUID，也不会因持续写入无限延长。
- outbox 的后续版本使旧清单项标为 superseded；新版本使用增量预算。批量入队还会检查当前版本，覆盖清单插入期间的并发可见性窗口。pending 项只由成功处理或明确版本替代结算。
- 预算预留依据实际待嵌入切片的 source_revision、队列领取版本和清单版本，不只依据记录 ID。新版本不能使用无限初始化额度。已经在途的旧请求可能仍产生费用。
- 完成和取消不修改每日额度。取消仍暂停全局队列；重新启用增量不会自动复活已经取消的历史范围。
- 迁移仅建表/索引/触发器，不启动历史扫描。部署需等全部 retrieval Worker 更新后再启用新任务。旧任务保留旧规则，不在迁移中隐式转换。

## 只读检查脚本

独立脚本：[inspect-retrieval-capacity.sh](../../scripts/inspect-retrieval-capacity.sh)。可复制到服务器直接执行，无需部署新镜像。要求操作主机有 bash、kubectl、python3、tar；Pod 内使用已部署 Hub 的 Node 和模块。

```bash
bash /tmp/mx-hub-capacity-inspector-20260916-2330.sh --probe-hanlp
```

默认报告目录 `/tmp/mx-hub-capacity-日期时间/`，同时输出 `.tar.gz`。不加 `--probe-hanlp` 时不做分词请求；加上时只顺序发送 1/8/16 条约 230 字的合成文本，禁用分词 fallback。它不是并发压测、也不能证明 100 QPS。

报告包括：

- ES、PG 的容器挂载点 → PVC → PV → hostPath/local/nodeAffinity，以及容器内 df。Docker data-root 不等于数据库 PV 路径。
- 执行主机分区用量、K8s 节点、Pod 资源用量/限制、重启数、HanLP 安全环境参数。
- 实际 ES 版本、节点可用空间、Hub 各索引主副本大小、向量 mapping、磁盘水位及 max_headroom。
- PG canonical/chunk/queue/manifest 大小和 planner 行数估计；SYSTEM 0.5% 最多 2,000 行的文本样本，经当前 chunker 计算切片数与估算 token。只输出汇总，不输出正文。
- 模型维度未配置时明确返回 null，不猜供应商或模型。只读事务 SQL 上限 10 秒，不执行全表精确计数或全库切片。

脚本不读取 K8s Secret、不输出 Provider key、Admin Token 或数据库 URL；不部署、不删除、不发起 Embedding，不建立或重建索引。Pod 配置只输出允许的字段，错误检查继续收集其余证据。模块来源 `server/scripts/retrieval-capacity.mjs` 已内嵌在独立脚本中；更新模块后必须同步脚本的内嵌段。

## 70 GiB / 175 GiB 能否足够

23:16 的只读主机 df：`/data` 约 175 GiB 可用，`/home` 约 70 GiB，根分区约 111 GiB。**这些是不同文件系统，不能相加；当时尚无权限核验实际 PV 与模型配置。** 不能据此承诺今晚两个任务能完成。

当前实现 PG 保存 float32 `real[]`；ES 使用 float32 原始向量加 int8 HNSW。粗略的纯向量基数为 PG `4 × 维度 × 切片数`，ES `5 × 维度 × 切片数`；二者之外还要算文本、图结构、元数据、各类索引、PG WAL、ES merge、旧索引和副本。

按 191.7 万有效记录举例（并非实测切片数）：

| 维度 | 平均 1 片：PG + ES 纯向量 | 平均 3 片：PG + ES 纯向量 |
|---|---:|---:|
| 1024 | 约 16.5 GiB | 约 49.4 GiB |
| 1536 | 约 24.7 GiB | 约 74.0 GiB |
| 3072 | 约 49.4 GiB | 约 148.1 GiB |

表格是基数，**不能当成总占用估计或容量通过结果**。PG 与 ES 若在不同盘，要分别核算。现有同版本向量可复用，样本推算不自动扣除复用。超长文本样本会有裁剪标记，出现裁剪时估计偏低。

严格 ES 重建会保留在线旧索引并写入另一代；不能只按新向量新增占用判断。即使数据本体少于 70 GiB，剩余空间也必须高于实际水位，并容纳写入/合并峰值。如果实际 flood-stage 保留 100 GiB，175 GiB 的空闲再写入 70 GiB 就只剩约 5 GiB 的水位余量，不能作为稳妥的执行窗口；以报告中的实际 settings 为准。

依据：[Elastic dense_vector 存储说明](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/dense-vector)、[磁盘水位与 headroom](https://www.elastic.co/docs/reference/elasticsearch/configuration-reference/cluster-level-shard-allocation-routing-settings)。

## HanLP 的实际工作方式与潜在瓶颈

仓库当前部署模板：1 个 HanLP 副本，`MAX_CONCURRENT_INFERENCES=1`，Torch/OMP/MKL 为 16 线程，资源上限 16 CPU / 8 GiB。需要报告确认线上是否一致。

客户端将同一轮并发的文本组成字符串数组，Python `_tokenizer(inputs)` 返回与数组等长的分词结果；没有把不同记录连接为一篇正文。一次模型调用内部仍可能划分多个 mini-batch。“单推理槽”不等于只用一个 CPU 核。

当前两个向量 Worker 各处理一条记录；一个 record 的 chunk 最多 16 个一批进入 Embedding/HanLP。单片短文本很多时，实际批大小可能只有 1；两 Worker 无跨进程合批，此时 HTTP 往返和模型供应商 RPM 可能先成为瓶颈。全文重建、增量 projector 和检索分词也共享 HanLP。

建议先看 1/8/16 的分词耗时、HanLP CPU/内存和 429，再结合向量任务端到端处理速度定位。不要直接把同一 Python 模型的并发槽调到 128；优先评估批大小、任务调度及独立模型副本。跨记录 Embedding 合批是后续优化，需要按向量空间和预算归属分组并保持逐条版本/结果映射，不能直接拼接正文。

## 验证

- 服务端回归：1,825 通过，15 按环境跳过；隔离 PGlite 覆盖固定范围、UUID 插入、更新/删除转增量、独立预算、0 不限额、额度耗尽、暂停/取消/租约失效、终态与每日额度保持。
- 类型检查与生产构建通过。浏览器本地 SQL 预览验证保存每日设置、0 额度确认、固定范围总量、运行中改额度及取消后暂停；没有生产模型调用。
- 检查脚本通过 bash/内嵌 Node 语法及模拟 kubectl 流程验证，确认非允许环境变量不会写入报告。线上空间与吞吐结论仍等待真实报告；PGlite 不能替代多连接并发和故障恢复压测。
