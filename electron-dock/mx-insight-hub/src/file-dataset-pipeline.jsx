// File-dataset cleaning tasks ("Twitter 用户清洗计划", "邮箱库清洗计划", ...):
// card and task control on the 清洗任务计划 page, one per dataset.
// PostgreSQL only; the dedicated dictionary worker does the work.
import { useCallback, useEffect, useState } from 'react'
import { ArrowClockwise, ArrowCounterClockwise, Database, Pause, Play, Trash, UploadSimple, Warning } from '@phosphor-icons/react'
import { adminApi } from './api.js'
import { ErrorState, Field, Modal, StatusBadge, formatDate, formatNumber, useRemoteData } from './components.jsx'
import { fileDataset } from '../shared/file-datasets.mjs'
import './file-datasets.css'

const STAGES = [
  ['verifying', '校验文件'], ['importing', '导入'], ['building', '去重与建索引'],
  ['validating', '核对计数'], ['ready', '待发布'], ['published', '已发布'],
]

export function formatBytes(value) {
  if (value === null || value === undefined) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let size = Number(value)
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1 }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 90) return `${Math.round(seconds)} 秒`
  if (seconds < 5400) return `${Math.round(seconds / 60)} 分钟`
  return `${(seconds / 3600).toFixed(1)} 小时`
}

export function pipelineStatus(pipeline) {
  const open = pipeline?.open
  if (open) {
    if (open.desiredState === 'discard') return { status: 'warning', label: '正在放弃' }
    if (open.runState === 'failed') return { status: 'down', label: '任务需恢复' }
    if (open.stage === 'ready') return { status: 'warning', label: '待发布' }
    if (open.desiredState === 'paused') return { status: 'disabled', label: open.runState === 'paused' ? '已暂停' : '正在暂停' }
    if (open.runState === 'waiting') return { status: 'warning', label: '等待 worker' }
    if (open.error) return { status: 'warning', label: '自动重试中' }
    return { status: 'warning', label: `正在${open.stageLabel}` }
  }
  if (pipeline?.active) return { status: 'active', label: `已发布 v${pipeline.active.id}` }
  return { status: 'disabled', label: pipeline?.dataset?.source ? '未开始' : '待配置' }
}

// What the operator does before pressing 继续; the worker already retried
// the transient ones on its own.
const FAILURE_HINTS = {
  server_file_unreadable: '确认 dictionary worker 的 Pod 有宿主机 group 10，且文件对该组可读（chmod 644）。',
  database_disk_full: 'mx-common PostgreSQL 所在的根盘已满：先腾出空间再点继续。',
  database_shared_memory_full: '自动重试已用完：PostgreSQL 的 /dev/shm 长时间被占满，等 Hub 高峰过去后点继续。',
  database_out_of_memory: '自动重试已用完：PostgreSQL 内存不足，等负载下降后点继续。',
  database_busy: '自动重试已用完：PostgreSQL 连接数已满，等负载下降后点继续。',
}

const sourceLabel = source => source ? `${source.rootId}:${source.relativePath}${source.entry ? ` › ${source.entry}` : ''}` : '尚未指定'
const isZip = path => /\.zip$/i.test(String(path || '').trim())
// Exact counts in the task control; the card uses compact numbers.
const exact = value => new Intl.NumberFormat('zh-CN').format(Number(value || 0))
const shortSha = sha => sha ? `${sha.slice(0, 8)}…${sha.slice(-5)}` : '不校验'

