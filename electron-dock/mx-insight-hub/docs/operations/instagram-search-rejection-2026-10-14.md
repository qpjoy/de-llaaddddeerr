# Instagram 搜索 HTTP 400 排查（2026-10-14）

## 2026-10-15 后续：策略搜索数据产品

后续用户要求将搜索路由产品化，当前实现与发布要求以 [策略搜索](../product/strategy-search.md) 为准：新增 migration 150，将 Instagram 默认固定 JustOne 持久化，支持管理员切到 TikHub 或配置仅限派发前的主备策略。新增带供应商标记的分页继续原供应商；旧未标记游标保留事故处理时的回放与重启规则。Facebook 继续使用原额度配置，其他平台保持当前路由。以下“无需新增数据库迁移”“新请求只派发 JustOne”描述的是先前单次代码切换阶段，不代表产品化后的全部模式。事故事实、原错误与费用记录不变，仍未证明生产恢复。

## 2026-10-15：按用户要求将标准搜索切到 JustOne

本节替代下文事故调查时的“标准搜索仍固定 TikHub”路由结论；历史请求、费用和供应商错误事实保持原样。
用户确认改用 JustOne 后，新增 Instagram 标准搜索直接使用
`GET /api/instagram/general-search/v1`（操作 `native.j.api_7968b9ed3e986618`）。
覆盖 `/api/v1/data/search`、`/api/v1/search/raw` 和 `/api/v1/night-all/search/raw`。
显式 TikHub 原生接口、用户资料及评论接口不在本次搜索切换范围内。

### 已核对的证据

