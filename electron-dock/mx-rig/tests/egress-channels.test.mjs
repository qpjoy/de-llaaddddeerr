import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect, createServer as createTcpServer } from 'node:net'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../apps/server/index.mjs'
import { Settings } from '../apps/server/settings.mjs'
import { ModelGateway } from '../apps/server/model.mjs'
import { observeEgress } from '../apps/server/egress.mjs'
import { createProxyFetch } from '../apps/server/proxy-fetch.mjs'
import { BrowserTools } from '../packages/runtime/browser.mjs'
import {
  activeProfile,
  browserProxy,
  bypassed,
  proxyEndpoint,
  publicEgress,
  readEgress,
  readEgressProfile
} from '../apps/server/egress-profiles.mjs'

const CHANNEL = {
  id: 'office',
  displayName: '办公网代理',
  proxyUrl: 'http://127.0.0.1:7890',
  bypass: ['.internal.example.com'],
  appliesTo: ['model', 'browser']
}

async function settingsFor(t, value = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-egress-'))
  const settings = await new Settings(join(root, 'settings.json')).init()
  if (Object.keys(value).length) await settings.update({ ...settings.value, ...value })
  return settings
}

test('a channel address is host and port only, and never carries a credential', () => {
  assert.equal(proxyEndpoint('http://127.0.0.1:7890/'), 'http://127.0.0.1:7890')
  assert.equal(proxyEndpoint('socks5://10.0.0.9:1080'), 'socks5://10.0.0.9:1080')
  assert.throws(() => proxyEndpoint('http://user:pw@127.0.0.1:7890'), /不要把凭据写进通道地址/)
  assert.throws(() => proxyEndpoint('http://127.0.0.1'), /请写明端口/)
  assert.throws(() => proxyEndpoint('http://127.0.0.1:7890/path'), /不能带路径/)
  assert.throws(() => proxyEndpoint('ftp://127.0.0.1:21'), /只支持 http、https、socks4 或 socks5/)
  assert.throws(() => proxyEndpoint('not a url'), /完整地址/)
})

test('a channel may not promise something its scheme or its credential cannot deliver', () => {
  // socks cannot serve the model path: the transport is HTTP CONNECT.
  assert.throws(
    () => readEgressProfile({ ...CHANNEL, proxyUrl: 'socks5://10.0.0.9:1080' }),
    /socks 通道只能作用于隔离浏览器/
  )
  assert.deepEqual(
    readEgressProfile({
      ...CHANNEL,
      proxyUrl: 'socks5://10.0.0.9:1080',
      appliesTo: ['browser']
    }).appliesTo,
    ['browser']
  )
  // Server-side credentials must never be handed to the desktop Runtime.
  assert.throws(
    () => readEgressProfile({ ...CHANNEL, authEnv: 'MX_RIG_EGRESS_AUTH' }),
    /不接收服务端凭据/
  )
  assert.equal(
    readEgressProfile({ ...CHANNEL, appliesTo: ['model'], authEnv: 'MX_RIG_EGRESS_AUTH' }).authEnv,
    'MX_RIG_EGRESS_AUTH'
  )
  assert.throws(() => readEgressProfile({ ...CHANNEL, authEnv: 'lower case' }), /环境变量名/)
  assert.throws(() => readEgress({ activeId: 'ghost', profiles: [CHANNEL] }), /不存在/)
  assert.throws(
    () => readEgress({ profiles: [CHANNEL, { ...CHANNEL, displayName: '重复' }] }),
    /通道 ID 重复/
  )
  assert.deepEqual(readEgress(null), { activeId: null, profiles: [] })
})

test('loopback is always direct, and a bypass suffix matches the way an operator expects', () => {
  assert.equal(bypassed('127.0.0.1', []), true)
  assert.equal(bypassed('localhost', []), true)
  assert.equal(bypassed('[::1]', []), true)
  assert.equal(bypassed('gateway.example', []), false)
  assert.equal(bypassed('api.internal.example.com', ['.internal.example.com']), true)
  assert.equal(bypassed('internal.example.com', ['.internal.example.com']), true)
  assert.equal(bypassed('evil-internal.example.com.attacker.net', ['.internal.example.com']), false)
  assert.equal(bypassed('one.host', ['one.host']), true)
  assert.equal(bypassed('two.host', ['one.host']), false)
  assert.equal(bypassed('anything.at.all', ['*']), true)
})

