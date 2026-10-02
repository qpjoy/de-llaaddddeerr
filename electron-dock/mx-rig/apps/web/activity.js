// 工作过程（Activity）: a mission as a person follows it.
//
// Not a log. What the member said, what the Agent said while it worked, and
// the tools it used folded into steps a person can scan — "读取了 3 个文件，
// 运行了 1 条命令" — each openable to the exact call, its result, and the
// page it left behind. Next to it, the browser: live while the Agent drives
// it (desktop), and afterwards a replay of every step with the hand moving.
//
// The page re-renders on every poll. Everything that must survive that —
// the live view, a playing replay, the lightbox, which groups are open — is
// kept here, outside the render, and re-attached.

import { h } from './views.js'
import { mountReplay, replayFrames } from './replay.js'

// -- what a step says ------------------------------------------------------------

const clip = (text, max = 120) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** One call in one line — `读取 src/app.ts:120`, `$ npm test` — never JSON. */
export function stepLabel(tool, args = {}) {
  const a = args ?? {}
  switch (tool) {
    case 'workspace_list':
      return `列出 ${a.path ?? '.'}`
    case 'workspace_read':
      return `读取 ${a.path}${a.fromLine ? `:${a.fromLine}` : ''}`
    case 'workspace_search':
      return `搜索 /${a.pattern}/${a.glob ? ` ${a.glob}` : ''}`
    case 'workspace_run':
      return `$ ${clip(a.command, 90)}`
    case 'workspace_write':
      return `${a.mode === 'append' ? '追加' : a.mode === 'overwrite' ? '覆盖' : '新建'} ${a.path}`
    case 'workspace_edit':
      return `修改 ${a.path}`
    case 'browser_open':
      return `打开 ${a.url}`
    case 'browser_snapshot':
      return '观察页面'
    case 'browser_click':
      return `点击 ${a.name ?? a.ref ?? ''}`
    case 'browser_fill':
      return `填写 ${a.label ?? a.ref ?? ''}`
    case 'browser_select':
      return `选择 ${a.option ?? ''}`
    case 'browser_check':
      return `${a.checked === false ? '取消勾选' : '勾选'} ${a.ref ?? ''}`
    case 'browser_press':
      return `按键 ${a.key}`
    case 'browser_wait':
      return `等待${a.text ? `「${clip(a.text, 30)}」` : '页面变化'}`
    case 'browser_assert':
      return `断言 ${a.kind}${a.expected ? `「${clip(a.expected, 40)}」` : ''}`
    case 'browser_handoff':
      return `请你来：${clip(a.reason, 60)}`
    case 'tests_run':
      return `派发测试计划 ${a.taskId ?? ''}`
    case 'tests_result':
    case 'tests_wait':
    case 'tests_case_results':
    case 'tests_artifacts':
      return `查看执行 ${a.runId ?? ''}`
    case 'tests_cases':
      return `读取 ${a.app ?? ''} 的用例目录`
    case 'case_draft':
      return `起草用例 ${a.caseId ?? ''} ${clip(a.title, 40)}`
    case 'finding_submit':
      return '提交结论'
    case 'procedure_propose':
      return `提出规程修正（${a.verdict ?? ''}）`
    default:
      return tool ?? '工具'
  }
}

/** What came back, in a few words — and what the page did on its own (a dialog, a download, a new tab). */
function stepNote(tool, result) {
  const base = resultNote(tool, result)
  if (!result?.notice) return base
  return [base, clip(result.notice, 160)].filter(Boolean).join(' · ')
}

function resultNote(tool, result) {
  if (!result) return ''
  if (result.error) return result.error.message ?? result.error.code ?? '未完成'
  switch (tool) {
    case 'workspace_read':
      return `第 ${result.fromLine}–${result.toLine} 行 / 共 ${result.totalLines} 行`
    case 'workspace_search':
      return `${result.matches?.length ?? 0} 处${result.truncated ? '以上' : ''}`
    case 'workspace_list':
      return `${result.entries?.length ?? 0} 项`
    case 'workspace_run':
      return result.timedOut
        ? `超时（${Math.round((result.durationMs ?? 0) / 1000)} 秒）`
        : `退出码 ${result.exitCode ?? result.signal} · ${((result.durationMs ?? 0) / 1000).toFixed(1)} 秒`
    case 'workspace_write':
    case 'workspace_edit':
      return `+${result.added ?? 0} −${result.removed ?? 0}`
    case 'browser_assert':
      return result.assertion ? (result.assertion.passed ? '通过' : '未通过') : ''
    case 'tests_run':
      return result.run?.id ? `${result.run.id}（派发不等于通过）` : ''
    default:
      if (result.run?.status) return `${result.run.id ?? ''} ${result.run.status}`
      if (result.title) return clip(result.title, 50)
      return ''
  }
}

