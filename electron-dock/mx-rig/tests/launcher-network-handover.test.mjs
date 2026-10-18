import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LauncherNetwork, PRODUCT_ID } from '../apps/desktop/launcher-network.mjs'

const VIP = '10.88.100.21'
const INTERNAL = `http://${VIP}:18090`
const BOOTSTRAP = 'https://bootstrap.example.test'
const ANONYMOUS_IP = '10.94.200.7'
const USER_IP = '10.94.0.7'
const USER_TOKEN = 'private-user-bearer'
const PASSWORD = 'private-user-password'
const PUBLIC_KEY = 'same-device-public-key'
const ROTATED_CAPABILITY = `mxlc1.${'R'.repeat(43)}`
const PEERS = ['domestic', 'internal']

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(Buffer.from(value).toString('base64')),
  decryptString: (value) => Buffer.from(value.toString(), 'base64').toString()
}
const json = (status, value) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' }
})

// Model the contract that matters here: one WireGuard public key, two distinct
// lease IPs, and a control request whose response also needs its current IP.
// No real Launcher SDK, socket, tunnel, or OS command participates in this test.
function fixture(options = {}) {
  const calls = { enroll: [], apply: [], stop: [], requests: [], events: [], statuses: [] }
  const leases = new Map()
  const transitions = new Map()
  const allowed = Object.fromEntries(PEERS.map((peer) => [peer, new Set()]))
  const state = { localIp: null, blockVipPeers: false, lostCommit: false, failedAbort: false, handoverDeadlineExpired: false }
  const routePlan = (leaseIp) => ({
    productId: PRODUCT_ID,
    serviceVip: VIP,
    leaseIp,
    leaseCidr: '10.94.0.0/16',
    routeCidrs: ['0.0.0.0/0'],
    domesticRelayEndpoint: 'relay.example.test:51280',
    domesticRelayPublicKey: 'relay-public-key',
    h2iDirectEnabled: true,
    h2iDirectEndpoint: 'internal.example.test:51280',
    h2iDirectPublicKey: 'internal-public-key'
  })
  const publicLease = (lease) => ({ ...lease })
  const requireTunnel = () => {
    if (!state.localIp || !allowed.domestic.has(state.localIp))
      throw new Error('VIP response lost: the current tunnel IP is no longer allowed')
  }
  const sdk = {
    resolveElectronLauncherBootstrap: async () => ({ ok: true, baseUrl: BOOTSTRAP }),
    createLauncherWireGuardKeyPair: () => ({ privateKey: 'private-device-key', publicKey: PUBLIC_KEY }),
    createElectronLauncher: (client) => ({
      getProduct: async () => ({ productId: PRODUCT_ID, mode: 'standalone', networkScope: 'owner', enabled: true, serviceVip: VIP }),
      connectNetwork: async (input) => {
        if (input.identityKind === 'user') requireTunnel()
        calls.enroll.push({ ...input, baseUrl: client.baseUrl })
        const lease = {
          leaseId: `lease-${leases.size + 1}`,
          capability: input.newLeaseCapability,
          productId: PRODUCT_ID,
          installId: client.installId,
          deviceId: client.deviceId,
          publicKey: input.publicKey,
          identityKind: input.identityKind,
          userId: input.userId ?? null,
          leaseIp: input.identityKind === 'user' ? USER_IP : ANONYMOUS_IP,
          generation: leases.size + 1,
          status: 'active'
        }
        assert.equal(lease.publicKey, PUBLIC_KEY)
        const previous = [...leases.values()].at(-1)
        leases.set(lease.leaseId, lease)
        const returned = publicLease(lease)
        if (previous && options.rotateCapability) {
          previous.capability = ROTATED_CAPABILITY
          returned.handoverLeases = [publicLease(previous)]
        }
        calls.events.push(`enroll:${lease.leaseIp}`)
        return { lease: returned, routePlan: routePlan(lease.leaseIp) }
      }
    }),
    applyElectronLauncherStandaloneDataPlane: async (input) => {
      const ip = input.routePlan.leaseIp
      calls.apply.push({ ip, allowed: Object.fromEntries(PEERS.map((peer) => [peer, [...allowed[peer]]])), input })
      calls.events.push(`apply:${ip}`)
      // A failed apply may still have changed the OS address. Rollback must
      // explicitly restore the old plan before abort removes the new peer IP.
      state.localIp = ip
      if (ip === USER_IP && options.failApply)
        return { ok: false, state: 'service-unreachable', message: 'simulated apply failure' }
      return { ok: true, state: 'network-ready', message: 'ok' }
    },
    stopElectronLauncherStandaloneDataPlane: async (input) => {
      calls.stop.push(input)
      state.localIp = null
      return { ok: true }
    }
  }
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url)
    const body = init.body ? JSON.parse(init.body) : {}
    const headers = new Headers(init.headers)
    calls.requests.push({ url, body, headers: Object.fromEntries(headers) })
    const throughVip = parsed.hostname === VIP
    if (throughVip) requireTunnel()
    if (parsed.pathname.endsWith('/oauth/token')) {
      assert.equal(parsed.origin, INTERNAL)
      assert.equal(body.password, PASSWORD)
      return json(200, { token: { access_token: USER_TOKEN, principal: { userId: 'u-42', displayName: 'Tester' } } })
    }
    if (['/healthz', '/readyz'].includes(parsed.pathname)) {
      calls.events.push(`probe:${state.localIp}:${parsed.pathname}`)
      return json(state.localIp === USER_IP && options.failProbe === parsed.pathname ? 503 : 200, { status: 'ready' })
    }
    const match = parsed.pathname.match(/\/leases\/([^/]+)\/(domestic-peer|internal-direct-peer)\/sync$/)
    if (!match) return json(404, {})
    if (throughVip && state.blockVipPeers) throw new Error('simulated unavailable VIP control path')
    const peer = match[2] === 'domestic-peer' ? 'domestic' : 'internal'
    const key = peer === 'domestic' ? 'domesticPeerSync' : 'internalDirectPeerSync'
    const target = leases.get(match[1])
    const other = leases.get(body.peerLeaseId)
    const phase = body.handoverPhase ?? 'single'
    const transition = transitions.get(body.transitionId)
    const terminal = ['committed', 'aborted'].includes(transition?.status)
    if (!target || target.status !== 'active' || headers.get('x-mx-lease-capability') !== target.capability)
      return json(401, { message: 'primary lease access denied' })
    if (phase !== 'single' && (!other || headers.get('x-mx-peer-lease-capability') !== other.capability || (other.status !== 'active' && !terminal)))
      return json(401, { message: 'peer lease access denied' })
    if (['prepare', 'commit'].includes(phase) && state.handoverDeadlineExpired)
      return json(401, { message: 'handover deadline expired' })
    calls.events.push(`${phase}:${peer}:${target.leaseIp}`)
    if (phase === 'single') {
      if ([...transitions.values()].some((entry) => !['committed', 'aborted'].includes(entry.status)))
        return json(401, { message: 'active transition required' })
      allowed[peer] = new Set([target.leaseIp])
    } else {
      if (!body.transitionId) return json(401, { message: 'transitionId required' })
      let current = transition
      if (!current && phase === 'prepare') {
        current = { oldId: other.leaseId, newId: target.leaseId, status: 'preparing', prepared: new Set(), finished: new Set() }
        transitions.set(body.transitionId, current)
      }
      if (!current) return json(401, { message: 'transition missing' })
      const old = leases.get(current.oldId)
      const next = leases.get(current.newId)
      assert.equal(target.leaseId, phase === 'abort' ? old.leaseId : next.leaseId)
      assert.equal(other.leaseId, phase === 'abort' ? next.leaseId : old.leaseId)
      if (phase === 'prepare') {
        if (options.failPreparePeer === peer)
          return json(200, { [key]: { status: options.failPrepareStatus ?? 'blocked', execution: 'not-started', failures: ['simulated peer failure'] } })
        allowed[peer] = new Set([old.leaseIp, next.leaseIp])
        current.prepared.add(peer)
        if (current.prepared.size === PEERS.length) current.status = 'prepared'
      } else {
        if (phase === 'commit' && current.prepared.size !== PEERS.length)
          return json(401, { message: 'all required peers must prepare before commit' })
        if (phase === 'abort' && current.status === 'committed')
          return json(401, { message: 'cannot abort committed transition' })
        if (phase === 'abort' && options.failAbortPeerOnce === peer && !state.failedAbort) {
          state.failedAbort = true
          current.status = 'abort-pending'
          return json(200, { [key]: { status: 'failed', execution: 'failed', failures: ['simulated interrupted abort'] } })
        }
        allowed[peer] = new Set([target.leaseIp])
        current.finished.add(`${phase}:${peer}`)
        current.status = `${phase}-pending`
        if (phase === 'commit' && options.loseCommitPeerResponse === peer && !state.lostCommit) {
          state.lostCommit = true
          throw new Error('simulated response loss before every peer committed')
        }
        if (PEERS.every((required) => current.finished.has(`${phase}:${required}`))) {
          current.status = phase === 'commit' ? 'committed' : 'aborted'
          other.status = 'released'
          if (phase === 'commit' && options.loseCommitResponse && !state.lostCommit) {
            state.lostCommit = true
            throw new Error('simulated response loss after server committed and retired old lease')
          }
        }
      }
    }
    if (throughVip) requireTunnel()
    return json(200, { lease: publicLease(target), [key]: { status: 'passed', execution: 'executed' } })
  }
  const expirePendingTransitions = () => {
    state.handoverDeadlineExpired = true
    for (const current of transitions.values()) {
      if (['committed', 'aborted'].includes(current.status)) continue
      const old = leases.get(current.oldId)
      assert.equal(old.status, 'active', 'TTL rollback requires an active old lease')
      for (const peer of PEERS) allowed[peer] = new Set([old.leaseIp])
      leases.get(current.newId).status = 'released'
      current.status = 'aborted'
    }
  }
  return { sdk, fetchImpl, calls, leases, transitions, allowed, state, expirePendingTransitions }
}

