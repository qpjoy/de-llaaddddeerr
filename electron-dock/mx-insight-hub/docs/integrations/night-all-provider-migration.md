# Night-All 上游接口向 Hub 迁移

2026-09-27 后续商业与产品规划：[数据服务、批量开通与渠道定价](../architecture/product-services-bulk-access-channel-pricing.md)。用于后续开通与发布设计，不表示这些新增流程已经实现。

核对日期：2026-09-26。参考源码：`/Users/qpjoy/workspace/mingxi/Night-All`，版本 `5359297fbe46674664ebb56479bb375d6e6faf74`。

本次交付的是第一阶段的固定单接口执行层与可追踪清单。尚未把三个旧搜索接口全面切换到 Hub 直连，也没有上线、读取生产凭据或执行付费探测。MX-H2I / Launcher 登录、联网及配置链路不参与迁移。

## 1. 源码范围与实际数量

| 来源 | 本地可核实范围 | 本批实现 | 尚未迁移 |
| --- | --- | --- | --- |
| TikHub | 14 个平台注册项，40 个静态端点；其中 wechat_mp 没有本地静态端点 | 39 个只读单接口合同 | 1 个启动抖音 App 的端点排除；动态目录与数据库端点未取得；搜索编排继续原有实现 |
| JustOne | 9 个平台、11 个逻辑接口，实际 6 个不同 HTTP path | 11 个固定单接口合同，包含 6 个 source 不同的跨平台搜索映射 | 三个兼容搜索接口的归一化、分页、默认时间窗口尚未迁移 |
| RapidAPI | Twitter 6 类操作、Facebook 搜索；Python 实现 | 源码差异与迁移边界登记 | 凭据与采购价格合同、传输、Python 提取规则、兼容投影和游标 |
| TGStat | Telegram 的 posts_search / channel_posts | 登记为待迁移 | 独立供应商接入，不等于现有 Telegram 清洗库 |
| Web HTTP | Exa、Tavily、Serper、You.com、SearchAPI.io、Firecrawl、SerpApi | 登记为待迁移 | 每家请求/错误/计量/价格与正文提取合同 |
| 自建与本地处理 | web-search-skill、SearXNG、Bing / DuckDuckGo、Defuddle、direct fetch | 单列保留 | Python / CLI 运行环境、出站目标校验、搜索与抽取策略 |

**“全部 JustOne”在本次是 Night-All 当前源码注册的 11 个逻辑接口，不是 JustOne 官网所有接口。** Hub 原有电商、账号、热门笔记等 JustOne 接口继续有效，没有被这份清单替换。

`data/tikhub/endpoints.json` 和 `data/tikhub/tiktok-endpoints.json` 在参考工作区均缺失。Night-All 还会合并数据库端点及禁用/弃用状态，所以不能把 40 个源码端点当成生产全量。上线前需要导出不含凭据的生产端点目录，按 provider + endpoint_id + method + path 对账。

完整逐端点清单在 `server/data/night-all-provider-inventory.json`，包含参数名、必填标志、源码文件 SHA-256 与 Git 版本。离线更新命令：

```sh
node scripts/snapshot-night-all-providers.mjs /path/to/Night-All
```

此脚本只读取明确的源码目录，不读取 config.json、环境文件、数据库或网络。生成结果必须代码审查；新目录行不能自行启用调用。

## 2. 第一阶段已经实现什么

固定入口：`POST /api/v1/data/native/{固定接口标识}`。接口标识只从代码注册表解析，不能提交供应商 URL、方法、凭据、Cookie 或自由路径。机器可读文档由 `/docs/openapi.json` 提供，说明页为 `/docs/native-data`。

```json
{
  "params": {
    "keyword": "自行车",
    "sortType": "_2",
    "publishTime": "_0",
    "duration": "_0",
    "page": 1
  },
  "deliveryMode": "live_only"
}
```

