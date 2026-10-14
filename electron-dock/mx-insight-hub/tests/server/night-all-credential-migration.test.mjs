import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { WEB_SEARCH_PROVIDERS } from '../../shared/web-search.mjs'
import { MemoryExternalPlatformCredentialStore } from '../../server/external-platforms/credentials-store.mjs'
import { StructuredExternalPlatformCredentialStore } from '../../server/external-platforms/structured-credentials.mjs'
import { formatMigrationResults, migrateNightAllCredentials, migrationArguments, readNightAllJsonCredentials } from '../../scripts/migrate-night-all-credentials.mjs'

const ADMIN = 'synthetic-admin-secret-at-least-32-bytes'
const secret = provider => `synthetic-${provider}-secret-never-log`
const scalar = ['rapidapi', 'tikhub', 'justone']
const web = WEB_SEARCH_PROVIDERS.map(({ key }) => key)
const providers = [...scalar, ...web]
const empty = { source: 'environment', revision: 0, credentialConfigured: false }
const metadata = (credential, provider) => Response.json({ data: { credential, ...(provider ? { provider: { key: provider } } : {}) } })
const env = path => ({ NIGHT_ALL_CONFIG_PATH: path, MX_INSIGHT_ADMIN_TOKEN: ADMIN })
const noSecrets = value => assert.doesNotMatch(typeof value === 'string' ? value : JSON.stringify(value), /synthetic-[a-z]+-secret/)
const config = () => ({
  crawlerProviders: Object.fromEntries(scalar.map(provider => [provider === 'justone' ? 'justOne' : provider, { apiKey: secret(provider), enabled: true }])),
  searchApis: Object.fromEntries(web.map(provider => [provider, { apiKey: secret(provider), enabled: true }])),
})