// Not a failure: the runtime said no on purpose (a password field), and the
// Agent was told what to do instead.
const REFUSED = new Set(['sensitive_field', 'protected_path', 'origin_denied'])

const CATEGORY = [
  ['workspace_read', (n) => `读取了 ${n} 个文件`],
  ['workspace_search', (n) => `搜索了 ${n} 次`],
  ['workspace_list', (n) => `列出目录 ${n} 次`],
  ['workspace_run', (n) => `运行了 ${n} 条命令`],
  ['workspace_change', (n) => `修改了 ${n} 个文件`],
  ['browser_open', (n) => `打开了 ${n} 个页面`],
  ['browser_click', (n) => `点击 ${n} 次`],
  ['browser_fill', (n) => `填写 ${n} 处`],
  ['browser_other', (n) => `操作页面 ${n} 次`],
  ['browser_snapshot', (n) => `观察页面 ${n} 次`],
  ['browser_assert', (n) => `断言 ${n} 条`],
  ['browser_handoff', (n) => `请你接手 ${n} 次`],
  ['tests_run', (n) => `派发了 ${n} 个测试`],
  ['tests', (n) => `查询测试平台 ${n} 次`],
  ['authoring', (n) => `起草 ${n} 项`],
  ['other', (n) => `调用工具 ${n} 次`]
]

function categoryOf(tool) {
  if (tool === 'workspace_write' || tool === 'workspace_edit') return 'workspace_change'
  if (['browser_select', 'browser_check', 'browser_press', 'browser_wait', 'electron_launch'].includes(tool))
    return 'browser_other'
  if (CATEGORY.some(([key]) => key === tool)) return tool
  if (tool?.startsWith('tests_')) return 'tests'
  if (['case_draft', 'finding_submit', 'procedure_propose'].includes(tool)) return 'authoring'
  return 'other'
}

/** "读取了 3 个文件，运行了 1 条命令，断言 2 条（1 条未通过）" */
export function stepsSummary(steps) {
  const counts = new Map()
  const files = new Set()
  let failed = 0
  let refused = 0
  for (const step of steps) {
    // Said no to on purpose: not done, and not a failure either.
    if (REFUSED.has(step.result?.error?.code)) {
      refused += 1
      continue
    }
    const key = categoryOf(step.tool)
    if (key === 'workspace_change' || key === 'workspace_read') {
      const path = step.args?.path
      if (path && files.has(`${key}:${path}`)) continue
      if (path) files.add(`${key}:${path}`)
    }
    counts.set(key, (counts.get(key) ?? 0) + 1)
    if (step.tool === 'browser_assert' && step.result?.assertion?.passed === false) failed += 1
  }
  const parts = CATEGORY.filter(([key]) => counts.has(key)).map(([key, say]) => {
    const text = say(counts.get(key))
    return key === 'browser_assert' && failed ? `${text}（${failed} 条未通过）` : text
  })
  if (refused) parts.push(`按规则拒绝 ${refused} 步`)
  return parts.join('，') || '准备中'
}

/** Files a mission changed, with lines added and removed. */
export function workspaceChanges(events = []) {
  const files = new Map()
  let tool = null
  for (const event of events) {
    if (event.kind === 'tool_start') tool = event.data?.tool ?? null
    if (event.kind !== 'tool_result' || (tool !== 'workspace_write' && tool !== 'workspace_edit')) continue
    const result = event.data?.result
    if (!result?.path || result.error) continue
    const entry = files.get(result.path) ?? { path: result.path, added: 0, removed: 0 }
    entry.added += result.added ?? 0
    entry.removed += result.removed ?? 0
    files.set(result.path, entry)
  }
  const list = [...files.values()]
  return {
    files: list,
    added: list.reduce((sum, entry) => sum + entry.added, 0),
    removed: list.reduce((sum, entry) => sum + entry.removed, 0)
  }
}

// -- the record, as blocks ---------------------------------------------------------

const QUIET = new Set(['thinking'])

/**
 * The mission's events as what a person reads: messages, and runs of tool
 * steps between them.
 */
