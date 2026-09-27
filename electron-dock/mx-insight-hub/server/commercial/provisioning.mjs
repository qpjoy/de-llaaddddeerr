import { randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { HubService } from '../hub-service.mjs'
import { MemoryStore } from '../stores/memory-store.mjs'
import { PostgresStore } from '../stores/postgres-store.mjs'
import { MemoryExternalPlatformControlStore, PostgresExternalPlatformControlStore, normalizePriceBook } from '../external-platforms/control-store.mjs'
import { customerRequestPrice } from '../billing/contracts.mjs'
import { digest, PROVISIONING_OPERATIONS, PROVISIONING_CATALOG_VERSION, provisioningOperation, officialPriceDraft } from './catalog.mjs'
import { normalizePriceDraft } from './price-drafts.mjs'
import { transactionPool } from './transaction.mjs'
import { MAX_CAPABILITY_SCOPES, MAX_PLATFORM_SCOPES, MAX_PROVISIONING_OPERATIONS } from '../../shared/access-limits.mjs'

const fail = (status, code, message) => { throw new AppError(status, code, message) }
const clone = value => structuredClone(value)
const fields = ['plans', 'consumerPlans', 'consumerPlanAssignmentEvents', 'grants', 'policies', 'capabilityGrants', 'capabilityPolicies', 'apiKeys', 'apiKeyPlatformEntitlements', 'apiKeyCapabilityEntitlements', 'apiKeyScopeEvents']
const memoryState = store => fields.map(key => [key, store[key]])
const fingerprint = value => digest(JSON.parse(JSON.stringify(value, (_key, item) => item instanceof Map ? [...item] : item instanceof Set ? [...item] : item)))
const uniq = values => [...new Set(values)].sort()
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

export class ProvisioningService {
  constructor({ service, control, runtime }) {
    this.service = service; this.store = service.store; this.control = control; this.runtime = runtime
    this.drafts = new Map(); this.batches = new Map(); this.references = []; this.applying = false
  }
  async catalog() {
    const providers = [...new Set(PROVISIONING_OPERATIONS.map(row => row.provider))]
    const views = await Promise.all(providers.map(async provider => {
      const runtime = await this.runtime(provider)
      return [provider, await this.control.describeProvider(provider, runtime)]
    }))
    return { version: PROVISIONING_CATALOG_VERSION, operations: PROVISIONING_OPERATIONS.map(row => ({ ...row,
      current: views.find(([provider]) => provider === row.provider)?.[1].find(op => op.operationKey === row.operation) })),
      officialDrafts: providers.map(officialPriceDraft) }
  }
  async listDrafts() {
    if (!this.store.pool) return clone([...this.drafts.values()].reverse())
    return (await this.store.pool.query('SELECT id, specification AS spec, specification_hash AS hash, created_at AS "createdAt" FROM control.procurement_price_drafts ORDER BY created_at DESC LIMIT 100')).rows
  }
  async draft(id, executor = this.store.pool) {
    if (!uuid(id)) fail(400, 'invalid_price_draft', '草稿 ID 无效')
    const row = executor ? (await executor.query('SELECT id, specification AS spec, specification_hash AS hash FROM control.procurement_price_drafts WHERE id=$1', [id])).rows[0] : this.drafts.get(id)
    if (!row) fail(404, 'price_draft_not_found', '价格草稿不存在')
    return clone(row)
  }
  async createDraft(input) {
    const spec = normalizePriceDraft(input)
    const row = { id: randomUUID(), spec, hash: digest(spec), createdAt: new Date().toISOString() }
    if (this.store.pool) await this.store.pool.query('INSERT INTO control.procurement_price_drafts(id,provider_key,specification,specification_hash,created_by) VALUES($1,$2,$3,$4,$5)', [row.id, spec.provider, spec, row.hash, 'admin-token'])
    else this.drafts.set(row.id, row)
    return clone(row)
  }
  normalize(input) {
    if (!input || Object.keys(input).some(key => !['keyId','operationIds','draftId','overrideProcurement','salePrices','currency','monthlyBudgetMinor','monthlySubsidyBudgetMinor','reason','acknowledgeRounding'].includes(key))) fail(400, 'invalid_provisioning', '批量配置字段无效')
    if (!uuid(input.keyId) || !Array.isArray(input.operationIds) || !input.operationIds.length || input.operationIds.length > MAX_PROVISIONING_OPERATIONS || input.operationIds.some(id => !provisioningOperation(id))) fail(400, 'invalid_provisioning', '请选择有效 Key 和已实现接口')
    const ids = uniq(input.operationIds)
    const overrides = input.overrideProcurement || []
    if (!Array.isArray(overrides) || overrides.some(id => !ids.includes(id))) fail(400, 'invalid_provisioning', '采购覆盖范围必须在所选接口内')
    if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 800) fail(400, 'invalid_provisioning', '请填写变更原因（1–800 字）')
    const salePrices = input.salePrices || {}
    if (typeof salePrices !== 'object' || Array.isArray(salePrices) || Object.entries(salePrices).some(([id, price]) => !ids.includes(id) || !Number.isSafeInteger(price) || price < 0)) fail(400, 'invalid_provisioning', '销售价须为所选接口的非负最小货币单位整数')
    for (const field of ['monthlyBudgetMinor','monthlySubsidyBudgetMinor']) if (input[field] != null && (!Number.isSafeInteger(input[field]) || input[field] < 0)) fail(400, 'invalid_provisioning', '采购预算须为非负最小货币单位整数')
    if (Object.keys(salePrices).length && !/^[A-Z]{3}$/.test(input.currency || '')) fail(400, 'invalid_provisioning', '请指定销售币种')
    return { keyId: input.keyId, operationIds: ids, draftId: input.draftId || null, overrideProcurement: uniq(overrides), salePrices,
      currency: input.currency || null, monthlyBudgetMinor: input.monthlyBudgetMinor ?? 0, monthlySubsidyBudgetMinor: input.monthlySubsidyBudgetMinor ?? 0,
      reason: input.reason.trim(), acknowledgeRounding: input.acknowledgeRounding === true }
  }
  async inspect(spec, service = this.service, control = this.control) {
    const store = service.store
    const key = (await store.listApiKeys()).find(row => row.id === spec.keyId)
    if (!key || key.status !== 'active' || !key.expiresAt || Date.parse(key.expiresAt) <= Date.now()) fail(409, 'api_key_unavailable', 'Key 已过期、撤销或不存在')
    if (key.scopeMode !== 'snapshot') fail(409, 'legacy_key_scope', '请先在 Key 管理中将动态授权 Key 转为明确范围，再批量开通')
    const consumer = await store.getConsumer(key.consumerId), tenant = await store.getTenant(key.tenantId)
    if (consumer?.status !== 'active' || tenant?.status !== 'active') fail(409, 'identity_inactive', '租户或调用者未启用')
    const [plan, billing, grants, capabilities, allKeys] = await Promise.all([store.getConsumerPlan(consumer.id), store.getTenantBilling(tenant.id, { ledgerLimit: 0 }), store.listGrants(consumer.id), store.listCapabilityGrants(consumer.id), store.listApiKeys(consumer.id)])
    if (!plan) fail(409, 'plan_assignment_missing', '调用者缺少套餐版本')
    const draft = spec.draftId ? await this.draft(spec.draftId, store.pool) : null
    const providers = uniq(spec.operationIds.map(id => provisioningOperation(id).provider))
    const runtimes = {}, views = {}
    for (const provider of providers) { runtimes[provider] = await this.runtime(provider); views[provider] = await control.describeProvider(provider, runtimes[provider]) }
    const rows = []
    for (const id of spec.operationIds) {
      const definition = provisioningOperation(id), current = views[definition.provider].find(row => row.operationKey === definition.operation)
      const blockers = []
      if (definition.blocked) blockers.push(definition.blocked)
      if (current.migrationRequired) blockers.push('migration_required')
      if (current.desiredState === 'paused' || current.desiredState === 'shadow') blockers.push('explicit_operation_review_required')
      const existing = current.priceBook.source === 'database' && current.priceBook.status === 'reviewed' && current.priceBook.ready
      const replacePrice = !existing || spec.overrideProcurement.includes(id)
      let priceBook = null, exactRates = []
      if (replacePrice) {
        exactRates = definition.endpointKeys.map(endpoint => draft?.spec.provider === definition.provider ? draft.spec.rates.find(rate => rate.endpointKey === endpoint) : null)
        if (exactRates.some(rate => !rate)) blockers.push('procurement_price_missing')
        else if (new Set(exactRates.map(rate => rate.currency)).size !== 1) blockers.push('operation_currency_mismatch')
        else {
          priceBook = { currency: exactRates[0].currency, pricingAsOf: draft.spec.observedAt,
            monthlyBudgetMinor: spec.monthlyBudgetMinor, monthlySubsidyBudgetMinor: spec.monthlySubsidyBudgetMinor,
            unitCostMinorByEndpoint: Object.fromEntries(exactRates.map(rate => [rate.endpointKey, rate.budgetMinor])) }
          try { normalizePriceBook(priceBook, definition) } catch { blockers.push('procurement_price_invalid') }
          if (exactRates.some(rate => rate.rounded) && !spec.acknowledgeRounding) blockers.push('rounding_acknowledgment_required')
        }
      }
      for (const blocker of current.blockers) if (!['deployment_gate_closed','price_control_incomplete','database_price_book_required','canary_allowlist_empty'].includes(blocker.code)) blockers.push(blocker.code)
      const nextState = current.desiredState === 'active' ? 'active' : 'canary'
      const nextCanary = nextState === 'canary' ? uniq([...current.canaryConsumerIds, consumer.id]) : current.canaryConsumerIds
      const oldSale = plan.priceBook?.entries.find(entry => entry.meterKey === definition.meterKey)
      const salePriceMinor = Object.hasOwn(spec.salePrices, id) ? spec.salePrices[id] : oldSale?.unitPriceMinor ?? null
      const effectivePrice = customerRequestPrice(Object.hasOwn(spec.salePrices, id) ? { ...plan.priceBook, defaultMultiplierPpm: plan.priceBook?.defaultMultiplierPpm ?? 1_000_000, currency: spec.currency, entries: [{ meterKey: definition.meterKey, unitPriceMinor: salePriceMinor }] } : plan.priceBook, billing.profile, definition.meterKey)
      rows.push({ ...definition, current, replacePrice, priceBook, exactRates, nextState, nextCanary, salePriceMinor, saleChanged: Object.hasOwn(spec.salePrices, id) && salePriceMinor !== oldSale?.unitPriceMinor,
        effectivePrice, platformPolicy: await store.getPolicy(consumer.id, definition.platform), capabilityPolicy: await store.getCapabilityPolicy(consumer.id, definition.capability), blockers: uniq(blockers) })
    }
    const changesPrice = rows.some(row => row.saleChanged)
    if (Object.keys(spec.salePrices).length && plan.priceBook && spec.currency !== plan.priceBook.currency) fail(409, 'plan_currency_mismatch', '新价格必须沿用当前套餐币种；批量开通不进行换汇')
    if (changesPrice && billing.account?.currency && spec.currency !== billing.account.currency) fail(409, 'wallet_currency_mismatch', '新套餐币种必须与租户钱包一致')
    const scopeOverflow = uniq([...key.platforms, ...rows.map(row => row.platform)]).length > MAX_PLATFORM_SCOPES || uniq([...key.capabilities, ...rows.map(row => row.capability)]).length > MAX_CAPABILITY_SCOPES
    if (scopeOverflow) for (const row of rows) row.blockers.push('key_scope_limit_exceeded')
    // Shared meters (e.g. social.accounts.search across providers) must agree.
    const meters = new Map()
    for (const row of rows.filter(row => Object.hasOwn(spec.salePrices, row.id))) {
      if (meters.has(row.meterKey) && meters.get(row.meterKey) !== row.salePriceMinor) fail(400, 'shared_meter_conflict', '同一计费项不能设置不同销售价')
      meters.set(row.meterKey, row.salePriceMinor)
    }
    return { catalogVersion: PROVISIONING_CATALOG_VERSION,
      key: { id: key.id, name: key.name, scopeMode: key.scopeMode, platforms: key.platforms, capabilities: key.capabilities, expiresAt: key.expiresAt },
      consumer, tenant: { id: tenant.id, name: tenant.name }, plan, profile: billing.profile, grants, capabilities, draftHash: draft?.hash || null,
      affectedKeys: allKeys.map(item => ({ id: item.id, name: item.name, status: item.status })), changesPrice, rows,
      canApply: rows.every(row => !row.blockers.length),
      notes: ['销售套餐属于调用者；改价影响该调用者的全部 Key。只有所选 Key 追加能力。', '租户倍率、钱包、旧账单和未选接口价格保持原值。', '已启用接口保留运行范围；新接口仅将目标调用者加入灰度名单。', '明确覆盖已有采购价格会影响所有使用该操作的调用者；客户销售价仍独立。', '采购预算使用最小货币单位向上取整的保守估值，原始精确价格另存为证据，不能视为供应商实账。'] }
  }
  async preview(input) {
    const spec = this.normalize(input), preview = await this.inspect(spec)
    const row = { id: randomUUID(), spec, preview, hash: digest(preview), status: 'preview', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), result: null }
    if (this.store.pool) await this.store.pool.query('INSERT INTO control.provisioning_batches(id,specification,preview,preview_hash,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [row.id, spec, preview, row.hash, 'admin-token', row.expiresAt])
    else this.batches.set(row.id, clone(row))
    return row
  }
  async batch(id, executor = this.store.pool, lock = false) {
    if (!uuid(id)) fail(400, 'invalid_provisioning', '批次 ID 无效')
    const row = executor ? (await executor.query(`SELECT id,specification AS spec,preview,preview_hash AS hash,status,result,expires_at AS "expiresAt" FROM control.provisioning_batches WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0] : this.batches.get(id)
    if (!row) fail(404, 'provisioning_not_found', '批次不存在')
    return clone(row)
  }
  async write(batch, service, control) {
    if (Date.parse(batch.expiresAt) <= Date.now()) fail(409, 'provisioning_expired', '预览已过期，请重新预览')
    const view = await this.inspect(batch.spec, service, control)
    if (digest(view) !== batch.hash) fail(409, 'provisioning_changed', '价格、授权、身份或运行配置已变化，请重新预览')
    if (!view.canApply) fail(409, 'provisioning_blocked', '请先处理预览中的阻塞项，或取消相应接口后重新预览')
    const applied = []
    for (const row of view.rows) {
      const next = await control.updatePolicy(row.provider, row.operation, { expectedRevision: row.current.revision, desiredState: row.nextState,
        canaryConsumerIds: row.nextCanary, ...(row.priceBook ? { priceBook: row.priceBook } : {}), reason: `批次 ${batch.id}: ${batch.spec.reason}` }, { runtime: await this.runtime(row.provider) })
      if (next.effectiveState === 'blocked') fail(409, 'provisioning_blocked', '运行条件发生变化，整批已撤销')
      if (row.replacePrice && service.store.pool) await service.store.pool.query('INSERT INTO control.procurement_price_references(provider_key,operation_key,price_book_version,draft_id,batch_id) VALUES($1,$2,$3,$4,$5)', [row.provider, row.operation, next.priceBook.version, batch.spec.draftId, batch.id])
      applied.push({ id: row.id, revision: next.revision, priceBookVersion: next.priceBook.version, draftId: row.replacePrice ? batch.spec.draftId : null })
    }
    if (view.changesPrice) {
      const entries = new Map((view.plan.priceBook?.entries || []).map(row => [row.meterKey, row]))
      for (const row of view.rows) if (Object.hasOwn(batch.spec.salePrices, row.id)) entries.set(row.meterKey, { meterKey: row.meterKey, billingUnit: 'request', unitPriceMinor: row.salePriceMinor })
      const key = `batch-${batch.id}`
      const published = await service.publishPlanVersion({ key, name: `批量开通 ${batch.id}`, limits: view.plan.limits, priceBook: { key, currency: batch.spec.currency,
        defaultMultiplierPpm: view.plan.priceBook?.defaultMultiplierPpm ?? 1_000_000, entries: [...entries.values()] } }, 'admin-token')
      await service.assignConsumerPlan(view.consumer.id, { planVersionId: published.versionId, expectedRevision: view.plan.revision }, 'admin-token')
    }
    for (const platform of uniq(view.rows.map(row => row.platform))) if (!view.grants.includes(platform)) await service.putPlatformConfiguration(platform, { tenantId: view.tenant.id, consumerId: view.consumer.id, enabled: true })
    for (const capability of uniq(view.rows.map(row => row.capability))) if (!view.capabilities.includes(capability)) await service.putCapabilityConfiguration(capability, { tenantId: view.tenant.id, consumerId: view.consumer.id, enabled: true })
    const platforms = uniq([...view.key.platforms, ...view.rows.map(row => row.platform)]), capabilities = uniq([...view.key.capabilities, ...view.rows.map(row => row.capability)])
    if (digest(platforms) !== digest([...view.key.platforms].sort()) || digest(capabilities) !== digest([...view.key.capabilities].sort())) await service.updateApiKeyScopes(view.key.id, { platforms, capabilities,
      expected: { scopeMode: view.key.scopeMode, platforms: view.key.platforms, capabilities: view.key.capabilities } }, 'admin-token')
    return { batchId: batch.id, status: 'completed', keyId: view.key.id, consumerId: view.consumer.id, applied, planChanged: view.changesPrice, completedAt: new Date().toISOString() }
  }
  async apply(id) {
    if (this.store.pool) {
      const client = await this.store.pool.connect()
      let commitStarted = false, releaseError = null
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
        const batch = await this.batch(id, client, true)
        if (batch.status === 'completed') { commitStarted = true; await client.query('COMMIT'); return batch.result }
        const pool = transactionPool(client), store = new PostgresStore(pool), control = new PostgresExternalPlatformControlStore({ pool })
        const service = new HubService({ store, adapter: this.service.adapter, apiKeyPepper: this.service.apiKeyPepper, defaultPolicy: this.service.defaultPolicy })
        const result = await this.write(batch, service, control)
        await client.query("UPDATE control.provisioning_batches SET status='completed',result=$2,applied_at=now() WHERE id=$1", [id, result])
        commitStarted = true
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(rollbackError => { releaseError = rollbackError })
        if (['40001','40P01'].includes(error.code)) fail(409, 'provisioning_changed', '并发配置发生变化，请重新预览')
        if (commitStarted) { releaseError = error; fail(503, 'provisioning_outcome_unknown', '提交结果尚未确认；请核对本批次结果，或使用同一批次 ID 重试') }
        throw error
      } finally { client.release(releaseError) }
    }
    if (this.applying) fail(409, 'provisioning_busy', '另一批次正在执行，请稍后读取批次结果')
    this.applying = true
    try {
      const batch = await this.batch(id)
      if (batch.status === 'completed') return batch.result
      const before = fingerprint([memoryState(this.store), this.control.rows, this.control.events])
      const store = new MemoryStore()
      // Real class instances retain private methods; copy metadata only. Wallets
      // and paid execution state are never committed by this transaction.
      for (const key of [...fields, 'tenants','consumers','billingProfiles']) store[key] = clone(this.store[key])
      const control = new MemoryExternalPlatformControlStore(); control.rows = clone(this.control.rows); control.events = clone(this.control.events)
      const service = new HubService({ store, adapter: this.service.adapter, apiKeyPepper: this.service.apiKeyPepper, defaultPolicy: this.service.defaultPolicy })
      const result = await this.write(batch, service, control)
      if (before !== fingerprint([memoryState(this.store), this.control.rows, this.control.events]) || digest(await this.inspect(batch.spec)) !== batch.hash) fail(409, 'provisioning_changed', '并发配置发生变化，请重新预览')
      for (const key of fields) this.store[key] = store[key]
      this.control.rows = control.rows; this.control.events = control.events
      this.references.push(...result.applied.filter(row => row.draftId).map(row => ({ ...row, batchId: id })))
      this.batches.set(id, { ...batch, status: 'completed', result })
      return result
    } finally { this.applying = false }
  }
}
