// This exact TikHub refusal was observed on Threads comments (2026-11-14).
// The supplier's no-charge text is a retry hint, not proof of billing: keep
// the adapter's billed:null and archive/price every attempt independently.
const RETRY_MESSAGE = "Request failed. Please retry. Check the docs below to verify your parameters, test with the default demo parameters, and send the response JSON to support. You won't be charged for this request."

export function threadsCommentRetryDelay({ provider, request, step, workflowKind, error, retries }, { random = Math.random } = {}) {
  if (provider !== 'tikhub' || request.platform !== 'threads'
    || !['post-comments', 'comment-replies'].includes(workflowKind)
    || step.key !== 't.api_fe58186e16adc3bb' || !Number.isInteger(retries) || retries < 0 || retries >= 2) return null
  const evidence = error.evidence
  if (evidence.outcome !== 'rejected' || ![null, false].includes(evidence.billed)
    || evidence.httpStatus !== 400 || evidence.businessCode !== 400) return null
  const archive = error.restrictedResponseArchive
  if (archive?.jsonParsed !== true || archive.httpStatus !== 400) return null
  const raw = archive.parsedPayload
  const envelope = Number.isInteger(raw?.code) ? raw : raw?.detail
  if (envelope?.code !== 400 || envelope.message !== RETRY_MESSAGE) return null
  // 1–1.25 s, then 2–2.5 s. An exhausted request remains an exact replay;
  // timeout/transport/5xx uncertainty and other rejections are never retried.
  return Math.floor(1000 * 2 ** retries * (1 + random() * 0.25))
}
