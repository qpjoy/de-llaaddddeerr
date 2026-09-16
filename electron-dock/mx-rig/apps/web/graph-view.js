// Orchestration rendering. The input is whatever `/api/rig/v1/graph` returns,
// which is derived from the compiled graph the runtime executes — so the
// picture is a view of the real thing, not a diagram maintained beside it.

const NODE_W = 158
const NODE_H = 52
const GAP_X = 74
const GAP_Y = 26
const PAD = 28
const TERMINAL_R = 13

/**
 * Pick the edges to draw as return paths.
 *
 * Nodes are ranked by how quickly the entry reaches them, ties broken by
 * declaration order; any edge pointing at an equal or earlier rank closes a
 * cycle. A depth-first classification would work too, but which edge it calls
 * the back edge depends on the order the entry branches happen to be listed —
 * and that is how `plan → approve` ends up drawn as the loop instead of the
 * `act → plan` retry that operators actually recognise.
 */
function feedbackEdges(shape, outgoing, entries) {
  const distance = new Map(entries.map((name) => [name, 0]))
  const queue = [...entries]
  while (queue.length) {
    const name = queue.shift()
    for (const to of outgoing.get(name) ?? []) {
      if (to === END_NODE || distance.has(to)) continue
      distance.set(to, distance.get(name) + 1)
      queue.push(to)
    }
  }
  const declared = new Map(shape.nodes.map((node, index) => [node.name, index]))
  const rank = new Map(
    [...declared.keys()]
      .sort(
        (left, right) =>
          (distance.get(left) ?? Number.MAX_SAFE_INTEGER) -
            (distance.get(right) ?? Number.MAX_SAFE_INTEGER) ||
          declared.get(left) - declared.get(right)
      )
      .map((name, index) => [name, index])
  )
  return new Set(
    shape.edges
      .filter(
        (edge) =>
          edge.from !== shape.entry &&
          edge.to !== END_NODE &&
          (rank.get(edge.to) ?? 0) <= (rank.get(edge.from) ?? 0)
      )
      .map((edge) => `${edge.from}→${edge.to}`)
  )
}

const END_NODE = '__end__'

/**
 * Layered left-to-right layout, longest path first.
 *
 * A node sits one column after the last of its forward predecessors, so an
 * approval always appears before the execution it gates even though the
 * read-only branch reaches that execution in fewer hops.
 */
export function layoutGraph(shape) {
  const outgoing = new Map()
  for (const edge of shape.edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, [])
    outgoing.get(edge.from).push(edge.to)
  }
  const entries = shape.edges.filter((edge) => edge.from === shape.entry).map((edge) => edge.to)
  const back = feedbackEdges(
    shape,
    outgoing,
    entries.length ? entries : shape.nodes.slice(0, 1).map((node) => node.name)
  )

  const layer = new Map(shape.nodes.map((node) => [node.name, 0]))
  const forward = shape.edges.filter(
    (edge) =>
      edge.from !== shape.entry && edge.to !== END_NODE && !back.has(`${edge.from}→${edge.to}`)
  )
  for (let round = 0; round <= shape.nodes.length; round++) {
    let moved = false
    for (const edge of forward) {
      const next = (layer.get(edge.from) ?? 0) + 1
      if (next > (layer.get(edge.to) ?? 0)) {
        layer.set(edge.to, next)
        moved = true
      }
    }
    if (!moved) break
  }

  // Hand-placed nodes are taken out of the automatic flow entirely: leaving
  // them in a column would let an untouched neighbour shift under them.
  const placed = shape.layout ?? {}
  const columns = new Map()
  for (const node of shape.nodes) {
    if (placed[node.name]) continue
    const index = layer.get(node.name) ?? 0
    if (!columns.has(index)) columns.set(index, [])
    columns.get(index).push(node)
  }
  const depth = columns.size ? Math.max(...columns.keys()) + 1 : 1
  const tallest = columns.size
    ? Math.max(...[...columns.values()].map((column) => column.length))
    : 1
  // Room under the last row for the return path to loop through.
  const height = PAD * 2 + tallest * NODE_H + (tallest - 1) * GAP_Y + (back.size ? 44 : 0)
  const rowSpace = height - (back.size ? 44 : 0)
  const positions = new Map()
  for (const [index, column] of columns) {
    const columnHeight = column.length * NODE_H + (column.length - 1) * GAP_Y
    const top = (rowSpace - columnHeight) / 2
    column.forEach((node, row) => {
      positions.set(node.name, {
        ...node,
        layer: index,
        x: PAD + TERMINAL_R * 2 + index * (NODE_W + GAP_X),
        y: top + row * (NODE_H + GAP_Y),
        w: NODE_W,
        h: NODE_H
      })
    })
  }
  for (const node of shape.nodes) {
    const spot = placed[node.name]
    if (!spot) continue
    positions.set(node.name, {
      ...node,
      layer: layer.get(node.name) ?? 0,
      x: spot.x,
      y: spot.y,
      w: NODE_W,
      h: NODE_H,
      pinned: true
    })
  }
  const extentX = Math.max(...[...positions.values()].map((node) => node.x + node.w), 0)
  const extentY = Math.max(...[...positions.values()].map((node) => node.y + node.h), 0)
  const width = Math.max(
    PAD * 2 + TERMINAL_R * 4 + depth * NODE_W + (depth - 1) * GAP_X,
    extentX + PAD
  )
  return {
    width,
    height: Math.max(height, extentY + PAD),
    nodes: [...positions.values()],
    start: { x: PAD, y: rowSpace / 2, r: TERMINAL_R },
    end: { x: width - PAD, y: rowSpace / 2, r: TERMINAL_R },
    edges: shape.edges.map((edge) => ({ ...edge, back: back.has(`${edge.from}→${edge.to}`) }))
  }
}

