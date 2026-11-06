// Public documentation for the "邮箱库" and "手机号库" file datasets.
// Visibility follows x-mx-required-platform / x-mx-required-capabilities.
import * as EMAIL from '../data/email-directory/contract.mjs'
import * as PHONE from '../data/phone-directory/contract.mjs'

const errorCodes = (platform, extra = []) => ({
  400: ['invalid_request', 'invalid_json', 'unsupported_fields'],
  401: ['api_key_required', 'invalid_api_key'],
  403: ['platform_not_granted', 'capability_not_granted', 'snapshot_key_required'],
  ...(extra.includes(422) ? { 422: ['query_too_broad'] } : {}),
  429: ['consumer_quota_exceeded', 'api_key_quota_exceeded'],
  503: [`${platform}_not_published`, ...(extra.includes('busy') ? [`${platform}_busy`] : []), `${platform}_unavailable`],
})

const envelope = (contractVersion, itemSchema, metaProperties) => ({
  type: 'object',
  properties: {
    data: {
      type: 'object',
      properties: {
        contractVersion: { type: 'string', const: contractVersion },
        items: { type: 'array', items: itemSchema },
        meta: {
          type: 'object',
          properties: {
            datasetVersion: { type: 'integer' }, publishedAt: { type: 'string', format: 'date-time' },
            mode: { type: 'string' }, limit: { type: 'integer' }, returned: { type: 'integer' }, truncated: { type: 'boolean' },
            nextCursor: { type: ['string', 'null'], description: 'Pass as `after` to read the next page; null when there is no next page or the mode does not page.' },
            revealed: { type: 'boolean' }, tookMs: { type: 'integer' }, note: { type: 'string' },
            ...metaProperties,
          },
        },
      },
    },
    requestId: { type: 'string' },
  },
})

function metadataPath(product, platform, capability, tag, operationId, description) {
  return {
    get: {
      tags: [tag],
      operationId,
      summary: 'Read the published version and query limits',
      description: `Requires the ${platform} platform and ${capability}. ${description} Metered like other stored reads.`,
      'x-mx-required-platform': platform,
      'x-mx-required-capabilities': [capability],
      'x-mx-allowed-query-fields': [],
      'x-mx-error-codes': { 400: ['unsupported_fields'], 401: ['api_key_required', 'invalid_api_key'], 403: ['platform_not_granted', 'capability_not_granted', 'snapshot_key_required'], 429: ['consumer_quota_exceeded', 'api_key_quota_exceeded'], 503: [`${platform}_unavailable`] },
      parameters: [],
      responses: { 200: { description: `${product} metadata.` } },
    },
  }
}

const emailItem = {
  type: 'object',
  required: ['email', 'emailMasked', 'domain', 'matchType', 'sourceRecords'],
  properties: {
    email: { type: 'string', description: 'Complete address by default (local part as recorded, domain lower-cased). Set reveal=false for a masked address.' },
    emailMasked: { type: 'boolean' },
    domain: { type: 'string' },
    matchType: { type: 'string', enum: ['exact', 'case_insensitive', 'prefix', 'domain', 'contains', 'similar'] },
    similarity: { type: 'number', description: 'Trigram similarity 0-1, fuzzy mode only.' },
    sourceRecords: { type: 'integer', description: 'How many identical source lines were merged into this row.' },
  },
}

const phoneItem = {
  type: 'object',
  required: ['phone', 'phoneMasked', 'matchType', 'sourceRecords'],
  properties: {
    phone: { type: 'string', description: 'E.164 number (+ and digits) by default. Set reveal=false for a masked number.' },
    phoneMasked: { type: 'boolean' },
    matchType: { type: 'string', enum: ['exact', 'prefix', 'suffix'] },
    sourceRecords: { type: 'integer', description: 'How many source lines normalized to this number.' },
  },
}

const E = EMAIL.QUERY_LIMITS
const P = PHONE.QUERY_LIMITS
const api = path => path.slice('/api/v1'.length)