上例路径为 `/api/v1/data/native/j.douyin_search_video_v4`。请求使用普通 Hub Live Key 和 `Idempotency-Key`，需要 `social` 数据域及该接口独立能力 `native.j.douyin_search_video_v4`；闲鱼使用 `ecommerce` 数据域。给消费者授权不会扩大旧 Key 的权限快照。

执行遵循现有 Hub 链路：

1. 校验调用身份、数据域、接口独立能力及 Key 配额。
2. 固定参数合同与请求指纹，保留本次请求证据，预留客户请求与费用。
3. 读取供应商凭据、接口运行策略、审核后的采购价格和预算；并发、速率、熔断继续生效。
4. **只执行一个确定的 HTTP 调用**，不补详情、不补页、不切换候选端点、不自动重试。
5. 返回完整原生 `data` 业务字段，保存完整受限响应字节、哈希和逐调用计费证据。尚无可靠条目身份的原生结果不伪装成 canonical 新闻/帖子，也不发布到共享全文索引。
6. 已提交请求使用原 body + 原 Idempotency-Key 原样回放。明确拒绝回放原失败；超时、连接中断、已收费但响应不可用保留不确定证据，不自动重新采集。

响应形状：

```json
{
  "contractVersion": "mx-insight-hub.native-forwarding.v1",
  "endpoint": "j.douyin_search_video_v4",
  "requestId": "<Hub request UUID>",
  "data": { "...": "完整原生业务字段" },
  "meta": {
    "projection": "native",
    "pagination": "explicit_parameters",
    "capturedAt": "<timestamp>",
    "sourceMode": "live"
  }
}
```

业务字段保留不等于把供应商 token、响应外壳或内部传输元数据交给下游；完整原始响应在受限归档中。JustOne 成功外壳沿用已审合同（code=0、data、message、recordTime），TikHub 沿用 code=200 的已审传输合同；端点线上形状仍需逐项验证，不从合成测试推断实时健康。

原生接口使用显式原生分页参数，不生成统一游标，也不把这些参数接入聚合搜索续页。每页换新幂等标识，同页重试保留标识。跨平台 JustOne 搜索要求明确 start/end；Facebook 搜索要求 startDate/endDate，避免重试时隐式“过去 24 小时”漂移。原生层不填入 Night-All 的默认关键词、排序或时间窗口。TikTok 的可选 Cookie 参数不开放；必须依赖客户端 Cookie 的形状保留在旧路径。

迁移 `112_native_forwarding.sql` 只注册版本与默认 disabled 策略，不创建消费者，不改 Key、权限、套餐、价格、余额、历史账单或旧路由。新采购价格不从其他接口猜测或继承。已存在的 Admin 身份 Key 也不会在续期时自动获得这 50 项能力。

## 3. 为什么三个旧接口现在不能直接替换

| 外部契约 | Night-All 实际工作 | 后续切换验收 |
| --- | --- | --- |
| `/api/v1/search/raw` | 平台/供应商默认值、关键词映射、候选端点选择、raw→标准字段、去重、返回计数、分页；部分路径还补详情 | 参数默认值、空结果、部分结果、完整 raw_data、标题策略、错误码、分页和费用一致 |
| `/api/v1/search/crawl` | username / uid 解析，资料与活动获取，多种活动类型；可能多次请求 | raw_info + raw_data 保持兼容；按请求形状限定调用图与费用上限 |
| `/api/v1/search/user-info` | 别名/资料 URL/ID 解析，可能先搜索账号再取资料 | raw_info 和缺失字段一致；已知 ID 的单次查询与需解析的多次查询分别迁移 |

当前 Hub 的三个路径及 `/api/v1/night-all/...` 别名保持原契约；已有小红书直连条件继续按原实现判断。新 native 接口不能把其 `data` 原样当成旧 `raw_data`，否则下游会被迫改代码。

