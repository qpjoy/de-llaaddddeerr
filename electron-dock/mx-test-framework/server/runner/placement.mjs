// Where a run happens, decided in one place.
//
// It used to be decided in three: a suite's `runnerKind` chose between the
// cluster and somebody's laptop, the run's status was set from that at each of
// the three places a run is created, and the claim deadline was derived from it
// again. Nobody creating a task was ever asked, and the same suite could not be
// run headless on the server one afternoon and on a real Windows machine the
// next. See docs/25-live-runs-and-runner-onboarding.md §13.

import { AppError } from '../core/errors.mjs'

export const RUNS_ON = ['server', 'any-runner', 'pinned-runner']

export const RUNS_ON_LABEL = {
  server: '服务器静默跑',
  'any-runner': '任意执行机',
  'pinned-runner': '指定执行机',
}

/**
 * What a task means when it says nothing.
 *
 * The suite's `runnerKind` stays the default so that every task, suite and
 * script written before this existed keeps behaving exactly as it did.
 */
export function defaultRunsOn(suite) {
  return suite?.runnerKind === 'local' ? 'any-runner' : 'server'
}

/**
 * The placement of one run: where it goes, which machine may take it, what
 * status it starts in, and how long it waits before giving up.
 */
export function resolvePlacement({ task, suite, now = new Date() }) {
  const runsOn = task?.runsOn ?? defaultRunsOn(suite)
  const assignedRunnerId = runsOn === 'pinned-runner' ? (task?.runnerId ?? null) : null
  return {
    runsOn,
    assignedRunnerId,
    // `queued` means the platform will act; `pending-runner` means a machine
    // has to show up. The distinction is what the run list shows as
    // 「排队中」 versus 「等待执行机」.
    status: runsOn === 'server' ? 'queued' : 'pending-runner',
    // Only work that waits for a machine can expire waiting. A deadline on a
    // server-side run would be a second timeout stacked on top of the lease.
    claimDeadline:
      runsOn === 'server'
        ? null
        : new Date(now.getTime() + (task?.claimWindowMinutes ?? 720) * 60_000).toISOString(),
  }
}

/**
 * Refuse a placement that cannot work, at the moment somebody chooses it.
 *
 * The alternative is a task that looks fine and produces a run that waits for a
 * machine that will never be able to take it, until it expires twelve hours
 * later with no explanation.
 */
export function assertPlacementPossible({ runsOn, suite, runner = null, runnerMatches = null }) {
  if (runsOn === 'server' && suite.surface !== 'web' && suite.surface !== 'api') {
    throw new AppError(400, 'placement_impossible', '桌面端套件不能在服务器上跑', {
      hint: '服务器上没有 Windows 和 macOS，也没有可以启动的安装包。选一台执行机。',
    })
  }
  if (runsOn !== 'pinned-runner') return
  if (!runner) {
    throw new AppError(400, 'runner_not_found', '指定执行机时必须选一台存在的机器')
  }
  if (runner.status === 'disabled') {
    throw new AppError(400, 'runner_disabled', `执行机「${runner.name}」已停用`)
  }
  if (runnerMatches && !runnerMatches(runner, suite)) {
    throw new AppError(400, 'runner_incapable', `执行机「${runner.name}」跑不了这条套件`, {
      hint: `这条套件要 ${suite.engine} × ${suite.surface}；这台机器注册时上报的是 ${(runner.capabilities?.engines ?? []).join('、') || '（无）'} × ${(runner.capabilities?.surfaces ?? []).join('、') || '（无）'}。`,
    })
  }
}

/**
 * How long a machine may be silent before it counts as gone.
 *
 * Generous on purpose: an idle runner checks in every 15 seconds by polling for
 * work, but one that is *busy* only renews its lease every 60. A threshold
 * tight enough for the idle case would show every machine that is actually
 * running tests as offline, which is the opposite of useful.
 *
 * docs/25 §5 sketched 50s against a 20s heartbeat. This is that formula with
 * the interval the runner actually uses today; when step E replaces polling
 * with a socket, the honest value drops with it.
 */
export const RUNNER_ONLINE_MS = 90_000

export function runnerIsOnline(runner, now = Date.now()) {
  if (!runner?.lastSeenAt) return false
  if (runner.status === 'disabled') return false
  return now - new Date(runner.lastSeenAt).getTime() < RUNNER_ONLINE_MS
}
