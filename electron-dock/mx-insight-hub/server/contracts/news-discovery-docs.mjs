const errors = Object.fromEntries([400, 401, 403, 404, 409, 429, 503].map(code => [code, { description: 'Hub error envelope with code, message and requestId' }]))
const idempotency = { name: 'Idempotency-Key', in: 'header', required: true,
  schema: { type: 'string', minLength: 8, maxLength: 128 }, description: 'One exact request including cursor. Reuse only to retry that request; use a new key for each new page.' }
const array = pattern => ({ type: 'array', maxItems: 50, uniqueItems: true, items: { type: 'string', pattern } })
export const newsQuerySchema = { type: 'object', additionalProperties: false, properties: {
  query: { type: 'string', maxLength: 300, default: '', description: 'Literal case-insensitive title/body substring; empty browses the corpus.' },
  catalogEntryIds: array('^[0-9a-fA-F-]{36}$'), sourceCodes: array('^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$'),
  categories: array('^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'), binding: { type: 'string', enum: ['all', 'mapped', 'unmapped'], default: 'all' },
  timeField: { type: 'string', enum: ['firstSeenAt', 'publishedAt'], default: 'firstSeenAt' },
  from: { type: ['string', 'null'], format: 'date-time', description: 'Inclusive lower bound' },
  to: { type: ['string', 'null'], format: 'date-time', description: 'Exclusive upper bound' },
  pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, cursor: { type: ['string', 'null'], maxLength: 4096 },
} }
const operation = (summary, extra = {}) => ({ tags: ['News discovery'], summary, security: [{ bearerKey: [] }, { apiKeyHeader: [] }],
  responses: { 200: { description: 'JSON { data, requestId }. See the news-discovery guide for field and coverage semantics.' }, ...errors }, ...extra })
const text = { type: ['string', 'null'] }
const labels = { type: 'array', items: { type: 'string' } }
const source = { type: 'object', properties: { catalogEntryId: { ...text, format: 'uuid' }, name: { type: 'string' }, code: text,
  bindingStatus: { type: 'string', enum: ['mapped', 'unmapped'] } } }
const article = { type: 'object', additionalProperties: false, properties: {
  id: { type: 'string', format: 'uuid' }, revision: { type: 'integer' }, category: { type: 'string' }, source,
  title: text, excerpt: { type: 'string', maxLength: 360 }, summary: text, url: { ...text, format: 'uri' },
  author: { type: 'object', properties: { name: text } }, publishedAt: { ...text, format: 'date-time' },
  publishedDate: text, publishedAtPrecision: text, firstSeenAt: { ...text, format: 'date-time' },
  contentExtent: { type: 'string', enum: ['full_text', 'summary', 'reference', 'unknown'] }, topics: labels, keywords: labels, section: text,
} }
const response = properties => ({ ...errors, 200: { description: 'Stored-data response; requestId identifies the metered request or metadata read.',
  content: { 'application/json': { schema: { type: 'object', required: ['data', 'requestId'], properties: {
    requestId: { type: 'string', format: 'uuid' }, data: { type: 'object', properties: { contractVersion: { const: 'mx-insight-hub.news-discovery.v1' }, ...properties } },
  } } } } } })
