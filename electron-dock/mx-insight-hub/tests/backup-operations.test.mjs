import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { collectEvidence, parseEvidence, summarizePostgres, summarizeSearch, postgresEvidenceSql } from '../scripts/backup-readiness.mjs'
import { collectKit, validateResources, configurationFingerprint, privateFile, publishEncryptedKit, parseArgs } from '../scripts/export-recovery-kit.mjs'
const now = Date.parse('2026-09-21T00:00:00Z')
const pg = { systemIdentifier: '7671038612254789664', archiveMode: 'on', archiveConfigured: true, lastArchivedAt: new Date(now - 60000).toISOString() }
const info = [{ name: 'mx-common', status: { code: 0 }, db: [{ id: 1, 'repo-key': 1, 'system-id': pg.systemIdentifier }], backup: [{ database: { id: 1, 'repo-key': 1 }, error: false, label: 'test-full', type: 'full', timestamp: { stop: (now - 60000) / 1000 } }] }]

test('PostgreSQL health distinguishes live DB from recent backup/archival evidence', () => {
  const noBackups = summarizePostgres({ archiveMode: 'off' }, null, { now })
  assert.equal(noBackups.reachable, true)
  assert.equal(noBackups.recentPgBackRestBackup, false)
  assert.equal(noBackups.archivingEnabled, false)
  assert.equal(summarizePostgres(pg, info, { now }).recentPgBackRestBackup, true)
  assert.equal(summarizePostgres({ ...pg, lastFailedAt: new Date(now).toISOString() }, info, { now }).archiveHasSuccess, false)
  assert.equal(summarizePostgres(pg, info, { now: now + 48 * 3600000 }).recentPgBackRestBackup, false)
})
test('missing, errored, future and stale backups never pass freshness', () => {
  for (const backup of [{ ...info[0].backup[0], error: true }, { ...info[0].backup[0], timestamp: { stop: now / 1000 + 1 } }]) {
    assert.equal(summarizePostgres(pg, [{ ...info[0], backup: [backup] }], { now }).recentPgBackRestBackup, false)
  }
  assert.equal(summarizePostgres(pg, [{ ...info[0], status: { code: 2 } }], { now }).recentPgBackRestBackup, false)
})
test('same-node ES snapshots do not imply off-host coverage', () => {
  const policy = { last_success: { time: now - 1000 } }
  assert.equal(summarizeSearch(policy, { type: 'fs' }, { now }).remoteRepositoryConfigured, false)
  assert.equal(summarizeSearch(policy, { type: 's3' }, { now }).remoteRepositoryConfigured, true)
})
test('metadata collector sends only read-only queries and withholds failed tool output', () => {
  const calls = []
  const report = collectEvidence({ now, run(command, args) {
    calls.push([command, args]); throw new Error('DO_NOT_PRINT_SECRET')
  } })
  assert.equal(report.basicBackupEvidencePresent, false)
  assert.equal(report.disasterRecoveryVerified, false)
  assert.equal(calls.length, 3)
  assert.ok(calls.every(([cmd, args]) => cmd === 'kubectl' && args.includes('exec')))
  assert.doesNotMatch(JSON.stringify(report), /DO_NOT_PRINT_SECRET/)
  assert.match(postgresEvidenceSql, /BEGIN READ ONLY/)
  assert.doesNotMatch(postgresEvidenceSql, /pg_switch_wal|archive_command'\),|SELECT \*/)
})
test('complete metadata remains explicitly short of a restore drill', () => {
  const report = collectEvidence({ now, run(command, args) {
    if (args.includes('psql')) return JSON.stringify(pg)
    if (args.includes('pgbackrest')) return JSON.stringify(info)
    if (args.at(-1).includes('/_slm/')) return JSON.stringify({ 'mx-common-daily': { policy: { repository: 'repo' }, last_success: { time: now - 1000 } } })
    return JSON.stringify({ repo: { type: 's3', settings: { secret_key: 'DO_NOT_PRINT_SECRET' } } })
  } })
  assert.equal(report.basicBackupEvidencePresent, true)
  assert.equal(report.disasterRecoveryVerified, false)
  assert.doesNotMatch(JSON.stringify(report), /DO_NOT_PRINT_SECRET/)
})
function fixture() {
  const s = (namespace, name, keys) => ({ kind: 'Secret', metadata: { namespace, name, uid: name, resourceVersion: '1' }, data: Object.fromEntries(keys.map(k => [k, 'c2VjcmV0'])) })
  return {
    'mx-common': { items: [s('mx-common', 'mx-common-secrets', ['postgres-password']), s('mx-common', 'mx-common-db-mx-insight-hub', ['password', 'database', 'username'])] },
    'mx-insight-hub': { items: [s('mx-insight-hub', 'mx-insight-hub-secrets', ['DATABASE_URL', 'MX_INSIGHT_API_KEY_PEPPER', 'MX_INSIGHT_ADMIN_TOKEN'])] },
  }
}
function temporary(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mx-backup-test-')))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
test('configuration capture rejects missing critical secrets or another namespace', () => {
  validateResources(fixture())
  const missing = fixture(); delete missing['mx-insight-hub'].items[0].data.MX_INSIGHT_API_KEY_PEPPER
  assert.throws(() => validateResources(missing), /missing/)
  const foreign = fixture(); foreign['mx-common'].items[0].metadata.namespace = 'mx-launcher'
  assert.throws(() => validateResources(foreign), /namespace/)
})
test('resource order does not change fingerprint, rotations do', () => {
  const a = fixture(); const b = fixture(); b['mx-common'].items.reverse()
  assert.equal(configurationFingerprint(a), configurationFingerprint(b))
  b['mx-common'].items[0].metadata.resourceVersion = '2'
  assert.notEqual(configurationFingerprint(a), configurationFingerprint(b))
})
test('input files must be private regular files, not symlinks', t => {
  const dir = temporary(t); const file = path.join(dir, 'env')
  fs.writeFileSync(file, 'secret', { mode: 0o600 }); assert.equal(privateFile(file), 'secret')
  fs.chmodSync(file, 0o644); assert.throws(() => privateFile(file), /private/)
  fs.symlinkSync(file, path.join(dir, 'link')); assert.throws(() => privateFile(path.join(dir, 'link')), /private/)
})
test('capture includes runtime configuration and only scoped PVs, never Launcher queries', t => {
  const dir = temporary(t); const envFile = path.join(dir, 'env'); const receiptFile = path.join(dir, 'receipt')
  fs.writeFileSync(envFile, 'secret', { mode: 0o600 }); fs.writeFileSync(receiptFile, '{}', { mode: 0o600 })
  const calls = []
  const run = (cmd, args) => {
    calls.push(args)
    if (cmd === 'git') return 'commit'
    if (args.includes('-n')) return JSON.stringify(fixture()[args[args.indexOf('-n') + 1]])
    if (args.includes('pv')) return JSON.stringify({ items: [{ spec: { claimRef: { namespace: 'mx-common' } } }, { spec: { claimRef: { namespace: 'mx-launcher' } } }] })
    return JSON.stringify({ items: [] })
  }
  const kit = JSON.parse(collectKit({ envFile, receiptFile, run }))
  assert.equal(kit.containsDatabaseBackup, false)
  assert.equal(kit.files['.env.internal'], 'secret')
  assert.equal(kit.persistentVolumes.length, 1)
  assert.ok(calls.every(args => !args.includes('mx-launcher')))
  let requests = 0
  const rotating = (cmd, args) => {
    const result = run(cmd, args)
    if (args.includes('secrets,configmaps')) {
      const parsed = JSON.parse(result); parsed.items[0].metadata.resourceVersion = String(++requests + 1); return JSON.stringify(parsed)
    }
    return result
  }
  assert.throws(() => collectKit({ envFile, receiptFile, run: rotating }), /changed/)
})
test('encrypted output is exclusive, private and never a plaintext staging file', t => {
  const dir = temporary(t); const output = path.join(dir, 'kit.age'); const plaintext = Buffer.from('VERY_PRIVATE')
  const recipient = 'age1' + 'q'.repeat(58)
  const encrypted = Buffer.from('age-encryption.org/v1\nTEST_FIXTURE_CIPHERTEXT')
  const run = (cmd, args, input) => { assert.equal(cmd, 'age'); assert.deepEqual(input, plaintext); assert.deepEqual(args, ['--encrypt', '--recipient', recipient]); return encrypted }
  const report = publishEncryptedKit({ plaintext, recipient, output, run })
  assert.equal(fs.statSync(output).mode & 0o777, 0o600)
  assert.deepEqual(fs.readFileSync(output), encrypted)
  assert.equal(report.containsDatabaseBackup, false)
  assert.doesNotMatch(JSON.stringify(report), /VERY_PRIVATE/)
  assert.deepEqual(fs.readdirSync(dir), ['kit.age'])
  assert.throws(() => publishEncryptedKit({ plaintext, recipient, output, run }), /new absolute/)
  assert.throws(() => publishEncryptedKit({ plaintext, recipient, output: path.join(dir, 'bad.age'), run: () => plaintext }), /encrypted file/)
  assert.equal(fs.existsSync(path.join(dir, 'bad.age')), false)
})
test('strict arguments require an explicit public recipient and fresh output', () => {
  assert.throws(() => parseArgs([]), /required/)
  assert.throws(() => parseArgs(['--output', '/a.age', '--output', '/b.age']), /invalid/)
  assert.throws(() => parseArgs(['--identity', 'PRIVATE']), /invalid/)
  assert.equal(parseArgs(['--recipient', 'public', '--output', '/a.age']).output, '/a.age')
})

test('pgBackRest system IDs survive JSON parsing without numeric rounding', () => {
  const parsed = parseEvidence('{"system-id":7671038612254789664}')
  assert.equal(parsed['system-id'], '7671038612254789664')
  assert.equal(summarizePostgres({ ...pg, systemIdentifier: '7671038612254789665' }, info, { now }).recentPgBackRestBackup, false)
})
