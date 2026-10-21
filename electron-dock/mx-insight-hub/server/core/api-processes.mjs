// Primary process for an API pod that runs several Node processes on one port.
//
// Node is single-threaded, so one process uses at most one core however large
// the pod's CPU limit is. The Public pod cannot add replicas (it binds a fixed
// host port), so it forks workers that share the listening socket through
// node:cluster instead. The primary serves nothing itself: it keeps the
// workers running and turns the pod's stop signal into a graceful stop of each.
//
// A worker that dies is replaced after a short, growing delay. Workers that keep
// dying right after they start mean the pod cannot serve (bad configuration, an
// unreachable dependency at startup), so after a few such failures in a row the
// primary exits non-zero and Kubernetes restarts the pod with its own backoff
// and makes the failure visible, rather than this process looping quietly.

export function superviseApiProcesses({
  cluster,
  processes,
  logger = console,
  host = process,
  exit = (code) => process.exit(code),
  restartDelayMs = 1_000,
  maxRestartDelayMs = 30_000,
  // A worker that exits sooner than this after starting counts as a crash loop.
  crashWindowMs = 30_000,
  maxConsecutiveCrashes = 5,
  // Below Kubernetes' default 30 s termination grace period.
  shutdownTimeoutMs = 25_000,
  // Each worker's V8 heap. Node sizes a default heap from the whole container,
  // so several workers could together outgrow the pod limit before any of them
  // collects; an explicit share keeps them inside it.
  workerHeapMb = 768,
  now = Date.now,
  setTimer = setTimeout,
}) {
  const startedAt = new Map()
  let stopping = false
  let exitCode = 0
  let consecutiveCrashes = 0

  const live = () => Object.values(cluster.workers ?? {}).filter(Boolean)
  const fork = () => {
    const worker = cluster.fork()
    startedAt.set(worker.id, now())
    return worker
  }
  const stop = (code) => {
    if (stopping) return
    stopping = true
    exitCode = code
    const workers = live()
    if (workers.length === 0) {
      exit(exitCode)
      return
    }
    // Each worker closes its listener, finishes in-flight requests and ends its
    // pools on SIGTERM, exactly as a single-process API does.
    for (const worker of workers) worker.process.kill('SIGTERM')
    const deadline = setTimer(() => {
      for (const worker of live()) worker.process.kill('SIGKILL')
      exit(exitCode)
    }, shutdownTimeoutMs)
    deadline?.unref?.()
  }

  cluster.on('exit', (worker, code, signal) => {
    const lived = now() - (startedAt.get(worker.id) ?? now())
    startedAt.delete(worker.id)
    if (stopping) {
      if (live().length === 0) exit(exitCode)
      return
    }
    consecutiveCrashes = lived < crashWindowMs ? consecutiveCrashes + 1 : 1
    if (consecutiveCrashes >= maxConsecutiveCrashes) {
      logger.error?.(`[api] ${consecutiveCrashes} API processes in a row exited within ${crashWindowMs} ms of starting; stopping the pod`)
      stop(1)
      return
    }
    const delayMs = Math.min(maxRestartDelayMs, restartDelayMs * 2 ** (consecutiveCrashes - 1))
    logger.error?.(`[api] process ${worker.process.pid} exited (${signal || `code ${code}`}); starting a replacement in ${delayMs} ms`)
    setTimer(() => {
      if (!stopping) fork()
    }, delayMs)
  })

  host.once('SIGTERM', () => stop(0))
  host.once('SIGINT', () => stop(0))
  cluster.setupPrimary?.({ execArgv: [...process.execArgv, `--max-old-space-size=${workerHeapMb}`] })
  for (let index = 0; index < processes; index += 1) fork()
  logger.log?.(`[api] started ${processes} API processes`)
  return { stop }
}
