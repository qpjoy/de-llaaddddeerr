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

用户随后返回 v4 实际归档映射：`mapped_saved_native_page`，19条全部成为标准项和 canonical 记录，身份、作者、正文和发布时间齐全，PostgreSQL投影安全；保留下一页游标。views有1条未知，其余指标真实0未被当成缺失。此项已在线只读验证通过，零新增采购；验证范围是 Admin 诊断容器的归档映射。

部署 Hub 新镜像后，在 Hub 源码目录执行：

```bash
bash server/ops/inspect-twitter-tikhub-saved.sh
```

该命令只读上面的已购回执，不采购、不操作 Delta、不改历史结果；v4实际调用部署镜像的标准映射、canonical转换及PostgreSQL安全校验。应看到 `adapterCalls=0`、19条映射和有效游标。旧镜像缺少新映射时明确返回 `needs_deploy`，不再发送供应商请求。

部署使用现有入口：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh ops internal-production deploy
```

无需 Delta/罗盘/Java 升级或额外数据库迁移。小量真实采购已获用户授权；标准链路验收入口已补齐，在有 kubectl 权限的宿主机同步下列两个同目录文件后执行：

```bash
bash server/ops/verify-twitter-standard.sh
```

入口读取同目录 `verify-twitter-standard.mjs`，以 stdin 在 **Public/api** 容器执行，不需要把诊断脚本重新打入镜像。使用已部署的 `createRuntime()` 和 `service.search()`，不启动第二个监听器或后台任务；检查的是 Public 镜像中的实际标准服务链路，不是公网 nginx/HTTP 认证入口。当前原调用方身份和授权仍在正常服务内检查，不读取/展示客户明文 Key，不新增权限或修改供应商策略。

- 保留原280字符完整查询，分别验证标准 v1/v2：首个小页、同 key 重放、原游标的下一页和再次重放。`pageSize=1`用于低采购量验收，不修改客户任务的20条页大小；全量供应商页仍由 Hub 保存并缓冲。
- v1没有新日期条件；v2明确使用固定诊断窗 `2026-09-18T00:00:00Z` 至 `2026-10-19T00:00:00Z`（Asia/Shanghai、半开区间），不声称重建旧请求丢失的时间窗。过滤后0条和有效游标可同时成立。
- 固定4个 `ops-twitter-standard-b5906846-*` key，`type=stable`。最多累计2条供应商调用记录，包含历史执行；不因重跑命令恢复额度。独占锁和实际派发前的预算检查仅作用于诊断进程，正常服务的客户额度与行为不变。已有缓冲页和重放可在额度用尽后继续读取；未知结果继续由原协议保护。
- 预期 `diagnosticRevision=twitter-standard-check.v1`、`standardDeliveryVerified=true`、`paginationVerified=true`、`originalUnchanged=true`。报告列出实际供应商及回执；页2的 `bufferedContinuationVerified=true`表示未新增供应商调用而完成缓冲续页。若源已耗尽，没有第二页则分页验收保持未确认。
- 这会按正常服务流程生成独立 usage/供应商回执和 Hub 入库队列任务，可能消耗供应商和客户额度；不写 Delta，不改原失败回执，不把诊断结果塞入旧冷启动。两次额度耗尽/拒绝/unknown时停止，保留结果供判断。

本地不能连接线上集群，标准服务验收仍需用户返回该命令结果；小页通过也不等于整月覆盖或旧 Delta 冷启动已经入库。

原请求 `b5906846-8564-4791-8b83-ef3ce97789bc` 的400/502回执不可改写为成功。对该旧 key 的重试仍返回原结果；旧失败任务若坚持复用该 key，需通过原业务提供的新搜索/重建入口形成新任务。Hub 不自动清空 unknown，也不把独立诊断页灌入旧冷启动任务。

## 本地验证记录

447项相关回归通过，无跳过，包含本地HTTP接口、真实PGlite的跨供应商租约/unknown校验、标准v1/v2、原raw/social和聚合计费、分页缓冲、映射、手动重试与只读诊断。独立复核已完成。额外检查发现旧 `content-search-aggregate.test.mjs:35` 的Weibo能力预期在本轮之前的HEAD也失败，已独立快照复现，未改动该平台行为。线上标准交付及旧任务恢复不包含在离线通过结论内。

本次62项相关测试通过、无跳过。新增验收脚本回归使用实际 HubService/路由/网关/适配器和合成供应商响应，覆盖双版本交付、缓冲和重放、跨执行预算、未知保护、空页、旧回执不变、JSONB对象键顺序、回执归属和固定命令入口，并用真实PGlite校验历史调用计数SQL。未增加生产服务限制，MX-H2I登录与联网代码无改动。
