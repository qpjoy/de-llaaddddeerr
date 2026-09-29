# 微信数据服务接入（2026-09-29）

本批为 Hub 本地实现，尚未部署或执行真实付费验收。2026-09-30 按明确要求切换 Hub 的旧微信搜索入口；MX-H2I、Launcher、Luopan 的身份、登录和联网不变，Night-All 源码及其他平台搜索路径不变。

## 产品与来源

数据产品 → 数据服务下按业务平台分组：微信（微信公众号、微信视频号、微信搜一搜）和小红书。场景应用保留自建采集、已收录内容及加工产品，例如 Telegram、全国舆情、新闻发现和专题洞察。产品归类描述业务来源与用途，不改变底层授权。

微信首次供应来源为 TikHub。面向调用方仅使用 Hub 路径、操作能力、价格与业务数据；供应商坐标、账户、采购价格及完整传输证据留在 Admin 管理面。未来其他来源可以绑定现有目录的同一平台；一次请求仍使用确定版本的路由，不能偷偷双发、失败换源或改变旧游标。

## 已实现范围

2026-09-29 下载官方 OpenAPI，固定 25 个正式 POST 接口与 1 个固定文章 GET 演示。Hub 统一以 POST 接收 JSON，服务端固定实际请求方法与路径，不接受任意 URL、凭据或额外参数。原有 1037 个 native 合同保持，现合计 1063 个。

| 微信服务 | 接口数 | Hub 路径前缀 | 稳定目录键 |
| --- | ---: | --- | --- |
| 微信公众号 | 11 | `/api/v1/data/wechat/mp/` | `source-catalog-0025` |
| 微信视频号 | 12 | `/api/v1/data/wechat/channels/` | `source-catalog-0003` |
| 微信搜一搜 | 2 | `/api/v1/data/wechat/search/` | `source-catalog-0026` |
| 固定文章演示 | 1 | `/api/v1/data/wechat/demo/` | `source-catalog-0025` |

管理快照：`server/data/wechat-contracts.json`，包含参数、来源 SHA-256 和逐接口价格。公开目录：`shared/wechat-services.json`，不含采购信息。更新脚本：`node scripts/import-wechat-contracts.mjs <已下载的OpenAPI文件>`；数量、方法或定价发生变化时需要重新审查，运行时不能导入外部规格。

公众号包含普通/H5 文章详情、普通/H5 互动数据、评论、评论回复、相关文章、广告、账号资料、文章列表、自定义菜单。视频号包含账号信息、短 ID 转账号、作品列表/详情/评论/分享链接、主页资料、合集列表/视频、直播回放/详情、号内搜索。搜一搜支持综合及视频搜索。分享链接只返回已有作品链接，不发布内容。

## 下游合同与产品

```http
POST /api/v1/data/wechat/mp/article-detail-h5
Authorization: Bearer <HUB_API_KEY>
Idempotency-Key: article-query-001
Content-Type: application/json

{"params":{"url":"https://mp.weixin.qq.com/s/<文章标识>","raw":false},"deliveryMode":"live_only"}
```

请求需要 `social` 数据域与该接口独立能力，例如 `native.wechat.mp.article-detail-h5`。消费者授权、Key 快照和当前运行策略取交集。每个接口都有独立参数文档、调试入口、Hub 价格查询与原请求重放；切换页面标签或查看价格不会采集。

响应顶层返回 `contractVersion / endpoint / data / meta.capturedAt` 与 Hub `requestId`。业务 `data` 保留完整字段；服务方外层 docs、support、cache_url、请求 ID 等不进入下游响应。超过安全整数范围的整数按原始 JSON token 转成字符串，完整原始文本、字节和 hash 保留在受限归档；这只适用于新增微信合同，不改旧接口的数值语义。

新增微信的实时交付说明使用 Hub 数据服务语义，采购连接信息仅留在受限证据中；幂等重放仍返回首次保存的完整响应。

公众号提供文章阅读与列表结果视图，正文按纯文本呈现，不执行返回的 HTML 或自动加载媒体；完整 JSON 仍可查看。正文、互动与评论各是独立调用，不会隐式补查。未知结果保留原幂等标识，禁止自动创建新请求重试。

文档入口：`/docs/wechat-mp`、`/docs/wechat-channels`、`/docs/wechat-search`，每一具体接口有 `/native/wechat.…` 文档页；租户文档只展示同一 consumer 内满足平台与能力组合的合同。

## 价格与开通

