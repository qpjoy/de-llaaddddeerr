import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('migration 058 keeps exact provider bodies outside secret-free operational archives', async () => {
  const migration = await readFile(
    new URL('../../migrations/058_external_platform_restricted_raw_responses.sql', import.meta.url),
    'utf8',
  )

  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS control\.external_platform_restricted_raw_responses/u,
  )
  assert.match(migration, /provider_call_id uuid NOT NULL UNIQUE/u)
  assert.match(migration, /body_sha256 char\(64\) NOT NULL/u)
  assert.match(migration, /body_bytes bytea NOT NULL/u)
  assert.match(migration, /body_text text/u)
  assert.match(migration, /octet_length\(body_bytes\) = body_size/u)
  assert.match(migration, /json_parsed boolean NOT NULL/u)
  assert.match(migration, /parsed_payload jsonb/u)
  assert.match(
    migration,
    /REVOKE ALL ON TABLE control\.external_platform_restricted_raw_responses FROM PUBLIC/u,
  )
  assert.match(migration, /Never select from Public, tenant, ordinary Admin, UI, log/u)
  assert.doesNotMatch(migration, /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW/iu)
  assert.doesNotMatch(migration, /GRANT\s+SELECT/iu)
})