export const fileDatasetOpenApiPaths = {
  [api(EMAIL.PRODUCT.searchPath)]: {
    post: {
      tags: ['Email Directory'],
      operationId: 'searchEmailDirectory',
      summary: 'Look up e-mail addresses in the published e-mail list',
      description: `Requires the ${EMAIL.PLATFORM} platform, the ${EMAIL.SEARCH_CAPABILITY} capability and a Key with explicit scopes (legacy dynamic Keys return snapshot_key_required). Reads only the published PostgreSQL version; nothing is fetched live. email: is this address in the list. prefix: local-part prefix (${E.prefixMinChars}+ characters), optional domain. domain: every address at a domain, paged with nextCursor/after. contains and fuzzy (${E.containsMinChars}+ characters, on the part before @) run in a bounded lane: a too-broad query returns 422 query_too_broad instead of scanning. Complete addresses by default; reveal=false masks them. The query text is not stored in usage evidence or audit.`,
      'x-mx-required-platform': EMAIL.PLATFORM,
      'x-mx-required-capabilities': [EMAIL.SEARCH_CAPABILITY],
      'x-mx-error-codes': errorCodes(EMAIL.PLATFORM, [422, 'busy']),
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['query'],
              additionalProperties: false,
              properties: {
                mode: { type: 'string', enum: [...EMAIL.MODES], default: 'email', description: 'email: complete address; prefix / contains / fuzzy: the part before @; domain: list a domain.' },
                query: { type: 'string', maxLength: E.maxQueryChars, description: 'Complete address, local-part fragment, or a domain (domain mode).' },
                domain: { type: 'string', description: 'Optional domain filter for prefix, contains and fuzzy.' },
                limit: { type: 'integer', minimum: 1, maximum: E.maxLimit, default: E.defaultLimit },
                after: { type: 'string', description: 'domain mode only: nextCursor of the previous page.' },
                reveal: { type: 'boolean', default: true, description: 'Omit or send true for complete addresses; false masks them. Complete address access is audited.' },
              },
            },
            example: { mode: 'email', query: 'name@example.com' },
          },
        },
      },
      responses: { 200: { description: 'Matches from the current published version.', content: { 'application/json': { schema: envelope(EMAIL.CONTRACT_VERSION, emailItem, { domain: { type: ['string', 'null'] } }) } } } },
    },
  },
  [api(EMAIL.PRODUCT.metadataPath)]: metadataPath('E-mail list', EMAIL.PLATFORM, EMAIL.SEARCH_CAPABILITY, 'Email Directory', 'getEmailDirectoryMetadata',
    'Returns the current published version, address count, modes and query limits.'),
  [api(PHONE.PRODUCT.searchPath)]: {
    post: {
      tags: ['Phone Directory'],
      operationId: 'searchPhoneDirectory',
      summary: 'Look up phone numbers in the published phone list',
      description: `Requires the ${PHONE.PLATFORM} platform, the ${PHONE.SEARCH_CAPABILITY} capability and a Key with explicit scopes. Reads only the published PostgreSQL version. Numbers are E.164 (country code first); the query may contain +, spaces, -, parentheses and dots. exact: one complete number. prefix: country/area code (${P.prefixMinDigits}+ digits). suffix: last digits (${P.suffixMinDigits}+). prefix and suffix page with nextCursor/after. Every mode is an index range scan. Complete numbers by default; reveal=false masks them.`,
      'x-mx-required-platform': PHONE.PLATFORM,
      'x-mx-required-capabilities': [PHONE.SEARCH_CAPABILITY],
      'x-mx-error-codes': errorCodes(PHONE.PLATFORM, [422]),
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['query'],
              additionalProperties: false,
              properties: {
                mode: { type: 'string', enum: [...PHONE.MODES], default: 'exact' },
                query: { type: 'string', maxLength: 64, description: 'Number or digits, e.g. +1 (415) 555-0123.' },
                limit: { type: 'integer', minimum: 1, maximum: P.maxLimit, default: P.defaultLimit },
                after: { type: 'string', description: 'prefix / suffix only: nextCursor of the previous page.' },
                reveal: { type: 'boolean', default: true },
              },
            },
            example: { mode: 'suffix', query: '0123', limit: 20 },
          },
        },
      },
      responses: { 200: { description: 'Matches from the current published version.', content: { 'application/json': { schema: envelope(PHONE.CONTRACT_VERSION, phoneItem, {}) } } } },
    },
  },
  [api(PHONE.PRODUCT.metadataPath)]: metadataPath('Phone list', PHONE.PLATFORM, PHONE.SEARCH_CAPABILITY, 'Phone Directory', 'getPhoneDirectoryMetadata',
    'Returns the current published version, number count, modes and query limits.'),
}

export const FILE_DATASET_DOC_TAGS = ['Email Directory', 'Phone Directory']

export const fileDatasetDocPaths = {
  [EMAIL.PRODUCT.docsKey]: [api(EMAIL.PRODUCT.searchPath), api(EMAIL.PRODUCT.metadataPath)],
  [PHONE.PRODUCT.docsKey]: [api(PHONE.PRODUCT.searchPath), api(PHONE.PRODUCT.metadataPath)],
}

const grantNote = (platform, capability) => `<p>调用者和 Key 同时具备数据域 <code>${platform}</code> 和业务操作 <code>${capability}</code> 时可查询；历史动态范围 Key 返回 <code>403 snapshot_key_required</code>，需在 API Keys 中改为显式权限范围。数据只来自已发布版本，存于 PostgreSQL，查询不触发实时采集。</p>`

