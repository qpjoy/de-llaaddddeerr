# 小红书热门笔记与创作灵感

数据产品 → 小红书 → 笔记画卷 / 热门笔记 / 创作灵感。原画卷 URL 保留。两个新产品默认打开接口调试，第二个 Tab 分别为热门内容和灵感看板，共享当前身份、参数、响应和幂等标识；页面打开、视图切换、身份续期均不触发采集。

| 产品 | Hub JSON POST | 独立能力 | 内部平台 / 固定上游 |
| --- | --- | --- | --- |
| 热门笔记 | `/api/v1/data/xiaohongshu/hot-notes/search` | `social.posts.hot_search` | JustOne `/api/xiaohongshu/hot-search/v1` |
| 创作灵感 | `/api/v1/data/xiaohongshu/creator-inspirations` | `social.inspiration.list` | TikHub `/api/v1/xiaohongshu/app_v2/get_creator_hot_inspiration_feed` |

两者均要求调用者与当前 Live Key 的 `xiaohongshu` 平台授权，加上本操作能力。不继承笔记搜索、详情或兼容能力的权限，不跨平台回退。复用现有凭证和各自出网策略；JustOne 使用小红书授权作用域的网关存储。供应商、endpoint、采购价币种、operation、请求与原始响应证据在内部独立可查。MX-H2I 与 Launcher 的认证和网络代码不参与本次接入。

## 请求

热门笔记支持 `searchWord`（默认空，最多 500 字符）、`orderBy`（默认 `premium_imp_num`）、`nd`（默认 `DAY_7`）和可选 `noteContentCategory`。排序枚举见接口文档，时间范围为 3/7/14/30 天。类目使用 `内容类目#父级[#子级]` 或 `所属行业#父级[#子级]`，不使用猜测类目字典。创作灵感首页使用 `{}`。

必须提供 `Idempotency-Key`。接口只接受固定 JSON 字段，不接受 provider、URL、token、pageNum 或原生游标。公开响应包含 `data.result` 与 `data.pageInfo`。下一页使用新的幂等标识，将 `data.pageInfo.nextCursor` 原样传回顶层 `cursor`；保持身份、接口和筛选不变。游标加密并绑定 consumer、Key、产品、筛选和合同版本，最多 15 页。

`hasMore=false`、空列表、无可用游标时停止。`unknown` 表示无法确认继续条件；`limit_reached` 不代表上游内容耗尽。JustOne 只保证接受页码，未保证响应包含 hasMore：识别到非空列表但没有明确继续标志时，返回 `hasMore=null`、`paginationStatus=next_page_probe`，由调用者明确决定是否查询下一页；此页可能为空且产生正常调用费用。TikHub 必须实际返回非空且变化的 cursor，不能自行把游标加一。

## 数据边界与验证依据

2026-09-23 对照 `/tmp/xiaohongshu_redian` 及官方文档：

- [JustOne 热门内容参数](https://docs.justoneapi.com/zh/api/xiaohongshu-rednote/hot-search-v1) / [OpenAPI](https://docs.justoneapi.com/openapi/xiaohongshu-rednote/hot-search-v1-zh.json)：`data` 无细化 schema。
- [TikHub 创作灵感](https://docs.tikhub.io/420136410e0)：首页空 cursor，续页使用响应 cursor；示例 `data=null`。

因此首版固定的是调用与交付合同，业务字段保留为 `data.result`，`meta.projection=native_fields`。展示层只识别直接数组或唯一的 items/notes/list/feeds/noteList 数组容器；不识别时按完整字段展示，不把任意对象冒充笔记列表。不推导标题、话题、指标单位、全站排名或 canonical ID。`returnedCount=null` 表示未知，null 或空对象响应为 unknown，显式空数组才是 no_data。原生分页坐标与服务传输元数据不作为公开翻页入口。

完整响应字节进入受限归档，交付与回放结果保存在现有调用快照中。未知条目不自动写入 `social.posts.v1`，避免污染画卷已有正文/指标；以后用真实样本锁定映射后再做版本化清洗。此版本测试使用明确标注的模拟响应，不宣称真实数据字段与结果完整性已经验收。

## 上线

先执行 `106_xiaohongshu_discovery.sql` 再启动新版本。迁移只新增两个默认 disabled 的操作，不修改已有账号、Key、scope、权限、钱包、套餐或运行开关。管理员在对应 TikHub / JustOne 操作中填写审核后的采购价与预算，再显式启用或灰度；未知价格不会按零处理。两个产品未内置猜测售价，客户计费沿用明确接口价优先、其余租户默认价的现有规则。

按产品给指定调用者和原 Key 显式开通能力；用接口调试执行受控首屏、续页、末页、空结果和失败样本验收。每个页面只调用一个上游；没有后台采集、自动重试、自动翻页、详情/评论附加调用。失败或结果不确定时保留原请求标识查状态；不换 Key 盲重试。

在线文档：`/docs/xiaohongshu-hot-notes`、`/docs/xiaohongshu-inspiration`，均受现有文档登录与租户能力过滤保护。动态 OpenAPI 与 `docs/contracts/openapi.yaml` 同步。
