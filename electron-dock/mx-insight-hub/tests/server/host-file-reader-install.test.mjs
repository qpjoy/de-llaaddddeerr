import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  const run = (failStart = false) => {
    writeFileSync(events, '')
    const result = spawnSync('bash', ['-c', `
      source "$1/scripts/install-host-file-reader.sh"
      systemd-analyze() { printf 'verify %s\\n' "$*" >>"$EVENTS"; }
      flock() { :; }
      curl() { printf 'probe %s\\n' "$*" >>"$EVENTS"; printf 400; }
      systemctl() {
        printf '%s\\n' "$*" >>"$EVENTS"
        if [ "$1" = is-failed ]; then return 1; fi
        if [ "$1" = enable ] && [ "$FAIL_START" = 1 ]; then return 7; fi
        return 0
      }
      install_host_file_reader "$2" "$3"
    `, '_', hub, prefix, source], { encoding: 'utf8', env: { ...process.env, EVENTS: events, FAIL_START: failStart ? '1' : '0' } })
    return { ...result, events: readFileSync(events, 'utf8') }
  }

  const pending = join(prefix, 'usr/local/lib/mx-insight-hub/.host-file-reader-restart-pending')
  const installed = join(prefix, 'usr/local/lib/mx-insight-hub/host-file-reader.py')
  const dir = join(prefix, 'var/lib/mx-insight-hub/file-reader-socket')
  const first = run()
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.events, /stop mx-insight-file-reader.service mx-insight-file-reader.socket/)
  assert.match(first.events, /enable --now mx-insight-file-reader.socket/)
  assert.match(first.events, /probe .*--unix-socket .*reader.sock .*http:\/\/localhost\/open/)
  const inode = statSync(dir).ino
  const again = run()
  assert.equal(again.status, 0, again.stderr)
  assert.doesNotMatch(again.events, /\bstop\b/)
  appendFileSync(script, '\n# fixture update\n')
  assert.equal(run(true).status, 7)
  assert.ok(existsSync(pending))
  assert.match(readFileSync(installed, 'utf8'), /fixture update/)
  const retry = run()
  assert.equal(retry.status, 0, retry.stderr)
  assert.match(retry.events, /stop mx-insight-file-reader.service mx-insight-file-reader.socket/)
  assert.equal(statSync(dir).ino, inode)
  assert.equal(existsSync(pending), false)
  assert.match(readFileSync(join(prefix, 'etc/systemd/system', name + '.socket'), 'utf8'), /SocketGroup=1000\s+SocketMode=0660/)
  assert.match(readFileSync(join(prefix, 'etc/systemd/system', name + '.service'), 'utf8'), /StateDirectory=mx-insight-file-reader\s+StateDirectoryMode=0700/)
  writeFileSync(join(dir, 'unrelated'), 'fixture')
  const unrelated = run()
  assert.equal(unrelated.status, 1)
  assert.match(unrelated.stderr, /Unexpected entry/)
  assert.doesNotMatch(unrelated.events, /daemon-reload/)
})
