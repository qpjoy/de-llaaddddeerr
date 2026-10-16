# Argus 商品迁移与历史报价缺口复核

核对日期：2026-10-16。用户提供的是缺口排查记录，不作为接口定义或线上现状的证明。本次对照 Hub 当前代码、10 月已保存验收记录，以及 `po-infra/docs/hub-upstream-migration.md`（核验日期 2026-09-14）和 `po-infra/docs/data_query_product_search.md`（2026-09-08）。没有新发起付费采集或修改线上配置。

## 当前结论

| 项目 | 已有证据 | 剩余工作 |
| --- | --- | --- |
| 抖音电商关键词商品搜索 | Hub 10 月 12 日已实现统一商品接口的 `douyin_ec`，与旧 Night-All 使用同一已登记搜索路径；已有首屏 30 条商品的验收样本 | 下游 helper 仍拒绝此平台；当前线上统一接口版本及原 Key 的执行条件需核验，不能仅凭原生接口可见推定 |
| 抖音商品字段 | 已保存样本经当前解析器得到 30 条商品 ID、标题、链接、图片 | 样本没有店铺 ID/名称和可确认价格；这些字段保持 null，不能称为满足完整监测需求 |
| 抖音后续页 | 已实现绑定查询、消费者和上游搜索会话的 Hub 游标，离线回归覆盖续页 | 没有真实第二页验收，不能承诺游标会话无限有效或完整覆盖平台商品 |
| 拼多多商品搜索 | 原有不支持能力；用户补充 JustOne、TikHub 均无接口，并明确暂不排查 | 移出本轮排查范围，保留不支持状态；不归为迁移丢失，也不继续寻找替代接口 |
| 四项 `customer_price_unavailable` | 用户已返回只读生产回执：指定 LCY-delta Key 的四项均解析到 CNY 1 最小单位/请求的租户默认价 | 当前指定 Key 的报价缺口已核实不存在，无需补价；历史 503 原因及真实接口可用性不由本次回执证明 |

10 月 13 日的原生抖音搜索/详情有独立的供应商 301 失败证据，参见 [抖音电商接口诊断](douyin-ecommerce-diagnostics-2026-10-13.md)。它与接口是否接入、客户是否有报价是不同判断；原生请求失败不证明统一接口不存在，也不证明之后已恢复。

## Hub 商品合同与旧参数对应

统一入口是 `POST /api/v1/data/ecommerce/products/search`，要求消费者和 Key 同时具有 `ecommerce` 平台及 `ecommerce.products.search` 操作权限。它没有将旧 `/api/v1/products/search` 的任意参数作为兼容别名接入。

| 旧字段 | Hub 对接方式 |
| --- | --- |
| `platform: "douyin_ec"` | `marketplace: "douyin_ec"` |
| `keyword` | `query`，保留原查询语义 |
| `businessId` | 保存于下游任务/日志；不放进 Hub JSON。逐页稳定的业务标识可用于构造 `Idempotency-Key` |
| `page: 1` | 首页可省略或传 1；抖音后续页使用返回的 `cursor`，不同时传 `page` |
| `pages` | 调用端在既定页数/时间预算内循环，不作为 Hub 参数 |
| `pageSize: 100` | Hub 不接受此字段，也不承诺每页 100 条；保存每批全部返回记录 |
| `includeRaw` | Hub 统一商品合同不接受；返回稳定业务字段，受限原始证据由诊断链路关联 |
| 实时监测 | 使用 `deliveryMode: "live_only"`；`refresh` 允许存量兜底，不能单凭请求模式判定实时成功 |

首页示例（仅说明合同，不自动执行）：

```http
POST /api/v1/data/ecommerce/products/search
Content-Type: application/json
Idempotency-Key: argus-monitor:job:scan:work-unit:douyin_ec:p1

{"marketplace":"douyin_ec","query":"<品牌或机构名称>","deliveryMode":"live_only"}
```

只有 `data.page.hasMore === true` 且 `data.page.nextCursor` 存在时继续：

```json
{"marketplace":"douyin_ec","query":"<同一查询词>","deliveryMode":"live_only","cursor":"<原样传回上一页 nextCursor>"}
```

下一页使用新的确定性幂等键；同一页的重试保留原键和完整参数。键为 8–128 位安全 ASCII 字符，以字母或数字开头，后续允许 `._:-`；较长的业务组合应生成稳定摘要，不直接拼接到超长 Header。错误/未知结果先查请求诊断，不自动换键重采。不要将旧 Night-All 页号、上游 `search_id` 或另一查询的游标传给 Hub。

- `hasMore=false` 表示该次上游遍历已终止，不等于平台全部商品已被覆盖。
- `hasMore=null` 表示无法证明可继续；停止自动翻页并保留“不完整/待核验”状态，不能标记全量完成。
- 缺失或重复游标不可通过自行递增页号绕过。抖音从第二页起依赖搜索会话；技术上限为 1000 页，实际取决于供应商续页证据和会话可用性。
- 监测保存每页的 `requestId`、原请求、返回游标和采集时间；跨页按平台商品 ID 去重，已获得记录不能因后续页失败被丢弃。

