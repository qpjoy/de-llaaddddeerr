import './indexing-observation.css'

const stages = { postgres: 'PostgreSQL 读写 / 锁等待', embedding: 'Embedding 模型', hanlp: 'HanLP 分词', elasticsearch: 'Elasticsearch 写入 / 管理' }
const reasons = {
  warming: '采样中，通常需要 30–60 秒的连续进度', preflight: '前置检查 / 统计范围中',
  finishing: '当前范围已处理，等待收尾', completed: '已完成', failed: '任务已停止，请查看错误信息',
  unknown_total: '增量追平 / 校验阶段，剩余总量未知', stalled: '近期没有完成进度，请检查依赖和重试',
  stale: '等待新的运行指标；暂不估算', paused: '已暂停，恢复后重新采样', disabled: '后台向量化未启用',
  unready: 'Embedding 或向量索引尚未就绪', no_workers: '没有在线 Worker',
  initialization_budget: '本次初始化额度不足，调整额度后继续',
  daily_budget: '每日预算已用完，次日 UTC 00:00（北京时间 08:00）恢复',
  legacy: '旧任务未锁定范围，无法估算初始化剩余时间',
}
const advice = {
  postgres: '检查 PG 连接池、慢查询、锁等待和磁盘 I/O；增加 Worker 前先确认数据库余量。',
  embedding: '检查 Embedding 服务的 TPM / RPM、响应时间与限流；并发增大仍受模型配额限制。',
  hanlp: '检查 HanLP 推理并发、批量大小、排队与 CPU；保留严格 HanLP 分词，不切换降级后端。',
  elasticsearch: '检查 ES bulk 延迟、429、磁盘水位和 merge 压力；扩并发前确认写入余量。',
}
export function duration(seconds) {
  if (!Number.isFinite(seconds)) return '—'
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`
  const roundedMinutes = Math.ceil(seconds / 60)
  const hours = Math.floor(roundedMinutes / 60), minutes = roundedMinutes % 60
  return `${hours >= 24 ? `${Math.floor(hours / 24)} 天 ` : ''}${hours % 24} 小时${minutes ? ` ${minutes} 分钟` : ''}`
}
const number = (n) => Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 1 })
const latency = (ms) => ms < 1000 ? `${number(ms)} ms` : `${number(ms / 1000)} s`

export function IndexingObservation({ data, kind }) {
  const eta = data?.eta, phase = data?.projection === 'chunks' ? '已有向量投影' : '全文投影'
  const scope = kind === 'search' ? `${phase} · ${data?.pass === 'build' ? '首轮构建' : data?.pass ? '增量追平 / 校验' : '准备中'}`
    : data?.scope === 'initialization' ? '本次锁定的初始化范围' : '当前增量队列（会随入库变化）'
  const entries = Object.entries(data?.stages || {}).filter(([key]) => stages[key])
  const slowest = entries.filter(([, row]) => row.calls > 0).sort((a, b) => b[1].ms - a[1].ms)[0]?.[0]
  const active = Object.entries(stages).map(([key, label]) => {
    const calls = (data?.active || []).filter((call) => call.stage === key)
    return calls.length ? `${label}：${calls.length} 个调用，最长已等待 ${duration(Math.max(0, (data.sampledAt - Math.min(...calls.map((call) => call.since))) / 1000))}` : null
  }).filter(Boolean)
  return <section className="mih-index-observation" aria-label={kind === 'search' ? '搜索重建进度诊断' : '向量化进度诊断'}>
    <div className="mih-index-observation__heading"><strong>进度与瓶颈观察</strong><small>{data?.sampledAt ? `采样于 ${new Date(data.sampledAt).toLocaleTimeString('zh-CN')}` : '启动后自动采样'}</small></div>
    <div className="mih-index-observation__metrics">
      <div><small>{kind === 'search' ? '当前阶段预计剩余' : '预计剩余'}</small><strong>{eta?.reason === 'estimated' ? `约 ${duration(eta.seconds)}` : '—'}</strong><span>{scope}</span></div>
      <div><small>实际处理速度</small><strong>{eta?.rate > 0 ? `${eta.rate.toLocaleString('zh-CN', { maximumSignificantDigits: 3 })} 条 / 秒` : '—'}</strong><span>{data?.scope === 'initialization' ? '已处理 + 版本变化转增量' : '已确认的处理进度'}</span></div>
      <div><small>{kind === 'search' ? '分词记录并发' : '可承接任务并发上限'}</small><strong>{kind === 'search' ? data?.concurrency ?? '—' : data?.effectiveConcurrency ?? '—'}</strong><span>{kind === 'search' ? '同批记录的配置并发' : `配置上限 ${data?.concurrencyLimit ?? '—'} · ${data?.reportingWorkers ?? 0} 个 Worker 上报指标`}</span></div>
    </div>
    <p className="mih-index-observation__note">{!data ? '尚无运行样本；不会为估算而启动任务。' : eta?.reason === 'estimated'
      ? `按最近 ${number(eta.windowSeconds)} 秒的实际速度估算，随吞吐变化更新。${kind === 'search' ? '仅含当前阶段，不含后续追平、校验和其他投影。' : '新数据优先、重试和限流可能延长完成时间。'}`
      : reasons[eta?.reason] || '等待进度样本'}</p>
    {kind !== 'search' && data ? <p className="mih-index-observation__note">等待预算 {number(data.budgetWaiting)} · 延后调度 {number(data.deferred)} · 待重试 {number(data.retrying)} · 失败待处理 {number(data.dead)}（分类可能重叠）</p> : null}
    {data?.lastError ? <p className="mih-index-observation__advice">最近失败环节：{stages[data.lastError.stage] || data.lastError.stage} · {data.lastError.kind === 'rate_limit' ? '检测到 HTTP 429 限流' : data.lastError.kind === 'unavailable' ? '服务暂不可用' : '调用失败，请结合任务日志排查'}</p> : null}
    {active.length ? <p className="mih-index-observation__note">正在等待：{active.join('；')}</p> : null}
    {entries.length ? <>
      <div className="mih-index-observation__table"><table><thead><tr><th>环节</th><th>调用数</th><th>平均等待</th><th>最长等待</th><th>累计等待</th><th>失败调用</th></tr></thead><tbody>
        {entries.map(([key, row]) => <tr key={key}><td>{stages[key]}{key === slowest ? <small> · 累计耗时最多</small> : null}</td><td>{number(row.calls)}</td><td>{latency(row.ms / Math.max(1, row.calls))}</td><td>{latency(row.maxMs)}</td><td>{duration(row.ms / 1000)}</td><td>{number(row.failed)}</td></tr>)}
      </tbody></table></div>
      {slowest ? <p className="mih-index-observation__advice">排查建议：{advice[slowest]}</p> : null}
      <p className="mih-index-observation__note">最近约 5 分钟的调用等待，包含网络与内部重试；并发调用可重叠，不等同于 CPU 占用或各环节耗时占比。模型 / ES 返回的业务错误仍以任务错误记录为准。</p>
    </> : null}
  </section>
}
