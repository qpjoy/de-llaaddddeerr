import { AppError } from '../core/errors.mjs'
import { validateFieldMap, inferFieldMap } from '../ingest/external/mapping.mjs'
import {
  EmbeddingRouter,
  ProviderRouter,
  parseProviderConfig,
  validateChatResponse,
} from './providers.mjs'

export {
  ProviderRouter,
  EmbeddingRouter,
  NoProviderAvailableError,
  parseProviderConfig,
  shouldFailover,
  validateChatResponse,
} from './providers.mjs'

// The Hub's central agent.
//
// Scope is deliberately three jobs, not "an agent that can do anything":
// suggest field mappings, classify/clean records that do not match a known
// shape, and produce embeddings. Each has a deterministic fallback that runs
// when no model is configured or every provider is down, so the agent is an
// accelerator rather than a dependency.

const MAPPING_SYSTEM_PROMPT = `You map spreadsheet or database columns onto a fixed schema.
Reply with ONLY a JSON object, no prose and no code fence.

Target fields (use only these):
externalId, title, body, url, contentType, authorName, authorExternalId,
eventTime, collectedAt, language, countryCode, admin1Code, admin2Code,
latitude, longitude, metrics.likes, metrics.comments, metrics.shares,
metrics.views, metrics.bookmarks

Format: {"<targetField>": {"from": "<exact source column name>"}}

Rules:
- externalId is required. Pick the column that uniquely identifies a row.
- Use the source column names EXACTLY as given, including any CJK characters.
- Never map one source column to two target fields.
- Omit a target field entirely if no column fits. Do not invent columns.`

const FILE_PROFILE_SYSTEM_PROMPT = `${MAPPING_SYSTEM_PROMPT}

The input is a value-free structural summary sampled from the first, middle and
last records. Also infer a lowercase platform and objectType when the evidence
is clear. Reply in this envelope:
{"platform":"twitter","objectType":"post","fieldMap":{"externalId":{"from":"id"}}}
Use null for an uncertain platform or objectType. Never infer identity from a
numeric value; use only column names, value type families and aggregate signals.`

function extractJson(text) {
  if (!text) throw new AppError(502, 'agent_invalid_response', 'Model returned an empty response')
  // Models add fences and preamble despite instructions. Take the outermost
  // brace-balanced span rather than trusting the whole string to be JSON.
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new AppError(502, 'agent_invalid_response', 'Model response contained no JSON object')
  }
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    // Native JSON parse errors may quote a fragment of the model response.
    // Prompts and returned content must never enter logs or degradedReason.
    throw new AppError(502, 'agent_invalid_response', 'Model response was not valid JSON')
  }
}

function valueFreeFileSampling(sampling) {
  if (!sampling || typeof sampling !== 'object') return null
  const integer = (value) => Number.isInteger(value) && value >= 0 ? value : null
  const positions = Array.isArray(sampling.sampledPositions)
    ? sampling.sampledPositions.flatMap((item) => (
        item && ['head', 'middle', 'tail'].includes(item.position) && integer(item.index) != null
          ? [{ position: item.position, index: item.index }]
          : []
      ))
    : []
  const columns = Array.isArray(sampling.columns)
    ? sampling.columns.flatMap((column) => {
        if (!column || typeof column.name !== 'string') return []
        return [{
          name: column.name,
          presentCount: integer(column.presentCount),
          nonEmptyCount: integer(column.nonEmptyCount),
          valueTypeFamilies: Array.isArray(column.valueTypeFamilies)
            ? column.valueTypeFamilies.filter((value) => typeof value === 'string')
            : [],
        }]
      })
    : []
  const signals = Object.fromEntries(Object.entries(sampling.signals || {}).flatMap(([key, value]) => (
    typeof value === 'number' && Number.isFinite(value) ? [[key, value]] : []
  )))
  return {
    strategy: typeof sampling.strategy === 'string' ? sampling.strategy : null,
    sourceRowCount: integer(sampling.sourceRowCount),
    sampledRowCount: integer(sampling.sampledRowCount),
    sampledPositions: positions,
    sampledRowIndexes: positions.map(({ index }) => index),
    columns,
    signals,
  }
}

export class HubAgent {
  constructor({ chat, embeddings, logger = console }) {
    this.chat = chat
    this.embeddings = embeddings
    this.logger = logger
  }

  get available() {
    return Boolean(this.chat?.available)
  }

