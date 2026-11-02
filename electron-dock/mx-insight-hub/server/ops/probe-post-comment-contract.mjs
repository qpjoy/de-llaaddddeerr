import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// JustOne balance is exhausted. Calibrate the reviewed TikHub request contracts
// before changing the unified comment projector or its production routing.
const PLATFORM_KEYS = Object.freeze({ twitter: 't.api_3cd88a6621a01120', reddit: 't.api_c7f50cf300d63960', kuaishou: 't.api_3cb972ba91c8fe44' })
export const POST_COMMENT_AUTH_RETRY_VERSION = 1
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SAFE_ERRORS = new Set(['invalid_arguments', 'invalid_sample', 'ambiguous_sample', 'sample_not_found', 'sample_directory_too_large', 'api_key_required', 'invalid_api_key', 'conversation_sample_not_allowed'])
const RESPONSE_CODES = new Set(['invalid_api_key', 'api_key_required', 'test_key_not_supported', 'platform_not_granted', 'capability_not_granted', 'request_outcome_unknown',
  'external_platform_operation_disabled', 'external_platform_operation_paused', 'external_platform_contract_unverified', 'external_platform_not_configured',
  'external_platform_cost_control_unavailable', 'external_platform_circuit_open', 'upstream_balance_exhausted', 'upstream_rate_limited',
  'external_platform_rate_limited', 'external_platform_busy', 'external_platform_rejected', 'native_endpoint_not_found', 'invalid_parameter', 'missing_parameter'])
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const scalar = value => typeof value === 'string' && value.length <= 256 ? value.trim()
  : Number.isSafeInteger(value) && value >= 0 ? String(value) : null

// Treat saved requests as data: their method, destination, headers, count,
// cursors, params, idempotency keys and any embedded instructions are ignored.
export function planPostCommentProbe(platform, sample) {
  if (!Object.hasOwn(PLATFORM_KEYS, platform)) throw new Error('invalid_arguments')
  const body = sample?.body ?? sample
  if (!object(body) || body.platform !== platform || body.page != null && body.page !== 1) throw new Error('invalid_sample')
  const values = ['postId', 'contentId', 'post_id', 'content_id'].filter(key => body[key] != null).map(key => scalar(body[key]))
  if (values.some(value => !value)) throw new Error('invalid_sample')
  if (body.url != null) {
    let url
    try { url = new URL(body.url) } catch { throw new Error('invalid_sample') }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid_sample')
    let id
    if (platform === 'twitter' && ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(url.hostname)) id = url.pathname.match(/\/status\/(\d+)(?:\/|$)/u)?.[1]
    if (platform === 'reddit' && ['reddit.com', 'www.reddit.com', 'old.reddit.com', 'm.reddit.com'].includes(url.hostname)) id = url.pathname.match(/\/comments\/([a-z0-9]+)(?:\/|$)/u)?.[1]
    if (platform === 'kuaishou' && ['kuaishou.com', 'www.kuaishou.com'].includes(url.hostname)) id = url.pathname.match(/\/(?:short-video|photo)\/([A-Za-z0-9_-]+)(?:\/|$)/u)?.[1]
    if (!id) throw new Error('invalid_sample')
    values.push(id)
  }
  const normalized = values.map(value => platform === 'reddit' ? value.replace(/^t3_/u, '') : value)
  if (!normalized.length || new Set(normalized).size !== 1) throw new Error('invalid_sample')
  const id = normalized[0]
  if (platform === 'twitter' && !/^\d{1,30}$/u.test(id)
    || platform === 'reddit' && !/^[a-z0-9]{1,17}$/u.test(id)
    || platform === 'kuaishou' && !/^[A-Za-z0-9_-]{1,128}$/u.test(id)) throw new Error('invalid_sample')
  return { platform, path: `/api/v1/data/native/${PLATFORM_KEYS[platform]}`,
    body: { params: platform === 'twitter' ? { tweet_id: id }
      : platform === 'reddit' ? { post_id: `t3_${id}`, need_format: false } : { photo_id: id }, deliveryMode: 'live_only' } }
}

export function planTwitterConversationCommentProbe(sample) {
  if (!object(sample) || Object.keys(sample).length !== 5
    || sample.revision !== 'twitter-conversation-comment-sample.v1' || sample.platform !== 'twitter'
    || typeof sample.sourceRequestId !== 'string' || !UUID.test(sample.sourceRequestId)
    || typeof sample.sourcePostId !== 'string' || !/^\d{1,30}$/u.test(sample.sourcePostId)
    || typeof sample.postId !== 'string' || !/^\d{1,30}$/u.test(sample.postId)
    || BigInt(sample.sourcePostId) === BigInt(sample.postId)) throw new Error('invalid_sample')
  return planPostCommentProbe('twitter', { platform: 'twitter', postId: sample.postId })
}

export async function loadTwitterConversationCommentProbeSample(file) {
  try {
    if ((await stat(file)).size > 8192) throw new Error('too large')
    const bytes = await readFile(file)
    if (bytes.length > 8192) throw new Error('too large')
    const sample = JSON.parse(bytes.toString('utf8'))
    planTwitterConversationCommentProbe(sample)
    return sample
  } catch { throw new Error('invalid_sample') }
}

