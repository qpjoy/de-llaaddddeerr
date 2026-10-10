# 商品 URL 与京东采集失败（2026-10-11）

## 已确认的线上证据

用户提供 `hub-product-url-20261011.json`，四组请求均为
`POST /api/v1/data/ecommerce/products/search`、`deliveryMode=refresh`、`page=1`。
随后运维只读查询原调用及精确响应字节，四份归档 SHA-256 均匹配。
没有重新请求供应商。

| 平台 / 查询 | Hub Request ID | 结果 | 供应商耗时 |
| --- | --- | --- | --- |
| 淘宝 / 小米手机 | `87977322-77d9-4251-8171-31e88213c868` | HTTP 200，10 商品，URL 全 null | 1931 ms |
| 天猫 / 海尔冰箱 | `28d74eb4-d6c6-4755-8814-37bc86da960c` | HTTP 200，10 商品，URL 全 null | 1450 ms |
| 闲鱼 / 索尼相机 | `74716d47-f86b-475e-b4b9-384188dfee0d` | HTTP 200，10 商品，URL 全 null | 2827 ms |
| 京东 / 联想笔记本 | `4e3e72d3-5dcb-46ec-8e54-c1aa352b3bf8` | HTTP 502，明确采集失败，没有商品列表 | 1990 ms |

淘宝、天猫各抽查前三条原始商品，常见链接字段均不存在；既有淘宝 fixture 也无链接。
这不是已确认的字段别名漏映射，抽查不能证明所有未知字段都不存在链接。
闲鱼各样本的 `data.item.main.targetUrl` 为 `fleamarket:` App URI，包含 `itemId`。
Hub 已读取该字段，但 HTTP/HTTPS URL 校验拒绝 App URI，所以交付 null。