export function FileDatasetPipelineCard({ datasetKey, token, onUnauthorized, notify }) {
  const product = fileDataset(datasetKey)
  const load = useCallback(() => adminApi.fileDatasetPipeline(token, datasetKey), [token, datasetKey])
  const state = useRemoteData(load, onUnauthorized)
  const [open, setOpen] = useState(false)
  const pipeline = state.data
  const status = pipelineStatus(pipeline)
  const version = pipeline?.open || pipeline?.active
  const titleId = `${datasetKey}-pipeline-title`
  return (
    <section className="qp-panel mih-telegram-card" aria-labelledby={titleId}>
      <div className="mih-telegram-card__identity">
        <span className="mih-telegram-card__icon"><Database size={22} weight="duotone" aria-hidden="true" /></span>
        <div>
          <p className="qp-kicker">FILE DATASET / {datasetKey.toUpperCase().replaceAll('-', ' ')}</p>
          <h2 id={titleId}>{product.pipelineLabel}</h2>
          <p>{product.pipelineSummary}</p>
        </div>
      </div>
      {state.error && !pipeline ? (
        <div className="mih-telegram-card__error"><ErrorState error={state.error} onRetry={state.refresh} /></div>
      ) : (
        <>
          <dl className="mih-telegram-card__facts">
            <div><dt>运行状态</dt><dd><StatusBadge status={status.status} label={status.label} /></dd></div>
            <div><dt>源文件</dt><dd><code>{sourceLabel(pipeline?.open?.source || pipeline?.dataset?.source)}</code></dd></div>
            <div><dt>文件指纹</dt><dd><code>{shortSha(pipeline?.open?.source?.expectedSha256 ?? pipeline?.dataset?.expectedSha256)}</code></dd></div>
            <div><dt>写入目标</dt><dd><code>PostgreSQL · account_dictionary</code></dd></div>
            <div><dt>已清洗</dt><dd>{version ? `${formatNumber(version.pairsRead || 0)} ${product.recordUnit}` : '—'}{pipeline?.open?.progress ? ` · ${Math.floor(pipeline.open.progress.percent * 100)}%` : ''}</dd></div>
            <div><dt>入库 / 隔离</dt><dd>{version ? `${formatNumber(version.pairsLoaded || 0)} / ${formatNumber(version.pairsQuarantined || 0)}` : '—'}</dd></div>
            <div><dt>当前发布</dt><dd>{pipeline?.active ? `v${pipeline.active.id} · ${product.uniqueLabel} ${formatNumber(pipeline.active.uniqueMappings || 0)}` : '尚未发布'}</dd></div>
            <div><dt>最近更新</dt><dd>{version?.updatedAt ? formatDate(version.updatedAt) : '尚未运行'}</dd></div>
          </dl>
          <div className="mih-telegram-card__actions">
            <span className="mih-source-label">只进 PostgreSQL · 不进 ES、HanLP 或向量化；暂停后从断点继续</span>
            <button className="qp-button qp-button--ghost" type="button" disabled={state.loading && !pipeline} onClick={() => setOpen(true)}>
              {state.loading && !pipeline ? '正在加载…' : '打开任务控制'}
            </button>
          </div>
        </>
      )}
      {open && pipeline ? (
        <FileDatasetPipelineModal datasetKey={datasetKey} token={token} pipeline={pipeline} onUnauthorized={onUnauthorized} notify={notify}
          onRefresh={state.refresh} onClose={() => { setOpen(false); state.refresh() }} />
      ) : null}
    </section>
  )
}

function Stages({ stage }) {
  const index = STAGES.findIndex(([key]) => key === stage)
  return <ol className="mih-tue-stages" aria-label="清洗阶段">
    {STAGES.map(([key, label], position) => (
      <li key={key} className={position < index ? 'is-done' : position === index ? 'is-current' : ''}>{label}</li>
    ))}
  </ol>
}

