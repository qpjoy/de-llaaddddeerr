# 多语言采集接入与 ipsearch 首期接入设计

日期：2026-09-14。状态：多语言接入目标设计；ipsearch 首期已实现于仓库，尚未上线或真实上游联调。运行细节见 [IP 风险画像](../operations/ip-risk.md)。

## 1. 本次目标与边界

ipsearch 首期作为实时上游，由 Hub 提供独立授权的数据产品和接口调试页；租户只请求 Hub，不能收到上游地址、凭据、供应商标识或内部转发说明。管理端可观察 ipsearch 的运行与调用证据。暂不制定客户价格，但必须完整计量。

Hub 的新能力不能成为 Launcher/MX-H2I 身份、登录、联网、readiness 的依赖。不修改 Launcher 用户中心、Internal/Domestic 路由、WireGuard、DNS 或 Luopan 的网络配置。历史文档只作为背景，现有代码与本次用户要求决定实施边界。

用户随后提供 `/tmp/ipsearch`，已核实 SDK 0.1.0：固定 HTTPS POST 表单的 IPv4 风险画像查询。无需托管 Python 运行时。

## 2. 已有能力与缺口

| 能力 | 代码证据 | 本次处理 |
| --- | --- | --- |
| 实时外部数据 | `server/external-platforms/gateway.mjs`、`tikhub-gateway.mjs`、`server/adapters/` | 复用授权、幂等、配额、存档、调用证据；新增具体适配器 |
| 数据库/文件清洗 | `server/ingest/external/` | 延续现有增量任务，不把实时请求伪装为五分钟清洗任务 |
| 爬虫统一记录 | `server/ingest/crawler/`、`docs/operations/night-all-saved-records-ingestion.md` | 已有 saved-records 固定管线可继续使用，不强迫所有生产者迁移 |
| 数据源治理 | `server/data/source-catalog.mjs`、`server/app.mjs` | 已有目录与分类 CRUD、版本冲突保护、归档恢复 |
| 产品授权与身份 | `shared/product-access.mjs`、`src/demo-credentials.jsx` | 新增独立业务 scope，复用现有租户身份与 Key，不创建第二套登录 |
| 多供应商同一能力 | 当前实现主要是具体适配器 | 目标为多对多绑定；目录登记本身不产生路由或调用能力 |
| 通用脚本托管/Push 接入 | 本次未核实存在正式统一契约 | 下文是待实现协议，不宣称已有通用插件安装、执行或写入 endpoint |

## 3. 中间层应管理契约，不必托管所有语言

“平台”需要拆开：

- **业务来源**：小红书、淘宝等目录项，描述覆盖范围与分类。
- **供应商**：TikHub、JustOne、ipsearch、自建服务，描述技术接入与采购。
- **业务能力**：搜索、详情等稳定 Hub 操作，是授权、配额与客户计量边界。
- **适配器版本**：把一个供应商版本映射为一个业务能力。
- **数据集与产品**：数据集提供稳定语义，产品组合能力、数据集和交互界面。

一个目录项可以有多个供应商；一个供应商可以覆盖多个目录项。版本化绑定记录能力、供应商 operation、请求/响应 schema、normalizer、分页规则、授权域和验证证据。不得用供应商名拼成公共数据集身份，也不能因供应商可调用就标记目录“已覆盖”。

按实际执行需要选择三种接入方式：

| 生产者形态 | 运行方式 | Hub 接入 |
| --- | --- | --- |
| 仅 HTTP 请求/签名/字段转换的脚本 | 将最小逻辑适配到 Hub 服务端；不逐请求启动解释器 | 同步实时 operation |
| 浏览器采集、复杂依赖、长任务 | 独立容器或常驻 worker 池，Python/Go/Node 各自锁定依赖 | 异步任务及结果提交，或现有数据库拉取 |
| 已经持续写数据库/文件的采集器 | 保留生产者及其运行环境 | 现有清洗计划、游标与映射 |

独立 worker 的并发本身可行，关键是池化、队列、租户公平性和每供应商限流。不要在 Hub 请求处理中任意执行上传代码。首期也不需要建立支持所有语言的插件商店。

多供应商替换须满足同一操作语义；游标固定原供应商/版本，不能中途切换。发生已发送但结果未知的付费调用时，不自动重试或换供应商再次消费。

## 4. 给脚本提供方的交付规范（拟定 v1）

规范统一传输信封和版本管理，不要求新闻、商品、会话共享一套业务字段。

交付包至少包含：

