# Telegram 已收录数据：下游策略接入指南

状态：2026-10-19 按当前仓库的公共路由、参数校验、搜索实现及合同测试核对。本文可用于下游开发；**代码存在不代表目标环境已发布、数据已追平或索引已经就绪**。部署验收与尚未实现的策略能力分别列在文末。

**本次接入前必须发布 TG 专用搜索修复**：旧实现先校验并未列入该接口白名单的 `platform`，可能使按合同发出的请求直接返回 400。本次由专用路由固定 `telegram`，并统一默认页大小。下游不要通过给专用请求添加 `platform` 绕过问题；按本文 body 联调修复后的服务。

推荐链路是：发现授权能力 → 按来源、会话、作者和时间窗搜索 → 用游标逐页保存 → 只对需要阅读的命中拉取上下文或双向时间线。以下接口均读取 Hub 已收录数据，不在查询时请求 Telegram、Night-All 或供应商。不要把其他平台的实时采购搜索规则套到这些接口。

## 1. 选择接口

| 下游任务 | 公共接口 | 主要边界 |
| --- | --- | --- |
| 查询当前 Key 可用能力、限制、上下文就绪状态 | `GET /api/v1/data/capabilities` | 先检查 Telegram grant 和 `context.ready` / `timeline.ready`；能力发现不证明数据完整 |
| 浏览／筛选会话目录 | `GET /api/v1/data/telegram/chats` | `sourceScope`、`kind`、`query`；支持历史游标 |
| 获取会话已有消息，不要求命中关键词 | `GET /api/v1/data/telegram/messages` | `sourceScope`、`chatId`、`from`、`to`；支持历史游标 |
| 有关键词和 TG 策略过滤条件 | `POST /api/v1/data/telegram/search` | 首选；支持来源、对象、会话、作者、时间窗；当前仅 `matchMode=full_text` |
| 选择短语／全词等受控检索模式 | `POST /api/v1/data/canonical/search` | 指定 `platform=telegram`、`objectType=message`；支持 `searchProfile`，不支持 TG 会话／作者／时间过滤 |
| 命中附近有限消息 | `GET /api/v1/data/canonical/items/{id}/context` | 固定前后窗口，无续页 |
| 命中后持续向前／向后阅读 | `GET /api/v1/data/canonical/items/{id}/timeline` | 双向签名游标；`newer` 可轮询；不是变更订阅 |
| 根据人名／用户名／会话名找候选实体 | `GET /api/v1/data/telegram/entities/search` | 仅 Monitor，Top-N 候选，无 cursor，不是全量作者或会话导出 |

兼容入口 `POST /api/v1/data/search` 的 `platform=telegram` 仍只查 Monitor messages，适合已有调用方保持兼容。新 TG 策略不要用它代替专用接口。`POST /api/v1/data/stored/search` 也可通过精确 `datasetId` 搜索单一数据集；下游通常不需要同时接入全部搜索入口。

截图中的后台 `/internal/v1/admin/...` 产品页面和高级 RAG 检索属于管理面，不能作为外部客户接口。下游只接本文 `/api/v1/...` 路由。

## 2. 鉴权、范围与请求身份

使用正常签发的 Hub Public API Key：

```http
Authorization: Bearer <Hub Public API Key>
```

需要有效的 `telegram` 平台授权，且受到当前 Key、consumer 的权限和额度约束。新 Key 是签发时选择的授权快照；后来给 consumer 增加权限，不会自动扩大旧 Key。不要传 Admin Token、Launcher Cookie、供应商凭据、tenantId 或物理数据库信息。

**当前 Telegram 数据是共享授权语料，不是逐租户隔离的数据包。** 有效授权限制谁能访问及如何计量，不会自动按租户划分消息行。需要按客户专属会话集合交付时，必须先增加明确的数据范围授权合同，不能把客户端 `chatId` 过滤视作服务端安全边界。

