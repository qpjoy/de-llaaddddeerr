# ADR-0005: PostgreSQL 权威数据与可重建搜索投影

状态：accepted。

## 决策

- Hub PostgreSQL + PostGIS 保存规范身份、记录版本、观测、数据发布、checkpoint、权限和账本。
- S3 兼容对象存储保存不可变 raw、文件、Parquet、导出和备份。
- Elasticsearch 保存通过 outbox 生成的全文/聚合/geo 搜索投影；删除整个索引后必须能重建。
- Redis/Valkey 只做租约、限流、队列和短缓存。
- 不让 Elasticsearch `_id`、Redis key、文件名或“平台 + 用户 + 时间”成为唯一去重真相。
- 第一阶段不引入 ClickHouse；只有真实负载证明 PG 分区、只读副本、物化视图和聚合表不足时才增加。

## 原因

客户授权、账本、增量游标和版本发布需要事务、一致唯一约束和可恢复历史。Elasticsearch 擅长全文、facet 和 geo relevance，但 mapping、reindex、plugin 升级和集群恢复不适合承载交易真相。对象存储解决大 raw/file 的不可变留存，避免把 PG 变成无限 blob 仓库。

## 后果

- ingest 只能写 PG + outbox，projector 异步写 ES；禁止应用双写。
- API 在 ES 故障时仍能提供 PG 精确读取和已物化数据，并明确全文降级。
- ES snapshot 是加速恢复手段，不替代 PG PITR 或 raw object backup。
- 需要建立 dataset/schema version、reindex、DLQ、回放和跨存储校验工具。

详见 [数据平台存储、检索与服务架构](../architecture/data-platform-storage-and-serving.md)。