## 商品、店铺与来源字段

产品字段位于 `data.items[]`：`id`、`marketplace`、`title`、`url`、`urlSource`、可选 `appUrl`、`pricing`、`shop.id/name`、`images`、`signals`、`attributes`。

业务来源使用商品的 `marketplace`、响应 `requestId` 和 `meta.sourceMode/capturedAt/servedAt/ageSeconds`。供应商身份、请求凭据和内部适配器路径不加入商品公共字段。`fresh_cache`、`stored_fallback`、`live` 与 `idempotent_replay` 必须按实际响应记录；幂等重放不代表又采集了一次。

10 月 12 日原始业务样本中的店铺对象为空，当前 `shop.id/name` 和价格为 null 有证据依据。不能把 `promotion_id` 当商品 ID，也不能按品牌关键词猜店铺。已有原生店铺商品列表要求已知 `shopId`，不等同于关键词店铺发现。若业务必须逐条获得店铺，需另行验证确实返回店铺的搜索/详情合同并明确额外请求费用；本次不自动补采。

## 调用端尚未同步的边界

本次只读检查 `/Users/qpjoy/workspace/mingxi/po-infra`，没有修改或发布其运行版本：

- `llm/data_query.py` 的商品平台白名单仍只有原五个平台，`douyin_ec` 会在 HTTP 请求前被拒绝；交付模式白名单也未接受 `live_only`。
- 同文件的独立商品监测 helper 仍拒绝抖音电商，并使用 `refresh`。
- `llm/infringement_monitor.py` 仍将 `douyin_ec` 列为不支持。
- 平台 helper 已有 Hub cursor、逐页幂等和未知/存量兜底保护，应保留。部分 `agent_sources/argus` 版本包仍直接执行包内旧 `/api/v1/products/search`；实际生效包由数据库 `AgentConfig.active_version` 与 `AgentVersion.code_file` 决定，不能根据本地目录名认定。

接入抖音不能只改一处白名单：需同步商品 Skill 参数校验、监测平台判定、实时交付模式、测试与文档。保留拼多多不支持状态。旧版本包还可能自带旧请求路径；平台部署不等于已激活 Agent 版本自动升级，应按已有发布流程产出新版本并验证实际 Scan/Resume。

## 四项历史客户报价错误

| 业务 | 当时的 Hub 路径 | 历史 requestId |
| --- | --- | --- |
| 微博搜索 | `/api/v1/night-all/search/raw` | `6c1324db-f60c-459c-923d-45a912ded738` |
| Twitter 账号发文列表 | `/api/v1/night-all/search/crawl` | `253766c3-3fe0-44e2-8c26-91923d4b6078` |
| 微博账号资料 | `/api/v1/night-all/search/user-info` | `f72b32a7-4a41-4dce-b716-50a3ef8c011a` |
| 淘宝商品搜索 | `/api/v1/data/ecommerce/products/search` | `e06637c5-5cf7-44fb-b253-147aefb0fa4d` |

这里的 Twitter“发文”是读取 openai 的发文列表，不是发布推文。以上实测属于 9 月 14 日，不能作为 10 月 16 日仍报 503 的证明。

数据库 migration 056 曾对缺失客户单项报价返回 `customer_price_unavailable`；080 允许未报价操作不产生客户扣费；105 加入租户默认价。当前 105 函数在 enforced 模式下抛出该错误的条件，是套餐引用了非空但不可用的价格簿，而不是单项价格缺失本身。迁移 142 又为当时零默认价租户设置了 1 最小货币单位的默认价，保留已明确的套餐单项价（包括免费）；此次用户返回的只读回执已核实指定 Key 当前使用 CNY 1 最小单位默认价。

因此修复顺序是：核实实际 Key → Consumer → 套餐版本 → 客户价格簿及选定计费项，核实线上函数版本和计费模式，再确定是否真需补价或修复版本/绑定。没有足够证据时不重新设置全局默认价，不重跑已完成的 10 月 14 日同步批次，不改采购预算、钱包、历史订单或账单。`scripts/migrate-missing-operation-prices.mjs` 补的是供应商采购报价，不能用它修复客户套餐错误。

若确认需要独立报价，沿用不可变价格簿/套餐版本发布与指定消费者切换，保留原合同周期；不能直接修改已发布版本，也不能以普通套餐重分配意外重置 `assigned_at`。价格数值取已确认的运营配置，不临时猜价。

### 已收到的生产回执与关闭结论

2026-10-16 收到用户运行脚本返回的 `customer-price.v1`，`readOnly=true`、`businessCalls=0`。回执不包含数据库快照时间；此日期是接收日期，不作为精确请求时间。

