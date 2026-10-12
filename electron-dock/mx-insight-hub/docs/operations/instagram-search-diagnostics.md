# Instagram 搜索冷却诊断

2026-10-12 可用性调整后，解析冷却默认改为 5 分钟，配置项为
`MX_INSIGHT_TIKHUB_RESPONSE_QUARANTINE_COOLDOWN_MS=300000`。下文中的 15 分钟与
`900000ms` 属于历史事故证据；用新诊断脚本追查这些旧请求时，在诊断命令上设置
`MX_INSIGHT_DIAGNOSTIC_COOLDOWN_MS=900000`，才能按当时期限匹配候选调用。
此诊断变量不修改运行时规则；未知结果的同请求保护仍默认 15 分钟。

## 2026-10-12 评论与回复各一次付费实测

用户随后明确允许评论和回复付费校准，生产 Hub 管理台以现有 LCY-delta 身份各发送
一次请求。评论输入沿用已实测搜索结果的公开帖子短码；回复输入完全取自刚收到的
评论对象，不购买短码转换，也不构造不存在的评论 ID。

```text
POST /api/v1/data/native/t.api_4167d40172ce25ef
{"deliveryMode":"live_only","params":{"code":"C_Yqdk4u__R","sort_order":"popular"}}

POST /api/v1/data/native/t.api_4896d158e6531d9a
{"deliveryMode":"live_only","params":{"media_id":"3447692265176956881","comment_id":"18024567395376549"}}
```

| 证据 | 评论 | 回复 |
| --- | --- | --- |
| Hub requestId | `d24f7dcf-7508-427e-b273-ac18ab161ca6` | `a0484ff9-fbf8-4113-8314-bed04e317cd2` |
| 上游 requestId | `ba0cd540-6f62-4973-8ed0-8da8743b83e3` | `d5581281-3ac0-4158-a1f2-ec0365ef446d` |
| 请求/完成时间（UTC） | `04:22:17.781Z` / `04:22:20.821Z` | `04:23:03.511Z` / `04:23:05.347Z` |
| 上游耗时 | 2886ms | 1713ms |
| 交付 | live、已提交响应、HTTP 200 | live、已提交响应、HTTP 200 |
| 当次上游调用 | 一条，HTTP/业务码 200、已计费 | 一条，HTTP/业务码 200、已计费 |
| 客户结算 | enforced、已扣款 ¥0.01 | enforced、已扣款 ¥0.01 |
| 结果 | 9 条顶层 comments，28 个顶层业务字段 | 1 条 child_comments，9 个顶层业务字段 |

日期均为 2026-10-12；完成时间对应北京时间 12:22:20、12:23:05。本轮客户合计扣费
¥0.02。两条采购账本各为 `1 USD · estimated` 最小货币单位，即各估算 $0.01，
不是供应商最终账单金额证明。两份受限响应均已归档，未重试、翻页或追加付费调用。

实际格式核对：

- 评论：`comments[]` 保留字符串 `pk/media_id/strong_id__`、正文、时间、作者、点赞数
  与子评论元数据；`caption` 是独立对象，不混进评论数组。`comment_count=10`，
  顶层评论 9 条，其中一个父评论的 `child_comment_count=1`。不能强制总数等于数组长度。
- 评论页 `has_more_comments=false/has_more_headload_comments=false`，没有 `next_min_id`。
  选中父评论的 `has_more_head_child_comments=true`、`num_head_child_comments=1`、
  `has_more_tail_child_comments=false`、预览回复为空；评论列表结束不代表所有回复已交付。
- 回复：`child_comments[1]`、独立 `parent_comment`、`child_comment_count=1`，
  head/tail 的更多标志均为 false，没有 `next_min_child_cursor`。子评论的
  `parent_comment_id/replied_to_comment_id` 与请求父评论 ID 相等，媒体 ID 与原评论一致。
  `parent_comment` 没有原评论列表中的子评论分页元数据，不人为拼接两个对象。
- 评论的 `user_id` 在这份样本中是安全整数，回复的 `user_id` 为字符串，作者对象还同时
  含数字 `pk` 和字符串 `id/pk_id`；保持原生类型。全部实际业务数据未发现不安全整数，
  评论/媒体的长 ID 均以字符串保留，不转成 JavaScript Number。