POST 搜索必须传 `Idempotency-Key`：8–128 字符，匹配 `^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`。约定每个“策略版本 + 查询轮次 + 子查询 + 页”有一个标识；重试原页保留原路径、body、Key 和标识，下一页换标识。不要在两个并发页之间共用标识，也不要更换 API Key 接管原请求。

专用 TG 搜索只支持默认 `fresh`，**不能传 `type`**；已提交响应默认回放窗口为 120 秒，超过窗口不能再把同一标识当作永久去重记录。Canonical 搜索接受 `type=fresh|stable`，`stable` 可保持已存响应的重放，但不会延长搜索 PIT 的寿命。下游应持久化已成功交付的页和消费状态。

安全 GET 不要求幂等键，每次请求／重试独立计量。TG 历史、实体、上下文、时间线按现行平台规则计量；搜索同样受到授权、策略和用量规则约束。零供应商请求不等于免计量。用量单位和最终价格不是同一个概念，以当前 Key 与套餐为准。

## 3. 来源、对象与 ID

### 两个 scope 不要混用

| 参数 | 值 | 含义 |
| --- | --- | --- |
| `sourceScope` | `monitor`（默认）、`sqlite`、`all` | 选择收录来源；新多来源调用显式传值 |
| `scope` | `messages`（默认）、`chats`、`all` | 专用 TG 搜索的结果对象类型 |
| `kind` | `all`（默认）、`channel`、`group`、`unknown` | 仅会话目录使用 |

数据集为 `telegram.monitor.chats.v1`、`telegram.monitor.messages.v1`、`telegram.sqlite.chats.v1`、`telegram.sqlite.messages.v1`。Canonical 搜索指定 `platform=telegram` 且不传 `datasetId`，可跨两种来源；传精确 `datasetId` 则只查一种。不要假定两种来源的相同 externalId 会由 Hub 自动合并成一条。

### 建议保存的标识

| 字段 | 用途 |
| --- | --- |
| `canonicalId` | Hub 内稳定 UUID，适合数据去重及 context/timeline 路径 |
| 搜索结果 `id` | Canonical 搜索与 TG 专用搜索中也是 canonical UUID；TG 搜索另外显式返回 `canonicalId` |
| 历史结果 `id` / `externalId` | 源业务 ID，**不是** context/timeline 所需 UUID；取同一行 `canonicalId` |
| 会话目录 `chatKey` | 例如 `monitor:<会话 canonical UUID>`；传给 messages GET 可精确选择来源和会话 |
| 会话目录 `externalId` | 原始规范化聊天 ID；传给 TG 搜索的 `chatId` |
| `author.id` | 原始规范化作者 ID；传给 TG 搜索的 `authorId` |
| 历史行 `dataVersion` | 当前 canonical revision 的字符串形式；用来记录已观察到的版本，不是 CDC 游标 |

专用 TG 搜索目前**不解析 `chatKey`**。从会话目录进入搜索时，用该会话的 `externalId` 作为 `chatId`，并带准确 `sourceScope`；不要把 `monitor:UUID` 直接放进搜索请求。

messages GET 使用 qualified `chatKey` 时，即使传 `sourceScope=all`，也只读取该 chatKey 对应的一种来源。要明确合并两种来源同一聊天，传 `sourceScope=all` 和原始外部聊天 ID。来源不匹配返回 `400 source_scope_mismatch`，会话不存在返回 `404 chat_not_found`。

## 4. 当前可执行的搜索规则

### TG 策略过滤

`POST /api/v1/data/telegram/search` 只接受以下 JSON 字段；未知字段会被拒绝：