[官方 OpenAPI](https://api.tikhub.io/openapi.json) 对 25 个正式接口逐项注明 **USD 0.01/次**；固定文章 demo 明确免费且缓存 1 小时。参考用户指定的[微信文档](https://docs.tikhub.io/472974860e0)及[H5 文章详情](https://docs.tikhub.io/511928397e0)。快照价格是公开基础采购价，不代表账户折扣或已发生的真实扣费。空搜索结果也可能是正常收费响应，不能用“没有结果”判断免费。

微信采购参考使用最新官方文档，批量开通提供独立的“载入微信官方文档价格（26 项）”按钮；与旧的部分账户快照分开保留来源和日期，其他接口原参考不变。客户看到的是既有 Hub 发布价格表和账户执行价，不公开采购价格，不自动把 USD 0.01 变成客户售价，也不自动更新已审核采购政策。原币 USD 0.01 = 1 cent；演示为明确零价，不是价格缺失。

明确免费的演示合同可通过零采购价审核与执行，采购调用记录不标记为供应方收费；该规则不改变下游套餐定价，也不允许正式接口省略已审核价格。

演示不享有 Key 或余额豁免：必须拥有 `social` 数据域及 `native.wechat.demo.article-sample` 精确能力，且接口已启用。使用普通 Hub 计费流程；强制计费时按客户当前有效报价预留余额，不足返回 `402 insufficient_credit`，未授权返回 `403`，均不发起采集。供应方采购免费不代表 Hub 客户价格免费；原请求幂等重放不重复扣款。显式零客户报价、shadow/disabled 计费仍遵循现有账户政策，不因本次接入而改写。

迁移 **118** 只注册 26 个 release 与初始 disabled 策略，`ON CONFLICT` 保留已有人工状态。按正常迁移器部署，再通过批量开通审查采购价格、客户价格、消费者授权与目标 Key 范围，并显式启用。发布代码本身不新建账户、不扩大授权、不改余额或历史账单。没有凭据或尚未审核时，新增操作不可调用，Hub 登录、存量查询和 MX-H2I 不依赖它们。

## 数据源目录与数据搜索

新合同通过稳定目录键绑定到已有三个微信平台，Admin 矩阵显示真实方法/路径、已实现状态、当前策略与采购参考；公共目录返回对应 Hub 产品入口。人工覆盖结论、接口实现、运行就绪和实测健康保持独立，不把目录接入冒充已经采集或入库。

数据搜索 → 产品展示增加 **微信专项搜索**，调用上述新合同，支持综合垂类、排序、发布时间和视频时长。搜索分页必须原样传回 `cursor` 并保留筛选条件，不能只递增 `offset`；公众号文章列表使用 `next_offset`。正常空结果与未知总数明确保留。跨平台与已收录模式保留原接口、游标和身份状态，专项结果不混进跨平台查询轮次。

当前转发保留完整请求交付归档，尚不把微信原生数据猜测成 canonical 文章，因此它不会自动出现在已收录全文搜索。后续入库需要按实际响应建立独立版本化映射、稳定文章/账号身份和清洗证据。微信实时搜索已从旧聚合连接器迁到新网关；专项搜索保持独立查询会话，已收录微信数据仍按原平台权限查询。

## 与线上旧微信搜索的区别

切换前，`/api/v1/search/raw` 与 `/api/v1/night-all/search/raw` 微信搜索通过 Hub 转发给 Night-All，再执行搜索。`standard_raw_payload`、字符串形式的 `raw_data`、`meta.endpointUsed`、`meta.stored.callId` 和 Hub 包装的 `mxnc1` 游标属于这条旧兼容链路；不是新 `/api/v1/data/wechat/search/search` 的响应合同。原 JSON 的 `req_…` 请求标识属于兼容响应，应通过 HTTP 的 `x-mx-insight-request-id` 关联 Hub 调用记录。仅有 JSON 无法判定当次是否为实时请求或历史重放。

2026-09-29 提供的线上样本把“全部、文章、账号、视频”等 17 个分类标签当成了 17 条内容，所有链接、作者和发布时间都缺失；HTTP 200 和 resultCount=17 不能证明获得了 17 篇文章。Night-All 的通用数组扫描会给 title 字段加分，并将 categories 数组送入内容转换；对仅含相同导航标签的合成输入，现有 normalizer 可复现此现象。样本没有原始业务响应，不能据此恢复文章或确定当时是否存在真实结果。旧接口还保留 source/sourceProvider 等供应方元数据。

本批直接转发保留业务 data，不经过该通用数组猜测。调用方需要精简搜索结果时可显式设置 `raw:false`，搜索文章可指定 `business_type:"article"`，分页使用返回 cursor。它不会修复已经交付的旧归一化数据。

## 2026-09-30 旧入口切换

| 入口 | 微信搜索行为 |
| --- | --- |
| `POST /api/v1/search/raw` | `wechat_search`（含 `wechat/weixin` 别名）和 `wechat_mp` 直接进入 `/api/v1/data/wechat/search/search` 的同一网关，返回新合同 |
| `POST /api/v1/night-all/search/raw` | 返回 `410 wechat_search_route_retired`，不执行、不回退，也不从此入口重放旧结果 |
| `POST /api/v1/data/search` | 微信分支进入同一新网关，返回新合同；`query` 映射 keyword，兼容 `type=fresh/stable`，两者均为永久幂等重放 |
| `POST /api/v1/data/aggregate/search` | 微信实时子请求调用新搜索，使用 `raw:false`，投影业务 `items`，每个来源每页一次调用；支持 `execution=hub_only` |
| 已收录搜索 | 按原 `wechat_mp/wechat_search` 平台权限查询；新实时权限不会扩展已收录权限 |

其他平台、crawl 与 user-info 的路由不变。源目录列出短路径、统一搜索、聚合搜索与 native 路由，旧 Night-All 能力矩阵移除微信实时操作。平台授权 `wechat_mp/wechat_search` 本身不能替代新操作需要的 `social + native.wechat.search.search`；新采购政策、Key 能力、客户价格与余额均走原网关，未配置时明确失败，不自动补授权或回退。

旧入口接受单个 `keyword`、`query` 或 `params.keyword`，同时提供时必须一致；`params` 使用新接口声明。`wechat_mp` 默认并限定 `business_type=article`，其他垂类用 `wechat_search`。旧 `count/pageSize/limit` 仅兼容默认提示 20，返回原生一页，不承诺 20 条、不截断或补页；其他值需要调用者改为新分页合同。`page>1` 必须带新 cursor。批量词、额外过滤器、自动补详情／评论等无法映射的控制返回 400，不能静默丢弃。显式 `includeDetails:false`、`includeComments:false`、`disableAutoDetails:true` 可保留。

```json
{"platform":"wechat_mp","keyword":"城市观察","params":{"raw":false}}
```

上述 `/api/v1/search/raw` 请求与新接口的 `{"params":{"keyword":"城市观察","business_type":"article","raw":false}}` 共用同一个业务指纹和 Idempotency-Key，跨路径重放不重复采集或扣款。`mxnc1` 游标返回 `400 wechat_legacy_cursor_retired`；仅 offset 翻页也拒绝。旧合同已用过的 Idempotency-Key 返回 409，不覆盖历史记录、不重复购买。需要重新采集时由调用者明确从首页开始并新建标识；旧交付仍可经请求历史查询。

## 聚合微信搜索（2026-09-30 后续更新）

```json
{"query":"城市观察","platforms":["wechat_mp"],"mode":"refresh"}
```

`wechat_mp` 固定文章分类，聚合条目类型为 `article`；`wechat_search` 为综合分类，按通用 `post` 搜索结果呈现。两者都是 `native.wechat.search.search` 的独立请求形状，同时选择会各调用一页、各计费一次；综合与文章结果可能重叠。需要更多分类/排序/时间参数时使用专项接口。关键词最多 100 字；聚合 `pageSize` 不改变实时一页，不截断、不补齐。数据源发现明确分开 `stored` 与 `refresh`；只有旧微信授权不能执行新实时搜索，只有新实时授权不能读取旧存量。

仅读取精简响应 `data.items`，绝不把 `categories` 当结果。标题高亮标签转为纯文本；大整数 docID 保留字符串；未提供的发布时间/指标保持空值，不从分类或标签推断。完整原生交付仍可用子请求 ID 查询，聚合投影不自动进入 canonical 存储。

分页读取 `continue_flag + cursor`，空页、no_more、缺失或重复 cursor 不继续购买。对外仍返回绑定当前 Key、查询和新路由的 `mxag1` 聚合游标；内部从已提交子请求恢复原生 cursor。每页新建父请求幂等 Key，同页重放或同一 continuation 换父 Key 不会重复购买子请求。旧微信聚合游标不可沿用，需显式发起新一轮；不回退 Night-All。

费用预览按新操作报价并读取当前运行就绪状态，不预留余额、不采集。执行时逐子请求检查精确权限、开关、额度和余额；父请求不另收费。失败在逐源状态中体现，不重试、不换源；其他来源可正常完成。

## 开放能力显示修复

原页面在 `compat.xiaohongshu.app_v2` 未就绪时，把全站 `operationReadiness` 的所有失败行都显示在同一单元格。现在服务器返回合同自身的 8 个实际接口；就绪状态也仅由其关联业务操作决定。页面默认显示接口数与就绪数量，详情折叠并提供文档/调试入口，业务操作列表增加搜索和每页 10 条的编号分页。