export function activityBlocks(row) {
  const blocks = []
  let group = null
  const close = () => {
    if (group?.steps.length) blocks.push(group)
    group = null
  }
  for (const event of row.events ?? []) {
    switch (event.kind) {
      case 'tool_start':
        group ??= { kind: 'steps', steps: [] }
        group.steps.push({ tool: event.data?.tool, args: event.data?.args ?? {}, at: event.at, result: null })
        break
      case 'tool_result': {
        const step = group?.steps.at(-1)
        if (step && !step.result) step.result = event.data?.result ?? {}
        break
      }
      case 'tool_error': {
        const step = group?.steps.at(-1)
        if (step && !step.result)
          step.result = {
            error: { code: event.data?.code ?? null, message: String(event.message ?? '').replace(/^\S+ 未(完成|执行)：/, '') }
          }
        else {
          group ??= { kind: 'steps', steps: [] }
          // Refused before it started (a password field): no tool_start.
          group.steps.push({
            tool: event.data?.tool,
            args: {},
            at: event.at,
            result: { error: { code: event.data?.code ?? null, message: String(event.message ?? '').replace(/^\S+ 未(完成|执行)：/, '') } }
          })
        }
        break
      }
      case 'approval':
        group ??= { kind: 'steps', steps: [] }
        group.waiting = event.data?.tool ?? true
        break
      case 'approved':
        if (group) group.waiting = null
        break
      case 'assertion':
        break
      case 'say':
        close()
        blocks.push({ kind: 'say', text: event.message, at: event.at })
        break
      case 'user':
        close()
        blocks.push({ kind: 'user', text: event.message, at: event.at })
        break
      case 'answer':
        close()
        blocks.push({ kind: 'answer', text: event.message, at: event.at })
        break
      case 'error':
      case 'cancelled':
      case 'interrupted':
        close()
        blocks.push({ kind: 'status', tone: event.kind === 'error' ? 'danger' : 'muted', text: event.message, at: event.at })
        break
      default:
        if (QUIET.has(event.kind)) break
        if (event.kind === 'handoff') {
          close()
          blocks.push({ kind: 'status', tone: 'warning', text: `✋ ${event.message}`, at: event.at })
          break
        }
        if (event.kind === 'takeover' && event.data?.screenshot) {
          close()
          blocks.push({ kind: 'manual', text: event.message, image: event.data.screenshot, at: event.at })
          break
        }
        if (event.kind === 'case_draft' || event.kind === 'finding' || event.kind === 'proposal') {
          group ??= { kind: 'steps', steps: [] }
          group.notes = [...(group.notes ?? []), event.message]
          break
        }
        close()
        blocks.push({ kind: 'status', tone: 'muted', text: event.message, at: event.at })
    }
  }
  close()
  return blocks
}

/** What is happening right now, for the working pill. */
export function currentActivity(row) {
  if (row.status === 'awaiting_approval') return '等待你确认'
  if (row.stream?.text) return '正在回复'
  const last = (row.events ?? []).at(-1)
  if (last?.kind === 'tool_start') return `正在${stepLabel(last.data?.tool, last.data?.args)}`
  if (last?.kind === 'tool_result' || last?.kind === 'thinking' || last?.kind === 'say') return '正在思考下一步'
  return '处理中'
}

// -- screenshots -------------------------------------------------------------------

const images = new Map() // path → Promise<src|null>
const ready = new Map() // path → src, once loaded: a re-render shows it at once

function imageOf(ctx, path) {
  if (!path) return Promise.resolve(null)
  if (!images.has(path))
    images.set(
      path,
      ctx
        .api('artifact-image', { path })
        .then(({ src }) => {
          ready.set(path, src)
          return src
        })
        .catch(() => null)
    )
  return images.get(path)
}

function thumbnail(ctx, path, onOpen) {
  const img = h('img', { alt: '步骤截图', loading: 'lazy', decoding: 'async' })
  if (ready.has(path)) img.src = ready.get(path)
  else imageOf(ctx, path).then((src) => src && (img.src = src))
  return h('button', { class: 'rig-thumb', type: 'button', title: '查看大图', onclick: onOpen }, img)
}

// -- lightbox ----------------------------------------------------------------------

let lightbox = null

