import { Cron } from 'croner'
import { MONITOR_TIME_ZONE } from '../shared/monitor-schedule.mjs'

// Database deadlines remain authoritative across replicas and restarts. Croner
// arms the exact next deadline, while a wall-clock reconciliation job notices
// policy edits on other replicas and retries transient storage/delivery errors.
export class MonitorCronTimer {
  constructor({ run, nextAt, logger = console, createCron = (...args) => new Cron(...args), now = () => Date.now() }) {
    Object.assign(this, { run, nextAt, logger, createCron, now })
    this.alarm = null
    this.reconcile = null
    this.running = null
    this.pending = false
    this.stopped = false
  }
  start() {
    if (this.reconcile || this.stopped) return
    this.reconcile = this.createCron('*/30 * * * * *', { timezone: MONITOR_TIME_ZONE, unref: true, protect: true }, () => this.refresh())
    void this.refresh()
  }
  refresh() {
    if (this.stopped) return Promise.resolve()
    if (this.running) { this.pending = true; return this.running }
    this.running = (async () => {
      do {
        this.pending = false
        await this.run()
        const at = await this.nextAt()
        this.alarm?.stop(); this.alarm = null
        if (this.stopped) return
        if (at && new Date(at).getTime() > this.now()) {
          // Croner's Date trigger has second resolution; never round early.
          const deadline = new Date(Math.ceil(new Date(at).getTime() / 1000) * 1000)
          this.alarm = this.createCron(deadline, { unref: true }, () => this.refresh())
        }
      } while (this.pending && !this.stopped)
    })().catch(() => this.logger.warn('[monitor-schedule] Schedule refresh failed; will retry'))
      .finally(() => { this.running = null })
    return this.running
  }
  async close() {
    this.stopped = true
    this.reconcile?.stop(); this.alarm?.stop()
    await this.running
  }
}
