import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../apps/server/index.mjs'
import { TourVideos, tourVideoRoutes } from '../apps/server/tour-videos.mjs'
import { requireRole } from '../packages/test-platform/server/identity/index.mjs'

// docs/24 M8c: each tour's recording, published at release and shown in
// 新手引导. Only catalogue tours, only WebM, only the latest, only by an admin.

const webm = (size, fill = 1) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(size - 4, fill)])
const body = (video, overrides = {}) => ({
  version: '0.8.0',
  recordedAt: '2026-10-08T08:00:00.000Z',
  durationMs: 42_000,
  video: video.toString('base64'),
  ...overrides
})
const admin = { id: 'local:admin', displayName: '管理员', role: 'admin' }

test('a tour video is a WebM of a catalogue tour, and a new one replaces the old', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rig-tour-videos-'))
  const videos = new TourVideos(root)
  await assert.rejects(videos.publish('made-up', admin, body(webm(64))), (error) => error.code === 'not_found')
  await assert.rejects(videos.publish('new-project', admin, body(Buffer.from('<html>not a video</html>'))), (error) => error.code === 'video_invalid')
  await assert.rejects(videos.publish('new-project', admin, body(webm(64), { recordedAt: 'yesterday' })))
  const first = await videos.publish('new-project', admin, body(webm(64)))
  assert.deepEqual([first.bytes, first.version, first.publishedBy], [64, '0.8.0', '管理员'])
  await videos.publish('new-project', admin, body(webm(128, 2), { version: '0.9.0' }))
  const { videos: listed } = await videos.list()
  assert.deepEqual(listed.map((entry) => [entry.id, entry.version, entry.bytes]), [['new-project', '0.9.0', 128]])
  assert.match(listed[0].title, /新项目/)
  assert.deepEqual((await readdir(root)).sort(), ['new-project.json', 'new-project.webm'], 'the latest only, no leftovers')
})

test('publishing keeps clear of the disk reserve', async () => {
  const videos = new TourVideos(await mkdtemp(join(tmpdir(), 'rig-tour-room-')), {
    minFreeBytes: 1_000,
    statfsImpl: async () => ({ bavail: 1_050, bsize: 1 })
  })
  await assert.rejects(videos.publish('read-a-run', admin, body(webm(64))), (error) => error.code === 'storage_low' && error.status === 507)
  assert.deepEqual((await videos.list()).videos, [])
})

test('only an admin publishes', async () => {
  const videos = new TourVideos(await mkdtemp(join(tmpdir(), 'rig-tour-role-')))
  const call = (role) =>
    tourVideoRoutes({
      req: { method: 'PUT', headers: {} },
      res: null,
      path: '/api/rig/v1/tour-videos/read-a-run',
      principal: { id: 'local:someone', role },
      videos,
      readJson: async () => body(webm(64)),
      sendJson: () => {},
      requireRole
    })
  await assert.rejects(call('viewer'))
  await assert.rejects(call('operator'))
  assert.equal(await call('admin'), true)
})

test('the service lists the videos and serves them with byte ranges', async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'rig-tour-http-'))
  const runtime = await start(
    { MX_RIG_ADMIN_TOKEN: 'tour-video-secret', MX_RIG_HOST: '127.0.0.1', MX_RIG_PORT: '0', MX_RIG_STORE: 'memory', MX_RIG_STATE_DIR: state, MX_RIG_ARTIFACTS_DIR: join(state, 'artifacts') },
    { schedule: false }
  )
  t.after(() => runtime.close())
  const auth = { authorization: 'Bearer tour-video-secret' }
  const video = webm(1000, 7)
  const put = await fetch(`${runtime.origin}/api/rig/v1/tour-videos/read-a-run`, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body(video))
  })
  assert.equal(put.status, 200)
  const listed = await (await fetch(`${runtime.origin}/api/rig/v1/tour-videos`, { headers: auth })).json()
  assert.deepEqual(listed.videos.map((entry) => entry.id), ['read-a-run'])
  const whole = await fetch(`${runtime.origin}/api/rig/v1/tour-videos/read-a-run.webm`, { headers: auth })
  assert.equal(whole.status, 200)
  assert.equal(whole.headers.get('content-type'), 'video/webm')
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), video)
  const part = await fetch(`${runtime.origin}/api/rig/v1/tour-videos/read-a-run.webm`, { headers: { ...auth, range: 'bytes=4-9' } })
  assert.equal(part.status, 206)
  assert.equal(part.headers.get('content-range'), 'bytes 4-9/1000')
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), Buffer.alloc(6, 7))
  assert.equal((await fetch(`${runtime.origin}/api/rig/v1/tour-videos/new-project.webm`, { headers: auth })).status, 404, 'not recorded yet')
  assert.equal((await fetch(`${runtime.origin}/api/rig/v1/tour-videos/read-a-run.webm`)).status, 401, 'members only')
})
