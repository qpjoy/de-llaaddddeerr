import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, copyFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const probe = new URL('../../server/ops/verify-twitter-query-param.mjs', import.meta.url)

function fixture(t, entryName) {
  const directory = mkdtempSync(join(tmpdir(), 'twitter-halves-entry-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const script = join(directory, entryName)
  copyFileSync(new URL(`../../server/ops/${entryName}`, import.meta.url), script)
  copyFileSync(probe, join(directory, 'verify-twitter-query-param.mjs'))
  // No cluster, database or network: record only argv and consume local stdin.
  writeFileSync(join(directory, 'kubectl'), '#!/bin/sh\nprintf "%s\\n" "$@"\ncat > "$0.stdin"\n', { mode: 0o755 })
  return { directory, run: args => spawnSync('bash', [script, ...args], { cwd: tmpdir(), encoding: 'utf8',
    env: { PATH: `${directory}:${process.env.PATH}`, MX_TWITTER_QUERY_PARAM_VERIFY: '1' } }) }
}

for (const [entryName, caseName] of [['verify-twitter-query-halves.sh', 'halves'], ['verify-twitter-query-and.sh', 'english-and'],
  ['verify-twitter-query-groups.sh', 'english-groups'], ['verify-twitter-query-order.sh', 'event-order'],
  ['verify-twitter-query-terms.sh', 'event-terms']]) {
test(`${caseName} entry selects its fixed case and sends JavaScript stdin from any cwd`, t => {
  const f = fixture(t, entryName), result = f.run([])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.deepEqual(result.stdout.trim().split('\n'), ['-n', 'mx-insight-hub', 'exec', '-i',
    'deployment/mx-insight-hub-admin', '-c', 'admin', '--', 'env', 'MX_TWITTER_QUERY_PARAM_VERIFY=0',
    'node', '--input-type=module', '-', `--case=${caseName}`, '--execute'])
  assert.equal(readFileSync(join(f.directory, 'kubectl.stdin'), 'utf8'), readFileSync(probe, 'utf8'))
})

test(`${caseName} entry rejects alternate selections and extra flags before kubectl`, t => {
  const f = fixture(t, entryName)
  for (const args of [['--case=candidate'], ['--case=control'], ['--execute']]) {
    const result = f.run(args)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /accepts no arguments/u)
  }
})

test(`${caseName} entry rejects missing or older sibling source before kubectl`, t => {
  const f = fixture(t, entryName), source = join(f.directory, 'verify-twitter-query-param.mjs')
  writeFileSync(source, "export const REVISION = 'twitter-query-param-check.v6'\n")
  for (const missing of [false, true]) {
    if (missing) rmSync(source)
    const result = f.run([])
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /no cluster request was sent/u)
  }
})
}
