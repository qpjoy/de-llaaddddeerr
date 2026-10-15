import assert from 'node:assert/strict'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { MultiExternalPlatformAdminService } from '../../server/external-platforms/admin.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { createWebSearchRuntime } from '../../server/web-search/runtime.mjs'
import {
  formatWebSearchMigrationResults, migrateWebSearchCredentials, migrationArguments,
  normalizeWebSearchAdminBase, readNightAllWebSearchCredentials, readNightAllDatabaseWebSearchCredentials,
  normalizeNightAllWebSearchBindings,
} from '../../scripts/migrate-web-search-credentials.mjs'

const ADMIN_TOKEN = 'synthetic-admin-secret-at-least-32-bytes'
const PEPPER = 'synthetic-web-search-credential-migration-pepper'
const secret = provider => `synthetic-${provider}-secret-never-log`
const entries = providers => Object.fromEntries(providers.map(provider => [provider, { apiKey: secret(provider), enabled: true }]))
const env = path => ({ NIGHT_ALL_CONFIG_PATH: path, MX_INSIGHT_ADMIN_TOKEN: ADMIN_TOKEN })
const emptyCredential = { revision: 0, source: 'environment', credentialConfigured: false }
const metadata = credential => Response.json({ data: { credential } })
const noSecrets = value => assert.doesNotMatch(typeof value === 'string' ? value : JSON.stringify(value), /synthetic-[a-z]+-secret|synthetic-admin-secret/)
const migrateJsonCredentials = (environment, options) => migrateWebSearchCredentials(environment, { source: 'json', ...options })

