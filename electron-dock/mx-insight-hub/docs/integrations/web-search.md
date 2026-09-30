# Web Search 数据服务

日期：2026-09-30。原始设计见 [规划](web-search-plan-2026-09-30.md)；本页记录当前实现与启用步骤。本轮产品界面修订为源码交付，未部署、执行真实供应商调用或更改生产授权及采购配置。

## 交付范围

Hub 自己直连百度、Exa、Tavily、Serper、You.com、SearchAPI、Firecrawl、SerpApi。请求不会进入 Night-All。后七家来自 Night-All 已有 HTTP 搜索能力，迁为 Hub 的固定地址、独立凭据、预算、授权和归档合同，不承诺旧响应形状完全相同。

百度支持网页、图片、视频；其他七家当前只提供网页检索。源码适配器和合成测试不等于真实账号已验收。DeepSeek 尚未注册成虚构的搜索供应商；后续在获得独立 Web Search 合同后新增适配器。Night-All 的 web-search-skill（Bing RSS / DuckDuckGo / SearXNG 编排）、Defuddle/direct fetch、历史运行记录迁移和 AI 答案生成仍单列后续阶段，未偷偷回退到旧进程。

## 管理员在哪里配置

1. **数据接入与治理 → 上游供应商 → 对应供应商**：保存 API Key；凭据加密落库，常规响应不回传明文。“查看 / 复制”需要再次输入 Admin Token。保存 Key 不会查询或启用接口。
2. 同一供应商详情里的 **System Proxy** 网络设置：沿用共享代理端点/序列，独立绑定该供应商。迁移 119 给新供应商默认 `system-egress`。只影响此供应商的 HTTP 出站；不会改变机器代理、DNS、WireGuard 或客户端网络。
3. **开放能力 → 租户授权 → Web Search**：选择租户，勾选渠道、上下移动排序，填写原因并预览。确认后同一事务同步租户配置、调用者授权和所有已有 Key；移除会展示逐把 Key 的影响并要求勾选确认。“调用者”页保留前往该工作区的入口。
4. **API Keys → 签发 / 调整权限**：只能勾选当前调用者已授权的渠道。可保存自己的排序，或点击“沿用租户顺序”。旧密钥、到期日和历史计量保持原值；更新带旧范围和旧排序的比较检查。
5. **上游供应商 → 上游平台操作控制 / 批量开通**：审核采购单价、币种和预算，设置 disabled/shadow/canary/active。所有新操作迁移后为 disabled，没有默认采购价、客户价或自动授权。对客户统一使用 `web.search` 计费项，供应商采购预算分别计算；同一计费项不允许在一批中设置不同销售价。审核单价需覆盖实际允许的资源数量和 edition。

没有新增独立 Search Sequence 管理页。当前搜索序列就是租户默认有序列表，以及 Key 的可选覆盖列表，放在授权时一起设置；LLM Sequence 和 System Proxy Sequence 继续独立管理。以后可在此模型上增加可复用的命名模板。

## 默认权限与“千人千面”

**默认不全部开放。** Admin 可见已登记的供应商；新租户和新 Key 默认没有 Web Search 使用权。“选中当前可授权供应商”只保存当时的显式范围，不包含未来新增供应商。

运行时要求同一个调用身份同时具备：

- `web_search` 数据域；
- `web.search` 业务能力；
- 被选渠道的 `web.search.provider.<key>` 能力。

每一项都受 Consumer 当前授权与 Key 当前快照的交集限制。按 2026-09-30 的用户补充要求，保存租户授权会为所有已有 Key 补齐当前已选权限（也可用于补齐历史 Key），并把历史 `legacy_dynamic` Key 转为明确快照。仅移除上次租户配置中存在、这次取消的项；Key 和 Consumer 的其他独立授权保留。移除需预览和明确确认，完成后立即阻断该渠道的查询和旧结果回放。详见 [租户授权同步](../operations/tenant-access-sync.md)。

顺序：Key 有独立顺序时优先使用，否则沿用租户顺序；已经获授权但未出现在排序中的渠道按登记顺序追加。排序不能授予权限。产品导航和直接路由受业务授权控制；租户 OpenAPI 按租户授权过滤渠道，当前 Key 的精确可用列表由 capabilities 返回，调试器进一步按 Key 过滤。

例如：租户授权 `[tavily, baidu]` 后，新签 Key A 可仅选百度，Key B 可选两家。下次显式保存该租户授权时，所有已有 Key 都会补齐当时的已选范围；独立 Key 顺序保留。仅登记 Exa 不授予权限，管理员把 Exa 勾入租户并确认保存后才同步到已有 Key。

