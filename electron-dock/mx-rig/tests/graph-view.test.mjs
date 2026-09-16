import test from 'node:test'
import assert from 'node:assert/strict'
import { layoutGraph } from '../apps/web/graph-view.js'
import { buildMissionGraph } from '../packages/runtime/mission-graph.mjs'

const noop = async () => ({})
const shape = () =>
  buildMissionGraph({
    seedWorkflow: noop,
    plan: noop,
    act: noop,
    answer: noop,
    dispatched: noop,
    rejected: noop
  }).describe()

test('the mission graph lays out left to right with the loop drawn as a back edge', () => {
  const layout = layoutGraph(shape())
  const byName = new Map(layout.nodes.map((node) => [node.name, node]))
  assert.equal(byName.size, 7)
  // Entry first, approval after planning, execution after approval.
  assert.ok(byName.get('plan').layer < byName.get('approve').layer)
  assert.ok(byName.get('approve').layer < byName.get('act').layer)
  const loop = layout.edges.find((edge) => edge.from === 'act' && edge.to === 'plan')
  assert.equal(loop.back, true, 'act → plan is the retry loop and must be drawn as a return path')
  assert.equal(
    layout.edges.find((edge) => edge.from === 'approve' && edge.to === 'act').back,
    false
  )
  // Nothing may be positioned outside the canvas the caller sizes the SVG to.
  for (const node of layout.nodes) {
    assert.ok(node.x >= 0 && node.x + node.w <= layout.width, `${node.name} x`)
    assert.ok(node.y >= 0 && node.y + node.h <= layout.height, `${node.name} y`)
  }
})

test('an unreachable node is still drawn rather than silently dropped', () => {
  const base = shape()
  const orphan = {
    ...base,
    nodes: [
      ...base.nodes,
      { name: 'orphan', title: '孤立节点', kind: 'step', description: '', interrupts: false }
    ]
  }
  const layout = layoutGraph(orphan)
  assert.ok(layout.nodes.some((node) => node.name === 'orphan'))
})
