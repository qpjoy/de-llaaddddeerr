import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createApp } from '../../server/app.mjs'
import { parseJustOneConfig } from '../../server/external-platforms/config.mjs'
import { ExternalPlatformAdminService } from '../../server/external-platforms/admin.mjs'
import {
  MemoryExternalPlatformCredentialStore,
  PostgresExternalPlatformCredentialStore,
  createExternalPlatformCredentialStore,
} from '../../server/external-platforms/credentials-store.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'

const ADMIN_TOKEN = 'external-platform-admin-token-at-least-32-bytes'

function justOneConfig(configured = true) {
  return parseJustOneConfig({
    MX_INSIGHT_JUSTONE_CONFIGURED: configured ? '1' : '0',
    MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED: '1',
  })
}

function adminService(credentialStore) {
  return new ExternalPlatformAdminService({
    store: new MemoryExternalPlatformStore(),
    config: justOneConfig(),
    credentialStore,
  })
}

async function withServer(app, run) {
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('migration 052 isolates external-platform plaintext credentials from analytics metadata', async () => {
  const sql = await readFile(
    new URL('../../migrations/052_external_platform_credentials.sql', import.meta.url),
    'utf8',
  )
  assert.match(sql, /CREATE TABLE IF NOT EXISTS control\.external_platform_provider_settings/u)
  assert.match(sql, /source text NOT NULL DEFAULT 'environment'/u)
  assert.match(sql, /revision bigint NOT NULL DEFAULT 0/u)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS control\.external_platform_provider_credentials/u)
  assert.match(sql, /api_key text NOT NULL/u)
  assert.match(sql, /length\(api_key\) <= 4096/u)
  assert.match(sql, /VALUES \('justone', 'environment', 0\)/u)
  assert.doesNotMatch(sql, /ALTER TABLE external_platform\.|INSERT INTO external_platform\./u)
})

test('memory credential store reports only safe state and fences rotations by revision', async () => {
  const firstSecret = 'justone-memory-secret-one'
  const secondSecret = 'justone-memory-secret-two'
  const store = createExternalPlatformCredentialStore({ environmentConfigured: true })
  assert.ok(store instanceof MemoryExternalPlatformCredentialStore)
  assert.deepEqual(await store.describeCredential('justone'), {
    source: 'environment',
    revision: 0,
    credentialConfigured: true,
    revealable: false,
    updatedAt: null,
  })
  assert.equal(await store.readCredential('justone'), null)

  await assert.rejects(
    () => store.updateCredential('justone', { apiKey: firstSecret }),
    (error) => error?.status === 400
      && error?.code === 'invalid_external_platform_credential'
      && !error.message.includes(firstSecret),
  )

  const saved = await store.updateCredential('justone', {
    apiKey: `  ${firstSecret}  `,
    expectedRevision: 0,
  })
  assert.equal(saved.source, 'database')
  assert.equal(saved.revision, 1)
  assert.equal(saved.credentialConfigured, true)
  assert.equal(saved.revealable, true)
  assert.doesNotMatch(JSON.stringify(saved), /justone-memory-secret|apiKey/u)
  assert.equal(await store.readCredential('justone'), firstSecret)

  await assert.rejects(
    () => store.updateCredential('justone', { apiKey: secondSecret, expectedRevision: 0 }),
    (error) => error?.code === 'external_platform_credential_revision_conflict'
      && error.details?.currentRevision === 1,
  )
  assert.equal(await store.readCredential('justone'), firstSecret)
  await assert.rejects(
    () => store.updateCredential('justone', { apiKey: secondSecret, unexpected: true }),
    (error) => error?.code === 'invalid_external_platform_credential'
      && !error.message.includes(secondSecret),
  )
  await assert.rejects(
    () => store.updateCredential('other', { apiKey: secondSecret }),
    (error) => error?.code === 'external_platform_not_found',
  )
})

