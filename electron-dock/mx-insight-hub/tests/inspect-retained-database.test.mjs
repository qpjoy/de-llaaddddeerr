import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sealApiKey } from '../server/core/key-vault.mjs'
import { pepperEvidence, overlap, validateLayout, containerIsolation } from '../scripts/inspect-retained-database.mjs'

const pepper = 'synthetic-retained-pepper-for-tests-1234'
function sample(id, candidate = pepper) {
  const plaintext = `synthetic-api-key-${id}`
  return { id, envelope: sealApiKey(plaintext, id, candidate),
    digest: createHmac('sha256', candidate).update(plaintext).digest('hex') }
}

test('old vault and authentication digest independently validate the current pepper without disclosure', () => {
  const values = [sample('one'), sample('two')]
  const result = pepperEvidence(values, pepper)
  assert.deepEqual(result, { verdict: 'MATCHED_SAMPLES', sampled: 2, matched: 2 })
  for (const secret of [pepper, values[0].envelope, values[0].digest, 'synthetic-api-key-one']) {
    assert.equal(JSON.stringify(result).includes(secret), false)
  }
  values[0].digest = '0'.repeat(64)
  assert.deepEqual(pepperEvidence(values, pepper), { verdict: 'MIXED_SAMPLES', sampled: 2, matched: 1 })
})

test('wrong pepper, damaged ciphertext and missing samples cannot be reported as a match', () => {
  assert.equal(pepperEvidence([sample('one')], 'different-current-pepper').verdict, 'NO_MATCH_OR_DAMAGED_SAMPLES')
  assert.equal(pepperEvidence([{ ...sample('one'), envelope: 'broken' }], pepper).matched, 0)
  assert.equal(pepperEvidence([], pepper).verdict, 'UNVERIFIED_NO_VAULT_SAMPLES')
})

test('vault envelopes remain bound to their original API key ID', () => {
  assert.equal(pepperEvidence([{ ...sample('one'), id: 'another' }], pepper).matched, 0)
})

test('directory use detection respects path components and parent mounts', () => {
  assert.equal(overlap('/data/common', '/data/common/pgdata'), true)
  assert.equal(overlap('/data/common/pgdata', '/data/common'), true)
  assert.equal(overlap('/data/common', '/data/common'), true)
  assert.equal(overlap('/data/common', '/data/common-old'), false)
  assert.equal(overlap('/', '/data/common'), true)
  assert.equal(overlap('/data/common', '/'), true)
})

test('incomplete, incompatible and special recovery layouts fail before starting PostgreSQL', t => {
  const root = mkdtempSync(join(tmpdir(), 'mx-retained-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'global'))
  mkdirSync(join(root, 'base'))
  writeFileSync(join(root, 'PG_VERSION'), '16\n')
  writeFileSync(join(root, 'global/pg_control'), 'synthetic-control')
  assert.doesNotThrow(() => validateLayout(root))
  for (const marker of ['standby.signal', 'recovery.signal', 'backup_label']) {
    writeFileSync(join(root, marker), '')
    assert.throws(() => validateLayout(root), /separate recovery review/)
    rmSync(join(root, marker))
  }
  writeFileSync(join(root, 'PG_VERSION'), '17\n')
  assert.throws(() => validateLayout(root), /PostgreSQL 16/)
  writeFileSync(join(root, 'PG_VERSION'), '16\n')
  writeFileSync(join(root, 'global/pg_control'), '')
  assert.throws(() => validateLayout(root), /control files are missing/)
})

test('inspection container has no network, host ports, capabilities, or automatic image pull', () => {
  const args = containerIsolation('sha256:synthetic', ['type=bind,source=/copy,target=/inspection/pgdata'])
  for (const expected of ['--network=none', '--read-only', '--pull=never', '--cap-drop=ALL', '--cpus=1', '--memory=1g']) {
    assert.ok(args.includes(expected))
  }
  assert.ok(!args.some(arg => /^(--privileged|--publish|-p$|--network=host)/.test(arg)))
})
