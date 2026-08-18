import {
  DEFAULT_SEARCH_PROFILE,
  POSTGRES_SEARCH_PROFILE,
  searchCapabilities,
} from './search/profiles.mjs'

const PUBLIC_SEARCH_PROFILE_IDS = Object.freeze(
  searchCapabilities({ audience: 'public' }).profiles.map((profile) => profile.id),
)

const errorResponse = {
  description: 'Request failed. The response contains a stable error code and requestId.',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ErrorEnvelope' },
    },
  },
}

const publicErrors = Object.fromEntries(
  [400, 401, 403, 404, 409, 410, 429, 502, 503].map((status) => [status, errorResponse]),
)

const telegramHistoryParameters = [
  {
    name: 'chatId', in: 'query', required: false,
    description: 'Exact normalized Telegram chat identifier.',
    schema: { type: 'string', minLength: 1, maxLength: 256 },
  },
  {
    name: 'from', in: 'query', required: false,
    description: 'Inclusive RFC3339 event-time lower bound.',
    schema: { type: 'string', format: 'date-time' },
  },
  {
    name: 'to', in: 'query', required: false,
    description: 'Inclusive RFC3339 event-time upper bound.',
    schema: { type: 'string', format: 'date-time' },
  },
  {
    name: 'pageSize', in: 'query', required: false,
    description: 'Defaults to 50; the API-key policy may impose a lower maximum.',
    schema: { type: 'integer', minimum: 1, maximum: 100 },
  },
  {
    name: 'cursor', in: 'query', required: false,
    description: 'Opaque nextCursor returned by the previous page. Return it unchanged.',
    schema: { type: 'string', minLength: 1, maxLength: 1024 },
  },
]

const resultTypeProperty = {
  type: 'string',
  enum: ['fresh', 'stable'],
  default: 'fresh',
  description: "Result freshness. 'fresh' always searches current data and replays a committed response only within 120 seconds, which covers a retry without turning the key into a cache. 'stable' replays the first response for that key indefinitely, for snapshots that must stay reproducible. Part of the request fingerprint.",
}

const idempotencyParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  description: 'The key is global within one consumer. Reuse it only when retrying the exact same path and normalized body; a new path, body or page requires a new key.',
  schema: {
    type: 'string',
    minLength: 8,
    maxLength: 128,
    pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$',
  },
}

const searchResponse = {
  description: 'Stable data-search response.',
  headers: {
    'x-mx-insight-request-id': {
      description: 'Durable request identifier for status lookup.',
      schema: { type: 'string', format: 'uuid' },
    },
    'idempotent-replay': {
      description: 'Whether the stored result of the same idempotent request was returned.',
      schema: { type: 'string', enum: ['true', 'false'] },
    },
  },
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/SearchEnvelope' },
    },
  },
}

const storedSearchResponse = {
  description: 'Hub canonical stored-search response.',
  headers: searchResponse.headers,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/StoredSearchEnvelope' },
    },
  },
}

const canonicalSearchResponse = {
  description: 'Source-independent search across the caller\'s granted Hub canonical corpus.',
  headers: searchResponse.headers,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/CanonicalSearchEnvelope' },
    },
  },
}

