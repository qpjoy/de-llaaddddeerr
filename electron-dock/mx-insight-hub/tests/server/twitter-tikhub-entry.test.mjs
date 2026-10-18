import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, copyFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const probe = new URL('../../server/ops/verify-twitter-tikhub.mjs', import.meta.url)
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'twitter-tikhub-entry-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const script = join(directory, 'verify-twitter-tikhub.sh')
  copyFileSync(new URL('../../server/ops/verify-twitter-tikhub.sh', import.meta.url), script)
  copyFileSync(probe, join(directory, 'verify-twitter-tikhub.mjs'))
  writeFileSync(join(directory, 'kubectl'), '#!/bin/sh\nprintf "%s\\n" "$@"\ncat > "$0.stdin"\n', { mode: 0o755 })
  return { directory, run: (args = []) => spawnSync('/bin/bash', [script, ...args], { cwd: tmpdir(), encoding: 'utf8',
    env: { PATH: `${directory}:/usr/bin:/bin` } }) }
}

test('TikHub wrapper selects the fixed diagnostic and streams JavaScript from any working directory', t => {
  const f = fixture(t), result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.deepEqual(result.stdout.trim().split('\n'), ['-n', 'mx-insight-hub', 'exec', '-i',
    'deployment/mx-insight-hub-admin', '-c', 'admin', '--', 'node', '--input-type=module', '-', '--execute'])
  assert.equal(readFileSync(join(f.directory, 'kubectl.stdin'), 'utf8'), readFileSync(join(f.directory, 'verify-twitter-tikhub.mjs'), 'utf8'))
})

test('TikHub wrapper refuses arbitrary provider, query, mode or destination before invoking kubectl', t => {
  const f = fixture(t)
  for (const args of [['--query=OpenAI'], ['--provider=rapidapi'], ['--execute'], ['--namespace=other']]) {
    const result = f.run(args)
    assert.equal(result.status, 2)
    assert.match(result.stderr, /accepts no arguments/u)
    assert.equal(result.stdout, '')
    assert.equal(existsSync(join(f.directory, 'kubectl.stdin')), false)
  }
})

test('TikHub wrapper refuses missing or incompatible sibling source before starting a cluster process', t => {
  const f = fixture(t), source = join(f.directory, 'verify-twitter-tikhub.mjs')
  writeFileSync(source, "export const REVISION = 'old-diagnostic'\n")
  for (const missing of [false, true]) {
    if (missing) rmSync(source)
    const result = f.run()
    assert.equal(result.status, 2)
    assert.match(result.stderr, /no cluster request was sent/u)
    assert.equal(result.stdout, '')
    assert.equal(existsSync(join(f.directory, 'kubectl.stdin')), false)
  }
})
