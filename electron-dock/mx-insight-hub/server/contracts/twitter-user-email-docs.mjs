// Public documentation for the Twitter user-email dictionary product.
// Visibility follows x-mx-required-platform / x-mx-required-capabilities.
import {
  CONTRACT_VERSION, METADATA_PATH, PLATFORM, QUERY_LIMITS, REVEAL_CAPABILITY, SEARCH_CAPABILITY, SEARCH_PATH,
} from '../data/twitter-user-email/contract.mjs'

const errorCodes = {
  400: ['invalid_request', 'invalid_json', 'unsupported_fields'],
  401: ['api_key_required', 'invalid_api_key'],
  403: ['platform_not_granted', 'capability_not_granted', 'snapshot_key_required'],
  422: ['query_too_broad'],
  429: ['consumer_quota_exceeded', 'api_key_quota_exceeded'],
  503: ['twitter_user_email_not_published', 'twitter_user_email_busy', 'twitter_user_email_unavailable'],
}

const itemSchema = {
  type: 'object',
  required: ['username', 'email', 'emailMasked', 'domain', 'matchType', 'matchedField', 'sourceRecords'],
  properties: {
    username: { type: 'string', description: 'Username exactly as recorded in the source file.' },
    email: { type: 'string', description: 'Masked e-mail such as jo***@gmail.com, or the complete address when reveal=true is granted.' },
    emailMasked: { type: 'boolean' },
    domain: { type: 'string', description: 'Lower-cased e-mail domain.' },
    matchType: { type: 'string', enum: ['exact', 'case_insensitive', 'prefix', 'contains', 'similar'] },
    matchedField: { type: 'string', enum: ['username', 'email', 'email_local'] },
    similarity: { type: 'number', description: 'Trigram similarity 0-1, fuzzy mode only.' },
    sourceRecords: { type: 'integer', description: 'How many identical source pairs were merged into this row.' },
  },
}

export const twitterUserEmailOpenApiPaths = {
  [SEARCH_PATH.slice('/api/v1'.length)]: {
    post: {
      tags: ['Twitter User Email'],
      operationId: 'searchTwitterUserEmail',
      summary: 'Look up Twitter usernames and e-mail addresses',
      description: `Requires the ${PLATFORM} platform, the ${SEARCH_CAPABILITY} capability and a Key with explicit scopes (legacy dynamic Keys return snapshot_key_required). Searches only the published PostgreSQL dictionary; nothing is fetched live. username and email modes are exact (original-case matches first). prefix needs ${QUERY_LIMITS.prefixMinChars}+ characters; contains and fuzzy need ${QUERY_LIMITS.containsMinChars}+ and run in a bounded lane: a too-broad query returns 422 query_too_broad instead of scanning. E-mails are masked unless reveal=true and ${REVEAL_CAPABILITY} is granted. Results are associations recorded in the source file; fuzzy matches are candidates, not verified ownership. The query text is not stored in usage evidence or audit.`,
      'x-mx-required-platform': PLATFORM,
      'x-mx-required-capabilities': [SEARCH_CAPABILITY],
      'x-mx-error-codes': errorCodes,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['query'],
              additionalProperties: false,
              properties: {
                mode: { type: 'string', enum: ['username', 'email', 'prefix', 'contains', 'fuzzy'], default: 'username', description: 'username: exact username; email: complete address to usernames; prefix / contains / fuzzy: partial or approximate match on field.' },
                query: { type: 'string', maxLength: QUERY_LIMITS.maxQueryChars, description: 'Username, complete e-mail, or fragment depending on mode.' },
                field: { type: 'string', enum: ['username', 'email_local'], default: 'username', description: 'For prefix, contains and fuzzy: match the username or the part before @.' },
                domain: { type: 'string', description: 'Optional e-mail domain filter, e.g. gmail.com. Not accepted in email mode. A domain alone is never a query.' },
                limit: { type: 'integer', minimum: 1, maximum: QUERY_LIMITS.maxLimit, default: QUERY_LIMITS.defaultLimit },
                reveal: { type: 'boolean', default: false, description: `Return complete e-mail addresses; requires ${REVEAL_CAPABILITY} and is audited.` },
              },
            },
            example: { mode: 'username', query: 'JohnSmith', limit: 20 },
          },
        },
      },
      responses: {
        200: {
          description: 'Matches from the current published version.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  data: {
                    type: 'object',
                    properties: {
                      contractVersion: { type: 'string', const: CONTRACT_VERSION },
                      items: { type: 'array', items: itemSchema },
                      meta: {
                        type: 'object',
                        properties: {
                          datasetVersion: { type: 'integer' }, publishedAt: { type: 'string', format: 'date-time' },
                          mode: { type: 'string' }, field: { type: ['string', 'null'] }, domain: { type: ['string', 'null'] },
                          limit: { type: 'integer' }, returned: { type: 'integer' }, truncated: { type: 'boolean' },
                          revealed: { type: 'boolean' }, tookMs: { type: 'integer' }, note: { type: 'string' },
                        },
                      },
                    },
                  },
                  requestId: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  },
  [METADATA_PATH.slice('/api/v1'.length)]: {
    get: {
      tags: ['Twitter User Email'],
      operationId: 'getTwitterUserEmailMetadata',
      summary: 'Read the published dictionary version and query limits',
      description: `Requires the ${PLATFORM} platform and ${SEARCH_CAPABILITY}. Returns the current published version, mapping count and query limits. Metered like other stored reads.`,
      'x-mx-required-platform': PLATFORM,
      'x-mx-required-capabilities': [SEARCH_CAPABILITY],
      'x-mx-allowed-query-fields': [],
      'x-mx-error-codes': { 400: ['unsupported_fields'], 401: errorCodes[401], 403: errorCodes[403], 429: errorCodes[429], 503: ['twitter_user_email_unavailable'] },
      parameters: [],
      responses: { 200: { description: 'Dictionary metadata.' } },
    },
  },
}

