import { readFileSync } from 'node:fs'
import { createPrivateKey, createPublicKey } from 'node:crypto'

const id = value => typeof value === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(value)
const https = value => {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw Error('Invalid URL')
  return url
}
// Separate from SDK imports: deployment preflight needs only Node built-ins.
export function readChannels(filename) {
  return validateChannels(filename ? JSON.parse(readFileSync(filename, 'utf8')) : [])
}
// Diagnostics are fixed messages only: never echo a submitted key or crypto error.
export function channelValidationIssues(c) {
  const issues = [], issue = (field, message) => issues.push({ field, message })
  if (!c || typeof c !== 'object') return [{ field: 'channel', message: '渠道配置无效。' }]
  if (!id(c.id) || ['mock','manual_alipay'].includes(c.id)) issue('id', '渠道 ID 需为 1–80 位字母、数字、点、下划线或短横线，且不能使用保留名称。')
  if (c.provider !== 'alipay') issue('provider', '请选择支持的支付宝渠道。')
  if (!['test','live'].includes(c.environment)) issue('environment', '请选择正式或沙箱环境。')
  if (typeof c.enabled !== 'boolean') issue('enabled', '请选择发布后是否启用新订单。')
  if (typeof c.appId !== 'string' || !/^\d{16}$/.test(c.appId)) issue('appId', '支付宝 APPID 需为 16 位数字。')
  if (typeof c.sellerId !== 'string' || !/^2088\d{12}$/.test(c.sellerId)) issue('sellerId', 'Seller ID 需为 2088 开头的 16 位商户 ID。')
  if (!Array.isArray(c.allowedApps) || !c.allowedApps.length || !c.allowedApps.every(id)) issue('allowedApps', '至少填写一个有效的来源应用 ID，多个应用用逗号分隔。')
  if (!['PKCS8','PKCS1'].includes(c.keyType)) issue('keyType', '请选择 PKCS8 或 PKCS1 私钥格式。')
  try {
    const prefix = c.keyType === 'PKCS8' ? '-----BEGIN PRIVATE KEY-----' : '-----BEGIN RSA PRIVATE KEY-----'
    if (typeof c.privateKey !== 'string' || !c.privateKey.startsWith(prefix)) throw Error()
    const key = createPrivateKey(c.privateKey)
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) throw Error()
  } catch { issue('privateKey', '应用私钥需为匹配所选格式的完整 RSA PEM，至少 2048 位；仅保存文本不代表校验通过。') }
  try {
    if (typeof c.alipayPublicKey !== 'string') throw Error()
    const key = createPublicKey(c.alipayPublicKey)
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) throw Error()
  } catch { issue('alipayPublicKey', '请填写有效的支付宝 RSA 公钥 PEM，至少 2048 位。') }
  try {
    if (https(c.notifyUrl).pathname !== `/v1/notifications/alipay/${c.id}`) throw Error()
  } catch { issue('notifyUrl', '通知地址需为 HTTPS，路径必须是 /v1/notifications/alipay/渠道ID，不能带查询参数、片段或末尾斜杠。') }
  try { https(c.returnUrl) } catch { issue('returnUrl', '付款后返回地址需为 HTTPS，不能带查询参数、片段或账号密码。') }
  if (Object.keys(c).some(k => !['id','provider','environment','enabled','appId','sellerId','allowedApps','keyType','privateKey','alipayPublicKey','notifyUrl','returnUrl'].includes(k))) issue('channel', '渠道包含不支持的配置字段。')
  return issues
}
export function validateChannels(entries) {
  try {
    if (!Array.isArray(entries) || entries.length > 32) throw Error('Invalid list')
    const ids = new Set(), accounts = new Set()
    for (const c of entries) {
      if (channelValidationIssues(c).length || ids.has(c.id)) throw Error('Invalid channel')
      const account = `${c.environment}:${c.appId}`
      if (accounts.has(account)) throw Error('Duplicate Alipay application')
      ids.add(c.id); accounts.add(account)
    }
    return entries
  } catch { throw new Error('Invalid mx-pay channels file; check channel IDs, app/seller IDs, app allowlists, HTTPS URLs and RSA PEM keys (values hidden)') }
}
