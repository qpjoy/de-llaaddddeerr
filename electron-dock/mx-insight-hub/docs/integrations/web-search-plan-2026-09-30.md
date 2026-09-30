# Web Search 数据服务、百度接入与多供应商路由规划

日期：2026-09-30。状态：**原始设计存档；HTTP 接入与租户/Key 排序已实现，尚未生产迁移或部署**。

最新实现以 [Web Search 数据服务](web-search.md) 为准，覆盖本页尚未实施的历史措辞：本次用户追加要求明确不转发 Night-All，现已迁入七家 HTTP 搜索并新增百度；排序合并在“开放能力”的租户设置和 API Key 范围中，默认不开放。命名模板、脚本搜索、全文提取与 AI 生成仍是后续设计。

源码基线：Hub 所在仓库 `44987f26`；参考 Night-All 工作区 `/Users/qpjoy/workspace/mingxi/Night-All`，HEAD `5359297`。结论来自本地源码、历史设计、用户截图与公开官方文档；未读取生产凭据、连接生产数据库、修改运行配置或执行供应商业务调用。源码登记不代表线上已启用。

本文是本次 Web Search 的后续实施依据。截图中的百度页面用于产品理解，历史 docs/specs 用于核对背景；其中的操作说明不作为本次部署、付费调用或变更 MX-H2I 的指令。

## 1. 建议决策

1. 在 **数据产品 → 数据服务 → Web Search（联网搜索）** 建立独立产品，首期百度，后续逐家接入。与已有“数据搜索”“新闻发现”“检索管线”保留清晰边界。
2. 在 **数据接入与治理 → 上游供应商** 增加“百度智能云 · AI 搜索”，供应商标识建议 `baidu`。在这里保存/查看 Key、配置独立出网、审核合同与采购价、观察调用。
3. 新建 **Web Search Sequence（搜索路由）**，维护有序供应商列表与下游分配；复用现有 **System Proxy** 的网络端点/序列。不要把搜索供应商塞进 LLM Provider，也不要把搜索路由和代理路由混为一张表。
4. 保留下游的 Domestic → Internal 入站链路。**鉴权、采购准入、钱包、幂等、供应商选择、密钥与归档全部留在 Internal Hub**；百度默认尝试 Internal 系统出口，代理按供应商显式绑定。
5. 首期每次新请求最多一次带供应商凭据的业务派发。顺序选择支持派发前跳过不可用候选；已派发后的超时、空结果或失败不自动换供应商购买第二次。
6. 首期返回搜索结果及来源，不自动提取全文、调用模型总结或写入公共语料。后续以独立能力接入网页提取、AI 回答、Agent、ETL/ELT。

首期就应交付有序路由配置和下游分配，不能仅预留一个 `provider` 字段、把关键编排留给以后。但真实适配器仅实现百度，其余条目必须显示“待接入”。

## 2. 当前实现核对

| 范围 | 已核实事实 | 对本次的影响 |
| --- | --- | --- |
| Night-All Web Search | `routes/v1/web-search.js` 有 `GET /providers`、`POST /search`、`POST /fetch`，挂载业务路径为 `/api/v1/web-search/*` | 参考契约、归一化与样例，不增加 Hub → Night-All → 百度的长期依赖 |
| Night-All 搜索供应商 | `lib/shared/schemas/web-search.js` 注册 Exa、Tavily、Serper、You.com、SearchAPI.io、Firecrawl、SerpApi、web-search-skill；没有百度 | 百度需新增 Hub 原生适配器，不能标成已迁移 |
| Night-All 抽取/存储 | 搜索默认 `extractContent=true`；存在 Defuddle/direct fetch 及 `web_search_runs`、`web_search_results` 持久化 | 不照搬搜索后自动抓网页的副作用；历史存储迁移单列 |
| Night-All specs | `specs/NIGHT_ALL_RUNTIME_AND_BOUNDARIES.md` 明确记录 fetch 路径私网 IP、DNS rebinding、redirect 校验缺口 | 首期不暴露任意 URL 抓取，不直接复用该 fetch 路径 |
| Hub 迁移清单 | `server/data/provider-migration.mjs` 已把上述 Web HTTP 和本地工具登记为 `deferred`，没有可调用 Hub Web Search 合同 | 更新迁移清单时保持“源码线索/已实现/已启用/实测健康”独立 |
| Hub 百度目录 | `source-catalog-0135`，UUID `cb2bc950-7929-5cf9-9498-64638a2eac45`，名称“百度搜索”，类别“搜索引擎与开放网络” | 复用稳定 ID，不重复建立同名来源 |
| 百度目录种子状态 | `coverage=not_covered`、`delivery=exploring`、`runtime=unknown` | 这是仓库种子状态，不能推断生产目录当前值；本次不改为已接通 |
| 供应商管理 | `server/external-platforms/admin.mjs`、`credentials-store.mjs`、`src/pages-external-platforms.jsx` 已有供应商隔离、Key 保存和显式 reveal | 百度复用管理边界与现有 Admin Token，不新增管理身份 |
| 网络代理 | `server/external-platforms/proxy.mjs` 当前固定注册 TikHub、RapidAPI，支持独立绑定与凭据无关的探测；迁移 117 扩充了表约束 | 需增加百度固定 origin/probe 注册和数据库允许值；仅改 UI 下拉框不够 |
| Domestic 出口中继 | `server/external-platforms/egress-relay.mjs` 已有逐供应商 revision 管理，启信接入使用此类能力 | 是可参考的出口形态，不是默认把百度 URL 改写到 Domestic 的理由 |
| 产品/目录 | `shared/product-navigation.mjs`、`shared/product-workbenches.mjs`、`server/data/source-connections.mjs`、`service-catalog.mjs` 已关联产品、文档、接口与稳定目录键 | 需要一并登记 Web Search，不能只增加侧边栏页面 |
| 部署/身份 | Public `18150` 与 Admin `18151` 分离；Launcher opaque token 内省已有实现，Hub 自己管理 consumer/Key/授权 | 新服务不参与 Launcher 登录与网络准入 |

