import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { PUBLIC_OPENAPI_DOCUMENT, publicDocsHtmlForPath, tenantOpenApiDocument } from '../../server/public-docs.mjs'
import { productEndpoints, productForPath, productConsoleRequest } from '../../shared/product-workbenches.mjs'

const path = '/data/telegram/semantic-search'

test('Telegram semantic API is discoverable in the product console and scoped public docs', () => {
  const product = productForPath('/data-products/telegram')
  const endpoints = productEndpoints(PUBLIC_OPENAPI_DOCUMENT, product)
  assert.equal(endpoints.length, 7)
  const endpoint = endpoints.find(item => item.path === `/api/v1${path}`)
  assert.ok(endpoint)
  assert.equal(endpoint.operationId, 'semanticSearchTelegram')
  assert.equal(endpoint.parameters.find(item => item.name === 'Idempotency-Key').required, true)
  assert.match(endpoint.description, /metered/)
  assert.match(endpoint.description, /without silently falling back/)
  assert.match(endpoint.description, /permanently bound to its original idempotency key/)
  assert.match(endpoint.description, /semantic_search_outcome_unknown/)
  const request = productConsoleRequest(endpoint, {}, '{"query":"领导人","sourceScope":"all","topK":20}')
  assert.equal(request.path, `/api/v1${path}`)
  assert.deepEqual(request.body, { query: '领导人', sourceScope: 'all', topK: 20 })
  const allowed = tenantOpenApiDocument([{ platforms: ['telegram'], capabilities: [] }])
  const hidden = tenantOpenApiDocument([{ platforms: ['public_opinion'], capabilities: [] }])
  assert.ok(allowed.paths[path])
  assert.equal(hidden.paths[path], undefined)
  const html = publicDocsHtmlForPath('/docs/telegram')
  assert.match(html, /telegram\/semantic-search/)
  assert.match(html, /不生成回答/)
  assert.match(html, /不能证明 TG 历史已经全部向量化/)
  assert.match(html, /不得自动换键重新调用模型/)
})

test('Telegram semantic static and served schemas agree on strict input and bounded evidence', () => {
  const parsed = spawnSync('python3', ['-c', 'import sys,yaml,json; json.dump(yaml.safe_load(sys.stdin),sys.stdout)'], {
    input: readFileSync(new URL('../../docs/contracts/openapi.yaml', import.meta.url), 'utf8'), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
  })
  assert.equal(parsed.status, 0, parsed.stderr)
  const saved = JSON.parse(parsed.stdout)
  for (const name of ['TelegramSemanticSearchRequest', 'TelegramSemanticSearchEnvelope', 'TelegramSemanticSearchItem']) {
    assert.deepEqual(saved.components.schemas[name], PUBLIC_OPENAPI_DOCUMENT.components.schemas[name], name)
  }
  assert.equal(saved.paths[path].post.operationId, 'semanticSearchTelegram')
  const input = saved.components.schemas.TelegramSemanticSearchRequest
  assert.equal(input.additionalProperties, false)
  assert.deepEqual(input.required, ['query'])
  assert.deepEqual(Object.keys(input.properties), ['query', 'sourceScope', 'chatId', 'authorId', 'from', 'to', 'topK', 'minSimilarity'])
  assert.equal(input.properties.sourceScope.default, 'all')
  assert.equal(input.properties.topK.maximum, 50)
  const output = saved.components.schemas.TelegramSemanticSearchEnvelope.properties.data.properties
  assert.equal(output.retrieval.properties.exhaustive.const, false)
  assert.equal(output.retrieval.properties.coverage.const, 'unknown')
  assert.equal(output.pageInfo.properties.paginationMode.const, 'top_k')
  assert.equal(output.pageInfo.properties.nextCursor.type, 'null')
  assert.equal(output.pageInfo.properties.hasMore, undefined)
  assert.deepEqual(saved.components.schemas.TelegramSemanticSearchItem.properties.contentType.type, ['string', 'null'])
})