| 字段 | 规则 |
| --- | --- |
| `query` | 必填，去除首尾空白后非空，最多 500 字符 |
| `sourceScope` | `monitor|sqlite|all`，默认 `monitor` |
| `scope` | `messages|chats|all`，默认 `messages`；策略正文搜索建议固定 `messages` |
| `matchMode` | 仅 `full_text`，默认同值 |
| `chatId`、`authorId` | 可选精确规范化 ID，各最多 256 字符，不是模糊条件 |
| `from`、`to` | 可选，完整 RFC3339 日期时间，必须有 `T`、秒和时区；边界包含，`from <= to` |
| `pageSize` | 正整数，专用搜索默认 `min(50, 当前授权上限)`；不超过当前授权上限和 100，建议显式传 20–50 |
| `cursor` | 首次省略，后页原样传 `pageInfo.nextCursor`，最多 8192 字符 |

过滤维度之间取 AND。`chatId`/`authorId` 是单值，不支持数组。时间按消息 `eventTime` 筛选；带时间条件的查询不会匹配 `eventTime=null` 的记录。起止时刻均包含，连续窗口在边界可能重复，必须去重。

### 关键词不等于表达式

当前公共 `query` 是文本，不解析 Boolean AST。`A AND B`、`A OR B`、`(A OR B) AND C`、`NOT`、`*`、`~` 或引号不是公共内容搜索操作符；不要让策略系统拼接这些字符串。`matchMode=and|or|phrase|fuzzy` 也不是当前允许值。

专用 TG 搜索使用默认 `canonical.balanced.v1`：原文短语分支，或 HanLP 正常时的全部分词 AND 分支。这里的 AND 是服务端分词结果的规则，不是调用方自定义关键词组。

需要受控匹配选择时，Canonical 搜索的 `searchProfile` 支持：

| 策略意图 | `searchProfile` | 精确边界 |
| --- | --- | --- |
| 默认平衡 | `canonical.balanced.v1` | 原文短语，或全部 HanLP 分词匹配 |
| 有序短语 | `canonical.phrase.v1` | 原文分析表示上的有序短语；不是逐字节相等或正则表达式 |
| 全部分词 | `canonical.terms-all.v1` | 要求每个分词匹配，可允许词序不同；不是用户定义的词组数组 |
| 中文召回补充 | `canonical.zh-recall.v1` | 平衡策略增加较低权重的有序 CJK bigram 分支；不是编辑距离纠错 |
| 标题／名称前缀 | `canonical.title-prefix.v1` | 标题、作者名、handle、用户名、会话名的受控前缀；索引前缀最长 12 字符 |

Canonical 的 TG 请求可传 `query/platform/datasetId/objectType/searchProfile/sort/pageSize/cursor/type`；`sort=relevance|newest|oldest`。不要把专用 TG 的 `chatId`、`authorId`、`scope`、`sourceScope` 放进去；该入口的 `from/to` 当前是舆情过滤合同，不能用于 Telegram。PG 降级固定按事件时间倒序，严格排序策略也需要处理降级。

若 HanLP 降级，依赖其分词的公共 profile 可降为原文 phrase，并报告 `search_profile_degraded`。若 ES 首次请求不可用，会降为 PostgreSQL 子串搜索：TG 响应通过 `warnings` 报告，Canonical 另外返回 `searchMode`、`search.requestedProfile/appliedProfile/degraded`。**降级不是相同匹配规则的等价执行。** 对匹配语义严格的策略，应将带降级告警的轮次标记为待复核，不应把它记为完整零命中或精确策略完成。

公共合同没有 SQL 通配符语法。本次配套修复为公共 PG 回退转义 `%`、`_` 和反斜线，使它们按字面字符查询；该修复需要发布后验证。不要依赖旧环境未转义行为做 wildcard 查询。

### 当前如何实现多个关键词

在新公共 Boolean 合同发布前，采用下游编排并明确成本和完整性：