/** Screenshots, large, one after another; Esc closes, arrows move. */
export function openLightbox(ctx, frames, index) {
  lightbox?.close()
  let at = index
  const img = h('img', { class: 'rig-lightbox__image', alt: '' })
  const caption = h('p', { class: 'rig-lightbox__caption' })
  const counter = h('span', { class: 'rig-lightbox__counter' })
  const show = () => {
    const frame = frames[at]
    caption.textContent = frame.label ?? ''
    counter.textContent = `${at + 1} / ${frames.length}`
    img.removeAttribute('src')
    imageOf(ctx, frame.image).then((src) => {
      if (src && frames[at] === frame) img.src = src
    })
  }
  const move = (delta) => {
    at = Math.max(0, Math.min(frames.length - 1, at + delta))
    show()
  }
  const onKey = (event) => {
    if (event.key === 'Escape') close()
    else if (event.key === 'ArrowRight') move(1)
    else if (event.key === 'ArrowLeft') move(-1)
  }
  const close = () => {
    document.removeEventListener('keydown', onKey)
    overlay.remove()
    lightbox = null
  }
  const overlay = h(
    'div',
    {
      class: 'rig-lightbox',
      role: 'dialog',
      'aria-label': '步骤截图',
      onclick: (event) => event.target === overlay && close()
    },
    h(
      'div',
      { class: 'rig-lightbox__frame' },
      h(
        'div',
        { class: 'rig-lightbox__bar' },
        counter,
        caption,
        h('button', { class: 'rig-lightbox__button', type: 'button', text: '◀', title: '上一张', onclick: () => move(-1) }),
        h('button', { class: 'rig-lightbox__button', type: 'button', text: '▶', title: '下一张', onclick: () => move(1) }),
        h('button', { class: 'rig-lightbox__button', type: 'button', text: '✕', title: '关闭（Esc）', onclick: () => close() })
      ),
      img
    )
  )
  document.addEventListener('keydown', onKey)
  document.body.append(overlay)
  lightbox = { close }
  show()
}

// -- the activity column ---------------------------------------------------------

function stepRow(ctx, step, frames) {
  const result = step.result
  const state = !result
    ? 'running'
    : REFUSED.has(result.error?.code)
      ? 'refused'
      : result.error
        ? 'error'
      : step.tool === 'browser_assert' && result.assertion?.passed === false
        ? 'failed'
        : step.tool === 'workspace_run' && (result.exitCode !== 0 || result.timedOut)
          ? 'failed'
          : 'done'
  const glyph = { running: '…', error: '!', failed: '✗', done: '✓', refused: '⊘' }[state]
  const label = result?.frame?.label ?? stepLabel(step.tool, step.args)
  const frameIndex = result?.screenshot ? frames.findIndex((frame) => frame.image === result.screenshot) : -1
  const row = h(
    'div',
    { class: 'rig-act', 'data-state': state },
    h('span', { class: 'rig-act__glyph', text: glyph }),
    h(
      'div',
      { class: 'rig-act__main' },
      h('span', { class: 'rig-act__label', text: label }),
      stepNote(step.tool, result) && h('span', { class: 'rig-act__note', text: stepNote(step.tool, result) })
    ),
    ctx.state.native && frameIndex >= 0
      ? thumbnail(ctx, result.screenshot, () => openLightbox(ctx, frames, frameIndex))
      : null
  )
  // A command's own words, when there is something to read.
  if (step.tool === 'workspace_run' && result?.output?.trim())
    return h(
      'div',
      { class: 'rig-act-wrap' },
      row,
      h(
        'details',
        { class: 'rig-act__more' },
        h('summary', { text: '输出' }),
        h('pre', { class: 'qp-code-block', text: result.output.trim().split('\n').slice(-40).join('\n') })
      )
    )
  return row
}

