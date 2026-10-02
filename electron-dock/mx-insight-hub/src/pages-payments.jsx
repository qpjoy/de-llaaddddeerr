import { useCallback, useRef, useState } from 'react'
import { Coins, Receipt, Scan, SlidersHorizontal } from '@phosphor-icons/react'
import { adminApi } from './api.js'
import { DropdownField, ErrorState, Field, LoadingState, Modal, PageHeading, useRemoteData } from './components.jsx'
import './payments.css'

const money = (value, currency = 'CNY') => `${currency === 'CNY' ? '¥' : `${currency} `}${(Number(value || 0) / 100).toFixed(2)}`
const stamp = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
const labels = { pending: '待付款', submitted: '待核实', paid: '已入账', cancelled: '已取消', requested: '待开票', issued: '已开票', rejected: '已退回' }
const parseAmount = value => /^\d{1,6}(\.\d{1,2})?$/u.test(value) ? Number(value.split('.')[0]) * 100 + Number((value.split('.')[1] || '').padEnd(2, '0')) : null
const button = 'qp-button qp-button--ghost'
const primary = 'qp-button qp-button--primary'
const localTime = () => { const date = new Date(); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) }
function Input({ label, ...props }) { return <Field label={label}><input className="qp-input" {...props} /></Field> }
function Badge({ status }) { return <span className={`mih-pay-badge mih-pay-badge--${status}`}>{labels[status] || status}</span> }

export function PaymentsPage({ token, session, query, setQuery, onUnauthorized, notify }) {
  const load = useCallback(() => adminApi.tenants(token), [token])
  const tenants = useRemoteData(load, onUnauthorized)
  const [mode, setMode] = useState('recharge')
  const [environment, setEnvironment] = useState('live')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [channelRevision, setChannelRevision] = useState(0)
  const allowed = (tenants.data || []).filter(tenant => session.platformAdmin || session.memberships?.some(item => item.tenantId === tenant.id && ['owner', 'admin'].includes(item.role)))
  const tenantId = allowed.some(item => item.id === query.get('tenantId')) ? query.get('tenantId') : allowed[0]?.id || ''
  return <div className="mih-pay-page">
    <PageHeading eyebrow="MX PAY" title={session.platformAdmin ? '充值与财务' : '充值与发票'} description="充值到当前租户钱包，供该租户下的服务共同使用。" onRefresh={tenants.refresh} loading={tenants.loading}>
      {session.platformAdmin ? <button className={button} onClick={() => setSettingsOpen(true)}><SlidersHorizontal size={17} />收款设置</button> : null}
    </PageHeading>
    {tenants.error ? <ErrorState error={tenants.error} onRetry={tenants.refresh} /> : null}
    <div className="mih-pay-toolbar qp-panel">
      {session.platformAdmin ? <div className="mih-pay-tabs" role="group" aria-label="支付工作区">{[['recharge', '账户充值'], ['finance', '财务工作台']].map(([value, label]) => <button key={value} className={mode === value ? primary : button} onClick={() => setMode(value)}>{label}</button>)}</div> : null}
      <DropdownField label="账务环境" value={environment} onChange={setEnvironment} options={[{ value: 'live', label: '正式收款' }, { value: 'test', label: '测试流程 · 不计入正式余额' }]} />
      {mode === 'recharge' ? <DropdownField label="充值租户" value={tenantId} onChange={value => setQuery({ tenantId: value })} options={allowed.map(tenant => ({ value: tenant.id, label: tenant.name }))} /> : null}
    </div>
    {environment === 'test' ? <p className="mih-pay-notice">测试环境：不会扣款，不增加可消费余额；开票信息也只用于流程测试。</p> : null}
    {mode === 'finance' || tenantId ? <PaymentWorkspace key={`${tenantId}:${environment}:${mode}:${channelRevision}`} {...{ token, session, tenantId, environment, mode, notify, onUnauthorized }} /> : tenants.loading ? <LoadingState /> : <p>暂无可以管理充值的租户，请联系管理员分配租户 owner/admin 角色。</p>}
    {settingsOpen ? <PaymentSettings {...{ token, onUnauthorized }} onClose={() => setSettingsOpen(false)} onSaved={() => { setSettingsOpen(false); setChannelRevision(value => value + 1); notify?.('收款配置已保存') }} /> : null}
  </div>
}