export const newsOpenApiPaths = {
  '/data/news/source-options': { get: operation('List every catalog source with news visible to the current Key; no usage unit', { operationId: 'newsSourceOptions',
    description: 'Dropdown options from active catalog entries with at least one readable news record in the current Key category scope. Uses effective current-revision bindings, not a recent-record sample. No acquisition, LLM or article search request. key is the stable catalog UUID; value is its current display name. Names are not search identifiers.',
    responses: response({ scope: { const: 'authorized_news_catalog_sources' }, countBasis: { const: 'catalog_entries' }, total: { type: 'integer', minimum: 0 },
      items: { type: 'array', items: { type: 'object', required: ['key', 'value'], properties: { key: { type: 'string', format: 'uuid' }, value: { type: 'string' } } } } }) }) },
  '/data/news/sources': { get: operation('News source catalog metadata and current-Key categories; no usage unit', { operationId: 'newsSources',
    responses: response({ scope: { const: 'active_catalog_metadata' }, coverage: { const: 'not_measured' },
      items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, majorCategory: text, scenarios: labels } } },
      categories: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, sourceType: { type: 'string' }, platform: { type: 'string' }, label: { type: 'string' }, datasetId: text, objectType: text, registered: { type: 'boolean' }, authorized: { type: 'boolean' } } } } }) }) },
  '/data/news/search': { post: operation('Search stored news, without acquisition or model calls', { operationId: 'newsSearch', parameters: [idempotency],
    responses: response({ items: { type: 'array', items: article }, filters: newsQuerySchema, dataBasis: { const: 'stored_canonical' }, pagination: { const: 'live_keyset' },
      pageInfo: { type: 'object', properties: { returnedCount: { type: 'integer' }, hasMore: { type: 'boolean' }, nextCursor: text } } }),
    requestBody: { required: true, content: { 'application/json': { schema: newsQuerySchema } } } }) },
  '/data/news/facets': { post: operation('Source/category facets of the latest 5000 matching records', { operationId: 'newsFacets', parameters: [idempotency],
    responses: response({ scope: { const: 'latest_matching_records' }, countBasis: { const: 'records' }, sampledRecords: { type: 'integer', maximum: 5000 }, truncated: { type: 'boolean' },
      asOf: { type: 'string', format: 'date-time' }, sources: { type: 'array', items: { type: 'object', properties: { ...source.properties, count: { type: 'integer' } } } },
      categories: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, count: { type: 'integer' } } } } }),
    requestBody: { required: true, content: { 'application/json': { schema: newsQuerySchema } } } }) },
  '/data/news/articles/{id}': { get: operation('Read the full stored article', { operationId: 'newsArticle',
    responses: response({ article: { ...article, properties: { ...article.properties, body: text } } }), parameters: [idempotency,
    { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }] }) },
}
export function newsGuide() { return `<section class="doc-page" data-doc-page="news-discovery">
<h2>新闻发现</h2><p>按数据源目录、结构化来源、类别和时间检索已入库新闻。读取 Hub 库存，不采集、不补抓正文、不调用模型。每次请求重新检查 tenant、consumer、Key 和类别授权；目录筛选不授予数据权限。</p>
<h3>下游平台需要的完整接口</h3>
<table><thead><tr><th>用途</th><th>接口</th><th>ID 的来源与用法</th></tr></thead><tbody>
<tr><td>新闻来源下拉</td><td>GET /api/v1/data/news/source-options</td><td>data.items[].key → catalogEntryIds；value 是显示名称。可多选。</td></tr>
<tr><td>数据类别与目录元数据</td><td>GET /api/v1/data/news/sources</td><td>data.categories[].id → categories；label 是显示名称，platform 仅表示授权数据域。</td></tr>
<tr><td>新闻搜索与下一页</td><td>POST /api/v1/data/news/search</td><td>data.items[].id → 文章详情；data.pageInfo.nextCursor → 下一页 cursor。</td></tr>
<tr><td>已存文章详情</td><td>GET /api/v1/data/news/articles/{id}</td><td>使用搜索返回的文章 id，不使用目录 key。</td></tr>
<tr><td>来源与类别统计</td><td>POST /api/v1/data/news/facets</td><td>sources[].catalogEntryId 可用于筛选，统计有 5,000 条上限，不能充当全部来源下拉。</td></tr>
</tbody></table>
<p>先获取来源和类别，再把所选 ID 放入搜索请求。三个标识不要混用：目录 UUID、文章 UUID、类别代码（如 news）。目录归类 binding 可取 all/mapped/unmapped，时间依据 timeField 可取 firstSeenAt/publishedAt；这些是合同固定枚举，无需额外查询接口。pageSize 为 1–100，仍受当前 Key 的最大分页限制。</p>
<pre><code>curl -sS "$HUB_URL/api/v1/data/news/source-options" -H "Authorization: Bearer $MX_INSIGHT_API_KEY"
curl -sS "$HUB_URL/api/v1/data/news/sources" -H "Authorization: Bearer $MX_INSIGHT_API_KEY"</code></pre>
<p>下面是选中一个目录来源后的搜索请求示例。目录 ID 须从当前 Key 的 source-options 响应选择；类别代码须从 sources 的 categories 选择，均不能硬编码为固定可用范围。</p>
<pre>{"query":"","catalogEntryIds":["94d36773-8912-5b8e-a593-8d0dcdaac8a3"],"categories":["news"],"binding":"all","timeField":"firstSeenAt","pageSize":20}</pre>
<p>下一页保持本次条件和 pageSize 不变，只增加或替换 cursor，并生成新的 Idempotency-Key；hasMore=false 时停止。详情使用新的请求标识；同一请求失败重试或重放保持标识。新闻发现的“接口调试”页可选择上述全部接口、复制 cURL/PowerShell/JavaScript 示例、读取真实 ID/名称与响应，并将搜索结果中的文章 ID 填入详情；切换接口和复制示例不会调用接口。</p>
<h3>目录与来源</h3><p>GET <code>/api/v1/data/news/sources</code> 返回安全目录元数据及当前 Key 的类别，不计 usage unit。目录不是库存承诺。使用返回的 <code>items[].id</code> 填入 <code>catalogEntryIds</code>。使用 <code>sourceCodes</code>（如 sina、huanqiu）查询尚未绑定目录的来源；<code>binding=unmapped</code> 可筛选待归类记录。</p>
<h3>新闻来源下拉与多选</h3><p>GET <code>/api/v1/data/news/source-options</code> 专供新闻下拉，返回当前 Key 授权类别中至少有一条可读新闻、且有效绑定目录的全部来源。它不使用最新 5000 条统计样本；没有新闻的目录项、已归档目录和未绑定来源不列为选项。接口不计 usage unit，无需 Idempotency-Key，也不请求模型或采集。total 是来源选项数，不是文章数。</p>
<pre>{"data":{"scope":"authorized_news_catalog_sources","countBasis":"catalog_entries","total":1,"items":[{"key":"94d36773-8912-5b8e-a593-8d0dcdaac8a3","value":"腾讯新闻"}]}}</pre>
<p>key 是稳定目录 UUID，value 是当前显示名称；重命名后 key 不变。前端组件若使用 value/label 约定，映射为 <code>{value:item.key,label:item.value}</code>。多选后把所有 key 传入 <code>catalogEntryIds:["来源UUID一","来源UUID二"]</code>，数组内部取 OR，最多 50 项。空数组表示不限目录，也保留未归类新闻。关键词留空可分页浏览选定来源的全部可见新闻；仍使用 search 的 nextCursor，不提供无上限全量文章响应。展开/勾选只准备条件，点击查询才发送新闻搜索。</p>
<h3>检索与分页</h3><p>POST <code>/api/v1/data/news/search</code> 支持 query、catalogEntryIds、sourceCodes、categories、binding、from、to、timeField、pageSize、cursor。多个维度取交集，每个数组内部为 OR。query 为标题/正文的不区分大小写字面子串，留空浏览。日期为 RFC3339、左闭右开；默认按首次收录倒序，publishedAt 只使用可解析的原文时间。</p>
<pre><code>curl -sS "$HUB_URL/api/v1/data/news/search" \\
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \\
  -H "Idempotency-Key: news-page-001" -H "Content-Type: application/json" \\
  -d '{"query":"新能源","sourceCodes":["sina"],"pageSize":20}'</code></pre>
<p>响应为 <code>{data:{contractVersion,items,pageInfo,filters,dataBasis,pagination},requestId}</code>。pageInfo 含 returnedCount、hasMore、nextCursor。保持过滤条件和页大小不变，将 nextCursor 原样传入下一页并使用新的幂等键。游标绑定 consumer、Key、授权与条件，6 小时过期；失效返回 invalid_cursor。实时 keyset 不承诺冻结快照；按 id 去重。不返回虚构总数。</p>
<h3>文章详情与内容边界</h3><p>GET <code>/api/v1/data/news/articles/{id}</code> 返回 data.article，包含 id、revision、category、source、title、summary、body、url、author、topics、keywords、section、publishedAt、publishedDate、publishedAtPrecision、firstSeenAt、contentExtent。列表返回 excerpt 而不返回 body。summary 只取来源摘要；全文程度为 full_text/summary/reference/unknown。正文非空不证明全文；原文时间与收录时间分开。原始响应、凭据及内部采集血缘不返回。</p>
<h3>统计与覆盖</h3><p>POST <code>/api/v1/data/news/facets</code> 使用相同条件，对最新最多 5000 条匹配记录统计，返回 sources、categories、sampledRecords、truncated、asOf、countBasis=records。该统计不是事件数或去重文章数。来源未绑定不会从全部结果中丢弃。当前识别 news/news.article/news.resolved，以及经过特定连接器限制的 bbc.article；引用、评论、热榜与未知类型不自动当新闻。</p>
<h3>身份、计量与重试</h3><p>所有接口要求有效 Hub Key 和 saved-record 类别 grant。搜索、统计、详情复用现有 <code>data.canonical-search</code> 计量/套餐规则，要求 Idempotency-Key；搜索按返回条数（至少 1 unit），统计和详情为 1 unit。相同请求重试复用原键，完成重放不重复计量；改变参数或页码须新键。来源元数据不计量。401 检查 Key；403 检查类别授权；404 表示文章不可见；409 检查幂等冲突或未决请求；429 遵守额度；503 可缩小查询范围，不能自动重新采集。</p>
</section>` }