/** The conversation and the work, as the member reads it. */
export function activityView(ctx, row) {
  const frames = replayFrames(row.events)
  const blocks = activityBlocks(row)
  const running = !['completed', 'failed', 'blocked', 'cancelled'].includes(row.status)
  ctx.state.openGroups ??= new Set()
  const view = h('div', { class: 'rig-activity', id: 'timeline' })
  blocks.forEach((block, index) => {
    if (block.kind === 'user') view.append(h('div', { class: 'rig-msg rig-msg--user', text: block.text }))
    else if (block.kind === 'say') view.append(h('div', { class: 'rig-msg rig-msg--say', text: block.text }))
    else if (block.kind === 'answer')
      view.append(h('div', { class: 'rig-msg rig-msg--answer', 'data-kind': 'answer', text: block.text }))
    else if (block.kind === 'status')
      view.append(h('p', { class: 'rig-activity__status', 'data-tone': block.tone, text: block.text }))
    else if (block.kind === 'manual') {
      const index = frames.findIndex((frame) => frame.image === block.image)
      view.append(
        h(
          'div',
          { class: 'rig-act rig-act--manual', 'data-state': 'manual' },
          h('span', { class: 'rig-act__glyph', text: '✋' }),
          h('div', { class: 'rig-act__main' }, h('span', { class: 'rig-act__label', text: block.text })),
          ctx.state.native && index >= 0 ? thumbnail(ctx, block.image, () => openLightbox(ctx, frames, index)) : null
        )
      )
    }
    else {
      const key = `${row.id}:${index}`
      const last = index === blocks.length - 1
      const open = ctx.state.openGroups.has(key) || (last && running)
      const failed = block.steps.filter(
        (step) =>
          (step.result?.error && !REFUSED.has(step.result.error.code)) || step.result?.assertion?.passed === false
      ).length
      const details = h(
        'details',
        { class: 'rig-work', open, ontoggle: (event) => {
          if (event.target.open) ctx.state.openGroups.add(key)
          else ctx.state.openGroups.delete(key)
        } },
        h(
          'summary',
          { class: 'rig-work__summary' },
          h('span', { class: 'rig-work__glyph', text: last && running ? '◌' : '▸' }),
          h('span', { class: 'rig-work__text', text: stepsSummary(block.steps) }),
          failed ? h('span', { class: 'rig-work__flag', text: `${failed} 处未通过` }) : null,
          block.waiting ? h('span', { class: 'rig-work__flag', 'data-tone': 'warning', text: '等待确认' }) : null
        ),
        h('div', { class: 'rig-work__body' }, ...block.steps.map((step) => stepRow(ctx, step, frames))),
        ...(block.notes ?? []).map((note) => h('p', { class: 'rig-work__note', text: note }))
      )
      view.append(details)
    }
  })
  if (row.stream?.text) view.append(h('div', { class: 'rig-msg rig-msg--say rig-stream', text: row.stream.text }))
  const changes = workspaceChanges(row.events)
  if (changes.files.length)
    view.append(
      h(
        'details',
        { class: 'rig-changes' },
        h(
          'summary',
          {},
          h('b', { text: `${changes.files.length} 个文件已更改` }),
          h('span', { class: 'rig-changes__added', text: ` +${changes.added}` }),
          h('span', { class: 'rig-changes__removed', text: ` −${changes.removed}` })
        ),
        ...changes.files.map((entry) =>
          h(
            'p',
            { class: 'rig-changes__file' },
            h('code', { text: entry.path }),
            h('span', { class: 'rig-changes__added', text: ` +${entry.added}` }),
            h('span', { class: 'rig-changes__removed', text: ` −${entry.removed}` })
          )
        )
      )
    )
  if (running)
    view.append(
      h(
        'div',
        { class: 'rig-working', role: 'status', 'aria-live': 'polite' },
        h('span', { class: 'rig-working__dot' }),
        h('span', { text: currentActivity(row) })
      )
    )
  if (!blocks.length && !running) view.append(h('p', { class: 'qp-caption qp-muted', text: '没有记录。' }))
  return view
}

// -- the browser: live, then replay ------------------------------------------------

/** The latest frame of the page the Agent is driving (desktop only). */
export const live = {
  frame: null,
  at: 0,
  image: null,
  url: null,
  pip: null,
  open: null,
  // Takeover: the mission a person is driving the page for, and how to reach it.
  takeover: null,
  api: null,
  queue: Promise.resolve(),
  chooser: null,
  // An alert / confirm / prompt the page raised while a person has it.
  dialog: null
}

// Keys that do something other than type a character.
const SPECIAL_KEYS = new Set([
  'Enter',
  'Backspace',
  'Tab',
  'Escape',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight'
])
const BUTTONS = ['left', 'middle', 'right']

/** One piece of input, in order after the last; a failure is shown, not thrown. */
function copySelection() {
  const target = live.takeover
  if (!target || !live.api) return
  live.queue = live.queue
    .then(() => live.api('browser-copy', { id: target.id }))
    .then(({ copied }) => {
      if (live.hint) live.hint.textContent = copied ? `已复制 ${copied} 个字符到剪贴板` : '页面上没有选中的文字'
    })
    .catch((error) => {
      if (live.hint) live.hint.textContent = `没有复制：${error.message}`
    })
}

function sendInput(event) {
  const target = live.takeover
  if (!target || !live.api) return
  live.queue = live.queue
    .then(() => live.api('browser-input', { id: target.id, event }))
    .catch((error) => {
      if (live.hint) live.hint.textContent = `没有送达：${error.message}`
    })
}

/**
 * The surface a person drives the page through during takeover: it sits over
 * the live frame, turns pointer positions into the page's own coordinates,
 * and sends keys, text (including an input method's) and pastes. What is
 * typed passes through and is cleared at once.
 */