京东精确归档为供应商 HTTP 200 / 业务码 301，正文消息
`COLLECT FAILED, SEND REQUEST AGAIN`；账本 `outcome=rejected`、`billed=false`。
[官方业务码说明](https://docs.justoneapi.com/zh/usage)定义 301 为采集失败、供应商不计费。
它不是成功的零商品页、Hub 解析丢弃或这次连接超时；不能据此推断供应商内部原因。
客户计费必须另查客户账本，不能从采购 `billed` 推断。

供应商支持排查所需关联：

- 上游 Request ID：`95dccfe992b548cba6866052a31ec503`。
- Hub call ID：`8642ce2d-d6c0-46fc-90a5-1cb100980b09`。
- 请求时间：附件记录 `2026-10-10T16:23:18.546859Z`（北京时间 2026-10-11 00:23:18）。
- 固定上游接口：`GET /api/jd/search-item-list/v1`，关键词“联想笔记本”，第一页。

## 修复边界

新的商品投影优先保留原始 HTTP/HTTPS URL，签名和查询参数不变，标记
`urlSource=upstream`。缺少可用网页链接时，淘宝、天猫、京东、闲鱼按准确数字商品 ID
生成固定平台的网页 URL，标记 `urlSource=derived_from_id`。闲鱼生成地址取商品 ID，
不执行 App URI，也不采用 URI 内另一个可能冲突的 ID。

只接受原始字符串或安全整数，要求与交付 ID 完全相同且为 1–32 位、非零开头 ASCII 数字。
不从标题、店铺 ID、截断/归一化 ID 或丢失精度的数字造链接。
小红书电商没有已定义的网页映射；无可用地址仍为 null。
生成链接不等于上游返回链接，也不是在售、页面可达或免登录的保证。

`urlSource` 在 OpenAPI 中为可选字段，以兼容旧快照；旧响应缺字段时来源未知。
新归档的 normalizedItem、交付快照、Canonical commerce.product 都保留来源标记；
原始商品与受限响应字节不变。Canonical parser 标记更新为
`mxih-justone-product-search.v3`，不升级 endpoint contract 来解除隔离。
没有历史数据迁移、缓存/幂等响应重写或额外详情采集。

京东 301 保持 502 和 `upstream_collection_failed`，保留原幂等响应、计费与熔断，
不自动重试，也不伪造空成功。修改 Hub URL 投影无法恢复供应商本次采集；
后续独立实时验收已成功，见文末；不能将上游恢复归因于 URL 投影修改。
本次只改 Hub 商品投影、文档、测试和只读诊断，不改 Launcher/MX-H2I 登录、权限、联网，
也不改 Night-All、供应商网络配置或支付服务。

## 部署与不计费验证

本地相关回归共 145 项：144 通过、0 失败，1 项 PostgreSQL 分页集成测试因未配置测试库跳过。
覆盖链接来源/异常 ID、Canonical 原始证据、实时/缓存/历史重放、京东 301、
HTTP/适配器/归档、公开文档和只读诊断。附件中的 30 个已交付 ID 全部通过本地链接生成，
这不是原始响应的服务器重放或网页可达性验证。

运维已报告部署完成，随后回传以下命令的完整输出，确认所执行的 Public Pod 已包含新投影。
后续发布仍按现有 Hub 流程操作，如使用 manage.sh，显式设置 `MX_INSIGHT_SYNC_LAUNCHER=0`。
本次无新增数据库迁移。旧缓存/历史幂等请求仍可能返回 null；新成功采集才生成新交付。

部署后在有 kubectl 的终端执行以下单行命令。它只读原归档，在 Pod 内运行当前链接投影，
不调用供应商、不改任何记录、不输出商品内容/URL/凭据。也不能证明商品网页可访问或京东恢复。

```bash
kubectl -n mx-insight-hub exec deploy/mx-insight-hub-public -c api -- node server/ops/diagnose-ecommerce-product-links.mjs 87977322-77d9-4251-8171-31e88213c868 28d74eb4-d6c6-4755-8814-37bc86da960c 74716d47-f86b-475e-b4b9-384188dfee0d 4e3e72d3-5dcb-46ec-8e54-c1aa352b3bf8
```

前三组预期 `state=projected`、`productCount=10`、`urlCount=10`，来源统计明确区分生成与原始链接。
京东预期 `state=upstream_rejected`、`businessCode=301`，这是历史证据原样校验。
`archive_integrity_failed`、`archive_missing_or_oversized` 或 `unsupported_marketplace` 等状态
不是验收通过，应先核对部署代码/归档/原请求信息，不通过付费重采集补证据。

## 部署后复验结果

运维回传 `mode=offline_read_only`，四个 Request ID / call ID 均与原记录一致：

| 平台 | 投影结果 | 商品数 | URL 数 | 原始网页链接 | 按 ID 生成 | 缺失 / 丢弃 |
| --- | --- | --- | --- | --- | --- | --- |
| 淘宝 | projected | 10 | 10 | 0 | 10 | 0 / 0 |
| 天猫 | projected | 10 | 10 | 0 | 10 | 0 / 0 |
| 闲鱼 | projected | 10 | 10 | 0 | 10 | 0 / 0 |
| 京东 | upstream_rejected / 301 | 无商品列表 | — | — | — | — |

已部署的商品 URL 投影在三份精确归档上复验通过，30 件商品均生成带来源标记的网页地址。
此次没有供应商调用或历史写回；输出中的 `billed=true/false` 和 `latencyMs` 均来自原调用，
不代表本次诊断产生费用或发生新的实时搜索。
旧缓存和原 Idempotency-Key 的响应保持原样，因此仍可能看到 null 或旧 301。
这一轮只读检查未验证新的 Public HTTP 采集、所有副本/worker 的镜像一致性、网页可达性或京东恢复。
后续京东实时验收结果如下；不能通过重新运行只读命令获得当前供应商可用性结论。

## 京东实时验收通过

用户要求直接在对话提供步骤，随后执行一次正常 Hub Public API 请求：
`marketplace=jd`、`query=联想笔记本`、`page=1`、`deliveryMode=live_only`。
命令从隐藏交互输入接收原 Hub Public API Key，经 stdin 传入 Pod，单次发送，无自动重试。

| 字段 | 结果 |
| --- | --- |
| 幂等标识 | `lcy-ecom-jd-lenovo-20261011-01` |
| Hub Request ID | `0ee7b26c-6ebf-4ce1-aa66-23cbdf7c44a2` |
| HTTP status | 200 |
| sourceMode / replay | live / false |
| 商品数 / 有 URL 商品数 | 48 / 48 |
| 返回的两件样例 ID | `10206948797971`、`100309245563` |
| 两件样例的 urlSource | derived_from_id |

本次真实查询与 URL 交付通过，不是缓存或幂等重放；无需继续重复付费验收。
淘宝/天猫/闲鱼已完成原归档在部署代码上的投影验证，京东已完成此次新实时查询验证。
旧 301 请求仍保留原状。新成功不能解释旧采集失败的供应商内部原因，也不能证明未来稳定性、
商品网页可达性或其他客户端展示链路。此次输出未包含实际采购/客户扣费证据，不能补写费用结论。