test('Postgres credential store keeps secret reads separate from safe projections', async () => {
  const secret = 'justone-postgres-secret'
  const timestamp = '2026-09-05T00:00:00.000Z'
  const calls = []
  let setting = { source: 'environment', revision: 0, updated_at: timestamp }
  let storedSecret = null
  let releaseError
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values })
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
      if (/INSERT INTO control\.external_platform_provider_settings/u.test(sql)) return { rows: [] }
      if (/FROM control\.external_platform_provider_settings[\s\S]*FOR UPDATE/u.test(sql)) {
        return { rows: [{ ...setting }] }
      }
      if (/INSERT INTO control\.external_platform_provider_credentials/u.test(sql)) {
        storedSecret = values[1]
        return { rows: [] }
      }
      if (/UPDATE control\.external_platform_provider_settings/u.test(sql)) {
        setting = { source: 'database', revision: setting.revision + 1, updated_at: timestamp }
        return { rows: [{ ...setting }] }
      }
      throw new Error(`unexpected transactional SQL: ${sql}`)
    },
    release(error) { releaseError = error },
  }
  const pool = {
    connect: async () => client,
    async query(sql, values = []) {
      calls.push({ sql, values })
      if (/EXISTS \(/u.test(sql)) {
        return { rows: [{ ...setting, credential_configured: storedSecret != null }] }
      }
      if (/SELECT settings\.source, credential\.api_key/u.test(sql)) {
        return { rows: [{ source: setting.source, api_key: storedSecret }] }
      }
      throw new Error(`unexpected pool SQL: ${sql}`)
    },
  }
  const store = createExternalPlatformCredentialStore({ pool, environmentConfigured: false })
  assert.ok(store instanceof PostgresExternalPlatformCredentialStore)

  const saved = await store.updateCredential('justone', { apiKey: secret, expectedRevision: 0 })
  assert.deepEqual(saved, {
    source: 'database',
    revision: 1,
    credentialConfigured: true,
    revealable: true,
    updatedAt: timestamp,
  })
  assert.equal(releaseError, null)
  assert.equal(await store.readCredential('justone'), secret)
  const described = await store.describeCredential('justone')
  assert.doesNotMatch(JSON.stringify(described), /justone-postgres-secret|apiKey/u)
  assert.ok(calls.some(({ sql, values }) => (
    /INSERT INTO control\.external_platform_provider_credentials/u.test(sql)
    && values[1] === secret
  )))
  assert.ok(calls.some(({ sql }) => /SELECT settings\.source, credential\.api_key/u.test(sql)))
  assert.ok(calls.some(({ sql }) => /EXISTS \(/u.test(sql)))
})

