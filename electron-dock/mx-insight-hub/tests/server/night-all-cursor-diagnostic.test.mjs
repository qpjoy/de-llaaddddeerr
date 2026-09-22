import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { createNightAllCompatibilityCursorCodec } from '../../server/external-platforms/cursor.mjs'

const secret = 'diagnostic-test-secret-never-print'
const consumer = 'diagnostic-test-consumer'
const codec = createNightAllCompatibilityCursorCodec(secret, consumer)
const shell = readFileSync(new URL('../../scripts/diagnose-douyin-request.sh', import.meta.url), 'utf8')
const program = shell.split("<<'NODE'\n")[1].split('\nNODE')[0]

function run(token) {
  const row = { id: '37bf1066-508d-47c9-9c54-2d572e03a0a5', consumer_id: consumer,
    platform: 'douyin', acquisition_request: { body: { platform: 'douyin', count: 20, cursor: token } } }
  const stub = `const pg = { Client: class {
    constructor(options) {
      if (!options.options.includes('default_transaction_read_only=on')) throw Error('not_readonly');
    }
    async connect() {}
    async end() {}
    async query(sql) {
      if (/FROM public.usage_requests/.test(sql)) return { rows: [${JSON.stringify(row)}] };
      if (/FROM serving.connector_calls/.test(sql)) return { rows: [] };
      if (/^(BEGIN|ROLLBACK)/.test(sql)) return { rows: [] };
      throw Error('unexpected_query');
    }
  } }`
  const code = program.replace("import pg from 'pg'", stub)
    .replaceAll("from './server/", `from '${new URL('../../server/', import.meta.url).href}`)
  const result = spawnSync(process.execPath, ['--input-type=module'], {
    input: code, encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: 'synthetic-not-connected', MX_INSIGHT_API_KEY_PEPPER: secret },
  })
  assert.equal(result.status, 0, result.stderr)
  for (const sensitive of [secret, token, 'private-search-context', 'private-backtrace']) {
    assert.ok(!result.stdout.includes(sensitive), 'diagnostics must not print secrets or continuation values')
  }
  return JSON.parse(result.stdout)
}

for (const complete of [false, true]) {
  test(`readonly cursor diagnosis distinguishes ${complete ? 'complete' : 'old single-value'} tokens`, () => {
    const token = codec.encode({
      contract: 'mx-insight-hub.night-all-compatibility-cursor.v1',
      operation: 'raw', platform: 'douyin', scope: 'synthetic', page: 2,
      continuation: complete
        ? { type: 'params', cursor: '8', value: { search_id: 'private-search-context', backtrace: 'private-backtrace' } }
        : { type: 'cursor', value: '8' },
    })
    const report = run(token)
    assert.deepEqual(report.runtimeCompoundProbe, {
      preservesCursor: true, preservesSearchId: true, preservesBacktrace: true, paidCalls: 0,
    })
    assert.deepEqual(report.requests[0].cursorState, {
      status: 'authenticated', platformMatchesRequest: true, operationIsRaw: true,
      page: 2, type: complete ? 'params' : 'cursor', hasPrimaryCursor: true,
      numericCursor: '8', hasSearchId: complete, hasBacktrace: complete,
    })
  })
}

test('a token that cannot authenticate is reported without dumping its payload', () => {
  const report = run('mxnc1.invalid-token')
  assert.equal(report.requests[0].cursorState.status, 'decode_failed_key_rotation_or_invalid_token')
})