function OpenVersionProgress({ version, reasonLabels, product }) {
  const progress = version.progress || {}
  const reasons = Object.entries(version.quarantineReasons || {}).sort((a, b) => b[1] - a[1])
  return <div className="mih-tue">
    <Stages stage={version.stage === 'pending' ? 'verifying' : version.stage} />
    <div className="mih-tue-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress.percent || 0) * 100)}
      aria-label={`${version.stageLabel}进度`}><span style={{ width: `${(progress.percent || 0) * 100}%` }} /></div>
    <p className="mih-tue-muted">
      版本 v{version.id} · {version.stageLabel} {Math.floor((progress.percent || 0) * 1000) / 10}%
      {version.stage === 'verifying' ? ` · 已校验 ${formatBytes(version.source.shaBytes)} / ${formatBytes(version.source.bytes)}` : ''}
      {version.stage === 'importing' ? ` · 已读取 ${formatBytes(version.byteOffset)} / ${formatBytes(version.source.entryBytes || version.source.bytes)}${version.source.entry ? `（从压缩包流式解压 ${version.source.entry}）` : ''}` : ''}
      {version.stage === 'building' ? ` · 已完成 ${progress.partitionsDone || 0}/${version.partitionCount} 个分区` : ''}
      {version.heartbeatAt ? ` · 心跳 ${formatDate(version.heartbeatAt)}` : ''}
    </p>
    {progress.workerStale ? <p className="mih-tue-notice mih-tue-warning"><Warning size={16} aria-hidden="true" />超过 2 分钟没有心跳。若正在建索引属正常现象；否则检查 mx-insight-hub-dictionary 是否在运行。</p> : null}
    {version.runState === 'failed' && version.error ? (
      <p className="mih-tue-notice mih-tue-danger"><Warning size={16} aria-hidden="true" /><span><strong>{version.error.code}</strong> · {version.error.message}{FAILURE_HINTS[version.error.code] ? <><br />{FAILURE_HINTS[version.error.code]}</> : null}</span></p>
    ) : null}
    {version.runState !== 'failed' && version.error ? (
      <p className="mih-tue-notice mih-tue-warning"><Warning size={16} aria-hidden="true" /><span>数据库资源暂时不足，worker 会自动重试，无需操作。<br /><strong>{version.error.code}</strong> · {version.error.message}</span></p>
    ) : null}
    <dl className="mih-tue-metrics">
      <div><dt>已读取</dt><dd>{exact(version.pairsRead || 0)}<small>{progress.estimatedTotalPairs ? ` / 约 ${exact(progress.estimatedTotalPairs)}` : ''} {product.recordUnit}</small></dd></div>
      <div><dt>已入库</dt><dd>{exact(version.pairsLoaded || 0)}</dd></div>
      <div><dt>已隔离</dt><dd>{exact(version.pairsQuarantined || 0)}</dd></div>
      <div><dt>速度</dt><dd>{version.stage === 'importing' && version.rowsPerSecond ? exact(Math.round(version.rowsPerSecond)) : '—'}<small> {product.recordUnit}/秒</small></dd></div>
      <div><dt>预计剩余</dt><dd>{version.stage === 'importing' ? formatDuration(progress.etaSeconds) : '—'}</dd></div>
      {version.uniqueMappings !== null ? <div><dt>{product.uniqueLabel}</dt><dd>{exact(version.uniqueMappings)}<small> · 重复 {exact(version.duplicatePairs || 0)}</small></dd></div> : null}
    </dl>
    {version.partitions?.length ? <div>
      <p className="mih-tue-muted">分区（浅：已去重 · 中：已建索引 · 深：已挂接）</p>
      <div className="mih-tue-partitions" style={{ gridTemplateColumns: `repeat(${Math.min(16, version.partitions.length)}, minmax(0, 1fr))` }}>{version.partitions.map(partition => (
        <span key={partition.no} data-step={partition.step} title={`分区 ${partition.no} · ${partition.step}${partition.uniqueRows !== null ? ` · ${exact(partition.uniqueRows)} 行` : ''}`}>{partition.no}</span>
      ))}</div>
    </div> : null}
    {reasons.length ? <div className="mih-tue-scroll"><table className="mih-tue-table"><thead><tr><th>隔离原因</th><th className="num">{product.recordUnit}数</th></tr></thead><tbody>
      {reasons.map(([reason, count]) => <tr key={reason}><td>{reasonLabels?.[reason] || reason} <code>{reason}</code></td><td className="num">{exact(count)}</td></tr>)}
    </tbody></table></div> : null}
  </div>
}

