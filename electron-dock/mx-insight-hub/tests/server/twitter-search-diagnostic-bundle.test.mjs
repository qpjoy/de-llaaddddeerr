import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { buildLocalTwitterSearchDiagnostic, buildTwitterSearchDiagnostic } from '../../scripts/build-twitter-search-diagnostic.mjs'

const root = new URL('../../', import.meta.url)
const requestId = '446a7664-028d-4dc8-940a-06baaff0c340'
const callId = '00000000-0000-4000-8000-000000000001'
const capturedAt = '2026-10-15T01:00:00.000Z'
const sources = () => ({ diagnosticSource: readFileSync(new URL('server/ops/diagnose-twitter-search.mjs', root), 'utf8'),
  parserSource: readFileSync(new URL('server/contracts/hub-social.mjs', root), 'utf8'),
  errorsSource: readFileSync(new URL('server/core/errors.mjs', root), 'utf8') })
const sha256 = source => createHash('sha256').update(source).digest('hex')
const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`

test('bundle pins exactly the local diagnostic, pure parser and error sources without deployed contract imports', () => {
  const input = sources(), result = buildTwitterSearchDiagnostic(input)
  assert.equal(result.metadata.projectionImplementation, 'bundled_local_candidate')
  assert.equal(result.metadata.parserSha256, sha256(input.parserSource))
  assert.equal(result.metadata.errorsSha256, sha256(input.errorsSource))
  assert.equal(result.metadata.diagnosticSourceSha256, sha256(input.diagnosticSource))
  assert.equal(result.bundleSha256, sha256(result.source))
  assert.equal(result.source, buildLocalTwitterSearchDiagnostic().source)
  assert.doesNotMatch(result.source, /await import\(new URL\('hub-social\.mjs'/)
  const encodedParser = result.source.match(/await import\("(data:text\/javascript;base64,[^"]+)"\)/)?.[1]
  assert.ok(encodedParser)
  const parser = Buffer.from(encodedParser.split(',')[1], 'base64').toString()
  assert.equal(sha256(parser), result.metadata.bundledParserSha256)
  assert.doesNotMatch(parser, /from ['"]\.\.|gateway|adapter.*from/)
  const encodedErrors = parser.match(/import \{ AppError \} from "(data:text\/javascript;base64,[^"]+)"/)?.[1]
  assert.equal(Buffer.from(encodedErrors.split(',')[1], 'base64').toString(), input.errorsSource)
})

test('changed, duplicated or expanded import surfaces and implementation markers fail closed', () => {
  const input = sources()
  for (const parserSource of [input.parserSource + "\nimport fs from 'node:fs'", input.parserSource + "\nawait import('node:http')",
    input.parserSource + "\nimport { AppError } from '../core/errors.mjs'", input.parserSource.replace('../core/errors.mjs', '../external-platforms/gateway.mjs')]) {
    assert.throws(() => buildTwitterSearchDiagnostic({ ...input, parserSource }), /parser_dependencies_changed/)
  }
  for (const diagnosticSource of [input.diagnosticSource.replace("new URL('hub-social.mjs', contracts)", "new URL('other.mjs', contracts)"),
    input.diagnosticSource + "\nawait import(new URL('hub-social.mjs', contracts))", input.diagnosticSource + "\nimport fs from 'node:fs'",
    input.diagnosticSource.replace('TWITTER_DIAGNOSTIC_IMPLEMENTATION', 'CHANGED_MARKER')]) {
    assert.throws(() => buildTwitterSearchDiagnostic({ ...input, diagnosticSource }), /diagnostic_(parser_import|dependencies|implementation_marker)_changed/)
  }
  assert.throws(() => buildTwitterSearchDiagnostic({ ...input, errorsSource: input.errorsSource + "\nexport { readFile } from 'node:fs'" }), /errors_dependencies_changed/)
})

function loaderSource({ corruptedArchive = false } = {}) {
  const pgModule = `
    import { createHash } from 'node:crypto'
    const capturedAt = ${JSON.stringify(capturedAt)}
    const tweet = id => ({content:{itemContent:{itemType:'TimelineTweet',tweet_results:{result:{__typename:'Tweet',rest_id:id,legacy:{full_text:'private-body',favorite_count:0}}}}}})
    const payload = {token:'private-secret',entries:[tweet('123'),{type:'TimelineAddEntries',entries:[tweet('456')]},{content:{cursorType:'Bottom',value:'private-cursor'}}]}
    const bytes = Buffer.from(JSON.stringify(payload))
    const receipt = {body_bytes:bytes,body_size:bytes.length,body_sha256:${corruptedArchive ? "'0'.repeat(64)" : "createHash('sha256').update(bytes).digest('hex')"},captured_at:capturedAt}
    const statements = []
    let released = false
    export default {Pool: class {
      constructor(options) {if(options.connectionString !== 'postgres://synthetic' || options.max !== 1) throw Error('unexpected_pool')}
      async connect() {return {release(){released=true},async query(sql,params) {
        statements.push(sql)
        if (!/^(BEGIN TRANSACTION.*READ ONLY|SET LOCAL|SELECT|COMMIT|ROLLBACK)/.test(sql)) throw Error('write_forbidden')
        if (/^(BEGIN|SET LOCAL|COMMIT|ROLLBACK)/.test(sql)) return {rows:[]}
        if (sql.includes('FROM public.usage_requests')) {
          if(params[0] !== ${JSON.stringify(requestId)}) throw Error('wrong_request_scope')
          return {rows:[{id:params[0],platform:'twitter',status:'committed',response_status:200,reserved_at:capturedAt,completed_at:capturedAt,
            acquisition_request:{path:'/api/v1/data/search',body:{platform:'twitter',query:'private-query',pageSize:20}},
            delivery_contract_version:'night-all.data-search.v1',delivery_status:'ok',delivery_source_mode:'live',delivered_item_count:0,declared_returned_count:0,delivery_has_more:false}]}
        }
        if (sql.includes('FROM external_platform.provider_calls')) {
          if(params[0] !== ${JSON.stringify(requestId)}) throw Error('wrong_call_scope')
          return {rows:[{id:${JSON.stringify(callId)},provider_key:'rapidapi',operation:'social.content.search',endpoint_key:'twitter-aio.search',endpoint_version:'twitter-aio.hub.v1',
            contract_version:'mx-insight-hub.social-data.v1',outcome:'succeeded',http_status:200,business_code:null,billed:null,item_count:0,started_at:capturedAt,completed_at:capturedAt}]}
        }
        if(sql.includes('FROM control.external_platform_restricted_raw_responses')) {
          if(params[0] !== ${JSON.stringify(callId)} || params[1] !== 4194304 || !sql.includes('octet_length(body_bytes) <= $2')) throw Error('unsafe_archive_read')
          return {rows:[receipt]}
        }
        throw Error('unexpected_sql')
      }}}
      async end() {if(!released || !statements[0]?.endsWith('READ ONLY') || statements.at(-1) !== 'COMMIT' || statements.length !== 7) throw Error('readonly_lifecycle_failed')}
    }}
  `
  return `export async function resolve(specifier, context, nextResolve) {
    if(specifier === 'pg') return {url:${JSON.stringify(dataModule(pgModule))},shortCircuit:true}
    if(specifier.startsWith('data:') || ['node:crypto','node:url'].includes(specifier)) return nextResolve(specifier,context)
    throw new Error('unexpected_runtime_import')
  }`
}

for (const corruptedArchive of [false, true]) test(`generated candidate bundle executes through stdin with read-only synthetic DB and ${corruptedArchive ? 'rejects changed archive bytes' : 'finds saved posts missed by old delivery'}`, t => {
  const directory = mkdtempSync(join(tmpdir(), 'twitter-diagnostic-bundle-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const loader = join(directory, 'fixture-loader.mjs')
  writeFileSync(loader, loaderSource({ corruptedArchive }))
  const built = buildLocalTwitterSearchDiagnostic()
  const result = spawnSync(process.execPath, ['--no-warnings', '--permission', '--allow-fs-read=*', '--allow-worker',
    '--experimental-loader', pathToFileURL(loader).href, '--input-type=module', '-', requestId], {
    cwd: root, env: { ...process.env, DATABASE_URL: 'postgres://synthetic' },
    input: 'globalThis.fetch = () => { throw new Error("network_forbidden") };\n' + built.source, encoding: 'utf8', timeout: 10000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  const report = JSON.parse(result.stdout)
  assert.equal(report.diagnosticRevision, 'twitter-search-diagnostic.v3')
  for (const [key, value] of Object.entries(built.metadata)) assert.equal(report[key], value)
  assert.equal(report.delivery.itemCount, 0)
  assert.equal(report.evidence[0].projection.state, corruptedArchive ? 'archive_integrity_failed' : 'current_projection_accepts')
  if (!corruptedArchive) {
    assert.equal(report.evidence[0].projection.returnedCount, 2)
    assert.equal(report.evidence[0].projection.hasMore, true)
    assert.equal(report.evidence[0].deliveredCountMatchesCurrent, false)
  }
  assert.doesNotMatch(result.stdout + result.stderr, /private-|postgres:\/\/|9223372036854775807/)
})

test('builder CLI writes only deterministic JavaScript to stdout and hashes to stderr', () => {
  const result = spawnSync(process.execPath, ['scripts/build-twitter-search-diagnostic.mjs'], { cwd: root, encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 0, result.stderr)
  const expected = buildLocalTwitterSearchDiagnostic()
  assert.equal(result.stdout, expected.source)
  const metadata = JSON.parse(result.stderr)
  assert.equal(metadata.bundleSha256, expected.bundleSha256)
  assert.equal(metadata.parserSha256, expected.metadata.parserSha256)
  assert.equal(metadata.bundleBytes, Buffer.byteLength(expected.source))
  const invalid = spawnSync(process.execPath, ['scripts/build-twitter-search-diagnostic.mjs', 'unexpected'], { cwd: root, encoding: 'utf8' })
  assert.equal(invalid.status, 1)
  assert.equal(invalid.stdout, '')
  assert.deepEqual(JSON.parse(invalid.stderr), { error: 'invalid_arguments' })
})