注意：`docs/operations/system-proxy.md` 的早期文字仍称“Agent 与 TikHub”，而当前代码已包括 RapidAPI；本文以代码为准。供应商单 Key store 当前存储 `api_key text`，**不能笼统宣称所有现有供应商 Key 都已经应用层加密**；已有 `StructuredExternalPlatformCredentialStore` 可复用 AES-GCM bundle。百度可以使用单字段 bundle，保持相同保存/reveal 体验，不在本批重写旧供应商凭据。

## 3. 产品与管理入口

### 3.1 用户侧产品

建议 URL：`/data-products/web-search`，文档 `/docs/web-search`。归属已有“数据服务”，不替换 `/data-products/search`。

| 入口 | 回答的用户问题 | 执行边界 |
| --- | --- | --- |
| 数据搜索 | 在已授权平台或已收录数据中找内容 | 保留现有聚合搜索合同 |
| Web Search | 在互联网上搜索网页、图片、视频 | 新的显式实时搜索合同 |
| 新闻发现 | 从 Hub 已收录内容发现新闻 | 不因本次接入变成实时网络搜索 |
| 检索管线 | 对已入库数据切分、索引与向量检索 | 不直接代表购买 Web Search |

产品页沿用 Neon Void 和现有身份选择，默认“接口调试”，另有“搜索体验”“接入说明”。搜索体验参考百度的大输入区、条件选择和结果阅读方式，但第一版仅呈现已实现能力，不放可点击的“深度思考/深搜索”假入口。

表单：查询词、已分配搜索路由、网页/图片/视频数量、站点、时间条件；百度专属版本项只在对应能力可用时出现。所有下拉采用共享 `DropdownField`。

结果：网页列表、图片视图、视频列表，展示标题、来源链接、片段、原始发布时间、实际返回数量、请求 ID 和交付时间；未返回字段为空，不编造摘要/日期/总数。图片只按现有产品媒体策略呈现已有 URL，不因显示结果后台抓正文。结果文本按不可信内容转义，链接拒绝脚本协议。

Admin 看供应商/出口/采购诊断；普通用户看可用路由、授权、自己的价格/用量和可用性。按用户此次要求，允许管理员为搜索渠道发布“百度”等展示名称；仅披露经发布的名称和能力，不暴露上游 Key、内部 Host、出口 IP、采购成本或全局候选清单。

页面打开、切换标签、续期短期凭据、切换结果视图不能产生搜索。发送按钮明确发起一次调用；网络结果不明时保留原 body 与 Idempotency-Key，另设“新建查询”用于确实要重新购买的请求。

导航、直接 hash 路由、产品发现与 OpenAPI 均按现有 `productScopes`/consumer/Key 权限交集过滤。只有 source-catalog 或 IP-risk 授权的用户不得因此看到可用 Web Search 工作台。

### 3.2 上游供应商

“百度智能云 · AI 搜索”卡片与其他供应商并列，详情包含：

- 合同：百度 Web Search、合同版本、已实现模态、未验证限制、启用状态。
- 凭据：已配置/未配置、数据库版本、保存时间、替换、显式查看已保存 Key。
- 出网：系统出口/继承/指定 Proxy Sequence，显示生效版本和脱敏连通性证据。
- 运行控制：disabled/shadow/canary/active/paused、采购价版本、并发/速率/预算。
- 观测：Hub 请求与上游派发分别统计；成功、有效空结果、无法解析、未知结果、replay 分开。
- 关联：“百度搜索”目录、Web Search 产品、搜索路由、对应调用记录。

没有验证余额 API 时显示“余额未接入”，不从已有请求数或免费额度倒推出余额；详情浏览不得触发鉴权或付费探测。

### 3.3 搜索路由管理

建议在“数据接入与治理”下增加“搜索路由”，路径 `/web-search/sequences`；供应商页和 Web Search 产品的 Admin 区提供快捷入口。System Proxy 继续保留现有入口，LLM Provider/LLM Sequence 继续只服务模型。

