import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { PaymentError, fields, requirePayment } from '@qpjoy/mx-pay'
import { verifyPaymentSource } from '@qpjoy/mx-pay/integration'
import { parseRechargeSources } from './recharge-config.mjs'

const scopes = ['orders.read','orders.write','events.read','events.ack']
const messages = {
  recharge_unconfigured: '尚未配置支付服务连接。',
  recharge_source_mismatch: '支付源、应用或环境与配置不一致，请核对原支付服务。',
  recharge_credential_scope: '业务凭据缺少下单或付款事件权限，请使用对应环境的应用凭据。',
  recharge_channel_unsupported: '未找到允许此应用使用的渠道，请检查渠道 ID、环境和应用白名单。',
  recharge_connection_unavailable: '支付连接配置无法解密，请核对保留的 Hub 密钥与数据库。',
  recharge_connection_conflict: '配置已被其他操作更新，请刷新后重新检查。',
  recharge_token_required: '请填写业务凭据；更换服务地址或应用时不能复用未回显的旧凭据。',
  payment_unavailable: '无法连接支付 API，请检查内网地址、DNS、端口和服务状态。',
  payment_unauthorized: '支付服务拒绝了业务凭据，请检查是否已撤销或用错环境。',
}
export function connectionFailure(error) {
  const code = messages[error?.code] ? error.code : error?.status === 401 || error?.status === 403 ? 'payment_unauthorized' : 'payment_unavailable'
  return { code, message: messages[code] }
}

// Uses the retained Hub pepper, with a separate key purpose and per-environment AAD.
// No browser-facing method returns the envelope or token; reads never seed the DB.
export class PaymentConnections {
  constructor(pool, pepper) {
    if (typeof pepper !== 'string' || pepper.length < 16) throw Error('Payment connection encryption requires the retained Hub pepper')
    this.pool = pool
    this.key = Buffer.from(hkdfSync('sha256', pepper, 'mx-insight-hub', 'payment-connection-v1', 32))
  }
  seal(env, source) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from(`hub_recharge:${env}`))
    const bytes = Buffer.concat([cipher.update(JSON.stringify(source)), cipher.final()])
    return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),bytes.toString('base64url')].join('.')
  }
  open(env, value) {
    try {
      const [v,iv,tag,bytes] = value.split('.')
      if (v !== 'v1') throw Error()
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv,'base64url'))
      decipher.setAAD(Buffer.from(`hub_recharge:${env}`));decipher.setAuthTag(Buffer.from(tag,'base64url'))
      const source = JSON.parse(Buffer.concat([decipher.update(Buffer.from(bytes,'base64url')),decipher.final()]).toString())
      const {sourceId,...config} = source
      parseRechargeSources(JSON.stringify([config]))
      if (config.environment !== env || !/^[0-9a-f-]{36}$/i.test(sourceId)) throw Error()
      return source
    } catch { throw new PaymentError(503,'recharge_connection_unavailable',messages.recharge_connection_unavailable) }
  }
  async read(env) {
    const row = (await this.pool.query('SELECT * FROM hub_recharge.connections WHERE environment=$1',[env])).rows[0]
    return row ? {source:this.open(env,row.sealed),revision:row.revision,origin:'database',updatedAt:row.updated_at} : null
  }
  async current(env, fallback) {
    return await this.read(env) || {source:fallback || null,revision:0,origin:fallback?'environment':'none',updatedAt:null}
  }
  view(snapshot) {
    const source = snapshot.source
    return {revision:snapshot.revision,origin:snapshot.origin,updatedAt:snapshot.updatedAt,
      baseUrl:source?.baseUrl || '',appId:source?.appId || 'mx-insight-hub',channelId:source?.channelId || '',tokenConfigured:Boolean(source?.token)}
  }
  async candidate(env, body, fallback) {
    fields(body,['revision','baseUrl','appId','channelId','token'])
    requirePayment(Number.isSafeInteger(body.revision) && body.revision >= 0,'invalid_payment_connection','配置版本不正确')
    const snapshot = await this.current(env,fallback), previous = snapshot.source
    requirePayment(body.revision === snapshot.revision,'recharge_connection_conflict',messages.recharge_connection_conflict,409)
    requirePayment(typeof body.token === 'string' && body.token.length <= 4096,'invalid_payment_connection','业务凭据格式不正确')
    // Never forward an unseen retained secret to a newly entered destination.
    if (!body.token) requirePayment(previous && body.baseUrl === previous.baseUrl && body.appId === previous.appId,
      'recharge_token_required',messages.recharge_token_required)
    try {
      const source = parseRechargeSources(JSON.stringify([{environment:env,baseUrl:body.baseUrl,appId:body.appId,channelId:body.channelId,token:body.token || previous?.token}]))[0]
      return {source,revision:snapshot.revision}
    } catch { throw new PaymentError(400,'invalid_payment_connection','请检查内网 API 地址、应用 ID、渠道 ID 和至少 32 位的业务凭据。') }
  }
  async assertRevision(client, env, revision) {
    const row = (await client.query('SELECT revision FROM hub_recharge.connections WHERE environment=$1',[env])).rows[0]
    requirePayment((row?.revision || 0) === revision,'recharge_connection_conflict',messages.recharge_connection_conflict,409)
  }
  async save(client, env, candidate, checked, actor) {
    await this.assertRevision(client,env,candidate.revision)
    const source = {...candidate.source,sourceId:checked.sourceId}, revision = candidate.revision+1
    await client.query(`INSERT INTO hub_recharge.connections(environment,revision,sealed,updated_by) VALUES($1,$2,$3,$4)
      ON CONFLICT(environment) DO UPDATE SET revision=excluded.revision,sealed=excluded.sealed,updated_by=excluded.updated_by,updated_at=now()`,
    [env,revision,this.seal(env,source),actor])
    await client.query('INSERT INTO hub_recharge.connection_audit(environment,revision,actor,document) VALUES($1,$2,$3,$4)',
      [env,revision,actor,{sourceId:checked.sourceId,appId:source.appId,channelId:source.channelId,baseUrl:source.baseUrl}])
    return this.view({source,revision,origin:'database',updatedAt:new Date().toISOString()})
  }
}

export async function checkPaymentConnection(source, client, route, identity = null) {
  identity ||= await client.identity()
  verifyPaymentSource(identity,{appId:source.appId,environment:source.environment,sourceId:route?.source_id || source.sourceId,
    features:['initiatorRef'],scopes},{sourceCode:'recharge_source_mismatch',scopeCode:'recharge_credential_scope'})
  requirePayment(!route?.source_id || route.app_id === source.appId && route.channel_id === source.channelId,
    'recharge_source_mismatch',messages.recharge_source_mismatch,409)
  const channel = (await client.channels()).items?.find(c=>c.id===source.channelId)
  requirePayment(channel && (channel.provider==='alipay' || source.environment==='test' && channel.provider==='mock'),
    'recharge_channel_unsupported',messages.recharge_channel_unsupported,409)
  return {sourceId:identity.sourceId,appId:identity.appId,environment:identity.environment,channelId:channel.id,channelEnabled:channel.enabled===true}
}