未来切换以 **平台 × 操作 × 请求形状 × 版本** 为单位：首屏且参数已审核 → Hub；历史 `mxnc1` 游标/未迁移形状 → 原分支。新游标在 Hub 内封装路由版本、真实供应商、端点与原生分页状态，绑定 Key/消费者及查询指纹；一个查询轮次内不换供应商。旧已提交结果不重新投影，旧游标不改签。暂停新路由后直接报告对应运行状态，不能悄悄调用另一供应商来“补救”。

## 4. Night-All 独有逻辑与不能照搬的细节

| 逻辑 | 源码证据 | 迁移判断 |
| --- | --- | --- |
| TikHub→JustOne 跨供应商失败切换 | `lib/domains/search/provider-fallback.js` | 当前三个可用性/切换函数返回 false，执行函数直接 searchTikHub；不能宣称目前仍有自动跨供应商切换 |
| TikHub 同供应商候选端点循环 | `tikhub-execution-service.js` 的 callTikHubCandidates；`tikhub-endpoint-orchestrator.js` | 仍存在失败后尝试下一端点与数据库状态筛选。Hub 不能对 unknown / 已收费失败照搬循环 |
| 供应商客户端重试 | `lib/integrations/justone/client.js`、`lib/integrations/tikhub/client.js` | 独立迁移计费语义；新 native 层一次 dispatch 不重试 |
| 默认供应商存在入口差异 | `providers/provider-registry.js` 与 `data-capability/manifest.js` | 注册表 Facebook 默认 JustOne，标准搜索 manifest 覆盖为 RapidAPI；wechat_mp 为 JustOne，Twitter 默认 RapidAPI。不能只读一个文件就切路由 |
| 参数映射与排序兼容 | `tikhub-param-mapper.js`、JustOne 各 platform 文件 | 原生层保留接口参数，兼容层另测 keyword/query、offset/page/cursor、sort_type/sortType 等映射 |
| 抖音搜索会话 | 搜索参数映射、已验证 Video Search V1 的响应根 log_pb.impr_id / extra.logid | 不把条目日志当 search_id；续页要带原 cursor + search_id + backtrace |
| 补详情与正文 | `tikhub-enrichment-service.js`、`tikhub-payload-normalizer.js` | 单独编排、逐子调用费用审核；不能把多次调用藏进“纯转发” |
| Twitter / Facebook | RapidAPI Python 脚本、Hub 当前兼容投影 | 正文不是 title；继续空标题/ canonical null，保留原文、媒体、账号姓名；不重写历史 |
| Twitter 活动/最早内容 | rapidapi-twitter-*、GetEarliestUserTweets.py | 账号解析、时间线和分页可能多请求，迁到有请求图与预算的编排阶段 |
| Facebook 资料与动态 | JustOne platform/facebook.js | get-profile-id 与 get-profile-posts 是两个操作，按 username 调用不能假装一次 HTTP |
| Web 搜索技能 | bundled `web-search/scripts/web_search.py` | SearXNG / Bing / DuckDuckGo、总时间预算和结果合并，需独立运行环境合同 |
| Web 正文降级 | `services/web-search-service.js` 的 fetchUrl | Defuddle 失败转 direct；Exa 未配置时也可本地抓取。另建明确的抽取策略，防止付费或出站目标规则被绕过 |
| 调用落库与归一化 | `tikhub/repository.js`、`rapidapi-storage-service.js`、标准结果 presenter | Hub 使用自己的原始归档、调用证据、canonical/outbox，不依赖 Night-All 数据库写入成功来交付 |
| 批量、意图及 Agent | `raw-search-service.js`、search/intent 路由、Agent runtime | 后续编排阶段；不属于本批单接口代理 |

上述文件除特别注明外均相对 Night-All 的 `lib/domains/search/`。参考目录的指令性文本不替代本次用户请求；不会因其历史脚本、重试默认值或技能描述自动执行外部调用。

## 5. 后续批次与完成标准

