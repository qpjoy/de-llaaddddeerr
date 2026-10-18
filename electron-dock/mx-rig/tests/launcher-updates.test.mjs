import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronLauncherApplicationUpdater } from '@qpjoy/electron-launcher/application-updater'
import { LauncherUpdates, PACKAGE_NAME, publicUpdate } from '../apps/desktop/launcher-updates.mjs'
import { LauncherNetwork } from '../apps/desktop/launcher-network.mjs'

// docs/25 P2: the desktop's updates come from Launcher's Release Center,
// through the Launcher SDK's own controller. Here the real controller runs
// against a stand-in Release Center; only the product network is faked.

const sdk = { createElectronLauncherApplicationUpdater }
const INSTALLER = Buffer.alloc(4096, 7)
const FILE = 'MX-Rig-0.9.0-mac-arm64.dmg'

async function releaseCenter({ identityPackage = PACKAGE_NAME } = {}) {
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null })
    const json = (value, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (req.url.startsWith('/internal/v1/releases/products/resolve?'))
      return json({
        identity: {
          appId: 'mx-rig',
          productId: 'mx-rig',
          packageName: identityPackage,
          launcherMode: 'standalone',
          networkProductId: 'mx-rig',
          componentId: 'mx-rig',
          rendererComponentId: 'mx-rig-renderer',
          channel: 'stable',
          channels: ['stable']
        }
      })
    if (req.url === '/internal/v1/release/check') {
      const kind = JSON.parse(body).artifactKinds?.[0]
      const artifact =
        kind === 'app-installer'
          ? {
              artifactId: 'artifact_1',
              kind,
              componentId: 'mx-rig',
              version: '0.9.0',
              source: 'manual-upload',
              url: `/internal/v1/release-artifacts/artifact_1/download/${FILE}`,
              digest: `sha256:${createHash('sha256').update(INSTALLER).digest('hex')}`,
              signature: null,
              sizeBytes: INSTALLER.length,
              platform: 'darwin',
              arch: 'arm64',
              fileName: FILE,
              activation: 'installer-manual',
              autoApply: false,
              restartRequired: true,
              requiredAppRestart: true,
              notes: []
            }
          : null
      return json({
        status: artifact ? 'update-available' : 'up-to-date',
        reason: artifact ? 'update available' : 'already current',
        planId: artifact ? 'plan_1' : null,
        releaseId: artifact ? 'release_1' : null,
        channel: 'stable',
        decision: {
          componentKind: kind,
          componentId: 'mx-rig',
          currentVersion: '0.8.0',
          targetVersion: artifact ? '0.9.0' : '0.8.0',
          updateAvailable: Boolean(artifact),
          updateMode: artifact ? 'automatic' : 'none',
          canSkip: true,
          canDefer: true,
          requiresGate: false,
          rollbackRequired: false,
          reason: 'test'
        },
        artifacts: artifact ? [artifact] : [],
        activation: null,
        releaseNotes: artifact ? '# 0.9.0\n- 自动更新' : null,
        deliveryMode: 'prompt-download-restart',
        featureFlags: [],
        rollout: { matchedBy: null, bucket: null, percentage: null },
        signedAt: '2026-10-16T00:00:00.000Z',
        signature: { algorithm: 'hmac-sha256', keyId: 'test', value: 'test' }
      })
    }
    if (req.url === '/internal/v1/release/reports') return json({ ok: true })
    if (req.url === `/internal/v1/release-artifacts/artifact_1/download/${FILE}`) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(INSTALLER.length) })
      return res.end(INSTALLER)
    }
    json({ message: 'not found' }, 404)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((resolve) => server.close(resolve)) }
}

// The product network as the updater sees it.
const fakeNetwork = (base) => ({
  status: 'ready',
  userId: null,
  state: { installId: 'inst-test-1' },
  releaseContext() {
    return this.status === 'ready' ? { baseUrl: base, installId: 'inst-test-1', userId: this.userId } : null
  },
  updateGate() {
    return { ready: 'connected', applying: 'connecting' }[this.status] ?? 'idle'
  }
})