export const PUBLIC_OPENAPI_DOCUMENT = {
  openapi: '3.1.0',
  info: {
    title: 'MX Insight Hub Open API',
    version: '1.0.0',
    description: [
      'Consumer-facing data and tool access only. All endpoints require an issued API key and enforce the consumer\'s explicit platform or capability grants, policy and usage quota.',
      'No management endpoints, physical data-source coordinates, credentials or raw source rows are part of this contract.',
    ].join('\n\n'),
  },
  servers: [{ url: '/api/v1', description: 'Same-origin public API' }],
  tags: [
    { name: 'Discovery', description: 'Discover the caller\'s granted platform capabilities.' },
    { name: 'Search', description: 'Idempotent content search.' },
    { name: 'Tools', description: 'Granted platform-independent processing capabilities.' },
    {
      name: 'Telegram',
      description: 'Hub-stored Telegram history, search and entities. Every consumer granted telegram reads the same complete canonical corpus; tenant-specific row subsets are not implemented.',
    },
    { name: 'Evidence', description: 'Request outcome and usage evidence for the current consumer.' },
  ],
  security: [{ bearerKey: [] }, { apiKeyHeader: [] }],
  paths: {
    '/data/capabilities': {
      get: {
        tags: ['Discovery'],
        operationId: 'listPublicCapabilities',
        summary: 'List capabilities granted to the authenticated consumer',
        description: 'Use this response to decide which platform operations and generic capabilities the current API key may call. Each entry must be both granted and ready.',
        responses: {
          200: {
            description: 'Granted public capabilities.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CapabilitiesEnvelope' },
                example: {
                  data: {
                    platforms: [{
                      platform: 'telegram',
                      ready: true,
                      capabilities: ['monitor_chats', 'monitor_messages', 'stored_search', 'entity_search'],
                    }],
                    capabilities: [{ capability: 'nlp.tokenize', ready: true }],
                  },
                  requestId: '00000000-0000-4000-8000-000000000001',
                },
              },
            },
          },
          401: errorResponse,
        },
      },
    },
    '/data/search': {
      post: {
        tags: ['Search'],
        operationId: 'searchData',
        summary: 'Search one explicitly selected platform',
        description: 'One request targets one granted platform. For platform=telegram, Hub searches canonical stored messages. Each page uses its own idempotency key; replay the same body with the same key.',
        parameters: [idempotencyParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SearchRequest' },
              examples: {
                telegram: {
                  summary: 'Telegram stored search',
                  value: { platform: 'telegram', query: 'AI Agent', pageSize: 20 },
                },
                platform: {
                  summary: 'Another granted platform',
                  value: { platform: 'xiaohongshu', query: 'AI Agent', pageSize: 20 },
                },
              },
            },
          },
        },
        responses: { 200: searchResponse, ...publicErrors },
      },
    },
    '/data/stored/search': {
      post: {
        tags: ['Search'],
        operationId: 'searchStoredData',
        summary: 'Search Hub canonical data without calling an upstream provider',
        description: 'Requires the explicit platform grant. datasetId and objectType are exact filters, not separate authorization grants: every consumer granted a platform can search the complete Hub canonical corpus for that platform. Elasticsearch is preferred and transport failure falls back to PostgreSQL. Physical databases, indices and query DSL are not accepted.',
        parameters: [idempotencyParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/StoredSearchRequest' },
              example: {
                platform: 'xiaohongshu',
                query: 'AI Agent',
                datasetId: 'night-all.search.v1',
                objectType: 'post',
                pageSize: 20,
              },
            },
          },
        },
        responses: { 200: storedSearchResponse, ...publicErrors },
      },
    },
    '/data/canonical/search': {
      post: {
        tags: ['Search'],
        operationId: 'searchCanonicalData',
        summary: 'Search all authorized Hub canonical datasets in one ranked result set',
        description: 'Searches the shared Hub canonical current-state projection once; it does not fan out to source APIs. Omitting platform searches all platforms currently granted to the consumer. platform, datasetId and objectType only narrow that authorized scope. searchProfile selects a versioned, server-owned query policy; callers cannot supply analyzers or Elasticsearch DSL. Balanced search uses HanLP/pre-segmented AND only while query segmentation is healthy; degraded Jieba/bigram terms switch the applied profile to raw phrase. The signed cursor is bound to the sorted platform-grant scope, query, filters, page size, resolved search profile and first-page analysis state so later pages do not re-segment. The independent canonical-search usage bucket always uses the strictest limits across the consumer\'s complete current grant set. Elasticsearch is preferred and PostgreSQL is the explicit degradation path.',
        parameters: [idempotencyParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CanonicalSearchRequest' },
              examples: {
                telegramAllSources: {
                  summary: 'Telegram monitor and SQLite-import datasets together',
                  value: { platform: 'telegram', query: 'AI Agent', objectType: 'message', searchProfile: DEFAULT_SEARCH_PROFILE, pageSize: 20 },
                },
                allGrantedPlatforms: {
                  summary: 'All platforms granted to this consumer',
                  value: { query: 'AI Agent', pageSize: 20 },
                },
              },
            },
          },
        },
        responses: { 200: canonicalSearchResponse, ...publicErrors },
      },
    },
    '/tools/tokenize': {
      post: {
        tags: ['Tools'],
        operationId: 'tokenizeText',
        summary: 'Tokenize bounded Chinese or mixed-language text',
        description: 'Requires an issued API Key and the nlp.tokenize capability grant. New or never-configured consumers receive it by default; administrators may explicitly disable it. The default is 1000 requests per rolling 3600-second consumer + capability window, shared by all API Keys for that consumer. The response reports the backend actually used and whether fallback degraded the result. Idempotency-Key is required; an exact replay is not segmented or metered twice.',
        parameters: [idempotencyParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/TokenizeRequest' },
              example: { text: '吴恩达与人工智能' },
            },
          },
        },
        responses: {
          200: {
            description: 'Bounded tokens and actual backend metadata.',
            headers: {
              'x-mx-insight-request-id': { schema: { type: 'string', format: 'uuid' } },
              'idempotent-replay': { schema: { type: 'string', enum: ['true', 'false'] } },
            },
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/TokenizeEnvelope' },
              },
            },
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          409: errorResponse,
          413: errorResponse,
          429: errorResponse,
          503: errorResponse,
        },
      },
    },
    '/data/telegram/chats': {
      get: {
        tags: ['Telegram'],
        operationId: 'listTelegramChats',
        summary: 'List normalized Telegram chats from Hub storage',
        description: 'Requires the telegram grant. Every granted consumer reads the same complete Hub canonical corpus; tenant-specific row subsets are not implemented. Results use descending event-time keyset pagination. This safe GET is separately metered on every call and retry.',
        parameters: telegramHistoryParameters,
        responses: {
          200: {
            description: 'A page of normalized Telegram chats.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/TelegramPageEnvelope' } } },
          },
          ...publicErrors,
        },
      },
    },
    '/data/telegram/messages': {
      get: {
        tags: ['Telegram'],
        operationId: 'listTelegramMessages',
        summary: 'List normalized Telegram messages from Hub storage',
        description: 'Requires the telegram grant. Every granted consumer reads the same complete Hub canonical corpus; tenant-specific row subsets are not implemented. Filter by exact chatId and/or inclusive event-time bounds. Return nextCursor unchanged; offset pagination is not supported.',
        parameters: telegramHistoryParameters,
        responses: {
          200: {
            description: 'A page of normalized Telegram messages.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/TelegramPageEnvelope' },
                example: {
                  data: {
                    items: [{
                      id: '-1001234567890:42',
                      externalId: '-1001234567890:42',
                      platform: 'telegram',
                      objectType: 'message',
                      contentType: 'text',
                      title: null,
                      text: 'Example normalized message',
                      url: null,
                      author: { id: '12345', name: 'Example', username: 'example_user' },
                      relations: { chatId: '-1001234567890', messageId: '42' },
                      attributes: {},
                      metrics: { views: 10 },
                      media: {},
                      entities: [],
                      links: [],
                      eventTime: '2026-08-09T08:00:00.000Z',
                      collectedAt: '2026-08-09T08:01:00.000Z',
                      editedAt: null,
                      lineage: { datasetId: 'telegram.monitor.messages.v1', origin: 'hub-direct' },
                      dataVersion: '2',
                    }],
                    pageInfo: { returnedCount: 1, hasMore: false, nextCursor: null },
                  },
                  requestId: '00000000-0000-4000-8000-000000000002',
                },
              },
            },
          },
          ...publicErrors,
        },
      },
    },
    '/data/telegram/search': {
      post: {
        tags: ['Telegram'],
        operationId: 'searchTelegram',
        summary: 'Advanced search across canonical Telegram messages and chats',
        description: 'Requires the telegram grant. Ranked full-text search uses the governed search projection and a documented PostgreSQL fallback. The version-3 opaque cursor is bound to the query, filters and bounded first-page analysis state, so later pages do not call the segmenter again. HanLP degradation applies raw phrase and reports search_profile_degraded.',
        parameters: [idempotencyParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/TelegramSearchRequest' },
              example: {
                query: 'AI Agent',
                scope: 'messages',
                chatId: '-1001234567890',
                from: '2026-08-01T00:00:00Z',
                matchMode: 'full_text',
                pageSize: 20,
              },
            },
          },
        },
        responses: { 200: searchResponse, ...publicErrors },
      },
    },
    '/data/telegram/entities/search': {
      get: {
        tags: ['Telegram'],
        operationId: 'searchTelegramEntities',
        summary: 'Fuzzy-search Telegram authors and chats',
        description: 'Searches author names/usernames and chat titles/usernames. This safe GET is separately metered and does not use an idempotency key.',
        parameters: [
          {
            name: 'query', in: 'query', required: true,
            schema: { type: 'string', minLength: 1, maxLength: 200 },
          },
          {
            name: 'pageSize', in: 'query', required: false,
            schema: { type: 'integer', minimum: 1, maximum: 100 },
          },
        ],
        responses: {
          200: {
            description: 'Ranked author/chat entity union.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/EntitySearchEnvelope' } } },
          },
          ...publicErrors,
        },
      },
    },
    '/requests/{requestId}': {
      get: {
        tags: ['Evidence'],
        operationId: 'getPublicRequestStatus',
        summary: 'Read the outcome of a request owned by this consumer',
        description: 'Use x-mx-insight-request-id from a search response. An unknown status is ambiguous: do not repeat with a new idempotency key.',
        parameters: [{
          name: 'requestId', in: 'path', required: true,
          schema: { type: 'string', format: 'uuid' },
        }],
        responses: {
          200: {
            description: 'Caller-owned request status.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/RequestStatusEnvelope' } } },
          },
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    '/usage': {
      get: {
        tags: ['Evidence'],
        operationId: 'getPublicUsage',
        summary: 'Read usage for the authenticated consumer',
        parameters: [
          { name: 'from', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } },
        ],
        responses: {
          200: {
            description: 'Consumer-scoped usage summary.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/UsageEnvelope' } } },
          },
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerKey: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'MX-API-Key',
        description: 'Authorization: Bearer <issued API key>',
      },
      apiKeyHeader: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
        description: 'Alternative to the Bearer header.',
      },
    },
    schemas: {
      SearchRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['platform', 'query'],
        properties: {
          platform: { type: 'string', minLength: 1, description: 'One explicit granted platform; wildcards and all are invalid.' },
          query: { type: 'string', minLength: 1, maxLength: 500 },
          pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          cursor: { type: 'string', minLength: 1, maxLength: 8192, description: 'Opaque nextCursor from the prior page.' },
          type: resultTypeProperty,
        },
      },
      StoredSearchRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['platform', 'query'],
        properties: {
          platform: { type: 'string', minLength: 1, maxLength: 64, description: 'One explicit granted platform; wildcards and all are invalid.' },
          query: { type: 'string', minLength: 1, maxLength: 500 },
          datasetId: { type: 'string', minLength: 1, maxLength: 200, description: 'Optional exact logical dataset filter; not a physical database or authorization grant.' },
          objectType: { type: 'string', minLength: 1, maxLength: 100, description: 'Optional exact canonical object-type filter.' },
          pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          cursor: { type: 'string', minLength: 1, maxLength: 8192, description: 'HMAC-signed opaque nextCursor bound to the normalized query and filters.' },
          type: resultTypeProperty,
        },
      },
      CanonicalSearchRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 500 },
          platform: { type: 'string', minLength: 1, maxLength: 64, description: 'Optional exact platform filter. It must already be granted; omit it to search every currently granted platform.' },
          datasetId: { type: 'string', minLength: 1, maxLength: 200, description: 'Optional exact logical dataset filter; never a physical source selector or authorization grant.' },
          objectType: { type: 'string', minLength: 1, maxLength: 100, description: 'Optional exact canonical object-type filter.' },
          searchProfile: {
            type: 'string',
            enum: PUBLIC_SEARCH_PROFILE_IDS,
            default: DEFAULT_SEARCH_PROFILE,
            description: 'Versioned server-owned search policy. Healthy HanLP/pre-segmented terms drive the default AND branch; degraded fallback terms cause an explicit phrase-only applied profile. Arbitrary analyzers, tokenizers, filters and Elasticsearch DSL are not accepted.',
          },
          pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          cursor: { type: 'string', minLength: 1, maxLength: 8192, description: 'HMAC-signed opaque nextCursor bound to the query, filters, page size, resolved search profile, authorized platform scope and bounded first-page analysis state.' },
          type: resultTypeProperty,
        },
      },
      TokenizeRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: {
            type: 'string', minLength: 1, maxLength: 4096,
            description: 'Must contain at least one Unicode letter or number; control characters are rejected.',
          },
        },
      },
      TelegramSearchRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 500 },
          scope: { type: 'string', enum: ['messages', 'chats', 'all'], default: 'messages' },
          chatId: { type: 'string', minLength: 1, maxLength: 256 },
          authorId: { type: 'string', minLength: 1, maxLength: 256 },
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
          matchMode: { type: 'string', enum: ['full_text'], default: 'full_text' },
          pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          cursor: { type: 'string', minLength: 1, maxLength: 8192, description: 'HMAC-signed version-3 cursor bound to query, filters and bounded first-page analysis state; return unchanged.' },
        },
      },
      PageInfo: {
        type: 'object',
        required: ['returnedCount', 'hasMore', 'nextCursor'],
        properties: {
          returnedCount: { type: 'integer', minimum: 0 },
          hasMore: { type: 'boolean' },
          nextCursor: { type: ['string', 'null'] },
        },
      },
      SearchItem: {
        type: 'object',
        required: ['id', 'externalId', 'platform', 'text'],
        properties: {
          id: { type: 'string' }, externalId: { type: 'string' }, platform: { type: 'string' },
          contentType: { type: ['string', 'null'] }, url: { type: ['string', 'null'] },
          title: { type: ['string', 'null'] }, text: { type: ['string', 'null'] },
          publishedAt: { type: ['string', 'null'], format: 'date-time' },
          collectedAt: { type: ['string', 'null'], format: 'date-time' },
          author: { type: ['object', 'null'], additionalProperties: true },
          metrics: { type: 'object', additionalProperties: { type: ['number', 'null'] } },
          media: { type: 'object', additionalProperties: true },
          source: { type: 'object', additionalProperties: true },
        },
      },
      SearchEnvelope: {
        type: 'object',
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object',
            required: ['contractVersion', 'platform', 'query', 'items', 'pageInfo', 'status', 'warnings', 'meta'],
            properties: {
              contractVersion: { type: 'string', example: 'night-all.data-search.v1' },
              platform: { type: 'string' }, query: { type: 'string' },
              items: { type: 'array', items: { $ref: '#/components/schemas/SearchItem' } },
              pageInfo: { $ref: '#/components/schemas/PageInfo' },
              status: { type: 'string' }, warnings: { type: 'array', items: { type: 'string' } },
              meta: { type: 'object', additionalProperties: true },
            },
          },
          requestId: { type: 'string' },
          traceId: { type: 'string' },
        },
      },
      StoredSearchItem: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'datasetId', 'platform', 'objectType', 'source'],
        properties: {
          id: { type: 'string', format: 'uuid' }, datasetId: { type: 'string' }, platform: { type: 'string' },
          objectType: { type: 'string' }, contentType: { type: ['string', 'null'] }, externalId: { type: 'string' },
          url: { type: ['string', 'null'] }, title: { type: ['string', 'null'] }, text: { type: ['string', 'null'] },
          author: { type: 'object', additionalProperties: false, properties: {
            id: { type: ['string', 'null'] }, name: { type: ['string', 'null'] }, username: { type: ['string', 'null'] },
          } },
          metrics: { type: 'object', additionalProperties: { type: ['number', 'null'] } },
          eventTime: { type: ['string', 'null'], format: 'date-time' },
          collectedAt: { type: ['string', 'null'], format: 'date-time' },
          score: { type: ['number', 'null'] }, source: { type: 'string', const: 'hub' },
        },
      },
      StoredSearchPageInfo: {
        type: 'object',
        additionalProperties: false,
        required: ['pageIndex', 'pageSize', 'returnedCount', 'hasMore', 'nextCursor', 'cursorType'],
        properties: {
          pageIndex: { type: 'integer', minimum: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 100 },
          returnedCount: { type: 'integer', minimum: 0, maximum: 100 }, hasMore: { type: 'boolean' },
          nextCursor: { type: ['string', 'null'], maxLength: 8192 },
          cursorType: { type: 'string', enum: ['opaque', 'none'] },
        },
      },
      CanonicalSearchPageInfo: {
        type: 'object',
        additionalProperties: false,
        required: ['pageIndex', 'pageSize', 'returnedCount', 'totalCount', 'totalRelation', 'totalPages', 'hasMore', 'nextCursor', 'cursorType'],
        properties: {
          pageIndex: { type: 'integer', minimum: 1 },
          pageSize: { type: 'integer', minimum: 1, maximum: 100 },
          returnedCount: { type: 'integer', minimum: 0, maximum: 100 },
          totalCount: { type: ['integer', 'null'], minimum: 0 },
          totalRelation: { type: 'string', enum: ['eq', 'gte', 'unknown'] },
          totalPages: { type: ['integer', 'null'], minimum: 0 },
          hasMore: { type: 'boolean' },
          nextCursor: { type: ['string', 'null'], maxLength: 8192 },
          cursorType: { type: 'string', enum: ['opaque', 'none'] },
        },
      },
      StoredSearchEnvelope: {
        type: 'object',
        additionalProperties: false,
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object',
            additionalProperties: false,
            required: ['contractVersion', 'source', 'query', 'filters', 'items', 'pageInfo', 'searchMode', 'warnings', 'durationMs'],
            properties: {
              contractVersion: { type: 'string', const: 'mx-insight-hub.stored-search.v1' },
              source: { type: 'string', const: 'hub' }, query: { type: 'string' },
              filters: { type: 'object', additionalProperties: false, required: ['platform', 'datasetId', 'objectType'], properties: {
                platform: { type: 'string' }, datasetId: { type: ['string', 'null'] }, objectType: { type: ['string', 'null'] },
              } },
              items: { type: 'array', items: { $ref: '#/components/schemas/StoredSearchItem' } },
              pageInfo: { $ref: '#/components/schemas/StoredSearchPageInfo' },
              searchMode: { type: 'string', enum: ['elasticsearch', 'postgres'] },
              warnings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['code', 'message'], properties: {
                code: { type: 'string' }, message: { type: 'string' },
              } } },
              durationMs: { type: 'integer', minimum: 0 },
            },
          },
          requestId: { type: 'string', format: 'uuid' },
        },
      },
      CanonicalSearchEnvelope: {
        type: 'object',
        additionalProperties: false,
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object',
            additionalProperties: false,
            required: ['contractVersion', 'source', 'query', 'scope', 'filters', 'search', 'items', 'pageInfo', 'searchMode', 'warnings', 'durationMs'],
            properties: {
              contractVersion: { type: 'string', const: 'mx-insight-hub.canonical-search.v1' },
              source: { type: 'string', const: 'hub' },
              query: { type: 'string' },
              scope: {
                type: 'object', additionalProperties: false, required: ['platforms'],
                properties: { platforms: { type: 'array', minItems: 1, items: { type: 'string' } } },
              },
              filters: {
                type: 'object', additionalProperties: false, required: ['platform', 'datasetId', 'objectType'],
                properties: {
                  platform: { type: ['string', 'null'] },
                  datasetId: { type: ['string', 'null'] },
                  objectType: { type: ['string', 'null'] },
                },
              },
              search: {
                type: 'object',
                additionalProperties: false,
                required: ['requestedProfile', 'appliedProfile', 'degraded'],
                properties: {
                  requestedProfile: { type: 'string', enum: PUBLIC_SEARCH_PROFILE_IDS },
                  appliedProfile: { type: 'string', enum: [...PUBLIC_SEARCH_PROFILE_IDS, POSTGRES_SEARCH_PROFILE] },
                  degraded: { type: 'boolean' },
                },
              },
              items: { type: 'array', items: { $ref: '#/components/schemas/StoredSearchItem' } },
              pageInfo: { $ref: '#/components/schemas/CanonicalSearchPageInfo' },
              searchMode: { type: 'string', enum: ['elasticsearch', 'postgres'] },
              warnings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['code', 'message'], properties: {
                code: { type: 'string' }, message: { type: 'string' },
              } } },
              durationMs: { type: 'integer', minimum: 0 },
            },
          },
          requestId: { type: 'string', format: 'uuid' },
        },
      },
      TelegramRecord: {
        type: 'object',
        required: ['id', 'externalId', 'platform', 'objectType', 'lineage', 'dataVersion'],
        properties: {
          id: { type: 'string' }, externalId: { type: 'string' }, platform: { type: 'string', const: 'telegram' },
          objectType: { type: 'string', enum: ['chat', 'message'] }, contentType: { type: ['string', 'null'] },
          title: { type: ['string', 'null'] }, text: { type: ['string', 'null'] }, url: { type: ['string', 'null'] },
          author: { type: ['object', 'null'], additionalProperties: true },
          relations: { type: 'object', additionalProperties: true }, attributes: { type: 'object', additionalProperties: true },
          metrics: { type: 'object', additionalProperties: true }, media: { type: 'object', additionalProperties: true },
          entities: { type: 'array', items: { type: 'object', additionalProperties: true } },
          links: { type: 'array', items: {} }, eventTime: { type: ['string', 'null'], format: 'date-time' },
          collectedAt: { type: ['string', 'null'], format: 'date-time' }, editedAt: { type: ['string', 'null'], format: 'date-time' },
          lineage: { type: 'object', required: ['datasetId', 'origin'], properties: { datasetId: { type: 'string' }, origin: { type: 'string' } } },
          dataVersion: { type: 'string' },
        },
      },
      TelegramPageEnvelope: {
        type: 'object',
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object',
            required: ['items', 'pageInfo'],
            properties: {
              items: { type: 'array', items: { $ref: '#/components/schemas/TelegramRecord' } },
              pageInfo: { $ref: '#/components/schemas/PageInfo' },
            },
          },
          requestId: { type: 'string' },
        },
      },
      CapabilitiesEnvelope: {
        type: 'object',
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object',
            properties: {
              platforms: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['platform', 'ready'],
                  properties: {
                    platform: { type: 'string' }, ready: { type: 'boolean' },
                    capabilities: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
              capabilities: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['capability', 'ready'],
                  properties: {
                    capability: { type: 'string', enum: ['nlp.tokenize'] },
                    ready: { type: 'boolean' },
                  },
                },
              },
            },
          },
          requestId: { type: 'string' },
        },
      },
      EntitySearchEnvelope: {
        type: 'object',
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object',
            required: ['items', 'pageInfo', 'searchMode'],
            properties: {
              items: { type: 'array', items: { type: 'object', additionalProperties: true } },
              pageInfo: { $ref: '#/components/schemas/PageInfo' },
              searchMode: { type: 'string', enum: ['elasticsearch', 'postgres'] },
            },
          },
          requestId: { type: 'string' },
        },
      },
      RequestStatusEnvelope: {
        type: 'object',
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object',
            required: ['id', 'status'],
            oneOf: [
              { required: ['platform'], not: { required: ['capability'] } },
              { required: ['capability'], not: { required: ['platform'] } },
            ],
            properties: {
              id: { type: 'string', format: 'uuid' },
              status: { type: 'string', enum: ['reserved', 'committed', 'released', 'unknown'] },
              platform: { type: 'string' }, units: { type: ['integer', 'null'] },
              capability: { type: 'string' },
              errorCode: { type: ['string', 'null'] }, reservedAt: { type: 'string', format: 'date-time' },
              completedAt: { type: ['string', 'null'], format: 'date-time' },
            },
          },
          requestId: { type: 'string' },
        },
      },
      UsageEnvelope: {
        type: 'object',
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object',
            required: ['requests', 'committed', 'released', 'unknown', 'units'],
            properties: {
              requests: { type: 'integer' }, committed: { type: 'integer' }, released: { type: 'integer' },
              unknown: { type: 'integer' }, units: { type: 'integer' },
              averageUpstreamLatencyMs: { type: ['integer', 'null'] },
              byPlatform: { type: 'object', additionalProperties: true },
              byCapability: { type: 'object', additionalProperties: true },
            },
          },
          requestId: { type: 'string' },
        },
      },
      TokenizeEnvelope: {
        type: 'object',
        additionalProperties: false,
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object',
            additionalProperties: false,
            required: ['capability', 'tokens', 'actualBackend', 'degraded', 'errorCode'],
            properties: {
              capability: { type: 'string', const: 'nlp.tokenize' },
              tokens: { type: 'array', minItems: 1, maxItems: 8192, items: { type: 'string', minLength: 1, maxLength: 512 } },
              actualBackend: { type: 'string', enum: ['hanlp', 'jieba', 'bigram'] },
              degraded: { type: 'boolean' },
              errorCode: { type: ['string', 'null'] },
            },
          },
          requestId: { type: 'string', format: 'uuid' },
        },
      },
      ErrorEnvelope: {
        type: 'object',
        required: ['error', 'requestId'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string' }, message: { type: 'string' }, details: { type: 'object', additionalProperties: true },
            },
          },
          requestId: { type: 'string' },
        },
      },
    },
  },
}

