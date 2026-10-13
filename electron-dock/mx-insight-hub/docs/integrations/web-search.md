# Web Search 数据服务

更新：2026-10-13。原始设计见 [规划](web-search-plan-2026-09-30.md)；本页记录实现与管理边界。Delta 调用方请直接阅读 [Web Search 接入合同与示例](delta-web-search.md)，对外页面为 `/docs/web-search`，完整 OpenAPI 为 `/docs/openapi.json`。

本轮补齐对外请求/响应 Schema、curl、权限/渠道选择、幂等与超时核对说明，并准备 Night-All 配置导入。2026-10-13 只读观测中 LCY-delta 已有八个渠道权限、百度 `ready=true`；这不是搜索验收或后续可用性保证。新代码本轮尚未生产部署，用户选择在服务器自行重新部署；导入来源、启用条件与部署步骤以 [Web Search 配置迁移操作说明](../operations/web-search-migration-2026-10-13.md) 为准。普通新 Key 的默认空授权与已有托管 Key 策略须区分，不扩大其他身份授权。

## 交付范围

Hub 自己直连百度、Exa、Tavily、Serper、You.com、SearchAPI、Firecrawl、SerpApi。请求不会进入 Night-All。后七家来自 Night-All 已有 HTTP 搜索能力，迁为 Hub 的固定地址、独立凭据、预算、授权和归档合同，不承诺旧响应形状完全相同。

百度支持网页、图片、视频；其他七家当前只提供网页检索。源码适配器和合成测试不等于真实账号已验收。DeepSeek 尚未注册成虚构的搜索供应商；后续在获得独立 Web Search 合同后新增适配器。Night-All 的 web-search-skill（Bing RSS / DuckDuckGo / SearXNG 编排）、Defuddle/direct fetch、历史运行记录迁移和 AI 答案生成仍单列后续阶段，未偷偷回退到旧进程。

## 管理员在哪里配置

1. **Web Search → 供应商管理**（仅 Admin Token 会话）或 **数据接入与治理 → 上游供应商 → 对应供应商**：两处共用同一份凭据，可保存 API Key；凭据加密落库，常规响应不回传明文。“查看 / 复制”需要再次输入 Admin Token，关闭弹窗/切换供应商会清除页面明文。供应商管理列出全部八家，不受产品调试所选 Key 的渠道权限限制。保存 Key 不会查询或启用接口。
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

Web Search 默认进入“接口调试”，并提供独立的“产品展示”和“搜索渠道与接入”；Admin Token 会话另有“供应商管理”页签。凭据与采购配置属于供应商，产品页只是共同管理入口；租户/Key 授权与排序独立。隐藏面板不会混入当前视图；接口名称与长路径分行显示。

产品展示提供大搜索框、授权渠道选择、网页/图片/视频勾选，以及数量、站点、日期、时间范围、Standard/Lite 筛选。仅发送公开合同支持的参数，不静默丢弃不支持的条件。示例按钮只填写问题；打开页面、切换页签、查看价格、刷新渠道状态和筛选已有结果都不会搜索。界面只呈现真实响应的摘要与来源链接，不生成虚构答案、缩略图或 VIP 状态。

同一 Key 的表单、结果与请求标识保留在页面会话内。临时签名凭据续期不重置请求；更换 Key 则重置产品视图。成功、空结果和失败都保留原请求标识，重试复用它；“新建相同查询（再次发送会计量）”仅清除该意图，仍需再次点击搜索。调试成功的搜索结果也可在产品展示中阅读。

判断是否需要重新授权应以当前 Key 的 `/capabilities` 为准：

- 渠道列表为空：核对该 Key 与 Consumer 的数据域、搜索能力及渠道权限。旧 Key 缺权限时可单独调整 Key，或经租户保存预览补齐所有旧 Key。
- 已显示授权渠道，但 `ready=false`：授权已经生效，不需要重复保存租户。管理员应在“上游供应商 → 对应渠道 → 上游平台操作控制”核对 `web.search` 的运行模式、凭据、采购单价和预算；保存供应商 Key 不会自动启用操作。
- `ready=true`：表示当前预派发检查通过，不保证后续网络、余额、额度或预算检查一定成功。发送时仍由服务端复核。

历史记录（2026-09-30）：LCY-delta 当时已列出 8 个授权渠道，但百度仍停用且预算未配置。2026-10-13 的只读观测已更新为百度 `ready=true`，详见页首与迁移操作说明；不要把历史状态当作当前阻断原因，也不要把 ready 当作真实搜索成功的证明。

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

百度专用选项：`edition:lite`、`sites` 域名数组、成对的 `from/to` 日期（YYYY-MM-DD）、`recency:week|month|semiyear|year`。`edition:standard` 是所有渠道接受的默认值，非百度不会向渠道传递 edition。`noTimeLimit` 等同省略 recency，空站点数组表示不筛选；统一入口不用日期时须省略 from/to，空字符串会拒绝。只有百度形状入口把同时为空的 gte/lte 转为不设过滤。有效日期范围与 recency 不能一起传。站点/时间过滤要求请求 web 结果，不暗示视频被按日期过滤。其他渠道不支持这些过滤选项时拒绝或在选择前排除，不静默丢弃条件。

响应主要字段为 `data.query/provider/items`，每条含 `type/title/url/snippet/publishedAt`；`meta.capturedAt/empty/fullText` 说明捕获时间和结果边界。`publishedAt` 保留上游日期文本，未知为 null，不猜时区。只展示摘要和链接，不自动抓全文；供应商没有摘要时字符串为空。

