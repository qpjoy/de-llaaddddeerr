import assert from 'node:assert/strict'
import { test } from 'node:test'
import net from 'node:net'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { probePostgres, probeHanlp, waitForStartupDependencies } from '../../server/ops/wait-startup-dependencies.mjs'

async function listen(t, server) {
  const sockets = new Set()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy()
    server.close(resolve)
  }))
  return server.address().port
}

function message(type, body) {
  const header = Buffer.alloc(5)
  header[0] = type.charCodeAt(0)
  header.writeInt32BE(4 + body.length, 1)
  return Buffer.concat([header, body])
}
const authentication = (kind = 3) => {
  const body = Buffer.alloc(4)
  body.writeInt32BE(kind)
  return message('R', body)
}
const pgError = (code) => message('E', Buffer.from(`SFATAL\0C${code}\0Mprivate-server-detail\0\0`))

async function postgresFixture(t, respond) {
  const requests = []
  const port = await listen(t, net.createServer((socket) => {
    let received = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk])
      if (received.length < 4 || received.length < received.readInt32BE(0)) return
      socket.removeAllListeners('data')
      requests.push(received)
      respond(socket, requests.length)
    })
  }))
  return { host: '127.0.0.1', port, requests }
}

async function hanlpFixture(t, respond) {
  const requests = []
  const port = await listen(t, http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url })
    respond(response, requests.length)
  }))
  return { url: `http://127.0.0.1:${port}`, requests }
}

test('PostgreSQL startup handshake accepts authentication without sending credentials or SQL', async (t) => {
  const pg = await postgresFixture(t, (socket) => {
    const frame = authentication()
    socket.write(frame.subarray(0, 3))
    setImmediate(() => socket.write(frame.subarray(3)))
  })
  assert.equal(await probePostgres(pg), 'ready')
  const packet = pg.requests[0]
  assert.equal(packet.readInt32BE(0), packet.length)
  assert.equal(packet.readInt32BE(4), 196608)
  assert.deepEqual(packet.subarray(8).toString().split('\0'), [
    'user', 'postgres', 'database', 'postgres', 'application_name', 'mx_hub_startup_probe', '', '',
  ])
})

test('PostgreSQL ping rejects recovery 57P03 but accepts server-side authentication/database errors like pg_isready', async (t) => {
  for (const [code, expected] of [['57P03', 'rejecting'], ['28P01', 'ready'], ['28000', 'ready'], ['3D000', 'ready']]) {
    const pg = await postgresFixture(t, (socket) => socket.end(pgError(code)))
    assert.equal(await probePostgres(pg), expected, code)
  }
})

test('PostgreSQL rejects malformed, truncated, oversized and non-PostgreSQL responses', async (t) => {
  const oversized = Buffer.from([69, 0, 1, 0, 0])
  for (const reply of [
    Buffer.from('HTTP/1.1 200 OK\r\n\r\n'),
    message('R', Buffer.alloc(3)),
    message('E', Buffer.from('SFATAL\0Mno sqlstate\0\0')),
    message('E', Buffer.from('SFATAL\0C57P03')),
    pgError('57P03').subarray(0, 8),
    oversized,
  ]) {
    const pg = await postgresFixture(t, (socket) => socket.end(reply))
    assert.equal(await probePostgres(pg), 'invalid_response')
  }
})

test('PostgreSQL socket probe has an absolute deadline even while bytes arrive', async (t) => {
  const pg = await postgresFixture(t, (socket) => {
    const frame = authentication()
    let index = 0
    const timer = setInterval(() => socket.write(frame.subarray(index, ++index)), 20)
    socket.once('close', () => clearInterval(timer))
  })
  const started = performance.now()
  assert.equal(await probePostgres({ ...pg, timeoutMs: 65 }), 'timeout')
  assert.ok(performance.now() - started < 500)
})

test('HanLP requires its ready health contract, uses GET and preserves a configured path prefix', async (t) => {
  const hanlp = await hanlpFixture(t, (response) => response.end(JSON.stringify({ status: 'ready' })))
  assert.equal(await probeHanlp(`${hanlp.url}/hanlp/`), 'ready')
  assert.deepEqual(hanlp.requests, [{ method: 'GET', url: '/hanlp/health' }])
  assert.equal(await probeHanlp(''), 'not_configured')
  assert.equal(await probeHanlp('file:///private/config'), 'invalid_url')
  assert.equal(await probeHanlp('http://user:private@localhost/'), 'invalid_url')
})