function inputSurface() {
  const sink = h('textarea', {
    class: 'rig-live__input',
    'aria-label': '在这里操作页面：点击、滚动、打字都会发到页面',
    autocomplete: 'off',
    autocorrect: 'off',
    autocapitalize: 'off',
    spellcheck: 'false'
  })
  const armed = () => Boolean(live.takeover)
  const point = (event) => {
    const rect = sink.getBoundingClientRect()
    const width = live.frame?.width || 1280
    const height = live.frame?.height || 720
    return {
      x: Math.round(((event.clientX - rect.left) / rect.width) * width),
      y: Math.round(((event.clientY - rect.top) / rect.height) * height)
    }
  }
  let lastMove = 0
  sink.addEventListener('mousemove', (event) => {
    if (!armed()) return
    const now = Date.now()
    if (now - lastMove < (event.buttons ? 30 : 80)) return
    lastMove = now
    sendInput({ type: 'move', ...point(event) })
  })
  sink.addEventListener('mousedown', (event) => {
    if (!armed()) return
    event.preventDefault()
    sink.focus()
    sendInput({ type: 'down', ...point(event), button: BUTTONS[event.button] ?? 'left', clickCount: event.detail || 1 })
  })
  sink.addEventListener('mouseup', (event) => {
    if (!armed()) return
    event.preventDefault()
    sendInput({ type: 'up', ...point(event), button: BUTTONS[event.button] ?? 'left', clickCount: event.detail || 1 })
  })
  sink.addEventListener(
    'wheel',
    (event) => {
      if (!armed()) return
      event.preventDefault()
      sendInput({ type: 'wheel', ...point(event), dx: Math.round(event.deltaX), dy: Math.round(event.deltaY) })
    },
    { passive: false }
  )
  sink.addEventListener('contextmenu', (event) => event.preventDefault())
  sink.addEventListener('keydown', (event) => {
    if (!armed() || event.isComposing || event.keyCode === 229) return
    const modifiers = [event.ctrlKey && 'Control', event.altKey && 'Alt', event.metaKey && 'Meta'].filter(Boolean)
    if (SPECIAL_KEYS.has(event.key)) {
      event.preventDefault()
      sendInput({ type: 'key', key: [...modifiers, event.shiftKey && 'Shift', event.key].filter(Boolean).join('+') })
      return
    }
    // A shortcut. Paste is left to the paste event, which carries the text;
    // copy reads the page's selection into this computer's clipboard.
    if (modifiers.length && /^[A-Za-z0-9]$/.test(event.key)) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'c') {
        event.preventDefault()
        copySelection()
        return
      }
      event.preventDefault()
      sendInput({ type: 'key', key: [...modifiers, event.shiftKey && 'Shift', event.key].filter(Boolean).join('+') })
    }
  })
  sink.addEventListener('input', (event) => {
    if (!armed() || event.isComposing || event.inputType === 'insertCompositionText') return
    if (event.data) sendInput({ type: 'text', text: event.data })
    sink.value = ''
  })
  sink.addEventListener('compositionend', (event) => {
    if (armed() && event.data) sendInput({ type: 'text', text: event.data })
    sink.value = ''
  })
  sink.addEventListener('paste', (event) => {
    if (!armed()) return
    event.preventDefault()
    const text = event.clipboardData?.getData('text')
    if (text) sendInput({ type: 'text', text })
  })
  return sink
}

function liveElement() {
  if (live.element) return live.element
  live.image = h('img', { class: 'rig-live__image', alt: 'Agent 正在操作的页面' })
  live.url = h('span', { class: 'rig-live__url' })
  live.sink = inputSurface()
  live.stage = h('div', { class: 'rig-live__stage' }, live.image, live.sink)
  live.element = h(
    'div',
    { class: 'rig-live' },
    h('div', { class: 'rig-live__bar' }, h('span', { class: 'rig-live__dot' }), h('b', { text: '实时' }), live.url),
    live.stage
  )
  return live.element
}

/** Arm or disarm the pane for a person's input. */
function armLive(target) {
  live.takeover = target
  liveElement()
  live.stage.classList.toggle('is-armed', Boolean(target))
  if (!target) live.sink.blur()
}