现有原生转发已接受这两份结构，本轮无运行时代码修改。两份完整交付业务对象通过
adapter 离线回放，逐字段相等、身份关联通过、零额外外部调用、无自动帖子入库。
离线构造的成功外层不是生产原始采购回执；账本和受限响应仍以 Hub 为准。
匿名化回归新增终页评论和非空回复两例，总计 6 项通过，保留此前 JSON 游标传递测试。

此次真实样本均为终页，所以仅实测了无续页游标形态；有后续页的游标传递仍属于
[官方评论契约](https://docs.tikhub.io/419083071e0)、
[官方回复契约](https://docs.tikhub.io/419083072e0)及模拟测试证据，没有付费验证下一页。
这些结论限定以上两个 V3 原生端点及此次样本，不表示所有 Instagram 版本/未来格式
均已校准，也不代表 po-infra 已改接这两个端点。MX-H2I 登录和联网保持不变。

## 2026-10-12 用户详情独立校准与评论契约核对

用户后续允许为用户详情、评论等其他接口付费校准。本轮按总共一次新增请求执行，
当时未收到扩大到每类各一次的答复；该次额度用于用户详情，当时评论与回复未付费实测。
后续新增授权及两项真实校准结果见上一节。
生产 Hub 管理台沿用现有 LCY-delta 身份，目标为前一次搜索结果中的公开帖子作者：

```text
POST /api/v1/data/native/t.instagram_v3_get_user_profile
{"deliveryMode":"live_only","params":{"username":"worldwidewag_"}}
```

- Hub requestId：`f4362d8b-26e9-41d2-ba25-faa48fcc7567`。
- 上游 requestId：`3b4cc3de-7a51-4a28-9f5f-3578ed861452`。
- 请求 `2026-10-12T04:06:49.367Z`，完成 `04:06:52.672Z`（北京时间 12:06:52）。
- 只读请求诊断确认已提交响应、HTTP 200、sourceMode=live；仅一条上游调用，
  HTTP/业务码 200、3173ms、已计费、已保存受限响应。
- 客户结算 enforced/已扣款，1 CNY 最小货币单位，即 ¥0.01。
  采购 1 USD 最小货币单位标注 estimated，只代表 $0.01 估算。

实际业务数据为扁平 `data`，含 18 个字段：字符串 `pk/id/username/full_name/biography`、
两个头像 URL、`category/_rid`，数字 `follower_count/following_count/media_count`，
布尔 `is_private/is_verified`，`external_url=null`，以及三个 `edge_*.count` 对象。
`id=pk` 与前次搜索作者身份一致；三组直接计数与嵌套计数逐一一致。
[官方用户详情说明](https://docs.tikhub.io/419083059e0) 描述 `data.user` 包装，
本次线上结果没有该层。原生接口按原样交付业务对象，已支持这两种形态；不为匹配
示例人为添加/删除 user 层，不把资料误交给综合搜索的帖子投影。

| 接口 | Hub 原生 endpoint key | 独立格式和分页契约 | 本轮证据 |
| --- | --- | --- | --- |
| 用户详情 V3 | `t.instagram_v3_get_user_profile` | 本次扁平 data；文档 data.user；输入 username | 一次真实调用、诊断账本、完整业务数据离线回放 |
| 帖子评论 V3 | `t.api_4167d40172ce25ef` | code；响应 comments、next_min_id、has_more_comments；后续 min_id 原样传递，sort_order 为 popular/newest | 官方说明、本地契约及模拟回归；未实测 |
| 评论回复 V3 | `t.api_4896d158e6531d9a` | media_id/comment_id；next_min_child_cursor 作为后续 min_id | 已固定的官方契约快照及模拟回归；未实测 |

[官方评论说明](https://docs.tikhub.io/419083071e0) 中的 `next_min_id` 可以是序列化 JSON
字符串，必须整体保留，不能改用搜索的 next_max_id/rank_token。回复使用单独的子评论
游标。调用这些端点均须使用其原生 endpoint key、现有权限和计费链路；一个请求只取
一次响应，不自动继续分页或补买详情。其他 V1/V2/V3 端点不能从这三项推断已验证。

新增 `tests/server/instagram-native.test.mjs` 的 4 项本地模拟回归全部通过：扁平/嵌套
用户详情、评论 JSON 游标与长字符串 ID、回复独立游标；同时核对一次调用、受限原始字节
及哈希、空值、Unicode 正文和无自动帖子入库。测试使用匿名合成数据，不包含真实账号、
头像地址或游标。另用本次实际交付业务对象通过 adapter 离线回放，全部 18 个字段相等；
模拟包装的 code=200 外层不是原始采购回执，原始回执由生产 Hub 受限保存。

本轮仅增加证据和测试，无需为用户详情改动运行时代码或部署。评论/回复的模拟回归不能
替代各自真实响应证据；本轮未断言其生产数据格式已完成校准。先前综合搜索兼容扩展仍须
按下一节部署；MX-H2I 登录、联网、权限和结算规则均未改。

## 2026-10-12 综合搜索兼容扩展与一次付费验证

用户明确授权一次付费请求后，经生产 Hub 管理台现有 LCY-delta 身份，仅手动发送一次：

```text
POST /api/v1/data/native/t.instagram_v3_general_search
{"deliveryMode":"live_only","params":{"query":"Paris"}}
```

- Hub requestId：`4517ae17-8cad-4ce6-9fbb-17df29625be5`。
- 上游 requestId：`b1e44eef-916b-4d61-b3c3-addd39f26b0b`。
- 请求时间 `2026-10-12T03:57:02.220Z`，完成 `03:57:09.332Z`。
- 只读请求诊断显示 committed、HTTP 200、sourceMode=live；当次只有一条供应商调用，
  HTTP/业务码 200，耗时 6958ms、已计费、已保存受限响应。
- 客户结算为 enforced/已扣款，1 CNY 最小货币单位，即 ¥0.01。
  采购账本显示 1 USD 最小货币单位并标注 estimated，即估算 $0.01；不是供应商最终账单金额证明。
- 原生交付含一个账号推荐和 18 条网格帖子：9 条图片、5 条视频、4 条轮播；有有效下一页游标。
  未翻页、未重试、未补发标准搜索。后续归档读取和本地回放不调用上游。

这次调用验证的是原生接口的实际交付；标准 data-search/raw 的新增解析逻辑通过同一业务
响应的离线投影与模拟集成测试验证，不能当作新增代码已在生产标准搜索上线的证明。
只读交付归档重新读取为完整 JSON 后，离线投影保留全部 18 条帖子，`status=ok/hasMore=true`；
逐条核对身份、正文、作者、发布时间及图片/视频链接，并核对 next_max_id/rank_token 均通过。
该原生调用没有自动触发标准帖子入库；“采集查询复现”中的归档记录数为 0 不能解释为
上游返回 0 条，原生完整业务对象就在该次交付响应中。

兼容范围限定为 `instagram/v3/general_search`。根据已归档事故、此次实测、既有 Night-All
关键词推荐样本及[官方接口说明](https://docs.tikhub.io/419083058e0)，覆盖如下：

| 返回结构 | 标准帖子交付行为 | 证据范围 |
| --- | --- | --- |
| `media_grid.sections[].layout_content.medias[].media` | 保留图片、视频和轮播的帖子身份、正文、作者、时间和媒体链接 | 此次实测 18 条 + 回归 |
| `mediaGrid/layoutContent/media` 别名、`items` 裸帖或 media 包装、嵌套 `data.data` | 按同一帖子校验规则处理 | 既有支持 + 回归 |
| `list[].media`、裸帖、`list[].user/hashtag/place` | 保留帖子；账号、话题、地点不冒充帖子 | 账号/话题归档；地点为类型容器模拟测试 |
| `users/hashtags/places` 分组 | 识别直接对象及对应类型包装，非帖子不入帖子结果 | 官方分组说明 + 模拟测试；本次未返回这些分组 |
| `other_results.keyword_recommendations.keywords` | 识别关键词推荐，保留分页或不完整警告 | 既有 Night-All 样本 + 回归 |
| 多个容器同时出现 | 按网格、items、list 顺序收集所有帖子，以交付身份去重 | 实测 grid+list；多帖子容器回归 |

只含已识别非帖子结果且声明更多、缺游标时返回 `partial` 和
`INSTAGRAM_NON_POST_CONTINUATION_UNAVAILABLE`。有效游标在非帖子页甚至显式空页仍可传递；
显式结束、同游标循环和第 15 页上限保持。空页声明更多却没有游标、坏帖、非法分类包装、
损坏容器/分页、超出请求条数继续失败。检查所有同时出现的已知容器，不能用空网格或
推荐结果掩盖其他容器里的帖子/异常；诊断也统计全部帖子容器，只输出固定字段类型和数量。

这不是对所有 Instagram 端点、任意未知结构或未来改版的保证。未知结构继续保留原始
归档并报错；原生接口保留业务对象，标准帖子接口遵守自身契约。无自动翻页、额外详情购买、
重试、授权/计费/隔离保护更改；MX-H2I 登录和联网代码未改。

本地回归：`instagram-search`、`instagram-search-diagnostics`、`raw-search-routing`、
`admission-recovery`、`night-all-pagination-platforms` 五组测试，66 通过、0 失败、6 个可选
数据库测试因未配置 PGlite 跳过。真实响应另在本地离线核对，不将账号、正文、签名 CDN
地址和真实游标写入测试夹具。新增代码尚待服务器部署，无新增数据库迁移。

在服务器同步本次代码后，从 Hub 源码目录执行既有部署流程：

```bash
bash scripts/manage.sh deploy
kubectl -n mx-insight-hub rollout status deployment/mx-insight-hub-public --timeout=300s
kubectl -n mx-insight-hub rollout status deployment/mx-insight-hub-admin --timeout=300s
```

部署后可用下文原事故的只读诊断命令复核，不需要再次付费。新原生调用的交付与结算可在
管理台“请求诊断”按上述新 requestId 查询；现有 Instagram CLI 诊断限定标准搜索路径，
不能把新原生调用 ID 填入后将“不支持/未找到”误解为调用失败。原生完整交付可在
“数据中心 → 采集查询复现”只读查看。旧 po-infra 冷启动已经恢复成功，无需再恢复一次。

## 2026-10-12 话题推荐与缺失游标

策略 `ad3c1131-6850-4cbf-a37a-ade3de846bd9` 的 Hub 请求
`7962155d-a920-4426-8663-ad5e68720806` 在 `01:55:44.930Z` 创建，
`01:55:44.954Z` 释放，实际路径是 `/api/v1/data/search`。
操作者返回的只读归档报告找到一条与告警截止时间完全匹配的候选：

- 原 Hub 请求 `8ba962cb-701f-4b43-acb9-d002c20063db`，调用 `8b12d535-5a5b-4bd2-81ce-2059f08489fe`。
- 调用结束于 `2026-10-12T01:51:24.698Z`，加 900000ms 正好是告警中的 `02:06:24.698Z`。
- HTTP / 业务码均为 200，`billed=true`，上游请求 `71881104-9125-4e2d-85f0-7680f569ae49`。
- `status=ok`、`list[1]`；唯一条目为 `position:number + hashtag:object`，
  外层没有 `id/pk/code/shortcode/user/media/caption/media_type/place`。
  没有媒体网格/items，`has_more=true`，`rank_token` 长 78，但没有 `next_max_id`。
- 当时已部署解析器回放仍报 `invalid_instagram_search_shape`。这次是话题推荐，
  与 10 月 9 日的账号推荐分支不同。旧记录未保存 blocker ID，仍保留候选关联的证据边界。

[官方综合搜索说明](https://docs.tikhub.io/419083058e0)（2026-10-12 核对）说明返回可含
用户、话题和地点，翻页需使用响应中的 `next_max_id` 与 `rank_token`。
不能将话题当帖子、用 rank_token 代替 next_max_id，或为补齐数据额外自动购买一页。

修复仅扩展已识别的 list 分支：没有帖子字段、没有 user/place 冲突、显式含 hashtag 对象的
条目归类为非帖子；不猜测/规范化话题内部字段。原始话题对象仍完整留在受限响应归档。
地点和未知条目仍不猜测。有媒体的条目继续走帖子身份校验。

对于非空、全部为已识别账号/话题的 list，如果声明有更多结果但没有可用游标，
交付 HTTP 200、`status=partial`、零条帖子、`hasMore=false/nextCursor=null`，并带
`INSTAGRAM_NON_POST_CONTINUATION_UNAVAILABLE` 警告。这里表示**无法安全继续这一响应**，
不表示搜索已穷尽或 Instagram 没有相关帖子；标准 data-search 与 raw 都保留该警告。
有有效游标时仍可继续；有帖子/空 list 却缺游标、损坏的 token/分页标志、未知或坏帖仍明确失败。
这样不会为已识别的推荐页打开全端点解析冷却，也不会掩盖可能丢失的帖子。

本地用报告的字段类型构造模拟响应，验证旧代码拒绝、新代码接受，并覆盖标准 data-search、
两个 raw HTTP 别名、幂等回放、采购回执、有效分页和坏帖保护。未读取生产话题内容，
未发付费探测或修改历史状态。无新增 migration；服务器归档回放结果见下方验收记录。

在服务器的 Hub 源码目录按既有流程部署，然后只读验证：

```bash
bash scripts/manage.sh deploy
kubectl -n mx-insight-hub rollout status deployment/mx-insight-hub-public --timeout=300s
kubectl -n mx-insight-hub rollout status deployment/mx-insight-hub-admin --timeout=300s
kubectl -n mx-insight-hub exec deployment/mx-insight-hub-admin -c admin -- \
  node /app/server/ops/diagnose-instagram-search.mjs \
  7962155d-a920-4426-8663-ad5e68720806 \
  --blocked-until 2026-10-12T02:06:24.698Z
```

匹配候选的 projection 预期：`current_projection_accepts`、`returnedCount=0`、
`hasMore=false`、`deliveryStatus=partial`，warningCodes 含上述警告。
旧请求依然是 released；不改账、不重写旧响应、不自动解除新出现的保护。
部署全部 API 副本并确认当前限制后，才在告警所属 po-infra 环境恢复该策略的 Instagram
冷启动任务，保留分页不完整的说明；Hub 部署不会自动重启下游任务。不要用 Dev 环境 404
推断生产策略不存在，也不要扩大到全平台恢复。MX-H2I 登录和联网保持不变。

### 操作者回传的归档回放验收

2026-10-12 操作者再次提交同一请求、同一调用的诊断结果：
`matchesReportedDeadline=true`、`current_projection_accepts`、`returnedCount=0`、
`invalidRowCount=0`、`hasMore=false`、`deliveryStatus=partial`，且 `warningCodes` 为
`["INSTAGRAM_NON_POST_CONTINUATION_UNAVAILABLE"]`。该份历史响应已通过当前诊断所用解析器，
符合预期的“话题结果、无可用后续游标”交付。

旧请求的 `released` 和旧调用的 `succeeded_unusable/invalid_instagram_search_shape`
保持不变，属于历史事实，不代表本次回放仍然失败；`released` 也不是当前端点保护状态。
此报告不包含全部 API 副本版本、最新保护记录或下游任务状态，不能据此宣布采集已恢复，
也不能将零条帖子解释为搜索穷尽。未为验收新增上游请求或改写采购账本。

操作者随后确认告警所属 po-infra 是 Docker 容器 `mx_data-web-1`（同名前缀网关端口 59201），
其上游为 `hub.minsight-ai.com`；Hub 自身在 Kubernetes。目标策略
`ad3c1131-6850-4cbf-a37a-ade3de846bd9` 的本地 ID 为 295，启用且未过期，
全局与 Instagram 均未暂停。Instagram 状态为 `failed/cold_start_failed`，尝试次数为 1；
最近三条冷启动任务都失败且入库为 0，其中任务
`2c6cd2ba-34ea-441a-9757-1fea6a41027e` 的错误文本匹配原告警请求 ID。
`delta_59202-web-1` 未找到该策略；`delta_59201-web-1` 导入冷启动模型失败，
不能据此判断其是否有策略，也不在本次恢复目标内。

恢复目标限定为已定位的 `mx_data-web-1` 中该策略的 Instagram 冷启动。
本地 po-infra 恢复入口 `recover_plan_cold_start` 支持 `platforms=["instagram"]`、
`force=False`，优先从失败任务检查点继续，并遵守现有暂停、禁用和过期状态。
采集器每次执行创建新的 step，按 step 标识生成本次 Hub 幂等键，不回放旧失败交付。
恢复会按现有策略实际调用 Hub，可能产生正常采购/客户计费；不更改历史 Hub 请求与账本。
操作者已执行恢复，返回 `plan_id=295`、`platforms=["instagram"]`、`resumed=true`，
并列出原任务 `c3c65964-98cd-4bf4-97ae-e6c4d583de19`、
`2c6cd2ba-34ea-441a-9757-1fea6a41027e`、`1c0be8d3-dc92-49ec-9ae9-973b3ad89ee2`。
这确认三条原任务已恢复入队；调用时的 Python 语法/依赖警告未阻止该步骤。
操作者随后回传终态：上述三条任务均为 `succeeded`、`collected_count=0`，分别于
`2026-10-12T03:39:31.478383Z`、`03:39:31.450384Z`、`03:39:31.243494Z` 完成。
平台冷启动状态于 `03:39:31.488933Z`（北京时间 11:39:31）变为 `succeeded`，
`reason=instagram_hub_projection_fixed`、`attempt_count=2`。
这确认本次解析修复的归档验收与下游失败任务恢复均已完成，冷启动失败状态已解除；
无需再次执行恢复。该状态报告未包含新 Hub 响应内容或后续增量运行记录，零条入库
不能证明搜索穷尽、上游没有相关帖子或后续增量已经执行。先前归档的 partial 警告仍保留其
“缺少可用游标、无法安全继续该响应”的含义，不以任务成功替代数据完整性结论。

## 2026-10-09 冷启动失败

策略 `78e90b16-999f-470f-b30c-45d83ad43429`，检索词 `Lu Benwei cheating`，
Hub 请求 `112fad2d-a78e-4959-9328-d3fdfb7d0c94`。

已从生产后台“数据浏览中心 → 请求诊断”只读核实：请求在
`2026-10-09T07:04:27.480Z` 创建、`07:04:27.490Z` 释放，
错误码 `external_platform_response_unusable`，没有当次上游调用、响应正文或客户扣款记录。
结合告警中 `upstreamDispatched=false`，这是之前解析失败引起的调度前保护，
不能判断为此次供应商限流、余额不足或没有搜索结果。

告警截止时间为 `2026-10-09T07:06:23.835Z`（北京时间 15:06:23.835）。
服务器报告已确认冷却为 900000ms，匹配的原始调用在 `06:51:23.835Z` 完成。
保护范围是同一供应商、operation、endpoint、contract，
不限某个检索词或 Key。下游称“其他检索式继续运行”不保证这些请求也能通过 Hub。
超过这次截止时间也不代表没有新的保护记录，或下游已自行解除策略阻塞。

当前 Hub 原生 Instagram 分支直接请求 TikHub `instagram/v3/general_search`。
保留旧 cursor / 小页请求的历史路由；不能只凭下游 `operation=raw` 判断实际 HTTP 路径。
该原生接口不接受 count 参数，Hub 对超出请求页大小的响应会拒绝，不能直接截断丢弃记录。
本次归档报告已排除这些作为第一处拒绝原因：实际失败点是顶层结构校验。
关键词推荐不作为帖子交付，未知结构也不转换为“成功但零条”。

## 读取服务器归档

从更新后的 Hub 源码目录执行。此方法通过标准输入运行宿主机上的脚本，
使用现有 Pod 的 `pg`、数据库连接及已部署解析器；不需要重建镜像、在宿主机安装依赖，
也不需要在只读容器中写文件。

```bash
sed \
  -e "s|from 'pg'|from '/app/node_modules/pg/lib/index.js'|" \
  -e "s|from '../contracts/|from '/app/server/contracts/|g" \
  -e "s|import.meta.url === pathToFileURL(process.argv\[1\]).href|process.argv[1] === '-'|" \
  server/ops/diagnose-instagram-search.mjs |
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - \
  112fad2d-a78e-4959-9328-d3fdfb7d0c94 \
  --blocked-until 2026-10-09T07:06:23.835Z
```

若新脚本已经随镜像部署，也可直接运行：

```bash
kubectl -n mx-insight-hub exec deployment/mx-insight-hub-admin -c admin -- \
  node /app/server/ops/diagnose-instagram-search.mjs \
  112fad2d-a78e-4959-9328-d3fdfb7d0c94 \
  --blocked-until 2026-10-09T07:06:23.835Z
```

脚本开启只读事务，查询最多 10 个候选、单份归档不超过 8MiB，并验证 SHA-256。
不请求供应商、不改账、不解除冷却；输出固定字段类型、数量和错误原因，
不输出正文、查询词、凭据或分页 token。当前仅重放保存了原始参数的首页请求；
后续页不会猜测 cursor 参数。

重点看 `evidence[].matchesReportedDeadline`、`storedErrorCode` 和 `projection`：

| 字段/原因 | 含义 |
| --- | --- |
| `matchesReportedDeadline=true` | 完成时间加冷却时长与告警一致；旧记录没有 blocker ID，仍是强匹配候选 |
| `invalid_instagram_search_shape` | 未识别的顶层数据结构或非正常业务状态 |
| `invalid_instagram_media_grid` | sections / layout_content / medias 结构不匹配 |
| `invalid_instagram_post_identity` | 帖子 ID 或 shortcode 不可用；`invalidRows` 指出类型及大整数风险 |
| `instagram_page_exceeds_requested_count` | 唯一帖子数超过保存请求的 pageSize |
| `missing_instagram_continuation` | 声明有后续页却没有可用 next_max_id |
| `invalid_instagram_continuation` / `invalid_instagram_pagination` | token 类型/长度或分页标志不符合约定 |
| `current_projection_accepts` | 已部署解析器能读取旧响应；不等于旧失败响应已修复或下游已恢复 |
| `archive_missing` / `archive_integrity_failed` | 原始证据不可用；不得据此判断接口健康 |

## 归档结果与 list 兼容处理

操作者返回的已校验归档报告定位到一条与冷却截止时间完全一致的候选：

- 原 Hub 请求 `db65c03d-af2d-46cc-a5a2-3c1d2af40d53`，调用 `72a54ecb-ede6-4f97-92b8-910a6dcbc75a`。
- 供应商请求 `49e81ea5-cb5b-40cd-aec8-ad792b8cb2d2`，HTTP / 业务码均为 200，`billed=true`。
- 顶层 `status=ok`、`list` 有 1 条、`has_more=false`，`rank_token` 长度 78；
  没有 `media_grid/items/keyword_recommendations`，触发 `invalid_instagram_search_shape`。
- 旧诊断中的 `resultCount=0` 仅表示旧解析器没有提取到帖子，不能证明 `list` 内容为空。

[TikHub 综合搜索官方说明](https://docs.tikhub.io/419083058e0)明确可能返回账号、话题和地点；
Night-All 的现有回归样本也包含 `list[].user`。操作者进一步读取了相同归档：唯一元素包含
数值 `position` 和对象 `user`，后者有字符串 `id/pk/username/full_name`；外层无
`id/pk/code/shortcode/media/caption/media_type/hashtag/place`。这是明确的账号结果结构，
不是帖子。Hub 将这种正常的“只有账号、没有帖子”的响应当成了契约错误。
诊断脚本现已追加不输出内容的 `listEntries` 类型证据，方便一次检查完整结构。

新增严格的 `status=ok + list` 分支，仅在媒体网格/items 没有提供时使用：

- `media` 对象或带 shortcode 的帖子沿用原 ID、媒体、caption 校验与去重。
- 明确带合法用户 ID、username 且不含帖子字段的 `list[].user` 不作为帖子入库。
  只有账号且 `has_more=false` 时，帖子接口返回正常零条、`hasMore=false`，不触发冷却。
- 若有有效后续游标，即使该页只有账号，也保留继续查询的能力；依然绑定 Key/查询，最多 15 页，
  不自动加发任何请求。
- 未知 list 项、混合的坏帖、无 ID 的媒体、异常状态及损坏的网格/items 仍明确失败，
  不以“过滤账号”为由掩盖丢失帖子。当时未支持地点/话题；话题的后续修复见上方 10 月 12 日记录。

标准 `/api/v1/data/search` 与两个 raw URL 共用此修复；原始响应、采购计费、历史重放不修改，
不回退 Night-All、不追加付费探测，不影响 MX-H2I 登录/联网。无新增 migration。
部署 public API 和 admin 的新镜像后重跑上面的只读诊断；该归档预期为
`current_projection_accepts`、`returnedCount=0`、`hasMore=false`。本地以报告字段结构重建的
模拟账号样本已通过标准搜索/raw 链路和只读诊断测试；生产原文仍留在服务器，部署后才能
对该份原文完成最终回放验证。不应把这个零条结果表述为“Instagram 上完全没有相关帖子”。
其他归档若 `listEntries` 显示未知类型，仍需按证据补充，不能直接删除结构校验。
旧请求 `status=released` 是不可改写的历史状态；下游已经阻塞的策略需要重新启动采集，
不能用旧幂等键的失败回放判断新代码是否正常。