async function fixture(t, searchApis = entries(['exa', 'tavily', 'serper', 'you', 'searchapi', 'firecrawl']), mode = 0o600) {
  const directory = await mkdtemp(join(tmpdir(), 'mx-web-search-migration-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'config.json')
  await writeFile(path, JSON.stringify({ searchApis }), { mode })
  await chmod(path, mode)
  return { directory, path }
}

async function hub(t) {
  const store = new MemoryStore(), controls = new MemoryExternalPlatformControlStore()
  const service = new HubService({ store, apiKeyPepper: PEPPER, adapter: { search() { throw Error('No Night-All execution permitted') } } })
  const runtime = createWebSearchRuntime({ pool: null, store, controls, config: { apiKeyPepper: PEPPER, listenerMode: 'admin', reservationLeaseMs: 150000 } })
  const admin = new MultiExternalPlatformAdminService(runtime.admins)
  const server = createServer(createApp({ service, store, externalPlatformAdmin: admin, adminToken: ADMIN_TOKEN, logger: { error() {} } }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return { admin, runtime, store, base: `http://127.0.0.1:${server.address().port}` }
}

test('CLI requires an explicit provider list and dry-run/apply mode; source selection stays explicit', () => {
  assert.deepEqual(migrationArguments(['--providers', 'exa,tavily', '--dry-run']), { providers: ['exa', 'tavily'], dryRun: true, source: 'database', allowReadableConfig: false })
  assert.deepEqual(migrationArguments(['--source', 'json', '--apply', '--providers', 'baidu', '--allow-readable-config']), { providers: ['baidu'], dryRun: false, source: 'json', allowReadableConfig: true })
  for (const args of [[], ['--all'], ['--providers', 'exa'], ['--dry-run'], ['--providers', 'exa,exa', '--apply'], ['--providers', '../secret', '--apply'], ['--providers', 'exa', '--apply', '--dry-run'], ['--providers', 'exa', '--apply', '--allow-readable-config'], ['--providers', 'exa', '--apply', '--source', 'auto'], ['--providers', 'exa', '--apply', '--source']]) {
    assert.throws(() => migrationArguments(args), /^Error: web_search_migration_/)
  }
})

test('Admin origin permits HTTPS or loopback HTTP and rejects credential/path/redirect destinations', async () => {
  assert.equal(normalizeWebSearchAdminBase(), 'http://127.0.0.1:18151')
  assert.equal(normalizeWebSearchAdminBase('https://hub.minsight-ai.com/'), 'https://hub.minsight-ai.com')
  assert.equal(normalizeWebSearchAdminBase('http://[::1]:18151'), 'http://[::1]:18151')
  for (const origin of ['http://hub.minsight-ai.com', 'file:///tmp', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com?token=secret', 'https://example.com#secret']) {
    assert.throws(() => normalizeWebSearchAdminBase(origin), /^Error: web_search_migration_/)
  }
  let calls = 0
  await assert.rejects(migrateJsonCredentials({ ...env('/unread'), MX_INSIGHT_ADMIN_BASE_URL: 'http://public.invalid' }, {
    providers: ['exa'], fetchImpl: async () => { calls++ },
  }), /secure_admin_origin_required/)
  assert.equal(calls, 0)
})

test('reader uses selected JSON fields only, reports historical enabled flags, and validates the encrypted bundle contract', async t => {
  const f = await fixture(t, { ...entries(['exa']), tavily: { apiKey: 'bad\nkey', enabled: true }, you: { apiKey: 123, enabled: true },
    serper: { apiKey: secret('serper'), enabled: false }, firecrawl: { apiKey: 'x'.repeat(1025), enabled: true }, serpapi: { apiKey: '', enabled: false }, searchapi: { apiKey: secret('searchapi') } })
  const providers = ['exa', 'tavily', 'you', 'serper', 'firecrawl', 'serpapi', 'baidu', 'searchapi']
  const result = await readNightAllWebSearchCredentials(f.path, { providers, allowReadableConfig: true })
  assert.deepEqual(result.exa, { status: 'available', sourceEnabled: true, credentials: { apiKey: secret('exa') } })
  assert.equal(result.serper.sourceEnabled, false, 'Historical source enabled does not mutate Hub operation state')
  assert.equal(result.serper.status, 'source_disabled')
  for (const provider of ['tavily', 'you', 'firecrawl']) assert.equal(result[provider].status, 'source_invalid')
  assert.deepEqual(result.serpapi, { status: 'source_disabled', sourceEnabled: false })
  assert.deepEqual(result.baidu, { status: 'source_missing', sourceEnabled: null })
  assert.deepEqual(result.searchapi, { status: 'source_enabled_unknown', sourceEnabled: null })
})

test('safe source reader rejects symlinks/shared writes/malformed code and never modifies the source', async t => {
  const f = await fixture(t, undefined, 0o644), before = await readFile(f.path), beforeStat = await stat(f.path)
  await readNightAllWebSearchCredentials(f.path, { providers: ['exa'], allowReadableConfig: true })
  assert.deepEqual(await readFile(f.path), before)
  assert.equal((await stat(f.path)).mtimeMs, beforeStat.mtimeMs)
  await assert.rejects(readNightAllWebSearchCredentials(f.path, { providers: ['exa'] }), /source_unavailable/)
  const link = join(f.directory, 'link.json'); await symlink(f.path, link)
  await assert.rejects(readNightAllWebSearchCredentials(link, { providers: ['exa'], allowReadableConfig: true }), /source_unavailable/)
  await chmod(f.path, 0o666)
  await assert.rejects(readNightAllWebSearchCredentials(f.path, { providers: ['exa'], allowReadableConfig: true }), /source_unavailable/)
  await chmod(f.path, 0o600)
  await writeFile(f.path, `globalThis.migrationCodeExecuted = '${secret('exa')}'`)
  await assert.rejects(readNightAllWebSearchCredentials(f.path, { providers: ['exa'] }), error => {
    noSecrets(error.message); return error.message === 'web_search_migration_source_unavailable'
  })
  assert.equal(globalThis.migrationCodeExecuted, undefined)
})

test('dry-run makes no writes; apply uses real encrypted credential API without search, policies, grants or secret output', async t => {
  const f = await fixture(t), h = await hub(t), environment = { ...env(f.path), MX_INSIGHT_ADMIN_BASE_URL: h.base }
  const operationsBefore = (await h.admin.detail('exa', '24h')).operations
  const calls = []
  const fetchImpl = (url, init) => {
    assert.equal(new URL(url).origin, h.base)
    assert.match(new URL(url).pathname, /^\/internal\/v1\/admin\/external-platforms\/(exa|tavily)(\/credential)?$/)
    assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store')
    assert.equal(init.headers['x-mx-insight-admin-token'], ADMIN_TOKEN)
    calls.push(init.method)
    return fetch(url, init)
  }
  const options = { providers: ['exa', 'tavily'], fetchImpl }
  const preview = await migrateJsonCredentials(environment, options)
  assert.equal(preview.complete, true); assert.deepEqual(calls, ['GET', 'GET'])
  assert(preview.providers.every(row => row.status === 'would_migrate' && row.sourceEnabled === true))
  const applied = await migrateJsonCredentials(environment, { ...options, dryRun: false })
  assert(applied.providers.every(row => row.status === 'migrated' && row.revision === 1))
  assert.deepEqual(await h.admin.revealCredential('exa'), { credentials: { apiKey: secret('exa') } })
  const persisted = await h.runtime.gateways.get('exa').credentialStore.storage.readCredential('exa')
  assert.match(persisted, /^bundle1\./); assert(!persisted.includes(secret('exa')))
  const repeated = await migrateJsonCredentials(environment, { ...options, dryRun: false, readCredentials() { throw Error('Preserved keys must not read source') } })
  assert(repeated.providers.every(row => row.status === 'preserved'))
  assert.deepEqual(calls, ['GET', 'GET', 'GET', 'PUT', 'GET', 'PUT', 'GET', 'GET'])
  const persistedPolicy = operations => operations.map(({ blockers, ...policy }) => policy)
  assert.deepEqual(persistedPolicy((await h.admin.detail('exa', '24h')).operations), persistedPolicy(operationsBefore))
  assert.equal(h.store.apiKeys.size, 0); assert.equal(h.store.consumers.size, 0)
  noSecrets(preview); noSecrets(applied); noSecrets(formatWebSearchMigrationResults(applied))
})

test('existing environment credentials, DB credentials and manual clears are preserved without source reads', async () => {
  const states = [
    { ...emptyCredential, credentialConfigured: true },
    { revision: 4, source: 'database', credentialConfigured: true },
    { revision: 2, source: 'database', credentialConfigured: false },
  ]
  const methods = []
  const result = await migrateJsonCredentials(env('/must-not-read'), { providers: ['exa', 'tavily', 'serper'], dryRun: false,
    fetchImpl: async (_, input) => { methods.push(input.method); return metadata(states.shift()) },
    readCredentials() { assert.fail('Preserved credentials must not read local secrets') },
  })
  assert.equal(result.complete, true); assert(result.providers.every(row => row.status === 'preserved'))
  assert.deepEqual(methods, ['GET', 'GET', 'GET'])
})

test('revision CAS preserves a concurrent real Admin edit and never retries it', async t => {
  const f = await fixture(t), h = await hub(t)
  let writes = 0
  const result = await migrateJsonCredentials({ ...env(f.path), MX_INSIGHT_ADMIN_BASE_URL: h.base }, { providers: ['exa'], dryRun: false,
    fetchImpl: async (url, input) => {
      if (input.method === 'PUT') {
        writes++
        await h.admin.updateCredential('exa', { credentials: { apiKey: 'concurrent-admin-key' }, expectedRevision: 0 })
      }
      return fetch(url, input)
    },
  })
  assert.equal(result.providers[0].status, 'conflict'); assert.equal(result.providers[0].httpStatus, 409)
  assert.equal(result.complete, false); assert.equal(writes, 1)
  assert.deepEqual(await h.admin.revealCredential('exa'), { credentials: { apiKey: 'concurrent-admin-key' } })
})

test('partial errors and unknown writes recover on rerun by reading saved state without repeating committed writes', async t => {
  const f = await fixture(t), h = await hub(t), environment = { ...env(f.path), MX_INSIGHT_ADMIN_BASE_URL: h.base }
  const writes = [], providers = ['exa', 'tavily', 'serper']
  let firstRun = true
  const fetchImpl = async (url, input) => {
    const provider = new URL(url).pathname.split('/')[5]
    if (input.method === 'PUT') {
      writes.push(provider)
      if (firstRun && provider === 'tavily') return Response.json({ message: `${secret('tavily')} ${ADMIN_TOKEN}` }, { status: 503 })
      const response = await fetch(url, input)
      if (firstRun && provider === 'exa') throw Error(`Lost response with ${secret('exa')} ${ADMIN_TOKEN}`)
      return response
    }
    return fetch(url, input)
  }
  const initial = await migrateJsonCredentials(environment, { providers, dryRun: false, fetchImpl })
  assert.deepEqual(initial.providers.map(row => row.status), ['write_unknown', 'write_unknown', 'migrated'])
  assert.equal(initial.complete, false); noSecrets(initial); noSecrets(formatWebSearchMigrationResults(initial))
  firstRun = false
  const resumed = await migrateJsonCredentials(environment, { providers, dryRun: false, fetchImpl })
  assert.deepEqual(resumed.providers.map(row => row.status), ['preserved', 'migrated', 'preserved'])
  assert.deepEqual(writes, ['exa', 'tavily', 'serper', 'tavily'])
  assert.equal(resumed.complete, true)
})

test('bad target metadata/source/acknowledgement are reported safely and never treated as successful migration', async t => {
  const f = await fixture(t)
  for (const credential of [{ revision: 0 }, { ...emptyCredential, revision: -1 }, { ...emptyCredential, source: 'unknown' }]) {
    const result = await migrateJsonCredentials(env(f.path), { providers: ['exa'], dryRun: false, fetchImpl: async () => metadata(credential) })
    assert.equal(result.providers[0].status, 'target_invalid')
  }
  const missing = await migrateJsonCredentials(env(f.path), { providers: ['baidu'], fetchImpl: async () => metadata(emptyCredential) })
  assert.equal(missing.providers[0].status, 'source_missing')
  assert.equal(missing.complete, true, 'A provider absent from the selected source is a safe skip')
  const invalid = await migrateJsonCredentials(env(f.path), { providers: ['exa'], fetchImpl: async () => metadata(emptyCredential),
    readCredentials() { throw Error(`${secret('exa')} ${ADMIN_TOKEN}`) },
  })
  assert.equal(invalid.providers[0].status, 'source_unavailable'); noSecrets(invalid)
  const unconfirmed = await migrateJsonCredentials(env(f.path), { providers: ['exa'], dryRun: false,
    fetchImpl: async (_, input) => input.method === 'GET' ? metadata(emptyCredential) : Response.json({ data: { revision: 99, apiKey: secret('exa') } }),
  })
  assert.equal(unconfirmed.providers[0].status, 'write_unconfirmed'); noSecrets(unconfirmed)
  let attempts = 0
  const rejected = await migrateJsonCredentials(env(f.path), { providers: ['exa'], dryRun: false,
    fetchImpl: async (_, input) => {
      if (input.method === 'GET') return metadata(emptyCredential)
      attempts++
      return Response.json({ error: secret('exa') }, { status: 403 })
    },
  })
  assert.equal(rejected.providers[0].status, 'write_rejected'); assert.equal(attempts, 1); noSecrets(rejected)
})

test('readable JSON requires the explicit flag and disabled/unknown source entries never write', async t => {
  const f = await fixture(t, { ...entries(['exa']), serpapi: { enabled: false, apiKey: secret('serpapi') }, you: { apiKey: secret('you') } }, 0o644)
  const calls = []
  const fetchImpl = async (_, input) => { calls.push(input.method); return metadata(emptyCredential) }
  const denied = await migrateJsonCredentials(env(f.path), { providers: ['exa'], fetchImpl })
  assert.equal(denied.providers[0].status, 'source_unavailable'); assert.equal(denied.complete, false)
  const allowed = await migrateJsonCredentials(env(f.path), { providers: ['exa', 'serpapi', 'you'], allowReadableConfig: true, fetchImpl })
  assert.deepEqual(allowed.providers.map(row => row.status), ['would_migrate', 'source_disabled', 'source_enabled_unknown'])
  assert.equal(allowed.complete, true); assert(calls.every(method => method === 'GET'))
})

test('CLI error output never echoes malformed provider values, token or source path', async () => {
  const script = new URL('../../scripts/migrate-web-search-credentials.mjs', import.meta.url)
  const result = await promisify(execFile)(process.execPath, [script.pathname, '--providers', secret('exa'), '--apply'], {
    env: { ...process.env, ...env(`/private/${secret('you')}`) },
  }).then(() => assert.fail('Invalid arguments should fail'), error => error)
  assert.equal(result.code, 1); noSecrets(result.stdout); noSecrets(result.stderr)
  assert.match(result.stderr, /No automatic retry/)
})

function sourceDatabase(rows, queryFailure = false) {
  const calls = []
  let configuration
  return {
    calls,
    configuration: () => configuration,
    clientFactory: options => {
      configuration = options
      return {
        async connect() { calls.push('connect') },
        async end() { calls.push('end') },
        async query(sql, parameters) {
          calls.push({ sql, parameters })
          if (parameters && queryFailure) throw Error(`${secret('exa')} ${ADMIN_TOKEN}`)
          return { rows: parameters ? rows : [] }
        },
      }
    },
  }
}

test('database source uses only the dedicated URL and a bounded read-only parameterized SQL query', async () => {
  const databaseUrl = 'postgresql://migration:synthetic-db-secret@localhost/night_all'
  const db = sourceDatabase([
    { hub_provider: 'exa', module_code: 'exa', secret: secret('exa'), base_url: 'https://api.exa.ai', host: '' },
    { hub_provider: 'tavily', module_code: null, secret: null },
  ])
  const result = await readNightAllDatabaseWebSearchCredentials(databaseUrl, { providers: ['exa', 'tavily'], clientFactory: db.clientFactory })
  assert.deepEqual(result.exa, { status: 'available', sourceEnabled: true, credentials: { apiKey: secret('exa') } })
  assert.deepEqual(result.tavily, { status: 'source_missing', sourceEnabled: null })
  assert.equal(db.configuration().connectionString, databaseUrl)
  assert(db.configuration().query_timeout > db.configuration().statement_timeout)
  assert.equal(db.calls[0], 'connect'); assert.equal(db.calls.at(-1), 'end')
  assert.equal(db.calls[1].sql, 'BEGIN READ ONLY'); assert.equal(db.calls[3].sql, 'COMMIT')
  const selected = db.calls[2]
  assert.deepEqual(selected.parameters, [['exa', 'tavily'], '[]'])
  assert.match(selected.sql, /unnest\(\$1::text\[\]\)/)
  assert.match(selected.sql, /m\.active = true and c\.status = 'active'/)
  assert.match(selected.sql, /public\.credential_modules/); assert.match(selected.sql, /public\.provider_credentials/)
  assert.match(selected.sql, /limit 1/i)
  assert.doesNotMatch(selected.sql.replace(/--.*$/gm, ''), /\b(insert|update|delete|alter|create|drop|secret_last_four|secret_fingerprint)\b/i)
})

test('database secret validation rejects incompatible endpoints and malformed values without rewriting them', async () => {
  const db = sourceDatabase([
    { hub_provider: 'exa', module_code: 'exa', secret: secret('exa'), base_url: 'https://private-gateway.invalid/search' },
    { hub_provider: 'tavily', module_code: 'tavily', secret: secret('tavily'), host: 'other.invalid' },
    { hub_provider: 'serper', module_code: 'serper', secret: 'bad\nkey' },
    { hub_provider: 'you', module_code: 'you', secret: secret('you'), base_url: 'https://user:password@ydc-index.io' },
    { hub_provider: 'searchapi', module_code: 'searchapi', secret: secret('searchapi'), host: 'www.searchapi.io' },
  ])
  const result = await readNightAllDatabaseWebSearchCredentials('postgres://localhost/night_all', {
    providers: ['exa', 'tavily', 'serper', 'you', 'searchapi'], clientFactory: db.clientFactory,
  })
  for (const key of ['exa', 'tavily', 'you']) assert.equal(result[key].status, 'source_endpoint_mismatch')
  assert.equal(result.serper.status, 'source_invalid')
  assert.equal(result.searchapi.status, 'available')
})

test('source database failures close the connection and never echo the URL, secret or query failure', async () => {
  const db = sourceDatabase([], true)
  await assert.rejects(readNightAllDatabaseWebSearchCredentials('postgres://localhost/night_all', {
    providers: ['exa'], clientFactory: db.clientFactory,
  }), error => { noSecrets(error.message); return error.message === 'web_search_migration_source_unavailable' })
  assert.equal(db.calls.at(-1), 'end')
  assert.equal(db.calls.filter(call => call?.sql === 'COMMIT').length, 0)
  for (const url of ['', undefined, 'https://synthetic-exa-secret.invalid', 'postgres://localhost/', 'postgres://localhost/night_all#secret']) {
    await assert.rejects(readNightAllDatabaseWebSearchCredentials(url, { providers: ['exa'], clientFactory() { assert.fail('Invalid URL must not connect') } }), /source_database_required/)
  }
})

test('default migration reads SQL once, writes encrypted Hub credentials and preserves manual edits on rerun', async t => {
  const h = await hub(t), db = sourceDatabase([
    { hub_provider: 'exa', module_code: 'exa', secret: secret('exa') },
    { hub_provider: 'tavily', module_code: 'tavily', secret: secret('tavily') },
  ])
  const environment = { MX_INSIGHT_ADMIN_TOKEN: ADMIN_TOKEN, MX_INSIGHT_ADMIN_BASE_URL: h.base, NIGHT_ALL_DATABASE_URL: 'postgres://localhost/night_all' }
  let reads = 0
  const options = {
    providers: ['exa', 'tavily'], dryRun: false,
    readCredentials() { assert.fail('Database mode must never read JSON') },
    readDatabaseCredentials: (url, options) => { reads++; return readNightAllDatabaseWebSearchCredentials(url, { ...options, clientFactory: db.clientFactory }) },
  }
  const applied = await migrateWebSearchCredentials(environment, options)
  assert.equal(reads, 1); assert.equal(applied.source, 'night-all-database'); assert.equal(applied.complete, true)
  assert.deepEqual(applied.providers.map(row => row.status), ['migrated', 'migrated'])
  assert.deepEqual(await h.admin.revealCredential('exa'), { credentials: { apiKey: secret('exa') } })
  assert.match(await h.runtime.gateways.get('exa').credentialStore.storage.readCredential('exa'), /^bundle1\./)
  await h.admin.updateCredential('tavily', { credentials: { apiKey: 'manually-rotated-tavily-key' }, expectedRevision: 1 })
  const repeated = await migrateWebSearchCredentials(environment, options)
  assert.equal(reads, 1); assert.deepEqual(repeated.providers.map(row => row.status), ['preserved', 'preserved'])
  assert.deepEqual(await h.admin.revealCredential('tavily'), { credentials: { apiKey: 'manually-rotated-tavily-key' } })
  noSecrets(applied); noSecrets(repeated); noSecrets(formatWebSearchMigrationResults(applied))
})

test('database source never falls back to Hub DATABASE_URL or JSON when absent or unavailable', async () => {
  const methods = []
  const environment = { ...env('/should-not-read'), DATABASE_URL: 'postgres://localhost/hub' }
  const options = {
    providers: ['exa'], dryRun: false,
    fetchImpl: async (_, input) => { methods.push(input.method); return metadata(emptyCredential) },
    readCredentials() { assert.fail('No implicit JSON fallback') },
  }
  const missing = await migrateWebSearchCredentials(environment, options)
  assert.equal(missing.providers[0].status, 'source_unavailable'); assert.equal(missing.complete, false)
  const failed = await migrateWebSearchCredentials({ ...environment, NIGHT_ALL_DATABASE_URL: 'postgres://localhost/night_all' }, {
    ...options, readDatabaseCredentials() { throw Error(secret('exa')) },
  })
  assert.equal(failed.providers[0].status, 'source_unavailable'); assert.equal(failed.complete, false)
  assert.deepEqual(methods, ['GET', 'GET']); noSecrets(failed)
})

test('explicit Night-All SQL bindings preserve provider/module defaults and never interpolate identifiers', async () => {
  const bindings = JSON.stringify({ exa: { credentialProvider: 'shared' }, tavily: { credentialModule: 'tavily-search' }, you: { credentialProvider: 'you-team', credentialModule: 'you-search' } })
  const expected = [
    { hub_provider: 'exa', credential_provider: 'shared', module_code: 'shared' },
    { hub_provider: 'tavily', credential_provider: 'tavily', module_code: 'tavily-search' },
    { hub_provider: 'you', credential_provider: 'you-team', module_code: 'you-search' },
  ]
  assert.deepEqual(normalizeNightAllWebSearchBindings(bindings, ['exa', 'tavily', 'you']), expected)
  const db = sourceDatabase([])
  await readNightAllDatabaseWebSearchCredentials('postgres://localhost/night_all', {
    providers: ['exa', 'tavily', 'you'], bindings, clientFactory: db.clientFactory,
  })
  assert.deepEqual(db.calls[2].parameters, [['exa', 'tavily', 'you'], JSON.stringify(expected)])
  assert.doesNotMatch(db.calls[2].sql, /you-team|tavily-search/)
  assert.match(db.calls[2].sql, /binding\.credential_provider is not null[\s\S]*c\.provider = binding\.credential_provider and m\.module_code = binding\.module_code/)
  assert.match(db.calls[2].sql, /binding\.credential_provider is null/)
})

test('malformed or unselected SQL mappings fail before any source or Hub access', async () => {
  for (const binding of ['not JSON', '[]', 'null', '{"exa":{}}', '{"tavily":{"credentialProvider":"tavily"}}', '{"exa":{"apiKey":"synthetic-exa-secret"}}', '{"exa":{"credentialModule":"../private"}}', JSON.stringify({ exa: { credentialProvider: 'a'.repeat(101) } })]) {
    await assert.rejects(migrateWebSearchCredentials({ MX_INSIGHT_ADMIN_TOKEN: ADMIN_TOKEN, NIGHT_ALL_WEB_SEARCH_BINDINGS: binding }, {
      providers: ['exa'], fetchImpl() { assert.fail('Invalid binding must fail before Hub access') },
      readDatabaseCredentials() { assert.fail('Invalid binding must fail before SQL access') },
    }), error => { noSecrets(error.message); return error.message === 'web_search_migration_source_bindings_invalid' })
  }
})

test('a dependency-free checkout can load CLI validation and the explicit JSON source', async t => {
  const f = await fixture(t)
  const files = ['scripts/migrate-web-search-credentials.mjs', 'scripts/migrate-tikhub-credential.mjs',
    'scripts/migrate-facebook-credentials.mjs', 'scripts/sql/night-all-web-search-credentials.sql',
    'shared/web-search.mjs', 'server/web-search/providers.mjs']
  for (const file of files) {
    const target = join(f.directory, file)
    await mkdir(join(target, '..'), { recursive: true })
    await copyFile(new URL(`../../${file}`, import.meta.url), target)
  }
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import { pathToFileURL } from 'node:url'
    const importer = await import(pathToFileURL(process.argv[1]))
    if (importer.migrationArguments(['--providers', 'exa', '--dry-run']).source !== 'database') throw Error('default source')
    const json = await importer.readNightAllWebSearchCredentials(process.argv[2], { providers: ['exa'] })
    process.stdout.write(json.exa.status)
  `, join(f.directory, files[0]), f.path], { cwd: f.directory, env: { PATH: process.env.PATH } })
  assert.equal(stdout, 'available'); assert.equal(stderr, '')
})