1. manifest：稳定 connector 标识、版本、支持操作、输入/输出 JSON Schema、运行类型、依赖锁文件或镜像 digest。
2. 认证：仅声明所需 secret 名称，由部署侧注入；不得将真实 key 写入包、日志、样例或响应。
3. 脱敏测试样例：成功、空结果、分页、鉴权失败、限流、超时、响应漂移；注明哪些错误可能已经消费上游额度。
4. 数据约定：稳定对象 ID、观测时间、事件时间及精度/时区、更新/删除语义、增量游标、批次边界、最大条数与字节数。
5. 权属与范围：服务端绑定租户/来源/数据集；生产者不能靠请求中的 tenantId、dataset 或 platform 自行扩大写入权限。

拟定记录信封字段：

| 字段 | 含义 |
| --- | --- |
| contractVersion / schemaVersion | 信封与业务数据 schema 独立版本 |
| runId / batchId | 生产运行及可幂等重交的批次身份 |
| recordId / sourceRevision | 稳定来源对象身份及本次来源版本；没有版本时以明确规则使用观测身份 |
| observedAt / eventTime | 采集时间与原业务事件时间；未知事件时间为 null，不填当前时间冒充 |
| operation | upsert 或 tombstone；删除必须有明确来源证据 |
| payload | 对应业务 schema 的完整业务数据 |
| provenance | 受限的采集器版本、来源、原始记录引用；不直接成为公共响应 |

无稳定跨供应商 ID 时保留独立 observation，不按标题、正文相似度强行合并。跨供应商实体关联单独维护证据与置信度；不得覆盖原始观测。

新增字段允许保留到受限原始层；必填字段类型变更或破坏性语义变化进入隔离状态，停用该 operation。先归档，再按指定 normalizer 版本重新处理，无需重新付费采集。

## 5. 落库保证与 ELT

“拿到数据”与“可检索”必须分开确认：

```text
实时适配器 / 外部采集结果 / 数据库增量批次
    → 持久化接收证据与原始响应
    → 版本化规范化与质量校验
    → PG canonical + revision + outbox
    → ES 投影 / 数据产品 / BI / Agent
```

优先采用原始层先落地、确定性转换随后执行的 ELT；需要同步返回的产品可立即规范化，但不能绕过归档与持久化 ingest 责任。AI 可辅助生成候选映射，生产映射须版本化且可测试，不让模型无审核决定字段覆盖和对象合并。

落库协议需要明确以下保证：

- 持久化成功后才确认 accepted；accepted 不等于 canonical 完成或 ES 已可检索。
- 同一生产者范围内，同批次/记录身份与同内容 hash 重交复用回执；同身份不同内容返回冲突，不能静默覆盖。
- 以 at-least-once 传输配合唯一约束和事务实现本地幂等，不能承诺跨供应商网络调用的全局 exactly-once。
- checkpoint 只随已持久化的批次推进；提交结果未知时查询回执，不盲目创建新批次。
- 原始响应对象存储与 PG 不存在天然联合事务：先写不可变对象并校验 hash，再提交 PG 引用/outbox；回收孤儿对象，重试不能生成第二次上游调用。
- 解析失败保留受限证据并进入可观察隔离队列；支持从 archive 重放转换，分别记录 archived、normalized、indexed、failed 状态。
- 外部数据库的更新必须有可靠变更水位和稳定 tie-breaker；只有分页或只增不改时间字段时，不能声称完整捕获编辑与删除。

新生产者 Push 协议及回执端点仍需实现。在它落地前，优先用现有数据库/文件管线交付，遵循其已验证 writer contract，不能让外部脚本直接写 Hub canonical、账本或 outbox 表。

## 6. ipsearch 首期实施切片

首期已确定为 IP 风险画像：`POST /api/v1/data/ip/risk`，授权为 `ip_risk` + `ip.risk.query`。ipsearch 保留为内部供应商标识。下列步骤描述接入目标；首期落地范围以运行文档为准。

实施顺序：

1. 核实固定上游 origin/path、认证、请求/响应、成功/失败判定、分页、超时与消费语义；只移植必要 HTTP 封装。
2. 新增独立可禁用的 provider adapter、operation 描述和服务端 secret 配置；凭据缺失只阻断其自身操作。
3. Hub 公共路由复用 tenant/consumer/Key 状态、明确 scope、Key 快照、配额和幂等校验。未开通返回 403，且不触达上游。新增能力不扩张历史 Key。
4. 落库并记录真实调用证据，响应采用 Hub 合同与 requestId；不透传内部错误堆栈、上游 URL、请求头、供应商标识或私有游标。
5. “外部数据平台”新增管理观察项；“数据产品”新增与小红书接口调试风格一致的页面，复用共享身份选择、组件与主题。
6. 同步更新 tenant 文档/OpenAPI 可见性和能力诊断。页面隐藏不能代替后端授权。

