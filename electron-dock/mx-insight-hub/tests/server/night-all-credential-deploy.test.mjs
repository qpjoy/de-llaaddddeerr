import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { migrateNightAllDeployCredentials } from '../../scripts/migrate-night-all-deploy-credentials.mjs'
import { migrateNightAllCredentials } from '../../scripts/migrate-night-all-credentials.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const scalar = ['rapidapi', 'tikhub', 'justone']
const web = ['baidu', 'exa', 'tavily', 'serper', 'you', 'searchapi', 'firecrawl', 'serpapi']
const token = 'synthetic-deploy-admin-secret-at-least-32-bytes'
const sourceUrl = 'postgresql://fixture:synthetic-source-secret@127.0.0.1/nightall'
const environment = { MX_INSIGHT_ADMIN_TOKEN: token, MX_INSIGHT_ADMIN_BASE_URL: 'http://127.0.0.1:18151' }
const missing = () => Object.assign(new Error('synthetic-source-secret'), { code: 'ENOENT' })

function coordinator(overrides = {}) {
  const calls = []
  return { calls, options: {
    discoverConfig: async () => '/synthetic/config.json', inspect: async () => ({}),
    migrateJson: async (env, options) => { calls.push({ source: 'json', env, options }); return { complete: true, providers: [] } },
    migrateFacebook: async env => { calls.push({ source: 'legacy', env }); return scalar.slice(0, 1).map(provider => ({ provider, status: 'preserved', revision: 1 })) },
    ...overrides,
  } }
}

test('deploy JSON owns eleven suppliers without SQL and only three when SQL is explicit', async () => {
  for (const database of ['', sourceUrl]) {
    const f = coordinator()
    const result = await migrateNightAllDeployCredentials({ ...environment, NIGHT_ALL_DATABASE_URL: database }, f.options)
    assert.equal(result.configMissing, false)
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].source, 'json')
    assert.equal(f.calls[0].env.NIGHT_ALL_CONFIG_PATH, '/synthetic/config.json')
    assert.deepEqual(f.calls[0].options, { providers: [...scalar, ...(database ? [] : web)], dryRun: false, allowReadableConfig: true })
  }
})

test('explicit missing JSON never falls back; automatic absence permits only the legacy Facebook importer', async () => {
  const explicit = coordinator({ inspect: async () => { throw missing() } })
  await assert.rejects(migrateNightAllDeployCredentials({ ...environment, NIGHT_ALL_CONFIG_PATH: '/synthetic/wrong.json' }, explicit.options), /config_unavailable/)
  assert.deepEqual(explicit.calls, [])
  const automatic = coordinator({ inspect: async () => { throw missing() } })
  const result = await migrateNightAllDeployCredentials(environment, automatic.options)
  assert.equal(result.configMissing, true)
  assert.deepEqual(automatic.calls.map(row => row.source), ['legacy'])
  assert.equal(result.providers[0].source, 'legacy-facebook')
})

test('discovery and inspection errors never permit legacy fallback', async () => {
  for (const operation of ['discoverConfig', 'inspect']) {
    const f = coordinator({ [operation]: async () => { throw Object.assign(new Error('synthetic-source-secret'), { code: 'EACCES' }) } })
    await assert.rejects(migrateNightAllDeployCredentials(environment, f.options), error => {
      assert.equal(error.message, 'night_all_deploy_config_unavailable')
      return true
    })
    assert.deepEqual(f.calls, [])
  }
})

test('JSON parse/read failures and unknown writes never retry through another source', async () => {
  for (const status of ['source_invalid', 'source_unavailable', 'write_unknown', 'write_unconfirmed', 'conflict']) {
    let attempts = 0
    const f = coordinator({ migrateJson: async () => { attempts++; return { complete: false, providers: [{ provider: 'rapidapi', status }] } } })
    const result = await migrateNightAllDeployCredentials(environment, f.options)
    assert.equal(result.complete, false)
    assert.equal(result.providers[0].status, status)
    assert.equal(attempts, 1)
    assert.deepEqual(f.calls, [])
  }
  const f = coordinator({ migrateJson: async () => { throw new Error('source unavailable') } })
  await assert.rejects(migrateNightAllDeployCredentials(environment, f.options), /source unavailable/)
  assert.deepEqual(f.calls, [])
})

