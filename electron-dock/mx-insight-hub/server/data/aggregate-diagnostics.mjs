import { AppError } from '../core/errors.mjs'
import { implementedRoutes } from './source-connections.mjs'

// Internal Admin-token endpoint only. Actual provider/cost evidence is read
// from immutable call records; the catalogue describes mapping, never dispatch.
export async function aggregateDiagnostics(store, history, requestId) {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new AppError(400, 'invalid_request_id', 'Invalid request ID')
  const header = await store.getRequest(requestId)
  const request = header && await store.getUsageRequestForRetry(requestId, header.consumerId)
  const data = request?.responseBody?.data
  if (!data?.sources || !Array.isArray(data.sources) || !['refresh', 'stored'].includes(data.mode)) {
    throw new AppError(404, 'aggregate_result_unavailable', '尚无已提交的聚合响应；请保留请求 ID 核对状态')
  }
  const [entries, inputs] = await Promise.all([store.listSourceCatalogEntries({ includeArchived: true }), store.listExternalSources()])
  const inventory = implementedRoutes(inputs)
  let parent = null
  if (history?.getAdminDiagnostics) {
    try { parent = (await history.getAdminDiagnostics(requestId)).runs.find(run => run.requestId === requestId) || null }
    catch { /* Search delivery remains independent of diagnostics availability. */ }
  }
  const rows = new Array(data.sources.length)
  let index = 0
  await Promise.all(Array.from({ length: Math.min(3, rows.length) }, async () => {
    while (index < rows.length) {
      const slot = index++, source = data.sources[slot]
      const routes = inventory.filter(route => route.platform === source.platform && route.keywordSearch)
      const keys = new Set(routes.flatMap(route => route.catalogKeys))
      let evidence = null, evidenceStatus = source.requestId ? 'not_available' : 'no_child_request'
      if (history?.getAdminDiagnostics && source.requestId) {
        try {
          const child = await store.getRequest(source.requestId, request.consumerId)
          if (child?.apiKeyId === request.apiKeyId) {
            const result = await history.getAdminDiagnostics(source.requestId)
            evidence = result.runs.find(run => run.requestId === source.requestId) || null
            evidenceStatus = evidence ? 'recorded' : 'not_recorded'
          }
        } catch { evidenceStatus = 'temporarily_unavailable' }
      }
      rows[slot] = { ...source, catalogEntries: entries.filter(entry => keys.has(entry.sourceKey)).map(entry => ({
        id: entry.id, sourceKey: entry.sourceKey, name: entry.canonicalName, archived: Boolean(entry.archivedAt) })),
        mappingStatus: keys.size ? 'implementation_inventory' : 'unmapped',
        evidenceStatus, providerCalls: evidence?.providerCalls || [], connectorCalls: evidence?.connectorCalls || [],
        customerCharge: evidence?.customerCharge || null, callsTruncated: evidence?.callsTruncated || false }
    }
  }))
  return { requestId, checkedAt: new Date().toISOString(), mode: data.mode, sources: rows,
    parent: { customerCharge: parent?.customerCharge || null, evidenceStatus: parent ? 'recorded' : 'not_available',
      billing: data.mode === 'refresh' ? 'non_billable_aggregate_parent' : 'canonical_search' },
    note: '目录映射来自当前实现清单；实际供应商与采购金额只来自已记录的调用证据。缺失金额未知，币种不换算；历史转发不能证明其内部供应商成本。' }
}
