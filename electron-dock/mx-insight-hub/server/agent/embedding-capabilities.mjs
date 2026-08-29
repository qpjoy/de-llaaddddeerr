export const EMBEDDING_CAPABILITY_CATALOG_REVISION = 1
export const EMBEDDING_CAPABILITY_CATALOG_CHECKED_AT = '2026-08-29'

const OPENAI_MODELS = Object.freeze([
  Object.freeze({
    id: 'text-embedding-3-small',
    defaultDimensions: 1536,
    configurableDimensions: true,
    allowedDimensions: Object.freeze({ minimum: 1, maximum: 1536 }),
  }),
  Object.freeze({
    id: 'text-embedding-3-large',
    defaultDimensions: 3072,
    configurableDimensions: true,
    allowedDimensions: Object.freeze({ minimum: 1, maximum: 3072 }),
  }),
  Object.freeze({
    id: 'text-embedding-ada-002',
    defaultDimensions: 1536,
    configurableDimensions: false,
    allowedDimensions: Object.freeze({ minimum: 1536, maximum: 1536 }),
  }),
])

const CATALOG = Object.freeze([
  Object.freeze({
    vendor: 'openai',
    hosts: Object.freeze(['api.openai.com']),
    protocols: Object.freeze(['openai-compatible']),
    status: 'supported',
    endpointPath: '/embeddings',
    reason: 'OpenAI 官方提供 Embeddings API；请为 Embedding 单独选择受支持的模型。',
    source: 'https://developers.openai.com/api/docs/guides/embeddings',
    models: OPENAI_MODELS,
  }),
  Object.freeze({
    vendor: 'anthropic',
    hosts: Object.freeze(['api.anthropic.com']),
    protocols: Object.freeze(['anthropic-messages']),
    status: 'unsupported',
    endpointPath: null,
    reason: 'Anthropic 官方不提供自有 Embedding 模型。',
    source: 'https://platform.claude.com/docs/en/build-with-claude/embeddings',
    models: Object.freeze([]),
  }),
  Object.freeze({
    vendor: 'deepseek',
    hosts: Object.freeze(['api.deepseek.com']),
    protocols: Object.freeze(['openai-compatible', 'anthropic-messages']),
    status: 'unsupported',
    endpointPath: null,
    reason: 'DeepSeek 当前官方 API Reference 未提供 Embeddings API。',
    source: 'https://api-docs.deepseek.com/api/create-chat-completion/',
    models: Object.freeze([]),
  }),
  Object.freeze({
    vendor: 'kimi',
    hosts: Object.freeze(['api.moonshot.ai', 'api.moonshot.cn']),
    protocols: Object.freeze(['openai-compatible', 'anthropic-messages']),
    status: 'unsupported',
    endpointPath: null,
    reason: 'Kimi 当前官方 API endpoint 列表未提供 Embeddings API。',
    source: 'https://platform.kimi.ai/docs/api/overview',
    models: Object.freeze([]),
  }),
])

function hostnameOf(baseUrl) {
  try {
    return new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return null
  }
}

function copyDimensions(value) {
  return value == null ? null : { ...value }
}

function copyModel(model) {
  return {
    ...model,
    allowedDimensions: copyDimensions(model.allowedDimensions),
  }
}

function commonResult(entry) {
  return {
    status: entry.status,
    vendor: entry.vendor,
    reason: entry.reason,
    endpointPath: entry.endpointPath,
    knownModels: entry.models.map(copyModel),
    checkedAt: EMBEDDING_CAPABILITY_CATALOG_CHECKED_AT,
    revision: EMBEDDING_CAPABILITY_CATALOG_REVISION,
  }
}

/**
 * Classify whether a Provider connection can be reused for embeddings.
 * Unknown OpenAI-compatible services stay probe-required instead of being
 * rejected: compatibility with Chat Completions does not prove /embeddings.
 */
export function classifyEmbeddingConnection(provider = {}) {
  const protocol = provider.protocol || 'openai-compatible'
  const hostname = hostnameOf(provider.baseUrl)
  const official = CATALOG.find((entry) => hostname && entry.hosts.includes(hostname))

  if (official) {
    if (official.status === 'supported' && !official.protocols.includes(protocol)) {
      return commonResult({
        ...official,
        status: 'unsupported',
        endpointPath: null,
        reason: '该 Provider 协议不能调用 OpenAI-compatible /embeddings。',
      })
    }
    return commonResult(official)
  }

  if (protocol !== 'openai-compatible') {
    return commonResult({
      status: 'unsupported',
      vendor: 'custom',
      reason: '当前 Embedding 调用仅支持 OpenAI-compatible /embeddings 协议。',
      endpointPath: null,
      models: [],
    })
  }

  return commonResult({
    status: 'probe-required',
    vendor: 'custom',
    reason: hostname
      ? '该 OpenAI-compatible 服务的 Embedding 能力未知，启用前必须连接测试。'
      : 'Provider Base URL 无法识别，启用 Embedding 前必须连接测试。',
    endpointPath: '/embeddings',
    models: [],
  })
}

/** Classify one embedding model without turning an unknown model into a ban. */
export function classifyEmbeddingModel(provider = {}, model = provider.model) {
  const connection = classifyEmbeddingConnection(provider)
  const modelId = typeof model === 'string' ? model.trim() : ''

  if (connection.status !== 'supported') {
    return {
      ...connection,
      model: modelId,
      defaultDimensions: null,
      configurableDimensions: false,
      allowedDimensions: null,
    }
  }

  const known = connection.knownModels.find((entry) => entry.id === modelId)
  if (!known) {
    return {
      ...connection,
      status: 'probe-required',
      reason: modelId
        ? '该模型不在当前官方 Embedding 白名单中，启用前必须连接测试。'
        : '尚未选择 Embedding 模型。',
      model: modelId,
      defaultDimensions: null,
      configurableDimensions: false,
      allowedDimensions: null,
    }
  }

  return {
    ...connection,
    model: known.id,
    defaultDimensions: known.defaultDimensions,
    configurableDimensions: known.configurableDimensions,
    allowedDimensions: copyDimensions(known.allowedDimensions),
  }
}

/** Public, credential-free catalog. Each call returns a mutation-safe copy. */
export function publicEmbeddingCapabilityCatalog() {
  return {
    revision: EMBEDDING_CAPABILITY_CATALOG_REVISION,
    checkedAt: EMBEDDING_CAPABILITY_CATALOG_CHECKED_AT,
    providers: CATALOG.map((entry) => ({
      vendor: entry.vendor,
      hosts: [...entry.hosts],
      protocols: [...entry.protocols],
      status: entry.status,
      endpointPath: entry.endpointPath,
      reason: entry.reason,
      source: entry.source,
      models: entry.models.map(copyModel),
    })),
  }
}
