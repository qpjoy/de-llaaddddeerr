# ADR-0004：独立 `mx_test` 库，复用 mx-common 迁移器

状态：已接受（2026-08-12）

## 背景

MXT 需要持久化。同一 PostgreSQL 实例上已有 `mx-insight-hub` 的库，
`mx-launcher/server` 也有自己的存储。

## 决策

- MXT 使用**独立数据库 `mx_test`**，不与 insight-hub 或 launcher 共库、共表。
- 迁移复用 `@qpjoy/mx-common` 的 `runMigrations`（advisory lock + `schema_migrations`
  + checksum 不可变校验），连接池复用 `createPool`。
- 迁移文件位于 `migrations/NNN_*.sql`，与 insight-hub 的命名一致。
- 表名统一 `mxt_` 前缀。即使独立库，前缀也让跨库排查日志时不会认错表。

## 理由

**测试数据的写入模式与业务数据完全不同。** 每次 run 写入几十到几百行
`mxt_run_cases` + `mxt_steps`，旧记录随保留策略批量删除。这种高频写入 + 周期性
大批量删除的模式会产生大量 dead tuple 和 vacuum 压力。放在 insight-hub 的库里，
它的查询性能会被 QA 的写入节奏影响——而两者之间没有任何业务关联。

**生命周期不同。** 测试记录有明确的保留期（30/180 天），业务数据没有。
共库意味着清理任务要在别人的库里跑 DELETE。

**故障隔离。** MXT 的迁移出错、连接池打满、慢查询，都不应该影响 insight-hub
的数据服务或 launcher 的控制面。独立库是最便宜的隔离手段。

**这与 insight-hub 的 ADR-0003（independent transactional store）是同一条推理**，
只是换了个应用。同级应用之间共享的是**代码**（`@qpjoy/mx-common`），不是**存储**。

## 后果

- 需要在部署时创建 `mx_test` 库并配 `MXT_DATABASE_URL`。
- 跨库关联（例如"这次执行对应哪个版本"）只能靠 ID 引用，不能 JOIN。
  这是可接受的——`mxt_runs.source_ref` 存 `{gitSha, version}` 字符串即可。
- 共用实例仍有资源竞争（CPU、IO、连接数）。如果将来成为问题，独立库的好处是
  可以直接迁到独立实例，不需要拆表。

## 被否决的方案

- **共用 insight-hub 库加 schema 隔离**：schema 隔离挡不住 vacuum 压力、
  连接池竞争和迁移故障传播。
- **写进 launcher 的 PlatformStore JSONB**：JSONB 兼容记录适合少量平台对象，
  撑不住 run/case/step 的量级与查询模式（趋势查询需要真正的索引）。
- **不落库，只存文件**：放弃历史、趋势与 flaky 检测——这正是要建平台的原因。