/** Called for every frame the desktop receives. */
export function pushFrame(frame) {
  live.frame = frame
  live.at = Date.now()
  const src = `data:image/jpeg;base64,${frame.data}`
  liveElement()
  live.image.src = src
  live.url.textContent = frame.url ?? ''
  // Somewhere else in the app: a small window in the corner, so the hand is
  // never out of sight.
  const watching = document.contains(live.element) && !document.hidden
  if (!live.pip) {
    const img = h('img', { alt: '' })
    live.pip = {
      img,
      element: h(
        'button',
        {
          class: 'rig-pip',
          type: 'button',
          title: '打开浏览器视图',
          onclick: () => live.open?.(live.frame?.missionId)
        },
        img,
        h('span', { class: 'rig-pip__label' }, h('span', { class: 'rig-live__dot' }), 'Agent 正在操作浏览器')
      ),
      timer: null
    }
  }
  if (watching) live.pip.element.remove()
  else {
    live.pip.img.src = src
    if (!document.contains(live.pip.element)) document.body.append(live.pip.element)
  }
  clearTimeout(live.pip.timer)
  live.pip.timer = setTimeout(() => live.pip.element.remove(), 5_000)
}

/**
 * The page is the person's now: the live frame takes their input, the Agent
 * waits. They hand it back — with a word for the Agent if they like — or end
 * this part of the mission.
 */
function takeoverPane(ctx, row) {
  armLive({ id: row.id })
  live.hint ??= h('span', { class: 'rig-takeover__hint' })
  live.hint.textContent =
    '点一下画面就能输入。你输入的内容只发给页面：不记录，也不给 Agent；交还时的那句话会给 Agent，别写密码。'
  const note = h('input', {
    class: 'qp-input',
    id: 'handback-note',
    placeholder: '交还时给 Agent 的一句话（可选）',
    value: ctx.state.handbackNote ?? ''
  })
  note.addEventListener('input', () => (ctx.state.handbackNote = note.value))
  const decide = (approved) =>
    ctx.run(async () => {
      await ctx.api('approve', {
        id: row.id,
        approvalId: row.pending.approvalId,
        approved,
        ...(approved && note.value.trim() ? { note: note.value.trim() } : {})
      })
      ctx.state.handbackNote = ''
      armLive(null)
      live.chooser = null
      live.dialog = null
      await ctx.refresh()
    })
  const chooser = live.chooser?.missionId === row.id ? live.chooser : null
  const asked = live.dialog?.missionId === row.id ? live.dialog : null
  return h(
    'div',
    { class: 'rig-browser rig-takeover' },
    h(
      'div',
      { class: 'rig-takeover__banner' },
      h('b', { text: row.pending.by === 'agent' ? '✋ Agent 请你来操作' : '✋ 你正在操作这个页面' }),
      row.pending.reason ? h('span', { class: 'rig-takeover__reason', text: row.pending.reason }) : null,
      live.hint
    ),
    liveElement(),
    asked ? dialogCard(ctx, row, asked) : null,
    chooser
      ? h(
          'div',
          { class: 'rig-takeover__chooser' },
          h('span', { text: '页面要你选择文件' }),
          h('button', {
            class: 'qp-button qp-button--outline qp-button--sm',
            type: 'button',
            text: '选择文件…',
            onclick: () =>
              ctx.run(async () => {
                const { files } = await ctx.api('browser-files', { id: row.id, multiple: chooser.multiple })
                if (files) live.chooser = null
                ctx.render()
              })
          })
        )
      : null,
    h(
      'div',
      { class: 'rig-takeover__actions' },
      note,
      h('button', {
        class: 'qp-button qp-button--primary qp-button--sm',
        type: 'button',
        id: 'handback',
        text: '交还给 Agent',
        onclick: () => decide(true)
      }),
      h('button', {
        class: 'qp-button qp-button--ghost qp-button--sm',
        type: 'button',
        text: '结束这一段',
        onclick: () => decide(false)
      })
    )
  )
}

/**
 * The page's own alert / confirm / prompt, which the live frames cannot show:
 * the page waits until the person answers here.
 */
function dialogCard(ctx, row, asked) {
  const kind = { alert: '页面提示', confirm: '页面要你确认', prompt: '页面要你输入', beforeunload: '离开这个页面？' }[asked.type] ?? '页面对话框'
  const field =
    asked.type === 'prompt'
      ? h('input', { class: 'qp-input', id: 'dialog-text', value: asked.text ?? asked.defaultValue ?? '', 'aria-label': '输入的内容' })
      : null
  // The page re-renders on every poll; what is typed here outlives that.
  field?.addEventListener('input', () => (asked.text = field.value))
  const answer = (accept) =>
    ctx.run(async () => {
      await ctx.api('browser-dialog', { id: row.id, accept, ...(field ? { text: field.value } : {}) })
      live.dialog = null
      ctx.render()
    })
  return h(
    'div',
    { class: 'rig-takeover__dialog', role: 'alertdialog', 'aria-label': kind },
    h('b', { text: kind }),
    h('p', { class: 'rig-takeover__dialog-text', text: asked.message || '（没有说明文字）' }),
    field,
    h(
      'div',
      { class: 'qp-row' },
      h('button', {
        class: 'qp-button qp-button--primary qp-button--sm',
        type: 'button',
        id: 'dialog-accept',
        text: '确定',
        onclick: () => answer(true)
      }),
      asked.type === 'alert'
        ? null
        : h('button', {
            class: 'qp-button qp-button--ghost qp-button--sm',
            type: 'button',
            id: 'dialog-dismiss',
            text: '取消',
            onclick: () => answer(false)
          })
    )
  )
}