1. **OR 候选集合**：把多个独立关键词作为独立子查询，各自完整翻页，最后按 canonical UUID 求并集。每个子查询有独立 cursor、页标识与完成状态；不要合并不同查询的相关性分数，也不要把并集当成一个全局排名分页。
2. **严格业务 AND / 排除条件**：用有区分度的必要词召回，在返回的 `title/text` 上按下游版本化规则复核。需要比较用户指定词组时，不要把 `terms-all` 的分词 AND 当成词组 AND。只处理首屏无法证明全量匹配；召回或降级语义也可能漏检，需要把该方案标记为候选检索。
3. **同义词／错别字**：下游维护有版本的词表，拆成有限子查询再去重；不宣称 Hub 已提供正文 fuzzy。实体搜索可辅助找作者／会话 ID，但仅返回 Monitor 的 Top-N 候选。

下游建议保存 `strategyId`、`strategyVersion`、关键词规范化规则、分组逻辑、sourceScope、会话／作者、时间窗、profile、子查询／页进度和降级告警。这些是下游记录字段，**不要直接添加到 Hub JSON 请求体**。

### 一套可直接实现的下游分组规则

以下 `client.literal-groups.v1` 是建议下游自行固定的规则名，不是 Hub 已发布的 `contractVersion`：

```json
{
  "ruleVersion": "client.literal-groups.v1",
  "allGroups": [["人工智能", "AI"], ["芯片", "算力"]],
  "none": ["广告合作"],
  "phrases": []
}
```

定义：`allGroups` 组内 OR、组间 AND；`none` 任一命中即排除；`phrases` 中每项都要求连续字面出现。用于客户端判定的文本是当前条目的 `title` 和 `text`，两个字段分别匹配，不跨字段拼接成一个假短语。文本和词统一 Unicode NFKC、英文字母小写；不自动去标点、删空格、改繁简或扩展同义词。空词／空组在创建策略时拒绝。

适用例子：

| 下游需求 | 规则及执行 |
| --- | --- |
| `人工智能 OR AI` | `allGroups=[["人工智能","AI"]]`；两个 TG 子查询各自翻页，再按 canonical UUID 求并集 |
| `(人工智能 OR AI) AND (芯片 OR 算力)` | 选择有区分度的一组（例如芯片／算力）作两个召回子查询，再在并集上复核两组 literal 匹配 |
| 同时出现词但不要求顺序 | 上述客户端规则可明确比较业务词；若接受服务端分词语义，独立使用 canonical `terms-all`，不要声称二者等价 |
| 必须包含连续的 `大语言模型` | `phrases=["大语言模型"]`；先用这一文本召回，再 literal 复核；canonical `phrase` 可提高服务端精度但仍需遵守降级处理 |
| 排除 `广告合作` | 在候选上用 `none` 复核；不发只有排除条件的全库查询 |

可使用以下无外部依赖的 JS 作为客户端复核函数；词表应先校验为非空字符串数组：

```js
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase()
function matchesLiteralGroups(item, rule) {
  const fields = [normalize(item.title), normalize(item.text)]
  const contains = term => fields.some(text => text.includes(normalize(term)))
  return rule.allGroups.every(group => group.some(contains))
    && rule.phrases.every(contains)
    && !rule.none.some(contains)
}
```

客户端建议限制每组最多 8 个召回词、每策略最多 4 组、同时运行至多 2 个子查询作为起点；这些是下游资源预算建议，不是 Hub 服务端承诺的上限。超过预算将策略标记待细化，不自动展开大量组合。每个子查询的 cursor 链顺序消费。该方案明确最终命中的业务含义，但不证明 ES 分词召回覆盖全部 literal 匹配；多查询各自有 PIT，不提供跨子查询同一原子快照。并集不保留全局相关度，也不能把各子查询 totalCount 相加成唯一结果数。

## 5. 游标、时效与一致性