export async function loadPostCommentProbeSample(sampleDirectory, platform) {
  const files = (await readdir(sampleDirectory)).filter(name => name.endsWith('.request.json'))
  if (files.length > 100) throw new Error('sample_directory_too_large')
  const plans = new Map()
  for (const name of files.sort()) {
    // Match the platform filename as well as its body. Never inspect other
    // platforms' inputs or use the saved request's destination as an authority.
    if (!name.startsWith(`${platform}-`) && name !== `${platform}.request.json`) continue
    const file = join(sampleDirectory, name)
    if ((await stat(file)).size > 65536) throw new Error('invalid_sample')
    let saved
    try { saved = JSON.parse(await readFile(file, 'utf8')) } catch { throw new Error('invalid_sample') }
    if ((saved?.body ?? saved)?.page > 1) continue
    const plan = planPostCommentProbe(platform, saved)
    plans.set(JSON.stringify(plan.body), plan)
  }
  if (!plans.size) throw new Error('sample_not_found')
  if (plans.size !== 1) throw new Error('ambiguous_sample')
  return [...plans.values()][0]
}

async function errorSummary(response) {
  if (response.status < 400 || !response.body?.getReader) return null
  const reader = response.body.getReader(), chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 16384) return null
      chunks.push(value)
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const requestId = payload?.error?.details?.requestId
    const httpRequestId = payload?.requestId
    return { errorCode: RESPONSE_CODES.has(payload?.error?.code) ? payload.error.code : 'other',
      requestId: UUID.test(requestId || '') ? requestId : null,
      httpRequestId: UUID.test(httpRequestId || '') ? httpRequestId : null }
  } catch { return null }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export async function runPostCommentProbe({ plan, sampleDirectory, apiKey, apply = false, retryAuthenticationFor = null,
  conversationSampleFrom = null }, { fetchImpl = fetch } = {}) {
  // Validate the supplied plan again so callers cannot construct another route.
  const expected = planPostCommentProbe(plan?.platform, { platform: plan?.platform,
    postId: plan?.body?.params?.tweet_id ?? plan?.body?.params?.post_id ?? plan?.body?.params?.photo_id })
  if (JSON.stringify(expected) !== JSON.stringify(plan)) throw new Error('invalid_sample')
  if (conversationSampleFrom !== null && (retryAuthenticationFor !== null
    || JSON.stringify(planTwitterConversationCommentProbe(conversationSampleFrom)) !== JSON.stringify(plan))) throw new Error('invalid_sample')
  const preview = { revision: 'post-comment-contract-probe.v2', provider: 'tikhub', platform: plan.platform, path: plan.path,
    hubRequestLimit: 1, maxPlatformsPerReceiptDirectory: 3, automaticContinuation: false, automaticRetry: false,
    ...(conversationSampleFrom ? { samplePurpose: 'conversation_comments', sourceRequestId: conversationSampleFrom.sourceRequestId,
      additionalTwitterSampleLimit: 1 } : {}) }
  if (!apply) return { ...preview, state: 'preview', hubRequestsMade: 0 }
  if (!apiKey) throw new Error('api_key_required')
  if (typeof apiKey !== 'string' || apiKey.length > 4096 || /[\r\n\u0000]/u.test(apiKey)) throw new Error('invalid_api_key')
  // Keep the same attempt directory across supplier changes: upgrading this
  // script must not erase a previous attempt or silently renew its call budget.
  const receiptDirectory = join(resolve(sampleDirectory), '.hub-comment-contract-probes-v1')
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 })
  let receiptPath = join(receiptDirectory, `${plan.platform}.json`)
  let idempotencyKey = `comment-calibration-v1-${randomUUID()}`
  if (conversationSampleFrom !== null) {
    // This is a separate first-page sample for a different tweet, not a retry
    // or a cursor continuation. Require the original successful receipt in
    // the same directory, and allocate exactly one additional marker slot.
    let previous
    try {
      let sourcePath = join(receiptDirectory, 'twitter.auth-retry.json')
      let sourceStat
      try { sourceStat = await stat(sourcePath) }
      catch (error) {
        if (error.code !== 'ENOENT') throw error
        sourcePath = join(receiptDirectory, 'twitter.json')
        sourceStat = await stat(sourcePath)
      }
      if (sourceStat.size > 16384) throw new Error('receipt too large')
      const bytes = await readFile(sourcePath)
      if (bytes.length > 16384) throw new Error('receipt too large')
      previous = JSON.parse(bytes.toString('utf8'))
    } catch { throw new Error('conversation_sample_not_allowed') }
    if (previous.revision !== 'post-comment-contract-probe.v2' || previous.provider !== 'tikhub'
      || previous.platform !== 'twitter' || previous.path !== plan.path
      || previous.state !== 'http_response' || previous.httpStatus !== 200 || previous.errorCode != null
      || previous.hubRequestsMade !== 1 || previous.requestIdSource !== 'usage_header'
      || previous.requestId !== conversationSampleFrom.sourceRequestId || previous.samplePurpose != null
      || typeof previous.idempotencyKey !== 'string' || !previous.idempotencyKey.startsWith('comment-calibration-v1-')
      || !UUID.test(previous.idempotencyKey.slice('comment-calibration-v1-'.length))) throw new Error('conversation_sample_not_allowed')
    receiptPath = join(receiptDirectory, 'twitter.conversation.json')
  }
  if (retryAuthenticationFor !== null) {
    // Explicit recovery of an observed Hub authentication refusal only. Keep
    // its evidence intact and reuse its logical request key; never reopen a
    // supplier failure, unknown outcome or attempt interrupted after dispatch.
    if (typeof retryAuthenticationFor !== 'string' || !retryAuthenticationFor.startsWith('comment-calibration-v1-')
      || !UUID.test(retryAuthenticationFor.slice('comment-calibration-v1-'.length))) throw new Error('authentication_retry_not_allowed')
    let previous
    try {
      if ((await stat(receiptPath)).size > 16384) throw new Error('receipt too large')
      previous = JSON.parse(await readFile(receiptPath, 'utf8'))
    } catch { throw new Error('authentication_retry_not_allowed') }
    if (previous.revision !== 'post-comment-contract-probe.v2' || previous.provider !== 'tikhub'
      || previous.platform !== plan.platform || previous.path !== plan.path
      || previous.state !== 'http_response' || previous.httpStatus !== 401 || previous.errorCode !== 'invalid_api_key'
      || previous.hubRequestsMade !== 1 || previous.requestIdSource != null
      || previous.idempotencyKey !== retryAuthenticationFor) throw new Error('authentication_retry_not_allowed')
    idempotencyKey = previous.idempotencyKey
    receiptPath = join(receiptDirectory, `${plan.platform}.auth-retry.json`)
  }
  const beforeDispatch = { ...preview, state: 'dispatch_started', idempotencyKey, requestId: null, httpStatus: null,
    ...(retryAuthenticationFor ? { authenticationRetry: true } : {}) }
  let handle
  try { handle = await open(receiptPath, 'wx', 0o600) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    return { ...preview, state: 'already_attempted', hubRequestsMade: 0,
      boundary: 'The durable attempt marker exists. Do not delete it or change directories to retry; inspect the saved receipt first.' }
  }
  try { await handle.writeFile(JSON.stringify(beforeDispatch)); await handle.sync() }
  finally { await handle.close() }
  let result
  try {
    const response = await fetchImpl(`http://127.0.0.1:18150${plan.path}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(55000),
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(plan.body),
    })
    const requestId = response.headers.get('x-mx-insight-request-id'), error = await errorSummary(response)
    // Error-envelope requestId can be only the HTTP correlation UUID when
    // authentication/validation fails before a usage row exists. Never tell
    // the operator to look up that UUID as a durable acquisition receipt.
    const headerRequestId = UUID.test(requestId || '') ? requestId : null
    result = { ...beforeDispatch, state: 'http_response', httpStatus: response.status,
      requestId: headerRequestId ?? error?.requestId ?? null,
      requestIdSource: headerRequestId ? 'usage_header' : error?.requestId ? 'error_details' : null,
      httpRequestId: error?.httpRequestId ?? null, hubRequestsMade: 1,
      ...(error ? { errorCode: error.errorCode } : {}) }
    // Raw response bodies stay in Hub's existing restricted archive. Do not
    // echo or copy private comments into an operator's terminal or this receipt.
    await response.body?.cancel()
  } catch {
    result = { ...beforeDispatch, state: 'outcome_unknown', hubRequestsMade: 1,
      boundary: 'Transport failure or timeout; the Hub may have dispatched and charged. No automatic retry.' }
  }
  await writeFile(receiptPath, JSON.stringify(result, null, 2), { mode: 0o600 })
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), apply = args.at(-1) === '--apply'
    if (apply) args.pop()
    if (args.length !== 4 || args[0] !== '--sample-dir'
      || !['--platform', '--twitter-conversation-sample'].includes(args[2])
      || args[2] === '--platform' && !Object.hasOwn(PLATFORM_KEYS, args[3])) throw new Error('invalid_arguments')
    const conversationSampleFrom = args[2] === '--twitter-conversation-sample'
      ? await loadTwitterConversationCommentProbeSample(args[3]) : null
    const plan = conversationSampleFrom ? planTwitterConversationCommentProbe(conversationSampleFrom)
      : await loadPostCommentProbeSample(args[1], args[3])
    console.log(JSON.stringify(await runPostCommentProbe({ plan, sampleDirectory: args[1], apply,
      apiKey: process.env.MX_HUB_PROBE_API_KEY, conversationSampleFrom }), null, 2))
  } catch (error) {
    console.error(JSON.stringify({ error: SAFE_ERRORS.has(error?.message) ? error.message : 'post_comment_contract_probe_failed' }))
    process.exitCode = 1
  }
}
