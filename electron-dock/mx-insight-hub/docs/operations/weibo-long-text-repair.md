# 微博全文修复与 LCY-delta 权限迁移

后续增量：微博 raw 搜索与全文补取已在 Hub 实现，见[Hub raw 搜索的平台迁移](hub-raw-search-routing.md)。下文记录 migration 131 的原始单条修复范围；131 不修改，新增保护由 migration 132 执行。

用户明确要求在下一次服务器 deploy 的 migrate 阶段完成。新增 `migrations/131_weibo_long_text_and_lcy_grants.sql`，由现有 `scripts/manage.sh deploy` 的 migrate-before-rollout 流程执行；不需要 SSH 配合、手工回写或再次付费。本文不代表生产已经部署。

## 问题与验证证据

- canonical ID：`34c72b79-f291-4ef7-ad9b-fe62eb03912d`，数据集 `night-all.search.v1`，平台 `weibo`，微博 ID `5351726865449966`，作者 ID `2471317784`。
- 原记录为 150 字符搜索摘要，结尾 `强调 ​展开c`，title 与 body 相同；来源标记 `weibo_web_v2_fetch_realtime_search`。
- Night-All 的微博适配器使用实时搜索；`lib/domains/search/paged-content-search-service.js` 明确传入 `disableAutoDetails: true` / `includeDetails: false`。搜索摘要没有补取详情，清洗和 Hub 入库又保留了“展开c”。删掉尾标不能还原正文。
- 经用户明确授权，使用 Night-All 现有 TikHub 凭据直连 **一次** `GET /api/v1/weibo/web_v2/fetch_post_detail?id=5351726865449966&is_get_long_text=true`；不经过 LCY-delta 的 Hub 用量账本。
- 返回 HTTP 200 / code 200；供应商 request ID `3b57afa7-2664-4dc7-9e4e-b8b5eb9c86be`；完成时间 `2026-10-08T05:56:31.007Z`。
- `data.isLongText=true`，`data.longText.content` 与 `data.text_raw` 一致，去掉末尾空白后为 **411 个 Unicode 字符**；ID、作者和原摘要前缀均一致。
- 原始响应 19,417 字节，SHA-256 `b05ecd61c51bb3e51a1fa464e0ffd78e41c10c0b47363a5b07806bee003444dc`。确切响应以 Base64 嵌入 migration，迁移时重新校验；无供应商凭据。服务器不需要访问本机 `/tmp` 文件或供应商接口。

此前 Twitter/Facebook 的 title 修复也在 Hub data-search/兼容入库体系中，但处理的是平台无标题语义，不会补回微博搜索接口未提供的正文。这次保留微博现有标题规则，仅将与旧 body 完全重复的 title 同步替换成全文；独立标题不变。

## Migration 131 的行为

迁移在同一 PostgreSQL 事务内完成：

1. 安装仅针对该 canonical ID 和本次已验证响应摘要的数据库保护。同正文的“展开c/展开全文”搜索摘要不再覆盖全文；旧 worker 的 upsert 也返回原 canonical 修订，原 revision/outbox 去重机制继续生效。新原始摘要与观察仍入库。其他记录、完整的新正文、不同前缀的编辑正文和删除事件不受影响。
2. 锁定原记录，核对数据集、微博 ID、作者、未删除状态、当前修订和摘要前缀。用已保存全文修复 body 和重复 title，其他 canonical 字段保持原值。
3. 新增手动修复 ingest run、完整响应字节、解析响应、变更前 canonical 快照、新修订、观察和 outbox 事件。保留旧修订、原搜索证据、用量、账单与不可变响应快照；原幂等键继续返回原响应。
4. 定位原 LCY-delta Live Key（租户 `277bf8a4-5ed5-414d-b429-d72fcd7d36b6`、调用者 `be7d07fe-3d98-4db3-b00d-e5cbe5a76190`、Key UUID 前缀 `fd2f8cc9`），追加 `social` 和下表两个 native capability。使用原微博限额作为新增项的保守基准，已有策略/Key 限额不覆盖；写入 Key scope 审计。其他 Key、密钥、有效期、价格和钱包均不修改。

没有目标记录/调用者的其他环境会跳过相应数据操作，不创建替代对象。目标身份、正文、修订或 Key 状态不一致会明确失败并整批回滚；存在会继承新增权限的 sibling dynamic Key 也会停止。正常重复 deploy 由 `schema_migrations` 跳过；直接重复执行 SQL 也不会增加修订、重复证据或重复 Key scope 事件。

## Hub 已有直接转发接口

| 操作 | Hub 路径 | 新增 capability |
| --- | --- | --- |
| 微博搜索 | `POST /api/v1/data/native/t.weibo_web_v2_fetch_realtime_search` | `native.t.weibo_web_v2_fetch_realtime_search` |
| 微博详情 | `POST /api/v1/data/native/t.api_4f35621a9c07e539` | `native.t.api_4f35621a9c07e539` |

二者直接经 Hub TikHub adapter 转发，不经过 Night-All；授权数据域是 `social`。原来的 `weibo` 搜索授权不能替代 native capability。已从线上管理台只读确认这两个操作生效正常；migration 不改变采购价格、预算或操作开关。

详情请求体：

```json
{"params":{"id":"5351726865449966","is_get_long_text":"true"}}
```

冻结契约中参数类型是 string，默认也是 `"true"`；实时搜索不支持该参数。Native 调用保留上游响应，当前不自动补发付费详情或覆盖 canonical。历史微博搜索/兼容路由本次不做整体切换，后续可按平台逐步迁移。

## 部署后核验

正常 deploy 即可。日志应出现 `applied 131_weibo_long_text_and_lcy_grants.sql`，并有正文修复、Key 补授权通知。数据库可只读检查：

```sql
SELECT char_length(body), current_revision, projection_revision,
       extensions #>> '{weiboLongTextRepair,requestId}' AS provider_request_id
FROM core.canonical_records
WHERE id='34c72b79-f291-4ef7-ad9b-fe62eb03912d';

SELECT event_type, projection_revision, status, last_error
FROM outbox.projection_events
WHERE aggregate_id='34c72b79-f291-4ef7-ad9b-fe62eb03912d'
ORDER BY projection_revision DESC;

SELECT k.name, e.capability, e.max_requests, e.window_seconds
FROM api_keys k JOIN api_key_capability_entitlements e ON e.api_key_id=k.id
WHERE k.consumer_id='be7d07fe-3d98-4db3-b00d-e5cbe5a76190'
  AND k.id::text LIKE 'fd2f8cc9-%'
  AND e.capability IN ('native.t.weibo_web_v2_fetch_realtime_search','native.t.api_4f35621a9c07e539');
```

正文预期 411 字符；原 revision 1 的记录变成 revision 2，全文索引由既有 projector 消费 outbox 后更新。浏览器刷新 LCY-delta 调用身份即可看到新增接口。本次不再发送真实请求作验证，以保持仅一次付费调用。

测试在独立 PGlite（PostgreSQL WASM）实例实际执行 migration、约束、trigger 和 Hub 原入库方法，验证回滚、重放、精确字节、旧修订、其他 Key/限额保持及旧 worker 摘要保护；不连接生产数据库。测试入口 `tests/server/weibo-long-text-migration.test.mjs`，用 `MX_INSIGHT_TEST_PGLITE_MODULE` 指定本地 PGlite 模块。

本次仅新增 Hub migration、测试和说明，不改 Launcher、MX-H2I 登录/联网、Night-All 配置或支付服务。
