import assert from 'node:assert/strict'
import { chmod, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  migrateTikHubCredential,
  normalizeAdminBase,
  readNightAllTikHubCredential,
} from '../../scripts/migrate-tikhub-credential.mjs'

const SECRET = 'night-all-tikhub-secret-that-must-not-be-logged'
const ADMIN_TOKEN = 'admin-token-with-at-least-32-bytes'

async function configFixture(mode = 0o600) {
  const directory = await mkdtemp(join(tmpdir(), 'mx-tikhub-migration-'))
  const path = join(directory, 'config.json')
  await writeFile(path, JSON.stringify({
    crawlerProviders: { tikhub: { apiKey: SECRET, enabled: true } },
  }), { mode })
  await chmod(path, mode)
  return { directory, path }
}

test('Night-All credential reader accepts only a private regular JSON file', async () => {
  const fixture = await configFixture()
  assert.equal(await readNightAllTikHubCredential(fixture.path), SECRET)

  await chmod(fixture.path, 0o644)
  await assert.rejects(
    () => readNightAllTikHubCredential(fixture.path),
    /permissions must exclude group and other access/,
  )

  const link = join(fixture.directory, 'linked-config.json')
  await symlink(fixture.path, link)
  await assert.rejects(() => readNightAllTikHubCredential(link), /not a symlink/)
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
    assert.deepEqual(body, { apiKey: SECRET, expectedRevision: 4 })
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
    assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET))
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
