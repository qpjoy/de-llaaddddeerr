// Native desktop station — macOS preview.
//
// A registered native app is read and driven through the macOS
// Accessibility tree (System Events, scripted in JXA): the same idea as the
// browser station's aria snapshot, with refs a model can point at. Windows UI
// Automation is not implemented; on any other platform the tools are simply
// not offered.
//
// Two facts about macOS shape this file. The first System Events call from
// an app waits on a consent dialog, for as long as nobody answers it — so
// every call has a timeout, and the only call made without a mission is the
// probe a person starts with a button. And the answer to that dialog belongs
// to the person at the machine: this code reports "not permitted" and says
// where the switch is; it never tries to get around it.

import { execFile } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { RigError } from '../contracts/index.mjs'

export const NATIVE_ASSERTIONS = Object.freeze({
  text_visible: '窗口里可见指定文本',
  text_absent: '窗口里不再出现指定文本',
  value_equals: '控件的值等于期望值',
  element_enabled: '控件处于可用状态'
})

const CALL_TIMEOUT_MS = 8_000
const SNAPSHOT_TIMEOUT_MS = 20_000
const MAX_NODES = 400
const MAX_DEPTH = 10
const TEXT_LIMIT = 16_000

const ROLES = {
  AXButton: 'button',
  AXTextField: 'textbox',
  AXTextArea: 'textbox',
  AXSecureTextField: 'password',
  AXStaticText: 'text',
  AXCheckBox: 'checkbox',
  AXRadioButton: 'radio',
  AXPopUpButton: 'combobox',
  AXComboBox: 'combobox',
  AXMenuButton: 'button',
  AXMenuItem: 'menuitem',
  AXLink: 'link',
  AXTab: 'tab',
  AXSlider: 'slider',
  AXImage: 'image',
  AXHeading: 'heading',
  AXRow: 'row',
  AXCell: 'cell',
  AXTable: 'table',
  AXList: 'list',
  AXOutline: 'tree',
  AXToolbar: 'toolbar',
  AXWindow: 'window',
  AXSheet: 'dialog'
}
const ACTIONABLE = new Set([
  'button',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'menuitem',
  'link',
  'tab',
  'slider'
])
const FILLABLE = new Set(['AXTextField', 'AXTextArea', 'AXComboBox'])

const roleOf = (raw) =>
  ROLES[raw] ??
  String(raw || '')
    .replace(/^AX/, '')
    .toLowerCase()

/** Run one JXA program; map the ways macOS says "no" to errors a person can act on. */
export function osascript(source, { timeoutMs = CALL_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'osascript',
      ['-l', 'JavaScript', '-e', source],
      { timeout: timeoutMs, signal, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout.trim())
        if (signal?.aborted) return reject(error)
        const text = `${stderr}${error.message}`
        if (error.killed || error.signal === 'SIGTERM')
          return reject(
            new RigError(
              'native_permission_pending',
              'macOS 可能正在等待授权：请在弹出的对话框里允许 MX Rig 控制「System Events」，或到 系统设置 → 隐私与安全性 → 辅助功能 / 自动化 中打开 MX Rig，然后重试',
              409
            )
          )
        if (/-1743|-1719|not allowed assistive|不允许辅助|Not authorized/i.test(text))
          return reject(
            new RigError(
              'native_permission_denied',
              '没有辅助功能权限：请到 系统设置 → 隐私与安全性 → 辅助功能 与 自动化 中允许 MX Rig，然后重试',
              403
            )
          )
        reject(
          new RigError(
            'native_failed',
            `原生工位调用失败：${text.split('\n')[0].slice(0, 200)}`,
            502
          )
        )
      }
    )
  })
}

