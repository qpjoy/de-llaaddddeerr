import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { MediaJobs } from '../src/jobs.mjs'
import { MediaCache } from '../src/cache.mjs'

test('SIGKILL leaves accepted/running jobs durable; expired lease is recovered and fenced', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'static-kill-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const moduleUrl = new URL('../src/jobs.mjs', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { MediaJobs } from ${JSON.stringify(moduleUrl)};
    const q = new MediaJobs(process.argv[1], {leaseMs:100});
    q.enqueue('p','tenant','hash','https://cdn.example/a');
    process.stdout.write(JSON.stringify(q.claim())+'\\n');
    setInterval(()=>{},1000);
  `, dir], { stdio: ['ignore', 'pipe', 'ignore'] })
  t.after(() => child.kill('SIGKILL'))
  let output = ''
  for await (const chunk of child.stdout) { output += chunk; if (output.includes('\n')) break }
  const stale = JSON.parse(output)
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
  await new Promise(resolve => setTimeout(resolve, 120))
  const recovered = new MediaJobs(dir, { leaseMs: 100 })
  t.after(() => recovered.close())
  const job = recovered.claim()
  assert.equal(job.id, stale.id); assert.equal(job.attempts, 2)
  assert.notEqual(job.owner, stale.owner)
  assert.equal(recovered.complete(stale, { key: 'stale' }), false)
  assert.equal(recovered.complete(job, { key: 'durable' }), true)
  assert.equal(recovered.ready('p', 'hash').result.key, 'durable')
  assert.equal(recovered.get(job.id, 'other'), null)
})
test('failed tasks keep evidence and explicitly retry; queue capacity and cache eviction are bounded', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'static-jobs-'))
  const q = new MediaJobs(dir, { maxQueued: 1, maxAttempts: 1 })
  t.after(async () => { q.close(); await rm(dir, { recursive: true, force: true }) })
  const accepted = q.enqueue('p', 's', 'one', 'https://cdn.example/one')
  assert.equal(q.enqueue('p', 's', 'one', 'https://cdn.example/one').id, accepted.id)
  assert.throws(() => q.enqueue('p', 's', 'two', 'https://cdn.example/two'), { code: 'queue_full' })
  const running = q.claim(); q.fail(running, 'bad_image', { status: 415, retryable: false })
  assert.equal(q.get(accepted.id, 'p').state, 'failed')
  assert.notEqual(q.retry(accepted.id, 'p').id, accepted.id)
  let now = 0
  const cache = new MediaCache({ maxBytes: 4, ttlMs: 10, now: () => now })
  cache.set('a', Buffer.from('aa')); cache.set('b', Buffer.from('bb')); cache.get('a'); cache.set('c', Buffer.from('cc'))
  assert.equal(cache.get('b'), null); assert.equal(cache.bytes, 4)
  now = 11; cache.prune(); assert.equal(cache.bytes, 0)
  assert.throws(() => new MediaCache({ maxBytes: -1 }))
})
