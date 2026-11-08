import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const manage = fileURLToPath(new URL('../../scripts/manage.sh', import.meta.url))
function run(action, roots, command = 'ops_action internal-production "$2"') {
  // No deployment credentials, cluster or persisted .env.internal involved.
  return spawnSync('bash', ['-c', 'source "$1"; load_env_file() { :; }; ' + command, '_', manage, action], {
    encoding: 'utf8',
    env: { ...process.env, MX_INSIGHT_IMAGE: 'mx-insight-hub:fixture', MX_INSIGHT_SERVER_FILE_ROOTS: JSON.stringify(roots) },
  })
}

test('offline plan mounts only the selected file in Admin and dictionary and leaves existing roots intact', () => {
  const archiveDir = '/data/nonexistent # "archive" mx-insight-hub:shadow'
  const roots = { 'shared-dir': '/shared_dir', other: '/shared_dir/other' }
  const plain = run('plan', roots)
  assert.equal(plain.status, 0, plain.stderr)
  const configured = run('plan', { ...roots, 'email-phone-archive': archiveDir })
  assert.equal(configured.status, 0, configured.stderr)
  assert.match(configured.stdout, /image: mx-insight-hub:fixture/)
  const entries = []
  const stripped = configured.stdout.replace(/^ +- (\{"name":"email-phone-archive".*\})$/gm, (_, json) => {
    entries.push(JSON.parse(json))
    return ''
  })
  const file = join(archiveDir, 'email-phone.zip')
  const expected = [
    { name: 'email-phone-archive', mountPath: file, readOnly: true },
    { name: 'email-phone-archive', hostPath: { path: file, type: 'File' } },
  ]
  assert.deepEqual(entries, [...expected, ...expected])
  assert.equal(stripped, plain.stdout)
  const deployments = configured.stdout.split(/^kind: Deployment$/m).slice(1)
  assert.deepEqual(deployments.filter(d => d.includes('"name":"email-phone-archive"'))
    .map(d => /^  name: ([^\n]+)/m.exec(d)[1]), ['mx-insight-hub-admin', 'mx-insight-hub-dictionary'])
})

test('archive preflight rejects invalid files and duplicate roots before deploy/apply change workloads', t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hub-archive-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const roots = { 'shared-dir': '/shared_dir', 'email-phone-archive': dir }
  const file = join(dir, 'email-phone.zip')
  const preflight = (settings = roots) => run('', settings, 'email_phone_archive_mount preflight')
  for (const action of ['deploy', 'apply']) {
    const result = run(action, roots, 'need() { :; }; require_production_env() { :; }; require_control_plane_ready() { exit 93; }; ops_action internal-production "$2"')
    assert.equal(result.status, 1)
    assert.match(result.stderr, /email-phone-archive: ENOENT/)
  }
  writeFileSync(file, 'fixture')
  chmodSync(file, 0o644)
  assert.equal(preflight().status, 0)
  assert.match(preflight({ ...roots, duplicate: dir }).stderr, /distinct directory/)
  chmodSync(file, 0o000)
  assert.match(preflight().stderr, /readable by the Hub Pod/)
  chmodSync(file, 0o755)
  assert.match(preflight().stderr, /non-executable regular file/)
  rmSync(file)
  symlinkSync(manage, file)
  assert.match(preflight().stderr, /must not use symbolic links/)
  assert.equal(preflight({ 'shared-dir': '/unmounted' }).status, 0)
})