// Every program gets its parameters as one JSON literal, never by string
// splicing: an app title or a value to type cannot become code.
const program = (params, body) => `
function run() {
  const P = ${JSON.stringify(params)};
  const se = Application('System Events');
  const read = (el, key) => { try { const v = el[key](); return v === null || v === undefined ? '' : v } catch (e) { return '' } };
  const nameOf = (el) => String(read(el, 'title') || read(el, 'description') || read(el, 'name') || '');
  const windowOf = () => {
    const procs = se.processes.whose({ bundleIdentifier: P.bundleId });
    if (procs.length === 0) return { error: 'not_running' };
    const wins = procs[0].windows();
    if (!wins.length) return { error: 'no_window' };
    return { win: wins[0] };
  };
  ${body}
}`

export const SNAPSHOT_PROGRAM = (bundleId) =>
  program(
    { bundleId, max: MAX_NODES, depth: MAX_DEPTH },
    `const found = windowOf();
  if (found.error) return JSON.stringify(found);
  const nodes = [];
  const walk = (el, path, depth) => {
    if (nodes.length >= P.max || depth > P.depth) return;
    const role = String(read(el, 'role'));
    const secure = role === 'AXSecureTextField' || String(read(el, 'subrole')) === 'AXSecureTextField';
    const raw = secure ? '' : read(el, 'value');
    const value = ['string', 'number', 'boolean'].includes(typeof raw) && raw !== '' ? String(raw) : null;
    nodes.push({ path, depth, role, name: nameOf(el), value, secure, enabled: read(el, 'enabled') !== false });
    let kids = [];
    try { kids = el.uiElements() } catch (e) {}
    for (let i = 0; i < kids.length; i++) walk(kids[i], path.concat([i]), depth + 1);
  };
  walk(found.win, [], 0);
  return JSON.stringify({ title: String(read(found.win, 'name')), nodes, truncated: nodes.length >= P.max });`
  )

export const ACT_PROGRAM = ({ bundleId, path, role, name, op, value }) =>
  program(
    { bundleId, path, role, name, op, value },
    `const found = windowOf();
  if (found.error) return JSON.stringify(found);
  let el = found.win;
  for (const i of P.path) {
    const kids = el.uiElements();
    if (i >= kids.length) return JSON.stringify({ error: 'stale' });
    el = kids[i];
  }
  const role = String(read(el, 'role'));
  const name = nameOf(el);
  if (role !== P.role || name !== P.name) return JSON.stringify({ error: 'stale', role, name });
  if (P.op === 'press') el.actions.byName('AXPress').perform();
  else if (P.op === 'fill') {
    if (role === 'AXSecureTextField' || String(read(el, 'subrole')) === 'AXSecureTextField') return JSON.stringify({ error: 'secure' });
    try { el.focused = true } catch (e) {}
    el.value = P.value;
  }
  return JSON.stringify({ ok: true });`
  )

export const PROBE_PROGRAM = () =>
  `function run() { return JSON.stringify({ enabled: Application('System Events').uiElementsEnabled() }) }`

/** Refs for actionable controls, and the text a model reads. */
export function renderTree(tree) {
  const refs = new Map()
  const lines = [`窗口「${tree.title || '（无标题）'}」`]
  let n = 0
  for (const node of tree.nodes) {
    const role = roleOf(node.role)
    const actionable = ACTIONABLE.has(role) && !node.secure
    const worth = actionable || node.name || node.value !== null || node.secure
    if (!worth || node.depth === 0) continue
    let line = `${'  '.repeat(Math.max(0, node.depth - 1))}- ${role}`
    if (node.name) line += ` ${JSON.stringify(node.name)}`
    if (node.secure) line += ' [密码框，不读取、不填写]'
    else if (node.value !== null && node.value !== node.name)
      line += ` value=${JSON.stringify(node.value.slice(0, 200))}`
    if (!node.enabled) line += ' [不可用]'
    if (actionable) {
      const ref = `n${++n}`
      refs.set(ref, { path: node.path, role: node.role, name: node.name })
      line += ` [ref=${ref}]`
    }
    lines.push(line)
  }
  if (tree.truncated) lines.push(`（控件超过 ${MAX_NODES} 个，后面的已省略）`)
  let text = lines.join('\n')
  if (text.length > TEXT_LIMIT) text = `${text.slice(0, TEXT_LIMIT)}\n（快照过长，已截断）`
  return { text, refs }
}

