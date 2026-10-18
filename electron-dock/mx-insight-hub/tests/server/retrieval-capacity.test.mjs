import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { ES_CAPACITY_ENDPOINTS, inspectElasticsearchCapacity, summarizeSample } from '../../server/scripts/retrieval-capacity.mjs'

test('capacity endpoints are fixed Hub metadata and filtered statistics, without content or node addresses', () => {
  assert.equal(Object.isFrozen(ES_CAPACITY_ENDPOINTS), true)
  assert.deepEqual(Object.keys(ES_CAPACITY_ENDPOINTS), [
    'version', 'allocation', 'indices', 'watermarks', 'vectorMappings', 'aliases', 'indexSettings', 'indexStats', 'nodeStats',
  ])
  for (const [name, path] of Object.entries(ES_CAPACITY_ENDPOINTS)) {
    const url = new URL(path, 'http://metadata.invalid')
    assert.doesNotMatch(path, /(?:_search|_doc|_bulk|_refresh|_forcemerge|_reindex|_tasks)(?:[/?]|$)/)
    assert.ok(url.searchParams.has('h') || url.searchParams.has('filter_path'), name)
    if (['indices', 'vectorMappings', 'aliases', 'indexSettings', 'indexStats'].includes(name)) {
      assert.match(url.pathname, /mx-insight-hub\*/)
    }
  }
  const nodes = new URL(ES_CAPACITY_ENDPOINTS.nodeStats, 'http://metadata.invalid')
  assert.equal(nodes.pathname, '/_nodes/stats/jvm,fs,thread_pool,indexing_pressure')
  assert.equal(nodes.searchParams.get('timeout'), '10s')
  const filter = nodes.searchParams.get('filter_path')
  assert.doesNotMatch(filter, /(?:address|host|ip|http|transport|attributes|failures|fs\.data)/)
  for (const metric of ['jvm.mem.heap_used_percent', 'jvm.gc.collectors.*.collection_count', 'fs.io_stats.total', 'thread_pool.write', 'thread_pool.write_coordination', 'indexing_pressure.memory']) {
    assert.ok(filter.includes(`nodes.*.${metric}`), metric)
  }
  assert.doesNotMatch(ES_CAPACITY_ENDPOINTS.allocation, /(?:[=,])(?:ip|host)(?:,|$)/)
  const settings = new URL(ES_CAPACITY_ENDPOINTS.indexSettings, 'http://metadata.invalid')
  assert.equal(settings.pathname, '/mx-insight-hub*/_settings/index.refresh_interval,index.number_of_shards,index.number_of_replicas')
  assert.equal(settings.searchParams.get('include_defaults'), 'true')
  assert.doesNotMatch(settings.searchParams.get('filter_path'), /(?:settings|defaults)(?:,|$)/)
  assert.match(ES_CAPACITY_ENDPOINTS.indexStats, /\/_stats\/indexing,search,merge,refresh\?level=indices&/)
  assert.match(ES_CAPACITY_ENDPOINTS.indexStats, /indices\.\*\.primaries\.merges/)
  assert.match(ES_CAPACITY_ENDPOINTS.indexStats, /indices\.\*\.total\.refresh/)
  assert.doesNotMatch(ES_CAPACITY_ENDPOINTS.indexStats, /level=shards|groups=/)
})

test('capacity probe issues one bounded GET at a time, with no request bodies or writes', async () => {
  const calls = []
  let active = 0, maxActive = 0
  const report = await inspectElasticsearchCapacity({ async request(...args) {
    calls.push(args)
    maxActive = Math.max(maxActive, ++active)
    await new Promise(setImmediate)
    active--
    return {}
  } })
  assert.equal(maxActive, 1)
  assert.deepEqual(calls, Object.values(ES_CAPACITY_ENDPOINTS).map(path => ['GET', path, undefined, { timeoutMs: 10000 }]))
  assert.ok(Date.parse(report.completedAt) >= Date.parse(report.observedAt))
  assert.match(report.limits, /cumulative counters: compare spaced samples/)
  assert.match(report.limits, /all workloads.*not just Hub/)
  assert.match(report.limits, /Aliases match alias names.*not every cluster reference/)
  assert.match(report.limits, /not evidence that an index is safe to delete/)
  assert.match(report.limits, /Missing fields are unavailable, not zero/)
})

