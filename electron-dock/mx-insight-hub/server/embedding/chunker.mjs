// Deterministic text chunking for retrieval.
//
// Deterministic matters more than clever here: the chunker's output is keyed by
// (record_id, chunk_index, chunker_version), so the same input must always
// produce the same chunks. A chunker that depended on anything non-deterministic
// would make re-chunking produce different keys and orphan the old rows.
//
// Bump CHUNKER_VERSION for any change to the algorithm. Existing chunks then
// read as stale and are recomputed, rather than a corpus silently containing two
// incompatible chunkings.

export const CHUNKER_VERSION = 'mxih-chunker.v1'

// Target chunk size in approximate tokens. Small enough that a chunk is about
// one idea (which is what makes a vector match meaningful) and large enough to
// carry context. Overlap keeps a sentence spanning a boundary retrievable from
// either side.
const TARGET_TOKENS = 320
const OVERLAP_TOKENS = 48
const MIN_CHUNK_TOKENS = 16

const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ]/

/**
 * Approximate token count.
 *
 * CJK characters are roughly one token each; Latin text is roughly four
 * characters per token. An exact count would require the target model's
 * tokenizer, which differs per provider — and since the chunk size only needs
 * to be in the right neighbourhood, a per-provider tokenizer would add a
 * dependency and a failover hazard for no retrieval benefit.
 */
export function estimateTokens(text) {
  if (!text) return 0
  let cjk = 0
  for (const character of text) if (CJK.test(character)) cjk += 1
  const latin = text.length - cjk
  return cjk + Math.ceil(latin / 4)
}

// Sentence boundaries for mixed zh/en text. CJK punctuation is included because
// splitting Chinese on Latin periods alone yields one enormous "sentence".
const SENTENCE_BOUNDARY = /(?<=[。！？；\n])|(?<=[.!?;]\s)/

function splitSentences(text) {
  return text
    .split(SENTENCE_BOUNDARY)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

/**
 * Split text into overlapping chunks on sentence boundaries.
 *
 * A sentence longer than the target is emitted whole rather than cut mid-way:
 * a chunk that starts and ends mid-sentence embeds poorly, and one oversized
 * chunk costs less retrieval quality than several truncated ones.
 */
export function chunkText(text, { targetTokens = TARGET_TOKENS, overlapTokens = OVERLAP_TOKENS } = {}) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!normalized) return []

  const sentences = splitSentences(normalized)
  const chunks = []
  let current = []
  let currentTokens = 0

  for (const sentence of sentences) {
    const tokens = estimateTokens(sentence)
    if (currentTokens > 0 && currentTokens + tokens > targetTokens) {
      chunks.push(current.join(' '))
      // Carry the tail of the previous chunk forward so a sentence spanning the
      // boundary is retrievable from either chunk.
      const overlap = []
      let overlapSize = 0
      for (let index = current.length - 1; index >= 0 && overlapSize < overlapTokens; index -= 1) {
        overlap.unshift(current[index])
        overlapSize += estimateTokens(current[index])
      }
      current = overlap
      currentTokens = overlapSize
    }
    current.push(sentence)
    currentTokens += tokens
  }
  if (current.length > 0) chunks.push(current.join(' '))

  // Drop a trailing fragment that is only overlap. It carries no new content and
  // would compete with the chunk it was copied from at retrieval time.
  return chunks
    .map((chunk) => chunk.trim())
    .filter((chunk, index) => chunk && (index === 0 || estimateTokens(chunk) >= MIN_CHUNK_TOKENS))
}

/**
 * Build the chunk set for one canonical record.
 *
 * The title is prepended to the first chunk rather than emitted as its own:
 * a title alone is usually too short to embed meaningfully, but it is exactly
 * the context that disambiguates the opening of the body.
 */
export function chunkRecord(record, options = {}) {
  const title = (record.title || '').trim()
  const body = (record.body || '').trim()
  const combined = title && body ? `${title}\n\n${body}` : title || body
  const pieces = chunkText(combined, options)

  return pieces.map((content, index) => ({
    chunkIndex: index,
    content,
    tokenCount: estimateTokens(content),
    chunkerVersion: CHUNKER_VERSION,
    sourceRevision: record.current_revision ?? 1,
  }))
}
