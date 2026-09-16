// Admin catalog metadata, not authorization, a runtime loader or a billing policy.
export const SLOT_CONTRACT_VERSION = 'mx-hub.integration-slot.v1'
export const SLOT_MODES = { sync_api: '同步 API', async_job: '异步采集', database_pull: '数据库增量', file_import: '文件导入', event_push: '事件接入', process_job: '独立进程' }
export const PLATFORM_SLOTS = {
  qixin: { ownership: '外部服务', modes: ['sync_api'], delivery: '完整响应 → Hub 快照 → Canonical 观察', control: '双密钥配置、逐接口运行与采购价', mapping: '企业查询响应合同；不推断企业实体', evidence: '调用记录、精确响应、交付与入库证据' },
  ipsearch: { ownership: '外部服务', modes: ['sync_api'], delivery: '请求结果与历史快照', control: 'IP 单条 / 批量查询', mapping: 'IP 风险画像合同', evidence: '调用记录、计费与结果快照' },
  justone: { ownership: '外部服务', modes: ['sync_api'], delivery: '完整上游归档 → Canonical → 检索', control: '商品搜索与受控刷新', mapping: '电商商品合同', evidence: '采购调用、缓存、交付与入库证据' },
  tikhub: { ownership: '外部服务', modes: ['sync_api'], delivery: '完整上游归档 → Canonical → 检索', control: '社交内容搜索、详情与用户', mapping: '社交内容合同', evidence: '采购调用、归档、分页与映射证据' },
  'night-all': { ownership: '自建服务', modes: ['sync_api'], delivery: '历史兼容结果与 Hub 快照', control: '关键词、账号内容、账号资料', mapping: '历史兼容合同', evidence: '已有连接器逻辑请求记录' },
  'night-all-a': { ownership: '自建平台', modes: ['async_job', 'database_pull'], delivery: '上游存储 → 独立 Hub 清洗计划', control: '案例采集、计划触发、运行与日志', mapping: 'saved_records Writer 与清洗映射', evidence: 'Hub 派发记录 + 上游任务、步骤、日志' },
}

export function slotProfile(key) {
  const profile = PLATFORM_SLOTS[key]
  return profile ? { contractVersion: SLOT_CONTRACT_VERSION, platformKey: key, ...profile } : null
}

const RUN_STATES = { queued: 'accepted', leasing: 'running', starting: 'running', running: 'running', retry_wait: 'running', succeeded: 'succeeded', failed: 'failed', blocked: 'blocked', cancelled: 'cancelled', orphaned: 'unknown' }
export function collectorRunView(run = {}) {
  const state = RUN_STATES[run.status] || 'unknown'
  const collection = run.metrics?.collection
  // Execution and data completeness are independent; no inferred zero counts.
  return { contractVersion: SLOT_CONTRACT_VERSION, upstreamRunId: run.id ?? null, upstreamTaskId: run.task_id ?? null,
    state, upstreamState: run.status ?? null,
    completeness: collection?.complete === true ? 'complete' : collection?.complete === false ? 'partial' : 'unknown',
    records: run.metrics?.records ?? null, traceId: run.trace_id ?? null,
    terminal: ['succeeded', 'failed', 'blocked', 'cancelled', 'orphaned'].includes(run.status),
    hubIngestion: 'unknown',
  }
}

// An adapter's outer success is not a schema/mapping/ingestion attestation.
export function processAdapterOutcome(envelope = {}) {
  const statuses = { success: 'succeeded', no_data: 'succeeded', partial: 'succeeded', unknown: 'unknown', error: 'failed', stopped: 'stopped' }
  return { state: statuses[envelope.status] || 'unknown',
    dataStatus: ['success', 'no_data', 'partial'].includes(envelope.status) ? envelope.status : 'unknown',
    hubIngestion: 'unknown' }
}