每条搜索路由支持命名、排序、启停、默认项、服务能力预览、consumer 分配和审计。复用 LLM Sequence 的交互模式，独立存储业务配置。拖动专用手柄排序，并提供上移/下移按钮；任何一次保存都需要 revision CAS，避免覆盖他人修改。

## 4. 数据源目录怎么标记

关联关系为：

```text
目录“百度搜索”(source-catalog-0135)
    ↕ 固定目录映射
供应商 baidu / 操作 web.search / 合同 baidu.web-search.v1
    ↕ 被搜索路由引用
产品 Web Search / Hub 公共接口
```

目录描述当前包含“网页/资讯/视频/图片/知道/贴吧结果”等广义范围。只接通 Web Search，不能把整个目录以及百度新闻、指数、贴吧等其他目录一并标为全覆盖。

状态按阶段记录：规划阶段 `planned + documented_only`；实现与离线测试通过后 `implemented + disabled + runtime unknown`；单次 canary 成功后只给对应操作记录时间化观测。覆盖度由操作者审核，优先标明“网页/图片/视频搜索已接，其他未核实”，不自动覆盖生产手工状态。

在 `source-connections.mjs` 的实际路由清单增加稳定映射，联通源目录 → 产品 → 文档 → 供应商管理。纯规划条目继续留在迁移清单，不能提前加入 `implementedRoutes()`。搜索 HTTP 供应商属于接入能力，返回结果中的具体新闻站点属于结果来源，二者不互相代替。

本轮只在本文登记关系；运行目录、seed 与生产数据库均未修改。

## 5. 入站、控制与出站链路

```text
外部调用方 ─HTTPS→ Domestic 数据 API 入口
                         │ 既有站点通道
                         ▼
Internal Hub Public :18150
  → Hub Key/授权/配额/价格/钱包/幂等
  → Web Search Sequence + 能力匹配
  → 选中供应商的出网绑定
      ├→ Internal 系统出口 → 百度
      ├→ System Proxy Sequence → 海外搜索服务
      └→ 可选 Domestic 出口代理/固定中继 → 指定供应商
  → 受限证据归档 + 下游响应快照 → 调用方

操作员 ─既有私网管理入口→ Internal Hub Admin :18151
  → 供应商 Key、搜索路由、Proxy 绑定、合同与价格配置
```

**Domestic → Internal 适合作为入站网关链路**：公共入口稳定，Internal 集中管理有状态逻辑。它不决定供应商的出网地理位置。Internal 直连百度是否更快/更稳，仍需目标运行环境的 DNS/TLS、延迟与业务实测，不能根据“国内 API”直接认定。

Domestic 只转发已审核的 Hub Public 方法/路径；不保存百度 Key，不运行选供应商逻辑，不进行 POST 自动重试，不转向 Admin、Night-All 或任意 upstream URL。扩展规则仅限新数据 API 的精确 location，不改 Launcher 用户、会话、AppCenter 既有路由。

机器下游只需要 Hub Key，不要求先登录 MX-H2I；Internal 内已有私网接入的调用方可以直接使用获准 Public 地址。浏览器工作台保留原 Launcher/Hub 会话路径，不新增百度登录。

首期建议技术预算（Hub 初始建议，非供应商 SLA）：请求体 64 KiB，完整响应上限 16 MiB，业务 HTTP 总 deadline 30 秒，总调度 deadline 60 秒（包含探测与归档预算），边缘超时需比内部预算留有余量。过大请求拒绝；响应超过上限显式记录不完整证据，绝不静默截断成功响应。冻结合同前用样例验证预算，并按现网边缘配置调校。

### 5.1 每个供应商独立出网

沿用 `inherit / system-egress / proxy-sequence` 三态；百度新增绑定默认 `system-egress`。不继承 TikHub 的 7788 绑定，不改变任何全局代理。这里的“系统出口”是 Pod/Node 当前路由；不等于物理直连、也不保证没有宿主网络设备。

代码注册表允许固定 origin 和不带凭据的 probe 目标。客户端不能传 `baseUrl`、代理地址、Authorization 或任意 headers。采用请求级 dispatcher，不设置全局 Node dispatcher、不写宿主 HTTP_PROXY、不调整 WireGuard/DNS/PAC。

两种 Domestic 出口方式按需选用：优先固定 CONNECT/正向代理，保留到百度的 TLS；若复用现有反向中继，须单独注册固定目的地、受限站点监听、禁重定向与脱敏日志，明确 TLS 在中继终止。二者不能用“代理 URL”同一字段混填，首期无需为了百度强行新增中继部署。

连通性探测与付费业务调用分离：probe 不带 Key/搜索词，固定 origin 有响应只表示网络可达；不等于 Key 有效、余额足够或能搜到数据。探测可在总预算内切换出口，已发送的业务 POST 不跟随切换。首次连通性未知可以执行这类固定探测，不能因为“未测试”永远跳过；如果不能可靠区分代理错误与目标响应，保守记录 unknown。

hostNetwork 的工作负载可能受 CNI 能力限制，不能仅凭 NetworkPolicy YAML 宣称实现完全隔离；需核验现有节点防火墙、监听地址与 Public/Admin 路由。此评估不要求改造客户端网络。

