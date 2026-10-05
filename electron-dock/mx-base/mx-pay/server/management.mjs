import { createHash, randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { requirePayment, PaymentError, fields } from '../src/index.mjs'
import { validateChannels, channelValidationIssues } from './channel-config.mjs'
import { ChannelPayments } from './channel-payments.mjs'

// Unserializable provenance: callers cannot smuggle delegated grants through JSON.
const delegated = Symbol('verified-launcher-grants')
const launcherRoles = { 'mx:pay:admin': 'administrator', 'mx:pay:channels': 'channel_manager',
  'mx:pay:audit': 'auditor', 'mx:pay:finance': 'finance_viewer' }
const digest = value => createHash('sha256').update(value).digest('hex')
const validId = value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(value)
const identityOf = p => ({ issuer: p.issuer, subject: p.subject, clientId: p.clientId })
export const memberId = p => digest(JSON.stringify([p.issuer,p.subject,p.clientId]))
export const roles = Object.freeze({
  administrator: ['channels.read','channels.write','orders.read','customers.read','finance.read','logs.read','members.read','members.write','applications.read','applications.write'],
  channel_manager: ['channels.read','channels.write'],
  auditor: ['channels.read','orders.read','customers.read','finance.read','logs.read','members.read','applications.read'],
  finance_viewer: ['finance.read'],
  viewer: ['orders.read','customers.read','logs.read'],
})
export const permissionCatalog = { version: 1, application: 'mx-pay', identityKey: ['issuer','subject','clientId'],
  roles, launcherRoles, scopes: ['center','application/environment'], financialWrites: [], authority: 'mx-pay',
  futureFinance: ['reconciliation','refunds','accounting'], futureFinanceEnabled: false }
export function validateGrants(grants) {
  requirePayment(Array.isArray(grants) && grants.length <= 100, 'invalid_payment_grants', '授权列表无效')
  const seen = new Set()
  for (const g of grants) {
    fields(g, ['role','scope','appId','environment'])
    requirePayment(Object.hasOwn(roles,g.role), 'invalid_payment_role', '未知支付角色')
    requirePayment(g.scope === 'center' ? g.role !== 'viewer' && !g.appId && !g.environment
      : g.scope === 'application' && ['viewer','finance_viewer'].includes(g.role) && validId(g.appId) && ['test','live'].includes(g.environment),
    'invalid_payment_scope', '请选择中心角色，或指定应用、环境的查看角色')
    const key = JSON.stringify([g.role,g.scope,g.appId,g.environment])
    requirePayment(!seen.has(key), 'duplicate_payment_grant', '重复授权'); seen.add(key)
  }
  return grants
}
const has = (p, permission, appId, environment) => p.grants.some(g => roles[g.role]?.includes(permission)
  && (g.scope === 'center' || g.appId === appId && g.environment === environment))
const permit = (p, permission, appId, environment) => requirePayment(has(p,permission,appId,environment), 'payment_console_forbidden','当前账号没有此模块或应用的权限',403)
const administrator = p => p.grants.some(g => g.scope === 'center' && g.role === 'administrator')
function readKey(file) {
  const key = readFileSync(file,'utf8').trim()
  if (!/^[a-f0-9]{64}$/.test(key)) throw Error('Invalid payment control key (value hidden)')
  return Buffer.from(key,'hex')
}
export class PaymentManagement {
  constructor(pool, key, { channelFactory, readPool = pool } = {}) {
    this.pool = pool; this.readPool = readPool; this.key = Buffer.isBuffer(key) ? key : readKey(key); this.channelFactory = channelFactory
    if (this.key.length !== 32) throw Error('Invalid control key')
  }
  seal(id, value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm',this.key,iv)
    cipher.setAAD(Buffer.from(`mx-pay:channel:${id}`))
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()])
    return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64')
  }
  unseal(id, value) {
    const bytes = Buffer.from(value,'base64'), decipher = createDecipheriv('aes-256-gcm',this.key,bytes.subarray(0,12))
    decipher.setAAD(Buffer.from(`mx-pay:channel:${id}`)); decipher.setAuthTag(bytes.subarray(12,28))
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString())
  }
  async transaction(work) {
    const c = await this.pool.connect()
    try {
      await c.query('BEGIN'); await c.query("SELECT pg_advisory_xact_lock(hashtext('pay-control'))")
      const result = await work(c)
      await c.query('COMMIT'); return result
    } catch (error) { await c.query('ROLLBACK').catch(()=>{}); throw error } finally { c.release() }
  }
  async audit(c, p, action, target, details = {}) {
    await c.query('INSERT INTO pay_control.audit(id,actor,action,target,details) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), p.credentialId ? { credentialId: p.credentialId } : identityOf(p), action,target,details])
  }
  async principal(identity, c = this.pool) {
    const id = memberId(identity), row = (await c.query('SELECT grants,revision FROM pay_control.members WHERE id=$1',[id])).rows[0]
    const localGrants = row?.grants || [], launcherGrants = identity[delegated] || []
    const grants = [...localGrants, ...launcherGrants.filter(g => !localGrants.some(local => local.role===g.role && local.scope===g.scope))]
    return { ...identityOf(identity), id, displayName: identity.displayName || identity.subject,
      grants, localGrants, launcherGrants, [delegated]: launcherGrants, revision: row?.revision || 0 }
  }
  // Called only by the SSO adapter after issuer/client/subject/audience verification.
  async ssoPrincipal(identity, settings) {
    const canonical = identity.mxIdentity
    const valid = canonical?.audience === settings.audience && canonical?.principal?.kind === 'user'
      && canonical.subject === `user:${identity.subject}` && canonical.principal.userId === identity.subject
      && [settings, ...(settings.previousProviders || [])].some(p => p.issuer===identity.issuer && p.clientId===identity.clientId)
    const scopes = valid && Array.isArray(canonical.principal.scopes) ? canonical.principal.scopes : []
    const grants = Object.entries(launcherRoles).filter(([scope]) => scopes.includes(scope)).map(([,role]) => ({ role, scope:'center' }))
    return this.principal({ ...identity, [delegated]: grants })
  }
  async bootstrap({ channels = [], credentials = [], access = [], drafts = [] } = {}) {
    await this.transaction(async c => {
      const fingerprint = digest(this.key)
      await c.query("INSERT INTO pay_control.meta VALUES('key',$1) ON CONFLICT DO NOTHING",[fingerprint])
      requirePayment((await c.query("SELECT value FROM pay_control.meta WHERE id='key'")).rows[0].value === fingerprint,
        'payment_control_key_changed','Restore the original payment control key',503)
      // Each seed is consumed once. Redeploy must never undo revocation or edits.
      const seed = async (id, work) => {
        if ((await c.query('SELECT id FROM pay_control.meta WHERE id=$1',[id])).rowCount) return
        await work(); await c.query('INSERT INTO pay_control.meta VALUES($1,$2)',[id,'imported'])
      }
      for (const ch of channels) await seed(`channel:${ch.id}`,async()=>{
        validateChannels([ch]); const cipher = this.seal(ch.id,ch)
        await c.query('INSERT INTO pay_control.channels(id,draft,published) VALUES($1,$2,$2) ON CONFLICT DO NOTHING',[ch.id,cipher])
      })
      requirePayment(Array.isArray(drafts) && drafts.length <= 32,'invalid_channel_drafts','渠道草稿列表无效')
      for (const ch of drafts) {
        this.draft(ch)
        await seed(`draft:${ch.id}`,()=>c.query('INSERT INTO pay_control.channels(id,draft) VALUES($1,$2) ON CONFLICT DO NOTHING',[ch.id,this.seal(ch.id,ch)]))
      }
      for (const cr of credentials) await seed(`credential:${cr.id}`,async()=>{
        await c.query('INSERT INTO pay_control.apps(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING',[cr.appId])
        await c.query('INSERT INTO pay_control.credentials(id,app_id,environment,scopes,hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [cr.id,cr.appId,cr.environment,JSON.stringify(cr.scopes),cr.hash.toString('hex')])
      })
      for (const entry of access) {
        const grant = entry.scope ? Object.fromEntries(['role','scope','appId','environment'].filter(k=>entry[k]).map(k=>[k,entry[k]]))
          : { role: 'viewer',scope: 'application',appId: entry.appId, environment: entry.environment }
        validateGrants([grant])
        await seed(`grant:${digest(JSON.stringify([entry.issuer,entry.subject,entry.clientId,grant.role,grant.scope,grant.appId || '',grant.environment || '']))}`,async()=>{
          const p = await this.principal(entry,c), grants = [...p.grants]
          if (!grants.some(g=>g.role===grant.role && g.scope===grant.scope && g.appId===grant.appId && g.environment===grant.environment)) grants.push(grant)
          await c.query(`INSERT INTO pay_control.members(id,identity,grants) VALUES($1,$2,$3)
            ON CONFLICT(id) DO UPDATE SET grants=excluded.grants,revision=pay_control.members.revision+1`,[p.id,identityOf(entry),JSON.stringify(grants)])
          await this.audit(c,{credentialId:'deployment-bootstrap'},'grant.bootstrap',p.id,{grants:[grant]})
        })
      }
    })
  }
  draft(value) {
    fields(value,['id','provider','environment','enabled','appId','sellerId','allowedApps','keyType','privateKey','alipayPublicKey','notifyUrl','returnUrl'])
    requirePayment(validId(value.id) && !['mock','manual_alipay'].includes(value.id) && value.provider === 'alipay'
      && ['live','test'].includes(value.environment) && typeof value.enabled === 'boolean'
      && Array.isArray(value.allowedApps) && value.allowedApps.length <= 100 && value.allowedApps.every(validId)
      && ['PKCS8','PKCS1'].includes(value.keyType), 'invalid_channel_draft','渠道草稿格式无效')
    for (const k of ['appId','sellerId','privateKey','alipayPublicKey','notifyUrl','returnUrl'])
      requirePayment(typeof value[k] === 'string' && value[k].length <= (k.includes('Key') ? 10000 : 1000),'invalid_channel_draft','渠道字段格式无效')
    return value
  }
  channelView(row, publishedChannels = []) {
    const ch = this.unseal(row.id,row.draft), {privateKey,alipayPublicKey,...safe} = ch
    const validationIssues = channelValidationIssues(ch)
    const published = row.published ? this.unseal(row.id,row.published) : null
    if (publishedChannels.some(other=>other.id!==ch.id && other.environment===ch.environment && other.appId===ch.appId))
      validationIssues.push({field:'appId',message:'同一环境已有使用此 APPID 的已发布渠道，请编辑原渠道。'})
    for (const field of ['provider','environment','appId','sellerId']) if (published && published[field]!==ch[field] && !validationIssues.some(issue=>issue.field===field))
      validationIssues.push({field,message:'已发布渠道的商户身份和环境不能改绑；如需更换，请建立新渠道。'})
    return { ...safe, privateKeyConfigured: Boolean(privateKey), alipayPublicKeyConfigured: Boolean(alipayPublicKey),
      revision: row.revision, published: Boolean(published), publishedEnabled: published?.enabled || false,
      pendingChanges: JSON.stringify(ch) !== JSON.stringify(published), valid:validationIssues.length===0, validationIssues, updatedAt: row.updated_at }
  }
  async syncChannels(service, pauseCheckout = false) {
    if (this.syncing) return this.syncing
    this.syncing = (async()=>{
      const rows = (await this.pool.query('SELECT id,published FROM pay_control.channels WHERE published IS NOT NULL ORDER BY id')).rows
      const version = digest(JSON.stringify(rows)+pauseCheckout)
      if (version === this.channelVersion) return
      const configs = validateChannels(rows.map(r=>this.unseal(r.id,r.published)))
      const channels = new ChannelPayments(service,configs.map(c=>pauseCheckout ? {...c,enabled:false} : c),this.channelFactory)
      await channels.bind()
      // Keep the in-flight query budget across configuration publications.
      service.channelPayments.adapters = channels.adapters; this.channelVersion = version
    })()
    try { await this.syncing } finally { this.syncing = null }
  }
  async authenticate(header) {
    const token = typeof header === 'string' && /^Bearer ([^\s]{32,4096})$/.exec(header)?.[1]
    requirePayment(token,'payment_auth_required','Payment service credential required',401)
    const row = (await this.pool.query('SELECT id,app_id,environment,scopes FROM pay_control.credentials WHERE hash=$1 AND NOT revoked',[digest(token)])).rows[0]
    requirePayment(row,'payment_auth_required','Invalid payment service credential',401)
    return { id:row.id,appId:row.app_id,environment:row.environment,scopes:row.scopes }
  }
  scopeQuery(p, permission, query, values) {
    const app = query.get('appId'), env = query.get('environment')
    for (const k of query.keys()) requirePayment(query.getAll(k).length===1,'invalid_payment_query','查询参数重复')
    const conditions = []
    const param = value => { values.push(value); return `$${values.length}` }
    if (!has(p,permission)) {
      const grants = p.grants.filter(g=>g.scope==='application' && roles[g.role]?.includes(permission))
      requirePayment(grants.length,'payment_console_forbidden','当前账号没有查询权限',403)
      conditions.push(`(${grants.map(g=>`(o.app_id=${param(g.appId)} AND o.environment=${param(g.environment)})`).join(' OR ')})`)
    }
    if (app) conditions.push(`o.app_id=${param(app)}`)
    if (env) { requirePayment(['live','test'].includes(env),'invalid_payment_query','环境无效'); conditions.push(`o.environment=${param(env)}`) }
    for (const [key,sql] of [['businessOrderId','o.business_order_id'],['customerRef',"o.document->>'customerRef'"],['status','o.status'],['channelId',"o.document->'checkout'->>'channelId'"]]) {
      const v = query.get(key)
      if (v) { requirePayment(v.length<=200,'invalid_payment_query','查询字段过长'); conditions.push(`${sql}=${param(v)}`) }
    }
    return conditions.length ? conditions.join(' AND ') : 'true'
  }
  async records(p, module, query) {
    const allowed = ['appId','environment','businessOrderId','customerRef','status','channelId','page']
    requirePayment([...query.keys()].every(k=>allowed.includes(k)),'invalid_payment_query','未知查询条件')
    const values = [], where = this.scopeQuery(p,module==='finance'?'finance.read':module==='customers'?'customers.read':module==='logs'?'logs.read':'orders.read',query,values)
    const page = Number(query.get('page') || 1)
    requirePayment(Number.isInteger(page) && page>=1 && page<=10000,'invalid_payment_query','页码无效')
    const offset = (page-1)*30
    let sql
    if (module==='orders') sql = `SELECT (o.document - ARRAY['submission','rejection','checkout']) || jsonb_build_object('channelId',o.document->'checkout'->>'channelId') AS item FROM pay.orders o WHERE ${where} ORDER BY o.created_at DESC,o.id DESC LIMIT 31 OFFSET ${offset}`
    if (module==='customers') sql = `SELECT jsonb_build_object('appId',o.app_id,'environment',o.environment,'customerRef',o.document->>'customerRef','orders',count(*),'paidMinor',coalesce(sum(o.amount_minor) FILTER (WHERE o.status='paid'),0),'lastOrderAt',max(o.created_at)) AS item FROM pay.orders o WHERE ${where} GROUP BY o.app_id,o.environment,o.document->>'customerRef' ORDER BY max(o.created_at) DESC,o.app_id,o.environment,o.document->>'customerRef' LIMIT 31 OFFSET ${offset}`
    if (module==='finance') sql = `SELECT jsonb_build_object('appId',o.app_id,'environment',o.environment,'provider',o.provider,'status',o.status,'orders',count(*),'amountMinor',sum(o.amount_minor)) AS item FROM pay.orders o WHERE ${where} GROUP BY o.app_id,o.environment,o.provider,o.status ORDER BY o.app_id,o.environment,o.provider,o.status LIMIT 31 OFFSET ${offset}`
    if (module==='logs') sql = `SELECT jsonb_build_object('id',e.id,'orderId',o.id,'businessOrderId',o.business_order_id,'appId',o.app_id,'environment',o.environment,'createdAt',e.created_at,'acknowledgedAt',e.acknowledged_at) AS item FROM pay.outbox e JOIN pay.orders o ON o.id=e.order_id WHERE ${where} ORDER BY e.created_at DESC,e.id DESC LIMIT 31 OFFSET ${offset}`
    const rows = (await this.readPool.query(sql,values)).rows
    return {items:rows.slice(0,30).map(r=>r.item),page,hasMore:rows.length>30}
  }
  async changeGrants(p, id, body) {
    fields(body,['identity','grants','revision']); validateGrants(body.grants)
    return this.transaction(async c=>{
      const actor = p.credentialId ? p : await this.principal(p,c); permit(actor,'members.write')
      const previous = (await c.query('SELECT * FROM pay_control.members WHERE id=$1',[id])).rows[0]
      const identity = previous?.identity || body.identity
      requirePayment(identity && memberId(identity)===id && identity.issuer===p.issuer && identity.clientId===p.clientId
        && typeof identity.subject==='string' && identity.subject.length>0 && identity.subject.length<=200,
      'invalid_member_identity','需指定当前 SSO 的不可变用户 ID')
      requirePayment(body.revision===(previous?.revision || 0),'payment_revision_conflict','授权已变化，请刷新重试',409)
      if (previous && administrator(previous) && !administrator(body)) {
        const admins = (await c.query(`SELECT count(*) FROM pay_control.members WHERE grants @> '[{"role":"administrator","scope":"center"}]'::jsonb`)).rows[0].count
        requirePayment(Number(admins)>1,'payment_last_administrator','不能移除最后一位支付管理员',409)
      }
      await c.query(`INSERT INTO pay_control.members(id,identity,grants) VALUES($1,$2,$3) ON CONFLICT(id)
        DO UPDATE SET grants=excluded.grants,revision=pay_control.members.revision+1`,[id,identityOf(identity),JSON.stringify(body.grants)])
      await this.audit(c,p,'member.grants',id,{grants:body.grants}); return {id}
    })
  }
  async route(p, method, path, query, body = {}) {
    if (method==='GET' && path==='me') return {...p,permissions:permissionCatalog}
    if (method==='GET' && ['orders','customers','finance','logs'].includes(path)) return this.records(p,path,query)
    const orderDetail = /^orders\/([a-f0-9-]{36})$/.exec(path)
    if (method==='GET' && orderDetail) {
      const order = (await this.readPool.query('SELECT document FROM pay.orders WHERE id=$1',[orderDetail[1]])).rows[0]?.document
      requirePayment(order && has(p,'orders.read',order.appId,order.environment),'payment_order_not_found','订单不存在',404)
      const audits = (await this.readPool.query(`SELECT id,created_at,document - ARRAY['submission','settlement'] AS details FROM pay.audit WHERE order_id=$1 ORDER BY created_at,id LIMIT 100`,[order.id])).rows
      const observations = (await this.readPool.query('SELECT id,channel_id,outcome,reason,created_at FROM pay.channel_observations WHERE order_id=$1 ORDER BY created_at DESC LIMIT 100',[order.id])).rows
      const delivery = (await this.readPool.query('SELECT id,acknowledged_at,created_at FROM pay.outbox WHERE order_id=$1',[order.id])).rows
      const {submission,rejection,checkout,...safe}=order
      return {order:{...safe,channelId:checkout?.channelId},audits,observations,delivery}
    }
    if (method==='GET' && path==='observations') {
      permit(p,'logs.read')
      const page=Number(query.get('page') || 1)
      requirePayment(Number.isInteger(page) && page>=1 && page<=10000,'invalid_payment_query','页码无效')
      const rows=(await this.readPool.query('SELECT id,channel_id,order_id,app_id,environment,outcome,reason,created_at FROM pay.channel_observations ORDER BY created_at DESC,id DESC LIMIT 31 OFFSET $1',[(page-1)*30])).rows
      return {items:rows.slice(0,30),page,hasMore:rows.length>30}
    }
    if (method==='GET' && path==='channels') {
      permit(p,'channels.read')
      const rows=(await this.readPool.query('SELECT * FROM pay_control.channels ORDER BY id')).rows
      const published=rows.filter(r=>r.published).map(r=>this.unseal(r.id,r.published))
      return {items:rows.map(r=>this.channelView(r,published))}
    }
    if (method==='GET' && path==='members') { permit(p,'members.read'); return {items:(await this.readPool.query('SELECT id,identity,grants,revision FROM pay_control.members ORDER BY created_at,id LIMIT 1000')).rows} }
    if (method==='GET' && path==='applications') {
      permit(p,'applications.read')
      return {items:(await this.readPool.query('SELECT id,name FROM pay_control.apps ORDER BY id')).rows,
        credentials:(await this.readPool.query('SELECT id,app_id AS "appId",environment,scopes,revoked,created_at AS "createdAt" FROM pay_control.credentials ORDER BY created_at DESC LIMIT 1000')).rows}
    }
    if (method==='GET' && path==='audit') {
      permit(p,'logs.read')
      const page = Number(query.get('page') || 1)
      requirePayment(Number.isInteger(page) && page>=1 && page<=10000,'invalid_payment_query','页码无效')
      const rows = (await this.readPool.query('SELECT * FROM pay_control.audit ORDER BY created_at DESC,id DESC LIMIT 31 OFFSET $1',[(page-1)*30])).rows
      return {items:rows.slice(0,30),page,hasMore:rows.length>30}
    }
    if (method==='GET' && path==='invitations') {
      permit(p,'members.read'); return {items:(await this.readPool.query('SELECT id,grants,expires_at,used_by,revoked FROM pay_control.invitations ORDER BY created_at DESC LIMIT 1000')).rows}
    }
    const channel = /^channels\/([A-Za-z0-9._-]{1,80})(?:\/(publish))?$/.exec(path)
    if (channel && (method==='PUT' && !channel[2] || method==='POST' && channel[2])) return this.transaction(async c=>{
      permit(await this.principal(p,c),'channels.write')
      fields(body,channel[2]?['revision']:['revision','channel'])
      const id = channel[1], row = (await c.query('SELECT * FROM pay_control.channels WHERE id=$1',[id])).rows[0]
      requirePayment(body.revision===(row?.revision || 0),'payment_revision_conflict','渠道已变化，请刷新后重试',409)
      if (!channel[2]) {
        const old = row ? this.unseal(id,row.draft) : {}
        requirePayment(body.channel && body.channel.id===id,'invalid_channel_draft','渠道 ID 不匹配')
        const ch = this.draft({...body.channel,privateKey:body.channel.privateKey || old.privateKey || '',alipayPublicKey:body.channel.alipayPublicKey || old.alipayPublicKey || ''})
        requirePayment(row || Number((await c.query('SELECT count(*) FROM pay_control.channels')).rows[0].count)<32,'payment_channel_limit','渠道数量已达上限',409)
        await c.query(`INSERT INTO pay_control.channels(id,draft) VALUES($1,$2) ON CONFLICT(id) DO UPDATE
          SET draft=excluded.draft,revision=pay_control.channels.revision+1,updated_at=now()`,[id,this.seal(id,ch)])
        await this.audit(c,p,'channel.draft',id,{enabled:ch.enabled})
      } else {
        requirePayment(row,'payment_channel_not_found','渠道不存在',404)
        const ch = this.unseal(id,row.draft), published = (await c.query('SELECT id,published FROM pay_control.channels WHERE published IS NOT NULL AND id<>$1',[id])).rows.map(r=>this.unseal(r.id,r.published))
        try { validateChannels([...published,ch]) } catch {
          const issues=this.channelView(row,published).validationIssues
          throw new PaymentError(400,'invalid_payment_channel',issues.map(i=>i.message).join('；') || '渠道校验失败，请检查已发布的渠道配置。')
        }
        const binding = (await c.query('SELECT identity FROM pay.channel_bindings WHERE id=$1',[id])).rows[0]?.identity
        const identity = {provider:ch.provider,environment:ch.environment,appId:ch.appId,sellerId:ch.sellerId}
        requirePayment(!binding || Object.keys(identity).every(k=>binding[k]===identity[k]),'payment_channel_identity_changed','已发布渠道的商户身份不能改变；请建立新渠道',409)
        await c.query('INSERT INTO pay.channel_bindings(id,identity) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,identity])
        await c.query('UPDATE pay_control.channels SET published=draft,revision=revision+1,updated_at=now() WHERE id=$1',[id])
        await this.audit(c,p,'channel.publish',id,{enabled:ch.enabled,environment:ch.environment,allowedApps:ch.allowedApps})
      }
      const published=(await c.query('SELECT id,published FROM pay_control.channels WHERE published IS NOT NULL')).rows.map(r=>this.unseal(r.id,r.published))
      return this.channelView((await c.query('SELECT * FROM pay_control.channels WHERE id=$1',[id])).rows[0],published)
    })
    const member = /^members\/([a-f0-9]{64})$/.exec(path)
    if (method==='PUT' && member) return this.changeGrants(p,member[1],body)
    if (method==='POST' && path==='members') {
      fields(body,['subject','grants'])
      const identity = {...identityOf(p),subject:body.subject}
      return this.changeGrants(p,memberId(identity),{identity,grants:body.grants,revision:0})
    }
    if (method==='POST' && path==='invitations/accept') {
      fields(body,['token']); requirePayment(typeof body.token==='string' && /^[A-Za-z0-9_-]{43}$/.test(body.token),'invalid_payment_invitation','邀请无效')
      return this.transaction(async c=>{
        const inv = (await c.query('SELECT * FROM pay_control.invitations WHERE token_hash=$1 AND NOT revoked AND expires_at>now()',[digest(body.token)])).rows[0]
        requirePayment(inv && inv.issuer===p.issuer && inv.client_id===p.clientId && (!inv.used_by || inv.used_by===p.id),'invalid_payment_invitation','邀请已过期、已撤销或已被使用',409)
        if (inv.used_by===p.id) return {accepted:true}
        const current = await this.principal(p,c), grants = [...current.localGrants]
        for (const g of inv.grants) if (!grants.some(old=>old.role===g.role && old.scope===g.scope && old.appId===g.appId && old.environment===g.environment)) grants.push(g)
        validateGrants(grants)
        await c.query(`INSERT INTO pay_control.members(id,identity,grants) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE
          SET grants=excluded.grants,revision=pay_control.members.revision+1`,[p.id,identityOf(p),JSON.stringify(grants)])
        await c.query('UPDATE pay_control.invitations SET used_by=$1 WHERE id=$2',[p.id,inv.id])
        await this.audit(c,p,'invitation.accept',inv.id,{grants:inv.grants}); return {accepted:true}
      })
    }
    if (method==='POST' && path==='invitations') return this.transaction(async c=>{
      permit(await this.principal(p,c),'members.write'); fields(body,['grants']); validateGrants(body.grants)
      requirePayment(body.grants.length && !body.grants.some(g=>g.role==='administrator'),'invalid_invitation_role','邀请不授予中心管理员；管理员须按用户 ID 单独授权')
      const id = randomUUID(), token = randomBytes(32).toString('base64url')
      await c.query("INSERT INTO pay_control.invitations(id,token_hash,issuer,client_id,grants,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '48 hours')",[id,digest(token),p.issuer,p.clientId,JSON.stringify(body.grants)])
      await this.audit(c,p,'invitation.create',id,{grants:body.grants}); return {id,token,expiresInHours:48}
    })
    const revokeInvitation = /^invitations\/([a-f0-9-]{36})\/revoke$/.exec(path)
    if (method==='POST' && revokeInvitation) return this.transaction(async c=>{
      permit(await this.principal(p,c),'members.write'); fields(body,[])
      await c.query('UPDATE pay_control.invitations SET revoked=true WHERE id=$1',[revokeInvitation[1]])
      await this.audit(c,p,'invitation.revoke',revokeInvitation[1]); return {revoked:true}
    })
    if (method==='POST' && path==='applications') return this.transaction(async c=>{
      permit(await this.principal(p,c),'applications.write'); fields(body,['id','name'])
      requirePayment(validId(body.id) && typeof body.name==='string' && body.name.trim() && body.name.length<=120,'invalid_payment_app','应用 ID 或名称无效')
      await c.query('INSERT INTO pay_control.apps(id,name) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET name=excluded.name',[body.id,body.name.trim()])
      await this.audit(c,p,'application.save',body.id); return {id:body.id}
    })
    if (method==='POST' && path==='credentials') return this.transaction(async c=>{
      permit(await this.principal(p,c),'applications.write'); fields(body,['appId','environment','purpose'])
      requirePayment(validId(body.appId) && ['test','live'].includes(body.environment) && ['payments','reporting','launcher-permissions'].includes(body.purpose),'invalid_payment_credential','凭据配置无效')
      requirePayment((await c.query('SELECT id FROM pay_control.apps WHERE id=$1',[body.appId])).rowCount,'invalid_payment_app','请先登记应用')
      requirePayment(body.purpose!=='launcher-permissions' || body.appId==='mx-launcher' && body.environment==='live','invalid_payment_credential','全局权限凭据仅供 mx-launcher 正式环境使用')
      const id = `key-${randomUUID()}`, secret = randomBytes(32).toString('base64url')
      const scopes = body.purpose==='payments'?['orders.read','orders.write','events.read','events.ack']:body.purpose==='reporting'?['reports.read']:['permissions.read']
      await c.query('INSERT INTO pay_control.credentials(id,app_id,environment,scopes,hash) VALUES($1,$2,$3,$4,$5)',[id,body.appId,body.environment,JSON.stringify(scopes),digest(secret)])
      await this.audit(c,p,'credential.create',id,{appId:body.appId,environment:body.environment,scopes}); return {id,secret,appId:body.appId,environment:body.environment,scopes}
    })
    const credential = /^credentials\/([A-Za-z0-9._-]{1,80})\/revoke$/.exec(path)
    if (method==='POST' && credential) return this.transaction(async c=>{
      permit(await this.principal(p,c),'applications.write'); fields(body,[])
      requirePayment((await c.query('UPDATE pay_control.credentials SET revoked=true WHERE id=$1 RETURNING id',[credential[1]])).rowCount,'payment_credential_not_found','凭据不存在',404)
      await this.audit(c,p,'credential.revoke',credential[1]); return {revoked:true}
    })
    throw new PaymentError(404,'payment_route_not_found','Route not found')
  }
}
