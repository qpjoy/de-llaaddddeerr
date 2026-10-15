# Facebook 双渠道字段校准与 API 兼容核查

更新：2026-10-15。用户要求 RapidAPI 与 JustOne 的差异由 Hub 适配，保持已有外部 API。
本轮实现限于 Facebook 搜索的内部投影和 canonical 入库边界，尚未部署生产。

## 证据来源和边界

- [JustOne 官方接口文档](https://docs.justoneapi.com/zh/api/facebook/post-search-v1)、
  [官方 OpenAPI](https://docs.justoneapi.com/openapi/facebook/post-search-v1-zh.json)。
- 官方文档使用的[已存响应示例](https://api.justoneapi.com/status/api-example/detail?api=%2Fapi%2Ffacebook%2Fsearch-post%2Fv1)：
  返回 metadata 标记 synthetic=false、checkedAt=2026-10-14T20:00:08（未注明时区）。
  这是只读已有示例，不是新采集；原文、用户资料和签名地址没有复制到测试。
- [JustOne 官方 SDK](https://github.com/justoneapi-official/justoneapi-python/blob/main/justoneapi/generated/resources/facebook.py)
  及其[较早成功示例](https://github.com/justoneapi-official/justoneapi-python/blob/main/docs/api-examples/getApiFacebookSearchPostV1.json)。
- [RapidAPI 官方端点](https://rapidapi.com/krasnoludkolo/api/facebook-scraper3/playground/apiendpoint_c0fb83cf-8dae-4824-a0ee-a66b79b037fb)
  核对请求参数。该页面没有成功响应示例，Rapid 返回字段以本地既有适配器、Night-All
  `crawlers/facebook/rapid/SearchPosts.py` 及其历史测试为兼容证据，不声明完整官方响应认证。
- 测试目录 `tests/fixtures/facebook/` 全部为合成数据，逐项来源与局限记录在 `SOURCES.md`。
  JustOne 两份官方样例均没有非空视频字段，其视频兼容仅有历史实现／合成测试证据。

## 请求参数校对

| 统一含义 | RapidAPI | JustOne | Hub 对外行为 |
| --- | --- | --- | --- |
| HTTP／路径 | GET `/search/posts` | GET `/api/facebook/search-post/v1` | 调用方继续使用原 Hub URL |
| 关键词 | query | keyword | 单一原检索式完整传递，不拆 OR、不去括号／引号 |
| 起始日 | start_date | startDate | 沿用 params 日期别名和现有日历日期转换 |
| 结束日 | end_date | endDate | JustOne 明确包含首尾日；不宣称两家时区／边界语义已通过实采认证 |
| 上游分页 | cursor | cursor | 供应商字符串原样保存，由 Hub opaque cursor 包装并绑定渠道 |
| 请求数量 | 无 count 参数 | 无 count 参数 | raw count／标准 pageSize 仍为 Hub 交付上限，保留余量与补页规则 |
| 其他参数 | 官方另有 recent_posts、location_uid | 当前未列等价项 | 不新增到公共接口，不假设两家具有相同能力 |
| 鉴权 | RapidAPI 请求头 | JustOne token 查询参数 | 继续由 Hub 凭据层处理，业务响应不公开 |

外部 URL 保持 `/api/v1/night-all/search/raw`、`/api/v1/search/raw`、`/api/v1/data/search`。
raw 的 query／keyword 与标准接口 query 的原规则、页大小、授权和错误合同保持。
不扩展顶层时间参数，不改变 params 八个既有别名的优先级、缺省时间、scope 或幂等 fingerprint。
日期精度仍为日，秒级窗口由已有调用方逻辑处理，不宣称时间语义升级。

## 成功结果字段校准

| 含义 | 已核对字段／差异 | Hub 新投影规则 |
| --- | --- | --- |
| 业务成功 | Rapid HTTP 成功且 results 合同有效；JustOne code=0 | HTTP200 不替代业务码；301 继续保存失败，不伪装为空结果 |
| 列表层级 | Rapid results；JustOne data.results，历史 business_data | 供应商适配后统一进入同一行投影，保持既有两种 JustOne 列表支持 |
| 内容身份 | post_id、postId、id；已归一行 content_id | 保留字符串及安全整数，不从 URL、哈希或不安全整数猜 ID |
| 正文 | message；已归一 full_text／text／content | 采用非空明确正文，全文保留；message_rich 保留原字段但不臆测结构或自动补详情 |
| 作者 | author.id/name/profile_picture_url；user 和已归一平面字段 | 输出既有 author_id／author_name／author_avatar_url，保持标准 author 结构 |
| 发布时间 | timestamp；已归一 created_at／created_time | 支持秒／毫秒数值及数字字符串，统一既有 ISO 时间；不合法为未知 |
| 点赞／反应总数 | reactions_count → like_count | 不把 reactions.like 分项冒充总数，不把 total 和分项累加 |
| 评论 | comments_count → comment_count；旧 reply_count | 真正 0 保留，缺失／显式 null／空串／布尔／复合值不生成 0 |
| 分享 | reshare_count → forward_count／share_count | 两个统一别名同值；canonical 只信最终校准值，避免回退到陈旧源别名 |
| 浏览 | video_view_count → view_count | 同样保留未知和真正 0，使用安全非负整数类型 |
| 收藏 | 已有 bookmark_count | 沿用同一严格数值规则；没有证据时为未知，不从其他行为数推测 |
| 单图 | image.uri | 保留明确资源引用及原 image 对象 |
| 相册 | JustOne album_preview.image_file_uri 为真实图，url 为 Facebook photo.php 页面 | 优先 image_file_uri，过滤已识别落地页作为媒体的误用；原相册字段／来源链接保留 |
| 媒体数量 | images_count 可以大于预览数组长度 | 只交付取得的图片，不补造缺少地址、不增发付费详情请求 |
| 视频 | 历史 video／video_files 数组或字典／video_hd_file、video_sd_file | 兼容已知引用；JustOne 当前公开示例无非空视频，保留这一验证边界 |
| 视频封面 | 明确 video_thumbnail 或已有 cover_url | 统一 cover_url；有视频时 images 仅移除与封面完全相同的引用，保留混合照片和不同签名地址 |
| 余量／下一页 | cursor 字符串可能含多层转义状态 | 不解析供应商 cursor 的业务含义；继续原渠道、原期限、15 次采购／公开页保护 |

raw_info／raw_data 继续为 JSON string；统一行仍供现有 canonical ingest 使用。
标准 envelope 仍是 night-all.data-search.v1，title 保持 null，raw 普通帖子 title 保持空字符串，
source.provider／endpointId 仍不公开供应商。内容、作者、日期、统计、媒体在三条投影间校准一致。
供应商原始响应字节和 SHA 保持独立，校准不改写旧归档或已保存响应。

## 兼容策略

既有标准余量游标保存了整页行投影的 hash，直接替换投影会使旧付费余量无法读取。
因此新遍历在加密游标内部标记 projectionVersion=2；无标记的旧游标按 1 解释，
整次旧遍历继续使用冻结的旧行／媒体投影，包括消耗完余量后的新源页。
版本不出现在公共请求／响应字段中，不改变公开 contractVersion、幂等身份或 scope。
未知内部版本仍走现有 invalid_cursor 错误。

历史成功和 301 失败响应仍原样回放，不重新投影，不为校准重采或重复结算。
旧游标仍受原有期限、归档完整性、身份、授权、渠道绑定和未知结果保护约束。
新校准从正常的新遍历开始生效，不能用它改写历史失败为成功。

canonical 的通用旧映射会在 null 时寻找其他原字段。Facebook 新投影在其入库边界
再次以已经校准的公共字段为准，防止未知日期／指标被 likes、comments、shares 等陈旧别名补回。
这只作用于 Facebook projectionVersion=2；旧版本和其他平台的 mapper 保持原规则，
rawItem 及其独立 rawPayloadSha256 保留，更新后的 canonical 摘要重新计算。

## 验证与发布

离线测试覆盖两套不同来源的合成 schema、真实适配器 mock fetch、原文和日期参数、完整归档，
raw／标准／canonical 同义字段、相册真实图、封面、严格指标、时间类型、明确 null 与源别名冲突，
以及真实旧投影 hash 续页、历史 200／301 原样回放、游标与幂等身份。
真实 PostgreSQL 条件测试与离线 PGlite 的边界分别报告，不用本地测试推断供应商在线成功率。

最终相关十三文件回归：380 项，376 通过、0 失败、4 项因未配置可丢弃真实 PostgreSQL 库而跳过。
其中新增字段校准十七项通过，旧投影／回放／媒体相关七项通过，PGlite 的实际 SQL 测试启用。
`npm run typecheck` 与 `git diff --check` 通过。没有以供应商实时请求替代离线合同验证。

本轮无新增数据库迁移，不修改价格、授权、钱包规则、全局额度／恢复探测或 MX-H2I 登录联网。
部署仍由运营者同步完整 Hub 源码后执行：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh ops internal-production deploy
kubectl -n mx-insight-hub rollout status deployment/mx-insight-hub-public --timeout=240s
```

当前仓库 Public Deployment 为单副本 Recreate，发布时沿用其既有切换方式。
如另有多副本或旧镜像流量池，须统一升级，避免新投影游标进入旧投影进程；
这不是可跨任意旧镜像无条件回滚的新游标格式。
不自动重发生产旧错误或通过付费采集验收。

## 尚不能由字段校准解决的部分

JustOne 只明确支持基础文本匹配，OR、括号、引号的搜索语义等价性尚未证实。
继续保留调用方原检索式，不能悄悄拆成多次请求或改成另一种搜索条件。
已核实的原始 301 是供应商采集失败，发生在成功投影之前；本轮修复不能被宣称为其内部根因修复。