| 接口 | 分页方式 | 时效和一致性 |
| --- | --- | --- |
| TG / Canonical 搜索，ES 模式 | PIT + `search_after`，查询 `pageSize+1` 判断后页 | PIT 每次实际搜索续期 2 分钟；属于本轮索引视图，不等于源数据完整；继续页固定同一后端及首屏分析状态 |
| TG / Canonical 搜索，PG 模式 | `event_time DESC NULLS LAST, id DESC` 的 keyset | 无固定快照，无 cursor 内 TTL；当前数据可能变化；不得切换后端续页 |
| chats/messages GET，显式来源／新过滤 | 签名 v2 keyset，排序时间 + canonical UUID | 无 cursor 内 TTL；当前存储视图；cursor 绑定 resource、来源、过滤、页大小 |
| legacy Monitor history，省略新增范围条件 | 原 v1 history cursor | 保留兼容行为；新接入显式传 `sourceScope` 使用新合同 |
| timeline | 按 `(eventTime, canonicalId)` 独占边界向 older/newer 分页 | `live-keyset`，无 cursor 内 TTL；每次仍校验当前授权、上限和 serving indexes |
| context | 前后有界窗口 | 无 cursor，最大前 50 + 当前 1 + 后 50 |

搜索 cursor 绑定规范化 query、过滤器、页大小，以及相应 profile／来源／对象／授权平台集合和首屏分析状态。当前 TG 搜索和 history 的签名不包含独立 tenant/consumer 身份；它们仍在每次请求执行鉴权和共享 TG 语料授权。Timeline 则额外绑定 tenant、consumer、原始 anchor、精确数据集、聊天、方向和页大小。统一按同一凭据、同一条件保存和使用，**不要跨客户传递任何 cursor**。

各类 cursor 互不兼容；不要解码、拼装、截断，也不要使用页号或 offset 替代。`pageIndex` 是说明字段，不支持随机跳页。`hasMore` 与 `nextCursor` 驱动遍历；结果条数少于 pageSize、页面显示数量或 totalCount 都不能代替它。

ES cursor 过期返回 `410 search_cursor_expired`，需显式开新查询轮次、去掉 cursor、使用新幂等键并保留已有结果去重。现有 ES cursor 遇临时不可用返回 `503 search_cursor_unavailable`，保留原页重试，不能拿该 cursor 转入 PG。查询／profile／授权范围变化或签名错误一般返回 `400 invalid_cursor`。

幂等重放只重放已存响应，**不会续期 ES PIT**。不要先请求首屏、等待人工处理数分钟后再依赖同一 cursor。后台任务可尽快顺序拉完一个有限时间窗，把已交付数据持久化供用户稍后阅读。

Canonical 返回的 `totalCount` 仅在 `totalRelation=eq` 时是精确数，`gte` 是下界，未知时为 null；只有精确总数才返回 totalPages。TG 专用搜索不返回全量总数，更适合作为不需要统计总量的策略遍历入口。

## 6. 可复制的调用示例

所有 ID、关键词与域名都是示例；在下游安全环境注入 `HUB_URL` 与 `HUB_API_KEY`。不要把真实 Key 写入仓库。以下首次查询 JSON 不含 cursor。

```bash
# 0. 查询本 Key 的能力
curl --fail-with-body -sS "$HUB_URL/api/v1/data/capabilities" \
  -H "Authorization: Bearer $HUB_API_KEY"

# 1. 列出两类来源中的频道，目录有自己的 cursor
curl --fail-with-body -sS --get "$HUB_URL/api/v1/data/telegram/chats" \
  -H "Authorization: Bearer $HUB_API_KEY" \
  --data-urlencode 'sourceScope=all' \
  --data-urlencode 'kind=channel' \
  --data-urlencode 'query=技术' \
  --data-urlencode 'pageSize=20'

# 2. 精确读取选中目录项：TG_CHAT_KEY 使用返回的 chatKey
curl --fail-with-body -sS --get "$HUB_URL/api/v1/data/telegram/messages" \
  -H "Authorization: Bearer $HUB_API_KEY" \
  --data-urlencode 'sourceScope=all' \
  --data-urlencode "chatId=$TG_CHAT_KEY" \
  --data-urlencode 'pageSize=50'
```