test('an active channel resolves per surface, and the public view hides no failure', () => {
  const egress = readEgress({ activeId: 'office', profiles: [CHANNEL] })
  assert.equal(activeProfile(egress, 'model').id, 'office')
  assert.equal(activeProfile(egress, 'browser').id, 'office')
  assert.equal(activeProfile({ activeId: null, profiles: [CHANNEL] }, 'model'), null)
  const modelOnly = readEgress({
    activeId: 'office',
    profiles: [{ ...CHANNEL, appliesTo: ['model'], authEnv: 'MX_RIG_EGRESS_AUTH' }]
  })
  assert.equal(activeProfile(modelOnly, 'browser'), null)
  assert.deepEqual(browserProxy(egress), {
    id: 'office',
    server: 'http://127.0.0.1:7890',
    bypass: '.internal.example.com'
  })
  assert.equal(browserProxy(modelOnly), null)
  // "Channel configured, variable missing" is the failure this page exists for.
  assert.equal(publicEgress(modelOnly, {}).active.authConfigured, false)
  assert.equal(
    publicEgress(modelOnly, { MX_RIG_EGRESS_AUTH: 'tunnel:secret' }).active.authConfigured,
    true
  )
  assert.ok(
    !JSON.stringify(publicEgress(modelOnly, { MX_RIG_EGRESS_AUTH: 'secret' })).includes('secret')
  )
})

test('the stored policy exposes endpoints only to the execution surface', async (t) => {
  const settings = await settingsFor(t, { egress: { activeId: 'office', profiles: [CHANNEL] } })
  const readable = settings.public()
  assert.deepEqual(readable.policy.egress, {
    activeId: 'office',
    model: 'office',
    browser: 'office'
  })
  assert.equal(readable.policy.egress.browserProxy, undefined)
  const execution = settings.public({ egressEndpoints: true })
  assert.equal(execution.policy.egress.browserProxy.server, 'http://127.0.0.1:7890')
  // Switching is an ordinary policy change: new revision, same validation.
  const before = settings.value.revision
  await settings.activateEgress(null)
  assert.notEqual(settings.value.revision, before)
  assert.equal(settings.public().policy.egress.activeId, null)
  await assert.rejects(() => settings.activateEgress('ghost'), /出网通道不存在/)
  // An omitted egress key keeps the stored channels rather than dropping them;
  // clearing them is an explicit empty list.
  await settings.update({ ...settings.value, egress: undefined })
  assert.equal(settings.value.egress.profiles.length, 1)
  await settings.update({ ...settings.value, egress: { profiles: [] } })
  assert.deepEqual(settings.value.egress, { activeId: null, profiles: [] })
})

