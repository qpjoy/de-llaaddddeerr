# 三个社交接口由 Hub 接管的评估

2026-09-30 已授权的微信例外：`/api/v1/search/raw`、`/api/v1/data/search` 与聚合微信实时子请求转入新 Hub 搜索；只有显式 Night-All 微信搜索入口停用。新权限、参数、返回、游标和幂等边界见[微信接入说明](../integrations/wechat-services.md)。以下其他平台仍适用原评估，本地代码切换不代表生产已部署。

日期：2026-09-28。以下为原始源码评估基线，后续实施状态见下一段；尚未切换生产路由。

后续用户决策：保留现有转发入口，另建三个 Hub 独立接口，覆盖完成后由下游显式切换。本文件以下保留最初评估基线；当前第一批实现及未覆盖项见 [Hub 独立社媒接口](../integrations/hub-social-data.md)。新增 Twitter HTTP 适配器和聚合 `execution=hub_only` 为本地实现，默认禁用，未切换生产、未完成全平台替代，也未验证供应商当前在线合同。

基线：Hub 所在仓库 `31176898d30a94d7b4512b777aff2e43869ddeee`；Night-All `/Users/qpjoy/workspace/mingxi/Night-All`，`5359297fbe46674664ebb56479bb375d6e6faf74`。本次只读代码、既有设计和用户提供的故障日志；没有访问 Internal、生产数据库或付费采集接口。截图和历史 docs/specs 用于理解需求，运行能力以源码与实际调用证据分别核对。

## 1. 结论与范围

Hub 可以成为三个接口的独立实现方。当前还不能停用 Night-All：已有直连传输、权限、计费和存储基础，但多数平台的兼容投影、分页和复合采集仍依赖 Night-All。没有发现这三个接口必须依赖 Night-All 应用本身、无法迁出的技术能力；需要保留的是业务行为、采集适配器与状态。

优先目标是：下游已经调用 Hub 的 `/api/v1/search/raw`、`crawl`、`user-info` 时，保持路径、输入、输出和调用身份不变，按平台、操作和请求形状把内部执行从 Night-All 替换为 Hub。既有 `/api/v1/night-all/search/*` 别名也保留。聚合搜索复用同一套底层能力，不再建立另一套重复的供应商编排。

必须区分两种“完全脱离”：

- **现有 Hub 三个兼容接口脱离 Night-All**：边界明确，可逐项实现；当前平台/操作登记为 raw 14、crawl 10、user-info 8，共 32 个组合，每个组合还有单/多账号、分页、补详情等形状。
- **所有原本直连 Night-All 的业务迁走、Night-All 整体下线**：范围更大。原服务还有多平台请求、显式 provider、历史采集、Web 搜索、任务/Agent、其他详情/评论接口以及数据写入消费者，不能由三个路径迁完推断全部可关闭。

现有 Hub 禁止客户端选择 provider/endpoint/凭据，以及 archive 等高成本参数，要求单个显式 platform；原 Night-All 暴露的范围更宽。旧直连调用方需要核对真实请求、鉴权和幂等头，不能保证只改域名就全部兼容。已在 Hub 内的执行器切换可以做到调用代码无变化。

## 2. Twitter 的实际处理链

默认链路：

```text
下游 → Hub 兼容接口 → Night-All HTTP 服务（部署端口 13141）
     → Node runProcess → Python unified.py → twitter-aio.p.rapidapi.com
     → Python 解析 → Night-All 标准 raw 响应 → Hub
```

`provider-registry.js` 默认 Twitter 为 `rapidapi`，请求可在 Night-All 层显式覆盖；Hub 公共兼容入口不开放该控制。`raw-search-service.js` 在 RapidAPI 分支派发 `search_posts`，账号动态/资料也各自分派 RapidAPI。运行时实际 Python 入口由 `crawlers/china_social/unified.py` 的 `CRAWLER_MAP` 确定。