test('deployment coordinator rejects non-loopback Admin origins before any source access', async () => {
  for (const base of ['https://hub.example.test', 'http://192.0.2.1:18151', 'http://127.0.0.1:18151/path']) {
    const f = coordinator({ discoverConfig: async () => { assert.fail('source must not be inspected') } })
    await assert.rejects(migrateNightAllDeployCredentials({ ...environment, MX_INSIGHT_ADMIN_BASE_URL: base }, f.options), /loopback/)
  }
})

test('deploy uses the real owner-checked JSON reader and missing-only Admin writes without environment fallback', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'night-all-deploy-reader-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'config.json')
  const key = 'synthetic-rapidapi-credential'
  await writeFile(path, JSON.stringify({ crawlerProviders: { rapidapi: { apiKey: key } } }), { mode: 0o644 })
  const calls = []
  const fetchImpl = async (url, input) => {
    const provider = new URL(url).pathname.split('/')[5]
    calls.push({ provider, method: input.method })
    if (input.method === 'GET') return Response.json({ data: { provider: { key: provider }, credential: { source: 'environment', revision: 0, credentialConfigured: false } } })
    assert.equal(provider, 'rapidapi')
    assert.deepEqual(JSON.parse(input.body), { apiKey: key, expectedRevision: 0 })
    return Response.json({ data: { source: 'database', revision: 1, credentialConfigured: true } })
  }
  const result = await migrateNightAllDeployCredentials({ ...environment, NIGHT_ALL_CONFIG_PATH: path, RAPIDAPI_KEY: 'synthetic-env-not-selected' }, {
    migrateJson: (env, options) => migrateNightAllCredentials(env, { ...options, fetchImpl }),
    migrateFacebook: () => assert.fail('No fallback from an existing JSON file'),
  })
  assert.equal(result.providers.find(row => row.provider === 'rapidapi').status, 'migrated')
  assert.equal(calls.filter(row => row.method === 'PUT').length, 1)
  assert.equal(calls.filter(row => row.method === 'GET').length, 11)
  assert.ok(!JSON.stringify(result).includes(key))
})

test('existing unsafe source paths are rejected by the JSON reader without legacy fallback', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'night-all-deploy-unsafe-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const original = join(dir, 'original.json'), link = join(dir, 'link.json'), directory = join(dir, 'directory')
  await writeFile(original, '{}', { mode: 0o600 })
  await symlink(original, link)
  await mkdir(directory)
  await chmod(original, 0o666)
  for (const path of [original, link, directory]) {
    const result = await migrateNightAllDeployCredentials(environment, {
      discoverConfig: async () => path,
      migrateJson: (env, options) => migrateNightAllCredentials(env, { ...options, fetchImpl: async (_url, input) => {
        assert.equal(input.method, 'GET', 'Unsafe JSON must never produce a write')
        return Response.json({ data: { credential: { source: 'environment', revision: 0, credentialConfigured: false } } })
      } }),
      migrateFacebook: () => assert.fail('Unsafe existing JSON must never select another source'),
    })
    assert.equal(result.configMissing, false)
    assert.equal(result.complete, false)
    assert.ok(result.providers.every(row => row.status === 'source_unavailable'))
  }
})