## 6. 供应商、Sequence 与下游分配

三种对象分工如下：

| 对象 | 配置内容 | 示例 |
| --- | --- | --- |
| Search Provider | 固定适配器、合同、凭据引用、可用模态/过滤器、采购计量、出网绑定 | baidu、未来 tavily/exa |
| Search Sequence | 有序候选、适用合同、启停、一次请求的派发策略 | `cn-default`: 百度；未来 `global-web`: Tavily → Exa → 百度 |
| Consumer/Key 路由分配 | 可使用的 Sequence、默认 Sequence、是否允许受控顺序覆盖 | A 使用中文优先，B 使用海外优先 |

示例名称与未来顺序只是配置样例，不构成对任何供应商质量/价格的排名；没有可执行适配器、凭据与已审核价格的候选不能上线。

配置建议包含 `sequenceKey, displayName, revision, state, steps[], maxPaidDispatches=1, defaultForBindings`；每个 step 持有 `providerKey + contractRelease + enabled`，网络出口引用该供应商自己的绑定。首期一供应商一凭据，标识独立于展示名；后续多账号再增加 profile 层，不现在重构全部供应商体系。

解析顺序明确为：

1. 校验 tenant、consumer、Key 状态及 `web_search + web.search` 权限交集。
2. 如果请求指定 `sequence`，必须属于该 Key 有效可用路由；否则依次用 Key 显式默认、consumer 显式默认、已分配的产品默认。没有默认就报配置错误，不自动选列表第一条。
3. 显式 route allowlist 是业务路由约束，不替代已有平台/能力授权；给 consumer 增加路由不得自动扩大已签发 Key 的路由快照。旧 Key 没有 Web Search 权限和路由绑定，不获得隐式访问。
4. 冻结本次候选顺序、请求合同、Sequence revision、允许出口范围与费用引用；开始有副作用前持久化到同一请求身份。
5. 按顺序校验候选合同是否能满足所有请求条件，再检查启用/凭据/已审核价/本地熔断/速率/采购准入；出口选择也计入总预算。
6. 派发前重新检查撤权和暂停，原子取得 provider 并发/成本 admission 并标记 dispatch_started；首次派发后不再尝试下一家。

管理员可为不同 consumer 保存不同顺序，普通下游只传已发布 `sequence`。如确有调用方自行调整顺序的需求，可额外开放 `providerOrder`：只允许重新排列所选 Sequence 内已发布给该 Key 的渠道 ID，不接受任意供应商/账号；必须单独授予 `web.search.route.select`，顺序进入指纹与审计。首期建议先交付保存的多条 Sequence 和下游选择；请求级临时排序列为第二期，避免与稳定路由一起增加首期验收面。

### 6.1 切换与失败语义

| 情况 | 可否选下一个候选 | 客户费用/证据 |
| --- | --- | --- |
| 尚未派发，候选停用、缺 Key、合同不匹配、采购价缺失或本地不可用 | 可以，按冻结顺序；记录 skip 原因 | 不形成该供应商业务采购 |
| 仅无凭据出口探测失败 | 可以，受总预算限制 | 与付费 dispatch 分开记录 |
| 已有当前请求匹配的完成快照 | 不调用任何候选 | 幂等回放；仍复核当前读取权限 |
| 上游返回有效空数组 | 不切换；正常空结果 | 按已公布的成功查询价格计，不伪装免费失败 |
| 已发送后 401/429/5xx、业务错误、重定向或无法解析 | 首期不切换 | 按固定错误/计费证据分类；HTTP 状态本身不能证明未收费 |
| 已发送后超时、断连、进程重启、提交状态不明 | 不重试、不切换 | unknown；保留必要 hold 和请求身份等待对账 |

后续如要“搜索 A 没结果继续 B”“多供应商融合”，应作为显式多采购模式，新增预算/价格说明和每次 attempt 证据，不改变首期单次派发语义。LLM Sequence 的重试规则不直接复制到付费搜索。

## 7. Hub 下游 API 草案

以下均为**拟新增路径**，当前不能调用。

| 方法/路径 | 用途 | 边界 |
| --- | --- | --- |
| `GET /api/v1/data/web-search/capabilities` | 当前 Key 的模态、过滤器、可用 Sequence 与限制 | 不探测供应商、不返回未授权渠道 |
| `POST /api/v1/data/web-search/search` | 长期推荐的 Hub 统一查询 | 供应商无关请求，固定 gateway |
| `POST /api/v1/data/web-search/compatible/baidu` | 迁移用户提供的百度请求体 | 固定百度合同、固定 baidu-only 路由，额外兼容能力授权 |

兼容入口保留百度业务字段形式，但不是任意 HTTP 透传代理；其响应仍明确使用 Hub envelope，不能宣称现有百度 SDK 只改 base URL 就完全兼容。两入口在同一调用身份、同一显式 Idempotency-Key、同一固定 `baidu-only` 路由及同义业务参数下，共用 acquisition/幂等与业务计费身份；不同投影从同一归档生成，不能因换入口重复购买。`cn-default` 多供应商路由不能仅因当前恰好选中百度就视为同一请求。指纹包含路由意图和所有影响上游请求的字段，存在行为差异时应报 409；显式新 Key 代表新请求，不因查询词相同就合并。

