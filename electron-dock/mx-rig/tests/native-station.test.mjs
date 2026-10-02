import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeStation, renderTree } from '../packages/runtime/native.mjs'
import { MissionStore } from '../packages/runtime/store.mjs'
import { RigRuntime } from '../packages/runtime/engine.mjs'
import { ToolExecutor } from '../packages/runtime/tools.mjs'
import { BrowserTools } from '../packages/runtime/browser.mjs'

const node = (path, role, name, extra = {}) => ({
  path,
  depth: path.length,
  role,
  name,
  value: null,
  secure: false,
  enabled: true,
  ...extra
})

/** A settings window as System Events would describe it. */
function fakeMac({ saved = false } = {}) {
  const state = { nickname: '旧昵称', saved, launched: [], acts: [], window: true }
  const tree = () => ({
    title: '偏好设置',
    nodes: [
      node([], 'AXWindow', '偏好设置'),
      node([0], 'AXStaticText', '昵称'),
      node([1], 'AXTextField', '昵称', { value: state.nickname }),
      node([2], 'AXSecureTextField', '密码', { secure: true }),
      node([3], 'AXButton', '保存'),
      node([4], 'AXGroup', ''),
      node([4, 0], 'AXCheckBox', '自动更新', { value: '1' }),
      ...(state.saved ? [node([5], 'AXStaticText', '已保存')] : [])
    ],
    truncated: false
  })
  const params = (source) => JSON.parse(/const P = (.*);\n/.exec(source)[1])
  const run = async (source) => {
    if (source.includes('uiElementsEnabled')) return JSON.stringify({ enabled: true })
    if (!state.window) return JSON.stringify({ error: 'no_window' })
    if (source.includes('const nodes = []')) return JSON.stringify(tree())
    const P = params(source)
    state.acts.push(P)
    const current = tree().nodes.find((entry) => entry.path.join('.') === P.path.join('.'))
    if (!current || current.role !== P.role || current.name !== P.name)
      return JSON.stringify({ error: 'stale' })
    if (P.op === 'fill' && current.secure) return JSON.stringify({ error: 'secure' })
    if (P.op === 'fill') state.nickname = P.value
    if (P.op === 'press' && P.name === '保存') state.saved = true
    return JSON.stringify({ ok: true })
  }
  return { state, run, launch: async (bundleId) => state.launched.push(bundleId) }
}

const APPS = [
  {
    id: 'native-prefs',
    name: '偏好设置',
    kind: 'native',
    path: '/Applications/Prefs.app',
    bundleId: 'dev.example.prefs'
  },
  { id: 'electron-one', name: 'One', path: '/Applications/One.app/Contents/MacOS/One' }
]

test('the tree becomes refs for controls only; a password field is never read', () => {
  const { text, refs } = renderTree({
    title: 'W',
    nodes: [
      node([], 'AXWindow', 'W'),
      node([0], 'AXButton', '保存'),
      node([1], 'AXSecureTextField', '密码', { secure: true }),
      node([2], 'AXGroup', ''),
      node([2, 0], 'AXTextField', '备注', { value: '你好' })
    ]
  })
  assert.match(text, /- button "保存" \[ref=n1\]/)
  assert.match(text, /- password "密码" \[密码框，不读取、不填写\]$/m)
  assert.match(text, /^ {2}- textbox "备注" value="你好" \[ref=n2\]$/m, 'nesting shows as indent')
  assert.equal(refs.size, 2)
  assert.deepEqual(refs.get('n2'), { path: [2, 0], role: 'AXTextField', name: '备注' })
})

test('a registered app is launched by bundle id and driven through fresh refs', async () => {
  const mac = fakeMac()
  mac.state.window = false
  const station = new NativeStation({ run: mac.run, launch: mac.launch, platform: 'darwin' })
  station.setApps(APPS)
  await assert.rejects(station.execute('native_launch', { app: 'electron-one' }), {
    code: 'app_unregistered'
  })
  setTimeout(() => {
    mac.state.window = true
  }, 50)
  const launched = await station.execute('native_launch', { app: 'native-prefs' })
  assert.deepEqual(mac.state.launched, ['dev.example.prefs'])
  assert.match(launched.snapshot, /textbox "昵称" value="旧昵称" \[ref=n1\]/)

  await station.execute('native_fill', { ref: 'n1', value: 'Rig' })
  assert.equal(mac.state.nickname, 'Rig')
  assert.equal(mac.state.acts[0].bundleId, 'dev.example.prefs')
  await assert.rejects(station.execute('native_fill', { ref: 'n2', value: 'x' }), {
    code: 'element_not_actionable'
  })
  const clicked = await station.execute('native_click', { ref: 'n2' })
  assert.deepEqual(clicked.clicked, { role: 'button', name: '保存' })

  const seen = await station.execute('native_assert', { kind: 'text_visible', expected: '已保存' })
  assert.equal(seen.assertion.passed, true)
  assert.equal(seen.assertion.station, 'native')
  const value = await station.execute('native_assert', {
    kind: 'value_equals',
    ref: 'n1',
    expected: 'Rig'
  })
  assert.equal(value.assertion.passed, true)
  const absent = await station.execute('native_assert', {
    kind: 'text_absent',
    expected: '已保存',
    timeoutMs: 0
  })
  assert.equal(absent.assertion.passed, false, 'a failed check is a fact, not an error')

  // The window changed under a ref: refused, not clicked somewhere else.
  station.refs.set('n9', { path: [3], role: 'AXButton', name: '删除' })
  await assert.rejects(station.execute('native_click', { ref: 'n9' }), { code: 'stale_ref' })
  await assert.rejects(station.execute('native_click', { ref: 'n77' }), { code: 'stale_ref' })
})

