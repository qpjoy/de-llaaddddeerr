import assert from 'node:assert/strict'
import { chmod, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  credentialFingerprintTail,
  formatMigrationResults,
  migrateExternalPlatformCredentials,
  migrateTikHubCredential,
  normalizeAdminBase,
  readNightAllExternalPlatformCredentials,
  readNightAllTikHubCredential,
} from '../../scripts/migrate-tikhub-credential.mjs'

const TIKHUB_SECRET = 'fake-night-all-tikhub-secret-that-must-not-be-logged'
const JUSTONE_SECRET = 'fake-night-all-justone-secret-that-must-not-be-logged'
const ADMIN_TOKEN = 'admin-token-with-at-least-32-bytes'

async function configFixture(mode = 0o600) {
  const directory = await mkdtemp(join(tmpdir(), 'mx-tikhub-migration-'))
  const path = join(directory, 'config.json')
  await writeFile(path, JSON.stringify({
    crawlerProviders: {
      tikhub: { apiKey: TIKHUB_SECRET, enabled: true },
      justOne: { apiKey: JUSTONE_SECRET, enabled: true },
    },
  }), { mode })
  await chmod(path, mode)
  return { directory, path }
}

test('Night-All credential reader accepts only a private regular JSON file', async () => {
  const fixture = await configFixture()
  assert.equal(await readNightAllTikHubCredential(fixture.path), TIKHUB_SECRET)
  assert.deepEqual(await readNightAllExternalPlatformCredentials(fixture.path), {
    tikhub: TIKHUB_SECRET,
    justone: JUSTONE_SECRET,
  })

  await chmod(fixture.path, 0o644)
  await assert.rejects(
    () => readNightAllTikHubCredential(fixture.path),
    /permissions must exclude group and other access/,
  )

  const link = join(fixture.directory, 'linked-config.json')
  await symlink(fixture.path, link)
  await assert.rejects(() => readNightAllTikHubCredential(link), /not a symlink/)
})

