# Night-All 搜索契约与 Facebook 标题修复

## 已复现的问题与改动

本次依据两个仓库源码与合成数据验证，不将截图的 HTTP 状态视为已确认的生产根因。

| 位置 | 缺陷 | 修复 |
| --- | --- | --- |
| Hub `server/data/night-all-pagination.mjs` | 仅 compound 模式保留静态筛选，composite 续页替换 params 时丢失排序等条件 | 两种复合模式都保留静态参数；旧 offset/search_id 等续页状态由新状态替换 |
| Night-All `raw-search-service.js` | wechat_mp 兼容搜索默认 TikHub，标准搜索 manifest 默认 JustOne，前者还可能命中已移除的旧端点 | 关键词 raw 搜索复用标准搜索 manifest 的平台默认选择；Facebook 仍为 RapidAPI，显式内部选择和其他操作不变 |
| Night-All `tikhub-endpoint-orchestrator.js` / `paged-content-search-service.js` | 提取与恢复复合续页时删除所有 cursor，丢失抖音原生 cursor，即使保留 search_id/backtrace 也不完整 | 端点声明的原生 cursor 与会话字段共存，标准搜索恢复完整 nextParams |
| Night-All `tikhub-param-mapper.js` | 通用顶层 cursor 可覆盖 nextParams 中准确的端点参数 | 结构化参数优先，顶层 cursor 仅补缺 |
| Night-All `paged-content-search-service.js` | hasMore=false 可能被残留游标推翻，造成多余付费续页 | 明确结束信号优先；已缓冲的合法结果仍可正常消费 |
| 两个仓库的内容标准化/入库 | Facebook 仍保留平台名加正文形成的 title | 扩展现有 Twitter 策略：raw 标题为空字符串，data-search/canonical 为 null |

Facebook 作者/账号名称、正文、ID、图片、指标保持；原始 payload 和已交付的历史快照不重写。
Hub 使用既有平台 hook；Facebook 再次正常入库时摘要包含解析器版本，确保旧标题获得修订和
索引事件。未启动历史回填、重建索引或重新采集。

## 两个公开接口的边界

- `/api/v1/night-all/search/raw`：页大小 `count`，返回 `data.page.nextCursor`。
- `/api/v1/data/search`：页大小 `pageSize`，返回 `data.pageInfo.nextCursor`。
- 两者下一页均使用顶层 `cursor`；接口、身份、平台、查询条件和页大小保持不变，每页新幂等键。
- count/pageSize 是上限，少于该值不代表结束。标准搜索去重/缓冲和独立上游请求可导致条数不同，不能要求两条链路逐页等长。
- 标准接口保持 `ready_only`。微信公众号的凭据、启用状态与契约验证仍须满足现有就绪条件；本次不会把未验证的能力改为 ready。
- 真实上游错误继续保留失败语义，不以空结果、自动换供应商或盲重试掩盖 400/502。

Facebook 首屏 502 在当前源码中不能由两条路径的默认供应商差异解释：两者均使用 RapidAPI。
需要当次 Hub requestId、错误 JSON 和对应 Night-All 关联日志，才能判断供应商响应、配置、
子进程或其他具体原因。微信公众号标准路径的 502 同样需要区分上游尚未 ready 和实际调用失败。

## 发布及验证

需要同步发布 Hub 与 Night-All。仅发布 Hub 会修正入库标题及复合游标的静态参数，
仍由旧 Night-All 输出的兼容响应标题不会被 Hub 擅自重写。
旧幂等请求继续复现原响应；缺少原生 cursor 的旧续页状态不能凭空修复，须明确开始新首屏。
接口别名、15 页边界、鉴权、计费与现有 MX-H2I 登录/联网代码不变；无数据库迁移。

新增回归先在旧实现上复现失败，再验证修复：Facebook 标题/纯媒体/账号/原始证据、
微信公众号默认路由与显式选择、抖音完整续页参数、明确结束、通用游标不覆盖原生参数、
Hub 多页静态筛选与跨平台游标封装。测试使用合成上游和内存存储，无真实供应商请求。

最终本地结果：

- Hub 搜索、入库、分页、授权、幂等、计数和交付回归：189 项，187 通过，2 项 PostgreSQL 集成测试因缺少独立测试数据库跳过。
- Night-All 针对性 JS 回归：72 项通过；Twitter/Facebook Python 标题回归：6 项通过。
- Night-All 扩展契约检查：65 项，64 通过，1 项既有失败。`data-capability-service.test.js` 的平台清单断言将包含 LinkedIn 的 manifest 与不含 LinkedIn 的 raw 搜索清单比较；manifest、provider context 和该测试均与 HEAD 一致，本次未改动这个独立问题。
- 两仓库 `git diff --check` 通过。未部署生产，未执行数据库迁移、历史回填或付费采集。
