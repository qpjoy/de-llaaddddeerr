import { createHash, randomUUID } from 'node:crypto'

// Payment policy has no dependency on Launcher, Hub auth, databases or providers.
export class PaymentError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code }
}
export function requirePayment(condition, code, message, status = 400) {
  if (!condition) throw new PaymentError(status, code, message)
}
export function fields(body, allowed) {
  requirePayment(body && typeof body === 'object' && !Array.isArray(body), 'invalid_payment', '请输入有效的支付参数')
  requirePayment(Object.keys(body).every(key => allowed.includes(key)), 'unsupported_payment_fields', '支付请求包含不支持的字段')
}
export function text(value, label, max = 256) {
  requirePayment(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max && !/[\u0000-\u001f]/u.test(value), 'invalid_payment', `${label}格式不正确`)
  return value.trim()
}
export function environment(value) {
  requirePayment(['live', 'test'].includes(value), 'invalid_payment_environment', '请选择正式或测试环境')
  return value
}
export function minor(value, label = '金额', { min = 0, max = 10_000_000 } = {}) {
  requirePayment(Number.isSafeInteger(value) && value >= min && value <= max, 'invalid_payment_amount', `${label}必须是 ${min}–${max} 范围内的整数分`)
  return value
}
export function requestKey(value) {
  requirePayment(typeof value === 'string' && /^[A-Za-z0-9:_-]{8,128}$/u.test(value), 'payment_idempotency_required', '请保留原请求编号重试')
  return value
}
export function fingerprint(value) {
  const canonical = input => Array.isArray(input) ? input.map(canonical) : input && typeof input === 'object'
    ? Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical(input[key])])) : input
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
export const defaultSettings = () => ({ revision: 0, enabled: false, merchantAccountId: '', payeeName: '', qrImage: '', instructions: '' })

export function settingsInput(body) {
  fields(body, ['expectedRevision', 'enabled', 'merchantAccountId', 'payeeName', 'qrImage', 'instructions'])
  minor(body.expectedRevision, '配置版本', { max: Number.MAX_SAFE_INTEGER })
  requirePayment(typeof body.enabled === 'boolean', 'invalid_payment', '请选择是否启用真实收款')
  const result = { enabled: body.enabled, merchantAccountId: text(body.merchantAccountId, '收款账户标识', 80), payeeName: text(body.payeeName, '收款人', 100), qrImage: body.qrImage, instructions: String(body.instructions || '').trim() }
  requirePayment(/^[A-Za-z0-9._-]+$/u.test(result.merchantAccountId), 'invalid_payment', '收款账户标识仅支持字母、数字、点、下划线和短横线')
  requirePayment(result.instructions.length <= 500, 'invalid_payment', '付款说明最多 500 字')
  // Inline raster images avoid external tracking, SSRF and executable SVGs.
  const match = typeof result.qrImage === 'string' && /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(result.qrImage)
  requirePayment(match && result.qrImage.length <= 700_000, 'invalid_payment_qr', '请上传不超过 500 KB 的 PNG、JPEG 或 WebP 收款码')
  const bytes = Buffer.from(match[2], 'base64')
  const validImage = match[1] === 'png' ? bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
    : match[1] === 'jpeg' ? bytes.subarray(0, 3).toString('hex') === 'ffd8ff'
      : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
  requirePayment(validImage && bytes.length <= 512_000, 'invalid_payment_qr', '收款码图片格式或大小不正确')
  return result
}

export function createOrder({ tenantId, input, settings, actor, now = new Date().toISOString() }) {
  fields(input, ['environment', 'amountMinor'])
  const env = environment(input.environment)
  const amountMinor = minor(input.amountMinor, '充值金额', { min: 100 })
  requirePayment(env === 'test' || settings.enabled, 'payment_channel_disabled', '收款通道尚未开通，请联系管理员', 409)
  return {
    id: randomUUID(), tenantId, environment: env, provider: env === 'test' ? 'mock' : 'manual_alipay',
    merchantAccountId: env === 'test' ? 'mock' : settings.merchantAccountId,
    amountMinor, currency: 'CNY', status: 'pending', revision: 0,
    checkout: env === 'test' ? { payeeName: '测试支付（不发生真实扣款）', qrImage: '', instructions: '仅验证充值流程，不增加正式可用余额。' }
      : { payeeName: settings.payeeName, qrImage: settings.qrImage, instructions: settings.instructions },
    submission: null, settlement: null, invoice: null, rejection: null,
    createdBy: actor, createdAt: now, updatedAt: now,
  }
}

