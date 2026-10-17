import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronLauncher } from '@qpjoy/electron-launcher'
import { LauncherNetwork, PRODUCT_ID } from '../apps/desktop/launcher-network.mjs'

const BOOTSTRAP = 'https://bootstrap.example.test'
const VIP = '10.88.100.21'
const INTERNAL = `http://${VIP}:18090`
const CIDR = '10.94.0.0/16'
const ANONYMOUS_IP = '10.94.200.7'
const USER_IP = '10.94.0.7'
const PASSWORD = 'test-password-kept-off-disk'
const TOKEN = 'test-user-token-kept-off-disk'
const CAPABILITY = /^mxlc1\.[A-Za-z0-9_-]{43}$/
// RFC 7748 Alice key material: deterministic and valid for the real SDK's
// public/private key validation, without invoking an OS tunnel or key store.
const KEY_PAIR = {
  privateKey: Buffer.from('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a', 'hex').toString('base64'),
  publicKey: Buffer.from('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a', 'hex').toString('base64')
}
const storageKey = Buffer.alloc(32, 19)
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString(value) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', storageKey, iv)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
  },
  decryptString(value) {
    const decipher = createDecipheriv('aes-256-gcm', storageKey, value.subarray(0, 12))
    decipher.setAuthTag(value.subarray(12, 28))
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
  }
}
const json = (status, value) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' }
})
const capabilities = (headers) => (headers.get('x-mx-lease-capability') ?? '').split(',').filter(Boolean)

function snapshotFor(lease) {
  return {
    snapshotId: `snapshot-${lease.generation}`,
    signatures: { digest: `digest-${lease.generation}` },
    overlayPolicy: { productId: PRODUCT_ID, launcherMode: 'standalone', identityKind: lease.identityKind, leaseIp: lease.leaseIp, cidr: CIDR },
    topology: {
      product: { serviceVip: VIP, internalControlIp: VIP, domesticGatewayIp: '10.88.0.1', dnsServer: VIP },
      internal: { baseUrl: INTERNAL, relayPeer: { fixedIp: VIP } },
      domestic: { siteId: 'domestic-test', gatewayIp: '10.88.0.1' },
      oversea: { siteId: 'oversea-test' },
      relayPlan: {
        domesticRelay: { publicEndpoint: 'relay.example.test:51280', publicKey: KEY_PAIR.publicKey },
        refreshHint: { materialDigest: 'test-material', secretUpdatedAt: '2026-01-01T00:00:00.000Z' },
        internalDirectPeer: { enabled: false },
        routes: { internalCidrs: [CIDR, `${VIP}/32`], dnsServer: VIP },
        homePeer: { allowedIps: [`${lease.leaseIp}/32`] }
      }
    }
  }
}

