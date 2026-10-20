/**
 * Readiness for a single-replica service in front of one database.
 *
 * Taking the only replica out of rotation does not fail over anywhere: it turns
 * slow logins into refused connections and makes kubelet/Endpoints churn
 * through the API server exactly when the shared disk is struggling. So:
 *
 * - at most one database check runs at a time; probes never queue more work
 *   onto a pool that is already waiting on the disk;
 * - a probe answers within `waitMs`, before the kubelet's probe timeout;
 * - until the first successful check the service is not ready (startup gate);
 * - afterwards a slow or failing check keeps it ready for `graceMs` since the
 *   last success, then readiness fails as before.
 */
export class ReadinessGate {
  private lastSuccessAt = Number.NEGATIVE_INFINITY;
  private running: Promise<boolean> | undefined;

  constructor(
    private readonly check: () => unknown,
    private readonly options: { waitMs: number; graceMs: number },
    private readonly now: () => number = Date.now
  ) {}

  async state(): Promise<{ ready: boolean; degraded: boolean }> {
    if (!this.running) {
      this.running = Promise.resolve()
        .then(this.check)
        .then(() => { this.lastSuccessAt = this.now(); return true; }, () => false)
        .finally(() => { this.running = undefined; });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      this.running,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), this.options.waitMs); })
    ]).finally(() => clearTimeout(timer));
    if (settled === true) return { ready: true, degraded: false };
    return { ready: this.now() - this.lastSuccessAt < this.options.graceMs, degraded: true };
  }
}
