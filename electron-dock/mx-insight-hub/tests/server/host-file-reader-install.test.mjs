import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, chownSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const hub = fileURLToPath(new URL('../../', import.meta.url))
const name = 'mx-insight-file-reader'
const socketPath = '/run/mx-insight-file-reader/reader.sock'

test('only Admin and dictionary mount the optional socket directory, independently of probes and init containers', () => {
  const plan = spawnSync('bash', ['-c', 'source "$1/scripts/manage.sh"; load_env_file() { :; }; ops_action internal-production plan', '_', hub],
    { encoding: 'utf8', env: { ...process.env, MX_INSIGHT_SERVER_FILE_ROOTS: '' } })
  assert.equal(plan.status, 0, plan.stderr)
  const deployments = plan.stdout.split(/^kind: Deployment$/m).slice(1)
  const wired = deployments.filter(d => d.includes(socketPath))
  assert.deepEqual(wired.map(d => /^  name: ([^\n]+)/m.exec(d)[1]), ['mx-insight-hub-admin', 'mx-insight-hub-dictionary'])
  for (const deployment of wired) {
    assert.equal(deployment.split(socketPath).length, 2)
    assert.equal(deployment.split('/var/lib/mx-insight-hub/file-reader-socket').length, 2)
    assert.match(deployment, /mountPath: \/run\/mx-insight-file-reader\s+readOnly: true/)
    assert.match(deployment, /path: \/var\/lib\/mx-insight-hub\/file-reader-socket\s+type: DirectoryOrCreate/)
    assert.ok(deployment.indexOf('          env:') < deployment.indexOf(socketPath))
    assert.ok(deployment.indexOf('      containers:') < deployment.indexOf(socketPath))
  }
})