async function open(t, f, dir) {
  if (!dir) {
    dir = await mkdtemp(join(tmpdir(), 'rig-handover-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
  }
  return LauncherNetwork.open({ dir, sdk: f.sdk, safeStorage, fetchImpl: f.fetchImpl,
    config: { bootstrapUrls: [BOOTSTRAP] }, onChange: (snapshot) => f.calls.statuses.push(snapshot.status) })
}
async function connected(t, f) {
  const network = await open(t, f)
  assert.equal((await network.connect()).status, 'ready')
  f.calls.events.length = 0
  f.calls.statuses.length = 0
  return network
}
const signIn = (network) => network.signIn({ account: 'tester', password: PASSWORD })
const savedVault = async (network) => {
  const saved = JSON.parse(await readFile(join(network.dir, 'mx-rig-launcher.json'), 'utf8'))
  return JSON.parse(safeStorage.decryptString(Buffer.from(saved.vault, 'base64')))
}
function assertNoPublicCredentials(f) {
  for (const request of f.calls.requests.filter(({ url }) => new URL(url).origin === BOOTSTRAP)) {
    assert.equal(request.headers.authorization, undefined)
    assert.doesNotMatch(JSON.stringify(request.body), new RegExp(`${USER_TOKEN}|${PASSWORD}`))
  }
}

test('handover prepares both required peers before changing IP, probes the new tunnel, then commits', async (t) => {
  const f = fixture()
  const network = await connected(t, f)
  assert.deepEqual(f.calls.requests
    .filter(({ url, body }) => url.endsWith('/sync') && !body.handoverPhase)
    .map(({ url }) => new URL(url).pathname.split('/').at(-2)), ['domestic-peer'], 'initial anonymous connection only syncs its relay peer')
  const snap = await signIn(network)
  assert.equal(snap.status, 'ready')
  assert.equal(snap.leaseIp, USER_IP)
  assert.equal(snap.identity.kind, 'user')
  assert.deepEqual(f.calls.events, [
    `enroll:${USER_IP}`,
    `prepare:domestic:${USER_IP}`, `prepare:internal:${USER_IP}`,
    `apply:${USER_IP}`, `probe:${USER_IP}:/healthz`, `probe:${USER_IP}:/readyz`,
    `commit:domestic:${USER_IP}`, `commit:internal:${USER_IP}`
  ])
  const application = f.calls.apply.at(-1)
  assert.equal(application.input.pathPreference, 'relay', 'configured Internal peer still participates for a relay client')
  for (const peer of PEERS) {
    assert.deepEqual(application.allowed[peer], [ANONYMOUS_IP, USER_IP])
    assert.deepEqual([...f.allowed[peer]], [USER_IP])
  }
  assert.equal(f.leases.get('lease-1').status, 'released')
  assert.equal((await savedVault(network)).pendingHandover, null)
  assertNoPublicCredentials(f)
})

test('a refreshed old capability returned in handoverLeases is used throughout prepare and commit', async (t) => {
  const f = fixture({ rotateCapability: true })
  const network = await connected(t, f)
  const original = f.leases.get('lease-1').capability
  assert.equal((await signIn(network)).status, 'ready')
  assert.notEqual(original, ROTATED_CAPABILITY)
  const requests = f.calls.requests.filter(({ body }) => body.handoverPhase)
  assert.equal(requests.length, 4)
  assert.ok(requests.every(({ headers }) => headers['x-mx-peer-lease-capability'] === ROTATED_CAPABILITY))
})

for (const status of ['blocked', 'failed']) {
  test(`HTTP 200 with ${status} peer result never applies the user IP or reports ready`, async (t) => {
    const f = fixture({ failPreparePeer: 'internal', failPrepareStatus: status })
    const network = await connected(t, f)
    const snap = await signIn(network)
    assert.equal(snap.status, 'error')
    assert.equal(snap.serverReachable, false)
    assert.equal(f.calls.apply.some(({ ip }) => ip === USER_IP), false)
    assert.equal(f.calls.statuses.includes('ready'), false)
    assert.equal(f.state.localIp, ANONYMOUS_IP)
    assert.equal([...f.transitions.values()][0].status, 'aborted')
    assert.deepEqual([...f.allowed.domestic], [ANONYMOUS_IP])
  })
}

for (const failure of ['apply', '/healthz', '/readyz']) {
  test(`${failure} failure restores the old local IP before abort and does not report a completed login`, async (t) => {
    const f = fixture(failure === 'apply' ? { failApply: true } : { failProbe: failure })
    const network = await connected(t, f)
    const snap = await signIn(network)
    assert.equal(snap.status, 'error')
    assert.equal(snap.serverReachable, false)
    assert.equal(f.calls.statuses.includes('ready'), false)
    assert.deepEqual(f.calls.apply.map(({ ip }) => ip), [ANONYMOUS_IP, USER_IP, ANONYMOUS_IP])
    assert.ok(f.calls.events.indexOf(`apply:${ANONYMOUS_IP}`) < f.calls.events.indexOf(`abort:domestic:${ANONYMOUS_IP}`))
    assert.equal(f.calls.events.some((event) => event.startsWith('commit:')), false)
    assert.equal(f.state.localIp, ANONYMOUS_IP)
    assert.equal(f.leases.get('lease-2').status, 'released')
    assert.equal((await savedVault(network)).pendingHandover, null)
  })
}

for (const restart of [false, true]) {
  test(`lost commit response retains the new tunnel and retries the same transition ${restart ? 'after restart' : 'on reconnect'}`, async (t) => {
    const f = fixture({ loseCommitResponse: true })
    const network = await connected(t, f)
    const snap = await signIn(network)
    assert.equal(snap.status, 'error')
    assert.equal(f.leases.get('lease-1').status, 'released', 'the server committed before losing the response')
    assert.equal(f.state.localIp, USER_IP, 'a lost response must not restore a now-retired IP')
    const saved = await savedVault(network)
    assert.ok(saved.pendingHandover)
    assert.doesNotMatch(JSON.stringify(saved), new RegExp(`${USER_TOKEN}|${PASSWORD}`))
    const transitionId = saved.pendingHandover.transitionId
    const resumed = restart ? await open(t, f, network.dir) : network
    assert.equal((await resumed.connect()).status, 'ready')
    assert.equal(f.calls.enroll.length, 2, 'recovery must not create a newer generation')
    assert.equal(f.transitions.size, 1)
    assert.ok(f.calls.requests.filter(({ body }) => body.handoverPhase).every(({ body }) => body.transitionId === transitionId))
    assert.equal((await savedVault(resumed)).pendingHandover, null)
    assert.equal(f.calls.events.some((event) => event.startsWith('abort:')), false)
    assert.equal(f.calls.apply.slice(1).some(({ ip }) => ip === ANONYMOUS_IP), false)
    if (restart) assert.equal(resumed.overseaSession(), null, 'the user bearer is not recovered from disk')
    assertNoPublicCredentials(f)
  })
}

test('unreachable old control path retains recovery state and never sends user credentials to public bootstrap', async (t) => {
  const f = fixture()
  const network = await connected(t, f)
  f.state.blockVipPeers = true
  assert.equal((await signIn(network)).status, 'error')
  const pending = (await savedVault(network)).pendingHandover
  assert.ok(pending)
  assert.equal((await network.connect()).status, 'error')
  assert.equal(f.calls.enroll.length, 2)
  assert.equal((await savedVault(network)).pendingHandover.transitionId, pending.transitionId)
  assert.equal(f.calls.statuses.includes('ready'), false)
  assertNoPublicCredentials(f)
})

test('repeated shutdown preserves ambiguous commit credentials and resumes the same transition after reopening', async (t) => {
  const f = fixture({ loseCommitResponse: true })
  const network = await connected(t, f)
  assert.equal((await signIn(network)).status, 'error')
  const before = await savedVault(network)
  const transitionId = before.pendingHandover.transitionId
  const credentials = before.leaseCredentials
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await network.disconnect('shutdown')
    const stopped = await savedVault(network)
    assert.equal(stopped.pendingHandover.transitionId, transitionId)
    assert.deepEqual(stopped.leaseCredentials, credentials)
  }
  assert.equal(f.state.localIp, null)
  assert.equal(f.calls.stop.length, 1, 'the second shutdown has no running data plane to stop')
  assert.equal(f.calls.requests.some(({ url }) => url.endsWith('/release')), false, 'pending leases belong to the unfinished server transition')
  const reopened = await open(t, f, network.dir)
  assert.equal((await reopened.connect()).status, 'ready')
  assert.equal(f.state.localIp, USER_IP)
  assert.equal(f.calls.enroll.length, 2)
  assert.equal(f.transitions.size, 1)
  assert.equal(f.transitions.get(transitionId).status, 'committed')
  assert.equal((await savedVault(reopened)).pendingHandover, null)
  assert.equal(reopened.overseaSession(), null)
  assertNoPublicCredentials(f)
})

for (const restart of [false, true]) {
  test(`a server TTL abort after a partial commit stays unresolved ${restart ? 'after reopening' : 'on retry'} instead of enrolling or claiming ready`, async (t) => {
    const f = fixture({ loseCommitPeerResponse: 'domestic' })
    const network = await connected(t, f)
    assert.equal((await signIn(network)).status, 'error')
    const before = await savedVault(network)
    const transitionId = before.pendingHandover.transitionId
    assert.equal(f.transitions.get(transitionId).status, 'commit-pending')
    assert.equal(f.leases.get('lease-1').status, 'active')
    f.expirePendingTransitions()
    assert.equal(f.transitions.get(transitionId).status, 'aborted')
    assert.equal(f.leases.get('lease-2').status, 'released')
    for (const peer of PEERS) assert.deepEqual([...f.allowed[peer]], [ANONYMOUS_IP])
    const resumed = restart ? await open(t, f, network.dir) : network
    const snap = await resumed.connect()
    assert.equal(snap.status, 'error')
    assert.equal(snap.serverReachable, false)
    assert.equal(f.calls.statuses.includes('ready'), false)
    assert.equal(f.calls.enroll.length, 2)
    const after = await savedVault(resumed)
    assert.equal(after.pendingHandover.transitionId, transitionId)
    assert.deepEqual(after.leaseCredentials, before.leaseCredentials)
    assert.equal(f.calls.requests.some(({ url }) => url.endsWith('/release')), false)
    assertNoPublicCredentials(f)
  })
}

test('an interrupted abort resumes the same transition before any enrollment and leaves a usable anonymous connection', async (t) => {
  const f = fixture({ failProbe: '/readyz', failAbortPeerOnce: 'internal' })
  const network = await connected(t, f)
  assert.equal((await signIn(network)).status, 'error')
  const before = await savedVault(network)
  const transitionId = before.pendingHandover.transitionId
  assert.equal(before.pendingHandover.phase, 'abort')
  assert.equal(f.transitions.get(transitionId).status, 'abort-pending')
  assert.equal(f.leases.get('lease-2').status, 'active')
  assert.equal(f.state.localIp, ANONYMOUS_IP)
  f.calls.events.length = 0
  const reopened = await open(t, f, network.dir)
  const recovered = await reopened.connect()
  assert.equal(recovered.status, 'error', 'recovery must not claim that the failed user login completed')
  assert.equal(recovered.identity.kind, 'anonymous')
  assert.equal(f.calls.enroll.length, 2, 'finish the saved abort before enrolling again')
  assert.deepEqual(f.calls.events, [
    `apply:${ANONYMOUS_IP}`,
    `abort:domestic:${ANONYMOUS_IP}`, `abort:internal:${ANONYMOUS_IP}`,
    `probe:${ANONYMOUS_IP}:/healthz`, `probe:${ANONYMOUS_IP}:/readyz`
  ])
  assert.equal(f.transitions.get(transitionId).status, 'aborted')
  assert.equal(f.leases.get('lease-2').status, 'released')
  assert.equal((await savedVault(reopened)).pendingHandover, null)
  const connectedAgain = await reopened.connect()
  assert.equal(connectedAgain.status, 'ready')
  assert.equal(connectedAgain.identity.kind, 'anonymous')
  assert.equal(connectedAgain.serverReachable, true)
  assert.equal(f.state.localIp, ANONYMOUS_IP)
  assertNoPublicCredentials(f)
})

test('an expired commit retry after the server already committed retains the new IP and pending record', async (t) => {
  const f = fixture({ loseCommitResponse: true })
  const network = await connected(t, f)
  assert.equal((await signIn(network)).status, 'error')
  const before = await savedVault(network)
  const transitionId = before.pendingHandover.transitionId
  assert.equal(f.transitions.get(transitionId).status, 'committed')
  f.expirePendingTransitions()
  assert.equal(f.transitions.get(transitionId).status, 'committed', 'TTL reconciliation never aborts a completed transition')
  assert.equal(f.leases.get('lease-1').status, 'released')
  assert.equal(f.leases.get('lease-2').status, 'active')
  const snap = await network.connect()
  assert.equal(snap.status, 'error')
  assert.match(snap.message, /HTTP 401/)
  assert.match(snap.message, /接管状态无法确认.*管理员核对该 Rig 接管记录/)
  assert.equal(snap.serverReachable, false)
  assert.equal(f.calls.statuses.includes('ready'), false)
  assert.equal(f.state.localIp, USER_IP)
  assert.equal(f.calls.apply.slice(1).some(({ ip }) => ip === ANONYMOUS_IP), false)
  assert.equal(f.calls.enroll.length, 2)
  assert.equal(f.calls.requests.some(({ url, body }) => url.endsWith('/release') || body.handoverPhase === 'abort'), false)
  const after = await savedVault(network)
  assert.equal(after.pendingHandover.transitionId, transitionId)
  assert.deepEqual(after.leaseCredentials, before.leaseCredentials)
  assertNoPublicCredentials(f)
})
