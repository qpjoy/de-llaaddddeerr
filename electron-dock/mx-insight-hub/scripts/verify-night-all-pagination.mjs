// Offline cross-repository contract check. No service boot, config, DB or network.
// node scripts/verify-night-all-pagination.mjs /path/to/Night-All
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createNightAllCompatibilityCursorCodec } from '../server/external-platforms/cursor.mjs'
import { capNightAllCompatibilityTraversal, prepareNightAllCompatibilityTraversal } from '../server/data/night-all-pagination.mjs'

if (!process.argv[2]) throw new Error('Pass the Night-All source root; this check is offline')
const requireNightAll = createRequire(pathToFileURL(resolve(process.argv[2], 'package.json')))
const { createTikHubEndpointOrchestrator } = requireNightAll('./lib/domains/search/tikhub-endpoint-orchestrator')
const { createTikHubParamMapper } = requireNightAll('./lib/domains/search/tikhub-param-mapper')
const { createTikHubRawSearchService } = requireNightAll('./lib/domains/search/tikhub-raw-search-service')
const { createTikHubExecutionService } = requireNightAll('./lib/domains/search/tikhub-execution-service')
const { createSearchServiceUtils } = requireNightAll('./lib/domains/search/search-service-utils')
const { paginationContract } = requireNightAll('./lib/domains/search/payload-utils')
const catalog = requireNightAll('./lib/integrations/social-providers/tikhub/curated-search-endpoints')
const orchestrator = createTikHubEndpointOrchestrator()
const { pageOptions } = createSearchServiceUtils({ defaultPageSize: 20, defaultMaxPageSize: 100 })
const mapper = createTikHubParamMapper({ ...orchestrator, pageOptions })
const report = { paidCalls: 0, networkCalls: 0, cases: [] }

for (const endpointId of ['douyin_search_fetch_video_search_v1', 'douyin_search_fetch_general_search_v2']) {
  const endpoint = catalog.find(entry => entry.endpoint_id === endpointId)
  assert.ok(endpoint, `missing endpoint ${endpointId}`)
  const codec = createNightAllCompatibilityCursorCodec('synthetic-cross-source-secret', 'synthetic-consumer')
  const options = { operation: 'raw', platform: 'douyin', codec }
  const request = { platform: 'douyin', query: '受害企业 赔偿回收率', count: 20 }
  const filters = { sort_type: '2', publish_time: '7' }
  let traversal = prepareNightAllCompatibilityTraversal({ ...options, upstreamBody: { ...request, params: filters } })
  const firstScope = traversal.scope
  let fixture = null
  let capturedParams = null
  const execution = createTikHubExecutionService({
    ...orchestrator, ...mapper, pageOptions,
    configService: { readRawConfig: () => ({}) },
    tikHubCandidates: async () => [endpoint],
    createTikHubClient: () => ({ callEndpoint: async (_endpoint, input) => {
      capturedParams = structuredClone(input.body)
      return { response: fixture, statusCode: 200, durationMs: 1 }
    } }),
    normalizeTikHubResponse: () => [{ id: 'synthetic-content' }],
    tikhubRepository: {
      createCall: async () => ({ id: 'synthetic-call' }),
      insertItems: async () => ({ contents: [{}], observations: [{}] }),
      finishCall: async () => {}, markEndpointSuccess: async () => {},
    },
  })
  const service = createTikHubRawSearchService({ ...orchestrator, ...mapper, ...execution,
    normalizeTikHubItem: item => item })
  for (let page = 1; page <= 3; page += 1) {
    // Video V1's live response uses log_pb.impr_id, not a search_id key.
    // Other endpoints keep their explicitly supplied search_id contract.
    const sessionField = endpointId === 'douyin_search_fetch_video_search_v1' ? 'impr_id' : 'search_id'
    fixture = { code: 200, params: { search_id: `previous-search-${page - 1}` },
      data: { cursor: page * 8, has_more: page < 3 ? 1 : 0,
        log_pb: { [sessionField]: `synthetic-search-${page}` }, backtrace: `synthetic-backtrace-${page}` } }
    const upstream = traversal.upstreamBody
    const result = await service.searchTikHub({ ...upstream,
      keyword: upstream.query, pageSize: 20, limit: 20 })
    assert.equal(capturedParams.keyword, request.query)
    assert.equal(capturedParams.sort_type, filters.sort_type)
    assert.equal(capturedParams.publish_time, filters.publish_time)
    if (page > 1) {
      assert.equal(capturedParams.cursor, String((page - 1) * 8))
      assert.equal(capturedParams.search_id, `synthetic-search-${page - 1}`)
      assert.equal(capturedParams.backtrace, `synthetic-backtrace-${page - 1}`)
    }
    const response = capNightAllCompatibilityTraversal({ data: {
      page: paginationContract(result.page, { returnedCount: 1 }),
      raw_data: '[{"synthetic":true}]',
    } }, { ...options, page: traversal.page, scope: traversal.scope, upstreamBody: upstream })
    assert.equal(response.data.raw_data, '[{"synthetic":true}]')
    if (page === 3) {
      assert.equal(response.data.page.nextCursor, null)
      assert.equal(response.data.page.hasMore, false)
    } else {
      assert.ok(response.data.page.nextCursor.startsWith('mxnc1.'))
      assert.equal(response.data.page.nextParams, null)
      traversal = prepareNightAllCompatibilityTraversal({ ...options,
        upstreamBody: { ...request, cursor: response.data.page.nextCursor } })
    }
  }
  // Old single-value tokens are valid but cannot grow missing search context.
  const oldCursor = codec.encode({
    contract: 'mx-insight-hub.night-all-compatibility-cursor.v1',
    operation: 'raw', platform: 'douyin', scope: firstScope, page: 2,
    continuation: { type: 'cursor', value: '8' },
  })
  const old = prepareNightAllCompatibilityTraversal({ ...options,
    upstreamBody: { ...request, cursor: oldCursor } })
  assert.equal(old.upstreamBody.cursor, '8')
  assert.equal(old.upstreamBody.params?.search_id, undefined)
  report.cases.push({ endpointId, pagesChecked: 3, fullContextPreserved: true,
    oldTokenCannotRecoverContext: true, syntheticOldTokenLength: oldCursor.length })
}
console.log(JSON.stringify(report, null, 2))
