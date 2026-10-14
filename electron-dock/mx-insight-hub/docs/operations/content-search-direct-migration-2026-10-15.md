# Facebook 补页与四平台关键词搜索直连

更新：2026-10-15。本文描述本地实现与隔离验收；未部署生产、未调用真实供应商。历史字段核查见 [策略搜索核查](strategy-search-contract-audit-2026-10-15.md)。

## 范围

- Facebook 标准 `/api/v1/data/search`：借鉴 Twitter 的归档余量优先、交付 ID 去重与有界补页；每个 Hub 请求最多 **3 次实际派发**，包含首次明确 429 后的保底请求。原 raw 单页合同保持。
- Bilibili、抖音、快手、知乎关键词搜索：标准入口与两个 raw 别名均由 Hub 执行固定 TikHub 端点，借鉴 Night-All 的参数、字段及分页状态，不依赖 Night-All 运行时、不自动回退。
- Bilibili 指标修复已移入 Hub：like/stat.like、review/stat.reply、favorites/stat.favorite、play/stat.view。现代指标缺失为 null，真实 0 保留；兼容 raw 保留原数值默认。硬币、弹幕不当作分享或评论。
- 账号内容、账号资料、任意端点选择和详情／评论附采不在本轮关键词迁移内；显式附采参数在采购前拒绝。已有可精确重放的请求先按原响应重放，不因新参数限制重写。

## 固定端点与默认参数

| 平台 | Hub 原生操作 | 保留的 Night-All 默认 |
| --- | --- | --- |
| Bilibili | `native.t.bilibili_web_fetch_general_search` | general_search；order=pubdate，页码与 page_size，duration=0，时间范围默认 0 |
| 抖音 | `native.t.douyin_search_fetch_video_search_v1` | 保留显式默认 V1，sort_type=2；cursor/search_id/backtrace 复合状态 |
| 快手 | `native.t.kuaishou_app_search_comprehensive` | newest/all/all；pcursor |
| 知乎 | `native.t.zhihu_web_fetch_article_search_v3` | created_time；offset/limit/search_hash_id |

不因候选端点排名改变显式默认。不接受调用方传入 provider/endpoint/凭据；params 仅接受对应固定端点的已声明字段，分页应传回 Hub 游标。没有迁移 SQL 自动开操作、加 Key scope 或更改价格；现有操作暂停、凭据缺失、采购门禁仍如实阻断。迁移 112 将原生操作初始设为 disabled，尚未审核启用的四项需在供应商管理中审核采购价并明确启用；发布代码不会绕过该状态。

聚合搜索默认实时路径及 `execution=hub_only` 均可发现这四个平台的固定关键词路由；预览只读原操作状态和凭据元数据，按原平台客户价格估算，不发起采集、不新增 native capability 授权。

## 分页、证据与结算

标准逻辑页先读取上次剩余的完整归档，再采购后续页；每请求最多 3 次实际上游调用，最多 15 个上游页和 15 个公开页，游标有效 24 小时。页大小为上限；自然耗尽允许短页，预算／准入停止返回已有内容、partial 与警告。下游只处理返回的 Hub nextCursor，无需合并供应商分页或自行取余量。

完整上游响应在派发下一次前留存精确字节、哈希、长度、原租户／消费者／Key／请求来源和采购凭据，并提交原入库队列一次。已付费但未交付的内容不会截断丢弃。服务端已交付记录限制去重窗口；游标仅携带小型归档／前序交付引用，绑定平台、查询、条件、页大小、type 和 Key。字节损坏、归属错误、过期或循环均拒绝，不能通过重新采购掩盖。

一次客户请求沿用现有报价、额度与一次结算；每次真实供应商派发各自检查操作、采购费用、速率、期限并单独记录。Facebook 自动选路保留原月额度和首次明确 429 保底规则，取得第一页／持有分页状态后固定供应商。未知派发或原子交付写入不确定时保留锁与客户资金，阻止相同意图换幂等键重新采购，等待只读核对和既有恢复流程。

## 兼容与发布

标准 `items/pageInfo`、兼容 `raw_info/raw_data` JSON 字符串、两个 raw 别名、既有平台授权和客户计量保留。原生视频／文章标题保留，正文不按显示长度截断；媒体按完整 URL 精确去重，不剥离签名或猜测视频封面。知乎搜索只返回摘要时如实标记 partial，不能把摘要声称为已补正文。

已保存响应优先精确重放，包括旧零值、空结果和失败。旧 Night-All 游标只能用于核对原归档重放；新派发需显式从第一页重启，不将其 token 交给 Hub 原生端点。新分页不跨供应商或路径。MX-H2I／Launcher 的登录与网络配置没有修改。

服务器仓库同步完整 Hub 源码后，由操作人员按原流程仅发布 Hub：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 bash scripts/manage.sh ops internal-production deploy
```

先只读确认固定操作状态、凭据及现有授权，不为验收追加付费搜索。四平台的新 Hub 关键词路径不再需要 Night-All 同步发布；仍直接使用 Night-All 的旧客户端可独立发布前述 Bilibili 修复。
## 本地验收

相关整合回归 522 项：518 通过、0 失败、4 项既有真实 PostgreSQL 条件测试跳过。实际运行的隔离 PGlite 使用生产账单触发器，验证两家 Facebook 来源、四平台来源、归档归属／哈希／长度、完整余量、跨页去重、一次客户结算、事务失败回滚及 COMMIT 回执丢失。真实 PostgreSQL 订阅额度和并发恢复测试仍须按原独立测试库流程运行，不用 PGlite 结果替代这些环境验收。

模拟适配器和本地 HTTP 验证四平台固定端点、两个 raw 别名、旧 200/502 与 mxnc1 的精确重放、旧游标新采集明确重启、最多 3 次标准派发、50 个 raw 子任务边界、原操作和 Key 授权、采购／未知状态保护、聚合仅 Hub 执行及只读预览。Bilibili 原生指标、缺失与真实零、原生标题和完整混合媒体／正文投影，以及 canonical 入库字段也在回归中。

动态／静态 OpenAPI 与 scope 过滤指南镜像检查、typecheck、Vite build、差异格式检查均通过。构建仅有既有的大 chunk 提示。验证没有发起真实搜索、读取生产数据库或发布，不能据此宣称四个平台线上已恢复。