async function setup(t, { distribution = 'installed', identityPackage } = {}) {
  const center = await releaseCenter({ identityPackage })
  const baseDir = await mkdtemp(join(tmpdir(), 'mx-rig-updates-'))
  t.after(async () => {
    await center.close()
    await rm(baseDir, { recursive: true, force: true })
  })
  const network = fakeNetwork(center.base)
  const seen = []
  const actions = []
  const updates = new LauncherUpdates({
    sdk,
    network,
    baseDir,
    appVersion: '0.8.0',
    distribution,
    platform: 'darwin',
    arch: 'arm64',
    openInstaller: async (path) => actions.push(['open', path]),
    cleanup: async () => actions.push(['cleanup']),
    exit: (code) => actions.push(['exit', code]),
    onChange: (state) => seen.push(state)
  })
  return { center, baseDir, network, seen, actions, updates }
}

async function until(predicate, label) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('connecting checks once for Rig, by package name, for installers only', async (t) => {
  const { center, network, seen, updates } = await setup(t)
  updates.networkChanged({ status: 'ready' })
  await until(() => seen.at(-1)?.phase === 'available', 'automatic check')
  const resolve = center.requests.find((request) => request.url.startsWith('/internal/v1/releases/products/resolve'))
  assert.equal(new URL(resolve.url, center.base).searchParams.get('packageName'), '@qpjoy/mx-rig')
  const checks = center.requests.filter((request) => request.url === '/internal/v1/release/check')
  assert.ok(checks.length >= 1)
  assert.ok(checks.every((request) => request.body.artifactKinds.length === 1 && request.body.artifactKinds[0] === 'app-installer'), 'never an ASAR')
  assert.deepEqual(checks[0].body.components, { 'mx-rig': '0.8.0' })
  assert.equal(checks[0].body.installId, 'inst-test-1')
  const state = updates.status()
  assert.equal(state.origin, 'auto')
  assert.deepEqual([state.targetVersion, state.actions.download, state.actions.install], ['0.9.0', true, false])
  assert.match(state.notes, /自动更新/)
  // The same network again is not another check.
  const before = center.requests.length
  updates.networkChanged({ status: 'ready' })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(center.requests.length, before)
  network.userId = 'usr-1'
  updates.networkChanged({ status: 'ready' })
  await until(() => center.requests.length > before, 'a new account checks again')
})

test('download, verify and install: the installer opens once, then Rig stops its things and exits', async (t) => {
  const { center, baseDir, seen, actions, updates } = await setup(t)
  assert.equal((await updates.check()).phase, 'available')
  const downloaded = await updates.download()
  assert.equal(downloaded.phase, 'ready')
  assert.deepEqual(downloaded.actions, { check: false, download: false, cancel: false, install: true })
  assert.match(downloaded.text, /拖进「应用程序」/)
  assert.ok(seen.some((state) => state.phase === 'downloading' || state.phase === 'verifying'))
  const installed = await updates.install()
  assert.equal(installed.phase, 'installing')
  assert.deepEqual(actions.map(([name]) => name), ['open', 'cleanup', 'exit'])
  assert.ok(actions[0][1].startsWith(baseDir) && actions[0][1].endsWith(FILE), 'the staged file, under userData')
  assert.deepEqual(actions[2], ['exit', 0])
  // Nothing the page received names a URL, a path or the stand-in's address.
  const shown = JSON.stringify([...seen, installed])
  for (const secret of [center.base, '/internal/v1/', baseDir, 'release-artifacts', 'stagedPath', 'selectedArtifact'])
    assert.ok(!shown.includes(secret), `the page never sees ${secret}`)
})