export function FileDatasetPipelineModal({ datasetKey, token, pipeline: initial, onUnauthorized, notify, onRefresh, onClose }) {
  const product = fileDataset(datasetKey)
  const [pipeline, setPipeline] = useState(initial)
  const [busy, setBusy] = useState(null)
  const [actionError, setActionError] = useState(null)
  const dataset = pipeline.dataset || {}
  const roots = pipeline.serverFiles?.roots || []
  const [form, setForm] = useState(() => ({
    serverPath: '',
    rootId: dataset.source?.rootId || roots[0]?.rootId || 'shared-dir',
    relativePath: dataset.source?.relativePath || product.defaultSource.relativePath,
    entry: dataset.source?.entry || product.defaultSource.entry || '',
    expectedSha256: dataset.expectedSha256 ?? product.defaultSource.sha256 ?? '',
    owner: dataset.owner || '', purpose: dataset.purpose || '', legalBasis: dataset.legalBasis || '',
  }))
  const [confirmDiscard, setConfirmDiscard] = useState('')
  // Files found in the .zip by the last 校验并保存 (or by its error details).
  const [archiveEntries, setArchiveEntries] = useState([])
  const zipSource = isZip(form.serverPath || form.relativePath)
  const open = pipeline.open
  const status = pipelineStatus(pipeline)
  const refresh = useCallback(async () => {
    try {
      setPipeline(await adminApi.fileDatasetPipeline(token, datasetKey))
    } catch (error) {
      if (error?.status === 401) onUnauthorized?.(error)
    }
  }, [token, datasetKey, onUnauthorized])
  const moving = open && open.stage !== 'ready' && open.runState !== 'failed' && !(open.desiredState === 'paused' && open.runState === 'paused')
  useEffect(() => {
    if (!moving) return undefined
    const timer = window.setInterval(refresh, 3_000)
    return () => window.clearInterval(timer)
  }, [moving, refresh])

  const mutate = async (name, request, message) => {
    setBusy(name)
    setActionError(null)
    try {
      await request()
      notify?.(message, 'success')
      await refresh()
      onRefresh?.()
    } catch (error) {
      if (error?.status === 401) onUnauthorized?.(error)
      setActionError(error)
      notify?.(error.message, 'error')
    } finally {
      setBusy(null)
    }
  }
  const saveSource = event => {
    event.preventDefault()
    const body = form.serverPath.trim()
      ? { serverPath: form.serverPath.trim() }
      : { rootId: form.rootId.trim(), relativePath: form.relativePath.trim() }
    mutate('save', async () => {
      try {
        const saved = await adminApi.configureFileDatasetPipeline(token, datasetKey, {
          ...body, ...(zipSource && form.entry.trim() ? { entry: form.entry.trim() } : {}),
          expectedSha256: form.expectedSha256.trim() || null,
          owner: form.owner, purpose: form.purpose, legalBasis: form.legalBasis,
        })
        const archive = saved?.archive
        setArchiveEntries(archive?.entries || [])
        if (archive?.entry) setForm(current => ({ ...current, entry: archive.entry.name }))
      } catch (error) {
        if (error?.details?.entries) setArchiveEntries(error.details.entries)
        throw error
      }
    }, zipSource ? '压缩包已校验并保存；worker 会先核对整个压缩包的 SHA-256，再流式解压读取所选文件' : '源文件已校验并保存；开启后由 worker 先核对 SHA-256')
  }
  const act = (action, message) => mutate(action, () => adminApi.fileDatasetPipelineAction(token, datasetKey, action, open?.id), message)

  return (
    <Modal title={product.pipelineLabel} size="xlarge" onClose={onClose}
      description="服务器文件 → PostgreSQL 字典（account_dictionary）· 不进 ES、HanLP 或向量化 · 暂停后从已提交批次继续"
      footer={<button className="qp-button qp-button--ghost" type="button" onClick={onClose}>关闭</button>}>
      <div className="mih-tue">
        <div className="mih-telegram-toolbar">
          <div><StatusBadge status={status.status} label={status.label} /><code>{datasetKey}</code></div>
          <div className="mih-page-actions">
            {!open ? <button className="qp-button" type="button" disabled={Boolean(busy) || !dataset.source}
              title={!dataset.source ? '先指定并保存源文件' : ''} onClick={() => act('start', '已开启清洗；worker 会先校验文件指纹')}>
              <Play size={16} />{busy === 'start' ? '正在开启…' : '开启'}</button> : null}
            {open && open.stage !== 'ready' && open.desiredState === 'running' && open.runState !== 'failed' ? (
              <button className="qp-button qp-button--ghost" type="button" disabled={Boolean(busy)} onClick={() => act('pause', '已请求暂停；当前批次提交后停止')}>
                <Pause size={16} />{busy === 'pause' ? '正在暂停…' : '暂停'}</button>) : null}
            {open && open.stage !== 'ready' && open.desiredState !== 'discard' && (open.desiredState === 'paused' || open.runState === 'failed') ? (
              <button className="qp-button" type="button" disabled={Boolean(busy)} onClick={() => act('resume', '已继续；从上次提交的断点开始')}>
                <Play size={16} />{busy === 'resume' ? '正在继续…' : '继续'}</button>) : null}
            {open?.stage === 'ready' ? (
              <button className="qp-button" type="button" disabled={Boolean(busy)}
                onClick={() => mutate('publish', () => adminApi.publishFileDataset(token, datasetKey, open.id), `v${open.id} 已发布；数据产品立即使用新版本`)}>
                <UploadSimple size={16} />{busy === 'publish' ? '正在发布…' : `发布 v${open.id}`}</button>) : null}
            {pipeline.previous && !pipeline.previous.dataDroppedAt ? (
              <button className="qp-button qp-button--ghost" type="button" disabled={Boolean(busy)}
                onClick={() => mutate('rollback', () => adminApi.rollbackFileDataset(token, datasetKey), `已切回 v${pipeline.previous.id}`)}>
                <ArrowCounterClockwise size={16} />{busy === 'rollback' ? '正在回退…' : `回退到 v${pipeline.previous.id}`}</button>) : null}
            <button className="qp-button qp-button--ghost" type="button" disabled={Boolean(busy)} onClick={refresh}><ArrowClockwise size={16} />刷新</button>
          </div>
        </div>
        {actionError ? <ErrorState error={actionError} /> : null}

        <section className="qp-panel">
          <h3>进度</h3>
          {open ? <OpenVersionProgress version={open} reasonLabels={pipeline.quarantineReasonLabels} product={product} /> : (
            <p className="mih-tue-muted">{pipeline.active ? `当前发布 v${pipeline.active.id}（${product.uniqueLabel} ${exact(pipeline.active.uniqueMappings || 0)}，${formatDate(pipeline.active.publishedAt)}）。` : '还没有发布过数据版本。'}指定源文件后点击“开启”，会新建一个未发布版本；完成核对后需要手动发布。</p>
          )}
        </section>

        <section className="qp-panel">
          <h3>源文件</h3>
          <p className="mih-tue-muted">格式：{product.sourceFormat}（{product.sourceExtensions.join(' / ')}）。可以直接填写服务器上的 .zip 路径：worker 不落地解压，边解压边读取所选文件，断点按解压后的字节记录，继续时重新解压并跳到断点（约每 GB 数秒）；.rar 等其他压缩格式需先在服务器解压。文件需放在服务器受控目录 {roots.length ? roots.map(root => <code key={root.rootId}>{root.rootId}</code>) : <code>未配置</code>} 下（Internal 默认 <code>/shared_dir</code>）。可直接粘贴服务器绝对路径；期望 SHA-256 不一致时 worker 会拒绝导入。正在进行的版本始终使用它开启时的文件。</p>
          <form className="mih-form mih-form--grid" onSubmit={saveSource}>
            <Field label="服务器路径（可选）" hint={`例如 /shared_dir/${product.defaultSource.relativePath}；填写后忽略下面两项`}>
              <input className="qp-input" value={form.serverPath} placeholder={`/shared_dir/${product.defaultSource.relativePath}`} onChange={event => setForm({ ...form, serverPath: event.target.value })} />
            </Field>
            <Field label="根目录 ID"><input className="qp-input" value={form.rootId} onChange={event => setForm({ ...form, rootId: event.target.value })} /></Field>
            <Field label="相对路径"><input className="qp-input" value={form.relativePath} onChange={event => setForm({ ...form, relativePath: event.target.value })} /></Field>
            {zipSource ? <Field label="压缩包内文件" hint={archiveEntries.length ? `可选：${archiveEntries.filter(row => row.supported).map(row => row.name).join('、')}` : '留空时自动选择；校验后列出包内可用文件'}>
              <input className="qp-input" value={form.entry} list={`${datasetKey}-archive-entries`} spellCheck={false}
                placeholder={product.defaultSource.entry || ''} onChange={event => setForm({ ...form, entry: event.target.value })} />
              <datalist id={`${datasetKey}-archive-entries`}>{archiveEntries.map(row => <option key={row.name} value={row.name}>{`${formatBytes(row.size)} · ${row.method}${row.supported ? '' : ' · 不支持'}`}</option>)}</datalist>
            </Field> : null}
            <Field label="期望 SHA-256" hint={zipSource ? '整个压缩包的指纹（服务器上 sha256sum 压缩包）；留空则不校验' : product.defaultSource.sha256 ? '预填的是已知来源文件的指纹；留空则不校验' : '留空则不校验'}>
              <input className="qp-input" value={form.expectedSha256} spellCheck={false} onChange={event => setForm({ ...form, expectedSha256: event.target.value })} />
            </Field>
            <Field label="数据负责人"><input className="qp-input" value={form.owner} onChange={event => setForm({ ...form, owner: event.target.value })} /></Field>
            <Field label="允许用途"><input className="qp-input" value={form.purpose} onChange={event => setForm({ ...form, purpose: event.target.value })} /></Field>
            <Field label="来源依据"><input className="qp-input" value={form.legalBasis} onChange={event => setForm({ ...form, legalBasis: event.target.value })} /></Field>
            <div className="mih-page-actions mih-form__wide">
              <button className="qp-button qp-button--ghost" type="submit" disabled={Boolean(busy)}>{busy === 'save' ? '正在校验…' : '校验并保存'}</button>
              {dataset.source ? <span className="mih-tue-muted">已保存：<code>{sourceLabel(dataset.source)}</code></span> : null}
            </div>
          </form>
        </section>

        <section className="qp-panel">
          <h3>版本</h3>
          <div className="mih-tue-scroll"><table className="mih-tue-table"><thead><tr>
            <th>版本</th><th>状态</th><th className="num">{product.uniqueLabel}</th><th className="num">隔离</th><th className="num">表 / 索引</th><th>开启</th><th>发布</th>
          </tr></thead><tbody>
            {(pipeline.recent || []).map(row => <tr key={row.id}>
              <td>v{row.id}{row.id === pipeline.dataset?.activeVersionId ? ' · 当前' : row.id === pipeline.dataset?.previousVersionId ? ' · 可回退' : ''}</td>
              <td>{row.stage}{row.dataDroppedAt ? '（数据已清理）' : ''}</td>
              <td className="num">{row.uniqueMappings === null ? '—' : exact(row.uniqueMappings)}</td>
              <td className="num">{exact(row.pairsQuarantined || 0)}</td>
              <td className="num">{row.tableBytes === null ? '—' : `${formatBytes(row.tableBytes)} / ${formatBytes(row.indexBytes)}`}</td>
              <td>{formatDate(row.createdAt)}</td><td>{row.publishedAt ? formatDate(row.publishedAt) : '—'}</td>
            </tr>)}
            {!pipeline.recent?.length ? <tr><td colSpan={7} className="mih-tue-muted">还没有版本</td></tr> : null}
          </tbody></table></div>
        </section>

        {open ? <section className="qp-panel">
          <h3>放弃这个未发布版本</h3>
          <p className="mih-tue-muted">删除 v{open.id} 已导入的数据和隔离记录，已发布的版本不受影响。输入 <code>discard</code> 确认。</p>
          <div className="mih-tue-row">
            <input className="qp-input" value={confirmDiscard} aria-label="输入 discard 确认" onChange={event => setConfirmDiscard(event.target.value)} />
            <button className="qp-button qp-button--ghost" type="button" disabled={Boolean(busy) || confirmDiscard !== 'discard'}
              onClick={() => { setConfirmDiscard(''); act('discard', `v${open.id} 已放弃`) }}><Trash size={16} />放弃 v{open.id}</button>
          </div>
        </section> : null}
      </div>
    </Modal>
  )
}