// Real installed Electron Launcher → standalone → core client serialization,
// with only HTTP and OS effects replaced. In particular, connectNetwork is not
// mocked: it must enroll, use the returned capability for snapshot, and derive
// the route plan from that snapshot before returning to Rig.
function fixture(options = {}) {
  const leases = new Map()
  const transitions = new Map()
  const calls = { sdk: [], enroll: [], snapshot: [], release: [], peer: [], apply: [] }
  const state = { generation: 0, localIp: null, allowedIps: new Set(), snapshotRejected: false }
  const latestAnonymous = (installId) => {
    const records = [...leases.values()].filter((lease) => lease.installId === installId && lease.identityKind === 'anonymous')
      .sort((a, b) => b.generation - a.generation)
    return records.find((lease) => lease.status === 'active') ?? records[0]
  }
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url)
    assert.ok([BOOTSTRAP, INTERNAL, `http://${VIP}`].includes(parsed.origin), `unexpected test URL: ${url}`)
    const body = init.body ? JSON.parse(init.body) : {}
    const headers = new Headers(init.headers)
    const path = parsed.pathname
    const request = { url, body, headers: Object.fromEntries(headers) }
    const denied = (message) => json(401, { message })
    if (parsed.hostname === VIP && (!state.localIp || !state.allowedIps.has(state.localIp)))
      throw new Error('simulated VIP tunnel is unavailable')
    if (parsed.origin === BOOTSTRAP) {
      assert.equal(headers.get('authorization'), null, 'no bearer may travel to public bootstrap')
      assert.equal(body.password, undefined)
    }
    if (path.endsWith(`/products/${PRODUCT_ID}`))
      return json(200, { product: { productId: PRODUCT_ID, mode: 'standalone', networkScope: 'owner', enabled: true, serviceVip: VIP } })
    if (path === '/internal/v1/sdk/oauth/token') {
      assert.equal(body.password, PASSWORD)
      return json(200, { token: { access_token: TOKEN, principal: { userId: 'u-42', displayName: 'Tester' } } })
    }
    if (path === '/healthz' || path === '/readyz') return json(200, { status: 'ready' })
    if (path === '/internal/v1/launcher-network/enrollments') {
      const proof = capabilities(headers)
      const nextCapability = headers.get('x-mx-new-lease-capability')
      calls.enroll.push({ ...request, proof, nextCapability })
      assert.match(nextCapability ?? '', CAPABILITY)
      assert.equal(body.leaseCapability, undefined, 'the real SDK must move capabilities into headers')
      assert.equal(body.newLeaseCapability, undefined)
      assert.equal(body.accessToken, undefined)
      assert.equal(body.publicKey, KEY_PAIR.publicKey)
      assert.equal(body.productId, PRODUCT_ID)
      assert.ok(proof.length <= 16, 'the server accepts at most 16 capability candidates')
      const previousAnonymous = latestAnonymous(body.installId)
      if (previousAnonymous && (previousAnonymous.deviceId !== body.deviceId || previousAnonymous.publicKey !== body.publicKey))
        return denied('existing anonymous install requires its original device and key')
      // This check applies to user enrollment too, and released records retain
      // the capability digest required to prove the same installation later.
      if (previousAnonymous && !proof.includes(previousAnonymous.capability))
        return denied('latest anonymous lease capability required, even when released')
      if (body.identityKind === 'user' && headers.get('authorization') !== `Bearer ${TOKEN}`)
        return denied('user bearer required')
      const active = [...leases.values()].filter((lease) => lease.status === 'active' && lease.publicKey === body.publicKey)
      const sameIdentity = active.find((lease) => lease.identityKind === body.identityKind && lease.userId === (body.userId ?? null))
      for (const existing of active) {
        if (existing === sameIdentity && existing.identityKind === 'user') continue
        if (!proof.includes(existing.capability)) return denied('another active lease for this public key requires its capability')
      }
      const generation = ++state.generation
      const lease = {
        leaseId: sameIdentity?.leaseId ?? `lease-${generation}`,
        generation,
        productId: PRODUCT_ID,
        installId: body.installId,
        deviceId: body.deviceId,
        publicKey: body.publicKey,
        siteId: 'domestic-test', domesticSiteId: 'domestic-test',
        launcherMode: 'standalone',
        identityKind: body.identityKind,
        leaseProfile: body.leaseProfile,
        userId: body.userId ?? null,
        leaseIp: body.identityKind === 'user' ? USER_IP : ANONYMOUS_IP,
        status: 'active',
        capability: nextCapability
      }
      leases.set(lease.leaseId, lease)
      const returned = { ...lease }
      if (body.identityKind === 'user' && previousAnonymous && options.rotateAnonymousOnUserEnrollment) {
        previousAnonymous.capability = nextCapability
        returned.handoverLeases = [{ ...previousAnonymous }]
      }
      return json(200, { lease: returned })
    }
    if (path === '/internal/v1/launcher-network/snapshots') {
      calls.snapshot.push(request)
      const lease = leases.get(body.leaseId)
      if (!lease || lease.status !== 'active' || !capabilities(headers).includes(lease.capability))
        return denied('snapshot requires the freshly issued lease capability')
      if (lease.identityKind === 'user' && headers.get('authorization') !== `Bearer ${TOKEN}`)
        return denied('user snapshot requires bearer')
      if (lease.identityKind === 'user' && options.failUserSnapshotOnce && !state.snapshotRejected) {
        state.snapshotRejected = true
        return denied('simulated snapshot failure after enrollment committed')
      }
      return json(200, { snapshot: snapshotFor(lease) })
    }
    const operation = path.match(/\/leases\/([^/]+)\/(release|domestic-peer\/sync)$/)
    if (!operation) throw new Error(`Unexpected fake-server request: ${path}`)
    const lease = leases.get(operation[1])
    const release = operation[2] === 'release'
    if (release) calls.release.push(request)
    else calls.peer.push(request)
    if (!lease || !capabilities(headers).includes(lease.capability)) return denied('lease capability mismatch')
    if (release) {
      lease.status = 'released'
      return json(200, { lease: { ...lease } })
    }
    if (lease.status !== 'active') return denied('primary peer lease must be active')
    const phase = body.handoverPhase
    if (phase) {
      const other = leases.get(body.peerLeaseId)
      const previous = transitions.get(body.transitionId)
      if (!other || headers.get('x-mx-peer-lease-capability') !== other.capability)
        return denied('handover peer capability mismatch')
      if (other.status !== 'active' && !['committed', 'aborted'].includes(previous?.status))
        return denied('handover peer is already released')
      if (phase === 'prepare') {
        transitions.set(body.transitionId, { status: 'prepared', oldId: other.leaseId, newId: lease.leaseId })
        state.allowedIps = new Set([lease.leaseIp, other.leaseIp])
      } else {
        if (!previous) return denied('handover transition missing')
        previous.status = phase === 'commit' ? 'committed' : 'aborted'
        other.status = 'released'
        state.allowedIps = new Set([lease.leaseIp])
      }
    } else state.allowedIps = new Set([lease.leaseIp])
    if (parsed.hostname === VIP && !state.allowedIps.has(state.localIp))
      throw new Error('peer operation cut its own VIP return path')
    return json(200, { lease: { ...lease }, domesticPeerSync: { status: 'passed', execution: 'executed' } })
  }
  const sdk = {
    createElectronLauncher: (clientOptions) => {
      calls.sdk.push(clientOptions)
      return createElectronLauncher({ ...clientOptions, fetchImpl })
    },
    createLauncherWireGuardKeyPair: () => ({ ...KEY_PAIR }),
    resolveElectronLauncherBootstrap: async () => ({ ok: true, baseUrl: BOOTSTRAP }),
    applyElectronLauncherStandaloneDataPlane: async (input) => {
      calls.apply.push(input)
      state.localIp = input.routePlan.leaseIp
      return { ok: true, state: 'network-ready', message: 'ok' }
    },
    stopElectronLauncherStandaloneDataPlane: async () => {
      state.localIp = null
      return { ok: true }
    }
  }
  return { sdk, fetchImpl, calls, leases, transitions, state, latestAnonymous }
}