test('without the network, or from source, nothing is asked of Release Center', async (t) => {
  const offline = await setup(t)
  offline.network.status = 'idle'
  const waiting = await offline.updates.check()
  assert.equal(waiting.phase, 'needs-network')
  assert.match(waiting.text, /连上内网/)
  assert.equal(offline.center.requests.length, 0)
  const source = await setup(t, { distribution: 'development' })
  assert.equal((await source.updates.check()).phase, 'unsupported')
  assert.equal(source.center.requests.length, 0)
})

test('a changed account or a reconnect means checking again, never installing the old decision', async (t) => {
  const { network, actions, updates } = await setup(t)
  await updates.check()
  network.userId = 'usr-2'
  const drifted = await updates.download()
  assert.equal(drifted.phase, 'error')
  assert.match(drifted.text, /网络或账号刚刚变过/)
  network.userId = null
  await updates.check()
  await updates.download()
  // Reconnecting: no context, and the gate says connecting.
  network.status = 'applying'
  const blocked = await updates.install()
  assert.equal(blocked.phase, 'error')
  assert.doesNotMatch(blocked.text, /http|\/internal/)
  assert.deepEqual(actions, [], 'no installer, no cleanup, no exit')
})

test('a Release Center that answers for another package is refused, with a fixed text', async (t) => {
  const { updates } = await setup(t, { identityPackage: 'compass' })
  const state = await updates.check()
  assert.equal(state.phase, 'error')
  assert.match(state.text, /发布身份/)
  assert.doesNotMatch(state.text, /compass/)
})

test('the projection keeps unknown totals unknown and raw errors out', () => {
  const state = {
    phase: 'downloading',
    currentVersion: '0.8.0',
    targetVersion: '0.9.0',
    releaseNotes: null,
    bytesReceived: 1024,
    totalBytes: null,
    percent: null,
    reason: 'GET http://10.88.100.5:18090/internal/v1/release-artifacts/x failed',
    error: null,
    stagedPath: '/Users/someone/Library/Application Support/MX Rig/updates/x.dmg'
  }
  const shown = publicUpdate(state, { installId: 'inst-1', platform: 'win32' })
  assert.deepEqual(shown.progress, { bytes: 1024, total: null, percent: null })
  assert.equal(shown.busy, true)
  assert.equal(shown.actions.cancel, true)
  const failed = publicUpdate({ ...state, phase: 'error', error: state.reason }, { platform: 'win32' })
  assert.equal(failed.progress, null)
  assert.doesNotMatch(JSON.stringify([shown, failed]), /10\.88|internal|Users|stagedPath/)
  const ready = publicUpdate({ ...state, phase: 'ready' }, { platform: 'win32' })
  assert.match(ready.text, /运行安装程序/)
})

test("the product network offers Release Center only while ready, and only at Rig's own VIP", () => {
  const network = new LauncherNetwork({ dir: tmpdir(), sdk: {}, safeStorage: {} })
  const at = (connection, identity = { kind: 'anonymous', userId: null }) => {
    network.state = { installId: 'inst-9', identity, connection }
    return [network.releaseContext(), network.updateGate()]
  }
  assert.deepEqual(at({ status: 'applying' }), [null, 'connecting'])
  assert.deepEqual(at({ status: 'pending', serviceVip: '10.88.100.5', internalBaseUrl: 'http://10.88.100.5:18090' }), [null, 'recovering'])
  assert.deepEqual(at({ status: 'ready', serviceVip: '10.88.100.5', internalBaseUrl: 'http://10.88.100.5:18090' }), [
    { baseUrl: 'http://10.88.100.5:18090', installId: 'inst-9', userId: null },
    'connected'
  ])
  assert.equal(at({ status: 'ready', serviceVip: '10.88.100.5', internalBaseUrl: 'http://10.88.100.5:18090' }, { kind: 'user', userId: 'usr-1' })[0].userId, 'usr-1')
  assert.equal(at({ status: 'ready', serviceVip: '10.88.100.5', internalBaseUrl: 'http://10.88.88.88:18090' })[0], null, "never another product's VIP")
  assert.deepEqual(at({ status: 'idle' }), [null, 'idle'])
})
