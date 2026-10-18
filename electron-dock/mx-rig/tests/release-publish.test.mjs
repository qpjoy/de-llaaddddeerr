import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { readInstallerManifest, writeInstallerManifest } from '../scripts/release-artifact.mjs'

// docs/25 P2: a Launcher-mode installer goes to Release Center from this
// repository — named installs first, approved by a separate account, then
// everyone.

const run = promisify(execFile)
const script = fileURLToPath(new URL('../scripts/release-publish.mjs', import.meta.url))
const BYTES = Buffer.alloc(2048, 3)

async function installer(t, name = 'MX-Rig-0.9.0-mac-arm64.dmg') {
  const dir = await mkdtemp(join(tmpdir(), 'mx-rig-release-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, name)
  await writeFile(file, BYTES)
  return { dir, file }
}

test('only a Launcher-mode build, unchanged since it was built, can be published', async (t) => {
  const { dir, file } = await installer(t)
  await assert.rejects(readInstallerManifest(file), /Launcher-mode build/)
  const manifest = await writeInstallerManifest(file, { version: '0.9.0', platform: 'darwin', arch: 'arm64' })
  assert.deepEqual(
    [manifest.productId, manifest.kind, manifest.launcherMode, manifest.sizeBytes, manifest.digest],
    ['mx-rig', 'app-installer', true, BYTES.length, `sha256:${createHash('sha256').update(BYTES).digest('hex')}`]
  )
  assert.deepEqual(await readInstallerManifest(file), manifest)
  await appendFile(file, 'x')
  await assert.rejects(readInstallerManifest(file), /changed since it was built/)
  const exe = join(dir, 'MX-Rig-0.9.0-win-x64.exe')
  await writeFile(exe, BYTES)
  await assert.rejects(writeInstallerManifest(exe, { version: '0.9.0', platform: 'darwin', arch: 'arm64' }), /not a darwin installer/)
  const spaced = join(dir, 'MX Rig-0.9.0.dmg')
  await writeFile(spaced, BYTES)
  await assert.rejects(writeInstallerManifest(spaced, { version: '0.9.0', platform: 'darwin', arch: 'arm64' }), /plain ASCII/)
  await writeFile(`${exe}.json`, JSON.stringify({ ...manifest, launcherMode: false, fileName: 'MX-Rig-0.9.0-win-x64.exe', platform: 'win32' }))
  await assert.rejects(readInstallerManifest(exe), /not built in Launcher mode/)
})

// A stand-in for Launcher Internal's SDK facade.
async function releaseCenter(t) {
  const calls = []
  const plans = new Map()
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks)
    const url = new URL(req.url, 'http://x')
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    const body = req.headers['content-type'] === 'application/json' && raw.length ? JSON.parse(raw) : null
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization ?? null, body, bytes: raw.length })
    if (url.pathname === '/internal/v1/sdk/oauth/token') return json(200, { token: { access_token: `token-for-${body.scope.includes('approve') ? 'approver' : 'publisher'}` } })
    if (url.pathname === '/internal/v1/releases/products/resolve') return json(200, { identity: { productId: 'mx-rig', channel: 'stable' } })
    if (url.pathname === '/internal/v1/sdk/releases/artifacts' && req.method === 'POST') {
      const digest = `sha256:${createHash('sha256').update(raw).digest('hex')}`
      if (digest !== url.searchParams.get('digest')) return json(400, { message: 'digest mismatch' })
      return json(200, { artifact: { artifactId: 'artifact_1', digest } })
    }
    if (url.pathname === '/internal/v1/sdk/releases' && req.method === 'POST') {
      const planId = `plan_${plans.size + 1}`
      const plan = {
        planId,
        requestId: body.requestId,
        createdAt: `2026-10-16T00:0${plans.size}:00.000Z`,
        components: { launcher: { targetVersion: '0.9.0', currentVersion: body.currentVersion } },
        artifacts: [{ artifactId: body.artifactId, kind: 'app-installer', platform: 'darwin', arch: 'arm64', digest: 'sha256:abc' }],
        rollout: { percentage: body.rolloutPercentage, audience: { installIds: body.targetInstallIds ?? [], userIds: body.targetUserIds ?? [] } },
        releaseNotes: body.releaseNotes,
        test: { suiteId: body.suiteId, topology: body.topology, sites: body.sites, gate: { verdict: 'blocked' } }
      }
      plans.set(planId, plan)
      return json(200, { plan })
    }
    if (url.pathname === '/internal/v1/sdk/releases' && req.method === 'GET') return json(200, { plans: [...plans.values()] })
    const gate = /^\/internal\/v1\/sdk\/releases\/([^/]+)\/gate$/.exec(url.pathname)
    if (gate) {
      plans.get(gate[1]).test.gate.verdict = body.status
      return json(200, { plan: plans.get(gate[1]) })
    }
    const one = /^\/internal\/v1\/sdk\/releases\/([^/]+)$/.exec(url.pathname)
    if (one && plans.has(one[1])) return json(200, { plan: plans.get(one[1]) })
    json(404, { message: 'not found' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { url: `http://127.0.0.1:${server.address().port}`, calls, plans }
}

const SECRETS = {
  MX_RIG_RELEASE_CLIENT_SECRET: 'mxsa1.publisher-secret',
  MX_RIG_RELEASE_APPROVER_CLIENT_SECRET: 'mxsa1.approver-secret'
}

test('publish goes to named installs, approve needs a smoke, promote opens it to everyone', async (t) => {
  const center = await releaseCenter(t)
  const { dir, file } = await installer(t)
  await writeInstallerManifest(file, { version: '0.9.0', platform: 'darwin', arch: 'arm64' })
  const env = { ...process.env, MX_LAUNCHER_URL: center.url, ...SECRETS }
  const cli = (...args) => run(process.execPath, [script, ...args], { env })
  const printed = []
  const keep = (result) => (printed.push(result.stdout, result.stderr), result)

  // Never for everyone at once, never a secret on the command line.
  await assert.rejects(cli('publish', file), /named installs first/)
  await assert.rejects(cli('publish', file, '--install-id', 'inst-1', '--client-secret', 'x'), /environment only/)
  await assert.rejects(run(process.execPath, [script, 'publish', file, '--install-id', 'inst-1'], { env: { ...process.env, MX_LAUNCHER_URL: center.url } }), /no publisher credential/)

  const notes = join(dir, 'notes.md')
  await writeFile(notes, '# 0.9.0\n- 自动更新\n')
  const published = keep(await cli('publish', file, '--install-id', 'inst-1', '--notes', notes, '--from', '0.8.0'))
  assert.match(published.stdout, /plan plan_1 for install inst-1/)
  const upload = center.calls.find((call) => call.path === '/internal/v1/sdk/releases/artifacts')
  assert.equal(upload.auth, 'Bearer token-for-publisher')
  assert.equal(upload.bytes, BYTES.length)
  assert.deepEqual(
    [upload.query.productId, upload.query.kind, upload.query.componentId, upload.query.platform, upload.query.arch, upload.query.channel, upload.query.version, upload.query.fileName],
    ['mx-rig', 'app-installer', 'mx-rig', 'darwin', 'arm64', 'stable', '0.9.0', 'MX-Rig-0.9.0-mac-arm64.dmg']
  )
  assert.match(upload.query.releaseId, /^mx-rig-darwin-arm64-0\.9\.0-[0-9a-f]{12}$/)
  const targeted = center.calls.find((call) => call.path === '/internal/v1/sdk/releases' && call.method === 'POST').body
  assert.deepEqual(
    [targeted.artifactId, targeted.targetInstallIds, targeted.rolloutStrategy, targeted.rolloutPercentage, targeted.currentVersion, targeted.deliveryMode],
    ['artifact_1', ['inst-1'], 'manual-ring', 0, '0.8.0', 'prompt-download-restart']
  )
  assert.equal(targeted.releaseNotes, '# 0.9.0\n- 自动更新')
  // The same request again is the same request ID (Release Center replays it).
  await cli('publish', file, '--install-id', 'inst-1', '--notes', notes, '--from', '0.8.0')
  const requests = center.calls.filter((call) => call.path === '/internal/v1/sdk/releases' && call.method === 'POST').map((call) => call.body.requestId)
  assert.equal(requests[0], requests[1])

  await assert.rejects(cli('promote', 'plan_1'), /not approved yet/)
  await assert.rejects(cli('approve', 'plan_1'), /--smoke passed/)
  const approved = keep(await cli('approve', 'plan_1', '--smoke', 'passed'))
  assert.match(approved.stdout, /gate passed/)
  const gate = center.calls.find((call) => call.path === '/internal/v1/sdk/releases/plan_1/gate')
  assert.equal(gate.auth, 'Bearer token-for-approver', 'approved by the other account')
  assert.deepEqual([gate.body.status, gate.body.evidence.installSmoke, gate.body.evidence.artifactId, gate.body.requestId], ['passed', 'passed', 'artifact_1', 'plan_1-gate-passed'])
  assert.match(approved.stdout, /release promote plan_1/)

  const promoted = keep(await cli('promote', 'plan_1'))
  const full = [...center.plans.values()].at(-1)
  assert.match(promoted.stdout, new RegExp(`plan ${full.planId} for everyone`))
  const fullBody = center.calls.filter((call) => call.path === '/internal/v1/sdk/releases' && call.method === 'POST').at(-1).body
  assert.deepEqual(
    [fullBody.artifactId, fullBody.rolloutStrategy, fullBody.rolloutPercentage, fullBody.targetInstallIds, fullBody.requestId],
    ['artifact_1', 'all', 100, undefined, 'mx-rig-0.9.0-darwin-arm64-full-after-plan_1']
  )
  keep(await cli('approve', full.planId, '--smoke', 'passed'))
  const fullGate = center.calls.filter((call) => call.path.endsWith('/gate')).at(-1)
  assert.equal(fullGate.body.evidence.targetedPlanId, 'plan_1', 'the full gate cites the targeted plan')

  const status = keep(await cli('status'))
  assert.match(status.stdout, /@qpjoy\/mx-rig → mx-rig \/ stable/)
  assert.match(status.stdout, /plan_1 {2}0\.9\.0 {2}darwin-arm64 {2}gate passed/)
  for (const secret of Object.values(SECRETS)) assert.ok(!printed.join('\n').includes(secret), 'secrets are never printed')
  assert.ok(center.calls.filter((call) => call.path === '/internal/v1/sdk/oauth/token').every((call) => call.body.audience === 'mx-sdk'))
})

test('a non-Launcher build is refused before anything is uploaded', async (t) => {
  const center = await releaseCenter(t)
  const { file } = await installer(t)
  await assert.rejects(
    run(process.execPath, [script, 'publish', file, '--install-id', 'inst-1'], { env: { ...process.env, MX_LAUNCHER_URL: center.url, ...SECRETS } }),
    /only a Launcher-mode build/
  )
  assert.equal(center.calls.length, 0)
  assert.ok((await readFile(file)).equals(BYTES))
})
