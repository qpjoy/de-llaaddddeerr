# ADR-0006: 来源身份、幂等接入与独立 checkpoint

状态：accepted。

## 决策

- 每个 connector/stream/partition 维护 Hub 自己的 durable checkpoint；不复用 Night-All 客户分页 cursor。
- 来源有稳定 external ID 时使用版本化 natural key；无 ID 时使用版本化 identity-hash 规则。
- canonical record、revision 和 observation 分表，既避免重复对象，也保留重复抓取产生的新观测。
- keyset watermark 必须有稳定 tie-breaker、索引和不会迟提交到已推进水位之后的
  来源契约。若来源不能证明提交顺序，connector 必须实现经验证的 overlap-window
  或 CDC commit position；重复读取依靠 PG upsert/唯一约束安全重放。当前
  PostgreSQL puller 没有通用 overlap-window，因此不满足条件的来源保持 paused。
- source object、canonical、revision、outbox、import batch/counter 在同一个
  PG 事务中提交；事务先锁定 active run、检查稳定 batch key 是否已经落盘，
  再写 canonical。checkpoint 只在该事务成功后 ack。数据库 pull 在入库前把
  active `importRunId` 持久化进 checkpoint，并用稳定 `run_key` 恢复同一逻辑
  run。若进程在 canonical COMMIT 后、cursor ack 前崩溃，重试沿用同一
  run/batch key，既不跳过数据，也不重复累计计数或拆散 lineage。
- run 进入终态与 durable cursor 的最终状态/位置在同一个 PG 事务中提交。
  若网络在 COMMIT 后断开，返回 `external_commit_outcome_unknown` 或
  `external_finalize_outcome_unknown`；这不是失败证据。worker/运维必须重试
  **同一 run、同一 batch/操作**，让已落盘 batch 或终态决定结果，不能另开
  run、推进/回退 cursor 或先 reset。
- 每个 batch 保存源页 fingerprint。正常恢复会在重新连接源库前先查已提交
  batch，并直接采用其 `cursor_end`；若较低层重放同时提供了不同 fingerprint，
  `pageDrifted` 是来源页发生漂移的事故证据，已提交 batch 仍是权威，不能把
  新页面盲写成同一 batch。
- source、`provider:<providerKey>` 都使用排序后的 PostgreSQL session advisory
  try-lock。pull/reset、连接/映射切换、Provider 测试/敏感变更等拓扑操作不会
  交叉；争用立即返回 `409 source_busy`，不在长查询后面无界等待。暂停只阻止
  新批次；已在运行的批次到 checkpoint 边界收尾，在此期间返回
  `409 source_draining`（Provider 敏感变更为 `provider_pause_required`）。
- 删除必须来自明确 tombstone 或完整 snapshot contract；“本轮未返回”不自动视为删除。

## 拒绝方案

- **仅用 ES `_id` 去重：** 无法原子推进 checkpoint、保存血缘和处理 ES/PG 部分失败。
- **仅用时间最大值：** 同时间戳、迟到事务、时钟回拨会漏数据。
- **平台 + 用户 + 时间：** 不是普遍唯一键，且来源精度/时区会漂移。
- **覆盖 current row 不留 revision：** 无法复现历史 Dashboard、解释纠错或重跑 parser。

详见 [数据接入、增量游标、缓存与稳定性](../architecture/ingestion-cache-and-fallback.md)。