保存策略首屏请求，例如 `tg-query.json`：

```json
{
  "query": "人工智能",
  "sourceScope": "all",
  "scope": "messages",
  "matchMode": "full_text",
  "from": "2026-10-18T00:00:00+08:00",
  "to": "2026-10-19T00:00:00+08:00",
  "pageSize": 20
}
```

示例使用下一日零点作包含式终点，避免以毫秒末尾猜测数据库的微秒边界；下一窗口可从同一零点开始，重复项按 canonical UUID 消除。

```bash
# 3. 先生成、保存本页标识；若超时，重试使用原标识和同一文件
TG_PAGE_KEY="tg-strategy-demo-$(uuidgen)"
curl --fail-with-body -sS "$HUB_URL/api/v1/data/telegram/search" \
  -H "Authorization: Bearer $HUB_API_KEY" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $TG_PAGE_KEY" \
  --data-binary @tg-query.json -o tg-page.json

# 4. 成功保存本页后才提交进度；有后页时生成下一页 body 与新标识
if jq -e '.data.pageInfo.hasMore == true' tg-page.json >/dev/null; then
  TG_NEXT_CURSOR=$(jq -er '.data.pageInfo.nextCursor' tg-page.json)
  jq --arg cursor "$TG_NEXT_CURSOR" '. + {cursor: $cursor}' \
    tg-query.json >tg-next-query.json
  TG_NEXT_KEY="tg-strategy-demo-$(uuidgen)"
  curl --fail-with-body -sS "$HUB_URL/api/v1/data/telegram/search" \
    -H "Authorization: Bearer $HUB_API_KEY" \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $TG_NEXT_KEY" \
    --data-binary @tg-next-query.json -o tg-next-page.json
fi
```

专用 TG 搜索返回结构（示意，省略可空业务字段）：

```json
{
  "data": {
    "contractVersion": "night-all.data-search.v1",
    "platform": "telegram",
    "query": "人工智能",
    "items": [{
      "id": "11111111-1111-4111-8111-111111111111",
      "canonicalId": "11111111-1111-4111-8111-111111111111",
      "externalId": "-1001234567890:42",
      "sourceScope": "monitor",
      "text": "示例消息",
      "source": { "provider": null, "endpointId": "hub-canonical-search" }
    }],
    "pageInfo": {
      "pageIndex": 1,
      "pageSize": 20,
      "returnedCount": 1,
      "hasMore": false,
      "nextCursor": null,
      "cursorType": "none"
    },
    "status": "ok",
    "warnings": [],
    "meta": { "providerCalls": 0, "paginationMode": "cursor" }
  },
  "requestId": "22222222-2222-4222-8222-222222222222"
}
```

需要 profile 的独立查询示例：

```bash
TG_CANONICAL_KEY="tg-phrase-demo-$(uuidgen)"
curl --fail-with-body -sS "$HUB_URL/api/v1/data/canonical/search" \
  -H "Authorization: Bearer $HUB_API_KEY" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $TG_CANONICAL_KEY" \
  --data '{"query":"人工智能","platform":"telegram","objectType":"message","searchProfile":"canonical.phrase.v1","sort":"relevance","pageSize":20,"type":"stable"}'

# 命中阅读：TG_CANONICAL_ID 取搜索 UUID，不能取历史 externalId
curl --fail-with-body -sS --get \
  "$HUB_URL/api/v1/data/canonical/items/$TG_CANONICAL_ID/timeline" \
  -H "Authorization: Bearer $HUB_API_KEY" \
  --data-urlencode 'before=10' --data-urlencode 'after=10'

# 后续保持原 anchor 路径，仅回传目标方向的 cursor
curl --fail-with-body -sS --get \
  "$HUB_URL/api/v1/data/canonical/items/$TG_CANONICAL_ID/timeline" \
  -H "Authorization: Bearer $HUB_API_KEY" \
  --data-urlencode "cursor=$TG_TIMELINE_CURSOR"
```

