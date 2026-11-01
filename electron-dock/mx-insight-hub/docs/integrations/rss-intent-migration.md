# RSS/新闻 intent 迁移：保留旧 RSS 覆盖

2026-11-01 用户决定：保留旧 RSS 订阅库覆盖并迁入 Hub，不以当前 Hub 新闻发现库存替代。
本轮状态：已修复旧检索链路的 query/日期传递；已提供并离线验证源库诊断。
RSS 数据迁移、Hub intent 入口、Delta 路由切换尚未完成，需要先取得下述源库证据。
未部署、未调用供应商或模型、未变更 MX-H2I 登录/联网。

## 已确认的代码问题

- Delta `/Users/qpjoy/workspace/mingxi/po-infra/llm/data_query.py` 的 `hub_data_query_route`
  对 `search_intent + rss/news` 返回空路由，仍由旧 HTTP Skill 执行。
- Night-All `search-intent-service.js` 原先优先使用 `intent`，可覆盖真实 `query`。
  现改为 query 优先；无 query 的既有调用仍兼容 intent 查询别名，businessId 不作为关键词。
- intent 曾复用事件概览的“通用问题清空关键词”分支；现在 intent 内部固定 preserveQuery，
  RSS/新闻收到原 query，不把检索静默变成首页浏览。普通事件概览保持原行为。
- `event-search-service.js::collectPlatform` 漏传 todayOnly，RSS/news 的默认行为会覆盖 false。
  现显式传递 true/false。mode、limit 与旧 rules/both 摘要行为保持；Hub 新链路计划只提供数据，摘要交给 Delta。

修复位于 Night-All 三个 search service，并新增 `tests/search-intent-query.test.js`。
新测试修复前复现3项失败；修复后新测试与既有 event-search 回归共8项通过。

## 必须保留的数据范围

旧 RSS 路径不等于当前 Hub 新闻发现：

| 来源 | 旧读取方式 | 迁移核对事项 |
| --- | --- | --- |
| `rss_canonical_items` | 时间窗内有行时优先 | 独立 UUID、rss_item_id、feed_key、原文/摘要、发布时间/收录时间、更新水位 |
| `rss_items` + `rss_feeds` | 规范库无对应窗口数据或不存在时回退 | 旧独有记录、订阅元数据、与规范库对应关系，不能只迁规范库 |
| `event_source_items` | news/hot 的数据库来源 | source_type 与业务来源隔离；不能把 Agent 产物重新当公开新闻 |
| RSS fetcher、本地 news-results JSON | 数据库不满足条件时的文件来源 | 需运行时核对文件与数据库覆盖；不能以数据库计数证明完整覆盖 |

这些是本地源码与 migration 声明，不是生产表结构或生产存量证据。
旧 RSS 查询先取受限窗口再内存过滤 query，可能漏掉窗口外的匹配项；Hub 应在过滤实际 query 后分页，
而不是迁移这一限制。不得通过放大源库扫描或清空关键词伪造检索成功。

## 只读生产核对

把本次新增脚本同步到服务器，在 mx-insight-hub 目录执行；无需发布镜像、迁移或重启：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - \
  < server/ops/diagnose-rss-intent-migration.mjs
```

脚本读取 Admin 已有 DATABASE_URL，查 Hub 当前登记的 `telegram-monitor-messages` 源连接，
复用其数据库配置只读检查四张固定 RSS/事件表。该登记源只是 Night-All 源库候选；表不存在时
返回 absent/incomplete，不能推断另一台服务器也没有数据，不尝试猜密码、端口或扫描其他主机。
如现场确认应使用已登记 chats 连接，可把 node 参数改为 `node --input-type=module - telegram-monitor-chats`。

输出包括连接是否已登记、表列类型、主键/索引定义、行数、旧 RSS 未被规范库覆盖的数量、
规范 RSS 无旧 ID 的数量、事件来源类别。不输出密码、DSN、文章正文或源 URL。
所有连接和事务只读；10秒语句超时、1秒锁超时；超时保留为 unavailable，不当作0。
`database_observed` 只表示数据库检查完整，不代表文件源完整、数据已迁移或链路可用。
脚本4项测试通过，包含真实 PGlite SQL、缺表、凭据不输出和只读连接约束。

## 核对后实施边界

1. 按实际源库身份和 schema 复用 Hub 管理的数据源连接；明确 RSS 规范/旧记录去重身份、更新及删除策略。
   通过现有清洗/入库流水线保存原始证据、规范记录及检索索引；不凭源 updated_at 自动宣称无丢失增量。
2. Hub 公开检索限定当前 Key 已授权 RSS/新闻范围，实际 query 必填；businessId 仅作业务归因，不能授予数据权限。
   RSS 与 news 来源选择保持可辨；缺少迁移来源不能静默变成已授权的全部新闻。
3. todayOnly=true 按 Asia/Shanghai 当天过滤；false 不附加当天限制。
   日期窗口需在首次请求/检查点冻结，跨天重试与续页不得改变原窗口。返回所用时间字段及范围。
4. 支持 mode=fast、limit 默认20和明确的有界分页，rules/both 摘要请求由 Delta 消费原始证据后生成；
   Hub 不隐式调用模型。单一社交平台既有 raw 路由保持，未支持的混合源明确报错而非回退 Night-All。
5. 新接口、文档、授权/计量和数据可用性验证完成后再切 Delta 代码路由；保留原请求/游标检查点，
   不能仅改旧 agent_sources 文件或以新幂等键绕过未决请求。