export const PUBLIC_DOCS_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="MX Insight Hub Open API 文档">
  <title>MX Insight Hub · Open API</title>
  <style>
    :root { color-scheme: dark; --bg:#070b12; --panel:#101824; --line:#26364b; --text:#e9f2fb; --muted:#91a4b8; --cyan:#2de4d0; --blue:#5597ff; --amber:#f3c85a; }
    * { box-sizing:border-box; }
    html { scroll-behavior:smooth; }
    body { margin:0; background:radial-gradient(circle at 75% 0,#102338 0,transparent 34rem),var(--bg); color:var(--text); font:15px/1.7 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    a { color:var(--cyan); text-decoration:none; }
    a:hover { text-decoration:underline; }
    .layout { display:grid; grid-template-columns:250px minmax(0,1fr); min-height:100vh; }
    aside { position:sticky; top:0; height:100vh; padding:28px 22px; border-right:1px solid var(--line); background:rgba(7,11,18,.9); }
    .brand { display:flex; gap:12px; align-items:center; margin-bottom:32px; }
    .mark { width:38px; height:38px; display:grid; place-items:center; border:1px solid var(--cyan); border-radius:10px; color:var(--cyan); font-weight:800; box-shadow:0 0 24px #2de4d033; }
    .brand strong { display:block; font-size:16px; }
    .brand span,.eyebrow,.muted { color:var(--muted); }
    nav a { display:block; padding:7px 10px; border-left:2px solid transparent; color:var(--muted); }
    nav a:hover { border-color:var(--cyan); color:var(--text); text-decoration:none; background:#11202d; }
    main { width:min(1120px,100%); padding:54px clamp(24px,5vw,72px) 90px; }
    .eyebrow { text-transform:uppercase; letter-spacing:.18em; color:var(--cyan); font-size:12px; font-weight:700; }
    h1 { margin:.2em 0; font-size:clamp(34px,5vw,58px); line-height:1.08; }
    h2 { margin:62px 0 18px; font-size:27px; }
    h3 { margin:34px 0 12px; font-size:19px; }
    p { max-width:850px; }
    .lead { font-size:18px; color:#b9c7d5; }
    .cards { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; margin:28px 0; }
    .card,.endpoint,.notice { border:1px solid var(--line); border-radius:12px; background:linear-gradient(150deg,#111c29,#0c131e); }
    .card { padding:18px; }
    .card strong { display:block; color:var(--cyan); margin-bottom:5px; }
    .endpoint { padding:18px 20px; margin:14px 0; }
    .endpoint-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
    .method { min-width:54px; text-align:center; padding:2px 8px; border-radius:5px; background:#153c38; color:var(--cyan); font-size:12px; font-weight:800; letter-spacing:.06em; }
    .method.post { background:#173256; color:#80b4ff; }
    code,pre { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
    .path { color:#e5edf7; overflow-wrap:anywhere; }
    pre { overflow:auto; padding:17px; border:1px solid #24354a; border-radius:10px; background:#050911; color:#cfe2f2; line-height:1.55; }
    :not(pre)>code { padding:.15em .4em; border-radius:4px; background:#142131; color:#9fc6ff; }
    .notice { padding:16px 18px; border-color:#4c4429; color:#efd786; }
    table { width:100%; border-collapse:collapse; margin:16px 0; }
    th,td { padding:10px 12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    th { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
    footer { margin-top:70px; padding-top:20px; border-top:1px solid var(--line); color:var(--muted); }
    @media(max-width:820px){ .layout{display:block} aside{position:relative;height:auto;border-right:0;border-bottom:1px solid var(--line)} nav{display:flex;flex-wrap:wrap}.cards{grid-template-columns:1fr} main{padding-top:36px} }
  </style>
</head>
<body>
<div class="layout">
  <aside>
    <div class="brand"><div class="mark">MX</div><div><strong>MX Insight Hub</strong><span>Open API</span></div></div>
    <nav aria-label="文档目录">
      <a href="#start">开始调用</a><a href="#rules">认证与调用规则</a><a href="#search">通用搜索</a>
      <a href="#tools">通用工具</a><a href="#telegram">Telegram</a><a href="#discovery">能力与证据</a><a href="#errors">错误与重试</a>
      <a href="/docs/openapi.json">OpenAPI JSON ↗</a>
    </nav>
  </aside>
  <main>
    <header id="start"><div class="eyebrow">Consumer contract · API v1</div><h1>统一数据访问，<br>由授权边界控制。</h1>
      <p class="lead">通过一个调用者 API Key 访问已授权平台与通用能力。Telegram 数据由 Hub 的规范化数据层提供，通用搜索和分词工具保持稳定响应结构。</p></header>
    <div class="cards"><div class="card"><strong>Base path</strong><code>/api/v1</code></div><div class="card"><strong>Authentication</strong>Bearer API Key 或 <code>x-api-key</code></div><div class="card"><strong>Machine contract</strong><a href="/docs/openapi.json">OpenAPI 3.1 JSON</a></div></div>

    <h2 id="rules">认证与调用规则</h2>
    <h3>认证及显式授权</h3>
    <p>每个请求必须携带已签发的调用者 API Key。建议使用 Bearer；不要把 Key 放进 URL、日志或前端代码。Key 只能调用后台为其调用者显式启用的平台或通用 capability；先调用 capabilities 确认授权与就绪状态。</p>
    <pre><code>export HUB_URL="https://hub.example.com"
export MX_INSIGHT_API_KEY="&lt;issued-api-key&gt;"

curl -sS "$HUB_URL/api/v1/data/capabilities" \\
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" | jq</code></pre>
    <h3>幂等、游标与配额</h3>
    <table><thead><tr><th>规则</th><th>客户端行为</th></tr></thead><tbody>
      <tr><td>POST 搜索</td><td><code>Idempotency-Key</code> 在同一 consumer 内全局唯一。仅在重试完全相同的路径和规范化 body 时复用；新路径、新 body 或新页面必须使用新 Key。</td></tr>
      <tr><td>结果新鲜度</td><td>可选 <code>type</code>：<code>fresh</code>（默认）表示始终检索当前数据，重放窗口为 120 秒，足以吸收一次重试而不会把 Key 变成缓存；<code>stable</code> 表示同一个 Key 永久返回首次的结果，用于报表、分页序列和审计等需要快照可复现的场景。<code>type</code> 参与请求指纹，同一个 Key 不能在两种语义之间切换。</td></tr>
      <tr><td>POST 分词</td><td>同样必须携带 <code>Idempotency-Key</code>；相同请求重放不会再次分词或重复计量。</td></tr>
      <tr><td>下一页</td><td>使用响应中的 <code>pageInfo.nextCursor</code>，不要解析或修改；因为 body 已变化，新页面必须使用新的幂等 Key。</td></tr>
      <tr><td>GET 历史/实体</td><td>不使用幂等 Key；每次调用和重试都会独立计量。</td></tr>
      <tr><td>页大小</td><td>同时受接口上限与该调用者平台策略约束；超限返回 <code>page_size_exceeded</code>。</td></tr>
    </tbody></table>

    <h2 id="search">通用搜索</h2>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/data/search</code></div><p>在一个请求中选择一个已授权平台。<code>platform=telegram</code> 使用 Hub 已清洗数据。</p></div>
    <pre><code>curl -sS -X POST "$HUB_URL/api/v1/data/search" \\
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: search-$(uuidgen)" \\
  -d '{"platform":"telegram","query":"AI Agent","pageSize":5}' | jq</code></pre>
    <pre><code>{
  "data": {
    "contractVersion": "night-all.data-search.v1",
    "platform": "telegram",
    "query": "AI Agent",
    "items": [],
    "pageInfo": { "returnedCount": 0, "hasMore": false, "nextCursor": null },
    "status": "ok",
    "warnings": [],
    "meta": { "capability": "stored_search", "sourceProvider": "mx-insight-hub" }
  },
  "requestId": "00000000-0000-4000-8000-000000000003"
}</code></pre>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/data/stored/search</code></div><p>只搜索 Hub canonical 数据，不调用 Night-All。可按逻辑 <code>datasetId</code> 和 <code>objectType</code> 精确过滤；不接受数据库、索引、SQL 或 ES DSL。</p></div>
    <div class="notice">授权边界仍是 <code>platform</code>：<code>datasetId</code> 只是过滤条件，不是独立授权。获得某平台授权的调用者当前可搜索该平台完整 canonical 语料。</div>
    <pre><code>curl -sS -X POST "$HUB_URL/api/v1/data/stored/search" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: stored-$(uuidgen)" \
  -d '{"platform":"xiaohongshu","query":"AI Agent","datasetId":"night-all.search.v1","objectType":"post","pageSize":20}' | jq</code></pre>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/data/canonical/search</code></div><p>来源无关的统一检索：在一份 canonical 全局索引中直接排序，不逐个调用来源后拼接。省略 <code>platform</code> 时搜索当前调用者已授权的全部平台；<code>datasetId</code> 与 <code>objectType</code> 只用于收窄。可用 <code>searchProfile</code> 选择版本化搜索策略；不接受任意 analyzer、tokenizer、filter 或 ES DSL。</p></div>
    <div class="notice">统一接口只读取 Hub 已存数据，不触发第三方采集。响应的 <code>scope.platforms</code> 是本次实际授权范围；游标与该范围及首屏分词状态绑定，后续页不会再次调用 HanLP。授权或 profile 发生变化后应从第一页重新搜索。独立的 canonical-search 用量桶固定采用调用者当前全部平台授权中最严格的限额。</div>
    <table><thead><tr><th>searchProfile</th><th>查询策略</th></tr></thead><tbody>
      <tr><td><code>canonical.balanced.v1</code>（默认）</td><td>HanLP 健康时使用“原文 phrase 或全部 HanLP/presegmented 词命中（AND）”；若分词降级到 Jieba/bigram，则明确应用 phrase-only，绝不拿 fallback 词误查 HanLP 字段。</td></tr>
      <tr><td><code>canonical.phrase.v1</code></td><td>只匹配保持语序的原文 phrase，精度优先。</td></tr>
      <tr><td><code>canonical.terms-all.v1</code></td><td>所有预分词查询词都必须命中，允许词序变化。</td></tr>
      <tr><td><code>canonical.zh-recall.v1</code></td><td>在默认策略上增加较低权重的 CJK bigram 召回。</td></tr>
      <tr><td><code>canonical.title-prefix.v1</code></td><td>用于标题、作者、用户名和会话名的有界前缀检索。</td></tr>
    </tbody></table>
    <pre><code>curl -sS -X POST "$HUB_URL/api/v1/data/canonical/search" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: canonical-$(uuidgen)" \
  -d '{"query":"AI Agent","searchProfile":"canonical.balanced.v1","pageSize":20}' | jq</code></pre>

    <h2 id="tools">通用工具</h2>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/tools/tokenize</code></div><p>新建或从未配置的调用者默认获得 <code>nlp.tokenize</code>，管理员可显式停用；调用仍必须携带已签发的 API Key。默认按 consumer + capability 的 3600 秒滚动窗口限制 1000 次，同一调用者的所有 Key 共享上限。它不授予数据平台权限，响应会报告实际分词后端及降级状态。</p></div>
    <pre><code>curl -sS -X POST "$HUB_URL/api/v1/tools/tokenize" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: tokenize-$(uuidgen)" \
  -d '{"text":"吴恩达与人工智能"}' | jq</code></pre>
    <pre><code>{
  "data": {
    "capability": "nlp.tokenize",
    "tokens": ["吴恩达", "与", "人工智能"],
    "actualBackend": "hanlp",
    "degraded": false,
    "errorCode": null
  },
  "requestId": "00000000-0000-4000-8000-000000000004"
}</code></pre>

    <h2 id="telegram">Telegram 数据</h2>
    <div class="notice">授权 <code>telegram</code> 后，调用者读取的是同一份 Hub 全量规范化语料；当前没有按租户划分不同的 Telegram 行级数据子集。租户隔离作用于 API Key 所有权、平台授权、策略、配额和用量证据。</div>
    <table><thead><tr><th>调用目标</th><th>接口</th><th>实际数据范围</th></tr></thead><tbody>
      <tr><td>Monitor 消息历史</td><td><code>GET /data/telegram/messages</code></td><td><code>telegram.monitor.messages.v1</code></td></tr>
      <tr><td>Monitor 会话目录</td><td><code>GET /data/telegram/chats</code></td><td><code>telegram.monitor.chats.v1</code></td></tr>
      <tr><td>Monitor 高级检索</td><td><code>POST /data/telegram/search</code></td><td>固定的 <code>telegram.monitor.*</code></td></tr>
      <tr><td>Monitor + SQLite 统一检索</td><td><code>POST /data/canonical/search</code></td><td>授权范围内全部 Telegram canonical dataset</td></tr>
      <tr><td>指定单个来源数据集</td><td><code>POST /data/stored/search</code></td><td>由 <code>datasetId</code> 精确收窄</td></tr>
    </tbody></table>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/telegram/messages</code></div><p>Monitor 消息历史；支持 <code>chatId</code>、<code>from</code>、<code>to</code>、<code>pageSize</code>、<code>cursor</code>。该兼容接口不会隐式混入 SQLite。</p></div>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/telegram/chats</code></div><p>会话目录，使用相同的时间和游标规则。</p></div>
    <pre><code>curl -sS "$HUB_URL/api/v1/data/telegram/messages?chatId=-1001234567890&amp;pageSize=20" \\
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" | jq</code></pre>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/data/telegram/search</code></div><p>高级全文检索；<code>scope</code> 可选 <code>messages</code>、<code>chats</code>、<code>all</code>，并可按 chat、author 和时间过滤。</p></div>
    <pre><code>curl -sS -X POST "$HUB_URL/api/v1/data/telegram/search" \\
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: telegram-$(uuidgen)" \\
  -d '{"query":"AI Agent","scope":"all","from":"2026-08-01T00:00:00Z","pageSize":20}' | jq</code></pre>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/data/canonical/search</code></div><p>同时检索 Telegram monitor 与 SQLite 导入数据。省略 <code>datasetId</code> 是合并的关键；如果只要消息，可用 <code>objectType=message</code> 收窄。</p></div>
    <pre><code>curl -sS -X POST "$HUB_URL/api/v1/data/canonical/search" \\
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: telegram-all-sources-$(uuidgen)" \\
  -d '{"platform":"telegram","objectType":"message","query":"AI Agent","searchProfile":"canonical.balanced.v1","pageSize":20}' | jq</code></pre>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/telegram/entities/search?query=example&amp;pageSize=20</code></div><p>模糊匹配作者名称/用户名和会话标题/用户名。</p></div>
    <div class="notice">如果搜索响应包含 <code>search_projection_degraded</code>，代表当前页面由 PostgreSQL 检索托底。Canonical 接口还会以 <code>search.appliedProfile=postgres.substring.v1</code> 和 <code>search_profile_degraded</code> 明示策略变化；Telegram/Stored 兼容响应只保留投影告警。若 Elasticsearch 仍在线但 HanLP 查询降级，三个接口都会返回 <code>search_profile_degraded</code>。已有 Elasticsearch 游标会签名并复用首屏分词状态，不会中途切换模式或重新分词。</div>

    <h2 id="discovery">能力、请求状态与用量</h2>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/capabilities</code></div><p>仅返回当前调用者已授权且可公开使用的平台与通用 capabilities。</p></div>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/requests/{requestId}</code></div><p>查询当前调用者拥有的持久请求记录。requestId 来自搜索响应头 <code>x-mx-insight-request-id</code>。</p></div>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/usage?from=...&amp;to=...</code></div><p>读取当前调用者的请求、提交、释放、未知状态与计费单元汇总。</p></div>

    <h2 id="errors">错误与重试</h2>
    <table><thead><tr><th>HTTP</th><th>含义</th><th>建议</th></tr></thead><tbody>
      <tr><td>400</td><td>字段、游标、页大小或幂等 Key 不合法</td><td>修正请求，不原样盲重试</td></tr>
      <tr><td>401 / 403</td><td>Key 无效，或平台未授权</td><td>检查 Key 与 capabilities</td></tr>
      <tr><td>409</td><td>幂等冲突、处理中或结果未知</td><td>保持原 body 与原幂等 Key；查询 request status</td></tr>
      <tr><td>410</td><td>搜索游标过期</td><td>从无 cursor 的第一页重新开始，并使用新幂等 Key</td></tr>
      <tr><td>429</td><td>请求或并发配额耗尽</td><td>等待策略窗口恢复</td></tr>
      <tr><td>503</td><td>当前数据或搜索运行时不可用</td><td>安全 GET 可稍后重试；POST 复用原幂等 Key</td></tr>
    </tbody></table>
    <p>所有错误都返回稳定的 <code>error.code</code> 和用于排查的 <code>requestId</code>。</p>
    <footer>MX Insight Hub Open API v1 · <a href="/docs/openapi.json">下载 OpenAPI JSON</a></footer>
  </main>
</div>
</body>
</html>`
