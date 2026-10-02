// What a mission spends, and how its conversation stays small enough to send.

import { REFERENCE } from './finding.mjs'

// Roughly where a long Agent conversation starts costing more than it tells
// the model: past this, the oldest tool results are shortened.
export const CONTEXT_CHAR_BUDGET = 60_000
const KEEP_RECENT_TOOL_RESULTS = 6
const COMPACTED = '（已压缩的较早工具结果'

/**
 * A rough token count for when a provider does not report one. CJK text is
 * about one token a character, other text about four characters a token;
 * inline images are left out rather than counted as base64 text.
 */
export function estimateTokens(value) {
  const text = (typeof value === 'string' ? value : JSON.stringify(value ?? '')).replace(
    /data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g,
    ''
  )
  const cjk = (text.match(/[㐀-鿿぀-ヿ가-힯]/g) ?? []).length
  return cjk + Math.ceil((text.length - cjk) / 4)
}

/** Add one model turn to the mission's meter. */
export function meter(row, { body, result }) {
  const usage = result?.usage ?? null
  const promptTokens = usage?.promptTokens ?? estimateTokens(body?.messages ?? [])
  const completionTokens =
    usage?.completionTokens ??
    estimateTokens(
      `${result?.message?.content ?? ''}${JSON.stringify(result?.message?.tool_calls ?? '')}`
    )
  row.usage ??= { calls: 0, promptTokens: 0, completionTokens: 0, estimated: false, byProvider: {} }
  row.usage.calls += 1
  row.usage.promptTokens += promptTokens
  row.usage.completionTokens += completionTokens
  if (!usage) row.usage.estimated = true
  const provider = result?.provider?.id ?? 'unknown'
  row.usage.byProvider[provider] =
    (row.usage.byProvider[provider] ?? 0) + promptTokens + completionTokens
  return row.usage
}

export function totalTokens(row) {
  return (row.usage?.promptTokens ?? 0) + (row.usage?.completionTokens ?? 0)
}

const size = (messages) =>
  JSON.stringify(messages).replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g, '').length

/**
 * Shorten the oldest tool results once the conversation grows past budget.
 *
 * The message stays — same role, same call id — so the transcript is still a
 * valid call/answer sequence, and the run and case IDs it mentioned are kept
 * in the short form, so a later conclusion can still be checked against what
 * the mission actually read. Returns how many results were shortened.
 */
export function compactMessages(
  messages,
  { budget = CONTEXT_CHAR_BUDGET, keepRecent = KEEP_RECENT_TOOL_RESULTS } = {}
) {
  if (size(messages) <= budget) return 0
  const tools = messages
    .map((message, index) => (message.role === 'tool' ? index : -1))
    .filter((index) => index >= 0)
  const older = tools.slice(0, Math.max(0, tools.length - keepRecent))
  let compacted = 0
  for (const index of older) {
    if (size(messages) <= budget) break
    const message = messages[index]
    const content = String(message.content ?? '')
    if (content.startsWith(COMPACTED)) continue
    const ids = [...new Set(content.match(REFERENCE) ?? [])].slice(0, 20)
    message.content = `${COMPACTED}，原 ${content.length} 字${ids.length ? `；其中出现的 ID：${ids.join('、')}` : ''}）`
    compacted += 1
  }
  return compacted
}