const players = new Map() // mission id → { player, count, element }

/** The browser tab of a mission: live while it runs, a replay afterwards. */
export function browserPane(ctx, row) {
  const running = !['completed', 'failed', 'blocked', 'cancelled'].includes(row.status)
  // Live for as long as the mission runs: a page waiting for a person's
  // approval sends no new frames, but it is still the page as it is.
  const mine = live.frame?.missionId === row.id
  const takeover = row.status === 'awaiting_approval' && row.pending?.name === 'takeover'
  if (ctx.state.native && running && mine) {
    live.pip?.element.remove()
    live.api = ctx.api
    if (takeover) return takeoverPane(ctx, row)
    armLive(null)
    return h(
      'div',
      { class: 'rig-browser' },
      liveElement(),
      row.status === 'running' && ['agent', 'orchestration'].includes(row.mode)
        ? h(
            'div',
            { class: 'qp-row' },
            h('button', {
              class: 'qp-button qp-button--outline qp-button--sm',
              type: 'button',
              id: 'live-takeover',
              text: '接管',
              title: 'Agent 会在当前这一步结束后暂停，由你在这个画面里操作',
              onclick: () =>
                ctx.run(async () => {
                  await ctx.api('takeover', { id: row.id })
                  ctx.notice('已请求接管：Agent 会在当前这一步结束后暂停，然后你就可以在画面里操作。')
                  await ctx.refresh()
                })
            }),
            h('span', { class: 'qp-caption qp-muted', text: '需要你来输入密码或验证码时，Agent 也会自己请你接手。' })
          )
        : null
    )
  }
  if (ctx.state.native && takeover)
    return h('p', {
      class: 'qp-caption qp-muted',
      text: '画面还没有传过来；可以直接在浏览器窗口里操作，完成后在左侧点「交还给 Agent」。'
    })
  const frames = replayFrames(row.events)
  if (!frames.length)
    return h('p', {
      class: 'qp-caption qp-muted',
      text: running ? 'Agent 还没有打开浏览器。开始操作页面后，这里会实时显示它在做什么。' : '这项任务没有操作浏览器。'
    })
  if (!ctx.state.native)
    return h(
      'div',
      { class: 'rig-browser' },
      h('p', {
        class: 'qp-caption qp-muted',
        text: `这项任务操作了 ${frames.length} 步浏览器。截图保存在执行它的电脑上，在那台电脑的 MX Rig 桌面端可以回放，或从终端用 /replay 导出。`
      }),
      h('ol', { class: 'rig-browser__steps' }, ...frames.map((frame) => h('li', { text: frame.label })))
    )
  let entry = players.get(row.id)
  if (!entry || entry.count !== frames.length) {
    entry?.player.destroy()
    const holder = h('div', { class: 'rig-browser__player' })
    const player = mountReplay(holder, frames, { resolve: (path) => imageOf(ctx, path) })
    entry = { player, count: frames.length, element: holder }
    players.set(row.id, entry)
  }
  return h(
    'div',
    { class: 'rig-browser' },
    entry.element,
    h(
      'div',
      { class: 'qp-row' },
      h('button', {
        class: 'qp-button qp-button--primary qp-button--sm',
        type: 'button',
        text: entry.player.playing ? '暂停' : '播放回放',
        onclick: (event) => {
          if (entry.player.playing) entry.player.pause()
          else entry.player.play()
          event.target.textContent = entry.player.playing ? '暂停' : '播放回放'
        }
      }),
      h('button', {
        class: 'qp-button qp-button--outline qp-button--sm',
        type: 'button',
        text: '导出回放',
        onclick: () =>
          ctx.run(async () => {
            const saved = await ctx.api('replay-export', { id: row.id })
            if (saved.saved) ctx.notice(`回放已导出：${saved.path}`)
          })
      })
    )
  )
}