## 产品展示与排障

Web Search 默认进入“接口调试”，并提供独立的“产品展示”和“搜索渠道与接入”。三个面板复用产品工作台布局，隐藏面板不会混入当前视图；接口名称与长路径分行显示。

产品展示提供大搜索框、授权渠道选择、网页/图片/视频勾选，以及数量、站点、日期、时间范围、Standard/Lite 筛选。仅发送公开合同支持的参数，不静默丢弃不支持的条件。示例按钮只填写问题；打开页面、切换页签、查看价格、刷新渠道状态和筛选已有结果都不会搜索。界面只呈现真实响应的摘要与来源链接，不生成虚构答案、缩略图或 VIP 状态。

同一 Key 的表单、结果与请求标识保留在页面会话内。临时签名凭据续期不重置请求；更换 Key 则重置产品视图。成功、空结果和失败都保留原请求标识，重试复用它；“新建相同查询（再次发送会计量）”仅清除该意图，仍需再次点击搜索。调试成功的搜索结果也可在产品展示中阅读。

判断是否需要重新授权应以当前 Key 的 `/capabilities` 为准：

- 渠道列表为空：核对该 Key 与 Consumer 的数据域、搜索能力及渠道权限。旧 Key 缺权限时可单独调整 Key，或经租户保存预览补齐所有旧 Key。
- 已显示授权渠道，但 `ready=false`：授权已经生效，不需要重复保存租户。管理员应在“上游供应商 → 对应渠道 → 上游平台操作控制”核对 `web.search` 的运行模式、凭据、采购单价和预算；保存供应商 Key 不会自动启用操作。
- `ready=true`：表示当前预派发检查通过，不保证后续网络、余额、额度或预算检查一定成功。发送时仍由服务端复核。

本轮只读核对时，LCY-delta 已列出 8 个授权渠道，百度密钥已配置，但百度 `web.search` 仍停用且预算未配置。该观测不能作为未来状态保证，也没有据此替管理员填入采购价格或启用接口。

## 下游 HTTP 合同

| 方法与路径 | 行为 |
| --- | --- |
| `GET /api/v1/data/web-search/capabilities` | 无供应商调用，返回当前 Key 的渠道、顺序、资源类型及就绪状态 |
| `POST /api/v1/data/web-search/search` | Hub 统一搜索请求与响应，必须提供 Idempotency-Key |
| `POST /api/v1/data/web-search/compatible/baidu` | 百度请求形状输入，仍返回 Hub 统一响应；单条 user message |

```bash
curl "$HUB_URL/api/v1/data/web-search/search" \
  -H "Authorization: Bearer $HUB_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: search-order-example-001' \
  -d '{"query":"人工智能","limit":10}'
```

省略 `provider` 按当前授权顺序选择；指定 `"provider":"baidu"` 只调用百度。网页默认 10 条；百度 web/image/video 单类上限 50/30/10，总请求结果量仍受 Key 页大小限制。使用 `resources:[{"type":"web","limit":50},{"type":"image","limit":30},{"type":"video","limit":10}]` 时不要再传 `limit`。

百度专用选项：`edition:standard|lite`、`sites` 域名数组、成对的 `from/to` 日期（YYYY-MM-DD）、`recency:week|month|semiyear|year`。`noTimeLimit` 转为省略字段，空站点/空日期转为不设过滤；非空日期与 recency 不能一起传。站点/时间过滤要求请求 web 结果，不暗示视频被按日期过滤。其他渠道不支持这些过滤选项时拒绝或在选择前排除，不静默丢弃条件。

响应主要字段为 `data.query/provider/items`，每条含 `type/title/url/snippet/publishedAt`；`meta.capturedAt/empty/fullText` 说明捕获时间和结果边界。`publishedAt` 保留上游日期文本，未知为 null，不猜时区。只展示摘要和链接，不自动抓全文；供应商没有摘要时字符串为空。

百度形状入口将用户提供的 messages、resource_type_filter、edition、search_filter、search_recency_filter 转为同一规范请求。它与显式 `provider=baidu` 的统一请求在语义相同、同 Key、同幂等标识时共用一次交付。省略 provider 的动态顺序请求是不同意图，复用同标识会冲突。

## 路由、费用与不确定结果

Internal 内部执行：`下游 → Domestic 公共入口 → Internal Hub 鉴权 → 固定搜索渠道 → 该渠道的系统出口/代理`。没有新增 Domestic 上的凭据或控制库，也没有引入 Hub → Night-All 跳转。现有入站链路适用，国内可达性由实际 Internal 出口决定，不能只根据供应商所在地假定可达。

