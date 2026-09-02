import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

async function frontendSources() {
  return Promise.all([
    readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/api.js', import.meta.url), 'utf8'),
    readFile(new URL('../../src/pages-data.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/pages-database-connections.jsx', import.meta.url), 'utf8'),
  ])
}

test('data-cleaning navigation keeps both admin-token-only routes under one parent', async () => {
  const [appSource] = await frontendSources()
  const databaseRoute = appSource.match(/\{ path: '\/database-connections',[^\n]+\}/u)?.[0] || ''
  const plansRoute = appSource.match(/\{ path: '\/sources',[^\n]+\}/u)?.[0] || ''

  assert.match(appSource, /const DATA_CLEANING_NAV_KEY = 'data-cleaning'/u)
  assert.match(appSource, /label: '数据清洗中心'/u)
  for (const route of [databaseRoute, plansRoute]) {
    assert.match(route, /navParent: DATA_CLEANING_NAV_KEY/u)
    assert.match(route, /platformAdmin: true/u)
    assert.match(route, /adminTokenOnly: true/u)
  }
  assert.match(plansRoute, /label: '清洗任务计划'/u)
})

test('database connection UI uses the shared dropdown and the safe flat DTO', async () => {
  const [, apiSource, , pageSource] = await frontendSources()

  assert.doesNotMatch(pageSource, /<select\b/iu)
  assert.match(pageSource, /<DropdownField label="SSL 模式"/u)
  assert.match(pageSource, /passwordConfigured/u)
  assert.match(pageSource, /留空保留当前密码/u)
  assert.match(pageSource, /connection\.references/u)
  assert.match(apiSource, /databaseConnections: \(token\).*\/database-connections/u)
  assert.match(apiSource, /updateDatabaseConnection:[\s\S]*?method: 'PUT'/u)
  assert.match(apiSource, /deleteDatabaseConnection:[\s\S]*?method: 'DELETE'/u)
  assert.match(apiSource, /testDatabaseConnection:[\s\S]*?\/test`[\s\S]*?method: 'POST'/u)
})

test('mobile-commerce task plan exposes the fixed stored-only contract and guarded controls', async () => {
  const [, apiSource, pageSource] = await frontendSources()

  for (const evidence of [
    'mobile-commerce-collected-items',
    'public.mb_collected_items',
    'mobile-commerce.collected-items.v1',
    'commerce_capture',
    '(collected_at, id)',
    'GET /api/v1/data/mobile-commerce/items',
    'stored-only',
    'Hub 只负责异步触发并读取其结果，不在本机抓取',
  ]) assert.match(pageSource, new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))

  const fields = pageSource.match(/const MOBILE_COMMERCE_FIELDS = \[([\s\S]*?)\n\]/u)?.[1] || ''
  assert.equal([...fields.matchAll(/^\s*'[^']+',?$/gmu)].length, 25)
  assert.match(pageSource, /updateMobileCommercePipelineStatus/u)
  assert.match(pageSource, /confirmed: true/u)
  assert.match(pageSource, /writerContractConfirmed/u)
  assert.match(pageSource, /unknown \/ unmapped/u)
  assert.match(pageSource, /Canonical 入库 → 异步检索投影 → Elasticsearch 搜索/u)
  assert.match(pageSource, /stored-only · 当前从数据库表增量清洗；远端主动获取未接入，不影响数据库清洗模式/u)
  assert.match(pageSource, /actionError\?\.details\?\.issues/u)
  assert.match(pageSource, /<ErrorState error=\{actionError\}/u)
  assert.match(pageSource, /pipeline\.activationWarnings/u)
  assert.match(pageSource, /以下兼容性警告不阻止数据库表清洗/u)
  assert.doesNotMatch(pageSource, /远端刷新（接口未接入）/u)
  assert.match(pageSource, /confirmPipelineKey: resetConfirmation/u)
  assert.match(pageSource, /<DatabaseConnectionField/u)
  assert.match(apiSource, /pipelines\/mobile-commerce\/status/u)
  assert.match(apiSource, /writerContractAttestation/u)
  assert.match(apiSource, /pipelines\/mobile-commerce\/checkpoint\/reset/u)
})

test('every scheduled cleaning plan saves its runtime interval independently from connection changes', async () => {
  const [, , pageSource] = await frontendSources()
  const section = (start, end) => {
    const from = pageSource.indexOf(start)
    const to = pageSource.indexOf(end)
    assert.notEqual(from, -1, start)
    assert.notEqual(to, -1, end)
    return pageSource.slice(from, to)
  }

  assert.equal([...pageSource.matchAll(/<RuntimeSyncIntervalControl\b/gu)].length, 5)
  assert.match(pageSource, /const SYNC_INTERVAL_APPLY_MESSAGE = '当前批次不变，下一次调度检查按新间隔重新计算'/u)
  assert.match(pageSource, /'保存同步间隔'/u)

  for (const call of [
    /updateMobileCommercePipeline\(token, \{\s*syncIntervalSeconds: Number\(form\.syncIntervalSeconds\)/u,
    /updateProvinceOpinionPipeline\(token, \{\s*syncIntervalSeconds: Number\(form\.syncIntervalSeconds\)/u,
    /updateTelegramSqlitePipeline\(token, \{\s*syncIntervalSeconds: Number\(form\.syncIntervalSeconds\)/u,
    /updateTelegramMonitorPipeline\(token, \{\s*syncIntervalSeconds: Number\(form\.syncIntervalSeconds\)/u,
    /updateSource\(token, source\.sourceKey, \{ syncIntervalSeconds \}\)/u,
  ]) assert.match(pageSource, call)

  for (const [start, end] of [
    ['function MobileCommercePipelineModal', 'function ProvinceOpinionPipelineModal'],
    ['function ProvinceOpinionPipelineModal', 'function TelegramSqlitePipelineModal'],
    ['function TelegramSqlitePipelineModal', 'function TelegramSqliteTaskCard'],
    ['function TelegramPipelineModal', 'function TelegramTaskCard'],
  ]) {
    const connectionSave = section(start, end).match(
      /const save = \(event\) => \{[\s\S]*?\n  \}\n\n  const saveSyncInterval/u,
    )?.[0] || ''
    assert.notEqual(connectionSave, '', start)
    assert.doesNotMatch(connectionSave, /syncIntervalSeconds:/u, start)
  }

  const genericSubmit = section('function DatabaseSourceControl', 'function PipelineRunHistory').match(
    /const submit = \(event\) => \{[\s\S]*?\n  \}\n\n  const saveSchedule/u,
  )?.[0] || ''
  assert.notEqual(genericSubmit, '')
  assert.doesNotMatch(genericSubmit, /syncIntervalSeconds:/u)
  assert.match(pageSource, /onSave=\{saveSyncInterval\} busy=\{Boolean\(busyAction\)\}/u)
  assert.match(pageSource, /onSave=\{saveSchedule\} busy=\{busy\}/u)
})
