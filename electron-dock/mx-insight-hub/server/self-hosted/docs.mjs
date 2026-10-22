import { WECHAT_SELF_HOSTED, WECHAT_SELF_HOSTED_LIMITS as LIMITS } from '../../shared/wechat-self-hosted.mjs'
import { WECHAT_SELF_HOSTED_VERSION } from './wechat-contract.mjs'

// Public contract for the WeChat self-hosted engine. Paths are relative to /api/v1.
const prefix = WECHAT_SELF_HOSTED.apiPrefix.slice('/api/v1'.length)
const base = { tags: ['微信自建引擎'], 'x-mx-required-platform': WECHAT_SELF_HOSTED.platform,
  'x-mx-required-capabilities': [WECHAT_SELF_HOSTED.capability], 'x-mx-doc-path': `/docs/${WECHAT_SELF_HOSTED.docs}` }
const idempotency = {
  name: 'Idempotency-Key', in: 'header', required: true,
  description: '同一业务意图保存同一标识和请求正文。相同标识 + 相同正文返回原任务，不重复采集或计费；相同标识 + 不同正文返回 409。',
  schema: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' }, example: 'delta-wsh-20261023-001',
}
const idParameter = name => ({ name, in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: name === 'jobId' ? '提交时返回的任务 ID' : '提交时返回的批次 ID' })
const itemSchema = {
  type: 'object', required: ['query'], additionalProperties: false,
  properties: {
    query: { type: 'string', minLength: 1, maxLength: LIMITS.queryLength, description: '公众号文章搜索关键词，去除首尾空白。' },
    limit: { type: 'integer', minimum: 1, maximum: LIMITS.limitMax, default: LIMITS.limitDefault, description: '返回文章上限，不承诺补足。' },
    page: { type: 'integer', minimum: 1, maximum: LIMITS.pageMax, default: 1, description: '搜索结果页码；不会自动翻页。' },
    cacheMaxAgeHours: { type: 'integer', minimum: 0, maximum: LIMITS.cacheHoursMax, default: LIMITS.cacheHoursDefault,
      description: '可接受的缓存时长。0 表示不用新鲜缓存；搜狗不可用时仍可能回退旧结果（标注且不收费）。' },
  },
}
const batchSchema = {
  type: 'object', required: ['items'], additionalProperties: false,
  properties: { items: { type: 'array', minItems: 1, maxItems: LIMITS.batchItems, items: { ...itemSchema,
    properties: { clientRef: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$', description: '可选，调用方自己的引用，批次内唯一。' }, ...itemSchema.properties } } } },
}
const statuses = ['queued', 'running', 'succeeded', 'failed', 'unknown', 'cancelled', 'expired']
const jobSchema = {
  type: 'object', required: ['jobId', 'status', 'input', 'timing', 'delivery', 'billing', 'links'],
  properties: {
    jobId: { type: 'string', format: 'uuid' }, batchId: { type: ['string', 'null'], format: 'uuid' }, clientRef: { type: ['string', 'null'] },
    status: { type: 'string', enum: statuses, description: 'succeeded 表示结果已保存可读；unknown 表示上游是否已停止未知，不自动扣费、不自动重试。' },
    input: itemSchema,
    queue: { type: ['object', 'null'], description: '仅 queued 时提供。', properties: {
      position: { type: ['integer', 'null'], description: '全局排队位置，1 表示下一个执行。' },
      estimatedStartAt: { type: ['string', 'null'], format: 'date-time', description: '按最近实际耗时估算，不是承诺。' } } },
    timing: { type: 'object', properties: Object.fromEntries(['queuedAt', 'deadlineAt', 'dispatchedAt', 'finishedAt']
      .map(key => [key, { type: ['string', 'null'], format: 'date-time' }]).concat([['durationMs', { type: ['integer', 'null'] }]])) },
    delivery: { type: 'object', properties: {
      available: { type: 'boolean', description: '是否有可读取的结果。' },
      sourceMode: { type: ['string', 'null'], enum: ['live', 'fresh_cache', 'stored_fallback', null], description: 'live 实时采集；fresh_cache 新鲜缓存；stored_fallback 旧结果（不收费）。' },
      fetchedAt: { type: ['string', 'null'] }, itemCount: { type: ['integer', 'null'] } } },
    billing: { type: 'object', properties: { status: { type: 'string', enum: ['none', 'reserved', 'charged', 'not_charged', 'pending_review'],
      description: 'none 未派发；reserved 已预留、执行中；charged 已计费；not_charged 不计费；pending_review 待核实，不自动扣费。' } } },
    error: { type: ['object', 'null'], properties: { code: { type: 'string' }, message: { type: 'string' } } },
    links: { type: 'object', properties: { self: { type: 'string' }, result: { type: 'string' } } },
  },
}
const errorSchema = { type: 'object', required: ['error', 'requestId'], properties: {
  error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' }, details: { type: 'object', additionalProperties: true } } },
  requestId: { type: 'string', format: 'uuid' },
} }
const errors = Object.fromEntries(Object.entries({
  400: 'idempotency_key_required、invalid_idempotency_key、invalid_wechat_self_hosted_request 或 unsupported_fields。',
  401: 'Hub Key 缺失、无效或过期。',
  403: 'capability_not_granted：当前 Key 没有 wechat.selfhosted.search。',
  404: 'job_not_found / batch_not_found：不存在或不属于当前调用方。',
  409: 'idempotency_conflict、result_not_ready、result_unavailable 或 job_not_cancellable。',
  429: `engine_queue_full（全局排队上限 ${LIMITS.globalQueued}）或 consumer_queue_full（每个调用方未完成上限 ${LIMITS.consumerOpen}）；带 Retry-After。`,
  503: 'engine_disabled 或 engine_attention_required：引擎停用或等待人工核实，暂不接收新任务；带 Retry-After。',
}).map(([status, description]) => [status, { description, content: { 'application/json': { schema: errorSchema } } }]))
const pick = (...codes) => Object.fromEntries(codes.map(code => [code, errors[code]]))
const accepted = (schema, example) => ({ 202: { description: '已持久保存。用 Location / links.self 轮询；Retry-After 为建议间隔（秒）。',
  headers: { location: { schema: { type: 'string' } }, 'retry-after': { schema: { type: 'string' } },
    'idempotent-replay': { schema: { type: 'string', enum: ['true', 'false'] }, description: 'true 表示返回原任务。' } },
  content: { 'application/json': { schema: { type: 'object', properties: { data: schema, requestId: { type: 'string', format: 'uuid' } } }, example } } } })
const jobExample = { data: { jobId: '7a1e0000-0000-4000-8000-000000000001', batchId: null, clientRef: null, status: 'queued',
  input: { query: '人工智能', limit: 5, page: 1, cacheMaxAgeHours: 24 },
  queue: { position: 2, estimatedStartAt: '2026-10-23T10:03:20.000Z' },
  timing: { queuedAt: '2026-10-23T10:00:00.000Z', deadlineAt: '2026-10-23T12:00:00.000Z', dispatchedAt: null, finishedAt: null, durationMs: null },
  delivery: { available: false, sourceMode: null, fetchedAt: null, itemCount: null }, billing: { status: 'none' }, error: null,
  links: { self: `${WECHAT_SELF_HOSTED.apiPrefix}/jobs/7a1e0000-0000-4000-8000-000000000001`,
    result: `${WECHAT_SELF_HOSTED.apiPrefix}/jobs/7a1e0000-0000-4000-8000-000000000001/result` } },
requestId: '00000000-0000-4000-8000-000000000002' }
const batchView = { type: 'object', properties: { batchId: { type: 'string', format: 'uuid' }, total: { type: 'integer' }, complete: { type: 'boolean' },
  counts: { type: 'object', additionalProperties: { type: 'integer' } }, jobs: { type: 'array', items: jobSchema }, links: { type: 'object' } } }
const resultSchema = { type: 'object', properties: {
  jobId: { type: 'string', format: 'uuid' }, status: { type: 'string', enum: statuses },
  sourceMode: { type: 'string', enum: ['live', 'fresh_cache', 'stored_fallback'] }, fetchedAt: { type: ['string', 'null'] },
  items: { type: 'array', description: '公众号文章记录，字段与 Night-All 标准 raw_data 一致（已解析为数组）；可能为空。', items: { type: 'object', additionalProperties: true } },
  page: { type: ['object', 'null'] }, warnings: { type: 'array', items: { type: 'object', additionalProperties: true } },
  billing: { type: 'object', properties: { status: { type: 'string' } } }, notice: { type: ['string', 'null'] },
} }
const ok = (description, schema) => ({ 200: { description, content: { 'application/json': { schema: { type: 'object', properties: { data: schema, requestId: { type: 'string', format: 'uuid' } } } } } } })

export const wechatSelfHostedPaths = {
  [`${prefix}/jobs`]: {
    post: { ...base, operationId: 'wechatSelfHostedSubmitJob', summary: '提交公众号文章搜索任务',
      description: `持久保存后立即返回 202 和 jobId；引擎全局串行执行，单条通常几十秒到 3 分钟。可以一次提交多条，不需要等上一条完成。计费由引擎开关决定，默认关闭（只转发）；开启后按任务计费：实时或 24 小时缓存结果计 1 次，旧结果、失败、取消、排队超时不计费，unknown 待核实。最长排队 ${LIMITS.queueWaitMs / 3_600_000} 小时。`,
      'x-mx-meter-key': WECHAT_SELF_HOSTED.meterKey, parameters: [idempotency],
      requestBody: { required: true, content: { 'application/json': { schema: itemSchema, example: { query: '人工智能', limit: 5 } } } },
      responses: { ...accepted(jobSchema, jobExample), ...pick(400, 401, 403, 409, 429, 503) } },
    get: { ...base, operationId: 'wechatSelfHostedListJobs', summary: '当前调用方最近的任务',
      description: '只读，不采集、不计费。按提交时间倒序。',
      parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } }],
      responses: { ...ok('任务列表', { type: 'array', items: jobSchema }), ...pick(400, 401) } },
  },
  [`${prefix}/jobs/{jobId}`]: {
    get: { ...base, operationId: 'wechatSelfHostedGetJob', summary: '查询任务状态',
      description: '只读，不采集、不计费。queued/running 时带 Retry-After；终态后用 links.result 读取结果。', parameters: [idParameter('jobId')],
      responses: { ...ok('任务状态', jobSchema), ...pick(401, 404) } },
  },
  [`${prefix}/jobs/{jobId}/result`]: {
    get: { ...base, operationId: 'wechatSelfHostedGetResult', summary: '读取任务结果',
      description: '读取已保存的结果，不发起采集、不重复计费。未完成返回 409 result_not_ready（带 Retry-After）；失败、取消、超时返回 409 result_unavailable。sourceMode=stored_fallback 是旧结果，不代表本次采集成功。',
      parameters: [idParameter('jobId')], responses: { ...ok('任务结果', resultSchema), ...pick(401, 404, 409) } },
  },
  [`${prefix}/jobs/{jobId}/cancel`]: {
    post: { ...base, operationId: 'wechatSelfHostedCancelJob', summary: '取消排队中的任务',
      description: '只能取消 queued 的任务；已派发的任务不能取消（上游无法可靠停止）。取消不收费。', parameters: [idParameter('jobId')],
      responses: { ...ok('已取消', jobSchema), ...pick(401, 404, 409) } },
  },
  [`${prefix}/batches`]: {
    post: { ...base, operationId: 'wechatSelfHostedSubmitBatch', summary: `批量提交（1–${LIMITS.batchItems} 条）`,
      description: '父批次与子任务一次保存；子任务按顺序排队，各自独立计费。读取进度用批次接口，读取结果用 /result（按输入顺序）。',
      'x-mx-meter-key': WECHAT_SELF_HOSTED.meterKey, parameters: [idempotency],
      requestBody: { required: true, content: { 'application/json': { schema: batchSchema,
        example: { items: [{ clientRef: 'q1', query: '人工智能' }, { clientRef: 'q2', query: '新能源', limit: 10 }] } } } },
      responses: { ...accepted(batchView), ...pick(400, 401, 403, 409, 429, 503) } },
  },
  [`${prefix}/batches/{batchId}`]: {
    get: { ...base, operationId: 'wechatSelfHostedGetBatch', summary: '查询批次进度', description: '只读。complete=false 时带 Retry-After。',
      parameters: [idParameter('batchId')], responses: { ...ok('批次进度', batchView), ...pick(401, 404) } },
  },
  [`${prefix}/batches/{batchId}/result`]: {
    get: { ...base, operationId: 'wechatSelfHostedGetBatchResult', summary: '读取批次结果',
      description: '按输入顺序返回每条的结果或错误；未完成的条目 items 为 null。只读，不重复计费。',
      parameters: [idParameter('batchId')], responses: { ...ok('批次结果', { type: 'object', additionalProperties: true }), ...pick(401, 404) } },
  },
}

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const code = value => `<pre><code>${escape(value)}</code></pre>`
const submitExample = `HUB_URL='https://hub.minsight-ai.com'   # Internal 同机可用 http://host.docker.internal:18150
# 1. 提交：保存这个 Idempotency-Key；网络超时后用同一个 key 和正文重发，会拿回原任务
curl -i "$HUB_URL${WECHAT_SELF_HOSTED.apiPrefix}/jobs" \\
  -H "Authorization: Bearer $HUB_API_KEY" -H 'Content-Type: application/json' \\
  -H 'Idempotency-Key: delta-wsh-20261023-001' \\
  --data '{"query":"人工智能","limit":5}'
# 2. 按 Retry-After（5–60 秒）轮询状态，直到 status 不是 queued / running
curl "$HUB_URL${WECHAT_SELF_HOSTED.apiPrefix}/jobs/$JOB_ID" -H "Authorization: Bearer $HUB_API_KEY"
# 3. 读取结果（只读，不重复计费）
curl "$HUB_URL${WECHAT_SELF_HOSTED.apiPrefix}/jobs/$JOB_ID/result" -H "Authorization: Bearer $HUB_API_KEY"`

export const wechatSelfHostedGuide = `<h2>微信自建引擎 · 下游接入</h2>
<p>合同版本 <code>${WECHAT_SELF_HOSTED_VERSION}</code>。公众号文章搜索由我们自建的搜狗引擎执行。引擎<strong>全局串行</strong>，单条通常几十秒到 3 分钟，所以接口是「提交 → 202 + jobId → 轮询 → 读结果」，不是同步返回。</p>
<h3>调用方式</h3>
<ul>
<li><strong>可以一次提交多条</strong>（单条接口多次调用，或批量接口一次 1–${LIMITS.batchItems} 条），不需要等上一条完成再发下一条。Hub 负责排队。</li>
<li>每条用各自的 <code>Idempotency-Key</code>。网络超时、不确定是否提交成功时，用<strong>同一个 key 和同一正文</strong>重发，会返回原任务，不会重复采集或计费。</li>
<li>按响应头 <code>Retry-After</code>（5–60 秒）轮询 <code>GET /jobs/{jobId}</code>。轮询、读结果、查批次都不计费。</li>
<li>status 为 succeeded 后读 <code>/result</code>。想要新数据，换新 key 并设 <code>cacheMaxAgeHours: 0</code>。</li>
<li>定期监控同一关键词：收到终态后再安排下一次，不要在执行期间反复提交。</li>
</ul>
${code(submitExample)}
<h3>状态</h3>
<table><thead><tr><th>status</th><th>含义</th><th>计费</th></tr></thead><tbody>
<tr><td>queued</td><td>排队中，queue.estimatedStartAt 为估算开始时间</td><td>未计费</td></tr>
<tr><td>running</td><td>引擎执行中</td><td>开启计费时已预留</td></tr>
<tr><td>succeeded</td><td>结果已保存。sourceMode：live 实时 / fresh_cache 新鲜缓存 / stored_fallback 旧结果</td><td>开启计费时 live、fresh_cache 计 1 次；stored_fallback 不计费</td></tr>
<tr><td>failed</td><td>明确失败或未派发（如余额不足、权限撤销、搜狗冷却）</td><td>不计费</td></tr>
<tr><td>unknown</td><td>上游是否已停止未知（超时、断连等）。引擎会暂停等待人工核实</td><td>待核实，不自动扣费</td></tr>
<tr><td>cancelled / expired</td><td>调用方取消 / 排队超过 ${LIMITS.queueWaitMs / 3_600_000} 小时</td><td>不计费</td></tr>
</tbody></table>
<h3>上限</h3>
<p>每批最多 ${LIMITS.batchItems} 条；每个调用方未完成（排队 + 执行中）最多 ${LIMITS.consumerOpen} 条；全局排队最多 ${LIMITS.globalQueued} 条。超出返回 429 和 Retry-After，不会静默丢弃。引擎停用或等待核实时返回 503。</p>
<h3>授权与价格</h3>
<p>需要平台 <code>${WECHAT_SELF_HOSTED.platform}</code> 和能力 <code>${WECHAT_SELF_HOSTED.capability}</code>。派发前再次校验 Key 与授权，被拒的任务记为 failed。计费默认关闭：只转发，billing.status 为 none。开启后按任务计费，执行价按当前套餐计算，派发时同时校验余额。</p>
<p>轮询间隔以响应头 <code>Retry-After</code> 为准：排队中的任务按预计开始时间给出 5–60 秒，执行中为 5 秒。</p>`