test('Postgres credential writes replace raw pg errors with a fixed secret-free AppError', async () => {
  const secret = 'justone-pg-error-secret'
  const rawError = new Error(`database rejected ${secret}`)
  rawError.detail = `Failing row contains (justone, ${secret})`
  rawError.query = 'INSERT INTO control.external_platform_provider_credentials VALUES ($1, $2)'
  rawError.parameters = ['justone', secret]
  const statements = []
  let releasedWith
  const client = {
    async query(sql) {
      statements.push(sql)
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] }
      if (/INSERT INTO control\.external_platform_provider_settings/u.test(sql)) return { rows: [] }
      if (/FOR UPDATE/u.test(sql)) {
        return { rows: [{ source: 'environment', revision: 0, updated_at: null }] }
      }
      if (/INSERT INTO control\.external_platform_provider_credentials/u.test(sql)) throw rawError
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release(error) { releasedWith = error },
  }
  const store = new PostgresExternalPlatformCredentialStore({
    pool: { async connect() { return client } },
  })

  await assert.rejects(
    () => store.updateCredential('justone', { apiKey: secret, expectedRevision: 0 }),
    (error) => {
      assert.notEqual(error, rawError)
      assert.equal(error.status, 503)
      assert.equal(error.code, 'external_platform_credential_store_unavailable')
      assert.equal(error.message, 'External platform credential storage is unavailable')
      assert.equal(error.details, undefined)
      assert.equal(error.cause, undefined)
      assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`, new RegExp(secret, 'u'))
      return true
    },
  )
  assert.ok(statements.includes('ROLLBACK'))
  assert.equal(releasedWith, null)
})

test('credential reads allow environment fallback but fail closed for an incomplete database source', async () => {
  const memory = new MemoryExternalPlatformCredentialStore({ environmentConfigured: true })
  assert.equal(await memory.readCredential('justone'), null)
  memory.setting = { ...memory.setting, source: 'database' }
  await assert.rejects(
    () => memory.readCredential('justone'),
    (error) => error?.status === 503
      && error?.code === 'external_platform_credential_store_unavailable'
      && error?.details === undefined,
  )

  let row = { source: 'environment', api_key: null }
  const postgres = new PostgresExternalPlatformCredentialStore({
    pool: { async query() { return { rows: row ? [row] : [] } } },
  })
  assert.equal(await postgres.readCredential('justone'), null)
  row = { source: 'database', api_key: null }
  await assert.rejects(
    () => postgres.readCredential('justone'),
    (error) => error?.status === 503
      && error?.code === 'external_platform_credential_store_unavailable'
      && error?.details === undefined,
  )
  row = { source: 'database', api_key: 'database-only-key' }
  assert.equal(await postgres.readCredential('justone'), 'database-only-key')

  const rawReadError = new Error('raw credential read failed')
  rawReadError.detail = 'must-not-cross-the-store-boundary'
  const failing = new PostgresExternalPlatformCredentialStore({
    pool: { async query() { throw rawReadError } },
  })
  await assert.rejects(
    () => failing.readCredential('justone'),
    (error) => error !== rawReadError
      && error?.status === 503
      && error?.code === 'external_platform_credential_store_unavailable'
      && error?.details === undefined,
  )
})

test('external-platform admin detail adds a safe credential DTO and reveals database source only', async () => {
  const secret = 'justone-service-secret'
  const credentialStore = new MemoryExternalPlatformCredentialStore({ environmentConfigured: true })
  const service = adminService(credentialStore)
  const before = await service.detail('justone', '24h')
  assert.deepEqual(before.credential, {
    source: 'environment',
    revision: 0,
    credentialConfigured: true,
    revealable: false,
    updatedAt: null,
  })
  assert.doesNotMatch(JSON.stringify(before), /apiKey/u)
  await assert.rejects(
    () => service.revealCredential('justone'),
    (error) => error?.code === 'external_platform_credential_not_revealable',
  )

  const saved = await service.updateCredential('justone', { apiKey: secret, expectedRevision: 0 })
  assert.equal(saved.source, 'database')
  assert.doesNotMatch(JSON.stringify(saved), /justone-service-secret|apiKey/u)
  const after = await service.detail('justone', '24h')
  assert.equal(after.credential.revealable, true)
  assert.equal(after.provider.configured, true)
  assert.doesNotMatch(JSON.stringify(after), /justone-service-secret|apiKey/u)
  assert.deepEqual(await service.revealCredential('justone'), { apiKey: secret })
})

test('external-platform credential Admin API writes safely and requires re-authentication to reveal', async () => {
  const secret = 'justone-http-secret'
  const rejectedSecret = 'justone-http-rejected-secret'
  const credentialStore = new MemoryExternalPlatformCredentialStore({ environmentConfigured: false })
  const externalPlatformAdmin = adminService(credentialStore)
  const app = createApp({
    service: {},
    store: { async ping() { return true } },
    adapter: { async dependencies() { return { status: 'up' } } },
    adminToken: ADMIN_TOKEN,
    externalPlatformAdmin,
    identity: {
      enabled: true,
      async resolve(credential) {
        if (credential !== 'launcher-platform-admin') return null
        return {
          kind: 'launcher-user',
          memberId: 'launcher-admin',
          platformAdmin: true,
          tenantIds: null,
          capabilities: [],
          memberships: [],
        }
      },
    },
    logger: { error() {}, warn() {} },
  })

  await withServer(app, async (baseUrl) => {
    const detailBefore = await fetch(`${baseUrl}/internal/v1/admin/external-platforms/justone?range=24h`, {
      headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN },
    })
    assert.equal(detailBefore.status, 200)
    const detailBeforePayload = await detailBefore.json()
    assert.equal(detailBeforePayload.data.credential.credentialConfigured, false)
    assert.doesNotMatch(JSON.stringify(detailBeforePayload), /apiKey/u)

    const launcherDenied = await fetch(`${baseUrl}/internal/v1/admin/external-platforms/justone/credential`, {
      method: 'PUT',
      headers: {
        authorization: 'Bearer launcher-platform-admin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ apiKey: rejectedSecret }),
    })
    assert.equal(launcherDenied.status, 403)
    assert.equal((await launcherDenied.json()).error.code, 'admin_token_required')

    const missingRevision = await fetch(`${baseUrl}/internal/v1/admin/external-platforms/justone/credential`, {
      method: 'PUT',
      headers: {
        'x-mx-insight-admin-token': ADMIN_TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ apiKey: rejectedSecret }),
    })
    assert.equal(missingRevision.status, 400)
    const missingRevisionText = await missingRevision.text()
    assert.equal(JSON.parse(missingRevisionText).error.code, 'invalid_external_platform_credential')
    assert.doesNotMatch(missingRevisionText, /justone-http-rejected-secret/u)

    const saved = await fetch(`${baseUrl}/internal/v1/admin/external-platforms/justone/credential`, {
      method: 'PUT',
      headers: {
        'x-mx-insight-admin-token': ADMIN_TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ apiKey: secret, expectedRevision: 0 }),
    })
    assert.equal(saved.status, 200)
    const savedPayload = await saved.json()
    assert.equal(savedPayload.data.revision, 1)
    assert.equal(savedPayload.data.credentialConfigured, true)
    assert.doesNotMatch(JSON.stringify(savedPayload), /justone-http-secret|apiKey/u)

    const detailAfter = await fetch(`${baseUrl}/internal/v1/admin/external-platforms/justone?range=24h`, {
      headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN },
    })
    const detailAfterPayload = await detailAfter.json()
    assert.equal(detailAfterPayload.data.credential.revealable, true)
    assert.doesNotMatch(JSON.stringify(detailAfterPayload), /justone-http-secret|apiKey/u)

    const stale = await fetch(`${baseUrl}/internal/v1/admin/external-platforms/justone/credential`, {
      method: 'PUT',
      headers: {
        'x-mx-insight-admin-token': ADMIN_TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ apiKey: rejectedSecret, expectedRevision: 0 }),
    })
    assert.equal(stale.status, 409)
    assert.doesNotMatch(await stale.text(), /justone-http-(?:secret|rejected-secret)/u)

    const invalid = await fetch(`${baseUrl}/internal/v1/admin/external-platforms/justone/credential`, {
      method: 'PUT',
      headers: {
        'x-mx-insight-admin-token': ADMIN_TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ apiKey: rejectedSecret, source: 'database' }),
    })
    assert.equal(invalid.status, 400)
    assert.doesNotMatch(await invalid.text(), /justone-http-rejected-secret/u)

    const wrongReauth = await fetch(`${baseUrl}/internal/v1/admin/external-platforms/justone/credential/reveal`, {
      method: 'POST',
      headers: {
        'x-mx-insight-admin-token': ADMIN_TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ adminToken: 'wrong-token' }),
    })
    assert.equal(wrongReauth.status, 403)
    assert.doesNotMatch(await wrongReauth.text(), /justone-http-secret/u)

    const extraRevealField = await fetch(`${baseUrl}/internal/v1/admin/external-platforms/justone/credential/reveal`, {
      method: 'POST',
      headers: {
        'x-mx-insight-admin-token': ADMIN_TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ adminToken: ADMIN_TOKEN, extra: rejectedSecret }),
    })
    assert.equal(extraRevealField.status, 400)
    assert.doesNotMatch(await extraRevealField.text(), /justone-http-rejected-secret/u)

    const launcherReveal = await fetch(`${baseUrl}/internal/v1/admin/external-platforms/justone/credential/reveal`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer launcher-platform-admin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ adminToken: ADMIN_TOKEN }),
    })
    assert.equal(launcherReveal.status, 403)

    const reveal = await fetch(`${baseUrl}/internal/v1/admin/external-platforms/justone/credential/reveal`, {
      method: 'POST',
      headers: {
        'x-mx-insight-admin-token': ADMIN_TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ adminToken: ADMIN_TOKEN }),
    })
    assert.equal(reveal.status, 200)
    assert.match(reveal.headers.get('cache-control') || '', /no-store/u)
    assert.deepEqual((await reveal.json()).data, { apiKey: secret })

    const unsupported = await fetch(`${baseUrl}/internal/v1/admin/external-platforms/other/credential`, {
      method: 'PUT',
      headers: {
        'x-mx-insight-admin-token': ADMIN_TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ apiKey: rejectedSecret }),
    })
    assert.equal(unsupported.status, 404)
    assert.doesNotMatch(await unsupported.text(), /justone-http-rejected-secret/u)
  })
})
