// Read-only: shows where a saved TikHub YouTube search receipt keeps author,
// view, date and engagement fields, as structural key names and value formats.
// No values, text, URLs or cursors leave restricted storage; no supplier call.
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REVISION = 'youtube-search-shape.v1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,40}$/u
const MAX_BYTES = 8 * 1024 * 1024
const LISTS = ['videos', 'shorts', 'channels', 'playlists', 'items', 'contents']
const SAMPLE = 3
const kind = value => value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
const object = value => kind(value) === 'object'
const keyNames = value => object(value) ? Object.keys(value).filter(key => IDENTIFIER.test(key)).sort().slice(0, 40) : []
const fail = code => Object.assign(new Error(code), { diagnosticCode: code })

// The format of a value, never the value: enough to decide whether an exact
// counter, an abbreviated display string or a relative date was supplied.
export function valueFormat(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? 'integer' : Number.isFinite(value) ? 'decimal' : 'other_number'
  if (typeof value !== 'string') return kind(value)
  const text = value.trim()
  if (!text) return 'empty_string'
  if (/^\d+$/u.test(text)) return 'digits'
  if (/^\d{1,3}(,\d{3})+$/u.test(text)) return 'digits_with_commas'
  if (/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/u.test(text)) return 'iso_date'
  if (/\b(ago|second|minute|hour|day|week|month|year)s?\b|前$|(秒|分钟|小时|天|周|个月|年)前/u.test(text)) return 'relative_time'
  if (/^[\d.,]+\s*[KMBkmb万亿]/u.test(text) || /[\d.,]+\s*(万|亿)/u.test(text)) return 'abbreviated_count'
  if (/[\d.,]+\s*(views?|次观看|观看|likes?|comments?)/iu.test(text)) return 'count_text'
  if (/^\d{1,2}(:\d{2}){1,2}$/u.test(text)) return 'duration'
  return 'other_text'
}

function fieldShapes(value, depth = 0) {
  if (!object(value)) return kind(value)
  return Object.fromEntries(keyNames(value).map(key => {
    const field = value[key]
    if (object(field)) return [key, depth < 2 ? fieldShapes(field, depth + 1) : 'object']
    if (Array.isArray(field)) return [key, { array: field.length, first: field.length ? (object(field[0]) && depth < 2 ? fieldShapes(field[0], depth + 1) : valueFormat(field[0])) : null }]
    return [key, valueFormat(field)]
  }))
}

export function inspectYoutubeArchive(archive) {
  if (!archive) return { state: 'archive_missing' }
  const bytes = archive.body_bytes instanceof Uint8Array ? Buffer.from(archive.body_bytes) : null
  if (!bytes || bytes.length > MAX_BYTES || createHash('sha256').update(bytes).digest('hex') !== archive.body_sha256) return { state: 'archive_integrity_failed' }
  let payload
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return { state: 'archive_not_json' } }
  const root = payload?.data
  const data = object(root?.data) ? root.data : root
  return { state: 'archive_verified', bodySize: bytes.length, envelopeCode: Number.isSafeInteger(payload?.code) ? payload.code : null,
    nestedData: object(root?.data), dataKeys: keyNames(data),
    lists: Object.fromEntries(LISTS.map(name => [name, Array.isArray(data?.[name]) ? data[name].length : kind(data?.[name])])),
    samples: Object.fromEntries(LISTS.filter(name => Array.isArray(data?.[name]) && data[name].length)
      .map(name => [name, data[name].slice(0, SAMPLE).map(entry => fieldShapes(entry))])) }
}

const callQuery = `SELECT /* youtube-shape:calls */ c.id, c.call_ordinal, c.outcome, c.http_status, c.business_code, c.endpoint_key,
    r.body_bytes, r.body_sha256
  FROM external_platform.provider_calls c
  LEFT JOIN control.external_platform_restricted_raw_responses r ON r.provider_call_id = c.id AND r.body_size <= ${MAX_BYTES}
  WHERE c.usage_request_id = $1 AND c.provider_key = 'tikhub' ORDER BY c.call_ordinal, c.started_at LIMIT 4`

export async function diagnoseYoutubeSearch(pool, requestId) {
  if (!UUID.test(requestId || '')) throw fail('invalid_request_id')
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout='5s'")
    const request = (await client.query(`SELECT /* youtube-shape:usage */ platform, status FROM usage_requests WHERE id = $1`, [requestId])).rows[0]
    if (!request) throw fail('request_not_found')
    if (request.platform !== 'youtube') throw fail('request_not_youtube')
    const calls = (await client.query(callQuery, [requestId])).rows
    return { diagnosticRevision: REVISION, requestId, status: request.status, readOnly: true, callsTruncated: calls.length > 3,
      calls: calls.slice(0, 3).map(call => ({ callId: call.id, ordinal: call.call_ordinal, outcome: call.outcome,
        httpStatus: call.http_status, businessCode: call.business_code,
        endpoint: IDENTIFIER.test(call.endpoint_key || '') ? call.endpoint_key : 'other',
        receipt: inspectYoutubeArchive(call.body_bytes ? call : null) })) }
  } finally { await client.query('ROLLBACK').catch(() => {}); client.release() }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  let pool
  try {
    if (args.length !== 1) throw fail('invalid_arguments')
    if (!UUID.test(args[0])) throw fail('invalid_request_id')
    if (typeof env.DATABASE_URL !== 'string' || !env.DATABASE_URL.trim()) throw fail('database_url_required')
    const { Pool } = await import('pg')
    pool = new Pool({ connectionString: env.DATABASE_URL, max: 1, application_name: REVISION, connectionTimeoutMillis: 5000 })
    process.stdout.write(`${JSON.stringify(await diagnoseYoutubeSearch(pool, args[0]), null, 2)}\n`)
  } catch (error) {
    const known = new Set(['invalid_arguments', 'invalid_request_id', 'database_url_required', 'request_not_found', 'request_not_youtube'])
    process.stdout.write(`${JSON.stringify({ diagnosticRevision: REVISION, errorCode: known.has(error?.diagnosticCode) ? error.diagnosticCode : 'diagnostic_unavailable' })}\n`)
    process.exitCode = 1
  } finally { await pool?.end().catch(() => {}) }
}

const stdinEntry = process.argv[1] === '-' && fileURLToPath(import.meta.url) === `${process.cwd()}/[eval1]`
if (stdinEntry || process.argv[1] && process.argv[1] !== '-' && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