- Key `fd2f8cc9-0ff1-4052-a538-8cc8150bde83` 和 Consumer 均为 active，`ownerMatches=true`；Consumer `be7d07fe-3d98-4db3-b00d-e5cbe5a76190` 下共有两个 Key。
- 实际函数指纹识别为 `tenant_default_105`；触发器 `O`、`subscription_exclusions_130`，四个选定计费项适用。
- 套餐版本 `47b5518d-93ab-4b86-9f7f-45e9bbbadaca` 为 published，绑定 revision=4；其价格簿 `8dd6d27b-8c11-4eed-81a9-d1a52d7c9c4f` 存在且为 published/version=2。
- 租户计费 profile 为 enforced/revision=3，默认 CNY 1 最小单位；四项 `raw`、`crawl`、`user-info`、`ecommerce.products.search` 均为 `state=priced`、`priceSource=tenant_default`、`billingUnit=request`、`quotedMinor=1`。

**关闭“当前指定 Key 四项客户报价缺失”缺口。** 四项虽没有套餐专属 entry，但有效默认价为 **¥0.01/计费请求**，不是每条返回数据收费。无需新增单项价、重新分配套餐、重跑采购补价或 10 月 14 日价格同步；本次没有写入价格或账务。

这不证明 9 月历史请求的归属、失败原因或之后恢复的具体时间，也不证明当前 Key 的授权、钱包余额、上游服务及实际业务调用均正常。同 Consumer 的两个 Key 共享套餐配置，不代表它们授权相同。无需重复运行本脚本；如同一 Key 的这些操作后来出现新的 503，再根据新请求证据检查对应运行环境。拼多多按用户补充停止排查；抖音调用端适配、店铺字段与真实续页仍按各自证据跟进。

### 一次性只读核验

新增 `server/ops/diagnose-customer-price.mjs`，只接受一个 Key 记录 UUID 与本次四个计费项中的 1–4 个；不接受 Key secret 或 SQL。它在限时 `REPEATABLE READ READ ONLY` 事务中查询绑定及报价，并对实际 PostgreSQL 函数正文及已知触发条件作识别，最终回滚。不会执行带锁/扣费语义的报价函数，不访问供应商，不在 Pod 写文件。

以下为本次已完成的只读核验命令，保留备查，无需重复执行；它通过 stdin 在现有 Admin Pod 运行，无需重启或部署 Hub：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - \
  fd2f8cc9-0ff1-4052-a538-8cc8150bde83 \
  raw crawl user-info ecommerce.products.search \
  < server/ops/diagnose-customer-price.mjs
```

这里显式选择的是 [已确认的 LCY-delta Key 记录 UUID](lcy-managed-access-and-default-prices.md)，不是秘钥。四个历史请求与此 Key 的归属没有在本次读库证实；如果此次调用使用另一 Key，应替换为其记录 UUID，不发 secret。脚本不会按名称选择另一个 Key，也不会因目标找不到而扩大查询范围。

| 输出 | 含义与后续处理 |
| --- | --- |
| `runtime.generation=tenant_default_105` | 实际报价/预留函数匹配当前已知实现；继续看每个 meter 的有效来源和值 |
| `missing_entry_errors_056` / `unlisted_free_080` | 仍是已知旧计费语义；先核对标准部署/迁移过程，不能手工替换 SQL 函数掩盖版本差异 |
| `unverified` | 函数指纹、触发器或身份关联未能证实；不输出可信报价，不猜部署版本 |
| meter `priced` | 已解析当前单项价或租户默认价，含币种、最小单位和倍率；不是权限、余额或供应商实时可用性保证 |
| `assigned_customer_price_book_unavailable` | 当前绑定引用不可用价格簿；需修复具体版本/绑定，不能用采购补价脚本处理 |
| `legacy_missing_meter_entry` | 旧 056 语义下缺该客户计费项；先确认版本和业务价格政策 |
| `unbilled` | 当前计费配置不生成该项扣费；报告具体原因，不代表请求已获授权或可执行 |
| `key_not_found` | 指定记录不存在；确认 UUID，不创建替代 Key |

这份输出用于形成针对当前配置的修复选择，不修改 9 月历史证据，也不承诺过去四个 503 的唯一原因。

## 验证边界

本次 Hub 商品合同、分页、路由及缺采购价/幂等回归 32/32 通过，包含隔离 PGlite。已保存的抖音样本重放没有新访问供应商。没有发现需要为旧参数增加 Hub 兼容别名或更换商品解析器的证据。已修正 `docs/contracts/public-api-v1.md` 遗漏抖音枚举、`live_only` 摘要、游标要求及商品 JSON 示例的错误嵌套。

客户报价诊断另有 10/10 回归通过、无跳过，包括实际 PGlite 执行固定查询、056/080/105 函数差异、129/130 触发器条件、未知触发条件拒绝、默认价/显式免费优先级和事务回滚。文档商品 JSON 示例已解析校验；脚本语法和本次 diff 检查通过。

当前指定 Key 的四项客户报价已由用户返回的生产回执核实。本次不证明新一轮线上实时搜索成功；真实第二页、完整店铺字段以及下游实际激活版本仍需各自证据。所有检查与工具限制在 Hub/下游调用分析，不改变 MX-H2I 登录、联网、SSO 或 mx-pay 服务。
