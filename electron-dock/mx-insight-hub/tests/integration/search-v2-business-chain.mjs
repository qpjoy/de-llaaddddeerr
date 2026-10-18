// Run after Java's PoliticalSearchContractFixtureTest. All provider responses are fixtures.
// node tests/integration/search-v2-business-chain.mjs DELTA_ROOT JAVA_FIXTURE [PYTHON]
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { normalizeDataSearchV2, prepareDataSearchV2, projectDataSearchV2 } from '../../server/contracts/data-search-v2.mjs'
import { createDataSearchV2CursorCodec, createDataSearchCursorCodec } from '../../server/external-platforms/cursor.mjs'

const [deltaRoot, fixture, python = 'python3'] = process.argv.slice(2)
assert.ok(deltaRoot && fixture, 'Provide Delta checkout and generated Java fixture paths')
const generated = spawnSync(python, [fileURLToPath(new URL('./search_v2_delta_fixture.py', import.meta.url)), deltaRoot, fixture], {
  encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
})
assert.equal(generated.status, 0, generated.stderr)
const { cases, legacy } = JSON.parse(generated.stdout)
assert.equal(cases.length, 12)
const codec = createDataSearchV2CursorCodec('integration-secret', 'tenant:consumer:key')
const oldCodec = createDataSearchCursorCodec('integration-secret', 'tenant:consumer:key')
let checks = 0
for (const { kind, platform, wire } of cases) {
  const normalized = normalizeDataSearchV2(wire)
  const prepared = prepareDataSearchV2(normalized, codec)
  const expectedStart = kind === 'cold_start' ? '2026-09-16T16:00:00.000Z'
    : kind === 'daily_report' ? '2026-09-16T16:30:00.000Z' : '2026-10-15T16:00:00.000Z'
  assert.equal(normalized.timeWindow.from, expectedStart, `${platform}/${kind} start`)
  assert.equal(normalized.timeWindow.to, '2026-10-16T16:30:00.000Z')
  if (platform === 'facebook') {
    assert.equal(prepared.upstream.params.endDate, '2026-10-17')
    assert.equal(prepared.upstream.params.startDate, kind === 'scheduled' ? '2026-10-16' : '2026-09-17')
  }
  const result = { status: 200, body: { requestId: 'fixture-request', data: {
    platform, query: normalized.query, status: 'ok', items: [
      { id: 'before', publishedAt: new Date(Date.parse(expectedStart) - 1).toISOString() },
      { id: 'start', publishedAt: expectedStart },
      { id: 'end', publishedAt: normalized.timeWindow.to },
      { id: 'missing-time' },
    ], pageInfo: { hasMore: true, nextCursor: 'underlying-provider-cursor' },
  } } }
  const projected = projectDataSearchV2(result, normalized, prepared, codec).body.data
  assert.deepEqual(projected.items.map(item => item.id), ['start'])
  assert.equal(projected.contractVersion, 'mx-insight-hub.data-search.v2')
  assert.deepEqual(projected.meta.requestedWindow, normalized.timeWindow)
  assert.equal(projected.meta.capabilities.deliveryFiltering, 'exact')
  assert.equal(projected.meta.capabilities.upstreamFiltering, platform === 'facebook' ? 'calendar_date' : 'unsupported')
  assert.equal(projected.meta.timeFilter.missingTimestamps, 1)
  assert.equal(projected.meta.timeFilter.outsideWindow, 2)
  assert.equal(projected.pageInfo.hasMore, true)
  const second = normalizeDataSearchV2({ ...wire, cursor: projected.pageInfo.nextCursor })
  assert.equal(prepareDataSearchV2(second, codec).upstream.cursor, 'underlying-provider-cursor')
  assert.throws(() => prepareDataSearchV2({ ...second, query: 'changed query' }, codec))
  assert.throws(() => prepareDataSearchV2({ ...second, timeWindow: { ...second.timeWindow, to: '2026-10-16T17:00:00.000Z' } }, codec))
  assert.throws(() => prepareDataSearchV2(second, createDataSearchV2CursorCodec('integration-secret', 'another-key')))
  assert.throws(() => oldCodec.decode(projected.pageInfo.nextCursor))
  assert.throws(() => normalizeDataSearchV2({ ...wire, cursor: oldCodec.encode({ cursor: 'old' }) }))
  checks++
}
assert.ok(!('timeWindow' in legacy) && !('params' in legacy))
console.log(`PASS: ${checks} Java → Delta → Hub cases (4 platforms × cold start/incremental/daily), exact windows, continuation, cross-version cursors, legacy wire preservation. No network or supplier calls.`)