test('HanLP rejects loading, HTTP errors/redirects, invalid/oversized JSON and bounded hanging requests', async (t) => {
  for (const [status, body, expected] of [
    [503, '{"status":"loading"}', 'http_503'],
    [302, '', 'http_302'],
    [200, '{"status":"loading"}', 'not_ready'],
    [200, 'not json', 'invalid_response'],
    [200, 'x'.repeat(17 * 1024), 'invalid_response'],
  ]) {
    const hanlp = await hanlpFixture(t, (response) => { response.statusCode = status; response.end(body) })
    assert.equal(await probeHanlp(hanlp.url), expected)
  }
  const hanging = await hanlpFixture(t, () => {})
  assert.equal(await probeHanlp(hanging.url, { timeoutMs: 30 }), 'timeout')
})

test('startup retries HanLP 503 and PostgreSQL recovery, requiring both ready in the same pass', async (t) => {
  const pg = await postgresFixture(t, (socket, count) => socket.end(count === 2 || count === 3 ? pgError('57P03') : authentication()))
  const hanlp = await hanlpFixture(t, (response, count) => {
    response.statusCode = count === 1 ? 503 : 200
    response.end(JSON.stringify({ status: count === 1 ? 'loading' : 'ready' }))
  })
  const logs = []
  assert.equal(await waitForStartupDependencies({
    hanlpUrl: hanlp.url, postgres: pg, timeoutMs: 1000, probeTimeoutMs: 100, retryMs: 5, log: (line) => logs.push(line),
  }), true)
  assert.equal(pg.requests.length, 4)
  assert.equal(hanlp.requests.length, 4)
  assert.match(logs.join('\n'), /postgres=rejecting hanlp=ready/u)
  assert.doesNotMatch(logs.join('\n'), /private-server-detail|127\.0\.0\.1/u)
})

test('startup has a total deadline and blocks missing HanLP configuration immediately', async (t) => {
  const pg = await postgresFixture(t, () => {})
  const hanlp = await hanlpFixture(t, () => {})
  const logs = []
  const started = performance.now()
  assert.equal(await waitForStartupDependencies({
    hanlpUrl: hanlp.url, postgres: pg, timeoutMs: 70, probeTimeoutMs: 5000, retryMs: 2000, log: (line) => logs.push(line),
  }), false)
  assert.ok(performance.now() - started < 600)
  assert.match(logs.at(-1), /deadline exceeded/u)
  const count = pg.requests.length
  assert.equal(await waitForStartupDependencies({ hanlpUrl: '', postgres: pg, log: (line) => logs.push(line) }), false)
  assert.equal(pg.requests.length, count)
  assert.match(logs.at(-1), /hanlp=not_configured/u)
})

test('CLI exits nonzero without secrets when saved HanLP URL is absent', () => {
  const env = { ...process.env, MX_COMMON_HANLP_URL: '', DATABASE_URL: 'private-db-credential' }
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../server/ops/wait-startup-dependencies.mjs', import.meta.url))], { env, encoding: 'utf8', timeout: 3000 })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /hanlp=not_configured/u)
  assert.doesNotMatch(result.stdout + result.stderr, /private-db-credential/u)
})

test('all six Internal workloads gate with the release image and only the saved HanLP URL; runtime image includes the script', () => {
  const root = new URL('../../', import.meta.url)
  for (const name of ['30-public-api', '31-admin-api', '32-projector', '33-ingest', '34-classifier', '35-retrieval']) {
    const yaml = readFileSync(new URL(`deploy/k8s/internal/${name}.yaml`, root), 'utf8')
    const init = yaml.split('      initContainers:\n')[1]?.split('      containers:\n')[0]
    assert.ok(init, name)
    assert.match(yaml, /hostNetwork: true/u)
    assert.match(init, /image: mx-insight-hub:shadow/u)
    assert.match(init, /imagePullPolicy: Never/u)
    assert.match(init, /command: \["node", "server\/ops\/wait-startup-dependencies\.mjs"\]/u)
    assert.match(init, /configMapKeyRef:\s+name: mx-insight-hub-config\s+key: MX_COMMON_HANLP_URL/u)
    assert.doesNotMatch(init, /secretRef|secretKeyRef|DATABASE_URL/u)
    assert.match(init, /readOnlyRootFilesystem: true/u)
  }
  assert.match(readFileSync(new URL('Dockerfile', root), 'utf8'), /COPY --from=build \/workspace\/mx-insight-hub\/server \.\/server/u)
})