test('the model gateway builds a tunnel per channel and rebuilds it on a switch', async (t) => {
  const settings = await settingsFor(t, {
    providers: [
      {
        id: 'primary',
        displayName: '主模型',
        baseUrl: 'https://gateway.example/v1',
        model: 'test-model',
        apiKeyEnv: 'MODEL_KEY',
        timeoutMs: 5000,
        enabled: true
      }
    ],
    sequence: ['primary'],
    egress: { activeId: 'office', profiles: [{ ...CHANNEL, appliesTo: ['model'] }] }
  })
  const reply = (content) => ({
    ok: true,
    status: 200,
    body: (async function* body() {
      yield Buffer.from(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
    })()
  })
  const direct = []
  const tunnelled = []
  const built = []
  const gateway = new ModelGateway(settings, {
    fetchImpl: async (url) => {
      direct.push(String(url))
      return reply('direct')
    },
    environment: { MODEL_KEY: 'k' },
    transport: (profile) => {
      built.push(profile.id + '@' + profile.proxyUrl)
      return async (url) => {
        tunnelled.push(String(url))
        return reply('tunnelled')
      }
    }
  })
  const turn = () =>
    gateway.turn('alice', { messages: [{ role: 'user', content: 'hi' }], tools: [] })
  assert.equal((await turn()).message.content, 'tunnelled')
  assert.equal((await turn()).message.content, 'tunnelled')
  // Two calls, one tunnel: the transport is cached by profile, not per request.
  assert.deepEqual(built, ['office@http://127.0.0.1:7890'])
  assert.equal(tunnelled.length, 2)
  assert.equal(direct.length, 0)

  // Editing the channel must not keep using the old route.
  await settings.update({
    ...settings.value,
    egress: {
      activeId: 'office',
      profiles: [{ ...CHANNEL, appliesTo: ['model'], proxyUrl: 'http://127.0.0.1:8899' }]
    }
  })
  await turn()
  assert.deepEqual(built, ['office@http://127.0.0.1:7890', 'office@http://127.0.0.1:8899'])

  // Back to direct: no channel, no tunnel, no restart.
  await settings.activateEgress(null)
  assert.equal((await turn()).message.content, 'direct')
  assert.equal(direct.length, 1)
})

test('the tunnel speaks CONNECT, names its credential failure, and carries real bytes', async (t) => {
  const seen = []
  const upstream = createTcpServer((socket) => {
    socket.once('data', (chunk) => {
      seen.push({ kind: 'upstream-bytes', first: chunk[0] })
      socket.destroy()
    })
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  const proxy = createServer()
  let refuse = true
  proxy.on('connect', (req, socket, head) => {
    seen.push({ kind: 'connect', target: req.url, auth: req.headers['proxy-authorization'] })
    if (refuse) {
      socket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
      socket.end()
      return
    }
    // Pipe the tunnel to the recording upstream, the way a real proxy would.
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    const forward = connect(upstream.address().port, '127.0.0.1', () => {
      if (head?.length) forward.write(head)
      socket.pipe(forward)
      forward.pipe(socket)
    })
    forward.on('error', () => socket.destroy())
  })
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
  t.after(() => {
    proxy.close()
    upstream.close()
  })
  const profile = readEgressProfile({
    ...CHANNEL,
    appliesTo: ['model'],
    proxyUrl: `http://127.0.0.1:${proxy.address().port}`,
    authEnv: 'MX_RIG_EGRESS_AUTH'
  })
  const send = createProxyFetch(profile, {
    environment: { MX_RIG_EGRESS_AUTH: 'tunnel:secret' },
    base: async () => ({ ok: true, status: 200, body: null, direct: true })
  })

  // 407 is reported as a credential problem, not as "no route".
  await assert.rejects(() => send('https://gateway.example/v1/models'), {
    code: 'egress_refused'
  })
  const connectAttempt = seen.find((entry) => entry.kind === 'connect')
  assert.equal(connectAttempt.target, 'gateway.example:443')
  assert.equal(connectAttempt.auth, `Basic ${Buffer.from('tunnel:secret').toString('base64')}`)

  // Once the proxy accepts, our TLS handshake really travels through it.
  refuse = false
  await assert.rejects(() => send('https://gateway.example/v1/models'))
  const carried = seen.find((entry) => entry.kind === 'upstream-bytes')
  assert.ok(carried, '隧道没有把字节送到上游')
  assert.equal(carried.first, 0x16, 'through the tunnel the first byte is a TLS handshake record')

  // Bypassed and plaintext targets never enter the tunnel.
  assert.equal((await send('https://api.internal.example.com/v1/models')).direct, true)
  assert.equal((await send('http://127.0.0.1:1234/v1/models')).direct, true)
  await assert.rejects(() => send('http://gateway.example/v1/models'), {
    code: 'egress_plaintext'
  })
})

test('the isolated browser is relaunched when the channel changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-browser-'))
  const launches = []
  const fakePage = {
    on: () => {},
    setDefaultTimeout: () => {},
    goto: async () => {},
    url: () => 'https://test.example/',
    title: async () => 'stub',
    locator: () => ({ innerText: async () => 'stub body' }),
    screenshot: async ({ path }) => writeFile(path, 'png')
  }
  const chromium = {
    launch: async (options) => {
      launches.push(options.proxy ?? null)
      return {
        newContext: async () => ({
          route: async () => {},
          routeWebSocket: async () => {},
          on: () => {},
          newPage: async () => fakePage
        }),
        close: async () => {}
      }
    }
  }
  const tools = new BrowserTools(root, chromium)
  t.after(() => tools.close())
  const context = (browserProxyValue) => ({
    policy: {
      browserOrigins: ['https://test.example'],
      allowedTools: ['browser_open'],
      egress: browserProxyValue ? { browserProxy: browserProxyValue } : {}
    },
    missionId: '00000000-0000-0000-0000-000000000001'
  })
  assert.deepEqual(BrowserTools.channelOf(context(null).policy), { key: 'direct', proxy: null })
  await tools.execute('browser_open', { url: 'https://test.example/' }, context(null))
  await tools.execute('browser_open', { url: 'https://test.example/' }, context(null))
  assert.deepEqual(launches, [null], 'same channel reuses the browser')
  const channel = { id: 'office', server: 'http://127.0.0.1:7890', bypass: 'a.example' }
  await tools.execute('browser_open', { url: 'https://test.example/' }, context(channel))
  assert.deepEqual(launches.at(-1), { server: 'http://127.0.0.1:7890', bypass: 'a.example' })
  await tools.execute('browser_open', { url: 'https://test.example/' }, context(null))
  assert.equal(launches.length, 3)
  assert.equal(launches.at(-1), null)
})

