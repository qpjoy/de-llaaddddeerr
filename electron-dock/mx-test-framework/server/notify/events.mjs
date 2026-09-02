import { redactLine } from '../core/redact.mjs'

// Deciding *whether* to say anything, and *what* to say.
//
// Delivery lives in adapters.mjs. Keeping the two apart matters because this
// file is where the judgement is, and judgement should not be entangled with
// whichever chat product the company uses this year.
//
// The rule, in one line: **notify on transitions, not on results.**
//
// A nightly job that posts "run finished" every morning gets muted within two
// weeks, and then nobody is watching when it matters. What a person actually
// needs to know is that something *changed*: it broke, or it came back. The
// second consecutive failure carries no new information — the dashboard already
// says so, and repeating it is what trains people to ignore the channel.

/** Events a channel can subscribe to. */
export const NOTIFY_EVENTS = ['failure', 'recovery', 'blocked']

/**
 * What, if anything, this run changed.
 *
 * `previous` is the most recent *finished* run of the same task. Same task,
 * not same suite: two tasks on one suite (hourly mock, nightly real) are
 * separate signals and one flipping should not silence the other.
 *
 * @returns {'failure'|'recovery'|'blocked'|null}
 */
export function resolveTransition(run, previous) {
  const now = run?.status
  const before = previous?.status ?? null

  if (now === 'failed') {
    // Already red — the dashboard has it, saying it again teaches people to
    // stop reading the channel.
    return before === 'failed' ? null : 'failure'
  }

  if (now === 'passed') {
    // Recovery is worth exactly one message. Without it, whoever silenced the
    // failure never learns it is safe to look away.
    return before === 'failed' || before === 'blocked' ? 'recovery' : null
  }

  if (now === 'blocked') {
    // Infrastructure, not the product: the browser never started, the
    // dependency install failed, the pod was evicted. Routed to the ops
    // channel, and gated the same way so a broken cluster does not post every
    // hour for a week.
    return before === 'blocked' ? null : 'blocked'
  }

  // `expired` — a desktop run nobody claimed — is deliberately silent. It is
  // not a failure, and alerting on "no one turned their laptop on" would make
  // the channel noisy in exactly the situation the queueing design accepts.
  return null
}

const firstLine = (text) => (typeof text === 'string' ? text.split('\n', 1)[0] : '')

/**
 * The message body, as structured data. Adapters turn it into their own format.
 *
 * Content follows from what the reader has to decide in the next thirty
 * seconds: is this mine, how bad, and where do I look. Hence the failing case
 * names and the last known good commit — "it broke somewhere between these two
 * commits" is the single most useful line in a failure alert.
 */
export function composeMessage({
  event,
  run,
  task,
  app,
  suite,
  cases = [],
  lastGood = null,
  baseUrl = '',
}) {
  const failed = cases
    .filter((entry) => entry.status === 'failed')
    .slice(0, 5)
    .map((entry) => ({
      caseId: entry.caseId,
      title: redactLine(entry.title, 120) || entry.caseId,
      // One line, not the stack: an alert is a pointer, not a report.
      error: redactLine(firstLine(entry.errorText), 200) || null,
    }))

  const totals = run.totals ?? {}
  return {
    event,
    title: {
      failure: `❌ 新失败 · ${app?.displayName ?? app?.slug ?? ''} / ${task?.name ?? suite?.slug ?? ''}`,
      recovery: `✅ 已恢复 · ${app?.displayName ?? app?.slug ?? ''} / ${task?.name ?? suite?.slug ?? ''}`,
      blocked: `⚠️ 执行受阻 · ${app?.displayName ?? app?.slug ?? ''} / ${task?.name ?? suite?.slug ?? ''}`,
    }[event],
    runId: run.id,
    runUrl: baseUrl ? `${baseUrl.replace(/\/$/u, '')}/runs/${run.id}` : null,
    appSlug: app?.slug ?? null,
    suiteSlug: suite?.slug ?? null,
    taskName: task?.name ?? null,
    profile: run.profile ?? null,
    status: run.status,
    totals: {
      tests: totals.tests ?? 0,
      passed: totals.passed ?? 0,
      failed: totals.failed ?? 0,
      // Registered but not executed. Surfaced in the alert because a run can be
      // "green" while quietly skipping half the catalog, and that is precisely
      // the failure mode the platform exists to make visible.
      notRun: totals.notRun ?? 0,
    },
    // Redacted: a blocked reason can quote a URL or a command line.
    blockedReason: run.blockedReason ? redactLine(run.blockedReason, 300) : null,
    failedCases: failed,
    failedCasesOmitted: Math.max(0, cases.filter((c) => c.status === 'failed').length - failed.length),
    sourceRef: run.sourceRef?.gitSha
      ? { ref: run.sourceRef.ref ?? null, gitSha: String(run.sourceRef.gitSha).slice(0, 12) }
      : null,
    // "It worked at this commit, it fails at that one" — the range to look in.
    lastGood: lastGood?.sourceRef?.gitSha
      ? {
          runId: lastGood.id,
          gitSha: String(lastGood.sourceRef.gitSha).slice(0, 12),
          finishedAt: lastGood.finishedAt ?? null,
        }
      : null,
  }
}

/** Whether a channel wants this event, and covers this app. */
export function channelWants(channel, { event, appId }) {
  if (!channel.enabled) return false
  if (channel.appId && channel.appId !== appId) return false
  const events = Array.isArray(channel.events) ? channel.events : NOTIFY_EVENTS
  return events.includes(event)
}
