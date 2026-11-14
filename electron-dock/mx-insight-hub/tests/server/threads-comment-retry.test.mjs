import test from 'node:test'
import assert from 'node:assert/strict'
import { threadsCommentRetryDelay } from '../../server/external-platforms/threads-comment-retry.mjs'

const message = "Request failed. Please retry. Check the docs below to verify your parameters, test with the default demo parameters, and send the response JSON to support. You won't be charged for this request."
function attempt() {
  return { provider: 'tikhub', request: { platform: 'threads' }, step: { key: 't.api_fe58186e16adc3bb' },
    workflowKind: 'post-comments', retries: 0, error: {
      evidence: { outcome: 'rejected', billed: null, httpStatus: 400, businessCode: 400 },
      restrictedResponseArchive: { jsonParsed: true, httpStatus: 400, parsedPayload: { detail: { code: 400, message } } },
    } }
}

test('Threads comment retry doubles its bounded jittered delay and permits only two additional attempts', () => {
  for (const workflowKind of ['post-comments', 'comment-replies']) {
    const input = { ...attempt(), workflowKind }
    assert.equal(threadsCommentRetryDelay(input, { random: () => 0 }), 1000)
    assert.equal(threadsCommentRetryDelay(input, { random: () => 0.9999 }), 1249)
    input.retries = 1
    assert.equal(threadsCommentRetryDelay(input, { random: () => 0 }), 2000)
    assert.equal(threadsCommentRetryDelay(input, { random: () => 0.9999 }), 2499)
    for (const retries of [-1, 2, 3, Infinity]) assert.equal(threadsCommentRetryDelay({ ...input, retries }), null)
  }
})

test('retry is restricted to the reviewed TikHub Threads business endpoints and exact refusal', () => {
  const edits = {
    provider: input => { input.provider = 'rapidapi' },
    platform: input => { input.request.platform = 'twitter' },
    native: input => { input.workflowKind = 'native-forwarding' },
    search: input => { input.workflowKind = 'threads-search' },
    account: input => { input.workflowKind = 'social-account' },
    endpoint: input => { input.step.key = 't.another_endpoint' },
    malformed: input => { input.error.restrictedResponseArchive.jsonParsed = false },
    missingArchive: input => { input.error.restrictedResponseArchive = null },
    another400: input => { input.error.restrictedResponseArchive.parsedPayload.detail.message = 'Bad Request' },
    misleadingText: input => { input.error.restrictedResponseArchive.parsedPayload.detail.message += ' different error' },
    badCode: input => { input.error.restrictedResponseArchive.parsedPayload.detail.code = 422 },
    conflictingEnvelope: input => { input.error.restrictedResponseArchive.parsedPayload.code = 200 },
  }
  for (const [name, edit] of Object.entries(edits)) {
    const input = attempt(); edit(input)
    assert.equal(threadsCommentRetryDelay(input), null, name)
  }
  const root = attempt()
  root.error.restrictedResponseArchive.parsedPayload = { code: 400, message }
  assert.equal(threadsCommentRetryDelay(root, { random: () => 0 }), 1000)
})

test('known billing, uncertain outcomes, rate limits and non-400 failures do not become automatic retries', () => {
  for (const patch of [{ billed: true }, { outcome: 'unknown' }, { outcome: 'succeeded_unusable' },
    { httpStatus: null }, { httpStatus: 429 }, { httpStatus: 500 }, { businessCode: null }]) {
    const input = attempt()
    Object.assign(input.error.evidence, patch)
    assert.equal(threadsCommentRetryDelay(input), null, JSON.stringify(patch))
  }
  const input = attempt()
  threadsCommentRetryDelay(input)
  assert.equal(input.error.evidence.billed, null, 'A supplier no-charge claim must not rewrite the ledger evidence')
})