test('combined migration cannot bypass private-file permissions', async () => {
  const fixture = await configFixture(0o644)
  let calls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    calls += 1
    return Response.json({ data: { credential: { revision: 0 } } })
  }
  try {
    await assert.rejects(
      () => migrateExternalPlatformCredentials({
        NIGHT_ALL_CONFIG_PATH: fixture.path,
        MX_INSIGHT_ADMIN_TOKEN: ADMIN_TOKEN,
        MX_INSIGHT_ALLOW_INSECURE_NIGHT_ALL_CONFIG: '1',
      }),
      /permissions must exclude group and other access/u,
    )
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('combined migration validates both source keys before contacting Hub Admin', async () => {
  const fixture = await configFixture()
  await writeFile(fixture.path, JSON.stringify({
    crawlerProviders: { tikhub: { apiKey: TIKHUB_SECRET } },
  }), { mode: 0o600 })
  await chmod(fixture.path, 0o600)
  let calls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    calls += 1
    return Response.json({ data: { credential: { revision: 0 } } })
  }
  try {
    await assert.rejects(
      () => migrateExternalPlatformCredentials({
        NIGHT_ALL_CONFIG_PATH: fixture.path,
        MX_INSIGHT_ADMIN_TOKEN: ADMIN_TOKEN,
      }),
      /crawlerProviders\.justOne\.apiKey is missing or invalid/u,
    )
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('credential migration is loopback-only and uses optimistic revision without revealing the key', async () => {
  assert.equal(normalizeAdminBase('http://localhost:18151/'), 'http://localhost:18151')
  assert.throws(() => normalizeAdminBase('https://example.com'), /loopback HTTP origin/)

  const fixture = await configFixture()
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options })
    if (options.method === 'GET') {
      return Response.json({ data: { credential: { revision: 4 } } })
    }
    const body = JSON.parse(options.body)
    assert.deepEqual(body, { apiKey: TIKHUB_SECRET, expectedRevision: 4 })
    return Response.json({
      data: { source: 'database', credentialConfigured: true, revision: 5 },
    })
  }
  try {
    const result = await migrateTikHubCredential({
      NIGHT_ALL_CONFIG_PATH: fixture.path,
      MX_INSIGHT_ADMIN_TOKEN: ADMIN_TOKEN,
      MX_INSIGHT_ADMIN_BASE_URL: 'http://127.0.0.1:18151',
    })
    assert.deepEqual(result, { dryRun: false, source: 'database', revision: 5 })
    assert.equal(calls.length, 2)
    assert.equal(calls[0].options.headers['x-mx-insight-admin-token'], ADMIN_TOKEN)
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TIKHUB_SECRET))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('combined credential migration preflights both revisions before writing and returns safe metadata', async () => {
  const fixture = await configFixture()
  const originalFetch = globalThis.fetch
  const calls = []
  const revisions = { tikhub: 4, justone: 8 }
  globalThis.fetch = async (url, options) => {
    const provider = String(url).match(/external-platforms\/(tikhub|justone)/u)?.[1]
    assert.ok(provider)
    calls.push({ provider, method: options.method })
    if (options.method === 'GET') {
      return Response.json({ data: { credential: { revision: revisions[provider] } } })
    }
    const body = JSON.parse(options.body)
    assert.deepEqual(body, {
      apiKey: provider === 'tikhub' ? TIKHUB_SECRET : JUSTONE_SECRET,
      expectedRevision: revisions[provider],
    })
    return Response.json({
      data: {
        source: 'database',
        credentialConfigured: true,
        revision: revisions[provider] + 1,
      },
    })
  }
  try {
    const result = await migrateExternalPlatformCredentials({
      NIGHT_ALL_CONFIG_PATH: fixture.path,
      MX_INSIGHT_ADMIN_TOKEN: ADMIN_TOKEN,
      MX_INSIGHT_ADMIN_BASE_URL: 'http://127.0.0.1:18151',
    })
    assert.deepEqual(calls, [
      { provider: 'tikhub', method: 'GET' },
      { provider: 'justone', method: 'GET' },
      { provider: 'tikhub', method: 'PUT' },
      { provider: 'justone', method: 'PUT' },
    ])
    assert.deepEqual(result, {
      dryRun: false,
      providers: [
        {
          provider: 'tikhub',
          status: 'migrated',
          source: 'database',
          revision: 5,
          fingerprintTail: credentialFingerprintTail(TIKHUB_SECRET),
        },
        {
          provider: 'justone',
          status: 'migrated',
          source: 'database',
          revision: 9,
          fingerprintTail: credentialFingerprintTail(JUSTONE_SECRET),
        },
      ],
    })
    const safeOutput = formatMigrationResults(result)
    assert.match(safeOutput, /provider=tikhub status=migrated fingerprintTail=[0-9a-f]{8}/u)
    assert.match(safeOutput, /provider=justone status=migrated fingerprintTail=[0-9a-f]{8}/u)
    assert.doesNotMatch(safeOutput, new RegExp(`${TIKHUB_SECRET}|${JUSTONE_SECRET}|${ADMIN_TOKEN}`, 'u'))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('combined dry-run validates both targets without writing or exposing source credentials', async () => {
  const fixture = await configFixture()
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options.method })
    return Response.json({ data: { credential: { revision: 7 } } })
  }
  try {
    const result = await migrateExternalPlatformCredentials({
      NIGHT_ALL_CONFIG_PATH: fixture.path,
      MX_INSIGHT_ADMIN_TOKEN: ADMIN_TOKEN,
      MX_INSIGHT_EXTERNAL_CREDENTIAL_MIGRATION_DRY_RUN: '1',
    })
    assert.equal(result.dryRun, true)
    assert.deepEqual(calls.map(({ method }) => method), ['GET', 'GET'])
    assert.deepEqual(result.providers.map(({ provider, status }) => ({ provider, status })), [
      { provider: 'tikhub', status: 'validated' },
      { provider: 'justone', status: 'validated' },
    ])
    assert.doesNotMatch(
      `${JSON.stringify(result)}\n${formatMigrationResults(result)}`,
      new RegExp(`${TIKHUB_SECRET}|${JUSTONE_SECRET}|${ADMIN_TOKEN}`, 'u'),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('credential migration dry-run reads metadata but performs no write', async () => {
  const fixture = await configFixture()
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return Response.json({ data: { credential: { revision: 7 } } })
  }
  try {
    const result = await migrateTikHubCredential({
      NIGHT_ALL_CONFIG_PATH: fixture.path,
      MX_INSIGHT_ADMIN_TOKEN: ADMIN_TOKEN,
      MX_INSIGHT_TIKHUB_MIGRATION_DRY_RUN: '1',
    })
    assert.deepEqual(result, { dryRun: true, source: 'night-all-config', expectedRevision: 7 })
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})