function PaymentWorkspace({ token, session, tenantId, environment, mode, onUnauthorized, notify }) {
  const [page, setPage] = useState(1), [status, setStatus] = useState(''), [invoiceStatus, setInvoiceStatus] = useState('')
  const [search, setSearch] = useState(''), [orderId, setOrderId] = useState('')
  const [amount, setAmount] = useState('100'), [busy, setBusy] = useState(false), [error, setError] = useState(null), [detail, setDetail] = useState(null)
  const intent = useRef(null), lock = useRef(false)
  const load = useCallback(async () => {
    const [orders, channels, billing] = await Promise.all([
      adminApi.paymentOrders(token, { tenantId: mode === 'finance' ? '' : tenantId, environment, page, status, invoiceStatus, orderId }),
      mode === 'recharge' ? adminApi.paymentChannels(token, tenantId) : null,
      mode === 'recharge' ? adminApi.tenantBilling(token, tenantId) : null,
    ])
    return { orders, channels, billing }
  }, [token, tenantId, environment, mode, page, status, invoiceStatus, orderId])
  const state = useRemoteData(load, onUnauthorized)
  const rows = state.data?.orders.items || [], channels = state.data?.channels
  const amountMinor = parseAmount(amount), enabled = channels?.[environment]?.enabled
  const valid = amountMinor >= 500 && amountMinor <= 10_000_000
  const refresh = () => state.refresh()
  async function create(event) {
    event.preventDefault(); if (lock.current) return
    lock.current = true; setBusy(true); setError(null)
    const body = { environment, amountMinor }, signature = JSON.stringify(body)
    if (intent.current?.signature !== signature) intent.current = { signature, key: crypto.randomUUID() }
    try { setDetail(await adminApi.createPaymentOrder(token, tenantId, body, intent.current.key)); intent.current = null; refresh() }
    catch (err) { setError(err); if (err.status === 401) onUnauthorized?.(err) }
    finally { lock.current = false; setBusy(false) }
  }
  async function open(row) {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(null)
    try { setDetail(await adminApi.paymentOrder(token, row.tenantId, row.id)) } catch (err) { setError(err) }
    finally { lock.current = false; setBusy(false) }
  }
  function exportPage() {
    const safe = value => `"${String(value ?? '').replace(/^[=+@-]/u, "'$&").replaceAll('"', '""')}"`
    const data = [['环境','订单号','租户','金额分','币种','状态','渠道流水','手续费分（空为未知）','到账时间','核实时间','核实人','账本ID','开票状态','发票号'], ...rows.map(row => [row.environment,row.id,row.tenantId,row.amountMinor,row.currency,labels[row.status],row.settlement?.tradeNo,row.settlement?.feeMinor,row.settlement?.paidAt,row.settlement?.confirmedAt,row.settlement?.confirmedBy,row.settlement?.ledgerEntryId,labels[row.invoice?.status] || '',row.invoice?.invoiceNumber])]
    const url = URL.createObjectURL(new Blob(['\uFEFF',data.map(row => row.map(safe).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = `mx-pay-${environment}-page-${page}.csv`; link.click(); URL.revokeObjectURL(url)
  }
  const paid = rows.filter(row => row.status === 'paid'), unknownFees = paid.filter(row => row.settlement.feeMinor == null).length
  return <>
    {state.error || error ? <ErrorState error={error || state.error} onRetry={refresh} /> : null}
    {channels?.storage === 'memory' ? <p className="mih-pay-notice">当前使用临时演示数据，服务重启后订单和余额会丢失。请勿真实付款；正式收款需部署 PostgreSQL。</p> : null}
    {mode === 'recharge' ? <>
      <section className="qp-panel mih-pay-balance"><Coins size={26} /><div><span>正式可用余额</span><strong>{state.data?.billing?.account ? money(state.data.billing.account.availableMinor, state.data.billing.account.currency) : '尚未开户'}</strong></div><div><span>冻结金额</span><strong>{money(state.data?.billing?.account?.heldMinor, state.data?.billing?.account?.currency)}</strong></div><a className={button} href={`#/plans?tenantId=${encodeURIComponent(tenantId)}`}>用量与账单</a></section>
      <form className="mih-pay-checkout" onSubmit={create}>
        <section className="qp-panel mih-pay-card"><h2><Scan size={22} />账户充值</h2><p>{environment === 'test' ? '模拟支付' : '支付宝扫码付款 · 人工核实到账'}</p>
          <div className="mih-pay-presets">{['50','100','500','1000'].map(value => <button key={value} type="button" className={amount === value ? primary : button} onClick={() => setAmount(value)}>{money(Number(value) * 100)}</button>)}</div>
          <Input label="自定义金额（元）" value={amount} onChange={event => setAmount(event.target.value)} inputMode="decimal" maxLength={9} required />
          <small>单笔 ¥5.00–¥100,000.00，最多两位小数。</small>
        </section>
        <aside className="qp-panel mih-pay-card"><h2>订单摘要</h2><dl className="mih-pay-facts"><div><dt>支付方式</dt><dd>{environment === 'test' ? '模拟测试' : '支付宝'}</dd></div><div><dt>收款人</dt><dd>{environment === 'test' ? '测试账户' : channels?.live.payeeName || '尚未配置'}</dd></div><div><dt>合计</dt><dd className="mih-pay-total">{money(valid ? amountMinor : 0)}</dd></div></dl>
          <p className="mih-pay-muted">{environment === 'test' ? '完整验证订单、核实和开票流程。' : '下单后扫码，按订单金额付款并提交流水号。核实到账后，余额即可使用。'}</p>
          {!enabled && !state.loading ? <p className="mih-pay-notice">收款通道尚未开通，请联系管理员。</p> : null}
          <button className={primary} disabled={busy || state.loading || !enabled || !valid}>{busy ? '正在创建…' : '创建充值订单'}</button>
        </aside>
      </form>
    </> : <section className="qp-panel mih-pay-card"><h2>人工核账与开票</h2><p>核对收款账户的真实账单、金额和流水号，再确认入账。用户提交的流水号只作为查账线索。</p><p>本页已入账 {paid.length} 笔 / {money(paid.reduce((sum, row) => sum + row.amountMinor, 0))}，已知手续费 {money(paid.reduce((sum, row) => sum + (row.settlement.feeMinor || 0), 0))}，另有 {unknownFees} 笔手续费未知。仅统计当前页。</p></section>}
    <section className="qp-panel mih-pay-card"><div className="mih-pay-record-heading"><h2><Receipt size={22} />{mode === 'finance' ? '收款与开票记录' : '充值记录'}</h2>{session.platformAdmin ? <button className={button} disabled={!rows.length || state.loading} onClick={exportPage}>导出当前页 CSV</button> : null}</div>
      <div className="mih-pay-filters"><DropdownField label="订单状态" value={status} onChange={value => { setStatus(value); setPage(1) }} options={[{ value: '', label: '全部状态' }, ...['pending','submitted','paid','cancelled'].map(value => ({ value, label: labels[value] }))]} /><DropdownField label="开票状态" value={invoiceStatus} onChange={value => { setInvoiceStatus(value); setPage(1) }} options={[{ value: '', label: '全部开票状态' }, ...['requested','issued','rejected'].map(value => ({ value, label: labels[value] }))]} />
        <form onSubmit={event => { event.preventDefault(); setOrderId(search.trim()); setPage(1) }}><Input label="按完整订单号查询" value={search} onChange={event => setSearch(event.target.value)} placeholder="粘贴订单号" /><button className={button}>查询</button></form></div>
      {state.loading ? <LoadingState /> : rows.length ? <div className="mih-pay-table"><table><thead><tr><th>时间 / 订单</th>{mode === 'finance' ? <th>租户</th> : null}<th>金额</th><th>状态</th><th>发票</th><th>操作</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td>{stamp(row.createdAt)}<small>{row.id}</small></td>{mode === 'finance' ? <td><small>{row.tenantId}</small></td> : null}<td>{money(row.amountMinor)}</td><td><Badge status={row.status} /></td><td>{row.invoice ? <Badge status={row.invoice.status} /> : '—'}</td><td><button className={button} disabled={busy} onClick={() => open(row)}>查看订单</button></td></tr>)}</tbody></table></div> : <p className="mih-pay-empty">暂无符合条件的充值记录。</p>}
      <div className="mih-pay-pagination"><button className={button} disabled={page <= 1 || state.loading} onClick={() => setPage(value => value - 1)}>上一页</button><span>第 {page} 页 · 每页 20 条</span><button className={button} disabled={!state.data?.orders.hasMore || state.loading} onClick={() => setPage(value => value + 1)}>下一页</button></div>
    </section>
    {detail ? <OrderDetail key={detail.id} order={detail} {...{ token, session, notify }} onClose={() => setDetail(null)} onChanged={refresh} /> : null}
  </>
}

function OrderDetail({ order: initial, token, session, onClose, onChanged, notify }) {
  const [order, setOrder] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState(null)
  const [payerName, setPayerName] = useState(''), [tradeNo, setTradeNo] = useState(initial.submission?.tradeNo || '')
  const [received, setReceived] = useState(''), [fee, setFee] = useState(''), [paidAt, setPaidAt] = useState(localTime), [note, setNote] = useState('')
  const [companyName, setCompany] = useState(''), [taxNumber, setTax] = useState(''), [email, setEmail] = useState(''), [invoiceNumber, setInvoiceNumber] = useState(''), [invoiceReason, setInvoiceReason] = useState('')
  const [acknowledged, setAcknowledged] = useState(false), [invoiceOpen, setInvoiceOpen] = useState(false)
  const intent = useRef(null), lock = useRef(false)
  async function act(action, values = {}) {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(null)
    const body = { expectedRevision: order.revision, ...values }, signature = JSON.stringify([action, body])
    if (intent.current?.signature !== signature) intent.current = { signature, key: crypto.randomUUID() }
    try { const next = await adminApi.paymentAction(token, order.tenantId, order.id, action, body, intent.current.key); setOrder(next); intent.current = null; onChanged(); notify?.('订单已更新') }
    catch (err) { setError(err) } finally { lock.current = false; setBusy(false) }
  }
  async function refresh() {
    setError(null); setBusy(true)
    try { setOrder(await adminApi.paymentOrder(token, order.tenantId, order.id)); onChanged() } catch (err) { setError(err) } finally { setBusy(false) }
  }
  return <Modal title={order.environment === 'test' ? '测试充值订单' : '充值订单'} description={order.id} size="large" busy={busy} onClose={onClose} closeOnBackdrop={false} closeOnEscape={false} footer={<><button className={button} disabled={busy} onClick={refresh}>刷新订单</button><button className={button} disabled={busy} onClick={onClose}>关闭</button></>}>
    <div className="mih-pay-detail">{error ? <ErrorState error={error} /> : null}<div className="mih-pay-order-total"><strong>{money(order.amountMinor)}</strong><Badge status={order.status} /></div>
      <dl className="mih-pay-facts"><div><dt>环境</dt><dd>{order.environment === 'test' ? '测试（不可消费）' : '正式'}</dd></div><div><dt>收款人</dt><dd>{order.checkout.payeeName}</dd></div><div><dt>下单时间</dt><dd>{stamp(order.createdAt)}</dd></div></dl>
      {order.status === 'pending' ? <>
        {order.checkout.qrImage ? <img className="mih-pay-qr" src={order.checkout.qrImage} alt={`支付宝收款码，收款人 ${order.checkout.payeeName}`} /> : null}
        <p>{order.checkout.instructions}</p><p className="mih-pay-notice">{order.environment === 'test' ? '无需真实付款。填写模拟付款人和至少 6 位测试流水号。' : `请扫码支付 ${money(order.amountMinor)}，核对支付宝显示的收款人；静态收款码需要手工输入金额。请勿重复付款。`}</p>
        {order.rejection ? <p role="alert">上次提交已退回：{order.rejection.reason}</p> : null}
        <form className="mih-pay-form" onSubmit={event => { event.preventDefault(); act('submit', { payerName, tradeNo }) }}><Input label="付款人" value={payerName} onChange={event => setPayerName(event.target.value)} maxLength={100} required /><Input label="支付宝交易流水号（测试可填 TEST-001）" value={tradeNo} onChange={event => setTradeNo(event.target.value)} minLength={6} maxLength={128} required /><button className={primary} disabled={busy}>我已付款，提交核实</button></form>
        <button className={button} disabled={busy} onClick={() => act('cancel')}>尚未付款，取消订单</button>
      </> : null}
      {order.status === 'submitted' ? <><p className="mih-pay-notice">已提交核实，确认到账后增加余额。请勿重复付款。</p><p>付款人：{order.submission.payerName} · 用户提交流水：{order.submission.tradeNo}</p>
        {session.platformAdmin ? <form className="mih-pay-form" onSubmit={event => { event.preventDefault(); if (acknowledged) act('confirm', { tradeNo, receivedAmountMinor: parseAmount(received), feeMinor: fee === '' ? null : parseAmount(fee), paidAt: new Date(paidAt).toISOString(), note }) }}>
          <h3>管理员核实到账</h3><p>填写交易支付总额，手续费单独记录；不要把扣除手续费后的净结算额作为订单金额。</p><Input label="账单中的实际流水号" value={tradeNo} onChange={event => setTradeNo(event.target.value)} required /><Input label="实际收到的金额（元）" value={received} onChange={event => setReceived(event.target.value)} inputMode="decimal" required /><Input label="渠道手续费（元，可留空表示未知）" value={fee} onChange={event => setFee(event.target.value)} inputMode="decimal" /><Input label="实际到账时间" type="datetime-local" value={paidAt} onChange={event => setPaidAt(event.target.value)} required /><Input label="核实说明 / 退回原因" value={note} onChange={event => setNote(event.target.value)} maxLength={500} required />
          <label className="mih-pay-check"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />{order.environment === 'test' ? '确认仅记入测试账本' : '已在收款账户核实这笔真实到账，且未通过人工充值等方式重复入账'}</label>
          <div className="mih-pay-actions"><button className={primary} disabled={busy || !acknowledged}>确认到账并入账</button><button className={button} type="button" disabled={busy || !note.trim()} onClick={() => act('reject', { reason: note })}>退回补充信息</button></div>
        </form> : null}</> : null}
      {order.status === 'paid' ? <><p className="mih-pay-notice">{order.environment === 'test' ? '已记录测试入账，正式余额未增加。' : '充值已到账，可在用量与账单中查看余额。'}</p><dl className="mih-pay-facts"><div><dt>支付流水</dt><dd>{order.settlement.tradeNo}</dd></div><div><dt>核实时间</dt><dd>{stamp(order.settlement.confirmedAt)}</dd></div><div><dt>账本编号</dt><dd>{order.settlement.ledgerEntryId}</dd></div></dl>
        {!order.invoice || order.invoice.status === 'rejected' ? <button className={primary} disabled={busy} onClick={() => setInvoiceOpen(value => !value)}>提交公司信息，申请开票</button> : null}
        {invoiceOpen && (!order.invoice || order.invoice.status === 'rejected') ? <form className="mih-pay-form" onSubmit={event => { event.preventDefault(); act('invoice-request', { companyName, taxNumber, email }) }}><h3>公司开票信息</h3><Input label="公司抬头" value={companyName} onChange={event => setCompany(event.target.value)} maxLength={200} required /><Input label="纳税人识别号" value={taxNumber} onChange={event => setTax(event.target.value.toUpperCase())} minLength={15} maxLength={20} required /><Input label="收票邮箱" type="email" value={email} onChange={event => setEmail(event.target.value)} required /><p>申请金额：{money(order.amountMinor)}。提交申请后，由工作人员核实开票内容并交付发票。</p><button className={primary} disabled={busy}>提交开票申请</button></form> : null}
        {order.invoice ? <section className="mih-pay-invoice"><h3>开票申请 <Badge status={order.invoice.status} /></h3><p>{order.invoice.companyName} · {order.invoice.taxNumber}</p><p>{order.invoice.email}</p>{order.invoice.invoiceNumber ? <p>发票号码：{order.invoice.invoiceNumber}</p> : null}{order.invoice.reason ? <p>{order.invoice.reason}</p> : null}
          {session.platformAdmin && order.invoice.status === 'requested' ? <form className="mih-pay-form" onSubmit={event => { event.preventDefault(); act('invoice-resolve', { status: 'issued', invoiceNumber, reason: invoiceReason }) }}><Input label="已开具发票号码" value={invoiceNumber} onChange={event => setInvoiceNumber(event.target.value)} maxLength={80} required /><Input label="交付说明 / 退回原因" value={invoiceReason} onChange={event => setInvoiceReason(event.target.value)} maxLength={500} required /><p>本操作登记已人工开具并交付的发票，不会自动生成或发送发票。</p><div className="mih-pay-actions"><button className={primary} disabled={busy}>登记已开票</button><button className={button} type="button" disabled={busy || !invoiceReason.trim()} onClick={() => act('invoice-resolve', { status: 'rejected', reason: invoiceReason })}>退回开票申请</button></div></form> : null}
        </section> : null}</> : null}
      {session.platformAdmin && order.events?.length ? <details><summary>最近 {order.events.length} 条操作记录（最多 100 条）</summary>{order.events.map(event => <p key={event.id}>{stamp(event.at)} · {event.action} · {event.actor}</p>)}</details> : null}
    </div>
  </Modal>
}

function PaymentSettings({ token, onClose, onSaved, onUnauthorized }) {
  const [saving, setSaving] = useState(false)
  const load = useCallback(() => adminApi.paymentSettings(token), [token])
  const state = useRemoteData(load, onUnauthorized)
  return <Modal title="支付宝收款设置" description="先配置可用于当前业务场景的收款码。启用后，用户即可创建正式充值订单。" size="large" onClose={onClose} closeOnBackdrop={false} busy={saving}>{state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : state.data ? <SettingsForm key={state.data.revision} initial={state.data} {...{ token, onSaved }} onSaving={setSaving} /> : <LoadingState />}</Modal>
}
function SettingsForm({ initial, token, onSaved, onSaving }) {
  const [form, setForm] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState(null)
  const change = (key, value) => setForm(current => ({ ...current, [key]: value }))
  async function imageFile(event) {
    const file = event.target.files?.[0]; if (!file) return
    if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 512_000) { setError(new Error('请选择不超过 500 KB 的 PNG、JPEG 或 WebP 图片')); return }
    const reader = new FileReader(); reader.onload = () => change('qrImage', reader.result); reader.readAsDataURL(file)
  }
  async function save(event) {
    event.preventDefault(); setBusy(true); onSaving(true); setError(null)
    try { await adminApi.savePaymentSettings(token, { expectedRevision: initial.revision, enabled: form.enabled, merchantAccountId: form.merchantAccountId, payeeName: form.payeeName, qrImage: form.qrImage, instructions: form.instructions }); onSaved() } catch (err) { setError(err) } finally { setBusy(false); onSaving(false) }
  }
  return <form className="mih-pay-form mih-pay-detail" onSubmit={save}>{error ? <ErrorState error={error} /> : null}<Input label="收款账户固定标识（保存后不可改名）" value={form.merchantAccountId} onChange={event => change('merchantAccountId', event.target.value)} disabled={Boolean(initial.merchantAccountId)} placeholder="alipay-main" required /><Input label="支付宝显示的收款人姓名或公司名称" value={form.payeeName} onChange={event => change('payeeName', event.target.value)} maxLength={100} required /><Input label="收款码图片（≤ 500 KB）" type="file" accept="image/png,image/jpeg,image/webp" onChange={imageFile} />{form.qrImage ? <img className="mih-pay-qr" src={form.qrImage} alt="收款码预览" /> : null}<Input label="付款说明" value={form.instructions} onChange={event => change('instructions', event.target.value)} maxLength={500} /><label className="mih-pay-check"><input type="checkbox" checked={form.enabled} onChange={event => change('enabled', event.target.checked)} />启用正式收款</label><p>更新只影响新订单。关闭通道会停止新建订单，已有订单仍需核账；请保留原收款账户。</p><button className={primary} disabled={busy || !form.qrImage}>{busy ? '保存中…' : '保存收款设置'}</button></form>
}
