import { createHmac, timingSafeEqual } from 'node:crypto'

import { AppError } from './core/errors.mjs'

// Firing a task when the repository under test moves.
//
// The endpoint is the only one in the platform that takes an unauthenticated
// request, so everything here is written from that starting point: the request
// is hostile until the signature says otherwise, and even afterwards the
// payload is treated as a *hint about which task to run*, never as instructions
// about what to run.
//
// The distinction matters most in one place: **the checkout always uses the
// repository URL registered on the app, never the one in the payload.** A
// delivery that says "clone this other repo" would otherwise be a way to make
// the platform fetch and execute arbitrary code. The signature makes that
// unlikely; not reading the field at all makes it impossible.

/**
 * Verify a GitHub-style HMAC signature.
 *
 * Compared in constant time. A `!==` here leaks the correct prefix through
 * timing, which is enough to forge a signature given patience.
 */
export function verifySignature({ body, signature, secret }) {
  if (!secret) {
    // Fail closed. An unsigned webhook endpoint is a public "run arbitrary
    // registered jobs" button, and the failure of a missing secret should be
    // visible when it is configured, not silently permissive forever.
    throw new AppError(401, 'webhook_unverified', '该应用未配置 webhook 密钥，拒绝处理')
  }
  const presented = typeof signature === 'string' ? signature.trim() : ''
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AppError(401, 'webhook_unverified', 'webhook 签名不匹配')
  }
  return true
}

/**
 * What a delivery is about, in the platform's own terms.
 *
 * Returns null for anything that is not a branch push — pull request opened,
 * issue commented, star added. Those are answered with 200 and ignored rather
 * than rejected: an endpoint that 4xx's on every unrelated event turns the
 * provider's UI red and gets the whole webhook disabled by whoever sees it.
 */
export function parsePush({ event, payload }) {
  // GitHub sends `ping` once when the hook is created. Answering it correctly
  // is what makes the green tick appear, which is how someone knows it works.
  if (event === 'ping') return { kind: 'ping' }
  if (event !== 'push') return null

  const ref = typeof payload?.ref === 'string' ? payload.ref : ''
  if (!ref.startsWith('refs/heads/')) return null // a tag or a note, not a branch
  const branch = ref.slice('refs/heads/'.length)

  const gitSha = typeof payload?.after === 'string' ? payload.after : ''
  if (!/^[0-9a-f]{40}$/iu.test(gitSha)) return null
  // A branch deletion pushes the zero sha. There is nothing to test.
  if (/^0{40}$/u.test(gitSha)) return null

  return {
    kind: 'push',
    branch,
    gitSha: gitSha.toLowerCase(),
    // Display only. Never used to decide what to clone.
    pusher: typeof payload?.pusher?.name === 'string' ? payload.pusher.name.slice(0, 96) : null,
    message:
      typeof payload?.head_commit?.message === 'string'
        ? payload.head_commit.message.split('\n', 1)[0].slice(0, 200)
        : null,
  }
}

/**
 * The ref a task would check out, which is also the branch it reacts to.
 *
 * Derived rather than configured: a task that fires on a push to a branch it
 * would not then test is a trap, and making the two independent is how that
 * trap gets built.
 */
export function taskBranch({ suite, app }) {
  return suite?.defaultBranch?.trim() || app?.defaultBranch?.trim() || null
}