  async complete(messages, {
    temperature = 0,
    maxTokens = 1_024,
    signal,
    providerIds = null,
    sequenceKey = null,
    ignoreCircuit = false,
  } = {}) {
    const call = providerIds
      ? this.chat.callSequence.bind(this.chat, providerIds)
      : this.chat.call.bind(this.chat)
    const result = await call('/chat/completions', (provider) => ({
      model: provider.model,
      messages,
      temperature,
      max_tokens: maxTokens,
    }), { signal, validatePayload: validateChatResponse, ignoreCircuit })
    return {
      ...result,
      sequenceKey,
      requestedTemperature: temperature,
      effectiveTemperature: result.protocol === 'anthropic-messages'
        ? Math.min(1, temperature)
        : temperature,
    }
  }

  /**
   * Propose a field mapping for a set of columns.
   *
   * Always returns a proposal: with no model, or with every provider down, the
   * deterministic alias matcher answers instead. That fallback is genuinely
   * useful — most spreadsheets from a known workflow have predictable headers
   * and should never cost a model call — so the model is there for the ones
   * that do not.
   *
   * The result is a SUGGESTION. It is stored unapproved and cannot be used for
   * ingestion until a human approves it (migration 008); letting a model decide
   * how data is stored would make the data model unreproducible.
   */
  async suggestFieldMap({ columns, sampleRows = [], signal, providerIds = null, sequenceKey = null } = {}) {
    const deterministic = inferFieldMap(columns)
    if (!this.available) {
      return { fieldMap: deterministic, origin: 'inferred', model: null, confidence: null }
    }

    try {
      const result = await this.complete([
        { role: 'system', content: MAPPING_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            `Columns: ${JSON.stringify(columns)}`,
            sampleRows.length > 0 ? `Sample rows: ${JSON.stringify(sampleRows.slice(0, 3))}` : '',
            `A deterministic matcher proposed: ${JSON.stringify(deterministic)}`,
            'Correct and complete it.',
          ].filter(Boolean).join('\n'),
        },
      ], { signal, providerIds, sequenceKey })

      const raw = extractJson(result.payload?.choices?.[0]?.message?.content)
      const fieldMap = this.#sanitizeFieldMap(raw, columns)
      // Validated before it is ever returned: a model that invents a target
      // field or drops externalId must fail here, not at import time.
      validateFieldMap(fieldMap)
      return {
        fieldMap,
        origin: 'agent',
        model: `${result.provider}:${result.model}`,
        confidence: null,
        attempts: result.attempts,
      }
    } catch (error) {
      // A model failure degrades to the deterministic proposal rather than
      // blocking the operator, and says so.
      this.logger?.warn?.(`[agent] mapping suggestion failed (${error.message}); using inferred mapping`)
      return {
        fieldMap: deterministic,
        origin: 'inferred',
        model: null,
        confidence: null,
        degradedReason: error.message,
      }
    }
  }

  /**
   * Suggest source scope and mapping without sending source values to a model.
   * `sampling` is produced by the external importer and contains only column
   * names, type families and aggregate signal counts.
   */
  async suggestFileProfile({ columns, sampling = null, signal, providerIds = null, sequenceKey = null } = {}) {
    const deterministic = inferFieldMap(columns)
    const safeSampling = valueFreeFileSampling(sampling)
    if (!this.available) {
      return {
        platform: null,
        objectType: null,
        fieldMap: deterministic,
        origin: 'inferred',
        model: null,
        confidence: null,
      }
    }
    try {
      const result = await this.complete([
        { role: 'system', content: FILE_PROFILE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            `Columns: ${JSON.stringify(columns)}`,
            safeSampling ? `First/middle/last structural summary: ${JSON.stringify(safeSampling)}` : '',
            `A deterministic matcher proposed: ${JSON.stringify(deterministic)}`,
            'Correct and complete the profile.',
          ].filter(Boolean).join('\n'),
        },
      ], { signal, providerIds, sequenceKey })
      const raw = extractJson(result.payload?.choices?.[0]?.message?.content)
      const fieldMap = this.#sanitizeFieldMap(raw?.fieldMap, columns)
      validateFieldMap(fieldMap)
      const normalizedScope = (value) => (
        typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value.trim().toLowerCase())
          ? value.trim().toLowerCase()
          : null
      )
      return {
        platform: normalizedScope(raw.platform),
        objectType: normalizedScope(raw.objectType),
        fieldMap,
        origin: 'agent',
        model: `${result.provider}:${result.model}`,
        confidence: null,
        attempts: result.attempts,
      }
    } catch (error) {
      this.logger?.warn?.(`[agent] file profile failed (${error.message}); using inferred mapping`)
      return {
        platform: null,
        objectType: null,
        fieldMap: deterministic,
        origin: 'inferred',
        model: null,
        confidence: null,
        degradedReason: error.message,
      }
    }
  }

  /**
   * Drop anything the model invented.
   *
   * A hallucinated column name produces a mapping that reads plausibly and maps
   * nothing, which is the failure mode that survives review. Only columns that
   * actually exist in the file are kept, and only one target per column.
   */
  #sanitizeFieldMap(raw, columns) {
    const available = new Set(columns)
    const used = new Set()
    const fieldMap = {}
    for (const [target, rule] of Object.entries(raw || {})) {
      const from = Array.isArray(rule?.from) ? rule.from[0] : rule?.from
      if (typeof from !== 'string' || !available.has(from) || used.has(from)) continue
      fieldMap[target] = { from }
      used.add(from)
    }
    return fieldMap
  }

  /**
   * Classify a record that did not match a known shape.
   *
   * Used by the ingest path for payloads whose structure differs from the
   * stored contract. Returns null when unavailable so the caller keeps the raw
   * record rather than dropping it — an unclassified row in `extensions` is
   * recoverable, a discarded one is not.
   */
  async classifyRecord({ record, categories, signal, providerIds = null, sequenceKey = null } = {}) {
    if (!this.available) return null
    try {
      const result = await this.complete([
        {
          role: 'system',
          content: `Classify the record into exactly one of: ${categories.join(', ')}.
Reply with only {"category": "<one of the listed values>", "confidence": <0..1>}.
If none fit, use {"category": "unknown", "confidence": 0}.`,
        },
        { role: 'user', content: JSON.stringify(record).slice(0, 4_000) },
      ], { signal, providerIds, sequenceKey })
      const parsed = extractJson(result.payload?.choices?.[0]?.message?.content)
      // A category outside the allowed set is a hallucination, not a new class.
      if (!categories.includes(parsed.category) && parsed.category !== 'unknown') {
        return { category: 'unknown', confidence: 0, model: `${result.provider}:${result.model}` }
      }
      return {
        category: parsed.category,
        confidence: Number(parsed.confidence) || 0,
        model: `${result.provider}:${result.model}`,
      }
    } catch (error) {
      this.logger?.warn?.(`[agent] classification failed: ${error.message}`)
      return null
    }
  }

  /** Embed a batch of texts. Throws when unavailable: there is no fallback for a vector. */
  async embed(texts, { signal, providerIds = null, sequenceKey = null, ignoreCircuit = false } = {}) {
    if (!this.embeddings?.available) {
      throw new AppError(503, 'embeddings_not_configured', 'No embedding provider is configured')
    }
    const result = providerIds
      ? await this.embeddings.embedSequence(providerIds, texts, { signal, ignoreCircuit })
      : await this.embeddings.embed(texts, { signal, ignoreCircuit })
    return { ...result, sequenceKey }
  }

  /** Run a minimal, data-free request against exactly one provider. */
  async testProvider({ kind, providerId, signal } = {}) {
    if (!['chat', 'embedding'].includes(kind)) {
      throw new AppError(400, 'invalid_provider_kind', 'kind must be chat or embedding')
    }
    if (typeof providerId !== 'string' || !providerId) {
      throw new AppError(400, 'invalid_provider_id', 'providerId is required')
    }
    let result
    if (kind === 'chat') {
      result = await this.chat.callProvider(providerId, '/chat/completions', (provider) => ({
        model: provider.model,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        temperature: 0,
        max_tokens: 8,
      }), { signal, validatePayload: validateChatResponse })
    } else {
      result = await this.embeddings.embedProvider(
        providerId,
        ['MX Insight Hub provider connectivity test'],
        { signal },
      )
    }
    return {
      ok: true,
      kind,
      providerId: result.provider,
      model: result.model,
      latencyMs: result.latencyMs,
      testedAt: new Date().toISOString(),
    }
  }

  status() {
    return {
      chat: this.chat?.available ? this.chat.status() : [],
      embeddings: this.embeddings?.available ? this.embeddings.status() : [],
      embeddingDimensions: this.embeddings?.dimensions ?? null,
    }
  }
}

export function createAgent({ config, logger = console }) {
  const chatProviders = parseProviderConfig(config.agent.chatProviders, { kind: 'chat' })
  const embeddingProviders = parseProviderConfig(config.agent.embeddingProviders, { kind: 'embedding' })

  return createAgentFromProviders({
    chatProviders,
    embeddingProviders,
    expectedEmbeddingDimensions: config.embedding?.dimensions ?? null,
    logger,
  })
}

/** Construct from already validated providers (used by the DB-backed runtime). */
export function createAgentFromProviders({
  chatProviders,
  embeddingProviders,
  expectedEmbeddingDimensions = null,
  logger = console,
  fetchImpl = globalThis.fetch,
}) {
  return new HubAgent({
    chat: new ProviderRouter({ providers: chatProviders, logger, fetchImpl }),
    embeddings: new EmbeddingRouter({
      providers: embeddingProviders,
      expectedDimensions: expectedEmbeddingDimensions,
      logger,
      fetchImpl,
    }),
    logger,
  })
}
