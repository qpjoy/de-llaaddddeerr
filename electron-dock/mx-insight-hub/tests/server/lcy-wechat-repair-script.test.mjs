import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import services from '../../shared/wechat-services.json' with { type: 'json' }

test('K8s repair previews without mutation, sends only migration 140 and stops at a failed step', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-kubectl-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const log = join(dir, 'calls.jsonl')
  await writeFile(join(dir, 'kubectl'), `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2), body = readFileSync(0, 'utf8');
appendFileSync(process.env.WECHAT_TEST_LOG, JSON.stringify({ args, body }) + '\\n');
if (process.env.WECHAT_TEST_FAIL === 'preview' && args.includes('--provider') && !args.includes('--apply')) process.exit(9);
if (process.env.WECHAT_TEST_FAIL === 'migration' && args.includes('-e')) process.exit(8);
`, { mode: 0o700 })
  // Node recognizes extensionless stdin helpers as ESM by syntax detection.
  const script = fileURLToPath(new URL('../../scripts/repair-lcy-wechat-access.sh', import.meta.url))
  const run = async (mode, failure = '') => {
    await writeFile(log, '')
    const result = spawnSync('bash', [script, ...(mode ? [mode] : [])], {
      encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`,
        WECHAT_TEST_LOG: log, WECHAT_TEST_FAIL: failure },
    })
    const calls = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    return { ...result, calls }
  }
  const preview = await run()
  assert.equal(preview.status, 0, preview.stderr)
  assert.equal(preview.calls.length, 2)
  assert.ok(preview.calls.every(call => !call.args.includes('-e') && !call.args.includes('--apply')))
  const applied = await run('--apply')
  assert.equal(applied.status, 0, applied.stderr)
  assert.equal(applied.calls.length, 5)
  assert.ok(applied.calls.every(call => call.args.slice(0, 5).join(' ') === '-n mx-insight-hub exec -i deployment/mx-insight-hub-admin'))
  assert.deepEqual(applied.calls.map(call => call.args.includes('-e') ? 'migration' : call.args.includes('--provider') ? 'prices' : 'read'),
    ['read', 'prices', 'migration', 'prices', 'read'])
  assert.equal(applied.calls[2].body, await readFile(new URL('../../migrations/140_lcy_wechat_mp_grants.sql', import.meta.url), 'utf8'))
  assert.match(applied.calls[2].args.at(-1), /runMigrations/)
  const expected = services.filter(row => row.key.startsWith('wechat.mp.') || row.key === 'wechat.search.search').map(row => row.operation).sort()
  for (const call of [applied.calls[1], applied.calls[3]]) {
    assert.deepEqual(call.args.filter((_value, i) => call.args[i - 1] === '--operation').sort(), expected)
    assert.ok(!call.args.includes('--all'))
  }
  assert.ok(applied.calls[3].args.includes('--apply'))
  const previewFailure = await run('--apply', 'preview')
  assert.equal(previewFailure.status, 9)
  assert.equal(previewFailure.calls.length, 2)
  const migrationFailure = await run('--apply', 'migration')
  assert.equal(migrationFailure.status, 8)
  assert.equal(migrationFailure.calls.length, 3)
})