test('permission problems become instructions, and other platforms say no plainly', async () => {
  const denied = new NativeStation({
    platform: 'darwin',
    run: async () => {
      const { RigError } = await import('../packages/contracts/index.mjs')
      throw new RigError('native_permission_denied', '没有辅助功能权限：请到 系统设置 …', 403)
    }
  })
  const status = await denied.probe()
  assert.deepEqual(
    [status.supported, status.permitted, status.code],
    [true, false, 'native_permission_denied']
  )
  assert.match(status.reason, /系统设置/)

  const windows = new NativeStation({
    platform: 'win32',
    run: async () => assert.fail('never called')
  })
  assert.equal((await windows.probe()).supported, false)
  await assert.rejects(windows.execute('native_snapshot', {}), { code: 'native_unsupported' })
})

test('native tools are offered only where the station runs, and never ride on a grant', async (t) => {
  const run = async ({ supported, replies, grants }) => {
    const mac = fakeMac()
    const station = new NativeStation({
      run: mac.run,
      launch: mac.launch,
      platform: supported ? 'darwin' : 'linux'
    })
    const browser = new BrowserTools(await mkdtemp(join(tmpdir(), 'mx-rig-native-')), undefined, {
      native: station
    })
    browser.setElectronApps(APPS)
    const store = await new MissionStore(await mkdtemp(join(tmpdir(), 'mx-rig-native-'))).init()
    const offered = []
    const client = {
      async request(path, body) {
        if (path === '/api/rig/v1/execution-config')
          return {
            policy: {
              revision: 'v1',
              maxTurns: 8,
              allowedTools: [
                'native_launch',
                'native_snapshot',
                'native_click',
                'native_assert',
                'browser_click'
              ],
              browserOrigins: [],
              browserPreauth: true
            },
            model: { configured: true },
            agents: []
          }
        if (path === '/api/rig/v1/model/turn') {
          offered.push(body.tools.map((tool) => tool.function.name))
          return { message: replies.shift() ?? { content: '完成' } }
        }
        throw new Error(path)
      }
    }
    const engine = new RigRuntime({
      store,
      client,
      executor: new ToolExecutor(client, browser),
      owner: 'a'
    })
    t.after(() => engine.close())
    const row = await engine.start({ mode: 'agent', goal: '检查偏好设置', grants })
    await engine.job
    return { store, engine, row, offered, mac }
  }
  const call = (id, name, args = {}) => ({
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
  })

  const linux = await run({ supported: false, replies: [] })
  assert.ok(!linux.offered[0].some((name) => name.startsWith('native_')))
  assert.ok(linux.offered[0].includes('browser_click'))

  const mac = await run({
    supported: true,
    grants: { browserWrites: true },
    replies: [
      call('c1', 'native_launch', { app: 'native-prefs' }),
      call('c2', 'native_click', { ref: 'n2' }),
      call('c3', 'native_assert', { kind: 'text_visible', expected: '已保存' }),
      { content: '已保存。' }
    ]
  })
  assert.ok(mac.offered[0].includes('native_snapshot'))
  let state = mac.store.get(mac.row.id, 'a')
  assert.equal(
    state.status,
    'awaiting_approval',
    'the browser grant does not cover a native launch'
  )
  assert.equal(state.pending.name, 'native_launch')
  await mac.engine.approve(mac.row.id, state.pending.approvalId, true)
  await mac.engine.job
  state = mac.store.get(mac.row.id, 'a')
  assert.equal(state.pending.name, 'native_click')
  await mac.engine.approve(mac.row.id, state.pending.approvalId, true)
  await mac.engine.job
  state = mac.store.get(mac.row.id, 'a')
  assert.equal(state.status, 'completed')
  assert.equal(state.assertions.length, 1)
  assert.equal(state.assertions[0].station, 'native')
  assert.equal(mac.mac.state.saved, true)
})