Timeline 首屏取 `pageInfo.older.cursor` / `pageInfo.newer.cursor`。续页不能同时传 before/after；返回 `pageInfo.direction` 指明方向，`anchorIndex=null`。两种方向的 items 都按时间升序，older 页前插，newer 页后接，按 canonical UUID 去重。前后各默认 10、硬上限各 50，timeline 还受 Telegram page-size grant 限制；context 的各 50 限制独立于搜索页大小。

`newer.hasMore=false` 时仍可能有 cursor，表示允许以后轮询；空页返回同一边界，非空页推进到新末尾。`older` 耗尽后 cursor 为 null。初始 anchor 被删除后，已经签发且仍有效的续页不需要重新读取 anchor。

## 7. 稳定、高效消费规则

1. **缩小数据范围**：能限定 sourceScope、chatId、authorId、时间窗就先限定；交互首屏 20 条，批处理通常 50 条，按实际响应体和耗时调整，不以每次拉最大页为目标。
2. **分页顺序执行**：同一 cursor 链不并发猜后页；多个策略可采用小型并发队列，遵守 Key 限额和 Retry-After。页数据与 nextCursor 应在下游同一事务提交，崩溃后重放原页再去重。
3. **列表不预取全部上下文**：先显示命中，用户打开一条时才拉 context/timeline；不对每条搜索结果额外发一个上下文请求，不在首屏循环拉完整会话。
4. **分别保留身份和版本**：至少存 canonical UUID、dataset/sourceScope、externalId、查询轮次、窗口、requestId、接收时间、警告及已见内容版本。跨数据集相同 externalId 不直接丢弃；如果业务需要合并展示，保留全部来源证据。
5. **区分业务时间与收录时间**：TG 专用搜索的 from/to 和 timeline 边界用事件时间，不是 ingest watermark。显式 sourceScope 的 messages 历史接口按有效排序时间过滤：eventTime 为空时依次回退 collectedAt、firstSeenAt；不要把该历史窗口等同于搜索的纯事件时间窗口。迟到消息可能出现在已越过的边界前，已有消息编辑／删除不会作为新事件推送。
6. **增量采用重叠复查，承认边界**：按固定窗口定期重新查询最近一段事件时间并去重，可降低迟到遗漏；窗口宽度由已观察到的延迟确定。它不保证发现任意久以前的迟到、修改和删除。当前无公开 `updatedSince`、单调 revision feed、删除事件或“恰好一次”增量合同。
7. **不要把后台数值当完整性证明**：hasMore=false 只表示该轮当前视图／范围没有后页。Monitor 的 `upstreamCompleteness=unknown`；SQLite 为 `bounded/append_only_overlap`。两者都不证明 Telegram 上游所有历史完整到达。

错误处理建议：

| HTTP / code | 下游动作 |
| --- | --- |
| 400 `unsupported_fields` / `unsupported_match_mode` / `page_size_exceeded` | 修正请求；不要反复原样重试 |
| 400 `invalid_cursor` | 核对 query、范围、profile、页大小、路径；显式新轮次重启并去重 |
| 401 / 403 | 处理凭据或授权，不降权绕过，不自动换客户 Key |
| 409 `idempotency_conflict` | 同一标识用于不同请求；修正下游页标识，不覆盖原页记录 |
| 409 `request_in_progress` | 保留原标识和 body，有界退避等待原请求完成 |
| 409 `request_outcome_unknown` | 保留 requestId 和原标识核对状态，不用新标识无限重试 |
| 410 `search_cursor_expired` | PIT 失效；新轮次、无 cursor、新标识，并对已有数据去重 |
| 429 | 按 Retry-After（若提供）及本地有界退避；减少并发，不增加翻页数规避额度 |
| 503 `search_cursor_unavailable` | 原 cursor／页请求稍后重试，不切换后端 |
| 503 `serving_indexes_unavailable` | 等待运维完成索引就绪；不要降为全表会话扫描 |
| 网络超时／502／504 | 保存原页身份，先核对 `GET /api/v1/requests/{requestId}`（若已获 ID），按原请求有界重试；不要立即新建整轮 |