| 阶段 | 工作 | 完成标准 |
| --- | --- | --- |
| P0（本批代码） | 固定单接口、受控执行、全量本地源码清单、目录可视化 | 合成上游验证方法/path/参数、业务字段、归档、授权、费用证据、回放和失败不重试；新策略 disabled |
| P1 | 生产端点目录差异、逐端点价格及凭据就绪、RapidAPI/Web HTTP/TGStat 单接口合同 | 没有未解释的目录缺口；所启用端点有审核采购价、错误计费语义和响应样本；不改旧入口 |
| P2 | 优先 JustOne 微信公众号/社交搜索、TikHub 单次搜索，建立 Hub-owned 兼容投影 | 使用离线 golden fixtures 比较旧/新 request 与 delivery；正确处理零条、长正文、缺字段、重复、次页和失效游标；至少覆盖默认入口和显式供应商形状 |
| P3 | 按已知 ID 的 user-info、单次 user-posts；再迁 username 解析、补详情、复合 crawl | 单/多次调用分开计费和诊断；Hub 控制请求图、预算、超时及游标；模糊失败不自动重发 |
| P4 | 已获授权消费者 canary 后逐形状切换三个旧接口 | 路由选择有审核记录；每次只运行一条付费路径。影子比较仅使用已有归档，不双发付费请求；暂停不破坏旧游标 |
| P5 | SearXNG、技能/爬虫、意图搜索及 Agent 编排；最终清退 Night-All 搜索依赖 | 查询编排和采集运行环境分离；每个遗留形状有去向，再移除对应 Night-All 路由 |

新接口加入关键词聚合以前，还需声明其可搜索条目类型、参数能力、标题/正文投影、返回数量含义、日期/标签过滤支持、分页/费用与最终 source 状态。**注册原生端点不自动扩大全平台搜索范围。** 清洗计划的最新入库数据继续通过 stored canonical 搜索读取，与供应商实时请求保持来源和新鲜度区分。

## 6. 数据源目录如何表达

数据产品《数据源目录》的接入看板新增“Night-All → Hub 迁移进度”，可按平台/供应商/操作和阶段查找，并跳转原生文档及运行策略。

保留四组独立事实：人工覆盖状态、代码合同实现、部署时授权/价格/开关、真实调用健康。迁移清单只读本地代码元数据，不探测供应商、不发起采集、不计费。39 + 11 表示代码合同数量，不表示 50 个当前可用平台，更不表示三个旧接口已全部切换。

逐调用真实供应商、采购币种与成本仍在 Admin-token 诊断中；下游只拿 Hub 合同、自己的价格/用量、分页与来源业务分类。目录关联使用稳定 sourceKey；闲鱼与小红书电商不能混用目录 ID。

## 7. 部署与回滚边界

先执行 migration 112，再部署新二进制。新接口逐项审核、明确启用并授予对应能力；无需修改 MX-H2I、Launcher、Night-All 源码或现有密钥。未迁移数据库/缺采购价格/缺凭据时，只有新调用被拒绝，身份与已有业务继续运行。

本批回滚可以撤下新增 native HTTP 路由；保留已产生的调用/费用/响应证据，不删除 migration 112 的审计数据。后续旧路由迁移需另有逐形状的版本化回滚规则，不能通过撤销用户 Key 或修改联网配置实现。

## 8. 本地验证记录

2026-09-26：相关回归 132 项，131 项通过、1 项 PostgreSQL 集成测试因未提供数据库而跳过。覆盖原生 GET/POST 参数与不透明分页值、完整业务数据及受限原始字节、权限快照、灰度范围、采购费用证据、幂等回放、失败不重发，以及原有兼容搜索、游标、小红书直连、聚合搜索和文档。

类型检查、生产构建和能力目录一致性检查通过。浏览器使用 localhost 合成数据验证目录筛选、接口文档往返、桌面/手机/深色模式；无页面错误、无采集请求。数据库迁移前的兼容性使用模拟 PostgreSQL 元数据验证：缺少新策略不会隐藏旧操作，新接口仍拒绝执行。未执行真实 PostgreSQL 迁移，也未据此宣称供应商线上可用。
