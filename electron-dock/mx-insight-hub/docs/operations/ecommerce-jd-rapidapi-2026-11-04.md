# 电商数据：京东接入 RapidAPI 备用通道、四种路由策略（2026-11-04）

状态：本地实现与测试完成，未部署，没有发起付费请求，没有修改线上路由、价格、授权或 Delta。MX-H2I 登录与联网不受影响。延续 [10-29 供应商路由](ecommerce-supplier-routing-2026-10-29.md)。

## 调研结论

| 项目 | JustOne 直连 | RapidAPI listing |
| --- | --- | --- |
| 发布者 | JustOne（`api.justoneapi.com`） | `justoneapi`（RapidAPI 账号 slug `dataapiman`，与淘宝/天猫 listing 同一发布者） |
| 主机 | `api.justoneapi.com` | `jd-com-api.p.rapidapi.com`（listing：`rapidapi.com/dataapiman/api/jd-com-api`） |
| 商品搜索 | `GET /api/jd/search-item-list/v1?keyword=&page=&token=` | `GET /api/jd/search-item-list/v1?keyword=&page=`，`x-rapidapi-key` / `x-rapidapi-host` 请求头 |
| 其他京东接口 | 详情 v1/v3/v4、价格、描述图、评论、店铺商品 | 同样 8 个（`/get-item-detail/v1` 等），本次只接商品搜索 |
| 无 Key 探测 | — | 401 `Invalid API key`（`x-rapidapi-proxy-response: true`），主机在线 |

- 路径、参数（`keyword`、`page`）与直连完全相同，只是认证和计费不同，和淘宝/天猫通道同一模式，因此复用同一适配器、同一合同 `jd.product-search.v1` 和同一解析。返回结构由同一后端产生；**尚未用付费请求核对**，启用前按下文第 5 步发一次确认。
- 旧的 `jd-all-api` listing 已下架（页面 "API not found"，主机 404）。其他发布者的京东 API（Otapi Jd、TMAPI、SIÁN 等）返回结构不同，不能无缝替换，未接入。
- 套餐均为**硬上限**（超额不扣费，RapidAPI 网关直接 429）：Basic $0 / 10 次/月（1000 次/小时）；Pro $19.99 / 300；Ultra $39.99 / 700；Mega $399.99 / 8000。折合约 $0.05–0.07/次，明显高于直连，适合作为备用或 JustOne 欠费期间的过渡。

## 改动

1. **合同**（`server/contracts/justone.mjs`）：京东候选供应商变为 `justone`、`rapidapi`；新增 `RAPIDAPI_JD_HOST` 与按平台的 `RAPIDAPI_PRODUCT_SEARCH_HOSTS`（淘宝/天猫 → `taobao-tmall-all-api1`，京东 → `jd-com-api`）。闲鱼、小红书电商、抖音电商仍只有 JustOne。
2. **适配器**（`server/adapters/justone.mjs`）：RapidAPI 传输改为 `{ provider: 'rapidapi' }`，主机按请求平台从上表选择；不在表内的平台、非商品搜索请求一律拒绝，不向 listing 主机发送 query token。
3. **出网**（`server/external-platforms/proxy.mjs`）：System Proxy 的 RapidAPI listing 白名单由同一张主机表生成，京东主机随之放行。
4. **采购目录**（`control-store.mjs`）：`rapidapi / ecommerce.products.search` 的必需端点仍只有淘宝；京东 `jd.product-search.v1` 作为**可选端点**，单独定价。已安装的淘宝价格不受影响，不需要迁移（路由表对 adapter id 没有约束）。
5. **未审核价格时的安全切换**（`gateway.mjs`）：某供应商对该端点没有采购价时，派发前就拒绝；在「优先 RapidAPI，失败切 JustOne」下，同一请求在派发前交给 JustOne（释放派发租约与并发槽，不产生 RapidAPI 调用和采购冻结）。固定路由行为不变（503 `external_platform_cost_control_unavailable`，不调用任何供应商）。
6. **管理界面**（「电商数据 → 管理」与「数据清洗中心 → 数据平台 → 电商平台」）：原来的「路由方式 + 主用 + 备用」三个下拉合并为一个**路由策略**，逐项列出：
   - 固定 JustOne
   - 固定 RapidAPI
   - 优先 JustOne，失败切 RapidAPI
   - 优先 RapidAPI，失败切 JustOne

   淘宝、天猫、京东都有这四项；只有一个供应商的平台只有「固定 JustOne」。后端接口与保存格式不变（`mode` / `adapterId` / `fallbackAdapterId`），旧客户端仍可用。当前方式显示为同样的文字。