## 8. 部署验收与后续策略合同

### 已实现，但目标环境待验收

- 发布后的 capabilities、真实授权及最大页大小；不要为测试自动扩大 grant。
- Monitor/SQLite ingest 健康、新鲜度与覆盖范围；代码不能证明当前积压已追平。
- 当前 ES 内容索引和 HanLP 状态；核对首屏、后页、PIT 过期、后端不可用和降级告警。
- 两个 TG 消息数据集的 context/timeline serving indexes 就绪；核对大／小会话的首屏延迟和正文体积。
- 同一查询 3 页以上无重复／漏页的边界样例、相同时刻不同 UUID、空时间、来源隔离、不同授权、并发重试和超时恢复。

本次配套代码改动修复 TG 专用搜索的入口参数冲突、默认页大小，以及 TG history／PG 搜索游标边界的微秒精度丢失；优化大消息量会话查询为先选有界 ID 再取正文，对公共 PG 子串回退和后台字面搜索作转义。目标环境需要发布后验证。本指南不代表已执行生产请求、发布、索引重建、历史回填或更改任何 SSO／MX-H2I 登录与联网配置。当前公共 canonical 搜索会计算总量，PG 降级时全量 count 可能增加延迟；需要 TG 过滤且不需要总数的策略优先使用专用搜索。大消息量会话延迟还取决于目标环境索引、数据库负载和响应体大小，不能承诺未经测量的加速倍数。

### 建议后续版本提供，当前不能发送

统一策略检索宜用有版本的结构化规则，而不是让客户提交 ES DSL：例如有限长度的 `all/any/none/phrases` 分组、明确定义的词组与分词关系、受控 fuzzy 强度和适用语言、统一 from/to/会话/作者过滤、排序和最大展开数量。新增规则应同时进入请求指纹、cursor 绑定及测试；首屏响应应报告规范化规则、实际匹配模式和降级情况。

建议先确定以下合同后再开放：

- OR 是同一检索内的候选并集；AND 在哪一层执行；NOT 是否允许仅排除无正向条件；词组是否跨字段匹配。
- 中文分词 AND、原文 phrase、子串、编辑距离 fuzzy 各自独立；名称模糊与消息正文模糊不能共用含糊定义。
- 有资源上限的查询树、禁用无限前导通配符／任意正则、最大时间窗／分组／terms／页数、取消与超时预算。
- PG 降级无法保持严格语义时，选择明确拒绝还是显式候选降级，不静默改变策略结果。
- 可靠增量另建单调变更序号和 tombstone 合同；不把现有 timeline live-keyset 改称 CDC。

### 维护依据

- [完整公共 API 合同](../contracts/public-api-v1.md#telegram-stored-data)、[OpenAPI](../contracts/openapi.yaml)
- [Canonical 搜索设计](../adr/0009-unified-canonical-search.md)、[搜索运行栈](../operations/search-and-observability-stack.md)
- [Monitor 收录与完整性](../operations/telegram-monitor-ingestion.md)、[SQLite 收录与边界](../operations/telegram-sqlite-api-ingestion.md)
- 源码：`server/data/telegram-monitor.mjs`、`server/data/stored-search.mjs`、`server/data/canonical-context.mjs`、`server/data/canonical-timeline.mjs`、`server/search/profiles.mjs`、`server/search/queries.mjs`、`server/hub-service.mjs`。
- 对应合同测试：`tests/server/telegram-monitor.test.mjs`、`canonical-search.test.mjs`、`canonical-context.test.mjs`、`canonical-timeline.test.mjs`、`canonical-timeline-http.test.mjs`。
