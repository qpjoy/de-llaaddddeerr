import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { classifyExternalPlatformIngest } from '../../server/workers/ingest.mjs'
import { NIGHT_ALL_COMPAT_DATASET_ID } from '../../server/ingest/legacy-night-all.mjs'
import { TIKHUB_XIAOHONGSHU_DATASET_ID } from '../../server/ingest/tikhub-xiaohongshu.mjs'

const job = (providerKey, platform, datasetId, extra = {}) => ({
  kind: 'external-platform-result', providerKey, platform, datasetId, records: [], ...extra,
})

test('ingest worker accepts Twitter standard and compatibility search under RapidAPI only', () => {
  for (const datasetId of ['night-all.search.v1', NIGHT_ALL_COMPAT_DATASET_ID]) {
    const payload = job('rapidapi', 'twitter', datasetId)
    assert.deepEqual(classifyExternalPlatformIngest(payload), {
      enterprise: false, justOne: false, tikHubXiaohongshu: false, hubRaw: true,
    })
    for (const providerKey of ['tikhub', 'justone', 'night-all', 'qixin', '']) {
      assert.throws(() => classifyExternalPlatformIngest({ ...payload, providerKey }), /pinned contract/)
    }
    for (const platform of ['facebook', 'weibo', 'instagram', 'xiaohongshu', 'x', '']) {
      assert.throws(() => classifyExternalPlatformIngest({ ...payload, platform }), /pinned contract/)
    }
    for (const records of [undefined, null, {}, '[]']) {
      assert.throws(() => classifyExternalPlatformIngest({ ...payload, records }), /pinned contract/)
    }
  }
  for (const datasetId of ['social.data.v1', 'ecommerce.products.v1', 'night-all.search.v2', '']) {
    assert.throws(() => classifyExternalPlatformIngest(job('rapidapi', 'twitter', datasetId)), /pinned contract/)
  }
  assert.throws(() => classifyExternalPlatformIngest(null), /pinned contract/)
  assert.throws(() => classifyExternalPlatformIngest(job('rapidapi', 'twitter', 'night-all.search.v1', {
    kind: 'search-result',
  })), /pinned contract/)
})

test('Twitter standard ingestion keeps every previously allowed provider/platform/dataset tuple', () => {
  const expected = [
    [job('qixin', 'enterprise', 'enterprise.responses.v1'), 'enterprise'],
    [job('justone', 'ecommerce', 'ecommerce.products.v1'), 'justOne'],
    ...[TIKHUB_XIAOHONGSHU_DATASET_ID, NIGHT_ALL_COMPAT_DATASET_ID, 'social.comments.v1']
      .map(datasetId => [job('tikhub', 'xiaohongshu', datasetId), 'tikHubXiaohongshu']),
    ...['weibo', 'instagram'].flatMap(platform => ['night-all.search.v1', NIGHT_ALL_COMPAT_DATASET_ID]
      .map(datasetId => [job('tikhub', platform, datasetId), 'hubRaw'])),
  ]
  for (const [payload, classification] of expected) {
    const result = classifyExternalPlatformIngest(payload)
    assert.equal(result[classification], true, JSON.stringify(payload))
    assert.equal(Object.values(result).filter(Boolean).length, 1)
    assert.throws(() => classifyExternalPlatformIngest({ ...payload, records: {} }), /pinned contract/)
  }
})

test('Instagram JustOne search ingestion accepts only its standard/raw datasets and retains old queued TikHub jobs', () => {
  for (const datasetId of ['night-all.search.v1', NIGHT_ALL_COMPAT_DATASET_ID]) {
    for (const providerKey of ['justone', 'tikhub']) assert.deepEqual(classifyExternalPlatformIngest(job(providerKey, 'instagram', datasetId)), {
      enterprise: false, justOne: false, tikHubXiaohongshu: false, hubRaw: true,
    })
    for (const platform of ['twitter', 'weibo', 'facebook']) {
      assert.throws(() => classifyExternalPlatformIngest(job('justone', platform, datasetId)), /pinned contract/)
    }
  }
  for (const datasetId of ['social.data.v1', 'ecommerce.products.v1', '']) {
    assert.throws(() => classifyExternalPlatformIngest(job('justone', 'instagram', datasetId)), /pinned contract/)
  }
})

test('ingest worker direct entry still refuses the memory driver without starting services', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../server/workers/ingest.mjs', import.meta.url))], {
    env: {
      PATH: process.env.PATH, MX_INSIGHT_STORE: 'memory',
      MX_INSIGHT_ADMIN_TOKEN: 'local-ingest-test',
      MX_INSIGHT_API_KEY_PEPPER: 'local-ingest-test-pepper-at-least-32-bytes',
    },
    encoding: 'utf8', timeout: 10000,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, /requires MX_INSIGHT_STORE=postgres; refusing to start/)
})
