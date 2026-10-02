// 回放（Replay）: a mission's browser steps, played back with the hand.
//
// Each step is a pair of frames the browser kept — the page right before the
// action (with the target's box) and the page after it. The player moves a
// cursor from the previous target to this one, outlines it, captions what is
// being done, ripples the click, and dissolves to the result. Assertions get
// a ✓ or ✗; a step that failed says so.
//
// Everything is drawn as SVG attributes and classes: the workbench is served
// under a CSP that allows no inline style, and the same file is inlined into
// the exported replay, which has no CSP at all. No imports, for the same
// reason.

const NS = 'http://www.w3.org/2000/svg'
const ARROW = 'M3 2 L3 19 L7.5 14.8 L10.6 21.5 L13.4 20.2 L10.4 13.6 L16.6 13.6 Z'
const SPEEDS = [0.5, 1, 2]

function svgNode(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag)
  for (const [key, value] of Object.entries(attrs))
    if (value !== undefined && value !== null) node.setAttribute(key, String(value))
  return node
}

function htmlNode(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

const BROWSER_TOOL = /^(browser_|electron_launch$)/

// Steps that keep a screenshot without a caption of their own.
const PLAIN = { browser_snapshot: '观察页面', browser_wait: '等待页面', browser_screenshot: '截图', electron_launch: '启动应用' }
const plain = (tool) => PLAIN[tool] ?? tool

/**
 * A mission's browser steps as frames, read from its record: each tool
 * result that kept a screenshot is a frame; a browser step that failed is a
 * frame on the last page seen, saying so.
 */
export function replayFrames(events = []) {
  const frames = []
  let call = null
  let last = null
  for (const event of events) {
    // A person took the page over: shown as a step of its own, the page as
    // they left it. What they typed was never kept.
    if (event.kind === 'takeover' && event.data?.screenshot) {
      frames.push({
        label: event.data.frame?.label ?? '人工操作',
        image: event.data.screenshot,
        viewport: event.data.frame?.viewport ?? null,
        manual: true,
        at: event.at
      })
      last = event.data.screenshot
      continue
    }
    if (event.kind === 'tool_start') {
      call = { tool: event.data?.tool ?? null, args: event.data?.args ?? {} }
      continue
    }
    if (!call || !BROWSER_TOOL.test(call.tool ?? '')) continue
    if (event.kind === 'tool_error' && last) {
      frames.push({
        label: `${plain(call.tool)} 未完成`,
        image: last,
        error: String(event.message ?? '').replace(/^\S+ 未(完成|执行)：/, ''),
        at: event.at
      })
      call = null
      continue
    }
    if (event.kind !== 'tool_result') continue
    const result = event.data?.result ?? {}
    const frame = result.frame ?? {}
    if (result.error && last) {
      frames.push({ label: frame.label ?? `${plain(call.tool)} 未完成`, image: last, error: result.error.message, at: event.at })
    } else if (result.screenshot) {
      frames.push({
        label: frame.label ?? plain(call.tool),
        image: result.screenshot,
        intent: frame.intent ?? null,
        box: frame.box ?? null,
        point: frame.point ?? null,
        viewport: frame.viewport ?? null,
        assertion: result.assertion ? Boolean(result.assertion.passed) : undefined,
        url: result.url ?? null,
        at: event.at
      })
      last = result.screenshot
    }
    call = null
  }
  return frames
}

/**
 * @param {HTMLElement} container
 * @param {Array<object>} frames  { label, image, intent?, box?, point?, viewport?, assertion?, error?, url? }
 * @param {object} [options]
 * @param {(src: string) => Promise<string>} [options.resolve] turns a frame's image reference into a URL
 * @param {boolean} [options.autoplay]
 */
export function mountReplay(container, frames, { resolve = async (src) => src, autoplay = false } = {}) {
  const size = frames.find((frame) => frame.viewport)?.viewport ?? { width: 1280, height: 720 }
  const W = size.width
  const H = size.height
  const root = htmlNode('div', 'rig-replay')
  root.tabIndex = 0
  const stage = htmlNode('div', 'rig-replay__stage')
  const canvas = svgNode('svg', { viewBox: `0 0 ${W} ${H}`, class: 'rig-replay__svg', role: 'img' })
  const base = svgNode('image', { x: 0, y: 0, width: W, height: H, preserveAspectRatio: 'xMidYMid meet' })
  const next = svgNode('image', { x: 0, y: 0, width: W, height: H, opacity: 0, preserveAspectRatio: 'xMidYMid meet' })
  const box = svgNode('rect', { class: 'rig-replay__box', rx: 6, opacity: 0 })
  const tag = svgNode('g', { class: 'rig-replay__tag', opacity: 0 })
  const tagBack = svgNode('rect', { rx: 6, height: 26 })
  const tagText = svgNode('text', { x: 10, y: 17 })
  tag.append(tagBack, tagText)
  const ripple = svgNode('circle', { class: 'rig-replay__ripple', r: 0, opacity: 0 })
  const cursor = svgNode('g', { class: 'rig-replay__cursor', opacity: 0 })
  cursor.append(svgNode('path', { d: ARROW }))
  const badge = svgNode('g', { class: 'rig-replay__badge', opacity: 0 })
  // Bottom left: the top of a page is usually its own header and title.
  const badgeBack = svgNode('rect', { x: 16, y: H - 50, rx: 8, height: 34 })
  const badgeText = svgNode('text', { x: 30, y: H - 28 })
  badge.append(badgeBack, badgeText)
  canvas.append(base, next, box, tag, ripple, cursor, badge)
  stage.append(canvas)

  const bar = htmlNode('div', 'rig-replay__bar')
  const button = (text, title, onClick) => {
    const node = htmlNode('button', 'rig-replay__button', text)
    node.type = 'button'
    node.title = title
    node.addEventListener('click', onClick)
    return node
  }
  const counter = htmlNode('span', 'rig-replay__counter')
  const caption = htmlNode('span', 'rig-replay__caption')
  const playButton = button('▶', '播放 / 暂停（空格）', () => (state.playing ? pause() : play()))
  const speedButton = button('1×', '播放速度', () => {
    state.speed = SPEEDS[(SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length]
    speedButton.textContent = `${state.speed}×`
  })
  bar.append(
    button('⏮', '回到开头', () => go(0)),
    button('◀', '上一步（←）', () => go(state.index - 1)),
    playButton,
    button('▶▏', '下一步（→）', () => go(state.index + 1)),
    speedButton,
    counter,
    caption
  )
  const steps = htmlNode('ol', 'rig-replay__steps')
  const items = frames.map((frame, index) => {
    const item = htmlNode('li')
    const mark = frame.error
      ? '!'
      : frame.manual
        ? '✋'
        : frame.assertion === true
          ? '✓'
          : frame.assertion === false
            ? '✗'
            : String(index + 1)
    const node = htmlNode('button', 'rig-replay__step')
    node.type = 'button'
    node.dataset.state = frame.error
      ? 'error'
      : frame.manual
        ? 'manual'
        : frame.assertion === false
          ? 'failed'
          : frame.assertion
            ? 'passed'
            : 'step'
    node.append(htmlNode('b', null, mark), htmlNode('span', null, frame.label ?? ''))
    node.addEventListener('click', () => go(index))
    item.append(node)
    steps.append(item)
    return node
  })
  root.append(stage, bar, steps)
  container.append(root)

  const state = { index: 0, playing: false, speed: 1, token: 0, at: null, images: new Map() }

  const image = (src) => {
    if (!src) return Promise.resolve(null)
    if (!state.images.has(src)) state.images.set(src, Promise.resolve(resolve(src)).catch(() => null))
    return state.images.get(src)
  }
  // Frames ahead are fetched while this one plays.
  const prefetch = (from) => {
    for (const frame of frames.slice(from, from + 3)) {
      image(frame.intent)
      image(frame.image)
    }
  }

  const sleep = (ms, token) =>
    new Promise((done) => setTimeout(() => done(token === state.token), ms / state.speed))
  const tween = (ms, token, update) =>
    new Promise((done) => {
      const started = performance.now()
      const step = (now) => {
        if (token !== state.token) return done(false)
        const t = Math.min(1, (now - started) / (ms / state.speed))
        update(ease(t))
        if (t < 1) requestAnimationFrame(step)
        else done(true)
      }
      requestAnimationFrame(step)
    })

  const place = (point) => {
    cursor.setAttribute('transform', `translate(${point.x - 3} ${point.y - 2})`)
    cursor.setAttribute('opacity', 1)
    state.at = point
  }
  const outline = (frame) => {
    if (!frame.box) {
      box.setAttribute('opacity', 0)
      tag.setAttribute('opacity', 0)
      return
    }
    const { x, y, width, height } = frame.box
    box.setAttribute('x', x - 4)
    box.setAttribute('y', y - 4)
    box.setAttribute('width', width + 8)
    box.setAttribute('height', height + 8)
    box.setAttribute('opacity', 1)
    tagText.textContent = frame.label ?? ''
    const textWidth = Math.min(W - 20, (tagText.getComputedTextLength?.() || (frame.label ?? '').length * 13) + 20)
    tagBack.setAttribute('width', textWidth)
    const above = y > 40
    tag.setAttribute('transform', `translate(${Math.max(4, Math.min(W - textWidth - 4, x - 4))} ${above ? y - 36 : y + height + 10})`)
    tag.setAttribute('opacity', 1)
  }
  const showBadge = (frame) => {
    const text = frame.error
      ? `未完成：${frame.error}`
      : frame.manual
        ? `✋ ${frame.label}`
        : frame.assertion === true
        ? `✓ ${frame.label}`
        : frame.assertion === false
          ? `✗ ${frame.label}`
          : frame.point
            ? ''
            : frame.label ?? ''
    if (!text) {
      badge.setAttribute('opacity', 0)
      return
    }
    badge.dataset.state = frame.error
      ? 'error'
      : frame.manual
        ? 'manual'
        : frame.assertion === false
          ? 'failed'
          : frame.assertion
            ? 'passed'
            : 'step'
    badgeText.textContent = text
    badgeBack.setAttribute('width', Math.min(W - 32, (badgeText.getComputedTextLength?.() || text.length * 14) + 28))
    badge.setAttribute('opacity', 1)
  }
  const dissolve = async (src, token) => {
    if (!src) return true
    next.setAttribute('href', src)
    const done = await tween(300, token, (t) => next.setAttribute('opacity', t))
    if (!done) return false
    base.setAttribute('href', src)
    next.setAttribute('opacity', 0)
    return true
  }

  function mark(index) {
    items.forEach((item, position) => item.classList.toggle('is-current', position === index))
    items[index]?.scrollIntoView?.({ block: 'nearest' })
    counter.textContent = `${index + 1} / ${frames.length}`
    caption.textContent = frames[index]?.label ?? ''
  }

  async function show(index, token) {
    const frame = frames[index]
    mark(index)
    prefetch(index + 1)
    badge.setAttribute('opacity', 0)
    if (frame.point && frame.intent) {
      const before = await image(frame.intent)
      if (token !== state.token) return false
      if (before) base.setAttribute('href', before)
      outline(frame)
      const from = state.at ?? { x: W / 2, y: H / 2 }
      const moved = await tween(650, token, (t) =>
        place({ x: from.x + (frame.point.x - from.x) * t, y: from.y + (frame.point.y - from.y) * t })
      )
      if (!moved) return false
      ripple.setAttribute('cx', frame.point.x)
      ripple.setAttribute('cy', frame.point.y)
      const rippled = await tween(420, token, (t) => {
        ripple.setAttribute('r', 6 + 22 * t)
        ripple.setAttribute('opacity', 0.9 * (1 - t))
      })
      if (!rippled || !(await sleep(160, token))) return false
      box.setAttribute('opacity', 0)
      tag.setAttribute('opacity', 0)
      if (!(await dissolve(await image(frame.image), token))) return false
      showBadge(frame)
      return sleep(900, token)
    }
    outline({})
    if (!(await dissolve(await image(frame.image), token))) return false
    if (frame.point) place(frame.point)
    showBadge(frame)
    return sleep(1200, token)
  }

  async function run(from) {
    const token = ++state.token
    for (let index = from; index < frames.length; index += 1) {
      state.index = index
      if (!(await show(index, token))) return
      if (!state.playing) return
    }
    state.playing = false
    playButton.textContent = '▶'
  }

  function play() {
    if (!frames.length) return
    if (state.index >= frames.length - 1 && !state.playing) state.index = 0
    state.playing = true
    playButton.textContent = '❚❚'
    run(state.index)
  }

  function pause() {
    state.playing = false
    state.token += 1
    playButton.textContent = '▶'
  }

  function go(index) {
    if (!frames.length) return
    const target = Math.max(0, Math.min(frames.length - 1, index))
    const playing = state.playing
    state.token += 1
    state.index = target
    if (playing) run(target)
    else {
      // Stepping shows the step as it ends: the result, the hand on the target.
      const token = ++state.token
      const frame = frames[target]
      mark(target)
      outline(frame.point ? frame : {})
      badge.setAttribute('opacity', 0)
      image(frame.image).then((src) => {
        if (token !== state.token) return
        if (src) base.setAttribute('href', src)
        if (frame.point) place(frame.point)
        showBadge(frame)
      })
      prefetch(target + 1)
    }
  }

  root.addEventListener('keydown', (event) => {
    if (event.key === ' ') {
      event.preventDefault()
      state.playing ? pause() : play()
    } else if (event.key === 'ArrowRight') go(state.index + 1)
    else if (event.key === 'ArrowLeft') go(state.index - 1)
  })

  if (frames.length) {
    go(0)
    if (autoplay) play()
  } else {
    const empty = htmlNode('p', 'rig-replay__empty', '这项任务没有浏览器步骤可以回放。')
    stage.replaceChildren(empty)
  }

  return {
    element: root,
    play,
    pause,
    go,
    get index() {
      return state.index
    },
    get playing() {
      return state.playing
    },
    destroy() {
      state.token += 1
      state.playing = false
      root.remove()
    }
  }
}
