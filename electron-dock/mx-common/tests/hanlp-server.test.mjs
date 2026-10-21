import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { batchingSegmenter, HanlpSegmenter, interactiveSegmenter } from '../src/segmenter/index.mjs'

const run = promisify(execFile)

test('the HanLP service pool, priority lane and HTTP contract hold against a stub tokenizer', async () => {
  // Pool sizing, admission order, the interactive reserve, disconnect skipping
  // and the wire contract live in Python next to the server they test; see
  // hanlp_server_test.py. -I keeps the host's site-packages and PYTHON* settings
  // out of it; the end-to-end cases build their own server environment.
  const script = fileURLToPath(new URL('./hanlp_server_test.py', import.meta.url))
  try {
    await run('python3', ['-I', '-B', script], { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 })
  } catch (error) {
    assert.fail(`hanlp_server_test.py failed:\n${error.stderr || error.message}`)
  }
})

function recordingHanlp() {
  const priorities = []
  const hanlp = new HanlpSegmenter({
    url: 'http://hanlp:8000',
    fetchImpl: async (_url, { headers, body }) => {
      priorities.push(headers['x-mx-segment-priority'] ?? null)
      const { texts } = JSON.parse(body)
      return new Response(JSON.stringify({ batch: texts.map((text) => [text]) }), { status: 200 })
    },
    logger: { warn() {} },
  })
  return { hanlp, priorities }
}

test('only request-path segmentation asks HanLP for the interactive lane', async () => {
  const { hanlp, priorities } = recordingHanlp()

  // Bulk writers -- direct batches and the projector's coalescing wrapper --
  // send no label, which the service reads as bulk.
  await hanlp.segmentBatchWithMeta(['重建'], { allowFallback: false })
  await batchingSegmenter(hanlp).segmentWithMeta('投影')
  const [query] = await Promise.all([interactiveSegmenter(hanlp).segmentWithMeta('查询')])
  await hanlp.segmentBatchWithMeta(['显式'], { priority: 'interactive' })
  await hanlp.segmentBatchWithMeta(['未知'], { priority: 'urgent' })

  assert.deepEqual(priorities, [null, null, 'interactive', 'interactive', null])
  // The label changes admission only, never provenance.
  assert.deepEqual(query.tokens, ['查询'])
  assert.equal(query.backendUsed, 'hanlp')
  assert.equal(query.degraded, false)
})