统一接口示例：

```sh
curl --request POST "$HUB_URL/api/v1/data/web-search/search" \
  --header "Authorization: Bearer $HUB_API_KEY" \
  --header 'Content-Type: application/json' \
  --header 'Idempotency-Key: web-search-example-001' \
  --data '{
    "query": "新能源汽车电池回收最新进展",
    "sequence": "cn-default",
    "resources": [
      {"type": "web", "topK": 10},
      {"type": "image", "topK": 5},
      {"type": "video", "topK": 3}
    ],
    "filters": {"sites": [], "recency": null}
  }'
```

`HUB_URL` 必须是实际已发布的 Hub Public 地址，`HUB_API_KEY` 是下游 Key；都不是供应商 Key。示例仅用于合同讨论，没有执行。

统一请求建议固定：非空 `query`、可选已分配 `sequence`、按资源类型去重的 `resources`、严格 `filters`。默认仅 web 10 条；`topK=0` 表示不请求该模态，所有模态为 0 拒绝。正整数范围来自当前合同，未知字段拒绝。过滤器 `recency` 与绝对日期区间互斥；日期使用明确的日粒度语义，不能暗示秒级精确过滤。站点是规范化的域名条件，不是让 Hub 访问的任意 URL。

统一请求必须由候选完整支持；无法满足图片、站点、日期或数量上限时跳过候选/返回能力错误。不能把 50 自动缩成 20，不能静默删除过滤器再声称完成请求。跨供应商 `standard/deep/advanced` 含义不通用；百度的 `edition` 暂由合同/路由配置或兼容入口指定，未来再定义有明确语义的通用质量档位。

建议响应：

```json
{
  "requestId": "<hub-request-id>",
  "data": {
    "contractVersion": "web-search.v1",
    "query": "新能源汽车电池回收最新进展",
    "items": [],
    "counts": {"web": 0, "image": 0, "video": 0},
    "pageInfo": {"supported": false, "nextCursor": null},
    "delivery": {"mode": "live", "observedAt": "<iso8601>"},
    "route": {"sequence": "cn-default", "revision": 1},
    "warnings": []
  }
}
```

这是有效空结果的**结构示例**，不是已调用数据。每条 item 保留 `id/type/title/url/site/snippet/publishedAt/media`，ID 限定于请求，不把供应商的局部引用序号当全局网页 ID。缺失日期为 null，无法解析的日期保留原始值与说明；分数只作来源内参考，不能宣称跨供应商可比较。

供应商业务扩展信息以版本化允许字段保留；完整原始响应保存在受限归档，兼容入口 `data.references` 保留合同内业务字段，不把响应截成只剩 title/url。上游 request ID、采购证据与网络详情留在 Admin 诊断。

首期没有官方分页合同就不暴露假 cursor/总结果数。`topK` 是上限而非交付保证；查看下一页已返回结果只能做本地分页，不能静默重新调用。未来分页必须把 provider/合同/Sequence revision/过滤器/Key 绑定到 opaque cursor，旧游标不能送往不同供应商。

公共错误建议稳定区分：400 参数/合同不支持、401 Hub Key 无效、403 业务或路由未授权、409 幂等或配置版本冲突、429 Hub 本地限流、503 无可用路由、502 上游交付不可用、504 结果未知的上游超时。供应商自身返回 401 不转换成“Hub Key 无效”。错误 DTO 包含 `requestId`、稳定 code、是否允许同 Key 查询原请求的说明；完整供应商错误与原因归类留在受限证据中。不得通过 `retryable=true` 暗示未知付费调用可以重新派发。

## 8. 百度适配合同与原始 cURL 的处理

首期固定 `POST https://qianfan.baidubce.com/v2/ai_search/web_search`，按用户提供的 `Authorization: Bearer …` 接入。固定目的地、方法、路径、JSON 类型，禁止自动重定向；上游认证头由服务端构造，绝不把下游 Hub Authorization 原样转发。