export function emailDirectoryDocumentationHtml() {
  const p = EMAIL.PRODUCT
  return `<section class="doc-page" data-doc-page="${p.docsKey}">
  <h2 id="${p.docsKey}">${p.label}</h2>
  <p>来源文件中的邮箱名录：查某个邮箱是否在库、按 @ 前部分的前缀或片段找候选、列出某个域名下的全部邮箱。</p>
  <h3>授权</h3>
  ${grantNote(EMAIL.PLATFORM, EMAIL.SEARCH_CAPABILITY)}
  <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">${p.searchPath}</code></div><p>默认返回 ${E.defaultLimit} 条，最多 ${E.maxLimit} 条。</p></div>
  <table><thead><tr><th>mode</th><th>用途</th><th>要求</th></tr></thead><tbody>
    <tr><td><code>email</code></td><td>完整邮箱是否在库</td><td>域名不分大小写；@ 前部分忽略大小写，原样相等排第一</td></tr>
    <tr><td><code>prefix</code></td><td>@ 前部分的前缀</td><td>至少 ${E.prefixMinChars} 个字符；可加 <code>domain</code></td></tr>
    <tr><td><code>domain</code></td><td>某域名下的全部邮箱</td><td><code>query</code> 填域名；用返回的 <code>nextCursor</code> 作为 <code>after</code> 翻页</td></tr>
    <tr><td><code>contains</code></td><td>@ 前部分包含片段</td><td>至少 ${E.containsMinChars} 个字符，且含连续 3 个字母或数字</td></tr>
    <tr><td><code>fuzzy</code></td><td>@ 前部分拼写近似</td><td>${E.fuzzyMinChars}–${E.fuzzyMaxChars} 个字符；按相似度排序</td></tr>
  </tbody></table>
  <pre><code>curl -sS -X POST "$HUB_URL${p.searchPath}" \\
  -H "Authorization: Bearer YOUR_HUB_API_KEY" -H "Content-Type: application/json" \\
  -d '{"mode":"domain","query":"example.com","limit":50}'</code></pre>
  <h3>稳定性与限制</h3>
  <p>精确、前缀和域名列表走 B-tree 索引，毫秒级；域名列表按游标逐页读取，任意深度都只扫一段索引。片段与近似查询先按抽样统计估算候选量，范围太宽返回 <code>422 query_too_broad</code>；全 Hub 同时只运行少量此类查询，繁忙时返回 <code>503 ${EMAIL.PLATFORM}_busy</code>。</p>
  <h3>隐私与计量</h3>
  <p>默认返回完整邮箱；传 <code>reveal: false</code> 返回脱敏邮箱，如 <code>jo***@gmail.com</code>。查询内容只保留不可逆摘要，返回完整邮箱的条数记入审计。每次调用按已收录数据读取计量。</p>
  <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">${p.metadataPath}</code></div><p>返回当前发布版本、邮箱数量、模式与查询限制。</p></div>
  </section>`
}

export function phoneDirectoryDocumentationHtml() {
  const p = PHONE.PRODUCT
  return `<section class="doc-page" data-doc-page="${p.docsKey}">
  <h2 id="${p.docsKey}">${p.label}</h2>
  <p>来源文件中的国际手机号名录（E.164，国家码在前）：查某个号码是否在库、按国家码或区号前缀列出、按尾号查找。</p>
  <h3>授权</h3>
  ${grantNote(PHONE.PLATFORM, PHONE.SEARCH_CAPABILITY)}
  <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">${p.searchPath}</code></div><p>默认返回 ${P.defaultLimit} 条，最多 ${P.maxLimit} 条。查询可带 +、空格、-、括号和点。</p></div>
  <table><thead><tr><th>mode</th><th>用途</th><th>要求</th></tr></thead><tbody>
    <tr><td><code>exact</code></td><td>完整号码是否在库</td><td>含国家码，至少 ${PHONE.MIN_DIGITS} 位</td></tr>
    <tr><td><code>prefix</code></td><td>国家码 / 区号开头</td><td>至少 ${P.prefixMinDigits} 位（含国家码）；可翻页</td></tr>
    <tr><td><code>suffix</code></td><td>尾号</td><td>至少 ${P.suffixMinDigits} 位；可翻页</td></tr>
  </tbody></table>
  <pre><code>curl -sS -X POST "$HUB_URL${p.searchPath}" \\
  -H "Authorization: Bearer YOUR_HUB_API_KEY" -H "Content-Type: application/json" \\
  -d '{"mode":"prefix","query":"+1 415"}'</code></pre>
  <h3>稳定性与限制</h3>
  <p>三种模式都是 B-tree 索引区间读取，毫秒级；翻页用返回的 <code>nextCursor</code> 作为下一次的 <code>after</code>，任意深度都只扫一段索引。不提供号码片段搜索：数字只有 10 种，片段无法有效缩小范围。</p>
  <h3>隐私与计量</h3>
  <p>默认返回完整号码；传 <code>reveal: false</code> 返回脱敏号码，如 <code>+141******23</code>。查询内容只保留不可逆摘要，返回完整号码的条数记入审计。每次调用按已收录数据读取计量。</p>
  <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">${p.metadataPath}</code></div><p>返回当前发布版本、号码数量、模式与查询限制。</p></div>
  </section>`
}

export const fileDatasetDocumentationHtml = {
  [EMAIL.PRODUCT.docsKey]: emailDirectoryDocumentationHtml,
  [PHONE.PRODUCT.docsKey]: phoneDirectoryDocumentationHtml,
}
