// Read-only: shows why saved TikHub Reddit search receipts were unusable. For
// each provider call it reports the dynamic-search node structure (key names,
// GraphQL type names and counts) and replays the installed parser. No values,
// text, URLs or cursors leave restricted storage; no supplier call.
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REVISION = 'reddit-search-shape.v3'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const KEY = /^_{0,2}[A-Za-z][A-Za-z0-9_]{0,40}$/u
const TYPE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,60}$/u
const REASON = /^[a-z][a-z_]{2,60}$/u
const MAX_BYTES = 8 * 1024 * 1024
const MAX_EDGES = 60
const kind = value => value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
const object = value => kind(value) === 'object'
const keyNames = value => object(value) ? Object.keys(value).filter(key => KEY.test(key)).sort().slice(0, 40) : []
const typeName = value => object(value) && typeof value.__typename === 'string' && TYPE_NAME.test(value.__typename) ? value.__typename : null
const fail = code => Object.assign(new Error(code), { diagnosticCode: code })
const source = path => import(new URL(path, pathToFileURL(`${process.cwd()}/`)))

// Same classifier as redditSearchMessageClass in tikhub-content-search.mjs
// (kept here so the diagnostic runs over stdin against any installed build).
const REDDIT_NO_RESULTS = /\b(?:no results|no posts|nothing found|couldn['’]t find|could not find|didn['’]t find|did not find)\b|没有找到|无结果|找不到|沒有找到/iu
export function noticeClass(node) {
  const presentation = object(node?.presentation) ? node.presentation : {}
  const text = [presentation.message, presentation.explanation].filter(value => typeof value === 'string').join('\n')
  return REDDIT_NO_RESULTS.test(text) ? 'no_results' : 'error'
}

// Mirror redditHidesPost's first matching guard without emitting any values.
// A depth refusal is a conservative bound, not evidence of an actual post.
const POST_KEYS = new Set(['post', 'posts', 'postTitle', 'permalink', 'selftext', 'subredditPost', 'profilePost'])
export function unknownNodeGuard(node) {
  let visited = 0
  const ignoredTrackingContexts = []
  const behaviors = node?.__typename === 'SearchSpellCorrectionApplied' ? ['corrected', 'original']
    : node?.__typename === 'SearchBanner' ? ['cta', 'dismiss'] : null
  const field = key => KEY.test(key) ? key : `key-sha256:${createHash('sha256').update(key).digest('hex').slice(0, 12)}`
  const visit = (value, depth, path) => {
    if (++visited > 20000) return { state: 'inspection_truncated', reason: 'node_budget', path }
    const reject = reason => ({ state: 'guard_rejects', reason, path, depth, valueType: kind(value) })
    if (depth > 6) return reject('depth_limit')
    if (behaviors && (path.length === 2 && path[0] === 'telemetry' && path[1] === 'trackingContext'
      || path.length === 4 && path[0] === 'behaviors' && behaviors.includes(path[1])
        && path[2] === 'telemetry' && path[3] === 'trackingContext')) {
      ignoredTrackingContexts.push(path)
      return null
    }
    if (Array.isArray(value)) {
      if (value.length > 200) return reject('array_limit')
      for (let index = 0; index < value.length; index++) {
        const result = visit(value[index], depth + 1, [...path, index])
        if (result) return result
      }
      return null
    }
    if (!object(value)) return typeof value === 'string' && /^t3_/u.test(value) ? reject('post_id_prefix') : null
    if (typeof value.__typename === 'string' && /Post$/u.test(value.__typename)) return reject('post_typename')
    for (const [key, item] of Object.entries(value)) {
      if (POST_KEYS.has(key)) return { ...reject('post_field'), path: [...path, key] }
      const result = visit(item, depth + 1, [...path, field(key)])
      if (result) return result
    }
    return null
  }
  return { ...(visit(node, 0, []) || { state: 'guard_accepts' }), visited, ignoredTrackingContexts }
}

// Mirrors the installed parser's node walk: post, children, or a known non-post.
function classify(node, depth = 0) {
  if (!object(node)) return { branch: 'not_object', kind: kind(node) }
  const shape = { typename: typeName(node), keys: keyNames(node) }
  if (Object.hasOwn(node, 'post')) {
    const post = node.post
    const id = [post?.id, post?.name, post?.post_id].find(value => typeof value === 'string' && value.trim())
    return { branch: 'post', ...shape, postTypename: typeName(post), postKeys: keyNames(post),
      identity: id ? (/^t\d_/u.exec(id)?.[0] ?? 'unprefixed') : 'missing' }
  }
  if (Object.hasOwn(node, 'children')) {
    const children = Array.isArray(node.children) ? node.children : []
    return { branch: 'children', ...shape, childCount: Array.isArray(node.children) ? children.length : kind(node.children),
      children: depth < 2 ? children.slice(0, 10).map(child => classify(child, depth + 1)) : 'depth_limit' }
  }
  const nonPost = ['community', 'comment', 'author'].find(name => object(node[name]))
  if (nonPost) return { branch: `non_post:${nonPost}`, ...shape }
  // Only the class leaves storage, never the notice text.
  if (shape.typename === 'SearchErrorMessage') return { branch: 'notice', ...shape, noticeClass: noticeClass(node) }
  return { branch: 'unrecognized', ...shape, guard: unknownNodeGuard(node),
    nested: Object.fromEntries(shape.keys.filter(key => object(node[key]) || Array.isArray(node[key])).slice(0, 10)
      .map(key => [key, Array.isArray(node[key]) ? { array: node[key].length, firstKeys: keyNames(node[key][0]), firstTypename: typeName(node[key][0]) }
        : { typename: typeName(node[key]), keys: keyNames(node[key]) }])) }
}

