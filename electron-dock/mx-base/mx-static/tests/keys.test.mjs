import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createStaticService } from '../src/service.mjs'
import { isObjectKey, isSharded, newObjectKey } from '../src/keys.mjs'

const write = 'w'.repeat(32), read = 'r'.repeat(32)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1kAAAAASUVORK5CYII=', 'base64')

test('new keys shard by hour and id prefix; both shapes stay readable', () => {
  const key = newObjectKey('mx-insight-hub', new Date('2026-09-13T07:41:05Z'))
  assert.match(key, /^mx-insight-hub\/2026\/09\/13\/07\/[0-9a-f]{2}\/[0-9a-f-]{36}$/)
  assert.equal(key.split('/')[5], key.split('/')[6].slice(0, 2), 'the shard is the id prefix')
  assert.equal(isSharded(key), true)
  assert.equal(isObjectKey(key), true)
  // A date-only key from before the split is still a valid address.
  assert.equal(isObjectKey('mx-insight-hub/2026/09/12/1ef9fdd0-b7dd-4a2c-9e1d-80dc0f0112a4'), true)
  assert.equal(isSharded('mx-insight-hub/2026/09/12/1ef9fdd0-b7dd-4a2c-9e1d-80dc0f0112a4'), false)
  for (const bad of ['../etc/passwd', 'p/2026/09/13/07/zz/1ef9fdd0-b7dd-4a2c-9e1d-80dc0f0112a4',
    'p/2026/09/13/07/1e/short', 'p/2026/9/13/07/1e/1ef9fdd0-b7dd-4a2c-9e1d-80dc0f0112a4', ''])
    assert.equal(isObjectKey(bad), false, bad)
})

test('a stored object lands in the sharded tree and reads back by its key', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mx-keys-'))
  const server = createStaticService({ root, projects: { 'mx-insight-hub': { write, read } }, signingKey: 's'.repeat(32), minFreeBytes: 0, env: {} })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}`
  t.after(async () => { await server.shutdown(); await new Promise(r => { server.close(r); server.closeAllConnections() }); await rm(root, { recursive: true, force: true }) })

  const stored = await fetch(`${url}/static/v1/projects/mx-insight-hub/upload`,
    { method: 'POST', headers: { authorization: `Bearer ${write}`, 'content-type': 'image/png' }, body: png }).then(r => r.json())
  assert.equal(isSharded(stored.key), true, stored.key)

  const [, year, month, day, hour, shard] = stored.key.split('/')
  assert.deepEqual(await readdir(join(root, 'objects', 'mx-insight-hub', year, month, day, hour, shard)), [stored.key.split('/').pop()])
  assert.deepEqual(await readdir(join(root, 'metadata', 'mx-insight-hub', year, month, day, hour, shard)), [stored.key.split('/').pop() + '.json'])

  const fetched = await fetch(`${url}/static/files/${stored.key}`, { headers: { authorization: `Bearer ${read}` } })
  assert.equal(fetched.status, 200)
  assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), png)
  assert.equal((await fetch(`${url}/static/files/mx-insight-hub/2026/09/13/07/zz/nope`, { headers: { authorization: `Bearer ${read}` } })).status, 404)
})