export function twitterUserEmailDocumentationHtml() {
  return `<section class="doc-page" data-doc-page="twitter-user-email">
  <h2 id="twitter-user-email">Twitter 用户邮箱</h2>
  <p>按用户名查邮箱、按邮箱反查用户名，或用片段、近似拼写找候选。数据来自已发布的字典版本，只存于 PostgreSQL，查询不触发任何实时采集。</p>
  <h3>授权</h3>
  <p>需要数据域 <code>${PLATFORM}</code> 与业务操作 <code>${SEARCH_CAPABILITY}</code>；返回完整邮箱另需 <code>${REVEAL_CAPABILITY}</code>。只接受显式选择权限范围的 Key，历史动态范围 Key 返回 <code>403 snapshot_key_required</code>，在 API Keys 中“调整 Key 权限”后即可使用。</p>
  <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">${SEARCH_PATH}</code></div><p>一次查询，默认返回 ${QUERY_LIMITS.defaultLimit} 条，最多 ${QUERY_LIMITS.maxLimit} 条。</p></div>
  <table><thead><tr><th>mode</th><th>用途</th><th>要求</th></tr></thead><tbody>
    <tr><td><code>username</code></td><td>用户名 → 邮箱</td><td>原样相等排第一，其次忽略大小写相等</td></tr>
    <tr><td><code>email</code></td><td>完整邮箱 → 用户名</td><td>域名不分大小写；@ 前部分忽略大小写匹配，原样相等排第一</td></tr>
    <tr><td><code>prefix</code></td><td>用户名或 @ 前部分的前缀</td><td>至少 ${QUERY_LIMITS.prefixMinChars} 个字符；可加 <code>domain</code></td></tr>
    <tr><td><code>contains</code></td><td>片段包含</td><td>至少 ${QUERY_LIMITS.containsMinChars} 个字符，且含连续 3 个字母或数字</td></tr>
    <tr><td><code>fuzzy</code></td><td>拼写近似</td><td>${QUERY_LIMITS.fuzzyMinChars}–${QUERY_LIMITS.fuzzyMaxChars} 个字符；按相似度排序</td></tr>
  </tbody></table>
  <pre><code>curl -sS -X POST "$HUB_URL${SEARCH_PATH}" \\
  -H "Authorization: Bearer YOUR_HUB_API_KEY" -H "Content-Type: application/json" \\
  -d '{"mode":"email","query":"name@example.com"}'</code></pre>
  <h3>稳定性与限制</h3>
  <p>精确与前缀查询走 B-tree 索引，毫秒级。片段与近似查询先按抽样统计估算候选量，范围太宽直接返回 <code>422 query_too_broad</code>（补充字符、加域名或改用前缀）；全 Hub 同时只运行少量此类查询，排队超时返回 <code>503 twitter_user_email_busy</code>，按 <code>retryAfterMs</code> 稍后重试。</p>
  <h3>隐私与计量</h3>
  <p>邮箱默认脱敏（如 <code>jo***@gmail.com</code>）。查询文本不写入用量证据或审计，只保留不可逆摘要；明文查看次数单独审计。每次调用按已收录数据读取计量。结果是来源文件记录的关联，近似命中不代表已验证的账号归属。</p>
  <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">${METADATA_PATH}</code></div><p>当前发布版本、映射数量与查询限制。</p></div>
  </section>`
}