async function fixture(t, value = config(), mode = 0o600) {
  const directory = await mkdtemp(join(tmpdir(), 'mx-night-all-credential-import-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'config.json')
  await writeFile(path, JSON.stringify(value), { mode })
  await chmod(path, mode)
  return { directory, path }
}

function hub() {
  const calls = []
  const stores = new Map(providers.map(provider => [provider, scalar.includes(provider)
    ? new MemoryExternalPlatformCredentialStore({ providerKey: provider })
    : new StructuredExternalPlatformCredentialStore({ providerKey: provider,
      fields: [{ name: 'apiKey', label: 'API Key' }], pepper: 'synthetic-import-encryption-pepper' })]))
  const fetchImpl = async (url, input) => {
    const parsed = new URL(url)
    const match = parsed.pathname.match(/^\/internal\/v1\/admin\/external-platforms\/([a-z]+)(\/credential)?$/)
    assert.ok(match, 'Only credential metadata/save routes may be called')
    const provider = match[1], store = stores.get(provider)
    assert.ok(store)
    assert.equal(input.headers['x-mx-insight-admin-token'], ADMIN)
    assert.equal(input.redirect, 'error')
    assert.equal(input.cache, 'no-store')
    assert.ok(input.signal instanceof AbortSignal)
    calls.push({ provider, method: input.method })
    if (input.method === 'GET') {
      assert.equal(match[2], undefined)
      return metadata(await store.describeCredential(provider), provider)
    }
    assert.equal(input.method, 'PUT')
    assert.equal(match[2], '/credential')
    try { return Response.json({ data: await store.updateCredential(provider, JSON.parse(input.body)) }) }
    catch (error) { return Response.json({ error: { code: error.code } }, { status: error.status }) }
  }
  return { calls, stores, fetchImpl }
}

test('JSON missing-only CLI requires explicit known providers and exactly one mode', () => {
  assert.deepEqual(migrationArguments(['--providers', 'rapidapi,exa', '--dry-run']),
    { providers: ['rapidapi', 'exa'], dryRun: true, allowReadableConfig: false })
  assert.deepEqual(migrationArguments(['--apply', '--providers', providers.join(','), '--allow-readable-config']),
    { providers, dryRun: false, allowReadableConfig: true })
  for (const args of [[], ['--all', '--apply'], ['--providers', 'rapidapi'], ['--apply'],
    ['--providers', 'rapidapi,rapidapi', '--apply'], ['--providers', 'qixin', '--apply'],
    ['--providers', 'rapidapi,', '--apply'], ['--providers', secret('unknown'), '--apply'],
    ['--providers', 'rapidapi', '--apply', '--dry-run'], ['--providers', 'rapidapi', '--apply', '--source', 'database'],
    ['--providers', 'rapidapi', '--apply', '--allow-readable-config', '--allow-readable-config']]) {
    assert.throws(() => migrationArguments(args), error => { noSecrets(error.message); return true })
  }
})

test('selected config JSON supplies three scalar and eight structured credentials with the existing field contracts', async t => {
  const f = await fixture(t)
  const result = await readNightAllJsonCredentials(f.path, { providers })
  for (const provider of providers) {
    assert.equal(result[provider].status, 'available')
    assert.equal(result[provider].sourceEnabled, true)
    if (scalar.includes(provider)) assert.equal(result[provider].apiKey, secret(provider))
    else assert.deepEqual(result[provider].credentials, { apiKey: secret(provider) })
  }
})

test('RapidAPI never falls back to environment keys or adjacent legacy news config', async t => {
  const f = await fixture(t, {})
  await mkdir(join(f.directory, 'data'))
  await writeFile(join(f.directory, 'data', 'news-config.json'), JSON.stringify({ twitterDaily: { apiKey: secret('legacy') } }), { mode: 0o600 })
  const h = hub()
  const result = await migrateNightAllCredentials({ ...env(f.path), RAPIDAPI_KEY: secret('environment'),
    RAPID_API_KEY: secret('environment'), TWITTER_RAPIDAPI_KEY: secret('environment'),
    NIGHT_ALL_DATABASE_URL: 'postgres://unused.invalid/night_all' }, { providers: ['rapidapi'], dryRun: false, fetchImpl: h.fetchImpl })
  assert.equal(result.providers[0].status, 'source_missing')
  assert.deepEqual(h.calls, [{ provider: 'rapidapi', method: 'GET' }])
  noSecrets(result)
})

test('source remains unchanged; readable files need opt-in while symlinks/shared writes stay forbidden', async t => {
  const f = await fixture(t, config(), 0o644), before = await readFile(f.path), beforeStat = await stat(f.path)
  await assert.rejects(readNightAllJsonCredentials(f.path, { providers }), /source_unavailable/)
  await readNightAllJsonCredentials(f.path, { providers, allowReadableConfig: true })
  assert.deepEqual(await readFile(f.path), before)
  assert.equal((await stat(f.path)).mtimeMs, beforeStat.mtimeMs)
  const link = join(f.directory, 'link.json')
  await symlink(f.path, link)
  await assert.rejects(readNightAllJsonCredentials(link, { providers, allowReadableConfig: true }), /source_unavailable/)
  await chmod(f.path, 0o666)
  await assert.rejects(readNightAllJsonCredentials(f.path, { providers, allowReadableConfig: true }), /source_unavailable/)
  await assert.rejects(readNightAllJsonCredentials(undefined, { providers }), /config_path_required/)
})

test('malformed JSON is data only and never executes or echoes source text', async t => {
  const f = await fixture(t)
  await writeFile(f.path, `globalThis.credentialImportExecuted = '${secret('source')}'`)
  await assert.rejects(readNightAllJsonCredentials(f.path, { providers }), error => { noSecrets(error.message); return true })
  assert.equal(globalThis.credentialImportExecuted, undefined)
  await writeFile(f.path, 'null')
  await assert.rejects(readNightAllJsonCredentials(f.path, { providers }), /source_invalid/)
})

test('source absence, invalid keys and Web Search enabled flags are reported without writes', async t => {
  const f = await fixture(t, { crawlerProviders: { rapidapi: { apiKey: 'bad\nkey' }, tikhub: { apiKey: '' }, justOne: { apiKey: 12 } },
    searchApis: { exa: { apiKey: secret('exa'), enabled: false }, tavily: { apiKey: secret('tavily') },
      serper: { apiKey: 'bad key', enabled: true } } })
  const h = hub()
  const selected = ['rapidapi', 'tikhub', 'justone', 'exa', 'tavily', 'serper', 'you']
  const result = await migrateNightAllCredentials(env(f.path), { providers: selected, dryRun: false, fetchImpl: h.fetchImpl })
  assert.deepEqual(result.providers.map(row => row.status),
    ['source_invalid', 'source_missing', 'source_invalid', 'source_disabled', 'source_enabled_unknown', 'source_invalid', 'source_missing'])
  assert.equal(result.complete, false)
  assert.ok(h.calls.every(call => call.method === 'GET'))
  noSecrets(result)
})

test('scalar keys are trimmed once and bounded to printable header-safe ASCII without truncation', async t => {
  const f = await fixture(t, { crawlerProviders: { rapidapi: { apiKey: ` ${'a'.repeat(4096)} ` },
    tikhub: { apiKey: 'b'.repeat(4097) }, justOne: { apiKey: '非ASCII密钥' } } })
  const result = await readNightAllJsonCredentials(f.path, { providers: scalar })
  assert.equal(result.rapidapi.apiKey, 'a'.repeat(4096))
  assert.equal(result.tikhub.status, 'source_invalid')
  assert.equal(result.justone.status, 'source_invalid')
  const store = new MemoryExternalPlatformCredentialStore({ providerKey: 'rapidapi' })
  assert.equal((await store.updateCredential('rapidapi', { apiKey: result.rapidapi.apiKey, expectedRevision: 0 })).credentialConfigured, true)
})

test('configured environment/database values and deliberate clears are preserved without opening the source', async () => {
  const states = [{ ...empty, credentialConfigured: true }, { source: 'database', revision: 2, credentialConfigured: true },
    { source: 'database', revision: 3, credentialConfigured: false }]
  const calls = []
  const result = await migrateNightAllCredentials(env('/must-not-read'), { providers: scalar, dryRun: false,
    fetchImpl: async (_, input) => { calls.push(input.method); return metadata(states.shift()) },
    readCredentials() { assert.fail('Preserved targets must not read source credentials') },
  })
  assert.deepEqual(result.providers.map(row => row.status), ['preserved', 'preserved', 'preserved'])
  assert.deepEqual(calls, ['GET', 'GET', 'GET'])
  assert.equal(result.complete, true)
})

test('target metadata must be complete and valid before it is treated as missing', async () => {
  for (const credential of [{ revision: 0 }, { ...empty, revision: -1 }, { ...empty, revision: '0' },
    { ...empty, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...empty, source: 'none' }, { ...empty, credentialConfigured: 'false' }]) {
    const result = await migrateNightAllCredentials(env('/must-not-read'), { providers: ['rapidapi'], dryRun: false,
      fetchImpl: async () => metadata(credential), readCredentials() { assert.fail('Invalid targets must not read secrets') } })
    assert.equal(result.providers[0].status, 'target_invalid')
    assert.equal(result.complete, false)
  }
  const mismatch = await migrateNightAllCredentials(env('/must-not-read'), { providers: ['rapidapi'],
    fetchImpl: async () => metadata(empty, 'tikhub'), readCredentials() { assert.fail('Wrong target must not read secrets') } })
  assert.equal(mismatch.providers[0].status, 'target_invalid')
})

test('dry-run checks every target before reading only missing source entries and never writes', async t => {
  const f = await fixture(t), h = hub()
  await h.stores.get('tikhub').updateCredential('tikhub', { apiKey: 'existing-manual-key', expectedRevision: 0 })
  let reads = 0
  const result = await migrateNightAllCredentials(env(f.path), { providers, dryRun: true, fetchImpl: h.fetchImpl,
    readCredentials: async (path, options) => {
      reads++
      assert.equal(h.calls.length, providers.length)
      assert.deepEqual(options.providers, providers.filter(provider => provider !== 'tikhub'))
      return readNightAllJsonCredentials(path, options)
    },
  })
  assert.equal(reads, 1)
  assert.ok(h.calls.every(call => call.method === 'GET'))
  assert.equal(result.providers.find(row => row.provider === 'tikhub').status, 'preserved')
  assert.ok(result.providers.filter(row => row.provider !== 'tikhub').every(row => row.status === 'would_migrate'))
  assert.equal(result.complete, true)
  noSecrets(result); noSecrets(formatMigrationResults(result))
})

test('apply writes original CAS credential stores only, verifies acknowledgements, and is idempotent', async t => {
  const f = await fixture(t), h = hub()
  const result = await migrateNightAllCredentials(env(f.path), { providers, dryRun: false, fetchImpl: h.fetchImpl })
  assert.ok(result.providers.every(row => row.status === 'migrated' && row.revision === 1))
  assert.equal(result.complete, true)
  assert.ok(h.calls.slice(0, providers.length).every(call => call.method === 'GET'))
  assert.ok(h.calls.slice(providers.length).every(call => call.method === 'PUT'))
  for (const provider of providers) {
    const store = h.stores.get(provider), saved = await store.readCredential(provider)
    assert.deepEqual(saved, scalar.includes(provider) ? secret(provider) : { apiKey: secret(provider) })
    if (!scalar.includes(provider)) assert.match(await store.storage.readCredential(provider), /^bundle1\./)
  }
  const rerun = await migrateNightAllCredentials(env('/must-not-read'), { providers, dryRun: false, fetchImpl: h.fetchImpl,
    readCredentials() { assert.fail('No source reads after successful migration') } })
  assert.ok(rerun.providers.every(row => row.status === 'preserved'))
  assert.equal(h.calls.filter(call => call.method === 'PUT').length, providers.length)
  noSecrets(result); noSecrets(formatMigrationResults(result)); noSecrets(rerun)
})

test('concurrent Admin rotation wins CAS without automatic retry', async t => {
  const f = await fixture(t), h = hub()
  let puts = 0
  const result = await migrateNightAllCredentials(env(f.path), { providers: ['rapidapi'], dryRun: false,
    fetchImpl: async (url, input) => {
      if (input.method === 'PUT') {
        puts++
        await h.stores.get('rapidapi').updateCredential('rapidapi', { apiKey: 'concurrent-admin-key', expectedRevision: 0 })
      }
      return h.fetchImpl(url, input)
    },
  })
  assert.equal(result.providers[0].status, 'conflict')
  assert.equal(result.providers[0].httpStatus, 409)
  assert.equal(puts, 1)
  assert.equal(await h.stores.get('rapidapi').readCredential('rapidapi'), 'concurrent-admin-key')
})

test('lost write response stays unknown and a later invocation preserves the committed credential', async t => {
  const f = await fixture(t), h = hub()
  const first = await migrateNightAllCredentials(env(f.path), { providers: ['rapidapi', 'exa'], dryRun: false,
    fetchImpl: async (url, input) => {
      const response = await h.fetchImpl(url, input)
      if (input.method === 'PUT') throw new Error(`${ADMIN} ${secret('rapidapi')}`)
      return response
    },
  })
  assert.deepEqual(first.providers.map(row => row.status), ['write_unknown', 'write_unknown'])
  assert.equal(first.complete, false)
  noSecrets(first); noSecrets(formatMigrationResults(first))
  const resumed = await migrateNightAllCredentials(env('/must-not-read'), { providers: ['rapidapi', 'exa'], dryRun: false,
    fetchImpl: h.fetchImpl, readCredentials() { assert.fail('Do not read source after a committed write') } })
  assert.deepEqual(resumed.providers.map(row => row.status), ['preserved', 'preserved'])
  assert.equal(h.calls.filter(call => call.method === 'PUT').length, 2)
})

test('rejected, uncertain and malformed acknowledgements never count as confirmed writes or leak response bodies', async t => {
  const f = await fixture(t)
  for (const [response, status] of [
    [() => Response.json({ error: `${ADMIN} ${secret('rapidapi')}` }, { status: 403 }), 'write_rejected'],
    [() => Response.json({ error: secret('rapidapi') }, { status: 503 }), 'write_unknown'],
    [() => new Response(secret('rapidapi')), 'write_unconfirmed'],
    [() => Response.json({ data: { source: 'environment', credentialConfigured: true, revision: 1 } }), 'write_unconfirmed'],
    [() => Response.json({ data: { source: 'database', credentialConfigured: false, revision: 1 } }), 'write_unconfirmed'],
    [() => Response.json({ data: { source: 'database', credentialConfigured: true, revision: 2 } }), 'write_unconfirmed'],
  ]) {
    let puts = 0
    const result = await migrateNightAllCredentials(env(f.path), { providers: ['rapidapi'], dryRun: false,
      fetchImpl: async (_, input) => input.method === 'GET' ? metadata(empty) : (puts++, response()) })
    assert.equal(result.providers[0].status, status)
    assert.equal(result.complete, false)
    assert.equal(puts, 1)
    noSecrets(result); noSecrets(formatMigrationResults(result))
  }
})

test('source/target failures stay safe and unavailable sources do not trigger fallback or writes', async () => {
  let methods = []
  const sourceFailure = await migrateNightAllCredentials(env('/not-a-source'), { providers: ['rapidapi'], dryRun: false,
    fetchImpl: async (_, input) => { methods.push(input.method); return metadata(empty) },
    readCredentials() { throw Error(`${ADMIN} ${secret('source')}`) } })
  assert.equal(sourceFailure.providers[0].status, 'source_unavailable')
  assert.deepEqual(methods, ['GET']); noSecrets(sourceFailure)
  const targetFailure = await migrateNightAllCredentials(env('/must-not-read'), { providers: ['rapidapi'],
    fetchImpl: async () => { throw Error(`${ADMIN} ${secret('target')}`) },
    readCredentials() { assert.fail('Unavailable targets must not read secrets') } })
  assert.equal(targetFailure.providers[0].status, 'target_unavailable'); noSecrets(targetFailure)
})

test('Admin origin is HTTPS or loopback HTTP and invalid inputs fail before any source/target access', async () => {
  for (const base of ['http://remote.invalid', 'https://user:secret@remote.invalid', 'https://remote.invalid/path', 'https://remote.invalid?secret=value']) {
    await assert.rejects(migrateNightAllCredentials({ ...env('/must-not-read'), MX_INSIGHT_ADMIN_BASE_URL: base }, {
      providers: ['rapidapi'], fetchImpl() { assert.fail('Invalid origin must not dispatch') },
    }))
  }
  for (const base of ['http://127.0.0.1:18151', 'http://[::1]:18151', 'https://hub.example.test']) {
    const result = await migrateNightAllCredentials({ ...env('/must-not-read'), MX_INSIGHT_ADMIN_BASE_URL: base }, {
      providers: ['rapidapi'], fetchImpl: async (url, input) => {
        assert.equal(new URL(url).origin, base); assert.equal(input.redirect, 'error')
        return metadata({ ...empty, credentialConfigured: true })
      },
    })
    assert.equal(result.providers[0].status, 'preserved')
  }
})

test('CLI validation errors never print argument values, Admin token or source path', async () => {
  const script = new URL('../../scripts/migrate-night-all-credentials.mjs', import.meta.url)
  const result = await promisify(execFile)(process.execPath, [script.pathname, '--providers', secret('unknown'), '--apply'], {
    env: { ...process.env, ...env(`/private/${secret('source')}`) },
  }).then(() => assert.fail('Invalid provider must fail'), error => error)
  assert.equal(result.code, 1)
  noSecrets(result.stdout); noSecrets(result.stderr)
  assert.match(result.stderr, /No automatic retry/)
})