test('the observation half keeps telling the truth about the environment', () => {
  const managed = publicEgress(readEgress({ activeId: 'office', profiles: [CHANNEL] }), {})
  const observed = observeEgress({
    env: { HTTP_PROXY: 'http://127.0.0.1:7788' },
    nodeVersion: 'v22.21.1',
    platform: 'linux',
    managed
  })
  // Node 22 ignores proxy variables — that stays true whatever Rig does.
  assert.equal(observed.effective, 'direct')
  assert.equal(observed.configured, true)
  assert.equal(observed.route.model, 'rig-channel')
  assert.equal(observed.route.browser, 'rig-channel')
  assert.match(observed.route.note, /办公网代理/)
  const bare = observeEgress({ env: {}, nodeVersion: 'v22.21.1' })
  assert.equal(bare.route.model, 'direct')
  assert.equal(bare.route.browser, 'direct')
  assert.equal(bare.managed.activeId, null)
})

test('switching a channel needs admin, and it invalidates the policy revision', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-egress-api-'))
  const runtime = await start(
    {
      MX_RIG_ADMIN_TOKEN: 'test-only-rig-secret',
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_PORT: '0',
      MX_RIG_STORE: 'memory',
      MX_RIG_STATE_DIR: root,
      MX_RIG_ARTIFACTS_DIR: join(root, 'artifacts')
    },
    { schedule: false }
  )
  t.after(() => runtime.close())
  const api = async (path, body, headers = { authorization: 'Bearer test-only-rig-secret' }) => {
    const response = await fetch(runtime.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: response.status, body: await response.json() }
  }
  const stored = await api('/api/rig/v1/admin/config')
  const saved = await api('/api/rig/v1/admin/config', {
    ...stored.body,
    orchestrations: stored.body.orchestrations.map(({ builtin, nextFireAt, ...rest }) => rest),
    egress: { activeId: null, profiles: [CHANNEL] }
  })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  const before = saved.body.policy.revision
  const activated = await api('/api/rig/v1/admin/egress:activate', { activeId: 'office' })
  assert.equal(activated.status, 200, JSON.stringify(activated.body))
  assert.equal(activated.body.egress.activeId, 'office')
  assert.notEqual(activated.body.config.policy.revision, before)
  assert.equal((await api('/api/rig/v1/egress')).body.egress.route.model, 'rig-channel')
  // /config withholds the endpoint; the execution surface needs it and gets it.
  assert.equal((await api('/api/rig/v1/config')).body.policy.egress.browserProxy, undefined)
  assert.equal(
    (await api('/api/rig/v1/execution-config')).body.policy.egress.browserProxy.server,
    'http://127.0.0.1:7890'
  )
  assert.equal((await api('/api/rig/v1/admin/egress:activate', { activeId: 'ghost' })).status, 404)

  const original = runtime.kernel.identity.resolve
  runtime.kernel.identity.resolve = async (token, source) =>
    token === 'operator-token' ? { id: 'op', role: 'operator' } : original(token, source)
  assert.equal(
    (
      await api(
        '/api/rig/v1/admin/egress:activate',
        { activeId: null },
        {
          authorization: 'Bearer operator-token'
        }
      )
    ).status,
    403
  )
})
