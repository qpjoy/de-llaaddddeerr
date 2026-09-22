# 小红书笔记画卷：热点、阅读量与评论（2026-09-23）

本次仅修改 MX Insight Hub。MX Launcher / MX-H2I 登录、Internal 配置、联网、DNS、WireGuard 均不修改。

## 产品合同

| 用途 | Hub JSON POST | 必需能力（还需 xiaohongshu 平台） |
| --- | --- | --- |
| 关键词笔记列表 | `/api/v1/xiaohongshu/app_v2/search_notes` | `social.posts.search` + `compat.xiaohongshu.app_v2` |
| 正文、标签与图片 | `/api/v1/data/post` 或原 `app/get_note_info` | `social.posts.resolve` |
| 详情、阅读量与曝光量 | `/api/v1/data/xiaohongshu/notes/detail` | `social.posts.analytics` |
| 评论列表 | `/api/v1/data/xiaohongshu/notes/comments` | `social.comments.list` |

详情另提供 `/api/v1/xiaohongshu/pgy/get_note_detail` 的 JSON POST 别名，和中立入口共享规范化参数、幂等和计费身份。请求仅传 `note_id`，不接受供应方、URL、凭据或任意路由。GET 不支持。

搜索界面提供按点赞热度/最新/评论最多排序及发布时间过滤。它表示关键词相关热门笔记，不声称全站热榜。搜索结果不自动补查阅读量或评论，用户明确选择笔记后独立查询。

### 为什么保留原详情按钮

