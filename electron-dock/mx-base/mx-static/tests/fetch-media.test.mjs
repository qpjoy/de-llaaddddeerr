import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:https'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { createMediaFetcher } from '../src/fetch-media.mjs'
import { assertPublicUrl, isPublicAddress } from '../src/net-guard.mjs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1kAAAAASUVORK5CYII=', 'base64')

async function origin(t, handler) {
  const dir = await mkdtemp(join(tmpdir(), 'mx-tls-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'),
    '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' })
  const cert = await readFile(join(dir, 'cert.pem'))
  const server = createServer({ key: await readFile(join(dir, 'key.pem')), cert }, handler)
  server.listen(0); await once(server, 'listening') // Dual stack: localhost may resolve to ::1 first.
  const staging = await mkdtemp(join(tmpdir(), 'mx-stage-'))
  t.after(async () => { server.close(); server.closeAllConnections(); await rm(dir, { recursive: true, force: true }); await rm(staging, { recursive: true, force: true }) })
  return {
    staging,
    base: `https://localhost:${server.address().port}`,
    fetcher: (options = {}) => createMediaFetcher({ stagingDir: staging, allowHosts: ['localhost'], tls: { ca: cert }, ...options }),
  }
}
const rejects = async (promise, status, code) => {
  const error = await promise.then(() => null, error => error)
  assert.ok(error, `expected ${status} ${code}, got success`)
  assert.equal(error.status, status); assert.equal(error.code, code)
}

test('streams a verified object to staging without buffering it whole', async t => {
  const big = Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024, 7)])
  const { base, staging, fetcher } = await origin(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' }); res.end(big)
  })
  const result = await fetcher()(`${base}/a.png`)
  assert.equal(result.size, big.length)
  assert.equal(result.contentType, 'image/png')
  assert.equal(result.sha256, createHash('sha256').update(big).digest('hex'))
  assert.deepEqual(await readFile(result.path), big)
  assert.equal(result.path.startsWith(staging), true)
})

test('rejects bad signatures from the first bytes and leaves no staged file', async t => {
  const { staging, base, fetcher } = await origin(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(Buffer.concat([Buffer.from('<script>alert(1)</script>'), Buffer.alloc(2 * 1024 * 1024, 1)]))
  })
  await rejects(fetcher()(`${base}/evil.png`), 415, 'media_content_invalid')
  assert.deepEqual(await readdir(staging), [])
})

test('enforces the size cap on both the declared and the actual length', async t => {
  const { staging, base, fetcher } = await origin(t, (req, res) => {
    const body = Buffer.concat([png, Buffer.alloc(4 * 1024 * 1024, 3)])
    // Lie about the length on /sneaky so the cap must also hold while streaming.
    res.writeHead(200, req.url === '/sneaky' ? { 'content-type': 'image/png' } : { 'content-type': 'image/png', 'content-length': String(body.length) })
    res.end(body)
  })
  await rejects(fetcher({ maxBytes: 1024 })(`${base}/declared.png`), 413, 'file_too_large')
  await rejects(fetcher({ maxBytes: 1024 })(`${base}/sneaky`), 413, 'file_too_large')
  assert.deepEqual(await readdir(staging), [])
})

test('rejects disallowed content types and non-2xx sources', async t => {
  const { base, fetcher } = await origin(t, (req, res) => {
    if (req.url === '/missing') { res.writeHead(404); return res.end('nope') }
    res.writeHead(200, { 'content-type': 'image/svg+xml' }); res.end('<svg/>')
  })
  await rejects(fetcher()(`${base}/a.svg`), 415, 'media_content_invalid')
  await rejects(fetcher()(`${base}/missing`), 502, 'source_unavailable')
})

test('re-validates every redirect hop and bounds the chain', async t => {
  const { base, fetcher } = await origin(t, (req, res) => {
    if (req.url === '/to-private') { res.writeHead(302, { location: 'https://169.254.169.254/latest' }); return res.end() }
    if (req.url === '/to-plain') { res.writeHead(302, { location: 'http://cdn.example/a.png' }); return res.end() }
    if (req.url.startsWith('/loop')) { res.writeHead(302, { location: `${base}/loop${req.url.length}` }); return res.end() }
    if (req.url === '/hop') { res.writeHead(302, { location: `${base}/final.png` }); return res.end() }
    res.writeHead(200, { 'content-type': 'image/png' }); res.end(png)
  })
  await rejects(fetcher()(`${base}/to-private`), 422, 'media_url_rejected')
  await rejects(fetcher()(`${base}/to-plain`), 422, 'media_url_rejected')
  await rejects(fetcher()(`${base}/loop`), 502, 'source_unavailable')
  assert.equal((await fetcher()(`${base}/hop`)).size, png.length)
})

test('never forwards credentials to the origin', async t => {
  let seen = {}
  const { base, fetcher } = await origin(t, (req, res) => {
    seen = req.headers
    res.writeHead(200, { 'content-type': 'image/png' }); res.end(png)
  })
  await fetcher()(`${base}/a.png`)
  assert.equal(seen.cookie, undefined)
  assert.equal(seen.authorization, undefined)
})

test('address guard blocks every private range and the url guard blocks non-https', () => {
  for (const address of ['127.0.0.1', '169.254.169.254', '10.1.2.3', '192.168.1.3', '::1', 'fd00::1', '::ffff:192.168.1.3', '100.64.0.1'])
    assert.equal(isPublicAddress(address), false, address)
  for (const address of ['8.8.8.8', '2001:4860:4860::8888']) assert.equal(isPublicAddress(address), true, address)
  for (const url of ['http://cdn.example/a', 'https://user:pw@cdn.example/a', 'https://127.0.0.1/a', 'https://localhost/a'])
    assert.throws(() => assertPublicUrl(url), error => error.status === 422, url)
  assert.equal(assertPublicUrl('https://cdn.example/a.jpg').hostname, 'cdn.example')
})
