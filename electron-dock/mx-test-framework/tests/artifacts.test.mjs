import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, before } from 'node:test'
import { ArtifactStore } from '../server/artifacts.mjs'

let root
let store
let base
let server

const stream = (text) =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(text))
      controller.close()
    },
  })

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'mxt-art-'))
  store = new ArtifactStore({ root })

  // Range serving is exercised over a real HTTP server. A hand-rolled fake
  // response would prove the code runs, not that a browser can seek the file —
  // and seeking is the entire point of the step timeline.
  server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://x').pathname).slice(1)
    try {
      await store.serve('trun_3', path, request, response)
    } catch (error) {
      response.writeHead(error.status ?? 500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: error.code, hint: error.details?.hint }))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`

  await store.write('trun_3', 'clip.mp4', stream('abcdefghij'))
  await store.write('trun_3', 'report/index.html', stream('<script>steal()</script>'))
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  await rm(root, { recursive: true, force: true })
})

const get = (path, range) => fetch(`${base}/${path}`, { headers: range ? { range } : {} })

// -- writing -----------------------------------------------------------------

test('writes a nested artifact path and lists it back', async () => {
  const bytes = await store.write('trun_1', 'videos/smoke/auth.cy.ts.mp4', stream('fake-video'))
  assert.equal(bytes, 10)
  assert.deepEqual(await store.list('trun_1'), [
    { path: 'videos/smoke/auth.cy.ts.mp4', bytes: 10, contentType: 'video/mp4' },
  ])
})

test('refuses paths that escape the run directory', () => {
  for (const bad of ['../escape.txt', 'a/../../escape.txt', '/etc/passwd']) {
    assert.throws(
      () => store.resolveWithin('trun_1', bad),
      (error) => error.code === 'invalid_artifact_path',
      bad,
    )
  }
})

test('a path that merely looks suspicious but stays inside is allowed', () => {
  // `..` inside a filename is not traversal, and rejecting it would break real
  // spec names.
  assert.ok(store.resolveWithin('trun_1', 'videos/a..b/report.html'))
  assert.ok(store.resolveWithin('trun_1', 'videos/sub/../sibling.mp4'))
})

test('an oversized upload leaves no partial file behind', async () => {
  await assert.rejects(
    store.write('trun_2', 'big.bin', stream('0123456789'), { limitBytes: 4 }),
    (error) => error.code === 'artifact_too_large',
  )
  // A truncated file would later be served as if it were complete.
  assert.deepEqual(await store.list('trun_2'), [])
})

test('infers the content types that matter for playback and reports', () => {
  assert.equal(store.contentType('a/b.mp4'), 'video/mp4')
  assert.equal(store.contentType('a/b.webm'), 'video/webm')
  assert.equal(store.contentType('a/b.png'), 'image/png')
  assert.equal(store.contentType('a/index.html'), 'text/html; charset=utf-8')
  assert.equal(store.contentType('a/unknown.xyz'), 'application/octet-stream')
})

// -- serving -----------------------------------------------------------------

test('serves a whole file and advertises range support', async () => {
  const response = await get('clip.mp4')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('accept-ranges'), 'bytes')
  assert.equal(response.headers.get('content-type'), 'video/mp4')
  assert.equal(await response.text(), 'abcdefghij')
})

test('serves a byte range so a browser can seek', async () => {
  const response = await get('clip.mp4', 'bytes=2-5')
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-range'), 'bytes 2-5/10')
  assert.equal(response.headers.get('content-length'), '4')
  assert.equal(await response.text(), 'cdef')
})

test('serves an open-ended range', async () => {
  const response = await get('clip.mp4', 'bytes=7-')
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-range'), 'bytes 7-9/10')
  assert.equal(await response.text(), 'hij')
})

test('serves a suffix range', async () => {
  const response = await get('clip.mp4', 'bytes=-3')
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-range'), 'bytes 7-9/10')
  assert.equal(await response.text(), 'hij')
})

test('clamps a range running past the end instead of erroring', async () => {
  const response = await get('clip.mp4', 'bytes=5-999')
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-range'), 'bytes 5-9/10')
  assert.equal(await response.text(), 'fghij')
})

test('uploaded HTML cannot become stored XSS against the platform session', async () => {
  const response = await get('report/index.html')
  assert.match(response.headers.get('content-security-policy'), /sandbox/)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
})

test('a missing artifact explains that it may have expired', async () => {
  const response = await get('nope.mp4')
  assert.equal(response.status, 404)
  const body = await response.json()
  assert.equal(body.code, 'artifact_not_found')
  assert.match(body.hint, /过期/)
})

// -- retention ---------------------------------------------------------------

test('purge removes old run directories and leaves recent ones', async () => {
  const stale = join(root, 'runs', 'trun_old')
  await mkdir(stale, { recursive: true })
  await writeFile(join(stale, 'a.txt'), 'x')
  const old = new Date(Date.now() - 40 * 86_400_000)
  await utimes(stale, old, old)

  const purged = await store.purgeOlderThan(30)
  assert.ok(purged.includes('trun_old'), JSON.stringify(purged))
  assert.ok(!purged.includes('trun_3'), '近期产物不应被清理')
})
