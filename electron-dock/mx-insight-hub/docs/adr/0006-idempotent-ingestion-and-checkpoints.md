# ADR-0006: 来源身份、幂等接入与独立 checkpoint

状态：accepted。

## 决策

- 每个 connector/stream/partition 维护 Hub 自己的 durable checkpoint；不复用 Night-All 客户分页 cursor。
- 来源有稳定 external ID 时使用版本化 natural key；无 ID 时使用版本化 identity-hash 规则。
- canonical record、revision 和 observation 分表，既避免重复对象，也保留重复抓取产生的新观测。
- overlap-window + keyset watermark 接住迟到数据；重复窗口依靠 PG upsert/唯一约束安全重放。
- raw、canonical、outbox 和新 checkpoint 在同一个 PG 事务边界内登记；对象 raw 上传先完成，失败对象由生命周期清理。
- 删除必须来自明确 tombstone 或完整 snapshot contract；“本轮未返回”不自动视为删除。

## 拒绝方案

- **仅用 ES `_id` 去重：** 无法原子推进 checkpoint、保存血缘和处理 ES/PG 部分失败。
- **仅用时间最大值：** 同时间戳、迟到事务、时钟回拨会漏数据。
- **平台 + 用户 + 时间：** 不是普遍唯一键，且来源精度/时区会漂移。
- **覆盖 current row 不留 revision：** 无法复现历史 Dashboard、解释纠错或重跑 parser。

详见 [数据接入、增量游标、缓存与稳定性](../architecture/ingestion-cache-and-fallback.md)。
