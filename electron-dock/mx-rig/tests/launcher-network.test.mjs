import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LauncherNetwork, PRODUCT_ID, SERVICE_IDENTITY } from '../apps/desktop/launcher-network.mjs'

// docs/25 §3.3: the desktop as Launcher's standalone product mx-rig. Its own
// lease and VIP only, a token that travels through the tunnel and stays in
// memory, and nothing of another product's network.

const VIP = '10.88.100.21'
const BOOTSTRAP = 'http://116.62.51.154:18090'

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`),
  decryptString: (buffer) => Buffer.from(buffer.toString().slice(7), 'base64').toString()
}

function fixture({ product = { productId: PRODUCT_ID, mode: 'standalone', networkScope: 'owner', enabled: true, serviceVip: VIP }, rigReady = true, routeProduct = PRODUCT_ID, apply = { ok: true, state: 'network-ready', message: 'ok' }, storage = safeStorage } = {}) {
  const calls = { connect: [], apply: [], stop: [], fetch: [], clients: [] }
  let leases = 0
  const sdk = {
    resolveElectronLauncherBootstrap: async ({ candidates }) => ({ ok: true, baseUrl: candidates[0].url, message: 'ok' }),
    createLauncherWireGuardKeyPair: () => ({ privateKey: 'private-key', publicKey: 'public-key' }),
    createElectronLauncher: (options) => {
      calls.clients.push(options.baseUrl)
      return {
        mode: 'standalone',
        getProduct: async (id) => {
          if (!product) throw new Error('404 product not found')
          return { ...product, requested: id }
        },
        connectNetwork: async (input) => {
          calls.connect.push(input)
          leases += 1
          const kind = input.identityKind
          return {
            lease: { leaseId: `lease-${leases}`, capability: input.newLeaseCapability, productId: PRODUCT_ID, installId: options.installId, identityKind: kind, userId: input.userId ?? null, leaseIp: '10.120.0.7', serviceVip: VIP },
            routePlan: { productId: routeProduct, leaseCidr: '10.120.0.0/16', serviceVip: VIP, routeCidrs: ['0.0.0.0/0'] },
            snapshot: { signatures: { digest: 'd' } }
          }
        }
      }
    },
    applyElectronLauncherStandaloneDataPlane: async (input) => {
      calls.apply.push(input)
      return apply
    },
    stopElectronLauncherStandaloneDataPlane: async (input) => {
      calls.stop.push(input)
      return { ok: true, message: 'stopped' }
    }
  }
  const fetchImpl = async (url, init = {}) => {
    calls.fetch.push({ url, init })
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.endsWith('/domestic-peer/sync')) return json(200, { ok: true })
    if (url === `http://${VIP}:18090/healthz`) return json(200, { ok: true })
    if (url === `http://${VIP}/readyz`) return rigReady ? json(200, { ok: true }) : json(502, {})
    if (url.endsWith('/internal/v1/sdk/oauth/token')) {
      const body = JSON.parse(init.body)
      if (body.password !== 'right') return json(401, { message: '账号或密码错误' })
      return json(200, { token: { access_token: 'mx-v1-user-token', subject: 'user:u-42', principal: { userId: 'u-42', displayName: '测试员' }, scope: 'auth.read' } })
    }
    if (url.endsWith('/release')) return json(200, { lease: { status: 'released' } })
    return json(404, {})
  }
  return { sdk, fetchImpl, calls, storage }
}

const open = async (f, events = []) =>
  LauncherNetwork.open({ dir: await mkdtemp(join(tmpdir(), 'rig-launcher-')), sdk: f.sdk, safeStorage: f.storage, fetchImpl: f.fetchImpl, appVersion: '0.8.0', onChange: (snap) => events.push(snap.status) })

test('connecting: an anonymous lease, a tunnel for its own range and VIP only, and the Rig service behind the VIP', async () => {
  const f = fixture()
  const events = []
  const network = await open(f, events)
  const snap = await network.connect()
  assert.equal(snap.status, 'ready')
  assert.equal(snap.serverUrl, `http://${VIP}`)
  assert.equal(snap.serverReachable, true)
  assert.deepEqual(events.slice(0, 4), ['resolving', 'enrolling', 'applying', 'ready'])
  assert.equal(f.calls.clients[0], BOOTSTRAP, 'the anonymous lease goes through the public bootstrap')
  const [connect] = f.calls.connect
  assert.deepEqual([connect.identityKind, connect.leaseProfile, connect.accessToken], ['anonymous', 'anonymous', undefined])
  const [apply] = f.calls.apply
  assert.deepEqual(apply.routeCidrs, ['10.120.0.0/16', `${VIP}/32`], 'never the 0.0.0.0/0 the plan offered')
  assert.deepEqual([apply.dnsDomains, apply.dnsHosts, apply.dnsZones, apply.suppressWireGuardDns], [[], [], [], true], 'no system DNS')
  assert.equal(apply.allowSystemFallback, false)
  assert.equal(apply.darwinServiceIdentity, SERVICE_IDENTITY)
  assert.match(apply.ownerId, /^mx-rig:/)
  // The state file holds no key or capability in the clear.
  const saved = await readFile(join(network.dir, 'mx-rig-launcher.json'), 'utf8')
  assert.doesNotMatch(saved, /private-key|mxlc1\./)
  assert.equal(JSON.parse(saved).connectedOnce, true)
})

