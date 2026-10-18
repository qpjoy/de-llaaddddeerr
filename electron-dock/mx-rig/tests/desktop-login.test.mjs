import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { RigError, serviceUrl } from '../packages/contracts/index.mjs'

const source = await readFile(new URL('../apps/desktop/main.mjs', import.meta.url), 'utf8')
function between(start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  assert.ok(from >= 0 && to > from, `desktop fixture boundaries: ${start}`)
  return source.slice(from, to)
}
// Execute the production login and the adjoining IPC entry branches unchanged.
// Only their dependencies are replaced; Electron, processes and network never run.
const loginSource = between('async function login(input) {', '// -- Electron station:')
const requestSource = between('      trusted(event)\n', '      // The overseas channel follows')
const makeSubject = new Function('dependencies', `
  const { stopWorker, RigClient, network, RigError, serviceUrl, createHash, join,
    fork, rpc, rememberLogin, loadElectronApps, browserEnv, playwrightBrowsers,
    ProjectWorkspaces, TestRepositories, LocalRunner, localStation } = dependencies;
  const app = { getPath: () => '/fixture/profile' };
  const root = '/fixture/rig';
  const process = { env: {} };
  const oversea = null;
  const pending = new Map();
  const trusted = () => {};
  let window, worker = null, client = null, member = null, localRunner = null,
    station = null, projectWorkspaces = null, testRepositories = null, loginPending = false;
  ${loginSource}
  async function request(input) {
    const event = {};
    ${requestSource}
    throw new Error('Unsupported fixture action');
  }
  return { login, request, state: () => ({ worker, client, member, loginPending }) };
`)

const credentials = { account: 'fixture-user', password: 'fixture-password' }
const userReady = { status: 'ready', identity: { kind: 'user' }, serverReachable: true }
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture({ launcher = true, principal = { id: 'u-fixture', kind: 'user', role: 'viewer' }, signIn = async () => userReady, initialStatus = 'ready' } = {}) {
  const calls = []
  const started = deferred()
  const network = launcher ? {
    snapshot: () => ({ status: initialStatus, serverUrl: 'http://10.88.100.6' }),
    signIn: async (input) => {
      calls.push({ action: 'sign-in', input })
      started.resolve()
      const result = await signIn()
      calls.push({ action: 'network-result', result })
      return result
    },
    connect: async () => { calls.push({ action: 'connect' }); return userReady },
    disconnect: async () => { calls.push({ action: 'disconnect' }); return { status: 'idle' } },
    recoverIdentity: async () => { calls.push({ action: 'recover' }); return { status: 'ready' } }
  } : null
  class RigClient {
    constructor(options) { Object.assign(this, options) }
    async request(path, body) {
      calls.push({ action: path, body })
      if (path.endsWith('/native-login')) return { token: 'fixture-business-token' }
      if (path.endsWith('/me')) return { principal }
      throw new Error(`Unexpected service request: ${path}`)
    }
  }
  const subject = makeSubject({
    network, RigClient, RigError, serviceUrl, createHash, join,
    stopWorker: async () => { calls.push({ action: 'stop-worker' }) },
    fork: (...args) => { calls.push({ action: 'fork', args }); return new EventEmitter() },
    rpc: async (method, input) => { calls.push({ action: `rpc-${method}`, input }); return { ready: true } },
    rememberLogin: async (input) => { calls.push({ action: 'remember', input }) },
    loadElectronApps: async () => [],
    browserEnv: () => ({}),
    playwrightBrowsers: () => ({}),
    ProjectWorkspaces: class { constructor(root) { this.root = root } },
    TestRepositories: class {},
    LocalRunner: class { async stop() {} },
    localStation: () => ({ stop: async () => {} })
  })
  return { ...subject, calls, started: started.promise, principal }
}

const actions = (f) => f.calls.map((call) => call.action)
function assertNotStarted(f) {
  assert.equal(actions(f).includes('fork'), false)
  assert.equal(actions(f).includes('rpc-init'), false)
  assert.equal(f.state().worker, null)
  assert.equal(f.state().client, null)
  assert.equal(f.state().member, null)
}

