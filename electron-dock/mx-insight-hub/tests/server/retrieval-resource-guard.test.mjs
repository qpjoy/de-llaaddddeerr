import assert from 'node:assert/strict'
import test from 'node:test'
import { readResourceCounters, RetrievalResourceGuard } from '../../server/retrieval/resource-guard.mjs'

function fixture() {
  let at = 0, total = 0, idle = 0, usec = 0, cpu = 20, memory = 40, containerCpu = 10, containerMemory = 30, unavailable = false
  const guard = new RetrievalResourceGuard({ now: () => at, read: async () => {
    if (unavailable) throw Error('unreadable')
    return { cpu: { total, idle }, memoryPercent: memory, containerCpuUsec: usec, containerCpuCores: 1, containerMemoryPercent: containerMemory }
  } })
  const sample = async (values = {}) => {
    cpu = values.cpu ?? cpu; memory = values.memory ?? memory
    containerCpu = values.containerCpu ?? containerCpu; containerMemory = values.containerMemory ?? containerMemory
    unavailable = values.unavailable ?? false
    at += 5000; total += 5000; idle += 5000 * (1 - cpu / 100); usec += 5000000 * containerCpu / 100
    return guard.sample()
  }
  const warm = async () => { await sample(); await sample(); assert.equal((await sample()).blocked, false) }
  return { guard, sample, warm }
}

test('resource protection yields at pressure, uses hysteresis and resumes automatically after stable recovery', async () => {
  const f = fixture()
  await f.warm()
  assert.equal((await f.sample({ cpu: 90 })).reason, 'cpu_pressure')
  await assert.rejects(f.guard.check(), { code: 'retrieval_resource_pressure' })
  assert.equal((await f.sample({ cpu: 78 })).reason, 'recovering')
  assert.equal((await f.sample({ cpu: 65 })).blocked, true)
  assert.equal((await f.sample({ cpu: 65 })).blocked, false)
  assert.equal((await f.sample({ memory: 92 })).reason, 'memory_pressure')
  assert.equal((await f.sample({ memory: 79 })).blocked, true)
  assert.equal((await f.sample({ memory: 79 })).blocked, false)
  assert.equal((await f.sample({ containerCpu: 92 })).reason, 'cpu_pressure')
  await f.sample({ containerCpu: 20 })
  assert.equal((await f.sample({ containerCpu: 20 })).blocked, false)
  assert.equal((await f.sample({ containerMemory: 92 })).reason, 'memory_pressure')
})

test('unavailable resource observations stop admission instead of being reported as idle capacity', async () => {
  const f = fixture()
  await f.warm()
  assert.equal((await f.sample({ unavailable: true })).reason, 'resource_unavailable')
  assert.equal((await f.sample()).reason, 'sampling')
  await f.sample()
  assert.equal((await f.sample()).blocked, false)
})

test('dependency throttling backs off while local budget waits do not masquerade as dependency pressure', async () => {
  const f = fixture()
  await f.warm()
  assert.equal(f.guard.failed({ status: 429, code: 'embedding_budget_exceeded' }), false)
  assert.equal((await f.sample()).blocked, false)
  assert.equal(f.guard.failed({ status: 429 }), true)
  assert.equal((await f.sample()).reason, 'dependency_backoff')
  for (let i = 0; i < 5; i++) await f.sample()
  assert.equal((await f.sample()).blocked, false)
  f.guard.succeeded()
  assert.equal(f.guard.failed({ status: 503 }), false, 'service errors retain their bounded job retry count')
  assert.equal((await f.sample()).reason, 'dependency_backoff')
  assert.equal(f.guard.failed({ status: 503, code: 'agent_providers_unavailable', attempts: [{ error: 'HTTP 429' }] }), true)
  assert.equal(f.guard.failed({ status: 503, code: 'agent_providers_unavailable', attempts: [{ error: 'HTTP 429' }, { error: 'HTTP 401' }] }), false)
})

test('Linux uses MemAvailable instead of free pages and reads cgroup limits without treating max as zero', async () => {
  const values = {
    '/proc/meminfo': 'MemTotal: 10000 kB\nMemFree: 10 kB\nMemAvailable: 4000 kB\n',
    '/sys/fs/cgroup/memory.current': '800', '/sys/fs/cgroup/memory.max': '1000',
    '/sys/fs/cgroup/cpu.stat': 'usage_usec 25000\nnr_throttled 3', '/sys/fs/cgroup/cpu.max': '50000 100000',
  }
  const args = { platform: 'linux', system: { cpus: () => [{ times: { idle: 200, user: 100, sys: 50 } }] },
    read: async (path) => { if (!(path in values)) throw Error('absent'); return values[path] } }
  const sample = await readResourceCounters(args)
  assert.equal(sample.memoryPercent, 60)
  assert.equal(sample.containerMemoryPercent, 80)
  assert.equal(sample.containerCpuCores, 0.5)
  values['/sys/fs/cgroup/memory.max'] = 'max'
  values['/sys/fs/cgroup/cpu.max'] = 'max 100000'
  const unlimited = await readResourceCounters(args)
  assert.equal(unlimited.containerMemoryPercent, null)
  assert.equal(unlimited.containerCpuCores, null)
  delete values['/proc/meminfo']
  assert.equal((await readResourceCounters(args)).memoryPercent, null)
})
