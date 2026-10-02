// 领航光标（Pilot）: the Agent's hand, drawn on the page it drives.
//
// Before a click, a fill, a choice, the cursor moves to the element, the
// element is outlined and captioned with what is about to happen — 「点击
// “保存”」 — and a ripple marks the click. A person watching the browser (or
// the live view in the desktop) sees the intent before the page changes, not
// a page that jumps.
//
// It must never change what is being tested:
// - it lives in a closed shadow root on <html>, marked aria-hidden, so the
//   accessibility snapshot, locators and the page's own queries never see it;
// - every style is set through CSSOM and nothing through innerHTML, so a
//   page's strict CSP or Trusted Types cannot break it (or be broken by it);
// - it takes no pointer events, and it hides itself for every screenshot
//   that is kept as evidence (`veil`) — through its own API, because a
//   screenshot stylesheet is inline CSS that a strict page would refuse.
//
// `pilotScript` runs inside the page (Playwright's addInitScript), so it
// cannot use anything from this module's scope.

export function pilotScript() {
  if (window.top !== window || window.__mxRigPilot) return
  const set = (element, styles) => {
    for (const [key, value] of Object.entries(styles)) element.style.setProperty(key, value)
    return element
  }
  const state = { host: null, box: null, tag: null, cursor: null, ripple: null, x: -40, y: -40, shown: false }

  function install() {
    if (state.host || !document.documentElement) return
    const host = document.createElement('mx-rig-pilot')
    host.setAttribute('aria-hidden', 'true')
    set(host, {
      position: 'fixed',
      inset: '0',
      'pointer-events': 'none',
      'z-index': '2147483647',
      display: 'block',
      contain: 'strict'
    })
    const root = host.attachShadow({ mode: 'closed' })
    state.box = set(document.createElement('div'), {
      position: 'absolute',
      border: '2px solid #22d3ee',
      'border-radius': '6px',
      background: 'rgba(34, 211, 238, 0.10)',
      'box-shadow': '0 0 0 4px rgba(34, 211, 238, 0.18)',
      opacity: '0',
      transition: 'all 240ms ease'
    })
    state.tag = set(document.createElement('div'), {
      position: 'absolute',
      padding: '3px 8px',
      'border-radius': '6px',
      background: '#0b1018',
      color: '#e6fbff',
      font: '12px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
      'white-space': 'nowrap',
      'box-shadow': '0 2px 8px rgba(0, 0, 0, 0.3)',
      opacity: '0',
      transition: 'opacity 200ms ease'
    })
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('width', '24')
    svg.setAttribute('height', '24')
    svg.setAttribute('viewBox', '0 0 24 24')
    const arrow = document.createElementNS(ns, 'path')
    arrow.setAttribute('d', 'M3 2 L3 19 L7.5 14.8 L10.6 21.5 L13.4 20.2 L10.4 13.6 L16.6 13.6 Z')
    arrow.setAttribute('fill', '#0b1018')
    arrow.setAttribute('stroke', '#ffffff')
    arrow.setAttribute('stroke-width', '1.4')
    arrow.setAttribute('stroke-linejoin', 'round')
    svg.append(arrow)
    state.cursor = set(document.createElement('div'), {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '24px',
      height: '24px',
      transform: 'translate(-40px, -40px)',
      transition: 'transform 380ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 200ms ease',
      opacity: '0',
      filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.35))'
    })
    state.cursor.append(svg)
    state.ripple = set(document.createElement('div'), {
      position: 'absolute',
      width: '28px',
      height: '28px',
      'margin-left': '-14px',
      'margin-top': '-14px',
      'border-radius': '50%',
      border: '2px solid #22d3ee',
      opacity: '0'
    })
    root.append(state.box, state.tag, state.ripple, state.cursor)
    document.documentElement.append(host)
    state.host = host
  }

  function point(x, y) {
    install()
    if (!state.cursor) return
    state.x = x
    state.y = y
    set(state.cursor, { transform: `translate(${x - 3}px, ${y - 2}px)`, opacity: '1' })
    state.shown = true
  }

  function ripple(x, y) {
    install()
    if (!state.ripple) return
    set(state.ripple, { left: `${x}px`, top: `${y}px` })
    state.ripple.animate?.(
      [
        { transform: 'scale(0.4)', opacity: 0.9 },
        { transform: 'scale(1.6)', opacity: 0 }
      ],
      { duration: 480, easing: 'ease-out' }
    )
  }

  function aim(box, label) {
    install()
    if (!state.box) return
    set(state.box, {
      left: `${box.x - 4}px`,
      top: `${box.y - 4}px`,
      width: `${box.width + 8}px`,
      height: `${box.height + 8}px`,
      opacity: '1'
    })
    state.tag.textContent = label || ''
    const above = box.y > 34
    set(state.tag, {
      left: `${Math.max(4, box.x - 4)}px`,
      top: above ? `${box.y - 32}px` : `${box.y + box.height + 8}px`,
      opacity: label ? '1' : '0'
    })
  }

  function clear() {
    if (!state.box) return
    set(state.box, { opacity: '0' })
    set(state.tag, { opacity: '0' })
  }

  // Out of the picture while evidence is taken. `display`, not `visibility`:
  // an inherited visibility change runs through the children's transitions
  // and would still be on screen when the frame is taken.
  function veil(on) {
    if (state.host) set(state.host, { display: on ? 'none' : 'block' })
  }

  try {
    window.addEventListener('mousemove', (event) => point(event.clientX, event.clientY), {
      capture: true,
      passive: true
    })
    window.addEventListener('mousedown', (event) => ripple(event.clientX, event.clientY), {
      capture: true,
      passive: true
    })
    Object.defineProperty(window, '__mxRigPilot', {
      value: Object.freeze({ aim, clear, point, veil }),
      configurable: false,
      enumerable: false
    })
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install)
    else install()
  } catch {
    // A page that fights the overlay still gets tested; it just has no cursor.
  }
}

/** What a step is about to do, the way the caption and the replay say it. */
export function intentLabel(tool, target, args = {}) {
  const named = target?.label ?? target?.name ?? target?.role ?? ''
  switch (tool) {
    case 'browser_click':
    case 'click':
      return `点击「${named}」`
    case 'browser_fill':
    case 'fill': {
      const value = String(args.value ?? '')
      return `填写「${named}」${value ? `：${value.length > 24 ? `${value.slice(0, 24)}…` : value}` : ''}`
    }
    case 'browser_select':
    case 'select':
      return `在「${named}」中选择「${args.option ?? ''}」`
    case 'browser_check':
    case 'check':
      return `${args.checked === false ? '取消勾选' : '勾选'}「${named}」`
    default:
      return named ? `操作「${named}」` : '操作'
  }
}
