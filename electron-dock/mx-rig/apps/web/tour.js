// 演示一遍 (docs/24): walks a person through a tour in their own window.
//
// Nothing here runs until someone starts a tour: this module is imported on
// that click, draws into a layer of its own outside #view, and takes the layer
// and every listener away when the tour ends. It acts only through the page —
// the same buttons a person presses — so a tour can do nothing a person could
// not, and what it builds is an ordinary project, plan or runner.
//
// Three speeds: 跟做 points and waits for the person to press; 演示 presses at
// reading pace; 快速准备 presses without stopping to explain. All three stop at
// the step marked 'final' — the first step of the real flow is the person's.
// While it presses for them, any input of theirs outside the panel pauses it:
// a tour never fights a person for the mouse.

import { TOURS } from './tours.js'
import { h } from './views.js'

const SVG = 'http://www.w3.org/2000/svg'
const ARROW = 'M3 2 L3 19 L7.5 14.8 L10.6 21.5 L13.4 20.2 L10.4 13.6 L16.6 13.6 Z'
const MODES = {
  follow: { label: '跟做', dwell: 0, read: 0 },
  demo: { label: '演示', dwell: 900, read: 2600 },
  fast: { label: '快速准备', dwell: 120, read: 150 }
}
const FIND_MS = 10_000
const SETTLE_MS = 1_500

class Ended extends Error {}
class Skipped extends Error {}

let active = null

/** Start `id`, unless a tour is already running (then it is brought back into view). */
export function runTour(ctx, id) {
  const tour = TOURS.find((entry) => entry.id === id)
  if (!tour) return null
  if (active) return active
  active = new TourRun(ctx, tour)
  active.start()
  return active
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const svg = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
  return node
}
const visible = (node) => Boolean(node && node.isConnected && node.getClientRects().length)
const calm = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
// Out of view: partly, for what fits in the window; entirely, for what does not.
const offscreen = (box) =>
  box.height < window.innerHeight ? box.top < 0 || box.bottom > window.innerHeight : box.bottom < 0 || box.top > window.innerHeight