选择只在业务派发前发生，根据已授权渠道、选项支持和凭据/操作就绪状态跳过候选。共享 Proxy 的无凭据探测可选出口；已发出的带凭据业务请求绝不自动重试、换代理或换供应商。选择后发现预算、并发、出网或其他准入阻断会明确失败，不在同一请求里无限寻找便宜或可用替代。

`control.web_search_request_routes` 以 Key + Idempotency-Key 保存请求哈希、选定渠道和当时排序；多进程竞争由数据库唯一约束收敛。同一请求在顺序/采购策略/凭据变动后仍绑定原渠道。成功、失败和 unknown 使用现有 usage/acquisition 机制核对和回放；空列表成功是正式结果。客户账单与采购预算独立，实际供应商扣费无证据时保持未知。

完整上游响应存入受限原始归档，交付快照由 Hub 保存。常规结果和错误不泄漏密钥，SerpApi 查询参数里的 Key 也不写入普通元数据。此阶段没有 Canonical/outbox/ES 入库，不能把接口已登记表述成已清洗全网数据。

## 数据源目录与发布

百度复用 `source-catalog-0135` / `cb2bc950-7929-5cf9-9498-64638a2eac45`。实现清单关联 Web Search 产品；保留现有人工 coverage/runtime 状态，其余渠道不伪造目录 UUID。迁移清单已将七家 HTTP 搜索从 deferred 改为 native_contract，脚本和全文提取仍 deferred。

发布顺序：备份并在隔离数据库验证迁移 119 → 按现有迁移流程先升级 schema → 发布 Hub → Admin 配置渠道凭据、出网与审核价格 → 小范围 canary 和显式租户/Key 授权 → 使用专门测试 Key 进行经授权的真实供应商验收。此工作没有运行这些生产步骤。回退时停用新操作、保留幂等/归档证据，不删除表、恢复旧 Key 或改动 MX-H2I 身份。

## 验证

单元与 HTTP 夹具覆盖八家固定请求、百度空过滤转换、非法参数、未知响应与空结果区别、渠道隔离、默认空权限、租户授权同步与独立调用者授权边界、排序变化后的回放、并发一次派发、别名去重、已撤销渠道、Admin 二次验证和 no-store。真实数据库测试使用 `MX_INSIGHT_TEST_DATABASE_URL`，要求已迁移至 119 的一次性数据库；未配置时明确跳过，不连接生产。

当前验证记录：全量服务端 2179 项通过、0 失败、34 项按前置条件跳过；随后补齐就绪状态与显式管理员测试身份范围，29 项相关回归通过。构建、类型检查、能力目录校验和 git diff 空白检查通过。未配置一次性 PostgreSQL 测试库，迁移 119 的真实执行仍待部署前验证。

本地 Playwright 使用已安装 Chrome 和内存服务，验证供应商页、租户勾选排序、Key 缩小范围、合成密钥保存/查看及移动布局。无 Browser 插件时使用 Playwright。测试不会访问真实搜索供应商。

产品界面修订使用 Browser 工具驱动本地 Chrome 与隔离响应夹具，核对桌面/390 CSS 像素布局、浅深主题、面板互斥、示例只填写、三种资源展示、结果本地筛选、空结果、未知结果重试、同 Key 凭据刷新及换 Key 后的结果清空。6 次显式发送对应 4 个独立意图（含调试结果共享），成功回放和失败重试均沿用原标识；页签、筛选和刷新凭据没有额外搜索。表单测试将候选渠道与服务端 `providerSupports` 逐项比对；共享工作台与调用凭据回归通过。视觉保持 Hub 原有导航和主题，落实居中搜索框、紧凑筛选和垂直结果；相较概念图，新增真实调用身份、渠道状态与价格入口。

官方核对资料：[百度 AI Search](https://ai.baidu.com/ai-doc/AppBuilder/pmaxd1hvy)、[Exa](https://exa.ai/docs/reference/search)、[Tavily](https://docs.tavily.com/documentation/api-reference/endpoint/search)、[You.com](https://you.com/docs/api-reference/search/v1-search)、[SearchAPI](https://www.searchapi.io/docs/google)、[Firecrawl](https://docs.firecrawl.dev/api-reference/endpoint/search)、[SerpApi](https://serpapi.com/search-api)。Serper 依据 Night-All 已存 HTTP 合同迁移，仍需账号真实验收。百度采用本次用户给定的 `Authorization: Bearer`；不尝试另一鉴权头后再发一次。