test('staged install upgrades only the reader, preserves its directory and retries interrupted activation', t => {
  const stage = mkdtempSync(join(tmpdir(), 'hub-reader-install-'))
  t.after(() => rmSync(stage, { recursive: true, force: true }))
  const source = join(stage, 'source')
  const prefix = join(stage, 'host')
  mkdirSync(join(source, 'scripts'), { recursive: true })
  cpSync(join(hub, 'deploy/systemd'), join(source, 'deploy/systemd'), { recursive: true })
  const script = join(source, 'scripts/host-file-reader.py')
  cpSync(join(hub, 'scripts/host-file-reader.py'), script)
  const events = join(stage, 'events')
  const run = ({ failStart = false, failAccess = false, retryFailed = false } = {}) => {
    writeFileSync(events, '')
    const result = spawnSync('bash', ['-c', `
      source "$1/scripts/install-host-file-reader.sh"
      systemd-analyze() { printf 'verify %s\\n' "$*" >>"$EVENTS"; }
      flock() { :; }
      journalctl() { printf 'journalctl %s\\n' "$*" >>"$EVENTS"; }
      verify_host_file_reader_socket() {
        printf 'verify-access %s\\n' "$*" >>"$EVENTS"
        [ "$FAIL_ACCESS" != 1 ]
      }
      curl() { printf 'probe %s\\n' "$*" >>"$EVENTS"; printf 400; }
      systemctl() {
        printf '%s\\n' "$*" >>"$EVENTS"
        if [ "$1" = is-failed ]; then [ "$RETRY_FAILED" = 1 ]; return; fi
        if [ "$1" = enable ] && [ "$FAIL_START" = 1 ]; then return 7; fi
        return 0
      }
      install_host_file_reader "$2" "$3"
    `, '_', hub, prefix, source], { encoding: 'utf8', env: { ...process.env, EVENTS: events,
      FAIL_START: failStart ? '1' : '0', FAIL_ACCESS: failAccess ? '1' : '0', RETRY_FAILED: retryFailed ? '1' : '0' } })
    return { ...result, events: readFileSync(events, 'utf8') }
  }

  const pending = join(prefix, 'usr/local/lib/mx-insight-hub/.host-file-reader-restart-pending')
  const installed = join(prefix, 'usr/local/lib/mx-insight-hub/host-file-reader.py')
  const dir = join(prefix, 'var/lib/mx-insight-hub/file-reader-socket')
  const first = run()
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.events, /stop mx-insight-file-reader.service mx-insight-file-reader.socket/)
  assert.match(first.events, /enable --now mx-insight-file-reader.socket/)
  assert.ok(first.events.includes(`verify-access ${join(dir, 'reader.sock')}\n`))
  assert.ok(first.events.indexOf('verify-access ') < first.events.indexOf('probe '))
  assert.match(first.events, /probe .*--unix-socket .*reader.sock .*http:\/\/localhost\/open/)
  const inode = statSync(dir).ino
  const again = run()
  assert.equal(again.status, 0, again.stderr)
  assert.doesNotMatch(again.events, /\bstop\b/)
  appendFileSync(script, '\n# fixture update\n')
  const failedStart = run({ failStart: true })
  assert.equal(failedStart.status, 7)
  for (const command of ['status ', 'journalctl ']) {
    const diagnostic = failedStart.events.split('\n').find(line => line.startsWith(command))
    assert.ok(diagnostic?.includes(`${name}.socket`) && diagnostic.includes(`${name}.service`), command)
  }
  assert.ok(existsSync(pending))
  assert.match(readFileSync(installed, 'utf8'), /fixture update/)
  const failedAccess = run({ failAccess: true })
  assert.notEqual(failedAccess.status, 0)
  assert.doesNotMatch(failedAccess.events, /probe /)
  assert.ok(existsSync(pending))
  const retry = run({ retryFailed: true })
  assert.equal(retry.status, 0, retry.stderr)
  assert.match(retry.events, /stop mx-insight-file-reader.service mx-insight-file-reader.socket/)
  assert.match(retry.events, /reset-failed mx-insight-file-reader.service/)
  assert.match(retry.events, /reset-failed mx-insight-file-reader.socket/)
  assert.equal(statSync(dir).ino, inode)
  assert.equal(existsSync(pending), false)
  const socketUnit = readFileSync(join(prefix, 'etc/systemd/system', name + '.socket'), 'utf8')
  assert.doesNotMatch(socketUnit, /^SocketGroup=/m)
  assert.match(socketUnit, /^SocketMode=0660$/m)
  assert.match(socketUnit, /^ExecStartPost=\/usr\/bin\/chgrp \+1000 \/var\/lib\/mx-insight-hub\/file-reader-socket\/reader\.sock$/m)
  assert.match(readFileSync(join(prefix, 'etc/systemd/system', name + '.service'), 'utf8'), /StateDirectory=mx-insight-file-reader\s+StateDirectoryMode=0700/)
  writeFileSync(join(dir, 'unrelated'), 'fixture')
  const unrelated = run()
  assert.equal(unrelated.status, 1)
  assert.match(unrelated.stderr, /Unexpected entry/)
  assert.doesNotMatch(unrelated.events, /daemon-reload/)
})

test('the installer checks socket type, ownership and mode before the root activation probe', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'reader-meta-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const verify = file => spawnSync('bash', ['-c', 'source "$1"; verify_host_file_reader_socket "$2"', '_',
    join(hub, 'scripts/install-host-file-reader.sh'), file], { encoding: 'utf8' })
  const path = join(temp, 'reader.sock')
  const regular = join(temp, 'regular')
  writeFileSync(regular, '')
  chmodSync(regular, 0o660)
  if (process.getuid() === 0) chownSync(regular, 0, 1000)
  assert.notEqual(verify(regular).status, 0)
  const server = createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(path, resolve))
  try {
    chmodSync(path, 0o660)
    if (process.getuid() === 0) {
      chownSync(path, 0, 1000)
      const valid = verify(path)
      assert.equal(valid.status, 0, valid.stderr)
      chmodSync(path, 0o666)
      assert.notEqual(verify(path).status, 0)
      chmodSync(path, 0o660)
      chownSync(path, 0, 1001)
      assert.notEqual(verify(path).status, 0)
      chownSync(path, 1000, 1000)
    }
    assert.notEqual(verify(path).status, 0)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