百度形状入口将用户提供的 messages、resource_type_filter、edition、search_filter、search_recency_filter 转为同一规范请求。它与显式 `provider=baidu` 的统一请求在语义相同、同 Key、同幂等标识时共用一次交付。省略 provider 的动态顺序请求是不同意图，复用同标识会冲突。

## 路由、费用与不确定结果

Internal 内部执行：`下游 → Domestic 公共入口 → Internal Hub 鉴权 → 固定搜索渠道 → 该渠道的系统出口/代理`。没有新增 Domestic 上的凭据或控制库，也没有引入 Hub → Night-All 跳转。现有入站链路适用，国内可达性由实际 Internal 出口决定，不能只根据供应商所在地假定可达。

选择只在业务派发前发生，根据已授权渠道、选项支持和凭据/操作就绪状态跳过候选。共享 Proxy 的无凭据探测可选出口；已发出的带凭据业务请求绝不自动重试、换代理或换供应商。选择后发现预算、并发、出网或其他准入阻断会明确失败，不在同一请求里无限寻找便宜或可用替代。

`control.web_search_request_routes` 以 Key + Idempotency-Key 保存请求哈希、选定渠道和当时排序；多进程竞争由数据库唯一约束收敛。同一请求在顺序/采购策略/凭据变动后仍绑定原渠道。成功、失败和 unknown 使用现有 usage/acquisition 机制核对和回放；空列表成功是正式结果。客户账单与采购预算独立，实际供应商扣费无证据时保持未知。

完整上游响应存入受限原始归档，交付快照由 Hub 保存。常规结果和错误不泄漏密钥，SerpApi 查询参数里的 Key 也不写入普通元数据。此阶段没有 Canonical/outbox/ES 入库，不能把接口已登记表述成已清洗全网数据。

## 数据源目录与发布

百度复用 `source-catalog-0135` / `cb2bc950-7929-5cf9-9498-64638a2eac45`。实现清单关联 Web Search 产品；保留现有人工 coverage/runtime 状态，其余渠道不伪造目录 UUID。迁移清单已将七家 HTTP 搜索从 deferred 改为 native_contract，脚本和全文提取仍 deferred。

原始发布顺序：备份并在隔离数据库验证迁移 119 → 按现有迁移流程先升级 schema → 发布 Hub → Admin 配置渠道凭据、出网与审核价格 → 小范围 canary 和显式租户/Key 授权 → 使用专用 Live Key 进行经授权的真实供应商验收（Test 环境 Key 不可派发）。2026-10-13 后续部署与缺失凭据导入以 [迁移操作说明](../operations/web-search-migration-2026-10-13.md) 为准。此文档修改没有运行生产发布或真实搜索。回退时停用新操作、保留幂等/归档证据，不删除表、恢复旧 Key 或改动 MX-H2I 身份。

## 验证

单元与 HTTP 夹具覆盖八家固定请求、百度空过滤转换、非法参数、未知响应与空结果区别、渠道隔离、默认空权限、租户授权同步与独立调用者授权边界、排序变化后的回放、并发一次派发、别名去重、已撤销渠道、Admin 二次验证和 no-store。真实数据库测试使用 `MX_INSIGHT_TEST_DATABASE_URL`，要求已迁移至 119 的一次性数据库；未配置时明确跳过，不连接生产。

当前验证记录：全量服务端 2179 项通过、0 失败、34 项按前置条件跳过；随后补齐就绪状态与显式管理员测试身份范围，29 项相关回归通过。构建、类型检查、能力目录校验和 git diff 空白检查通过。未配置一次性 PostgreSQL 测试库，迁移 119 的真实执行仍待部署前验证。

本地 Playwright 使用已安装 Chrome 和内存服务，验证供应商页、租户勾选排序、Key 缩小范围、合成密钥保存/查看及移动布局。无 Browser 插件时使用 Playwright。测试不会访问真实搜索供应商。

产品界面修订使用 Browser 工具驱动本地 Chrome 与隔离响应夹具，核对桌面/390 CSS 像素布局、浅深主题、面板互斥、示例只填写、三种资源展示、结果本地筛选、空结果、未知结果重试、同 Key 凭据刷新及换 Key 后的结果清空。6 次显式发送对应 4 个独立意图（含调试结果共享），成功回放和失败重试均沿用原标识；页签、筛选和刷新凭据没有额外搜索。表单测试将候选渠道与服务端 `providerSupports` 逐项比对；共享工作台与调用凭据回归通过。视觉保持 Hub 原有导航和主题，落实居中搜索框、紧凑筛选和垂直结果；相较概念图，新增真实调用身份、渠道状态与价格入口。

官方核对资料：[百度 AI Search](https://ai.baidu.com/ai-doc/AppBuilder/pmaxd1hvy)、[Exa](https://exa.ai/docs/reference/search)、[Tavily](https://docs.tavily.com/documentation/api-reference/endpoint/search)、[You.com](https://you.com/docs/api-reference/search/v1-search)、[SearchAPI](https://www.searchapi.io/docs/google)、[Firecrawl](https://docs.firecrawl.dev/api-reference/endpoint/search)、[SerpApi](https://serpapi.com/search-api)。Serper 依据 Night-All 已存 HTTP 合同迁移，仍需账号真实验收。百度采用本次用户给定的 `Authorization: Bearer`；不尝试另一鉴权头后再发一次。
