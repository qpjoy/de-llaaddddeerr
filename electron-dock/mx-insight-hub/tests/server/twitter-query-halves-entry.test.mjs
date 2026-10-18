import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const entry = new URL('../../server/ops/verify-twitter-query-halves.sh', import.meta.url)
const probe = new URL('../../server/ops/verify-twitter-query-param.mjs', import.meta.url)

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'twitter-halves-entry-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const script = join(directory, 'verify-twitter-query-halves.sh')
  copyFileSync(entry, script)
  copyFileSync(probe, join(directory, 'verify-twitter-query-param.mjs'))
  // No cluster, database or network: record only argv and consume local stdin.
  writeFileSync(join(directory, 'kubectl'), '#!/bin/sh\nprintf "%s\\n" "$@"\ncat >/dev/null\n', { mode: 0o755 })
  return { directory, run: args => spawnSync('bash', [script, ...args], { cwd: tmpdir(), encoding: 'utf8',
    env: { PATH: `${directory}:${process.env.PATH}`, MX_TWITTER_QUERY_PARAM_VERIFY: '1' } }) }
}

test('entry always selects halves and execute, using its sibling source from any cwd', t => {
  const f = fixture(t), result = f.run([])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.deepEqual(result.stdout.trim().split('\n'), ['-n', 'mx-insight-hub', 'exec', '-i',
    'deployment/mx-insight-hub-admin', '-c', 'admin', '--', 'env', 'MX_TWITTER_QUERY_PARAM_VERIFY=0',
    'node', '--input-type=module', '-', '--case=halves', '--execute'])
})

test('old candidate selections and extra flags cannot change the fixed entry or reach kubectl', t => {
  const f = fixture(t)
  for (const args of [['--case=candidate'], ['--case=control'], ['--execute']]) {
    const result = f.run(args)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /accepts no arguments/u)
  }
})

test('missing or older sibling source stops before any cluster invocation', t => {
  const f = fixture(t), source = join(f.directory, 'verify-twitter-query-param.mjs')
  writeFileSync(source, "export const REVISION = 'twitter-query-param-check.v1'\n")
  for (const missing of [false, true]) {
    if (missing) rmSync(source)
    const result = f.run([])
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /no cluster request was sent/u)
  }
})