| 业务操作 | 实际 Python 实现 | 本地源码使用的 twitter-aio 接口/行为 |
| --- | --- | --- |
| raw 关键词搜索 | `GetCommentByKeywords.py` | `GET /search/{URL 编码后的查询}`；count、category、includeTimestamp，非空 cursor 和可选 filters |
| crawl 账号帖子 | `GetUserContent.py` | ID 使用 `/user/{id}/tweets`；用户名使用 `/user/-1/tweets?username=...`；保留 cursor |
| user-info | `GetUserInfo.py` | `/user/by/username/{name}` 或 `/user/users/by/ids`；另有 `/user/about/{name}` 补资料 |
| 历史/最早帖子 | `GetEarliestUserTweets.py` | 按日期窗口构造 from 查询，循环关键词搜索和分页、去重与排序；可先查账号创建时间 |

这些路径是本地实现事实，不代表已重新验证供应商当前合同或运行健康。Twitter 主路径是 HTTP API 采集，检查到的上述三个脚本没有要求启动浏览器。把这些 HTTP 请求、参数构造和解析迁为 Hub 的 Node 适配器在技术上可行。

**twitter-aio 是通过 RapidAPI 调用的具体 API 服务，二者不是两个自动互备的供应商。** RapidAPI 的 Host 头用于标识所调 API，Key 对应应用身份；因此接入目录应记录到“渠道 + 具体服务/Host + 操作 + 合同版本”，而非登记一个 `rapidapi` 就认为所有服务都可调。[RapidAPI 官方鉴权说明](https://docs.rapidapi.com/docs/configuring-api-security)。各服务订阅、限额和采购价格仍需单独核对。

TikHub 的 Twitter 搜索端点也有本地注册，但不在上述默认 RapidAPI 调用后自动接替。`provider-fallback.js` 当前关闭 TikHub → JustOne 的跨供应商回退；候选端点循环、客户端重试、活动类型回退仍存在，不能把“跨供应商回退关闭”理解成每次只发一个 HTTP 请求。Facebook 还存在按操作不同的默认值：raw 由 manifest 选择 RapidAPI，账号资料/内容默认 JustOne。

### 2.1 对此前两次故障的意义

| Hub requestId | Night-All requestId | 用户提供的故障证据 |
| --- | --- | --- |
| `23b19584-7ee1-42be-a093-2b696ce6a6c5` | `req_muk2jwea_6e364208` | twitter-aio HTTP 400 → 子进程 exitCode=1 → CRAWLER_COMMAND_FAILED |
| `46c9f2dc-730f-465c-8975-dc9bb86af88b` | `req_muk2m4u9_df2be4a5` | 同上；另一 supplier requestId |

这是上游 HTTP 请求被拒绝后逐层包装的错误；这两次不属于 Hub 已迁移的 TikHub/JustOne 直连分支。仅有 `400, bad request` 不能区分 Night-All 参数与供应商现行合同不符，还是供应商内部返回 400。原样迁移同一请求不会消除该错误。迁移验收前应核对实际编码后 path、脱敏 query、Host、供应商合同和成功样本。

### 2.2 性能与隐藏的请求次数

Python 不是必然很慢；当前实现的额外工作是每次执行启动进程、导入模块、建立进程内 Session、JSON/标准结果转换，以及 Hub ↔ Night-All 的网络往返。连接可以在一次 Python 执行内复用，但该 Session 不能跨子进程复用。采用 Hub 常驻 HTTP 客户端可以消除这部分重复工作，并减少一个应用故障点。

不能从两次约 2.7/5.2 秒的失败耗时推算 Python 占比或承诺减少几秒。没有供应商、进程启动、解析、排队和落库分段数据；当前证据只证明收到 HTTP 400，并非进程超时。

更值得控制的是多次上游调用：

- raw 搜索脚本总量上限 200、单次页上限 50，未达到请求数量且有游标时会继续请求；count=20 也不保证永远只请求一次。HTTP 400 不进入该脚本的连接错误重试分支；连接类错误默认最多再试一次，可配置至两次。
- 账号资料可能在主要资料请求后补 `about`；其连接类错误最多尝试五次。账号帖子脚本最多尝试三次，含 HTTP 错误和 429 分支的等待。
- 大量账号帖子可以分块执行；历史采集还会跨日期窗口循环。异步分块和 Python 内部重试可能叠加。不能把这些行为直接带入 Hub 的“一次原生派发”合同。
- `local-crawler-execution-service.js` 把 `upstreamCallCount` 设为 1，代理回退时设为 2，并覆盖 Python 输出中的同名字段。该数值不能完整代表 Python 内部实际 HTTP 尝试次数，不能直接作为采购实际调用量。

建议每个真实 HTTP 尝试记录独立 attempt：父 Hub requestId、operation、Host/endpoint、provider requestId、起止时间、状态、是否已派发及成本证据；串联排队、连接、上游响应、转换和归档耗时。用相同输入/地区/出口/缓存条件分别比较首屏、续页、账号资料、账号帖子 p50/p95，明确成功与失败样本，不混用子进程数与 HTTP 数。移除 Night-All 的收益需要实测；供应商慢和错误仍需单独治理。

## 3. 与当前《数据聚合搜索》的关系

截图 1 的“数据搜索”产品与截图 2 的“聚合数据搜索”使用同一组 aggregate API 和共享搜索组件，是同一能力的不同入口。

当前 `aggregateSourceCatalog()` 和 `refreshAggregate()` 的真实组成：

- 14 个社交逻辑平台调用 Hub 的 `data.search`；小红书的已迁移形状可直连，其余多数内部仍依赖 Night-All。
- 5 个商品市场调用 `ecommerce.products.search`。授权满足时，合计就是截图的 19 个实时平台；不是 19 个已摆脱 Night-All 的采集器。
- stored 查询 Hub canonical/索引；既有清洗源有入库记录不等于有实时采集接口。
- 实时每个继续执行的源获取一个合同窗口，并发 3；支持逐源状态和不透明续页。120 秒预算停止新增派发并等待已派发工作结算，不是到点强制中断所有请求。
- 原生目录中新加一个端点，不会自动加入关键词搜索。详情、资料、评论、榜单等接口无法只凭 keyword 调用；现有实时聚合也不接受不能可靠执行的日期/tag 过滤。

因此，应把新 RapidAPI、Web 或爬虫能力加入共享执行层，再让 aggregate 选择其中“可关键词检索”的操作。`crawl` 和 `user-info` 是独立的账号能力，不能用聚合关键词搜索替代。

Hub 当前已有 1037 个 TikHub/JustOne 原生固定接口标识（757 + 280，代码导出核对），但仅完成固定请求和原生交付；不等同 1037 个已上线/获授权/实测健康的接口，更不等同 1037 个统一搜索适配器。目前未找到 Hub RapidAPI/twitter-aio 或 SearXNG 执行适配器。目录可见、合同实现、策略启用、真实健康应分别展示。

## 4. 三个接口必须覆盖的能力

| 接口 | Night-All 当前提供的关键行为 | Hub 现有基础 | 接管剩余工作 |
| --- | --- | --- | --- |
| raw | 平台默认 provider、keyword/query 映射；排序和时间条件；候选端点；平台结果解析；可选补详情/评论；分页、去重、批量关键词与标准 raw_data | 固定供应商请求、治理链；小红书窄形状直连；aggregate/canonical；旧合同校验 | 为每个迁移形状补参数及投影适配、首次/续页一致性、详情子调用预算；RapidAPI 传输尚缺 |
| crawl | 用户名/ID/URL 解析；平台活动类型；账号帖子分页；部分资料来源；缓存/锁；服务端游标；部分成功；更大工作量的分块/任务能力 | 小红书单账号 posts 等已迁移形状；归档/幂等/权限/费用；其余兼容转发 | 各平台身份解析和请求图、raw_info + raw_data 的字段一致性、去重/停止条件、可恢复状态；大任务另行规划 |
| user-info | 多种账号标识、批量资料、字段统一；头像/主页/粉丝等；Twitter about 补查；平台候选端点 | 小红书窄形状；其他原生资料端点与统一治理 | 身份别名、单/多次调用区分、缺失/不存在/部分失败语义，以及 raw_info 投影 |

三个接口共用且不可丢失的行为：

1. **交付合同**：`data.raw_info`、`data.raw_data` 是 JSON 字符串，不能直接换成数组或供应商原生 data；保留 page/meta、计数、warnings、空结果/部分失败区别。Twitter/Facebook 保留无标题规则、完整正文、媒体和作者字段，不重写历史交付。
2. **连续查询状态**：抖音 cursor + search_id + backtrace、Night-All 的服务端游标/缓冲、Hub `mxnc1` 等必须逐形状核对。旧游标仍路由旧执行器，不能把一个供应商游标交给另一个执行器，也不能失效后自动花钱重搜第一页。
3. **缓存与重放**：鲜度、精确匹配的旧快照回退、调用者范围、幂等回放及失败结果都要保持明确；实时 aggregate 不混入未声明的旧数据。首次切路由不改已提交请求的响应快照。
4. **费用与错误**：一次业务请求可能对应多次采购；共享业务调用不能由兼容层和 aggregate 重复收费。保留上游状态/code、跨层 requestId 与受限诊断；未知结果不触发自动重试或付费切换供应商。
5. **落库与来源**：Night-All 的 RapidAPI/TikHub 调用、内容、账号写入，在新路径中由 Hub 原始归档、canonical/outbox 接管。若其他系统还读取旧 Night-All 表，仅迁 HTTP 响应不能关闭该写入依赖，必须另行对账和迁移这些读者。

现有 Hub 的身份、Key、采购治理、钱包、配额、归档与 canonical 能复用；不应重新造一套。Night-All 的批量/档案/任务能力并非全都能经当前 Hub 合同触达：首轮验收只覆盖 Hub 已接受形状；原直连客户用到的扩展能力另列合同，避免把“兼容迁移”变成静默缩减或自动扩大权限。

## 5. 自建工具与 SearXNG 的位置

Night-All 的 `web-platform-search-service.js`、`web-provider-clients.js` 和 bundled `web-search/scripts/web_search.py` 提供另一条 Web 搜索链：Web HTTP 供应商、自建 SearXNG、Bing RSS、DuckDuckGo，以及可选正文提取。bundled Python 脚本默认引擎为 Bing RSS + DuckDuckGo；支持 SearXNG 不代表每次默认使用它，是否线上启用仍需配置/调用证据。

SearXNG 已有 HTTP `/search?q=...&format=json`，Hub 可直接连接独立实例，须在实例中启用 JSON；无需为这一步保留整个 Night-All，也无需在每次 Hub 请求时再启动 Python。此判断依据其官方 HTTP 合同，不是对当前服务器可用性的确认。[SearXNG Search API](https://docs.searxng.org/dev/search_api.html)。

建议区分三类执行：

| 类型 | Hub 接入方式 | 业务归属 |
| --- | --- | --- |
| TikHub、JustOne、RapidAPI 具体服务、Web HTTP API | 固定 endpoint 的常驻 HTTP 适配器，复用 Hub 凭据/预算/证据 | 供应商操作，可组合成社交搜索、资料、商品、网页等产品 |
| 自建 SearXNG 等已有服务 API | 受控内网 HTTP connector | Web 搜索能力；结果 URL/摘要不冒充社交完整帖子或用户资料 |
| 真实浏览器/登录态爬虫、依赖 Python/CLI 的抽取与长任务 | 独立常驻 worker 或受控任务运行环境，由 Hub 编排与归档 | 工具/采集操作，再组成数据产品；避免阻塞 Hub API 进程 |

这些 worker 可以属于 Hub 的部署和治理体系，“Hub 负责”不要求所有语言和浏览器跑在同一个 Node 进程。纯 HTTP Twitter 路径优先直接改为 Node；复杂爬虫是否重写按依赖和实测收益决定。网页检索与正文提取分开核算；原有 Defuddle/direct 等降级策略单独审查，不隐藏成一次纯转发。

## 6. 数据源目录与产品组织建议

沿用现有目录身份、权限和操作模型，增加明确关联，不建一套互相冲突的分类：

| 维度 | 示例 | 作用 |
| --- | --- | --- |
| 内容来源/发布平台 | Twitter、小红书、某新闻站 | 用户理解数据从哪里来，稳定 catalog ID |
| 供应商/交付渠道 | RapidAPI 下的 twitter-aio、TikHub、JustOne | 管理侧凭据、采购价格、Host、版本、健康 |
| 工具与执行环境 | SearXNG 服务、网页抽取、浏览器 worker | 描述如何获取/处理，不冒充内容发布者 |
| 业务能力 | 内容搜索、账号资料、账号帖子、网页搜索、正文提取 | 固定输入/输出、过滤能力、分页与授权 |
| 数据产品 | 数据搜索、账号画像、账号内容流、新闻发现、专题数据集 | 组合能力，定义交付和新鲜度；同一来源可用于多个产品 |
| 运行方式 | live / stored / scheduled / asynchronous | 区分本次采集、已有记录、周期采集和后台任务 |

每条可执行绑定记录 `(平台, 操作, 请求形状, 合同版本, 执行器版本)`、支持的筛选/页上限、成本模型和最近调用证据。人工“已覆盖”状态不自动开放接口；新增 RapidAPI 服务不自动授予原 Key 权限。客户看 Hub 的业务平台/能力/自己的价格，供应商凭据、采购和路由细节留在管理面。

## 7. 共用执行层与无感切换

```text
旧 raw/crawl/user-info → 兼容参数与响应适配 ┐
现有 data.search / aggregate → 查询编排  ├→ Hub 业务能力执行层
新业务数据产品 → 产品编排                ┘   ├→ TikHub / JustOne / RapidAPI HTTP
                                            ├→ 自建服务 / crawler worker
                                            ├→ Hub 已收录数据
                                            └→ Night-All（未迁移形状）
```

这是目标设计，不是已经实现的新路由。外层可有不同响应形状，底层传输、语义解析、授权和采购证据共享；不要通过内部 HTTP 调用另一条公共 API 而重复预留/计费。

切换条件：

- 每个形状先做离线 golden 对照：输入、上游映射、raw 字段、空结果、错误、首屏/续页、计数和费用证据。不要求新旧 provider 返回同一批实时内容，但要求已冻结样本的语义一致。
- 已归档响应和模拟上游用于影子比较，生产只执行一条付费链。把原来隐藏的重试/补页显式列入计划；无法确认是否已收费时不自动发第二次请求。
- 新查询固定路由版本；旧游标、在途请求、幂等重放保留原执行器。回滚只切之后的新查询，已签发新游标仍需被新执行器服务至结束/过期；不能把新游标强送回 Night-All。
- 保留现有 Hub Key/授权/价格/账户，不把“供应商迁移”当成修改 MX-H2I 身份的理由。新操作需要明确开通，不能因为目录变多而扩权。
- 对原直连 Night-All 的应用逐一核对 base URL、认证、businessId 归属和 Idempotency-Key。可使用受控接入适配逐步过渡，不把 Night-All 原有密钥直接当成 Hub Key，也不承诺账号与入口零配置迁移。

## 8. 推荐实施顺序及退役门槛

| 波次 | 交付 | 退出条件 |
| --- | --- | --- |
| 0：合同和样本 | 固定现有 32 个平台/操作组合，按实际流量拆请求形状；补生产动态端点目录差异，核对 Twitter 400 的请求与供应商合同 | 默认路径、批量/补详情、分页、缓存和旧数据库读者均有清单；不把静态清单当全量 |
| 1：Twitter | Hub RapidAPI/twitter-aio transport；优先 raw 单关键词首屏/续页，再 user-info 的 ID/用户名/about，最后有限账号帖子 crawl；三种入口和 aggregate 复用适配器 | 对应形状的离线对照、采购/错误合同、幂等/授权回归通过；真实 canary 成功后按形状切路由 |
| 2：其余社交 | 利用已有 TikHub/JustOne 固定合同补语义层；先高频单次搜索/资料，再账号解析、补详情和复杂 crawl；Facebook 按操作迁移不同 provider | 各支持形状保留交付、分页、缓存和账务；无隐含候选端点/重复收费 |
| 3：Web 与自建能力 | SearXNG HTTP、Web 供应商、正文抽取和必要的 worker；登记可搜索能力加入现有 aggregate | 网页结果/正文和社交数据类型区分；请求预算、来源证据、错误/分页与目录绑定完成 |
| 4：退出搜索依赖 | 停止为已迁移形状新建 Night-All 请求，等待旧游标/在途工作耗尽；保留历史响应；迁移确有需要的旧库读者 | 代表性业务周期内不再有这些形状的 Night-All 调用，回滚与故障演练通过，且无旧状态/数据读者依赖 |

大规模档案采集、Agent/意图搜索、独立详情/评论接口不作为普通 Twitter 首屏直连的前置条件。是否随后退役整个 Night-All，取决于这些独立业务及采集写入是否也已迁出。

本次只新增评估文档和索引；不修改运行代码、现有路由、权限、价格、密钥、部署或 MX-H2I/Launcher 登录及联网。数量通过本地注册表只读导出核对，未执行生产验收或付费性能测试。

## 9. 源码与相关设计

Hub 源码路径相对项目根目录：

- `server/hub-service.mjs`：`nightAllCompatibilitySearch()`、`search()` 和 aggregate 调度；小红书窄形状分流，其余兼容路径。
- `server/contracts/night-all-legacy.mjs`、`server/data/night-all-compat.mjs`：平台/操作、JSON 字符串响应、接受/禁止参数与页数边界。
- `server/data/aggregate-search.mjs`：14 社交 + 5 商品、共享业务执行、授权和续页。
- `server/contracts/native-forwarding.mjs`：当前 1037 个固定合同及单次请求边界。

Night-All 源码路径相对上述独立仓库根目录：

- `lib/domains/search/providers/provider-registry.js`、`raw-search-service.js`、`provider-fallback.js`；`lib/domains/data-capability/manifest.js`：默认供应商和按操作分流。
- `lib/domains/search/local-crawler-execution-service.js`、`crawlers/china_social/unified.py`：实际进程派发、脚本映射、错误与计数。
- `crawlers/twitter/rapid/GetCommentByKeywords.py`、`GetUserContent.py`、`GetUserInfo.py`、`GetEarliestUserTweets.py`：具体 HTTP、重试、解析和多页/时间窗。
- `lib/domains/search/rapidapi-twitter-crawl-service.js`、`rapidapi-twitter-user-activity-service.js`、`social-crawl-service.js`、`user-activity-service.js`、`user-info-service.js`、`standard-payload.js`：分块、账号、游标及标准 raw 合同。
- `lib/domains/search/web-platform-search-service.js`、`web-provider-clients.js`；`lib/domains/agent/skills/web-search/scripts/web_search.py`：Web 与 SearXNG 路径。

相关：[数据搜索产品](../product/data-search.md)、[聚合搜索](aggregate-search-and-source-routing.md)、[Night-All 迁移库存](../integrations/night-all-provider-migration.md)、[官方接口合同](../integrations/official-provider-services-2026-09-27.md)。
