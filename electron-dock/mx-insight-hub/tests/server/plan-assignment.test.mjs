import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const ADMIN_TOKEN = 'plan-assignment-admin-token'
const PEPPER = 'plan-assignment-test-pepper-at-least-32-bytes'
const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url))

function addPublishedPlan(store, overrides = {}) {
  const plan = {
    id: randomUUID(),
    key: `plan-${randomUUID()}`,
    name: 'Customer plan',
    status: 'active',
    versionId: randomUUID(),
    version: 1,
    versionStatus: 'published',
    limits: { monthlyRequests: 70_000, maxPageSize: 50, burstRps: 25 },
    pricing: { currency: 'CNY', mode: 'operator_price_book' },
    publishedAt: new Date().toISOString(),
    ...overrides,
  }
  store.plans.push(plan)
  return plan
}

async function fixture() {
  const store = new MemoryStore()
  const service = new HubService({ store, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Plan tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Plan consumer' })
  return { store, service, tenant, consumer }
}

test('MemoryStore plan assignment is revisioned, audited, CAS-safe, and idempotent for the same target', async () => {
  const { store, service, consumer } = await fixture()
  const initial = await service.getConsumerPlan(consumer.id)
  assert.deepEqual(initial.limits, {
    monthlyRequests: 1_000_000,
    maxPageSize: 100,
    burstRps: 100,
  })
  assert.equal(initial.revision, 1)
  assert.equal(initial.assignedBy, 'database-default')

  const eventCount = store.consumerPlanAssignmentEvents.length
  const noOp = await service.assignConsumerPlan(consumer.id, {
    planVersionId: initial.versionId,
    expectedRevision: initial.revision,
  }, 'member-no-op')
  assert.equal(noOp.revision, initial.revision)
  assert.equal(noOp.assignedAt, initial.assignedAt)
  assert.equal(noOp.assignedBy, initial.assignedBy)
  assert.equal(store.consumerPlanAssignmentEvents.length, eventCount)

  const target = addPublishedPlan(store)
  const assigned = await service.assignConsumerPlan(consumer.id, {
    planVersionId: target.versionId,
    expectedRevision: initial.revision,
  }, 'member-plan-admin')
  assert.equal(assigned.versionId, target.versionId)
  assert.equal(assigned.revision, 2)
  assert.equal(assigned.assignedBy, 'member-plan-admin')
  assert.equal(store.consumerPlanAssignmentEvents.length, eventCount + 1)
  assert.deepEqual(store.consumerPlanAssignmentEvents.at(-1), {
    consumerId: consumer.id,
    previousPlanVersionId: initial.versionId,
    planVersionId: target.versionId,
    assignedBy: 'member-plan-admin',
    assignedAt: assigned.assignedAt,
    previousRevision: 1,
    revision: 2,
    recordedAt: assigned.assignedAt,
  })

  await assert.rejects(
    () => service.assignConsumerPlan(consumer.id, {
      planVersionId: initial.versionId,
      expectedRevision: 1,
    }, 'stale-member'),
    (error) => error?.status === 409
      && error?.code === 'plan_assignment_revision_conflict'
      && error?.details?.currentRevision === 2,
  )

  const draft = addPublishedPlan(store, { versionStatus: 'draft' })
  await assert.rejects(
    () => service.assignConsumerPlan(consumer.id, {
      planVersionId: draft.versionId,
      expectedRevision: 2,
    }, 'member-plan-admin'),
    (error) => error?.status === 409 && error?.code === 'plan_version_not_assignable',
  )
})

test('legacy unmetered plan is grandfather-only while an existing binding remains idempotent', async () => {
  const { store, service, consumer } = await fixture()
  const current = await service.getConsumerPlan(consumer.id)
  const legacy = addPublishedPlan(store, {
    key: 'legacy-unmetered',
    name: 'Legacy (unchanged)',
    limits: {},
    pricing: { mode: 'grandfathered' },
  })
  const eventCount = store.consumerPlanAssignmentEvents.length

  await assert.rejects(
    () => service.assignConsumerPlan(consumer.id, {
      planVersionId: legacy.versionId,
      expectedRevision: current.revision,
    }, 'member-plan-admin'),
    (error) => error?.status === 409 && error?.code === 'plan_version_grandfather_only',
  )
  assert.equal((await service.getConsumerPlan(consumer.id)).versionId, current.versionId)
  assert.equal(store.consumerPlanAssignmentEvents.length, eventCount)

  const assignedAt = new Date().toISOString()
  store.consumerPlans.set(consumer.id, {
    versionId: legacy.versionId,
    assignedBy: 'migration-054',
    assignedAt,
    revision: 9,
  })
  const noOp = await service.assignConsumerPlan(consumer.id, {
    planVersionId: legacy.versionId,
    expectedRevision: 9,
  }, 'member-plan-admin')
  assert.equal(noOp.revision, 9)
  assert.equal(noOp.assignedAt, assignedAt)
  assert.equal(noOp.assignedBy, 'migration-054')
  assert.equal(store.consumerPlanAssignmentEvents.length, eventCount)
})

test('HubService strictly validates the plan assignment body', async () => {
  const { service, consumer } = await fixture()
  const current = await service.getConsumerPlan(consumer.id)
  const invalidBodies = [
    null,
    [],
    {},
    { planVersionId: current.versionId },
    { planVersionId: current.versionId, expectedRevision: '1' },
    { planVersionId: current.versionId, expectedRevision: 0 },
    { planVersionId: current.versionId, expectedRevision: 2_147_483_648 },
    { planVersionId: 'not-a-uuid', expectedRevision: 1 },
  ]
  for (const body of invalidBodies) {
    await assert.rejects(
      () => service.assignConsumerPlan(consumer.id, body, 'member-plan-admin'),
      (error) => error?.status === 400 && error?.code === 'invalid_request',
    )
  }
  await assert.rejects(
    () => service.assignConsumerPlan(consumer.id, {
      planVersionId: current.versionId,
      expectedRevision: 1,
      assignedBy: 'caller-controlled',
    }, 'member-plan-admin'),
    (error) => error?.status === 400 && error?.code === 'unsupported_fields',
  )
})

test('plan assignment HTTP route is platform-admin-only and derives the audit actor from the principal', async (t) => {
  const { store, service, consumer } = await fixture()
  const target = addPublishedPlan(store)
  const identity = {
    enabled: true,
    async resolve(token) {
      if (token === 'launcher-platform-admin') {
        return {
          kind: 'launcher-user',
          memberId: 'member-platform-admin',
          displayName: 'Platform admin',
          platformAdmin: true,
          tenantIds: null,
          capabilities: [],
          memberships: [],
        }
      }
      if (token === 'launcher-scoped-user') {
        return {
          kind: 'launcher-user',
          memberId: 'member-scoped-user',
          displayName: 'Scoped user',
          platformAdmin: false,
          tenantIds: [],
          capabilities: [],
          memberships: [],
        }
      }
      return null
    },
  }
  const app = createApp({
    service,
    store,
    adapter: {},
    identity,
    adminToken: ADMIN_TOKEN,
    logger: { error() {} },
  })
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const call = async (token, body) => {
    const response = await fetch(`${baseUrl}/internal/v1/admin/consumers/${consumer.id}/plan`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    return { response, payload: await response.json() }
  }

  const denied = await call('launcher-scoped-user', {
    planVersionId: target.versionId,
    expectedRevision: 1,
  })
  assert.equal(denied.response.status, 403)
  assert.equal(denied.payload.error.code, 'platform_admin_required')
  assert.equal((await service.getConsumerPlan(consumer.id)).revision, 1)

  const granted = await call('launcher-platform-admin', {
    planVersionId: target.versionId,
    expectedRevision: 1,
  })
  assert.equal(granted.response.status, 200)
  assert.equal(granted.payload.data.revision, 2)
  assert.equal(granted.payload.data.assignedBy, 'member-platform-admin')

  const eventCount = store.consumerPlanAssignmentEvents.length
  const noOp = await call('launcher-platform-admin', {
    planVersionId: target.versionId,
    expectedRevision: 2,
  })
  assert.equal(noOp.response.status, 200)
  assert.equal(noOp.payload.data.revision, 2)
  assert.equal(store.consumerPlanAssignmentEvents.length, eventCount)

  const legacy = addPublishedPlan(store, {
    key: 'legacy-unmetered',
    name: 'Legacy (unchanged)',
    limits: {},
    pricing: { mode: 'grandfathered' },
  })
  const grandfathered = await call('launcher-platform-admin', {
    planVersionId: legacy.versionId,
    expectedRevision: 2,
  })
  assert.equal(grandfathered.response.status, 409)
  assert.equal(grandfathered.payload.error.code, 'plan_version_grandfather_only')
  assert.equal((await service.getConsumerPlan(consumer.id)).revision, 2)
  assert.equal(store.consumerPlanAssignmentEvents.length, eventCount)

  const stale = await call('launcher-platform-admin', {
    planVersionId: store.plans[0].versionId,
    expectedRevision: 1,
  })
  assert.equal(stale.response.status, 409)
  assert.equal(stale.payload.error.code, 'plan_assignment_revision_conflict')

  const actorInjection = await call('launcher-platform-admin', {
    planVersionId: store.plans[0].versionId,
    expectedRevision: 2,
    assignedBy: 'caller-controlled',
  })
  assert.equal(actorInjection.response.status, 400)
  assert.equal(actorInjection.payload.error.code, 'unsupported_fields')
})

test('Plans UI exposes assignment controls only behind platformAdmin', async () => {
  const [apiSource, pagesSource] = await Promise.all([
    readFile(new URL('../../src/api.js', import.meta.url), 'utf8'),
    readFile(new URL('../../src/pages.jsx', import.meta.url), 'utf8'),
  ])
  assert.match(apiSource, /assignConsumerPlan:[\s\S]*method: 'PUT'/u)
  assert.match(pagesSource, /session\?\.platformAdmin \? <th>操作<\/th> : null/u)
  assert.match(pagesSource, /adminApi\.assignConsumerPlan[\s\S]*expectedRevision: currentPlan\.revision/u)
  assert.match(pagesSource, /plan\.versionId === currentPlan\?\.versionId[\s\S]*'已分配'/u)
  assert.match(pagesSource, /plan\.key === 'legacy-unmetered'/u)
  assert.match(pagesSource, /仅保留现有绑定/u)
})

test('Xiaohongshu bootstrap reconciles the requested plan before minting and blocks mint on failure', async (t) => {
  const tenantId = randomUUID()
  const consumerId = randomUUID()
  const legacyVersionId = randomUUID()
  const launchVersionId = randomUUID()
  const calls = []
  let rejectPlan = false
  const mock = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
    calls.push({ method: request.method, url: request.url, body })
    let status = 200
    let data
    if (request.method === 'GET' && request.url === '/internal/v1/admin/tenants') {
      data = [{ id: tenantId, name: 'bootstrap' }]
    } else if (request.method === 'GET' && request.url === `/internal/v1/admin/consumers?tenantId=${tenantId}`) {
      data = [{ id: consumerId, tenantId, name: 'bootstrap' }]
    } else if (request.method === 'GET' && request.url === `/internal/v1/admin/plans?consumerId=${consumerId}`) {
      data = {
        currentPlan: { key: 'legacy-unmetered', versionId: legacyVersionId, revision: 7 },
        catalog: [{
          key: 'launch-1m',
          name: 'Launch 1M',
          status: 'active',
          versionId: launchVersionId,
          version: 1,
          versionStatus: 'published',
        }],
      }
    } else if (request.method === 'PUT' && request.url === `/internal/v1/admin/consumers/${consumerId}/plan`) {
      assert.deepEqual(body, { planVersionId: launchVersionId, expectedRevision: 7 })
      if (rejectPlan) {
        status = 409
        data = undefined
      } else {
        data = { versionId: launchVersionId, revision: 8 }
      }
    } else if (request.method === 'PUT' && request.url?.startsWith('/internal/v1/admin/platforms/')) {
      data = {}
    } else if (request.method === 'PUT' && request.url?.startsWith('/internal/v1/admin/capabilities/')) {
      data = {}
    } else if (request.method === 'POST' && request.url === '/internal/v1/admin/api-keys') {
      data = { secret: 'mih_live_bootstrap-secret' }
    } else {
      status = 404
    }
    const payload = status === 200
      ? { data }
      : { error: { code: 'plan_assignment_revision_conflict', message: 'stale assignment' } }
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(payload))
  })
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => mock.close(resolve)))
  const baseUrl = `http://127.0.0.1:${mock.address().port}`
  const runProvision = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/provision.mjs'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        MX_INSIGHT_ADMIN_BASE_URL: baseUrl,
        MX_INSIGHT_ADMIN_TOKEN: ADMIN_TOKEN,
        MX_INSIGHT_BOOTSTRAP_NAME: 'bootstrap',
        MX_INSIGHT_BOOTSTRAP_PLATFORMS: 'xiaohongshu',
        MX_INSIGHT_BOOTSTRAP_PLAN_KEY: 'launch-1m',
        MX_INSIGHT_BOOTSTRAP_CAPABILITIES: 'nlp.tokenize',
        NIGHT_ALL_BASE_URL: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })

  const success = await runProvision()
  assert.equal(success.code, 0, success.stderr)
  const planIndex = calls.findIndex((call) => call.url === `/internal/v1/admin/consumers/${consumerId}/plan`)
  const keyIndex = calls.findIndex((call) => call.url === '/internal/v1/admin/api-keys')
  assert.ok(planIndex >= 0 && keyIndex > planIndex)
  assert.match(success.stderr, /bootstrap plan assigned: launch-1m v1/u)

  const beforeFailure = calls.length
  rejectPlan = true
  const failed = await runProvision()
  assert.notEqual(failed.code, 0)
  assert.match(failed.stderr, /PUT \/internal\/v1\/admin\/consumers\//u)
  assert.equal(
    calls.slice(beforeFailure).some((call) => call.url === '/internal/v1/admin/api-keys'),
    false,
  )
})