调试页只列当前 Key 允许的固定 Hub 接口；参数变化重置请求身份，相同参数失败重试保留幂等键。只有显式“新请求”可再次执行相同查询。切换身份清空响应与参数中的身份相关状态；浏览、切换视图、查看文档均不得触发采集。

## 7. 计量与待定价

上游采购价格与客户销售价格独立。用户此次明确“暂不定价但详细计量”，所以 ipsearch 需要显式 metering-only 策略，不能填一个虚构的零价来通过现有付费 provider 门禁，也不能放宽 JustOne/TikHub 的现有门禁。

客户账单状态为未定价/未扣费，金额 nullable；采购价格未知则保持 unknown。计量模式仍执行次数配额、QPS、并发、超时及 operation 开关。未来价格发布只影响生效后新请求，不追溯扣除历史请求。

| 记录层 | 必需证据 |
| --- | --- |
| Hub 请求事件 | requestId、tenant/consumer/Key ID（非 secret）、业务 operation/版本、请求 hash、时间、耗时、结果/拒绝码 |
| 幂等逻辑请求 | 幂等身份、首次请求与 replay 关系、处理中/成功/失败/结果未知状态 |
| 上游 attempt | 独立 attemptId、内部 provider/operation/adapter/credential 版本、dispatch 时间、HTTP 与业务状态、耗时、字节/返回条数、是否已确认计费或未知 |
| 入库证据 | archive hash/ref、ingest job、规范化状态、canonical revision、索引状态与错误 |
| 定价快照 | metering-only 标识、客户价版本或 null、采购价版本或 null、币种/金额或 null |

分别展示请求数、逻辑执行数、上游实际调用数、成功交付数、空结果数、失败数、未知结果数、授权/限流拒绝数、缓存命中与幂等回放数。没有供应商确认时不能从 HTTP 200 推断已计费；上游成功但数据无法规范化也不等于 Hub 成功交付。

401 无法归属租户的请求只进独立安全/流量统计。租户使用记录不暴露供应商 attempt 明细，管理端可按 requestId 关联。禁止把 secret 或完整请求参数直接写到普通日志。

## 8. 数据源目录的外部操作

当前已存在的接口，不需再建第二份目录：

| 用途 | 当前接口 |
| --- | --- |
| 列表/创建 | `GET/POST /internal/v1/admin/source-catalog` |
| 详情/修改状态与字段 | `GET/PUT /internal/v1/admin/source-catalog/:id` |
| 逻辑删除/恢复 | `POST /internal/v1/admin/source-catalog/:id/archive`、`.../:id/restore` |
| 分类列表/创建 | `GET/POST /internal/v1/admin/source-catalog/taxonomy` |
| 分类修改 | `PUT /internal/v1/admin/source-catalog/taxonomy/:id` |
| 审计 | `GET /internal/v1/admin/source-catalog/:id/events` |

修改和归档须提交当前 revision。coverageStatus、deliveryStatus、字段审核与 runtime health 是独立维度；改成“已完成”不代表接口健康或已经落库。删除使用归档，保留历史引用与证据。

这些管理操作目前通过 `requireSourceAdmin` 限定为 Hub Admin Token，不是普通外部客户 Key 可写的 API。内部可信自动化可以复用；第三方脚本不应获得全局 Admin Token。若要让供应方直接维护目录，应另增限定来源范围的服务凭据与 catalog-write 权限，并复用同一 PG 版本化写入服务。该细粒度机器写权限是后续工作，不能通过公开 Internal 路由代替。

## 9. 验收与尚未完成项

ipsearch 上线前需要通过：未授权零上游调用；已授权请求留完整用量与归档；租户不能读别人的结果；暂停/撤销授权即时生效；并发相同幂等请求只发送一次；超时未知不重发；响应漂移保留证据；落库重试不重新采集；无价格不扣费且不显示虚构金额；错误/文档/响应均无上游身份与 secret；现有 JustOne/TikHub、Hub 身份测试和构建通过。

仓库已实现 ipsearch 路由、产品调试页、固定 HTTP 适配、迁移 081/082、数据库凭据配置与热轮换、单条及批量查询和仅计量模式。首期持久化到 PG 受限 archive 与调用者范围快照，不自动发布到共享 canonical/ES；通用 Push/worker 插件协议仍为规划。真实 key 联调、生产迁移与上线尚未执行，不能把本地测试视为 MX-H2I 线上登录回归。