const tradeNumber = value => {
  const result = text(value, '支付流水号', 128)
  requirePayment(/^[A-Za-z0-9_-]{6,128}$/u.test(result), 'invalid_payment_trade', '支付流水号需为 6–128 位字母、数字、下划线或短横线')
  return result
}
export function transitionOrder(order, action, body, { actor, finance = false, now = new Date().toISOString() }) {
  const allowed = {
    submit: ['payerName', 'tradeNo'], cancel: [], reject: ['reason'],
    confirm: ['tradeNo', 'receivedAmountMinor', 'feeMinor', 'paidAt', 'note'],
    'invoice-request': ['companyName', 'taxNumber', 'email'],
    'invoice-resolve': ['status', 'invoiceNumber', 'reason'],
  }
  requirePayment(Object.hasOwn(allowed, action), 'invalid_payment_action', '不支持该订单操作')
  fields(body, ['expectedRevision', ...allowed[action]])
  requirePayment(Number.isSafeInteger(body.expectedRevision) && body.expectedRevision === order.revision, 'payment_revision_conflict', '订单已更新，请刷新后操作', 409)
  const next = structuredClone(order)
  const state = (...states) => requirePayment(states.includes(order.status), 'payment_state_conflict', '当前订单状态不支持此操作', 409)
  if (['confirm', 'reject', 'invoice-resolve'].includes(action)) requirePayment(finance, 'payment_finance_required', '该操作需要平台管理员核实', 403)
  if (action === 'submit') {
    state('pending')
    next.submission = { payerName: text(body.payerName, '付款人', 100), tradeNo: tradeNumber(body.tradeNo), submittedAt: now }
    next.status = 'submitted'; next.rejection = null
  } else if (action === 'cancel') {
    state('pending')
    next.status = 'cancelled'
  } else if (action === 'reject') {
    state('submitted')
    next.status = 'pending'; next.rejection = { reason: text(body.reason, '退回原因', 500), actor, at: now }
  } else if (action === 'confirm') {
    state('submitted')
    requirePayment(minor(body.receivedAmountMinor) === order.amountMinor, 'payment_amount_mismatch', '实际到账金额必须与订单金额一致；差额请先人工处理', 409)
    const paidAt = typeof body.paidAt === 'string' ? Date.parse(body.paidAt) : NaN
    requirePayment(Number.isFinite(paidAt) && paidAt >= Date.parse(order.createdAt) - 300_000 && paidAt <= Date.parse(now) + 300_000, 'invalid_payment_time', '到账时间需在下单之后且不能晚于当前时间')
    next.settlement = { tradeNo: tradeNumber(body.tradeNo), amountMinor: order.amountMinor,
      feeMinor: body.feeMinor == null ? null : minor(body.feeMinor, '手续费', { max: order.amountMinor }),
      paidAt: new Date(paidAt).toISOString(), confirmedAt: now, confirmedBy: actor, note: text(body.note, '核实说明', 500), ledgerEntryId: null }
    next.status = 'paid'
  } else if (action === 'invoice-request') {
    state('paid')
    requirePayment(!order.invoice || order.invoice.status === 'rejected', 'invoice_already_requested', '该订单已有开票申请', 409)
    const taxNumber = text(body.taxNumber, '纳税人识别号', 20).toUpperCase()
    requirePayment(/^[A-Z0-9]{15,20}$/u.test(taxNumber), 'invalid_invoice', '请输入 15–20 位纳税人识别号')
    const email = text(body.email, '收票邮箱', 254)
    requirePayment(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email), 'invalid_invoice', '请输入有效的收票邮箱')
    next.invoice = { status: 'requested', companyName: text(body.companyName, '公司抬头', 200), taxNumber, email, requestedAt: now, requestedBy: actor, amountMinor: order.amountMinor }
  } else if (action === 'invoice-resolve') {
    state('paid')
    requirePayment(order.invoice?.status === 'requested', 'invoice_state_conflict', '当前没有待处理的开票申请', 409)
    requirePayment(['issued', 'rejected'].includes(body.status), 'invalid_invoice', '请选择已开票或退回')
    next.invoice = { ...order.invoice, status: body.status, resolvedAt: now, resolvedBy: actor,
      invoiceNumber: body.status === 'issued' ? text(body.invoiceNumber, '发票号码', 80) : null,
      reason: text(body.reason, body.status === 'issued' ? '交付说明' : '退回原因', 500) }
  }
  next.revision += 1; next.updatedAt = now
  return next
}