test('unified login waits for the user network before worker startup and exposing the member', async () => {
  const gate = deferred()
  const f = fixture({ signIn: () => gate.promise })
  const login = f.login(credentials)
  await f.started
  assertNotStarted(f)
  assert.deepEqual(actions(f), ['stop-worker', '/api/rig/v1/native-login', '/api/rig/v1/me', 'sign-in'])
  assert.deepEqual(f.calls.at(-1).input, credentials)
  gate.resolve(userReady)
  const result = await login
  assert.deepEqual(actions(f), [
    'stop-worker', '/api/rig/v1/native-login', '/api/rig/v1/me', 'sign-in',
    'network-result', 'fork', 'rpc-init', 'remember'
  ])
  assert.equal(result.member, f.principal)
  assert.equal(f.state().member, f.principal)
  assert.equal(f.state().client.token, 'fixture-business-token')
  assert.equal(f.calls.find((call) => call.action === 'rpc-init').input.owner, f.principal.id)
})

test('failed or incomplete handover never starts the worker or commits business login', async (t) => {
  for (const [name, snapshot] of Object.entries({
    error: { ...userReady, status: 'error' },
    pending: { ...userReady, status: 'pending' },
    anonymous: { ...userReady, identity: { kind: 'anonymous' } },
    unreachable: { ...userReady, serverReachable: false },
    unverified: { ...userReady, serverReachable: null }
  })) await t.test(name, async () => {
    const f = fixture({ signIn: async () => snapshot })
    await assert.rejects(f.login(credentials), { code: 'network_not_ready' })
    assertNotStarted(f)
    assert.equal(actions(f).includes('remember'), false)
  })
})

test('a rejected network sign-in preserves the error and never starts the worker', async () => {
  const error = new Error('fixture network token exchange failed')
  const f = fixture({ signIn: async () => { throw error } })
  await assert.rejects(f.login(credentials), (actual) => actual === error)
  assertNotStarted(f)
})

test('ordinary mode, local accounts and service admin keep the existing login path', async (t) => {
  for (const [name, options] of Object.entries({
    ordinary: { launcher: false },
    local: { principal: { id: 'local:fixture', kind: 'local', role: 'operator' } },
    serviceAdmin: { principal: { id: 'service-admin', kind: 'service', role: 'admin' } }
  })) await t.test(name, async () => {
    const f = fixture({ ...options, signIn: async () => { throw new Error('must not request a user network') } })
    const result = await f.login(credentials)
    assert.equal(result.member, f.principal)
    assert.equal(actions(f).includes('sign-in'), false)
    assert.equal(actions(f).filter((action) => action === 'fork').length, 1)
    assert.equal(actions(f).filter((action) => action === 'rpc-init').length, 1)
  })
})

test('an unavailable initial network is rejected before credentials reach Rig', async () => {
  const f = fixture({ initialStatus: 'pending' })
  await assert.rejects(f.login(credentials), { code: 'network_not_ready' })
  assertNotStarted(f)
  assert.deepEqual(actions(f), ['stop-worker'])
})

test('IPC blocks duplicate login and network mutation until the first login completes', async () => {
  const gate = deferred()
  const f = fixture({ signIn: () => gate.promise })
  const login = f.request({ action: 'login', body: credentials })
  await f.started
  for (const action of ['login', 'network-connect', 'network-disconnect', 'network-recover'])
    await assert.rejects(f.request({ action, body: credentials }), { code: 'login_pending' })
  assert.equal(actions(f).filter((action) => action === 'stop-worker').length, 1)
  assert.equal(actions(f).includes('connect'), false)
  assert.equal(actions(f).includes('disconnect'), false)
  assert.equal(actions(f).includes('recover'), false)
  gate.resolve(userReady)
  await login
  assert.equal(f.state().loginPending, false)
  await f.request({ action: 'network-connect' })
  assert.equal(actions(f).filter((action) => action === 'connect').length, 1)
})

test('IPC releases the login guard after a failed handover so recovery remains available', async () => {
  const f = fixture({ signIn: async () => ({ ...userReady, status: 'error' }) })
  await assert.rejects(f.request({ action: 'login', body: credentials }), { code: 'network_not_ready' })
  assert.equal(f.state().loginPending, false)
  assertNotStarted(f)
  await f.request({ action: 'network-connect' })
  assert.equal(actions(f).filter((action) => action === 'connect').length, 1)
  await f.request({ action: 'network-recover' })
  assert.equal(actions(f).filter((action) => action === 'recover').length, 1)
})

test('identity recovery IPC is unavailable outside Launcher mode', async () => {
  const f = fixture({ launcher: false })
  await assert.rejects(f.request({ action: 'network-recover' }), { code: 'not_launcher' })
})