- [官方接口文档](https://docs.justoneapi.com/zh/api/instagram/general-search-v1)：输入是 `keyword` 和可选 `paginationToken`。首页沿用已登记合同默认空 token；不传 TikHub 的 query、next_max_id、rank_token 或 enable_metadata。
- [官方公开响应示例](https://api.justoneapi.com/status/api-example/detail?api=%2Fapi%2Finstagram%2Fgeneral-search%2Fv1)：`synthetic:false`，`checkedAt=2026-10-15T00:00:09`（未标时区）。这是公开文档示例读取，不是付费采集。
- 成功 envelope 为 `code=0`；业务列表在完整响应的 `data.data.items`，分页令牌在 `data.pagination_token`，下一页以 camelCase 输入参数 `paginationToken` 传回。完整官方样例的 8 条帖子、封面和视频均通过离线投影；仓库仅保存匿名结构 fixture。
- 线上 Admin 只读检查：操作“正常”，策略修订 #2，发布 #2，价格表 #229，当前无运行阻断项；JustOne DB Key 已配置。沿用 2026-10-06 的 CNY 1 最小单位（¥0.01）临时采购预算估值，不将其标为已核实的 JustOne 实际收费。客户仍按原 Instagram/raw 费率结算。

### 切换行为

新请求只派发一次 JustOne，保持已有标准响应格式、Instagram 平台授权和客户 meter；不增加 social/native grant，不修改 Key、套餐、价格或历史账本。失败或未知结果不会自动回到 TikHub、Night-All 或 RapidAPI，也不会自动重发付费请求。

新游标绑定 JustOne、原 Key、查询、页大小及 raw/data 路径。上游返回超过页大小时，先归档完整结果，再从同一归档分页；后续缓冲不再采购、不重复入库，客户按现有每请求规则结算。读取归档同时核验供应商、操作、端点、合同、归属、成功状态、24 小时有效期与 SHA256。

旧 TikHub 和 Night-All 游标不能转换成 JustOne token。已提交请求在原重放窗口内仍原样返回；需要重新采集时，旧游标返回 `409 search_restart_required`，调用者明确从第一页使用新的 Idempotency-Key 开始。旧失败记录不会变成成功；data/search fresh 仍是 120 秒窗口，未知结果不能靠反复 POST 验证。

原始/标准搜索页大小支持 1–100，单关键词。不能映射的复杂 raw 参数明确拒绝，不绕回旧供应商。保留最多 15 页；只有明确的空字符串或 null token 才作为终页，缺失/错误类型/循环 token 返回合同错误，保存上游付费证据。官方样例只证明非空续页，真实终页尚未验证。

### 验证与发布

本地回归覆盖原生 GET、中文与特殊字符、标准响应、历史回放、旧游标与缓冲退休、一次结算、跨 Key/路径隔离、归档完整性、SQL 原子提交和失败不回退。最终合并回归 175/175 通过、无跳过，含本地 PGlite；类型检查、构建和 diff 检查通过。入库 worker 已接受 JustOne Instagram 标准/raw 数据集并保留旧 TikHub 队列；测试没有发起生产搜索。

无需新增数据库迁移。当前仅完成本地实现，生产还未切换；完整运行可用性需发布后用正常业务请求和诊断账本核对，不能由官方示例或当前门禁状态保证。
同步代码后，在 Hub 项目目录由有生产集群权限的操作者执行：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 bash scripts/manage.sh ops internal-production deploy
```

此发布仅针对 Hub；保留 MX-H2I 登录、联网与 Launcher。下文为 TikHub 事故及已消耗的单次付费验证记录。

## 本次授权的单次复测

用户已明确授权以原参数发起一次新的付费请求，不依赖联系 TikHub。该授权已执行一次，结果如下；不要再次执行付费验证。

| 项目 | 单次复测结果 |
| --- | --- |
| 新 Hub requestId | `9c43a396-57bc-433d-9eba-1f30c3762631` |
| 请求 / 完成时间 | 2026-10-14 15:18:55.028 / 15:18:57.434 UTC |
| Hub 结果 | committed / HTTP 502 / upstream_request_rejected / live |
| 唯一供应商调用 | `c68723fb-9a3a-48a8-b1fa-908b877e745e`，TikHub Instagram V3 general_search，2235 ms |
| TikHub 结果 | HTTP / 业务码 400，上游 ID `1abb8631-5af7-4002-8d39-97d853c58dcb` |
| 新归档 | 哈希校验通过，834 字节；detail.message 194 字符，仍为 request_failed_no_charge_claim，没有具体字段说明 |
| 成功结构校准 | not_success_envelope，无 data/items/media_grid 等成功数据，不能据此放宽成功解析 |
| 供应商实际计费 / 客户结算 | billed=null（未知）/ captured、enforced、CNY 0.01 |

参数相同的新请求再次遭到上游拒绝；这证明当次故障仍可复现，不能由通用 400 确定为具体参数错误或供应商内部故障。
原账本与新账本分别保留，不执行自动退款、错误转成功或额外付费重试。
以下命令记录本次执行方式；如需继续核查，只使用 `--inspect`。
本机没有生产 Kubernetes 上下文；以下脚本由有集群访问能力的操作者执行，无须重启或部署服务。
脚本读取原请求完整快照和原 Key，通过现有 Admin 临时身份和 Public API 发起一次请求，沿用当前授权、路由和价格。

先将 `server/ops/revalidate-instagram-incident.mjs` 同步到服务器 checkout，在仓库根目录执行：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - --execute-once \
  < electron-dock/mx-insight-hub/server/ops/revalidate-instagram-incident.mjs
```

脚本固定原请求与新幂等身份 `instagram-one-shot-059572f9-bdf3-4b64-96b9-c7eebd530338`，
执行前只读查重；即使已提交结果超过 fresh 的 120 秒窗口，只要存在这次请求记录便停止发送。
不要并发执行，不要修改固定身份；若 HTTP 结果未知，只能把 `--execute-once` 改为 `--inspect` 查询已保存的新 requestId。
未发现记录也不代表上一次一定未发送，不能据此自行重试。输出只含状态、关联 ID 与结构摘要，不输出凭据、关键词或游标。
取得新 requestId 后分别核对供应商调用、归档结构、返回条数和客户结算；缓存命中或单次成功均不代表供应商持续恢复。

本次同时扩展管理台的 Instagram 原参数验证入口：限定保存的 `POST /api/v1/data/search` 与本次 TikHub 原生调用证据，
参数只读，保留原 Key；采集历史页引导到请求诊断发送，避免页面切换丢失未确定状态。
Instagram 结果未知时不再次 POST：fresh 的重放窗口有限，不能把同幂等键重发一律当作免费只读查询。

## 已确认的线上证据

原请求调查阶段通过用户现有管理会话只读查看诊断；后续单次付费复测另记于文首。

| 项目 | 保存的事实 |
| --- | --- |
| Hub requestId | `ddecf6fe-c6e9-4632-9fb6-67014bdf261a` |
| 请求 / 完成时间 | 2026-10-14 09:39:04.633 / 09:39:06.861 UTC |
| Hub 结果 | instagram / committed / HTTP 502 / `upstream_request_rejected` / live |
| 下游错误 | `external_platform_rejected` |
| 供应商操作 | TikHub `native.t.instagram_v3_general_search` |
| TikHub 结果 | rejected / HTTP 400 / 业务码 400 / 2016 ms |
| TikHub requestId | `1843e295-eaf0-4f7b-9d8a-7d6439a12a9b` |
| 原始响应 | 运维返回 `archive_verified/hashVerified=true`，834 字节；当前页面不展示未审核的消息 |
| 供应商计费 | 历史 billed 未知；已校验消息声明本次不收费；1 USD 最小单位为 estimated，不能作为实际扣费证据 |
| 客户结算 | captured / enforced / 1 CNY 最小单位，即 CNY 0.01 |

该请求已实际到达 TikHub，不能归因为 RapidAPI 缺 key、Hub 凭据门禁、429 或 HTTP 200 后的 Instagram 投影失败。
现有嵌套错误元数据提取已正常记录业务码和上游 requestId；没有证据表明需要再次修复该适配器逻辑。

## 参数核对与待确认项

### Swagger 原始定义逐项校准

2026-10-14 按用户提供的 [Swagger operation](https://api.tikhub.io/#/Instagram-V3-API/general_search_api_v1_instagram_v3_general_search_get)
读取 [OpenAPI 原始定义](https://api.tikhub.io/openapi.json)。该链接的 operationId 与实际调用路径完全对应。

| 项目 | 官方定义 | Hub 标准搜索实际行为 |
| --- | --- | --- |
| 方法 / 路径 | GET `/api/v1/instagram/v3/general_search` | 一致；Hub 自身的 POST `/api/v1/data/search` 会转为此 GET，无请求体 |
| `query` | 必填 string | 原 query 作为 URL 查询参数，中文、空格、`#`、`&` 等由 URLSearchParams 编码 |
| `next_max_id` | 可选 string，首页省略 | 首页不传；后续页从保存的上游续页信息获取 |
| `rank_token` | 可选 string，首页省略 | 首页不传；后续页保留上游 token，不重新生成 |
| `enable_metadata` | 可选 boolean，默认 true | 标准路径显式传 boolean true，在线路上编码为 `enable_metadata=true` |
| `count` / `pageSize` | 此端点未声明 | 不传给 TikHub；Hub 在已归档结果内分页 |

“首次只传 query”是最小调用示例；并不禁止显式传可选 `enable_metadata=true`。
GET 的查询字符串本来就是文本，归档回显 `"true"` 不能据此认定布尔类型错误。
也不应给所有查询自动补 `#`：只有用户明确搜索话题标签时才使用该前缀。

成功响应引用通用 `ResponseModel`，其 `data` schema 为 `anyOf: [{}, {type: "null"}]`，没有声明 Instagram 的内部字段类型。
Swagger 展示 `data: "string"` 是通用示例，不能把实际搜索结果强制解析成字符串，也不能把该示例作为帖子搜索成功数据。
官方正文描述 users/places/hashtags、num_results 和续页字段；原生入口保留业务数据，标准帖子搜索不把账号/地点/话题冒充帖子。
`docs` 字段说明它是当前端点的文档链接，本身不指出哪个参数失败。
422 对应 `HTTPValidationError.detail[]`，而本次是 HTTP 400、`detail` 对象及通用失败消息，两者不能混用。

确认并修复一处元数据缺口：已发布的 `t.instagram_v3_general_search` 使用旧库存记录，遮蔽了同路径官方定义的 type/default/description。
现在此 key 复用已核对的四项官方参数元数据，Hub 原生文档可正确显示 string/boolean 与 true 默认值。
保留旧 key、endpointVersion、操作授权和标量兼容，不注入被省略的默认参数，不改变请求指纹。
旧请求的归一化发生在幂等回放识别之前；此处贸然收紧旧标量输入会阻断历史回放，故未增加这种不兼容校验。
标准 data/search 的参数原本已符合定义；这一元数据修复不能被称为两次 HTTP 400 的根因修复。
本轮 Swagger 校准回归 111/111 通过，包括原生转发、provider expansion、Instagram 投影、raw/data 路由；
类型检查、构建及生成文档字段检查通过。专项覆盖默认值省略、显式 false/true、`#fashion` 和中文特殊字符、
双游标编码、历史标量指纹及通用字符串示例拒绝标准投影。所有验证使用本地模拟，没有新的付费请求；修改尚未部署。

Hub 的标准搜索与简单 raw 搜索使用 GET `/api/v1/instagram/v3/general_search`，
首页参数为 `query`、`enable_metadata=true`，续页才携带 `next_max_id`、`rank_token`。
`count` / `pageSize` 不发往该 TikHub 端点，Hub 通过现有归档分页机制限制交付条数。
这与 [TikHub 官方端点文档](https://docs.tikhub.io/419083058e0) 的参数集合一致。
下游日志中的 `operation=raw` 不能单独确定原始 Hub HTTP 路径。

运维已返回旧版只读脚本输出：原路径为 `/api/v1/data/search`，`query` 是长度 19 的字符串，
`pageSize=20`，无 cursor、keyword 或显式 page/count。`platform/operation/endpoint/contract=other`
是旧诊断白名单缺少 Instagram 的显示问题，不能据此认定供应商路由错误。

归档顶层缺少业务码、关联 ID 和消息；`detail.code=400`，关联 ID 与调用账本一致。
`detail.message` 长度 194，精确匹配 `request_failed_no_charge_claim`：通用请求失败，建议检查参数或联系支持，并声明本次不收费。
该分类来自本次已校验原始字节，不是套用另一条小红书请求的消息。
该消息未点名任何错误字段或内部阶段。运维随后运行免文件同步命令，返回 `hashVerified=true` 和以下 `detail.params` 摘要：

| 参数 | 本次归档中的形状 |
| --- | --- |
| `query` | 非空字符串，长度 19 |
| `next_max_id` | 未传 |
| `rank_token` | 未传 |
| `enable_metadata` | 非空字符串，长度 4 |

这与首页请求的参数形式相容。当前代码设置 `enable_metadata: true`，GET URL 查询序列化为字符串；
因此回显为字符串不能证明类型错误，长度 4 也不能独立证明实际原文为 `true`。
未读取关键词内容，参数形状相容不代表所有供应商业务条件都满足。
当前没有可确认的 Hub 请求映射缺陷，也不能将通用 400 确定为供应商内部故障；无需继续反复提取同一归档。
供应商声明不改变历史 `billed=null`，也不自动改变 Hub 客户已扣 CNY 0.01 的账本；本次没有执行退款或修改失败结算规则。
已有界面的“准备按原参数发起新请求验证”在此链路返回仅支持小红书的说明，没有发送请求。

## 只读获取缺失证据

本机仅配置 docker-desktop Kubernetes 上下文，没有 Hub 生产集群访问能力。
在可访问 Hub Kubernetes 的服务器仓库根目录执行：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - ddecf6fe-c6e9-4632-9fb6-67014bdf261a \
  < electron-dock/mx-insight-hub/server/ops/diagnose-tikhub-rejection.mjs
```

先同步本次更新的脚本即可通过标准输入运行，无须部署或重启服务。脚本使用只读事务并最终回滚，
核验归档字节长度和 SHA256，限定最多 10 条 TikHub 调用、每份档案 8 MiB。
它只输出固定错误分类、业务码、UUID 关联 ID，以及已知参数的类型/长度/空值摘要；
不输出关键词、分页 token、凭据或原始正文，不请求供应商。

本次补齐 Instagram 平台、操作、端点、合同和路径的诊断标识，避免它们被显示为 `other`；
同时补充受校验归档的已知 Instagram 参数形状，以便核对实际响应回显。
这项补丁修复诊断缺口，不能据此宣称上游 400 已恢复。

参数摘要现已由运维补回，以上命令保留作后续排查参考。用户随后授权执行上面的单次新请求，先以实际结果校准；供应商调查信息保留作参考，不作为继续排查的前置条件。现有通用消息不能说明具体原因，不盲目改参数或自动重试。
若没有受限归档读取权限，不扩大权限；由已有权限的运维执行。
同一幂等键会继续返回保存的失败响应，不能用来验证新请求是否恢复。

### 服务器仍返回旧版输出时

如果再次输出 `other` 且没有 `detail.params`，不能把缺少该字段解读为供应商没有回显参数。
可直接执行以下完整命令，不依赖服务器 checkout 或镜像中的诊断脚本版本。
它只读取此次已知请求、调用和 TikHub 供应商精确关联的归档，不调用供应商，也不修改账本。

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- node --input-type=module <<'NODE'
import pg from 'pg'
import { createHash } from 'node:crypto'
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000, query_timeout: 6000 })
let transaction = false
try {
  if (!process.env.DATABASE_URL) throw new Error('database_url_required')
  await db.connect()
  await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  transaction = true
  await db.query("SET LOCAL statement_timeout = '5s'")
  await db.query("SET LOCAL lock_timeout = '1s'")
  await db.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
  const { rows: [a] } = await db.query(`SELECT r.body_size, r.body_sha256,
    CASE WHEN r.body_size <= 8388608 AND octet_length(r.body_bytes) <= 8388608
      THEN r.body_bytes ELSE NULL END AS body_bytes
    FROM control.external_platform_restricted_raw_responses r
    JOIN external_platform.provider_calls p ON p.id = r.provider_call_id
    WHERE p.usage_request_id = $1 AND p.id = $2 AND p.provider_key = 'tikhub'
    LIMIT 1`, ['ddecf6fe-c6e9-4632-9fb6-67014bdf261a', '9618f10d-be5f-49ea-a529-0974de5109f7'])
  if (!a) throw new Error('archive_missing')
  if (!Buffer.isBuffer(a.body_bytes) || a.body_bytes.length > 8388608 || a.body_size !== a.body_bytes.length
    || createHash('sha256').update(a.body_bytes).digest('hex') !== a.body_sha256)
    throw new Error('archive_unavailable_or_integrity_failed')
  const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(a.body_bytes))
  const kind = v => v === undefined ? 'missing' : v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v
  const params = kind(payload) === 'object' && kind(payload.detail) === 'object' ? payload.detail.params : undefined
  const fields = Object.fromEntries(['query', 'next_max_id', 'rank_token', 'enable_metadata'].map(name => {
    const v = kind(params) === 'object' ? params[name] : undefined
    return [name, { type: kind(v), length: typeof v === 'string' ? v.length : null,
      empty: typeof v === 'string' ? v.length === 0 : null }]
  }))
  await db.query('ROLLBACK')
  transaction = false
  console.log(JSON.stringify({ diagnostic: 'instagram-params-v1', hashVerified: true,
    params: { type: kind(params), fields } }, null, 2))
} catch (error) {
  const safe = ['database_url_required', 'archive_missing', 'archive_unavailable_or_integrity_failed']
  console.error(JSON.stringify({ error: safe.includes(error.message) ? error.message : 'diagnostic_read_failed' }))
  process.exitCode = 1
} finally {
  if (transaction) await db.query('ROLLBACK').catch(() => {})
  await db.end().catch(() => {})
}
NODE
```

以上只读诊断保留供应商账本、客户结算、历史响应与路由，不新增自动重试、迁移或生产写入；用户授权的单次新请求另记于文首。未修改 MX-H2I 登录、联网和 Launcher。

## 供应商定位信息（已准备，未发送）

- TikHub requestId：`1843e295-eaf0-4f7b-9d8a-7d6439a12a9b`。
- 时间：2026-10-14 09:39:04.713 UTC 开始调用；Hub 于 09:39:06.861 UTC 完成。
- 接口：GET `/api/v1/instagram/v3/general_search`，HTTP / `detail.code` 均为 400。
- 首页请求：关键词非空、长度 19，无 `next_max_id` / `rank_token`；元数据参数回显为长度 4 的字符串。
- 已校验错误正文只有通用请求失败及本次不收费声明，未指出具体字段。
- 请核查本次失败阶段、是否存在未公开的参数限制，以及实际供应商扣费情况。

此信息可用于供应商工单，不含关键词、凭据或游标；尚未提交工单或发送外部消息。

## 本地验证

最终合并回归 74/74 通过，无跳过，数据库诊断使用已有本地 PGlite。
覆盖 Instagram 首请求/续页 HTTP 400 参数构造、原始字节/哈希保存、无自动重试、只读字段脱敏、
原 Key/原参数复测、过期 fresh 账本查重、未知状态锁、JSON 网关错误与畸形成功响应、XHS 兼容和 stdin 执行。
`npm run typecheck`、`npm run build`、`git diff --check` 通过；构建只有既有的大包提示。
本机浏览器使用隔离模拟服务确认参数只读，结果未知后无重发按钮，切换历史/诊断仍保持锁且仅一次模拟 POST。
本地测试未连接生产；实际单次付费验证及随后只读归档校验由操作者执行，结果记于文首。
上面的免文件同步命令另经 11 个离线场景验证，覆盖参数脱敏、缺失/畸形参数、归档大小/哈希、无效 UTF-8、数据库及回滚异常；这些异常模拟均在本地运行。

## 2026-10-14 调查时的可用性边界与备用候选

当前标准 Instagram 搜索只绑定 TikHub V3 综合搜索，没有已验证的自动备用链路。
仓库已登记 JustOne `native.j.api_7968b9ed3e986618`（`/api/instagram/general-search/v1`，keyword/paginationToken）
和 TikHub V2 `native.t.api_b946e02da1c2bce3`（`/api/v1/instagram/v2/general_search`，keyword/pagination_token）。
登记不代表线上已启用、已有权限或价格：JustOne 缺少已核实的端点采购价；TikHub V2 的官方目录价格也不是实际扣费证明。
两者的成功数据与分页语义均未在本次验证，不能直接切换并沿用 V3 游标或投影；本次没有请求它们。
要提高持续可用性，需要先核实备用操作的准入、价格与真实响应，再设计明确失败后的受控切换，未知结果不能盲目双发。

本轮修改仍待部署。同步代码后，由操作者在 Hub 项目目录运行现有命令，仅部署 Hub，禁用 Launcher 同步：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 bash scripts/manage.sh ops internal-production deploy
```

该段记载 2026-10-14 的诊断补丁边界；最新 JustOne 搜索切换与发布说明见文首。切换不能宣称修复了 TikHub 上游的 400。
