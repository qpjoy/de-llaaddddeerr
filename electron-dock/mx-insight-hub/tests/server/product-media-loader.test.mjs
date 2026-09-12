import assert from 'node:assert/strict'
import test from 'node:test'
import { createProductMediaLoader } from '../../src/product-media-loader.js'

test('product media loader caps a page of requests at three concurrent relays', async () => {
  const loader = createProductMediaLoader({ maxConcurrency: 3, backoffMs: [] })
  let active = 0
  let observed = 0
  const releases = []
  const tasks = Array.from({ length: 9 }, (_, index) => loader.load(async () => {
    active += 1
    observed = Math.max(observed, active)
    await new Promise((resolve) => releases.push(resolve))
    active -= 1
    return index
  }))

  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(loader.stats().active, 3)
  assert.equal(loader.stats().queued, 6)
  while (releases.length > 0 || loader.stats().queued > 0 || loader.stats().active > 0) {
    releases.splice(0).forEach((release) => release())
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(observed, 3)
})

test('default product media loader can start a whole nine-image page concurrently', async () => {
  const loader = createProductMediaLoader({ backoffMs: [] })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const tasks = Array.from({ length: 9 }, () => loader.load(() => gate))

  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(loader.stats(), { active: 9, queued: 0, maxConcurrency: 12 })
  release('image')
  assert.deepEqual(await Promise.all(tasks), Array(9).fill('image'))
})

test('product media loader retries only the server busy signal', async () => {
  const loader = createProductMediaLoader({ maxConcurrency: 1, backoffMs: [1, 1] })
  let calls = 0
  const value = await loader.load(async () => {
    calls += 1
    if (calls < 3) throw Object.assign(new Error('busy'), { status: 429, code: 'external_media_busy' })
    return 'image'
  })
  assert.equal(value, 'image')
  assert.equal(calls, 3)

  for (const failure of [
    { status: 429, code: 'external_media_rate_limited' },
    { status: 502, code: 'external_media_source_throttled' },
    { status: 502, code: 'external_media_unavailable' },
    { status: 401, code: 'invalid_api_key' },
  ]) {
    let attempts = 0
    await assert.rejects(loader.load(async () => {
      attempts += 1
      throw Object.assign(new Error(failure.code), failure)
    }))
    assert.equal(attempts, 1)
  }
})

test('aborting a queued media request removes it without blocking later work', async () => {
  const loader = createProductMediaLoader({ maxConcurrency: 1, backoffMs: [] })
  let release
  const first = loader.load(() => new Promise((resolve) => { release = resolve }))
  const controller = new AbortController()
  let cancelledCalls = 0
  const cancelled = loader.load(async () => { cancelledCalls += 1 }, { signal: controller.signal })
  const last = loader.load(async () => 'last')
  controller.abort()
  await assert.rejects(cancelled, (error) => error?.name === 'AbortError')
  assert.equal(cancelledCalls, 0)
  release('first')
  assert.equal(await first, 'first')
  assert.equal(await last, 'last')
  assert.deepEqual(loader.stats(), { active: 0, queued: 0, maxConcurrency: 1 })
})

test('pending durable media waits and retries without treating it as missing', async () => {
  const loader = createProductMediaLoader({ pendingBackoffMs: [1, 1] })
  let attempts = 0
  const result = await loader.load(async () => {
    if (++attempts < 3) throw Object.assign(new Error('queued'), { status: 503, code: 'external_media_pending' })
    return 'stored-image'
  })
  assert.equal(result, 'stored-image')
  assert.equal(attempts, 3)
})