export const GRID = 8

const ns = 'http://www.w3.org/2000/svg'
const el = (tag, attrs = {}) => {
  const node = document.createElementNS(ns, tag)
  for (const [key, value] of Object.entries(attrs))
    if (value != null) node.setAttribute(key, String(value))
  return node
}

function path(from, to, back) {
  if (back) {
    // Loop back under the row so a returning edge never hides behind a node.
    const dip = Math.max(from.y + from.h, to.y + to.h) + 30
    return `M ${from.x + from.w / 2} ${from.y + from.h} C ${from.x} ${dip}, ${to.x + to.w} ${dip}, ${to.x + to.w / 2} ${to.y + to.h}`
  }
  const x1 = from.x + from.w
  const y1 = from.y + from.h / 2
  const x2 = to.x
  const y2 = to.y + to.h / 2
  const mid = x1 + (x2 - x1) / 2
  return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`
}

/** Consecutive pairs in the trace are the edges this mission actually took. */
function hotEdges(trace) {
  const hot = new Set()
  for (let index = 1; index < trace.length; index++) hot.add(`${trace[index - 1]}→${trace[index]}`)
  return hot
}

export function renderGraph(shape, { trace = [], current = null, onSelect, onMove } = {}) {
  const layout = layoutGraph(shape)
  const visited = new Set(trace)
  const hot = hotEdges(trace)
  const svg = el('svg', {
    viewBox: `0 0 ${layout.width} ${layout.height}`,
    width: layout.width,
    height: layout.height,
    role: 'img',
    'aria-label': '任务编排图'
  })
  const marker = el('marker', {
    id: 'rig-arrow',
    viewBox: '0 0 8 8',
    refX: 7,
    refY: 4,
    markerWidth: 7,
    markerHeight: 7,
    orient: 'auto-start-reverse'
  })
  marker.append(el('path', { d: 'M 0 0 L 8 4 L 0 8 z', fill: 'var(--qp-line-strong)' }))
  const defs = el('defs')
  defs.append(marker)
  svg.append(defs)

  const byName = new Map(layout.nodes.map((node) => [node.name, node]))
  const anchor = (name) =>
    name === shape.entry
      ? {
          x: layout.start.x - layout.start.r,
          y: layout.start.y - NODE_H / 2,
          w: layout.start.r * 2,
          h: NODE_H
        }
      : name === '__end__'
        ? {
            x: layout.end.x - layout.end.r,
            y: layout.end.y - NODE_H / 2,
            w: layout.end.r * 2,
            h: NODE_H
          }
        : byName.get(name)

  for (const edge of layout.edges) {
    const from = anchor(edge.from)
    const to = anchor(edge.to)
    if (!from || !to) continue
    const line = el('path', {
      class: 'rig-graph__edge',
      d: path(from, to, edge.back),
      'marker-end': 'url(#rig-arrow)',
      'data-kind': edge.kind,
      'data-hot': hot.has(`${edge.from}→${edge.to}`) ? 'true' : null
    })
    svg.append(line)
    if (edge.label && !edge.back) {
      const label = el('text', {
        class: 'rig-graph__label',
        x: from.x + from.w + (to.x - from.x - from.w) / 2,
        y: from.y + from.h / 2 + (to.y - from.y) / 2 - 6,
        'text-anchor': 'middle'
      })
      label.textContent = edge.label
      svg.append(label)
    }
  }

  for (const terminal of [
    { point: layout.start, text: '开始' },
    { point: layout.end, text: '结束' }
  ]) {
    const group = el('g', { class: 'rig-graph__terminal' })
    group.append(el('circle', { cx: terminal.point.x, cy: terminal.point.y, r: terminal.point.r }))
    const text = el('text', {
      x: terminal.point.x,
      y: terminal.point.y + terminal.point.r + 14,
      'text-anchor': 'middle'
    })
    text.textContent = terminal.text
    group.append(text)
    svg.append(group)
  }

  for (const node of layout.nodes) {
    const group = el('g', {
      class: 'rig-graph__node',
      'data-kind': node.kind,
      'data-visited': visited.has(node.name) ? 'true' : null,
      'data-current': current === node.name ? 'true' : null,
      tabindex: '0',
      role: 'button'
    })
    group.append(el('rect', { x: node.x, y: node.y, width: node.w, height: node.h, rx: 8 }))
    const title = el('text', { x: node.x + 12, y: node.y + 22 })
    title.textContent = node.title
    const sub = el('text', { x: node.x + 12, y: node.y + 38 })
    const tspan = document.createElementNS(ns, 'tspan')
    tspan.setAttribute('class', 'rig-graph__sub')
    tspan.textContent = `${node.name}${node.interrupts ? ' · 暂停点' : ''}`
    sub.append(tspan)
    group.append(title, sub)
    if (onSelect) {
      group.addEventListener('click', () => onSelect(node))
      group.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect(node)
        }
      })
    }
    if (onMove) makeDraggable(svg, group, node, onMove)
    svg.append(group)
  }
  return svg
}

/**
 * Drag a node to a fixed position.
 *
 * Screen pixels are converted through the SVG's own matrix, so dragging lands
 * where the pointer is at any zoom or container width. The move is reported on
 * release rather than on every frame: an author drags to a place, and the
 * editor should record one edit, not fifty.
 */
function makeDraggable(svg, group, node, onMove) {
  group.style.cursor = 'grab'
  group.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    const matrix = svg.getScreenCTM()
    if (!matrix) return
    const inverse = matrix.inverse()
    const toUser = (source) => {
      const point = new DOMPoint(source.clientX, source.clientY).matrixTransform(inverse)
      return { x: point.x, y: point.y }
    }
    const origin = toUser(event)
    const from = { x: node.x, y: node.y }
    let moved = false
    group.setPointerCapture(event.pointerId)
    group.style.cursor = 'grabbing'
    const onPointerMove = (move) => {
      const at = toUser(move)
      const next = { x: from.x + (at.x - origin.x), y: from.y + (at.y - origin.y) }
      if (!moved && Math.hypot(next.x - from.x, next.y - from.y) < 3) return
      moved = true
      group.setAttribute('transform', `translate(${next.x - from.x} ${next.y - from.y})`)
    }
    const onPointerUp = (up) => {
      group.releasePointerCapture(up.pointerId)
      group.style.cursor = 'grab'
      group.removeEventListener('pointermove', onPointerMove)
      group.removeEventListener('pointerup', onPointerUp)
      group.removeEventListener('pointercancel', onPointerUp)
      if (!moved) return
      const at = toUser(up)
      const snap = (value) => Math.max(0, Math.round(value / GRID) * GRID)
      onMove(node.name, {
        x: snap(from.x + (at.x - origin.x)),
        y: snap(from.y + (at.y - origin.y))
      })
    }
    group.addEventListener('pointermove', onPointerMove)
    group.addEventListener('pointerup', onPointerUp)
    group.addEventListener('pointercancel', onPointerUp)
  })
}
