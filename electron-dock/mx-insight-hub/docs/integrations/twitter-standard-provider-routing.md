# Twitter 标准搜索的供应商兼容

2026-10-18：Hub 在现有 `/api/v1/data/search`、`/api/v2/data/search` 内接入 TikHub 的 Twitter timeline。下游继续使用原 API、Twitter 平台授权、幂等键及分页方式，不需要申请 `social` 或 `native.*` 权限。MX-H2I 登录、SSO 和联网链路没有改动。

## 供应商选择与历史兼容

`MX_INSIGHT_TWITTER_SEARCH_PROVIDER=auto` 是默认部署策略：新搜索在采购前按调用方的供应商凭据和操作发布策略优先选可用 TikHub，TikHub 未就绪时使用原有可用 RapidAPI。也可以设置 `tikhub` 或 `rapidapi` 固定新搜索的供应商。当前操作权限、预算、并发及平台授权仍由各供应商原网关在实际派发前检查；收到拒绝、超时或 unknown 后不自动换供应商重发。

- 已保存请求优先按原供应商重放，包括原200、原失败以及原有 fresh/stable 语义。
- 新 TikHub 请求在预订时就保存供应商标记，不能因为派发前失败而转去另一供应商。
- 签名游标固定供应商、查询、页大小、调用方及前一页；配置切回 RapidAPI 后，已有 TikHub 游标仍沿 TikHub 继续。旧 RapidAPI 游标继续由旧实现处理，旧 `mxnc1` 保留原重放/显式重启边界。
- 标准搜索外的 raw/social/账号接口保持原有路由；Facebook、Instagram 等平台的策略不变。
- 同一调用方、已知查询的未决结果跨供应商、跨版本继续保护，复用已有 Boolean 编译器识别 SQL式和其等价 native 式。缺少查询的历史记录不会变成整个平台禁用。原 key 自身仍受幂等和 unknown 约束。
- 滚动升级期间两种供应商共用标准 Twitter 父派发租约，并在持有租约后检查未决结果，防止同一请求重复采购。

## 数据和分页

TikHub 使用固定 `t.twitter_web_fetch_search_timeline`，传 `keyword`、`search_type=Top` 和下一页的原生 `cursor`。Hub 复用既有等价 Boolean 编译器，保留客户原查询和指纹，不删除条件、不自动缩短检索式。接口未声明 count，Hub 不添加这个参数。

映射以供应商 `tweet_id` 字符串为真实身份，保留 `text`、发布时间、作者和照片/视频。缺失指标保持 null，真实0保持0；无关新增元数据不导致可用帖文被拒。整页存档及去重后按客户 pageSize 交付，所有超额帖子保存在缓冲，后续页先消费缓冲再采购；同页重试重放原回执。原生短页或空页带有效游标时继续分页；重复游标停止继续采购并返回明确提示。

v1 请求不添加新的日期限制。v2 沿用原精确半开时间窗交付过滤及覆盖限制提示；过滤后空页仍保留有效游标。第一页成功、19条结果或 `hasMore=false` 都不能单独证明完整历史窗口覆盖。

## 本次线上证据与验证

已购原生请求 `dcc086fa-469a-4237-a435-e427b7e70f3a`、唯一调用 `6c6177d6-4065-499c-aabb-50217f355780` 为 HTTP200/business200/succeeded。原280字符SQL式的等价257字符 native 式被 TikHub 接受。v3归档结构检查覆盖全部19项且未截断；本轮离线测试使用相同字段结构的合成数据，不冒充原始帖子字节。

部署 Hub 新镜像后，在 Hub 源码目录执行：

```bash
bash server/ops/inspect-twitter-tikhub-saved.sh
```

该命令只读上面的已购回执，不采购、不操作 Delta、不改历史结果；v4实际调用部署镜像的标准映射、canonical转换及PostgreSQL安全校验。应看到 `adapterCalls=0`、19条映射和有效游标。旧镜像缺少新映射时明确返回 `needs_deploy`，不再发送供应商请求。

部署使用现有入口：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh ops internal-production deploy
```

无需 Delta/罗盘/Java 升级或额外数据库迁移。标准链路验收使用一个正常的新搜索及其返回游标，沿用同一查询/窗口/页大小，同页重试保持同 key、下一页用新 key；检查实际结果、采购条数、归档与回放。小量真实采购已获用户授权，但本地不能连接线上集群，本轮不把合成测试宣称为线上冷启动已恢复。

原请求 `b5906846-8564-4791-8b83-ef3ce97789bc` 的400/502回执不可改写为成功。对该旧 key 的重试仍返回原结果；旧失败任务若坚持复用该 key，需通过原业务提供的新搜索/重建入口形成新任务。Hub 不自动清空 unknown，也不把独立诊断页灌入旧冷启动任务。

## 本地验证记录

447项相关回归通过，无跳过，包含本地HTTP接口、真实PGlite的跨供应商租约/unknown校验、标准v1/v2、原raw/social和聚合计费、分页缓冲、映射、手动重试与只读诊断。独立复核已完成。额外检查发现旧 `content-search-aggregate.test.mjs:35` 的Weibo能力预期在本轮之前的HEAD也失败，已独立快照复现，未改动该平台行为。线上标准交付及旧任务恢复不包含在离线通过结论内。