7. 文案与诊断：电商数据说明、RapidAPI 供应商描述、`diagnose-ecommerce-search.mjs` 的判读说明包含京东 listing。

## 切换规则（与 10-29 相同，京东同样适用）

- 会切换：主用熔断、凭据未配置、操作未启用/暂停、**该端点未审核采购价**、Hub 限流；或主用明确拒绝且未计费——JustOne 601 余额、100 鉴权、302/303 限流配额；RapidAPI 网关的 401/402/403/429（未订阅、Key 无效、套餐用尽）。
- 不切换：已计费（含 200 但无法解析）、结果未知（超时、断连、代理 5xx）、请求参数错误，避免同一页付两次费。
- 每个请求最多切换一次。RapidAPI 京东的失败只记在 `rapidapi/jd` 平台熔断上，不影响淘宝 listing，也不影响 Twitter/Facebook 的 RapidAPI 全局熔断。
- 对调用方透明：请求、返回结构、游标、幂等回放不变；游标绑定接口合同不绑定供应商，切换后旧游标照常续页。

## 部署与启用顺序

1. 部署（无新迁移）：

   ```bash
   MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh ops internal-production deploy
   ```

   部署的补价步骤会给新出现的可选端点补 0.01 的暂定采购价（只补缺失、不改已有价格和启停状态）。
2. 在 RapidAPI 控制台用 Hub 当前的 RapidAPI Key 订阅 `jd-com-api`，按用量选套餐（硬上限，不会超额扣费）。
3. 「上游供应商 → RapidAPI」：把「电商商品搜索 · 淘宝/天猫/京东」中 `jd.product-search.v1` 的采购价改为实际单价（约 $0.05–0.07/次，按所选套餐），确认操作已启用。
4. 「电商数据 → 管理 → 京东」：选择路由策略，例如 JustOne 欠费期间选「优先 RapidAPI，失败切 JustOne」，充值后改回「优先 JustOne，失败切 RapidAPI」。
5. 用接口调试发一次京东搜索，再用诊断确认 `rapidapi` / `jd` 为 `succeeded`：

   ```bash
   kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
     node --input-type=module - 24 < server/ops/diagnose-ecommerce-search.mjs
   ```

不做第 4 步时，线上行为与部署前完全一致。

## 测试

`tests/server/ecommerce-supplier-routing.test.mjs` 新增 5 项（共 14 项，1 项需 PGlite）：

- 京东经 RapidAPI 使用 `jd-com-api` 主机、同一路径与参数、请求头认证，归一后的商品与直连逐字段一致；天猫仍走淘宝 listing。
- 优先 RapidAPI：套餐用尽的网关 429 在同一请求内交给 JustOne（调用序号 0/1），只计入 `rapidapi/jd` 熔断。
- 优先 JustOne：601 余额交给京东 listing。
- 京东未审核采购价：优先 RapidAPI 时派发前交给 JustOne、无 RapidAPI 调用、并发槽已归还；固定 RapidAPI 时 503 且不调用（不含网关改动时此项失败，已核对）。
- 四种路由策略的枚举、保存与回显；单供应商平台只有固定项。