export function inspectRedditArchive(archive, parse = null) {
  if (!archive) return { state: 'archive_missing' }
  const bytes = archive.body_bytes instanceof Uint8Array ? Buffer.from(archive.body_bytes) : null
  if (!bytes || bytes.length > MAX_BYTES || createHash('sha256').update(bytes).digest('hex') !== archive.body_sha256) return { state: 'archive_integrity_failed' }
  let payload
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return { state: 'archive_not_json' } }
  const root = payload?.data
  const dynamic = value => value?.search?.dynamic || value?.search?.Dynamic
  const data = !dynamic(root) && dynamic(root?.data) ? root.data : root
  const main = dynamic(data)?.components?.main
  const edges = Array.isArray(main?.edges) ? main.edges : []
  const nodes = edges.slice(0, MAX_EDGES).map(edge => classify(edge?.node))
  const branches = {}
  for (const node of nodes) branches[node.branch] = (branches[node.branch] || 0) + 1
  return { state: 'archive_verified', bodySize: bytes.length, envelopeCode: Number.isSafeInteger(payload?.code) ? payload.code : null,
    dataPath: data === root ? 'data' : 'data.data', dataKeys: keyNames(data), mainKind: kind(main), mainKeys: keyNames(main),
    pageInfoKeys: keyNames(main?.pageInfo), edgeCount: Array.isArray(main?.edges) ? edges.length : kind(main?.edges),
    edgesTruncated: edges.length > MAX_EDGES, branches, nodes, parser: parse ? parse(payload, archive.captured_at) : null }
}

function parser(contract) {
  const request = contract.normalizeTikHubContentSearchRequest({ platform: 'reddit', query: 'offline-diagnostic', pageSize: 20 })
  return (payload, capturedAt) => {
    try {
      const result = contract.projectTikHubContentSearch({ publicBody: { data: payload?.data,
        meta: { capturedAt: new Date(capturedAt || Date.now()).toISOString() } } }, request)
      return { state: 'installed_accepts', itemCount: result.items.length, nonPostCount: result.nonPostCount ?? 0 }
    } catch (error) {
      return { state: 'installed_rejects', reason: REASON.test(error?.message || '') ? error.message : 'other' }
    }
  }
}

const callQuery = `SELECT /* reddit-shape:calls */ c.id, c.outcome, c.http_status, c.business_code, c.error_code, c.endpoint_key,
    r.body_bytes, r.body_sha256, r.captured_at
  FROM external_platform.provider_calls c
  LEFT JOIN control.external_platform_restricted_raw_responses r ON r.provider_call_id = c.id AND r.body_size <= ${MAX_BYTES}
  WHERE c.id = ANY($1::uuid[]) AND c.provider_key = 'tikhub' AND c.endpoint_key LIKE '%reddit%' ORDER BY c.started_at LIMIT 3`

export async function diagnoseRedditSearch(pool, callIds, { contract = null } = {}) {
  if (!Array.isArray(callIds) || !callIds.length || callIds.length > 3 || callIds.some(id => !UUID.test(id))) throw fail('invalid_call_ids')
  const parse = contract ? parser(contract) : null
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout='5s'")
    const calls = (await client.query(callQuery, [callIds])).rows
    if (!calls.length) throw fail('calls_not_found')
    return { diagnosticRevision: REVISION, readOnly: true, parserReplay: parse ? 'installed' : 'unavailable',
      calls: calls.map(call => ({ callId: call.id, outcome: call.outcome, httpStatus: call.http_status, businessCode: call.business_code,
        errorCode: REASON.test(call.error_code || '') ? call.error_code : null,
        receipt: inspectRedditArchive(call.body_bytes ? call : null, parse) })) }
  } finally { await client.query('ROLLBACK').catch(() => {}); client.release() }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  let pool
  try {
    if (!args.length || args.length > 3 || args.some(id => !UUID.test(id))) throw fail('invalid_call_ids')
    if (typeof env.DATABASE_URL !== 'string' || !env.DATABASE_URL.trim()) throw fail('database_url_required')
    const { Pool } = await import('pg')
    const contract = await source('server/contracts/tikhub-content-search.mjs').catch(() => null)
    pool = new Pool({ connectionString: env.DATABASE_URL, max: 1, application_name: REVISION, connectionTimeoutMillis: 5000 })
    process.stdout.write(`${JSON.stringify(await diagnoseRedditSearch(pool, args, { contract }), null, 2)}\n`)
  } catch (error) {
    const known = new Set(['invalid_call_ids', 'database_url_required', 'calls_not_found'])
    process.stdout.write(`${JSON.stringify({ diagnosticRevision: REVISION, errorCode: known.has(error?.diagnosticCode) ? error.diagnosticCode : 'diagnostic_unavailable' })}\n`)
    process.exitCode = 1
  } finally { await pool?.end().catch(() => {}) }
}

const stdinEntry = process.argv[1] === '-' && fileURLToPath(import.meta.url) === `${process.cwd()}/[eval1]`
if (stdinEntry || process.argv[1] && process.argv[1] !== '-' && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