核对 [PGY 详情官方合同](https://docs.tikhub.io/479321007e0)：`data.data` 可提供 `content`、作者、`imagesList`、`videoInfo`、`readNum`、`impNum`、`likeNum`、`favNum`、`cmtNum`；没有承诺结构化标签或评论内容。因此新增入口可渲染已提供的正文、媒体和指标，但不能无条件替代完整正文/标签操作。`meta.tagsAvailable=false` 表示没提供标签，画卷保留当前会话已取得的标签。

阅读量映射 `metrics.views`，曝光量映射 `metrics.impressions`，与点赞/评论独立；未提供的指标为 `null`，真实零保留 `0`。详情按本次观测写入 `social.posts.v1`，评论及内嵌回复写入 `social.comments.v1`。原始响应字节留在受限归档，公开响应、错误、头部和文档使用 Hub 合同。

新详情和评论每个新请求直接采集一次；仅既有的幂等保护可重放，不新增请求缓存/缓冲、定时等待或后台重试。界面和文档仅建议新详情查询间隔至少 5 秒；这是操作建议，不能保证接口不会限流。结果不确定时保留同一幂等标识。

[评论官方合同](https://docs.tikhub.io/420136394e0) 的 cursor/index/pageArea 被封装为 Hub 加密游标；下游只接收 `nextCursor`，绑定 consumer、Key、note_id、sort，最多 15 页。缺失/冲突/未前进的分页信息不猜测续页。每页使用新 Idempotency-Key；打开弹窗、关闭重开、切换视图和滚动都不自动采集新评论。内嵌回复不代表完整二级评论遍历。

## 价格、权限与上线

- `103_xiaohongshu_research.sql` 只新增两项独立操作的合同/控制记录，默认 `disabled`。不开通任何消费者/Key 权限，不更改旧操作的状态。既有部署环境开关也不会隐式开放新操作。
- 在“外部数据平台”分别审核并填写两项采购单价/币种/预算，再显式启用；不把旧图文详情的采购成本猜作新接口成本。缺少凭据、成本或放行只阻止对应新操作。
- 在“开放能力”显式开通业务与目标 Key 的新能力；原 Key 可以通过现有权限编辑流程增补，无需变动 MX-H2I 用户身份。
- “追加小红书费率”打开 v2 草稿：原四项加上阅读量和评论，均为现有模板价 CNY 10 分/成功请求。v1 仍为四项不可变模板；已有发布套餐和调用者绑定保持不变。运营需发布新版本并分配到目标调用者后生效。授权但未定价的操作仍按既有免费规则处理，不隐式收费。
- PGY 官方合同明确 HTTP 200（含查无数据）产生采购成本、HTTP 400 不产生采购成本。有效无结果交付 `meta.status=no_data` 计一次 Hub 成功请求；幂等重放不重复扣款。已计采购成本但无法规范化的响应保留证据并返回失败，不能伪装成功空列表。
- 原 App V2 业务字段保留；供应方 `request_id/router/docs/support/cache_url/message` 等传输元数据从公开交付移除，Hub 请求 ID 取响应头。旧快照重放也经过相同边界。

验证使用本地内存服务与合成响应，未执行真实付费调用、线上迁移或部署。真实返回字段覆盖率与线上 PostgreSQL 入库需要启用前核验。

本次验证：服务端回归 1974 通过、26 跳过（未配置 PostgreSQL 集成测试库），类型检查、生产构建与 4 项 Sites 测试通过。现有 Playwright/Chromium 对 1440×1000 桌面及 390×844 手机视口验证了调试器幂等重放、旧正文与新指标并存、评论两页、弹窗重开不采集和无横向溢出；无应用脚本错误。本地预览存在 favicon 404，不影响业务流程。

---

## 历史实现（2026-09-13；与上文冲突时以上文为准）


本期复用 Hub 的 TikHub 网关、独立操作放行、凭据、成本准入、归档与 canonical 入库。只改变 Hub；不修改 Launcher、MX-H2I、用户登录、DNS 或 WireGuard。

## 发布范围

已有五个 App V2 GET 入口现在也接受同字段 JSON POST：get_image_note_detail、search_notes、search_users、get_user_info、get_user_posted_notes。POST 禁止混用 URL query，page/ai_mode 可传 JSON 整数，其余类型按现有合同校验。两种 HTTP 方法共享 endpoint + 规范化参数幂等身份，不能靠切换传输重复采集。

文档侧边栏按平台原生接口 → JustOne / TikHub 分类。TikHub 的五个端点分别拥有参数表、官方参考链接、示例、授权、分页和错误说明。平台名称只用于文档分类，不新增租户供应方路由字段。外部平台 TikHub 详情连接到文档和画卷。

本期不开放任意路径代理；评论、收藏、话题及视频专用 API 不在此次列表/图文详情发布范围。`/api/v1/xiaohongshu/app/get_note_info` 仍是现有稳定产品合同，通过链接获得 `data.item.text`、`data.item.tags`；并非声称原样转发旧 App V1 响应。

## 列表、详情和分页

- 管理员会话默认读取 `social.posts.v1` 中的小红书笔记，复用 Data Center 的安全展示投影、完整正文和 opaque cursor。按现有 newest 排序；关键词只筛选已存数据。非管理员不会请求跨租户管理历史。
- 手机式列表打开详情后展示当前版本正文、标签及媒体。列表预览明确标记可能不完整，可在详情中点击“获取完整正文与标签”直接读取完整详情，也可带入解析表单选择其它交付策略。详情与原生响应的原始业务内容不在 UI 做长度截断。
- 上划只加载 Hub 历史；下拉只有显式勾选开启后才采集，且必须有 Public Live Key 与输入。按钮也可单独获取一页。关键词采集默认图文笔记；用户列表接受 ID/主页分享链接。
- 搜索 page 与 search_id/search_session_id 延续同一查询；用户列表只使用 Hub 返回的 mxec2 游标。最多 15 页。Hub 历史 cursor 永远不发送给上游；缺失、冲突、空页仍宣称有后续的响应显示错误。
- 每页新幂等键，失败后保持同一键重试，关闭手势续页，绝不后台重试。超出显示批大小的已采集笔记先缓冲展示，再请求下一付费页。跨批按笔记 ID 去重。采集筛选和历史筛选是两个独立区域，避免将上游页码误作 Hub 存储页码。
- API Key 只放页面内存；换 Key 清除结果。原始图片默认关闭；开启后通过原始 HTTPS 地址读取，费用未知，不触发笔记采集。尚未声称接入 mx-static。

## 下游交付

租户继续使用自己的 Live Key、明确的平台和操作能力，不能调用管理历史。兼容接口另需 `compat.xiaohongshu.app_v2`。每次交付保留 requestId，`GET /api/v1/acquisitions/{requestId}` 只允许所属 consumer 读取这次交付和入库证据；可用授权后的 canonical/stored search 检索长期数据，但不将当前状态搜索等同于原始响应重放。异步入库延迟时，当前页面可显示本次响应，管理历史需稍后刷新。

## 官方参考

- [图文详情](https://docs.tikhub.io/420136391e0)
- [搜索笔记](https://docs.tikhub.io/420136398e0)
- [搜索用户](https://docs.tikhub.io/420136399e0)
- [用户信息](https://docs.tikhub.io/420136395e0)
- [用户笔记](https://docs.tikhub.io/420136396e0)

仅文档参考不表示该环境的上游操作已放行；凭据/合同/价格/授权仍须通过现有运行时控制。缺少任何一项只影响数据采集，不影响 Hub 或 MX-H2I 登录联网。

## 本地验证

- 定向服务端、文档、笔记/电商、身份/凭据隔离及 Sites worker 回归：168 通过，3 个 PostgreSQL 集成测试因未配置测试数据库跳过。
- 构建、现有 TypeScript 检查通过；浏览器验证管理登录、无 Key 空态、独立 TikHub 文档页。
- 隔离样例验证：10→20 篇历史续页、长正文和标签详情；无效 Public Key 的采集 401 不退出管理会话。样例只在 /tmp 测试服务，不写入生产库或代码内置数据。
- 未执行真实付费 TikHub 调用、线上数据库验证或部署。