class TourRun {
  constructor(ctx, tour) {
    this.ctx = ctx
    this.tour = tour
    this.mode = null
    this.index = -1
    this.state = 'intro'
    this.skipped = []
    this.cursor = { x: window.innerWidth / 2, y: window.innerHeight - 120 }
    this.aim = null
    this.waiters = new Set()
    this.frame = 0
    this.ended = new Promise((resolve) => (this.markEnded = resolve))
    // What {{key}} in a step stands for: when the tour started, and what the
    // desktop says about the tour's context.
    this.context = { stamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }) }
  }

  // -- the layer -------------------------------------------------------------

  start() {
    this.layer = h('div', { id: 'tour', class: 'rig-tour rig-print-hide', 'data-tour': this.tour.id })
    this.overlay = svg('svg', { class: 'rig-tour__overlay', 'aria-hidden': 'true' })
    this.ring = svg('rect', { class: 'rig-tour__ring', rx: 10, opacity: 0 })
    this.ripple = svg('circle', { class: 'rig-tour__ripple', r: 0, opacity: 0 })
    this.pointer = svg('g', { class: 'rig-tour__cursor', opacity: 0 })
    this.pointer.append(svg('path', { d: ARROW }))
    this.overlay.append(this.ring, this.ripple, this.pointer)
    this.panel = h('section', { class: 'qp-panel rig-tour__panel', role: 'dialog', 'aria-live': 'polite', 'aria-label': '演示一遍' })
    this.layer.append(this.overlay, this.panel)
    document.body.append(this.layer)
    this.onKey = (event) => {
      if (event.isTrusted && ['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(event.key)) this.onScrollIntent(event)
      if (event.key === 'Escape' && this.state === 'running') this.pause('你按了 Esc，演示暂停了。')
      else if (event.isTrusted && this.takesOver(event)) this.pause()
    }
    this.onPointer = (event) => {
      if (event.isTrusted && this.takesOver(event)) this.pause()
    }
    // Once the person scrolls by themselves, the tour stops scrolling for them.
    this.onScrollIntent = (event) => {
      if (event.isTrusted && !this.panel.contains(event.target)) this.userScrolled = true
    }
    window.addEventListener('keydown', this.onKey, true)
    window.addEventListener('pointerdown', this.onPointer, true)
    window.addEventListener('wheel', this.onScrollIntent, { capture: true, passive: true })
    window.addEventListener('touchmove', this.onScrollIntent, { capture: true, passive: true })
    // The tour's panel stands in for the 系统 panel while it runs, so that
    // never covers what is pointed at; the reader's own setting is untouched.
    document.body.classList.add('rig-touring')
    this.mark()
    this.intro()
  }

  end() {
    if (this.state === 'gone') return
    this.state = 'gone'
    cancelAnimationFrame(this.frame)
    window.removeEventListener('keydown', this.onKey, true)
    window.removeEventListener('pointerdown', this.onPointer, true)
    window.removeEventListener('wheel', this.onScrollIntent, true)
    window.removeEventListener('touchmove', this.onScrollIntent, true)
    document.body.classList.remove('rig-touring')
    for (const wake of this.waiters) wake()
    this.waiters.clear()
    this.markEnded('gone')
    this.layer.remove()
    if (active === this) active = null
  }

  /** Only the speeds that press for the person can be taken over. */
  takesOver(event) {
    if (this.state !== 'running' || this.mode === 'follow') return false
    if (this.panel.contains(event.target)) return false
    // Modifier keys alone, scrolling keys and the like are not taking over.
    if (event.type === 'keydown' && ['Shift', 'Control', 'Alt', 'Meta', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown'].includes(event.key)) return false
    return true
  }

  mark() {
    Object.assign(this.layer.dataset, {
      state: this.state,
      mode: this.mode ?? '',
      index: String(this.index),
      step: this.step?.id ?? ''
    })
  }

  get step() {
    return this.tour.steps[this.index] ?? null
  }

  // -- the panel -------------------------------------------------------------

  draw(spec = {}) {
    const { status = null, buttons = [], body = [] } = spec
    // What a resumed tour shows again.
    if (this.state !== 'paused') this.lastDraw = spec
    const step = this.step
    const total = this.tour.steps.length
    this.jump = h('button', {
      type: 'button',
      class: 'qp-button qp-button--outline qp-button--sm',
      'data-tour-action': 'jump',
      text: '滚到高亮处',
      hidden: true,
      onclick: () => {
        const node = this.aim && document.querySelector(this.aim)
        if (node) node.scrollIntoView({ block: 'center', behavior: calm() ? 'auto' : 'smooth' })
      }
    })
    // replaceChildren would write a null out as the text "null".
    const parts = [
      h(
        'div',
        { class: 'rig-tour__head' },
        h('strong', { class: 'qp-body-2 qp-body-2--semibold', text: `演示一遍 · ${this.tour.title}` }),
        h(
          'span',
          { class: 'qp-caption qp-muted' },
          this.mode ? `${MODES[this.mode].label}` : '',
          step && this.index >= 0 ? ` · ${this.index + 1} / ${total}` : ''
        )
      ),
      this.jump,
      ...body,
      status ? h('p', { class: 'qp-caption qp-muted rig-tour__status', text: status }) : null,
      buttons.length ? h('div', { class: 'qp-row rig-tour__actions' }, ...buttons) : null
    ]
    this.panel.replaceChildren(...parts.filter(Boolean))
    this.mark()
  }

  button(text, action, onclick, primary = false) {
    return h('button', {
      type: 'button',
      class: `qp-button qp-button--sm ${primary ? 'qp-button--primary' : 'qp-button--ghost'}`,
      'data-tour-action': action,
      text,
      onclick
    })
  }

  intro() {
    const { native, principal } = this.ctx.state
    const rank = { viewer: 0, operator: 1, admin: 2 }
    const blocked =
      this.tour.native && !native
        ? '这个演示要在桌面端进行：源码快照和本机执行机只在桌面端。'
        : (rank[principal?.role] ?? -1) < rank[this.tour.role]
          ? '这个演示里有只有管理员能做的步骤。'
          : null
    const writes = this.tour.creates.length
    this.draw({
      body: [
        h('p', { class: 'qp-body-2', text: this.tour.summary }),
        writes
          ? h(
              'div',
              { class: 'rig-tour__creates' },
              h('p', { class: 'qp-caption', text: '会新建（已有的直接沿用，不删除、不改动）：' }),
              h('ul', {}, ...this.tour.creates.map((item) => h('li', { class: 'qp-caption', text: item })))
            )
          : h('p', { class: 'qp-caption', text: '只读：不会新建或改动任何东西。' }),
        h('p', {
          class: 'qp-caption qp-muted',
          text: '「跟做」由你按高亮的按钮；「演示」和「快速准备」替你按，你在别处点一下或按 Esc 就会暂停。最后一步（正式流程）总是由你来按。'
        }),
        blocked ? h('p', { class: 'qp-caption rig-tour__blocked', text: blocked }) : null
      ],
      buttons: blocked
        ? [this.button('关闭', 'close', () => this.end())]
        : [
            this.button('跟做（第一次推荐）', 'follow', () => this.begin('follow'), true),
            this.button('演示', 'demo', () => this.begin('demo')),
            this.button('快速准备', 'fast', () => this.begin('fast')),
            this.button('取消', 'cancel', () => this.end())
          ]
    })
  }

  // -- playing ---------------------------------------------------------------

  async begin(mode) {
    this.mode = mode
    this.state = 'running'
    this.overlay.classList.add('is-on')
    this.track()
    try {
      if (this.tour.context === 'proving-ground') Object.assign(this.context, await this.ctx.api('proving-ground-status'))
      for (this.index = 0; this.index < this.tour.steps.length; this.index += 1) {
        this.mark()
        if (await this.notNeeded(this.step)) {
          this.skipped.push(this.step.id)
          continue
        }
        try {
          await this.perform(this.step)
        } catch (error) {
          if (!(error instanceof Skipped)) throw error
          this.skipped.push(this.step.id)
        }
      }
      this.finish()
    } catch (error) {
      if (!(error instanceof Ended)) {
        this.state = 'lost'
        this.draw({
          body: [h('p', { class: 'qp-body-2', text: `演示中断：${error.message}` })],
          buttons: [this.button('结束', 'end', () => this.end(), true)]
        })
      }
    }
  }

  finish() {
    this.state = 'done'
    this.aim = null
    this.draw({
      body: [h('p', { class: 'qp-body-2', text: this.tour.finish })],
      buttons: [this.button('关闭', 'close', () => this.end(), true)]
    })
  }

  async perform(step) {
    step = { ...step, until: step.until ?? (step.action === 'fill' ? { fields: step.fields } : undefined) }
    // A tour only does what is still missing.
    if (step.until && (await this.holds(step.until))) return
    for (;;) {
      // Paused: nothing is drawn or pressed until the person says 继续.
      await this.beat(0)
      const node = await this.find(step)
      await this.beat(0)
      if (this.aim !== step.target) this.userScrolled = false
      this.aim = step.target
      this.reveal(node)
      if (step.action === 'final') return this.atFinal(step)
      if (this.mode === 'follow') {
        const done = await this.follow(step)
        if (done) return
        continue
      }
      // 演示 and 快速准备: a beat to see what is about to happen, then do it.
      this.draw({ body: [this.say(step)], status: step.action === 'look' ? null : '马上替你按这一步……', buttons: this.runningButtons(step) })
      await this.beat(step.action === 'look' ? MODES[this.mode].read : MODES[this.mode].dwell)
      if (this.consumeSkip()) throw new Skipped()
      if (step.action === 'look') return
      const fresh = await this.find(step)
      await this.beat(0)
      await this.act(step, fresh)
      if (!step.until) return
      this.draw({
        body: [this.say(step)],
        status: step.action === 'pick' ? '请在系统对话框里选择；选好后自动继续。' : '等它完成……',
        buttons: this.runningButtons(step)
      })
      if (await this.waitFor(step.until, step.wait ?? 15_000)) return
      if (this.consumeSkip()) throw new Skipped()
      throw new Error(`「${step.say.slice(0, 18)}…」这一步没有完成`)
    }
  }

  /** 跟做: point, and wait for the person — or for 替我做这一步, 下一步 or 跳过. */
  async follow(step) {
    const choice = this.choice()
    const buttons = [
      step.action === 'look'
        ? this.button('下一步', 'next', () => choice.pick('next'), true)
        : this.button('替我做这一步', 'do', () => choice.pick('do')),
      step.optional ? this.button('跳过这一步', 'skip', () => choice.pick('skip')) : null,
      this.button('结束', 'end', () => this.end())
    ].filter(Boolean)
    this.draw({
      body: [this.say(step)],
      status:
        step.action === 'look'
          ? null
          : step.action === 'pick'
            ? '请按高亮的按钮，在系统对话框里选择。'
            : step.action === 'fill'
              ? `请填写：${step.fields.map((field) => this.resolve(field.value).split('\n')[0].slice(0, 40)).join('；')}`
              : '请按高亮的地方。',
      buttons
    })
    const watching = step.until ? this.watch(step.until) : step.action === 'look' ? null : this.pressed(step.target)
    const answer = await this.race([choice.promise, watching?.promise.then(() => 'done')])
    watching?.cancel()
    if (answer === 'skip') throw new Skipped()
    if (answer === 'done' || answer === 'next') return true
    if (answer === 'do') {
      await this.act(step, await this.find(step))
      if (!step.until) return true
      this.draw({ body: [this.say(step)], status: '等它完成……', buttons: [this.button('结束', 'end', () => this.end())] })
      if (await this.waitFor(step.until, step.wait ?? 15_000)) return true
      throw new Error(`「${step.say.slice(0, 18)}…」这一步没有完成`)
    }
    return false
  }

  /** The real flow starts here, and the person starts it. */
  async atFinal(step) {
    this.state = 'final'
    // 跟做 to the end is the one way a tour counts in 系统 (界面上报): the
    // person pressed every step themselves. 演示 and 快速准备 do not count.
    if (this.mode === 'follow') this.ctx.signal?.('tour_followed')
    this.draw({
      body: [this.say(step)],
      status: '这一步由你来按。',
      buttons: [this.button('结束演示', 'end', () => this.end())]
    })
    const press = this.pressed(step.target)
    await this.race([press.promise])
    press.cancel()
    this.state = 'running'
  }

  say(step) {
    return h('p', { class: 'qp-body-1 rig-tour__say', text: step.say })
  }

  runningButtons(step) {
    return [
      step.optional ? this.button('跳过这一步', 'skip', () => (this.skipRequested = true)) : null,
      this.button('暂停', 'pause', () => this.pause('演示暂停了。')),
      this.button('结束', 'end', () => this.end())
    ].filter(Boolean)
  }

  consumeSkip() {
    const skip = Boolean(this.skipRequested)
    this.skipRequested = false
    return skip
  }

  pause(reason = '你接手了：演示暂停，页面照常可用。') {
    if (this.state !== 'running') return
    this.state = 'paused'
    this.draw({
      body: [this.step ? this.say(this.step) : null],
      status: reason,
      buttons: [this.button('继续', 'resume', () => this.resume(), true), this.button('结束', 'end', () => this.end())]
    })
  }

  resume() {
    if (this.state !== 'paused') return
    this.state = 'running'
    if (this.lastDraw) this.draw(this.lastDraw)
    else this.mark()
    for (const wake of this.waiters) wake()
    this.waiters.clear()
  }

  /** Wait `ms`, longer while paused; an ended tour stops here. */
  async beat(ms) {
    let left = ms
    while (left > 0 || this.state === 'paused') {
      this.alive()
      if (this.state === 'paused') {
        await new Promise((resolve) => this.waiters.add(resolve))
        continue
      }
      const slice = Math.min(left, 100)
      await sleep(slice)
      left -= slice
    }
    this.alive()
  }

  alive() {
    if (this.state === 'gone') throw new Ended()
  }

  choice() {
    let pick
    const promise = new Promise((resolve) => (pick = resolve))
    return { promise, pick }
  }

  /** The first of `promises` to settle; an ended tour stops the wait. */
  async race(promises) {
    const answer = await Promise.race([...promises.filter(Boolean), this.ended])
    this.alive()
    return answer
  }

  /** The person's own press of `selector` (not the tour's), until cancelled. */
  pressed(selector) {
    let listen
    const promise = new Promise((resolve) => {
      listen = (event) => {
        if (!event.isTrusted) return
        const target = document.querySelector(selector)
        if (target && (target === event.target || target.contains(event.target))) resolve(true)
      }
      window.addEventListener('click', listen, true)
    })
    const cancel = () => window.removeEventListener('click', listen, true)
    promise.then(cancel)
    this.ended.then(cancel)
    return { promise, cancel }
  }

  /** `condition` coming true, polled until it does or the watch is cancelled. */
  watch(condition, timeoutMs = Infinity) {
    const token = { stopped: false }
    const promise = this.waitFor(condition, timeoutMs, token).then((ok) => (ok ? true : new Promise(() => {})), () => new Promise(() => {}))
    return { promise, cancel: () => (token.stopped = true) }
  }

  // -- reading the page and the service --------------------------------------

  async notNeeded(step) {
    if (!step.skipIf) return false
    if (step.skipIf.state) return this.stateHolds(step.skipIf.state)
    if (step.skipIf.absent) {
      // Give a fresh render a moment before deciding something is not there.
      const deadline = Date.now() + SETTLE_MS
      while (Date.now() < deadline) {
        if (visible(document.querySelector(step.skipIf.absent))) return false
        await this.beat(100)
      }
      return !visible(document.querySelector(step.skipIf.absent))
    }
    return false
  }

  async holds(condition) {
    if (typeof condition === 'string') return visible(document.querySelector(this.resolve(condition)))
    if (condition.state) return this.stateHolds(condition.state)
    if (condition.fields)
      return condition.fields.every((field) => document.querySelector(field.selector)?.value === this.resolve(field.value))
    const node = document.querySelector(condition.selector)
    if (!node) return false
    if (condition.value != null) return node.value === this.resolve(condition.value)
    if (condition.valueIncludes != null) return String(node.value ?? '').includes(this.resolve(condition.valueIncludes))
    if (condition.filled) return String(node.value ?? '').trim() !== ''
    if (condition.text != null) return (node.textContent ?? '').includes(this.resolve(condition.text))
    if (condition.notText != null) return !(node.textContent ?? '').includes(this.resolve(condition.notText))
    return visible(node)
  }

  /** `{{key}}` from the tour's context. */
  resolve(text) {
    return String(text).replace(/\{\{(\w+)\}\}/g, (_, key) => String(this.context[key] ?? ''))
  }

  async stateHolds(name) {
    const { native } = this.ctx.state
    if (name === 'runner-running') return Boolean(native && (await this.ctx.api('runner-status').catch(() => null))?.running)
    const workspace = /^workspace:(.+)$/.exec(name)
    if (workspace) return Boolean(native && (await this.ctx.api('workspace-status', { app: workspace[1] }).catch(() => null))?.exists)
    const app = /^app:(.+)$/.exec(name)
    if (app) return Boolean((await this.ctx.api('apps').catch(() => null))?.apps?.some((entry) => entry.slug === app[1]))
    if (name === 'proving-ground-running') return Boolean(native && (await this.ctx.api('proving-ground-status').catch(() => null))?.running)
    return false
  }

  async waitFor(condition, timeoutMs, token = { stopped: false }) {
    const deadline = Date.now() + timeoutMs
    const every = typeof condition === 'object' && condition.state ? 1000 : 150
    for (;;) {
      this.alive()
      if (token.stopped) return false
      if (await this.holds(condition)) return true
      if (Date.now() >= deadline) return false
      await sleep(every)
    }
  }

  /** The step's target, waiting for the page to draw it; asks the person when it does not come. */
  async find(step) {
    for (;;) {
      const deadline = Date.now() + FIND_MS
      while (Date.now() < deadline) {
        this.alive()
        const node = document.querySelector(step.target)
        if (visible(node)) return node
        await sleep(150)
      }
      this.aim = null
      this.state = 'lost'
      const choice = this.choice()
      this.draw({
        body: [this.say(step)],
        status: step.missing ?? '找不到这一步要指的地方：可能页面还没出来，或者你去了别的页面。回到那一页，演示会自己接上。',
        buttons: [
          this.button('再找一次', 'retry', () => choice.pick('retry'), true),
          step.optional ? this.button('跳过这一步', 'skip', () => choice.pick('skip')) : null,
          this.button('结束', 'end', () => this.end())
        ].filter(Boolean)
      })
      // The person may go back to the page by themselves: then it just goes on.
      const back = this.watch(step.target)
      const answer = await this.race([choice.promise, back.promise.then(() => 'back')])
      back.cancel()
      this.state = 'running'
      this.mark()
      if (answer === 'skip') throw new Skipped()
    }
  }

  /** Press, choose or open — the way a person would, through the page. */
  async act(step, node) {
    this.alive()
    if (step.action === 'fill') {
      for (const field of step.fields) {
        const input = document.querySelector(field.selector)
        if (!input) throw new Error(`找不到要填写的地方：${field.selector}`)
        await this.glide(input)
        this.splash()
        this.put(input, this.resolve(field.value))
        await this.beat(this.mode === 'demo' ? 300 : 0)
      }
      return
    }
    await this.glide(node)
    this.splash()
    if (step.action === 'select') this.put(node, this.resolve(step.value))
    else node.click()
  }

  /** Set a field the way typing does: the page hears the same events. */
  put(input, value) {
    input.value = value
    input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  }

  // -- drawing the cursor and the ring ---------------------------------------

  reveal(node, behavior = calm() ? 'auto' : 'smooth') {
    this.revealedAt = performance.now()
    if (offscreen(node.getBoundingClientRect())) node.scrollIntoView({ block: 'center', behavior })
  }

  /** Follow the target every frame: the page redraws under the tour. */
  track() {
    const tick = () => {
      if (this.state === 'gone') return
      const node = this.aim && document.querySelector(this.aim)
      if (visible(node)) {
        const box = node.getBoundingClientRect()
        // A redraw puts the page back where it was scrolled before; bring the
        // target back into view — until the person scrolls by themselves.
        if (offscreen(box) && !this.userScrolled && this.state !== 'paused' && performance.now() - (this.revealedAt ?? 0) > 900) this.reveal(node, 'auto')
        if (this.jump) this.jump.hidden = !offscreen(box)
        const pad = 6
        this.ring.setAttribute('x', box.left - pad)
        this.ring.setAttribute('y', box.top - pad)
        this.ring.setAttribute('width', box.width + pad * 2)
        this.ring.setAttribute('height', box.height + pad * 2)
        this.ring.setAttribute('opacity', 1)
        if (!this.gliding) this.place(this.restingPoint(box))
        this.pointer.setAttribute('opacity', 1)
        // The panel never sits on what it points at.
        this.panel.classList.toggle('rig-tour__panel--top', box.bottom > window.innerHeight - 240)
      } else {
        this.ring.setAttribute('opacity', 0)
      }
      this.frame = requestAnimationFrame(tick)
    }
    this.frame = requestAnimationFrame(tick)
  }

  restingPoint(box) {
    return { x: box.left + Math.min(28, box.width / 2), y: box.top + box.height / 2 }
  }

  place(point) {
    this.cursor = point
    this.pointer.setAttribute('transform', `translate(${point.x - 3} ${point.y - 2})`)
  }

  async glide(node) {
    const to = this.restingPoint(node.getBoundingClientRect())
    if (calm()) return this.place(to)
    const from = { ...this.cursor }
    const ms = this.mode === 'fast' ? 160 : 520
    const started = performance.now()
    this.gliding = true
    try {
      for (;;) {
        const t = Math.min(1, (performance.now() - started) / ms)
        const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
        this.place({ x: from.x + (to.x - from.x) * ease, y: from.y + (to.y - from.y) * ease })
        if (t >= 1) break
        await new Promise((resolve) => requestAnimationFrame(resolve))
        this.alive()
      }
    } finally {
      this.gliding = false
    }
  }

  splash() {
    if (calm()) return
    const { x, y } = this.cursor
    const started = performance.now()
    const grow = () => {
      const t = Math.min(1, (performance.now() - started) / 420)
      this.ripple.setAttribute('cx', x)
      this.ripple.setAttribute('cy', y)
      this.ripple.setAttribute('r', 6 + t * 22)
      this.ripple.setAttribute('opacity', 1 - t)
      if (t < 1 && this.state !== 'gone') requestAnimationFrame(grow)
    }
    requestAnimationFrame(grow)
  }
}