test('an unregistered product says what to do; so does a Rig service not yet behind the VIP', async () => {
  const missing = await (await open(fixture({ product: null }))).connect()
  assert.equal(missing.status, 'error')
  assert.match(missing.message, /scripts\/manage\.sh launcher plan/)
  const embed = await (await open(fixture({ product: { productId: PRODUCT_ID, mode: 'embed', networkScope: 'broker-session', serviceVip: VIP } }))).connect()
  assert.match(embed.message, /独立端/)
  const noRig = await (await open(fixture({ rigReady: false }))).connect()
  assert.equal(noRig.status, 'ready')
  assert.equal(noRig.serverReachable, false)
  assert.match(noRig.message, /反代路由/)
})

test('a route plan for another product is refused, and nothing is applied', async () => {
  const f = fixture({ routeProduct: 'mx-h2i' })
  const snap = await (await open(f)).connect()
  assert.equal(snap.status, 'error')
  assert.equal(f.calls.apply.length, 0)
})

test('signing in goes through the VIP, keeps the token in memory, and swaps to a user lease', async () => {
  const f = fixture()
  const network = await open(f)
  await network.connect()
  await assert.rejects(network.signIn({ account: 'tester', password: 'wrong' }), /账号或密码错误/)
  const snap = await network.signIn({ account: 'tester', password: 'right' })
  assert.equal(snap.status, 'ready')
  assert.deepEqual(snap.identity, { kind: 'user', displayName: '测试员' })
  const token = f.calls.fetch.find((call) => call.url.endsWith('/oauth/token'))
  assert.equal(new URL(token.url).hostname, VIP, 'the password never goes to the public bootstrap')
  const user = f.calls.connect.at(-1)
  assert.deepEqual([user.identityKind, user.leaseProfile, user.userId, user.accessToken], ['user', 'employee', 'u-42', 'mx-v1-user-token'])
  assert.equal(f.calls.clients.at(-1), `http://${VIP}:18090`, 'the user lease is asked for inside the tunnel')
  assert.match(user.leaseCapability, /mxlc1\./, 'the anonymous lease is presented for the handover')
  const saved = await readFile(join(network.dir, 'mx-rig-launcher.json'), 'utf8')
  assert.doesNotMatch(saved, /mx-v1-user-token|right/)
  // Signing out goes back to an anonymous lease: the login page still reaches the service.
  const out = await network.signOut()
  assert.deepEqual([out.status, out.identity.kind, f.calls.connect.at(-1).identityKind], ['ready', 'anonymous', 'anonymous'])
})

test('no secure storage, no connection; a conflict with another network is reported, not forced', async () => {
  const noStorage = await (await open(fixture({ storage: { isEncryptionAvailable: () => false } }))).connect()
  assert.match(noStorage.message, /钥匙串/)
  const conflict = await (await open(fixture({ apply: { ok: false, state: 'ownership-conflict', message: 'route 10.120.0.0/16 owned by another product' } }))).connect()
  assert.equal(conflict.status, 'error')
  assert.match(conflict.message, /冲突/)
})

test('quitting after a connection that never reached the tunnel touches nothing on the system', async () => {
  const f = fixture({ product: null })
  const network = await open(f)
  assert.equal((await network.connect()).status, 'error')
  assert.equal((await network.disconnect('shutdown')).status, 'idle')
  assert.equal(f.calls.stop.length, 0, 'no data plane was applied, so none is stopped')
})

test('disconnecting stops only this tunnel and releases the leases', async () => {
  const f = fixture()
  const network = await open(f)
  await network.connect()
  const snap = await network.disconnect('manual')
  assert.equal(snap.status, 'idle')
  assert.equal(f.calls.stop.length, 1)
  assert.match(f.calls.stop[0].ownerId, /^mx-rig:/)
  assert.ok(f.calls.fetch.some((call) => call.url.endsWith('/leases/lease-1/release')))
  assert.equal(Object.keys(network.vault.leaseCredentials).length, 0)
})
