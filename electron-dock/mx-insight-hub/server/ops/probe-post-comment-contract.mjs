import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const PLATFORM_KEYS = Object.freeze({ twitter: 'j.api_bcedccd1a73cc8f2', reddit: 'j.api_9f1806a48fde0794', kuaishou: 'j.api_e0c0bbd6b8e0784c' })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SAFE_ERRORS = new Set(['invalid_arguments', 'invalid_sample', 'ambiguous_sample', 'sample_not_found', 'sample_directory_too_large', 'api_key_required', 'invalid_api_key'])
const RESPONSE_CODES = new Set(['invalid_api_key', 'api_key_required', 'platform_not_granted', 'capability_not_granted', 'request_outcome_unknown',
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
    body: { params: platform === 'twitter' ? { tweetId: id }
      : platform === 'reddit' ? { postId: `t3_${id}` } : { videoId: id }, deliveryMode: 'live_only' } }
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
    const requestId = payload?.error?.details?.requestId ?? payload?.requestId
    return { errorCode: RESPONSE_CODES.has(payload?.error?.code) ? payload.error.code : 'other',
      requestId: UUID.test(requestId || '') ? requestId : null }
  } catch { return null }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export async function runPostCommentProbe({ plan, sampleDirectory, apiKey, apply = false }, { fetchImpl = fetch } = {}) {
  // Validate the supplied plan again so callers cannot construct another route.
  const expected = planPostCommentProbe(plan?.platform, { platform: plan?.platform,
    postId: plan?.body?.params?.tweetId ?? plan?.body?.params?.postId ?? plan?.body?.params?.videoId })
  if (JSON.stringify(expected) !== JSON.stringify(plan)) throw new Error('invalid_sample')
  const preview = { revision: 'post-comment-contract-probe.v1', platform: plan.platform, path: plan.path,
    hubRequestLimit: 1, maxPlatformsPerReceiptDirectory: 3, automaticContinuation: false, automaticRetry: false }
  if (!apply) return { ...preview, state: 'preview', hubRequestsMade: 0 }
  if (!apiKey) throw new Error('api_key_required')
  if (typeof apiKey !== 'string' || apiKey.length > 4096 || /[\r\n\u0000]/u.test(apiKey)) throw new Error('invalid_api_key')
  const receiptDirectory = join(resolve(sampleDirectory), '.hub-comment-contract-probes-v1')
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 })
  const receiptPath = join(receiptDirectory, `${plan.platform}.json`)
  const idempotencyKey = `comment-calibration-v1-${randomUUID()}`
  const beforeDispatch = { ...preview, state: 'dispatch_started', idempotencyKey, requestId: null, httpStatus: null }
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
    result = { ...beforeDispatch, state: 'http_response', httpStatus: response.status,
      requestId: UUID.test(requestId || '') ? requestId : error?.requestId ?? null, hubRequestsMade: 1,
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
    if (args.length !== 4 || args[0] !== '--sample-dir' || args[2] !== '--platform' || !Object.hasOwn(PLATFORM_KEYS, args[3])) throw new Error('invalid_arguments')
    const plan = await loadPostCommentProbeSample(args[1], args[3])
    console.log(JSON.stringify(await runPostCommentProbe({ plan, sampleDirectory: args[1], apply,
      apiKey: process.env.MX_HUB_PROBE_API_KEY }), null, 2))
  } catch (error) {
    console.error(JSON.stringify({ error: SAFE_ERRORS.has(error?.message) ? error.message : 'post_comment_contract_probe_failed' }))
    process.exitCode = 1
  }
}