async function runHooks(t, { database = '', jsonExit = 0, sqlExit = 0, hasToken = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'night-all-deploy-shell-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const configPath = join(dir, 'source with spaces', 'config.json')
  const result = spawnSync('bash', ['-c', `
    source "$1/scripts/manage.sh"
    need() { [ "$1" = node ] || [ "$1" = docker ]; }
    node() {
      [ "$MX_INSIGHT_ADMIN_TOKEN" = "$DEPLOY_TEST_TOKEN" ] || return 91
      [ "$MX_INSIGHT_ADMIN_BASE_URL" = http://127.0.0.1:18151 ] || return 92
      [ "$NIGHT_ALL_CONFIG_PATH" = "$DEPLOY_TEST_CONFIG" ] || return 93
      printf 'json\\n' >> "$DEPLOY_TEST_DIR/events"
      printf '%s\\0' "$@" >> "$DEPLOY_TEST_DIR/argv"
      return "$DEPLOY_TEST_JSON_EXIT"
    }
    docker() {
      [ "$MX_INSIGHT_ADMIN_BASE_URL" = http://127.0.0.1:18151 ] || return 94
      printf 'sql\\n' >> "$DEPLOY_TEST_DIR/events"
      printf '%s\\0' "$@" >> "$DEPLOY_TEST_DIR/argv"
      return "$DEPLOY_TEST_SQL_EXIT"
    }
    curl() { return 95; }
    kubectl() { return 96; }
    seed_default_price_books() { printf 'prices\\n' >> "$DEPLOY_TEST_DIR/events"; }
    ensure_night_all_supplier_credentials
    ensure_web_search_supplier_credentials
    seed_default_price_books
    printf 'deploy-continues\\n'
  `, '_', root], { encoding: 'utf8', timeout: 10000, env: {
    ...process.env, MX_INSIGHT_ADMIN_TOKEN: hasToken ? token : '', MX_INSIGHT_ADMIN_BASE_URL: 'https://ignored.example.test',
    NIGHT_ALL_CONFIG_PATH: configPath, NIGHT_ALL_DATABASE_URL: database,
    DEPLOY_TEST_DIR: dir, DEPLOY_TEST_CONFIG: configPath, DEPLOY_TEST_TOKEN: token,
    DEPLOY_TEST_JSON_EXIT: String(jsonExit), DEPLOY_TEST_SQL_EXIT: String(sqlExit),
  } })
  assert.equal(result.status, 0, result.stderr)
  const output = result.stdout + result.stderr
  for (const secret of [token, sourceUrl, configPath]) assert.ok(!output.includes(secret), 'No secret or source path in deployment output')
  assert.match(output, /deploy-continues/)
  const argv = await readFile(join(dir, 'argv'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  for (const secret of [token, sourceUrl, configPath]) assert.ok(!argv.includes(secret), 'Credentials and source path travel through environment only')
  return { output, argv: argv.split('\0').filter(Boolean), events: (await readFile(join(dir, 'events'), 'utf8')).trim().split('\n') }
}

test('actual shell hooks choose JSON only without SQL and never retry an optional JSON failure', async t => {
  const { output, argv, events } = await runHooks(t, { jsonExit: 1 })
  assert.deepEqual(events, ['json', 'prices'])
  assert.equal(argv.filter(arg => arg.endsWith('migrate-night-all-deploy-credentials.mjs')).length, 1)
  assert.match(output, /WARNING: Night-All supplier import incomplete/)
})

test('actual shell hooks run disjoint JSON then SQL then prices, with no retry after either failure', async t => {
  const { output, argv, events } = await runHooks(t, { database: sourceUrl, jsonExit: 1, sqlExit: 1 })
  assert.deepEqual(events, ['json', 'sql', 'prices'])
  assert.equal(argv.filter(arg => arg.endsWith('migrate-night-all-deploy-credentials.mjs')).length, 1)
  assert.equal(argv.filter(arg => arg.endsWith('migrate-web-search-credentials.mjs')).length, 1)
  assert.match(output, /WARNING: Night-All supplier import incomplete/)
  assert.match(output, /WARNING: Web Search credential import incomplete/)
})

test('actual shell hooks skip both credential imports without Admin Token', async t => {
  const { output, argv, events } = await runHooks(t, { database: sourceUrl, hasToken: false })
  assert.deepEqual(events, ['prices'])
  assert.deepEqual(argv, [])
  assert.doesNotMatch(output, /WARNING/)
})

test('deploy and apply each run the coordinator once after Admin readiness and before existing SQL and prices', async () => {
  const source = await readFile(join(root, 'scripts/manage.sh'), 'utf8')
  for (const action of ['deploy', 'apply']) {
    const branch = source.match(new RegExp(`^    ${action}\\)\\n([\\s\\S]*?)^      ;;`, 'm'))?.[1]
    assert.ok(branch)
    assert.match(branch, /k8s_smoke\s+ensure_default_api_key\s+ensure_night_all_supplier_credentials\s+ensure_web_search_supplier_credentials\s+seed_default_price_books/)
    assert.equal(branch.match(/ensure_night_all_supplier_credentials/g)?.length, 1)
    assert.doesNotMatch(branch, /ensure_facebook_supplier_credentials|migrate-facebook/)
  }
})

test('direct CLI with an explicit missing source prints only a safe error and never tries fallback', t => {
  const path = join(tmpdir(), `nonexistent-night-all-synthetic-source-secret-${process.pid}`, 'config.json')
  const result = spawnSync(process.execPath, [join(root, 'scripts/migrate-night-all-deploy-credentials.mjs')], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, ...environment, NIGHT_ALL_CONFIG_PATH: path, RAPIDAPI_KEY: 'synthetic-env-credential' },
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Check NIGHT_ALL_CONFIG_PATH/)
  assert.match(result.stderr, /No automatic retry or source fallback/)
  assert.doesNotMatch(result.stderr, /synthetic-/)
})
