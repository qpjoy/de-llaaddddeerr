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
export function validateChannels(entries) {
  try {
    if (!Array.isArray(entries) || entries.length > 32) throw Error('Invalid list')
    const ids = new Set(), accounts = new Set()
    for (const c of entries) {
      if (!c || !id(c.id) || ['mock','manual_alipay'].includes(c.id) || ids.has(c.id)
        || c.provider !== 'alipay' || !['test','live'].includes(c.environment) || typeof c.enabled !== 'boolean'
        || typeof c.appId !== 'string' || !/^\d{16}$/.test(c.appId) || typeof c.sellerId !== 'string' || !/^2088\d{12}$/.test(c.sellerId)
        || !Array.isArray(c.allowedApps) || !c.allowedApps.length || !c.allowedApps.every(id)
        || !['PKCS8','PKCS1'].includes(c.keyType) || typeof c.privateKey !== 'string' || typeof c.alipayPublicKey !== 'string'
        || Object.keys(c).some(k => !['id','provider','environment','enabled','appId','sellerId','allowedApps','keyType','privateKey','alipayPublicKey','notifyUrl','returnUrl'].includes(k))) throw Error('Invalid channel')
      if (https(c.notifyUrl).pathname !== `/v1/notifications/alipay/${c.id}`) throw Error('Invalid notification path')
      https(c.returnUrl)
      if (!c.privateKey.startsWith(c.keyType === 'PKCS8' ? '-----BEGIN PRIVATE KEY-----' : '-----BEGIN RSA PRIVATE KEY-----')) throw Error('Key type mismatch')
      for (const key of [createPrivateKey(c.privateKey), createPublicKey(c.alipayPublicKey)]) {
        if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) throw Error('RSA2 requires RSA >= 2048 bits')
      }
      const account = `${c.environment}:${c.appId}`
      if (accounts.has(account)) throw Error('Duplicate Alipay application')
      ids.add(c.id); accounts.add(account)
    }
    return entries
  } catch { throw new Error('Invalid mx-pay channels file; check channel IDs, app/seller IDs, app allowlists, HTTPS URLs and RSA PEM keys (values hidden)') }
}