test('unavailable endpoints remain partial evidence and redact exception bodies and credentials', async () => {
  let requests = 0
  const report = await inspectElasticsearchCapacity({ async request(method, path) {
    requests++
    if (path === ES_CAPACITY_ENDPOINTS.aliases) throw Object.assign(Error('http://user:secret@private:9200'), { status: 403, body: { transport_address: 'private:9300' } })
    if (path === ES_CAPACITY_ENDPOINTS.nodeStats) throw { status: 'http://secret@private', code: 'secret', body: 'private:9300' }
    return {}
  } })
  assert.equal(requests, Object.keys(ES_CAPACITY_ENDPOINTS).length)
  assert.deepEqual(report.aliases, { unavailable: true, status: 403 })
  assert.deepEqual(report.nodeStats, { unavailable: true, status: null })
  assert.deepEqual(report.indexSettings, {})
  assert.doesNotMatch(JSON.stringify(report), /secret|private|transport_address/)
})

test('watermarks keep their flat report shape while unrelated settings never reach the report', async () => {
  const report = await inspectElasticsearchCapacity({ async request(method, path) {
    if (path !== ES_CAPACITY_ENDPOINTS.watermarks) return {}
    return {
      persistent: { cluster: { routing: { allocation: { disk: { threshold_enabled: true, watermark: { high: '90%', flood_stage: { max_headroom: '100gb' } } }, secret: 'excluded' } } } },
      defaults: { cluster: { routing: { allocation: { disk: { watermark: { low: '85%' } } } } } },
      transient: { secret: 'excluded' },
    }
  } })
  assert.deepEqual(report.watermarks, {
    persistent: {
      'cluster.routing.allocation.disk.threshold_enabled': true,
      'cluster.routing.allocation.disk.watermark.high': '90%',
      'cluster.routing.allocation.disk.watermark.flood_stage.max_headroom': '100gb',
    },
    transient: {},
    defaults: { 'cluster.routing.allocation.disk.watermark.low': '85%' },
  })
  assert.doesNotMatch(JSON.stringify(report), /excluded|secret/)
})

test('filtered counters preserve explicit zero and missing optional metrics without inferring health', async () => {
  const value = { _nodes: { total: 1, successful: 1, failed: 0 }, nodes: { node1: { timestamp: 1000, jvm: { uptime_in_millis: 2000, mem: { heap_used_percent: 21 } }, thread_pool: { write: { queue: 0, rejected: 0 } } } } }
  const report = await inspectElasticsearchCapacity({ async request(method, path) {
    return path === ES_CAPACITY_ENDPOINTS.nodeStats ? value : {}
  } })
  assert.deepEqual(report.nodeStats, value)
  assert.equal(report.nodeStats.nodes.node1.fs, undefined)
  assert.equal(report.nodeStats.nodes.node1.indexing_pressure, undefined)
})

test('standalone shell uses the same ES helper, fixed endpoints and capacity logic before image rollout', async () => {
  const [module, shell] = await Promise.all([
    readFile(new URL('../../server/scripts/retrieval-capacity.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/inspect-retrieval-capacity.sh', import.meta.url), 'utf8'),
  ])
  const start = '// Fixed metadata/statistics GETs only.'
  const moduleLogic = module.slice(module.indexOf(start), module.indexOf('\nif (process.argv[1]')).trim()
  const shellLogic = shell.slice(shell.indexOf(start), shell.indexOf('\ntry { console.log(JSON.stringify(await inspectCapacity')).trim()
  assert.equal(shellLogic, moduleLogic)
  assert.equal((shell.match(/inspectElasticsearchCapacity\(search.client\)/g) || []).length, 1)
})

test('existing sample estimates retain clipping and never return sampled text', () => {
  const title = 'synthetic title only '.repeat(3)
  const report = summarizeSample([{ title, body: 'synthetic body only '.repeat(5), original_length: 90000 }], 1000, 768)
  assert.equal(report.sampledRecords, 1)
  assert.equal(report.eligibleInSample, 1)
  assert.equal(report.clippedRecords, 1)
  assert.ok(report.estimatedChunks >= 1000)
  assert.ok(report.vectorBytesOnly.postgresFloat32 >= 1000 * 768 * 4)
  assert.doesNotMatch(JSON.stringify(report), /synthetic title|synthetic body/)
})