async function open(t, f, dir) {
  if (!dir) {
    dir = await mkdtemp(join(tmpdir(), 'rig-renewal-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
  }
  return LauncherNetwork.open({ dir, sdk: f.sdk, fetchImpl: f.fetchImpl, safeStorage, config: { bootstrapUrls: [BOOTSTRAP] } })
}
async function vault(network) {
  const raw = await readFile(join(network.dir, 'mx-rig-launcher.json'), 'utf8')
  assert.equal(raw.includes(KEY_PAIR.privateKey), false)
  assert.doesNotMatch(raw, /mxlc1\.|test-user-token-kept-off-disk|test-password-kept-off-disk/)
  const file = JSON.parse(raw)
  return JSON.parse(safeStorage.decryptString(Buffer.from(file.vault, 'base64')))
}
const signIn = (network) => network.signIn({ account: 'tester', password: PASSWORD })
const assertReady = (snap) => assert.equal(snap.status, 'ready', snap.message)
function assertLatestProof(f, requestIndex, capability) {
  assert.ok(f.calls.enroll[requestIndex].proof.includes(capability), 'renewal must present the previous anonymous proof')
  assert.notEqual(f.calls.enroll[requestIndex].nextCapability, capability, 'successful enrollment rotates its capability')
}

test('real SDK renews the same active anonymous lease with old proof and uses the rotated capability for snapshot', async (t) => {
  const f = fixture()
  const network = await open(t, f)
  assertReady(await network.connect())
  const before = f.latestAnonymous(network.state.installId)
  const oldCapability = before.capability
  assertReady(await network.connect())
  assert.equal(f.leases.size, 1, 'active same-profile enrollment reuses its leaseId')
  assert.equal(f.latestAnonymous(network.state.installId).leaseId, before.leaseId)
  assertLatestProof(f, 1, oldCapability)
  assert.equal(f.calls.snapshot[1].headers['x-mx-lease-capability'], f.calls.enroll[1].nextCapability)
  assert.equal((await vault(network)).leaseCredentials[before.leaseId].capability, f.calls.enroll[1].nextCapability)
})

test('disconnect and reopen preserve released anonymous proof without releasing it twice', async (t) => {
  const f = fixture()
  const network = await open(t, f)
  assertReady(await network.connect())
  const initial = f.latestAnonymous(network.state.installId)
  const capability = initial.capability
  assert.equal((await network.disconnect()).status, 'idle')
  const saved = await vault(network)
  assert.equal(saved.leaseCredentials[initial.leaseId].status, 'released')
  assert.equal(saved.leaseCredentials[initial.leaseId].capability, capability)
  assert.equal(initial.capability, capability, 'release does not erase the server capability proof')
  const reopened = await open(t, f, network.dir)
  await reopened.disconnect()
  assert.equal(f.calls.release.length, 1, 'already-released local records are not sent to release again')
  assertReady(await reopened.connect())
  assertLatestProof(f, 1, capability)
  assert.notEqual(f.latestAnonymous(network.state.installId).leaseId, initial.leaseId)
  assert.equal(f.calls.snapshot.at(-1).headers['x-mx-lease-capability'], f.calls.enroll.at(-1).nextCapability)
})

test('anonymous proof retired by user handover survives user disconnect and anonymous restart', async (t) => {
  const f = fixture()
  const network = await open(t, f)
  assertReady(await network.connect())
  const anonymous = f.latestAnonymous(network.state.installId)
  const capability = anonymous.capability
  assertReady(await signIn(network))
  assert.equal(anonymous.status, 'released')
  assert.equal((await vault(network)).leaseCredentials[anonymous.leaseId].status, 'released')
  await network.disconnect()
  assert.equal(f.calls.release.length, 1, 'only the active user lease needs explicit release')
  assert.notEqual(f.calls.release[0].url.split('/').at(-2), anonymous.leaseId)
  const reopened = await open(t, f, network.dir)
  assertReady(await reopened.connect())
  assertLatestProof(f, 2, capability)
  assert.equal(reopened.snapshot().identity.kind, 'anonymous')
})

test('signOut proves both the retired anonymous installation and the active user peer', async (t) => {
  const f = fixture()
  const network = await open(t, f)
  assertReady(await network.connect())
  const oldAnonymous = f.latestAnonymous(network.state.installId)
  assertReady(await signIn(network))
  const user = [...f.leases.values()].find((lease) => lease.identityKind === 'user')
  assertReady(await network.signOut())
  const renewal = f.calls.enroll.at(-1)
  assert.ok(renewal.proof.includes(oldAnonymous.capability))
  assert.ok(renewal.proof.includes(user.capability))
  assert.equal(renewal.headers.authorization, undefined)
  assert.equal(user.status, 'released')
  assert.equal(network.snapshot().identity.kind, 'anonymous')
  assert.equal(f.transitions.size, 2)
})

test('released credential history is bounded while every restart preserves the latest anonymous proof', async (t) => {
  const f = fixture()
  let network = await open(t, f)
  let previousCapability = null
  for (let iteration = 0; iteration < 24; iteration += 1) {
    assertReady(await network.connect())
    if (previousCapability) assertLatestProof(f, f.calls.enroll.length - 1, previousCapability)
    // Retire user leases too, so pruning is exercised with a growing history
    // rather than only anonymous records that can be superseded immediately.
    assertReady(await signIn(network))
    assertReady(await network.signOut())
    const latest = f.latestAnonymous(network.state.installId)
    previousCapability = latest.capability
    await network.disconnect()
    const saved = await vault(network)
    assert.ok(Object.keys(saved.leaseCredentials).length <= 16)
    assert.equal(saved.leaseCredentials[latest.leaseId].capability, previousCapability)
    assert.equal(saved.leaseCredentials[latest.leaseId].generation, latest.generation)
    assert.equal(saved.leaseCredentials[latest.leaseId].status, 'released')
    network = await open(t, f, network.dir)
  }
  assert.equal(f.calls.release.length, 24)
  assert.equal(new Set(f.calls.release.map(({ url }) => url)).size, 24, 'old released proof records are never repeatedly released')
})

test('a capability issued before a failed snapshot remains available to anonymous renewal after restart', async (t) => {
  const f = fixture({ rotateAnonymousOnUserEnrollment: true, failUserSnapshotOnce: true })
  const network = await open(t, f)
  assertReady(await network.connect())
  const anonymous = f.latestAnonymous(network.state.installId)
  const oldCapability = anonymous.capability
  assert.equal((await signIn(network)).status, 'error')
  assert.equal(f.state.snapshotRejected, true)
  const issued = f.calls.enroll[1].nextCapability
  assert.equal(anonymous.capability, issued)
  const failed = await vault(network)
  assert.equal(failed.leaseCredentials[anonymous.leaseId].capability, oldCapability, 'the SDK never returned the enrollment result to Rig')
  assert.equal(failed.pendingCapabilities['user:u-42'], issued)
  await network.disconnect()
  assert.equal(f.calls.release.at(-1).headers['x-mx-lease-capability'], oldCapability)
  assert.equal(anonymous.status, 'active', 'stale capability cannot release the server lease')
  const reopened = await open(t, f, network.dir)
  assertReady(await reopened.connect())
  assert.ok(f.calls.enroll[2].proof.includes(issued), 'another identity must present the outstanding user capability too')
  assert.equal(f.calls.enroll[2].headers.authorization, undefined)
  assert.equal(f.calls.snapshot.at(-1).headers['x-mx-lease-capability'], f.calls.enroll[2].nextCapability)
})