export class NativeStation {
  /**
   * @param {object}   [options]
   * @param {Function} [options.run]    runs one JXA program (tests pass a fake)
   * @param {Function} [options.launch] starts an app by bundle id
   */
  constructor({ run = osascript, launch = openApp, platform = process.platform } = {}) {
    this.run = run
    this.launch = launch
    this.platform = platform
    this.apps = new Map()
    this.current = null
    this.refs = new Map()
    this.lastTree = null
  }
  get supported() {
    return this.platform === 'darwin'
  }
  /** Only what the person at this machine registered as a native app. */
  setApps(apps = []) {
    this.apps = new Map(
      apps
        .filter((entry) => entry?.kind === 'native' && typeof entry.bundleId === 'string')
        .map((entry) => [entry.id, entry])
    )
  }
  /** Started by a button, never by a mission: the first call may raise a macOS dialog. */
  async probe() {
    if (!this.supported)
      return {
        supported: false,
        permitted: false,
        reason: '原生桌面工位目前只支持 macOS（Windows UI Automation 尚未实现）'
      }
    try {
      const { enabled } = JSON.parse(await this.run(PROBE_PROGRAM(), { timeoutMs: 12_000 }))
      return enabled
        ? { supported: true, permitted: true, reason: null }
        : { supported: true, permitted: false, reason: '系统的辅助功能 UI 脚本已关闭' }
    } catch (error) {
      return { supported: true, permitted: false, reason: error.message, code: error.code ?? null }
    }
  }
  async #call(source, { signal, timeoutMs } = {}) {
    const raw = await this.run(source, { signal, timeoutMs })
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new RigError('native_failed', '原生工位返回了无法解析的结果', 502)
    }
    if (parsed.error === 'not_running')
      throw new RigError('native_not_running', '应用没有在运行，请先用 native_launch 启动', 409)
    if (parsed.error === 'no_window')
      throw new RigError('native_no_window', '应用当前没有打开的窗口', 409)
    return parsed
  }
  async #snapshot(signal) {
    if (!this.current)
      throw new RigError('native_missing', '请先用 native_launch 启动一个已登记的原生应用')
    const tree = await this.#call(SNAPSHOT_PROGRAM(this.current.bundleId), {
      signal,
      timeoutMs: SNAPSHOT_TIMEOUT_MS
    })
    const { text, refs } = renderTree(tree)
    this.refs = refs
    this.lastTree = tree
    return { text, tree }
  }
  #target(ref) {
    const target = this.refs.get(String(ref ?? ''))
    if (!target)
      throw new RigError(
        'stale_ref',
        `没有 ref ${ref}：请先 native_snapshot，并使用最新快照里的 ref`,
        409
      )
    return target
  }
  async #act(ref, op, value, signal) {
    const target = this.#target(ref)
    const result = await this.#call(
      ACT_PROGRAM({ bundleId: this.current.bundleId, ...target, op, value }),
      {
        signal
      }
    )
    if (result.error === 'stale')
      throw new RigError('stale_ref', `ref ${ref} 指向的控件已经变化，请重新 native_snapshot`, 409)
    if (result.error === 'secure') throw new RigError('sensitive_field', '不填写密码框', 403)
    return target
  }
  async execute(name, args, { signal } = {}) {
    if (!this.supported)
      throw new RigError('native_unsupported', '原生桌面工位目前只支持 macOS', 409)
    signal?.throwIfAborted()
    switch (name) {
      case 'native_launch': {
        const app = this.apps.get(String(args.app ?? ''))
        if (!app) throw new RigError('app_unregistered', '这个应用没有在本机登记为原生应用', 403)
        await this.launch(app.bundleId)
        this.current = { id: app.id, name: app.name, bundleId: app.bundleId }
        // An app takes a moment to put up its first window.
        for (let attempt = 0; ; attempt += 1) {
          try {
            const { text } = await this.#snapshot(signal)
            return { app: app.name, snapshot: text }
          } catch (error) {
            if (!['native_not_running', 'native_no_window'].includes(error.code) || attempt >= 20)
              throw error
            await sleep(500, undefined, { signal })
          }
        }
      }
      case 'native_snapshot':
        return { app: this.current?.name, snapshot: (await this.#snapshot(signal)).text }
      case 'native_click': {
        const target = await this.#act(args.ref, 'press', undefined, signal)
        await sleep(300, undefined, { signal })
        return {
          clicked: { role: roleOf(target.role), name: target.name },
          snapshot: (await this.#snapshot(signal)).text
        }
      }
      case 'native_fill': {
        if (typeof args.value !== 'string') throw new RigError('invalid_arguments', '缺少 value')
        const target = this.#target(args.ref)
        if (!FILLABLE.has(target.role))
          throw new RigError('element_not_actionable', '只能填写文本框', 409)
        await this.#act(args.ref, 'fill', args.value, signal)
        return {
          filled: { role: roleOf(target.role), name: target.name },
          snapshot: (await this.#snapshot(signal)).text
        }
      }
      case 'native_assert':
        return { assertion: await this.#assert(args, signal) }
      default:
        throw new RigError('tool_denied', `未知原生工具 ${name}`, 403)
    }
  }
  async #assert(args, signal) {
    const kind = args.kind
    if (!Object.hasOwn(NATIVE_ASSERTIONS, kind))
      throw new RigError(
        'invalid_arguments',
        `断言类型只能是 ${Object.keys(NATIVE_ASSERTIONS).join(' / ')}`
      )
    const needsRef = kind === 'value_equals' || kind === 'element_enabled'
    if (needsRef && args.ref === undefined)
      throw new RigError('invalid_arguments', `${kind} 需要 ref`)
    if (kind !== 'element_enabled' && !args.expected)
      throw new RigError('invalid_arguments', `${kind} 需要 expected`)
    const target = needsRef ? this.#target(args.ref) : null
    const deadline = Date.now() + (args.timeoutMs ?? 3_000)
    let actual
    let passed = false
    while (true) {
      const { tree } = await this.#snapshot(signal)
      const node = target
        ? tree.nodes.find(
            (entry) => entry.path.join('.') === target.path.join('.') && entry.role === target.role
          )
        : null
      if (kind === 'text_visible' || kind === 'text_absent') {
        const seen = tree.nodes.some((entry) =>
          [entry.name, entry.value].some((field) => field && field.includes(args.expected))
        )
        actual = seen
        passed = kind === 'text_visible' ? seen : !seen
      } else if (kind === 'value_equals') {
        actual = node?.value ?? null
        passed = actual === args.expected
      } else {
        actual = node ? node.enabled : null
        passed = actual === true
      }
      if (passed || Date.now() >= deadline) break
      await sleep(300, undefined, { signal })
    }
    return {
      kind,
      description: NATIVE_ASSERTIONS[kind],
      ...(target
        ? { ref: args.ref, target: { role: roleOf(target.role), name: target.name } }
        : {}),
      ...(args.expected !== undefined ? { expected: args.expected } : {}),
      actual,
      passed,
      station: 'native',
      at: new Date().toISOString()
    }
  }
  close() {
    this.current = null
    this.refs = new Map()
  }
}

function openApp(bundleId) {
  return new Promise((resolve, reject) =>
    execFile('open', ['-b', bundleId], { timeout: 15_000 }, (error) =>
      error ? reject(new RigError('native_launch_failed', `无法启动 ${bundleId}`, 502)) : resolve()
    )
  )
}