公开官方资料核对：[百度搜索 AppBuilder 文档](https://ai.baidu.com/ai-doc/AppBuilder/pmaxd1hvy) 列出 `standard/lite`、web/image/video 上限 50/30/10，返回 `references`，日期过滤有模态限制。原始示例的几个处理点如下，属于 Hub 拟议校验策略：

| 输入 | 处理 |
| --- | --- |
| 空 `messages[0].content` | 拒绝；工作台要求实际查询词 |
| 多轮 messages | 统一接口只接受 query；兼容入口首期只接受单条 user，明确报不支持，不静默丢弃历史 |
| 空 `site: []` | 作为无站点限制，省略上游 match |
| `gte/lte` 都为空 | 省略 range；只有一端有效则拒绝，避免误以为过滤生效 |
| `search_recency_filter: noTimeLimit` | 视为控制台“不限”的兼容输入并归一化为省略；目前读到的官方枚举未列此值，不能直接当合法上游值透传 |
| `edition: standard` | 百度合同内保留；不映射成通用“深搜索” |
| 自定义日期并请求非网页资源 | 首期统一合同拒绝无法保证的组合；待验证模态语义后再扩展，不声称所有模态都受日期约束 |
| 未核实参数/阿拉丁 | 首期不开放；以后版本化增加 |

拟议兼容入口可直接承接以下整理后的请求体；这里使用 Hub Key，由 Hub 替换为保存的百度 Key：

```sh
curl --request POST "$HUB_URL/api/v1/data/web-search/compatible/baidu" \
  --header "Authorization: Bearer $HUB_API_KEY" \
  --header 'Content-Type: application/json' \
  --header 'Idempotency-Key: baidu-compatible-example-001' \
  --data '{
    "messages": [{"content": "新能源汽车电池回收最新进展", "role": "user"}],
    "resource_type_filter": [
      {"type": "web", "top_k": 50},
      {"type": "image", "top_k": 30},
      {"type": "video", "top_k": 10}
    ],
    "edition": "standard"
  }'
```

这里只省略无效占位条件，保留用户希望的三种资源与数量；上限不保证实际返回足量。工作台默认采用更小的 10 条网页请求，只有用户明确选择才发上述规模。该入口和命令目前均为规划，未实现或执行。

上述上限、版本和日期说明来自可读取的 AppBuilder 官方页面，**仍需冻结当前千帆合同后做样例验证**。本次发现新版官方目录指向 [千帆 API 百度搜索](https://cloud.baidu.com/doc/qianfan-api/s/Wmbq4z7e5)，但正文抓取超时；旧页面头部使用 Authorization，末尾示例又出现 X-Appbuilder-Authorization。因此以用户给定 Authorization 作为首期预期，不双发认证头、不在鉴权失败后自动换头重试。实施时核验账号所用产品/Key 类型和新版字段，完成一份脱敏成功/空/错误样例后再启用。

采购价、免费额度、限流、错误是否收费、标准/精简版价格差异均作为发布前证据项，本次不把历史网页价格或免费调用次数写进默认客户套餐。

## 9. 凭据、授权、计费与持久化

### 9.1 凭据与查看

复用 `/internal/v1/admin/external-platforms/:provider/credential` 保存以及 `.../credential/reveal` 查看流程，注册 `baidu` 服务。使用现有 Structured store 的单字段 `apiKey` bundle，服务层解包后只交给百度适配器；不修改已有 plaintext 供应商的存储或 pepper。

reveal 要求当前 Admin Token principal，并再次提交 Admin Token 校验；响应 no-store，明文只在短暂弹窗中展示，关闭清空，不写 localStorage、普通 DTO、请求预览或日志。数据库/解密错误只返回脱敏状态。记录 metadata-only 保存/reveal 审计；不要把共享 Admin Token 虚构成实名操作者。无 Key 或解密失败仅阻断百度能力，不阻断 Hub readiness/Launcher 登录。

### 9.2 授权与价格

新增数据域 `web_search`、能力 `web.search`；兼容入口额外要求 `web.search.baidu-compatible`。读能力发现仍必须检查当前业务授权。产品只是这些权限的展示/销售组合，不再建立冗余产品访问 gate。

客户每次成功逻辑搜索最多计一次；采购每次真实 dispatch 分别记录。有效零结果是否收费需要在客户合同中明确，建议按成功查询收费。兼容与统一入口不重复占钱包，不将 Admin Token 当成免费业务 Key；Admin 工作台使用已有受控演示身份与普通消费链路。

采购报价按 provider/operation/edition/合同版本和原币保存，客户价来自现有 immutable plan。缺价格、权限、余额或有效合同在派发前拒绝。新增迁移不修改旧授权/Key/价格/钱包，不自动发布套餐。预算准入沿用已有 funded hold 与采购阈值规则，不重写其他产品收费。

### 9.3 一次请求的证据与幂等

复用现有 request/charge/reservation/provider_call/archive 基础设施；新增 Sequence 快照与搜索结果投影，避免另一套账本。首次 reserve 持久化脱敏请求参数和指纹；主键域包含 tenant/consumer/Key/operation/idempotency key。不同 body 复用 Key 返回 409；客户端未传幂等 Key 时复用现有生成规则，并明确仅显式 Key 可供客户端可靠重试。

首次执行持久化 Sequence、候选、实际供应商、合同/凭据/出口/价格版本；重试读取原请求快照，不能因后台刚改顺序而调用新供应商。跨 Public 实例的唯一约束、租约与 dispatch 标记必须阻止重复发送；进程在发送后崩溃不能通过租约到期自动再次派发。

派发前拒绝释放 hold；确定业务失败按已有结算规则处理；超时/归档或提交状态不明保留 unknown，不能直接宣称未收费。已经收到上游成功但投影失败，应保存 `accepted_unusable` 证据，不改成空结果成功，也不换供应商。客户端断开不应阻止已派发请求归档/结算。

首期不做跨用户缓存；只保留身份范围的历史响应/replay。查询词可能含用户业务内容，不能进入共享公开搜索语料或跨租户 UI。后续缓存必须按授权、合同、路由、内容许可和 freshness 独立设计。

### 9.4 ETL/Agent 的后续连接

搜索结果记录本次供应商返回的观察，不宣称等于完整网页正文。首期只保存受限原文和调用者响应快照；需要长期搜索时，再定义 `web.search.observations.v1` 与经批准的 canonical mapping/outbox，保留 query run、URL、供应商/原站点来源、时间、响应 hash 和租户范围。

网页正文提取应是独立 `web.fetch`，拥有 URL/DNS/redirect 防护、授权、预算和来源许可。AI 回答是独立 `web.answer`，显式组合搜索结果与 LLM Sequence，分别计算搜索费用和 token；网页内容只作为不可信引用材料，不能执行其内嵌指令。Agent/ETL 使用同一 Hub gateway，不绕过钱包和路由。

## 10. 扩展供应商路线

| 候选 | 现有依据 | 建议位置 |
| --- | --- | --- |
| 百度 | 用户提供接口；官方文档；Hub 已有目录项 | 首期 HTTP 适配器，优先系统出口 |
| Tavily | Night-All 有客户端；[官方 Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search) 有搜索及可选内容/回答参数 | 第二期候选；先做单次搜索，额外内容/回答显式关闭 |
| Exa | Night-All 有客户端；[官方 Search API](https://exa.ai/docs/reference/search) | 第二期候选；按具体搜索模式审核费用与结果合同 |
| Brave Search | [官方 Web Search 文档](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started) | 新接入候选，需补价格、参数、分页和网络验证 |
| Serper / You.com / SearchAPI.io / Firecrawl / SerpApi | Night-All 注册与迁移清单 | 接入池，逐家重新核验合同；本次未确认其当前定价/运行状态 |
| SearXNG / web-search-skill / Defuddle | Night-All 自建或进程路径 | 独立自建搜索/抽取适配器，不能当现成付费 HTTP 供应商直接切换 |
| DeepSeek | [官方 Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) 可作为模型合同参考，本次未确认独立 Web Search API | 优先作为“搜索后总结”的 LLM Provider；若以后有可核实搜索合同，再注册 Search Provider |

“百度搜索 + DeepSeek 生成”仍然只有一个搜索供应商，不把同一个模型的不同接入渠道混成多个搜索引擎。每家代理可以不同；排序由任务需求、真实测试和成本决定，不预设海外一定优于国内。

## 11. 实现拆分与文件落点

优先沿用模块化单体，不新建独立微服务。建议以下交付顺序：

| 阶段 | 可验收产出 | 启用条件 |
| --- | --- | --- |
| P0 契约冻结 | 当前百度请求/返回/错误/价格证据、目录关系、OpenAPI 草案、离线样例 | 文档与 mock 验证；不调用真实供应商 |
| P1a 服务执行 | 百度适配器、统一/兼容入口、Key 管理与 reveal、独立代理、Sequence 与 consumer/Key 分配、采购/钱包/归档 | 所有新操作默认 disabled；可离线全链路运行 |
| P1b 完整产品 | Web Search 产品、搜索体验、目录链接、供应商卡片、搜索路由页面、接口说明 | 与 P1a 同一个可交付版本，不能只有后端接口 |
| P1c 灰度验收 | 已有身份显式授予最小范围、录入 Key/审核价格、单次业务验证、链路观测 | 只开启指定 consumer canary，保留旧 Key/用户/网络配置 |
| P2 多供应商 | 第二个真实适配器、能力匹配验证、按客户不同顺序；可选受控临时顺序 | 每家独立凭据/价格/网络；不自动批量启用 |
| P3 扩展产品 | 网页提取、AI 回答、Agent tool、经批准的 canonical/ETL 接入 | 独立权限、成本、隐私与运行验收 |

建议文件分工（新增文件名可在实施时调整）：

| 落点 | 改动 |
| --- | --- |
| `server/contracts/web-search.mjs`、`web-search-docs.mjs` | Zod/固定合同、统一与兼容投影、OpenAPI 和样例 |
| `server/adapters/baidu-search.mjs` | 固定 HTTP 目标、认证构造、deadline、体积限制、错误/业务响应解码 |
| `server/web-search/sequence-store.mjs`、`router.mjs` | revision 路由、下游绑定、能力匹配、派发前选路与审计 |
| `server/web-search/gateway.mjs` | 接入现有授权/幂等/采购/钱包/归档链路，单次派发 |
| `server/external-platforms/{admin,proxy,structured-credentials}.mjs`、`server/index.mjs` | 注册百度独立服务、凭据 bundle、固定出网目标；保留原服务行为 |
| `server/app.mjs`、`server/public-docs.mjs`、能力/计费目录 | 新路由、当前 Key 的能力发现、按授权投影文档 |
| `server/data/{source-connections,provider-migration,service-catalog}.mjs` | 稳定目录关联、状态与实现登记；不提前标记线上健康 |
| `shared/product-navigation.mjs`、`product-workbenches.mjs` | 数据服务下产品与文档映射 |
| `src/web-search-product.jsx`、`web-search-sequences.jsx`、现有供应商页 | 搜索体验、API 调试、有序路由、Key/代理/审计入口 |
| 新增 migrations | 百度空凭据元数据/禁用操作、Proxy 约束、Sequence/steps/bindings/audit；编号以实施时最新状态为准 |
| `tests/server/` | 百度合同、权限隔离、路由顺序、代理、exact replay、未知结果/收费、产品文档可见性 |

数据库只新增必要控制表与搜索投影：`control.web_search_sequences`、steps、bindings、events；绑定设计覆盖 consumer 和 Key 快照。已有 provider settings/credentials、Proxy bindings、operation controls、price books、usage/archive 表继续复用。动态供应商目录与固定代码适配器之间必须校验注册关系；保存一个名称不等于可执行任意 URL。

引用中的供应商/Proxy/Sequence 不能直接删除；停用影响新派发，历史快照保留。迁移必须保留既有 binding/价格/授权，CAS 冲突返回可解释错误。迁移序号、索引与外键在编码时按现有 schema 核对，不在规划里假定表已创建。

## 12. MX-H2I 不回归与上线验证

**所有功能变化限于 Hub。** 不修改 Launcher/MX-H2I 登录、opaque token 内省合同、用户表、session、飞书/密码/访客流程、权限语义、ProductNetwork、地址段、WG peer/route、DNS、PAC、NRPT、resolver 或网络 ownership。Luopan 继续是独立测试产品，不变成 Hub 执行器或网络前置依赖。

| 验证 | 通过标准 |
| --- | --- |
| 离线百度合同 | 非空词、各模态上限、空条件归一化、非法组合/未知字段拒绝；正确、空、错误、大响应、超时样例覆盖 |
| 顺序/能力 | mock 至少两候选证明排序、显式默认、跳过不兼容；不得靠插入顺序选默认或忽略站点/数量要求 |
| 一次派发 | 已发送后的 401/429/5xx/超时/解析失败/进程恢复都没有第二次 paid dispatch；proxy probe 不算 paid call |
| 幂等/计费 | 并发同 Key/body 一次采购；换 body 409；改 Sequence 或出口后旧请求仍只回原快照；钱包不重复扣费 |
| Key/reveal | Admin 二次验证、no-store、无日志泄漏；租户/机器 Key/普通 Launcher 会话不能读取上游 Key |
| 旧供应商 | TikHub/RapidAPI/JustOne/启信现有凭据、Proxy、价格、授权、成功路径保持；未配置百度时 Hub 正常启动 |
| 产品/目录 | source-catalog-only 用户无搜索执行权限；授权用户能从目录到产品和文档；点击页面与切页无后台采购 |
| 入站隔离 | Domestic 新路径只到 Public，Admin 不可由公共路由访问；超时/客户端断开不触发边缘重试 |
| 身份/联网 | 既有登录、续期、AppCenter 打开、MX-H2I 连网及 Luopan 独立通道按原回归基线通过；Hub/百度故障不影响这些路径 |

实施时先跑新单元/HTTP 合同测试，再跑相关 `identity`、`demo-credential`、`external-platform-*`、`tenant-docs`、`source-catalog-provider-visibility`、`product-workbench` 回归和 build/typecheck；UI 用本地 mock 验证桌面/窄屏，不借开发预览调用生产供应商。真实 MX-H2I 登录和联网验收使用现有测试基线，不为测试重置用户配置。

上线顺序：可向后兼容迁移 → Hub 后端/前端且操作保持 disabled → 核验 Public 路由 → 管理端录入 Key/价格/Sequence → 指定 consumer canary → 单次结果与账本对账 → 扩大范围。保存 Key 不自动启用操作。只有现场执行这些步骤后才能把状态改成“已上线”。

回滚：暂停新搜索操作/Sequence，停止新派发并等待已发请求完成归档/结算；回退 Hub 应用版本，保留新增控制记录、钱包与请求证据。只撤本次新增的数据入口规则；不回滚整个 Domestic/Internal 网关、不重建用户 Key、不回放未知请求、不重启 MX-H2I 网络。

## 13. 本轮交付与仍待确认的证据

本轮交付此详细规划、Hub 文档索引和 Launcher 集成边界说明；没有新增运行 API、修改目录数据库或部署配置。已确认 Night-All 的可复用实现与 Hub 的百度目录身份，方案可进入 P0/P1 开发。

发布前仍需补：新版百度完整合同/认证头实测、脱敏响应与业务错误样例、当前采购价格/免费额度规则/错误收费证据、实际 Internal 出口表现和现网 Domestic 精确 Public 路由。其余设计默认已在本文给出，不要求先修改 MX-H2I 或等待海外供应商确定才能开始首期实现。

相关仓库设计：[供应商迁移](night-all-provider-migration.md)、[数据搜索](../product/data-search.md)、[System Proxy](../operations/system-proxy.md)、[Internal 部署](../operations/internal-k8s-deployment.md)、[Launcher/Hub 边界](../../../mx-launcher/docs/26-mx-insight-hub-integration-architecture.md)。
