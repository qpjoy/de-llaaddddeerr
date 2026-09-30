import os from 'node:os'
import { readFile } from 'node:fs/promises'
import { AppError } from '../core/errors.mjs'

const ratio = (used, total) => Number.isFinite(used) && Number.isFinite(total) && total > 0
  ? Math.max(0, Math.min(100, used / total * 100)) : null
const numeric = (text) => text !== null && text.trim() !== '' && Number.isFinite(Number(text)) ? Number(text) : null
const field = (text, name) => numeric(text?.match(new RegExp(`^${name}[:\\s]+(\\d+)`, 'm'))?.[1] ?? null)

// Read-only host counters plus optional cgroup v2 limits. No host tuning,
// Kubernetes credentials, source content or model calls are involved.
export async function readResourceCounters({ system = os, read = readFile, platform = process.platform } = {}) {
  const cpu = system.cpus().reduce((sum, item) => ({
    total: sum.total + Object.values(item.times).reduce((n, v) => n + v, 0),
    idle: sum.idle + item.times.idle,
  }), { total: 0, idle: 0 })
  const files = platform === 'linux' ? await Promise.all([
    '/proc/meminfo', '/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.max',
    '/sys/fs/cgroup/cpu.stat', '/sys/fs/cgroup/cpu.max',
  ].map((path) => read(path, 'utf8').catch(() => null))) : []
  const available = platform === 'linux' ? field(files[0], 'MemAvailable') : system.freemem()
  const total = platform === 'linux' ? field(files[0], 'MemTotal') : system.totalmem()
  const [quota, period] = (files[4]?.trim().split(/\s+/) || []).map((v) => numeric(v))
  return {
    cpu, memoryPercent: available === null || total === null ? null : ratio(total - available, total),
    containerMemoryPercent: ratio(numeric(files[1] ?? null), numeric(files[2] ?? null)),
    containerCpuUsec: field(files[3], 'usage_usec'),
    containerCpuCores: quota > 0 && period > 0 ? quota / period : null,
  }
}

export class RetrievalResourceGuard {
  constructor({ read = readResourceCounters, now = Date.now } = {}) {
    this.read = read
    this.now = now
    this.previous = null
    this.current = null
    this.pressured = false
    this.healthySamples = 0
    this.cooldownUntil = 0
    this.failures = 0
  }
  async sample() {
    if (this.pending) return this.pending
    if (this.current && this.now() - this.current.checkedAt < 5000) return this.current
    this.pending = this.measure().finally(() => { this.pending = null })
    return this.pending
  }
  async measure() {
    const at = this.now()
    let counters
    try { counters = await this.read() } catch { counters = null }
    const old = this.previous
    const cpuPercent = counters && old
      ? ratio(counters.cpu.total - old.cpu.total - (counters.cpu.idle - old.cpu.idle), counters.cpu.total - old.cpu.total) : null
    const containerCpuPercent = counters?.containerCpuCores && old?.containerCpuUsec != null && counters.containerCpuUsec != null
      ? ratio(counters.containerCpuUsec - old.containerCpuUsec, (at - old.at) * 1000 * counters.containerCpuCores) : null
    const memoryPercent = counters?.memoryPercent ?? null, containerMemoryPercent = counters?.containerMemoryPercent ?? null
    let reason = !counters || memoryPercent === null ? 'resource_unavailable' : cpuPercent === null ? 'sampling'
      : memoryPercent >= 90 || containerMemoryPercent >= 90 ? 'memory_pressure'
      : cpuPercent >= 85 || containerCpuPercent >= 85 ? 'cpu_pressure' : null
    if (reason) { this.pressured = true; this.healthySamples = 0 }
    else if (this.pressured) {
      const recovered = cpuPercent <= 70 && memoryPercent <= 80
        && (containerCpuPercent === null || containerCpuPercent <= 70)
        && (containerMemoryPercent === null || containerMemoryPercent <= 80)
      this.healthySamples = recovered ? this.healthySamples + 1 : 0
      if (this.healthySamples >= 2) this.pressured = false
      else reason = 'recovering'
    }
    if (!reason && at < this.cooldownUntil) reason = 'dependency_backoff'
    this.previous = counters ? { ...counters, at } : null
    this.current = { version: 1, checkedAt: at, blocked: Boolean(reason), reason,
      cpuPercent, memoryPercent, containerCpuPercent, containerMemoryPercent,
      cooldownUntil: this.cooldownUntil > at ? this.cooldownUntil : null }
    return this.current
  }
  async check() {
    if ((await this.sample()).blocked)
      throw new AppError(503, 'retrieval_resource_pressure', '资源压力保护中，后台任务稍后自动继续')
  }
  failed(error) {
    if (['embedding_budget_exceeded', 'initialization_budget_exceeded', 'retrieval_resource_pressure', 'embedding_not_ready'].includes(error.code)) return false
    const status = Number(error.status ?? error.statusCode ?? error.cause?.status)
    if (![429, 502, 503, 504].includes(status)) return false
    this.cooldownUntil = this.now() + Math.min(300000, 30000 * 2 ** Math.min(this.failures++, 4))
    this.current = null
    // The existing provider router wraps upstream statuses in a 503 and keeps
    // a value-free attempt list. Only an all-429 result is a rate-limit retry;
    // authentication, transport and invalid-response failures stay bounded.
    return status === 429 || (error.code === 'agent_providers_unavailable'
      && error.attempts?.length > 0 && error.attempts.every((a) => a.error === 'HTTP 429'))
  }
  succeeded() { this.failures = 0 }
}
