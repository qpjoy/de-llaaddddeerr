import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, copyFileSync, readFileSync, rmSync, existsSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const probe = new URL('../../server/ops/verify-twitter-standard.mjs', import.meta.url)

function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'twitter-standard-entry-')))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const script = join(directory, 'verify-twitter-standard.sh')
  const source = join(directory, 'verify-twitter-standard.mjs')
  copyFileSync(new URL('../../server/ops/verify-twitter-standard.sh', import.meta.url), script)
  copyFileSync(probe, source)
  writeFileSync(join(directory, 'kubectl'), '#!/bin/sh\nprintf "%s\\n" "$@"\ncat > "$0.stdin"\n', { mode: 0o755 })
  return { directory, source, run: (args = []) => spawnSync('/bin/bash', [script, ...args], {
    cwd: tmpdir(), encoding: 'utf8', env: { PATH: `${directory}:/usr/bin:/bin` },
  }) }
}

test('standard wrapper uses the Public API container and streams matching JavaScript from any directory', t => {
  const f = fixture(t), result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.deepEqual(result.stdout.trim().split('\n'), ['-n', 'mx-insight-hub', 'exec', '-i',
    'deployment/mx-insight-hub-public', '-c', 'api', '--', 'node', '--input-type=module', '-', '--execute'])
  assert.equal(readFileSync(join(f.directory, 'kubectl.stdin'), 'utf8'), readFileSync(f.source, 'utf8'))
})

test('standard wrapper rejects extra query, execution and destination arguments before kubectl', t => {
  const f = fixture(t)
  for (const args of [['--query=OpenAI'], ['--execute'], ['--namespace=other'], ['--provider=rapidapi']]) {
    const result = f.run(args)
    assert.equal(result.status, 2)
    assert.match(result.stderr, /accepts no arguments/u)
    assert.equal(result.stdout, '')
    assert.equal(existsSync(join(f.directory, 'kubectl.stdin')), false)
  }
})

test('standard wrapper rejects outdated or missing source without starting a cluster process', t => {
  const f = fixture(t)
  writeFileSync(f.source, "export const REVISION = 'twitter-standard-check.v0'\n")
  for (const missing of [false, true]) {
    if (missing) rmSync(f.source)
    const result = f.run()
    assert.equal(result.status, 2)
    assert.match(result.stderr, /no cluster request was sent/u)
    assert.equal(result.stdout, '')
    assert.equal(existsSync(join(f.directory, 'kubectl.stdin')), false)
  }
})

test('standalone JavaScript requires explicit execution before installed imports or HTTP', t => {
  const f = fixture(t), marker = join(f.directory, 'unexpected-runtime-access')
  const guard = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'config imported');\nthrow new Error('unexpected installed import');\n`
  // Both direct-file and stdin entry points have an installed config trap.
  writeFileSync(join(f.directory, 'config.mjs'), guard)
  mkdirSync(join(f.directory, 'server'))
  writeFileSync(join(f.directory, 'server', 'config.mjs'), guard)
  const networkGuard = join(f.directory, 'network-guard.mjs')
  writeFileSync(networkGuard, `import http from 'node:http';\nimport https from 'node:https';\nimport net from 'node:net';\nimport { writeFileSync } from 'node:fs';\nconst forbidden = () => { writeFileSync(${JSON.stringify(marker)}, 'network called'); throw new Error('unexpected HTTP'); };\nglobalThis.fetch = forbidden;\nhttp.request = http.get = https.request = https.get = net.connect = net.createConnection = forbidden;\n`)
  for (const stdin of [false, true]) {
    for (const args of [[], ['--query=OpenAI'], ['--execute', '--query=OpenAI']]) {
      const result = spawnSync(process.execPath, ['--import', networkGuard,
        ...(stdin ? ['--input-type=module', '-'] : [f.source]), ...args], {
        cwd: f.directory, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' },
        ...(stdin ? { input: readFileSync(f.source, 'utf8') } : {}),
      })
      assert.equal(result.status, 1, result.stderr)
      assert.equal(result.stderr, '')
      assert.deepEqual(JSON.parse(result.stdout), {
        diagnosticRevision: 'twitter-standard-check.v1', errorCode: 'explicit_execute_required',
      })
      assert.equal(existsSync(marker), false)
    }
  }
})
