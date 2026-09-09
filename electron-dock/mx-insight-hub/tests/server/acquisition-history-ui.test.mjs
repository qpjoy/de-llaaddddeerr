import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PUBLIC_OPENAPI_DOCUMENT } from '../../server/public-docs.mjs'

test('Data Center offers an admin-only exact-delivery acquisition history lookup', async () => {
  const [page, component, api] = await Promise.all([
    readFile(new URL('../../src/pages-catalog.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/acquisition-history.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/api.js', import.meta.url), 'utf8'),
  ])

  assert.match(page, /<AcquisitionHistoryPanel token=\{token\} onUnauthorized=\{onUnauthorized\}/u)
  assert.match(component, /采集查询复现/u)
  assert.match(component, /当时实际交付的完整响应/u)
  assert.match(component, /保持原样/u)
  assert.match(component, /data\.delivered\?\.responseBody/u)
  assert.match(component, /data\.customerCharge\?\.chargedMinor/u)
  assert.match(component, /data\?\.costLineage\?\.providerCalls/u)
  assert.match(component, /计费状态未知/u)
  assert.match(component, /providerPriceBookVersion/u)
  assert.match(component, /providerCredentialRevision/u)
  assert.match(api, /acquisitionHistory: \(token, requestId\) => request\([\s\S]*?\/acquisitions\/\$\{encodeURIComponent\(requestId\)\}/u)
})

test('public docs describe acquisition replay as caller-owned and no-dispatch', async () => {
  const [yaml, contract, curlGuide] = await Promise.all([
    readFile(new URL('../../docs/contracts/openapi.yaml', import.meta.url), 'utf8'),
    readFile(new URL('../../docs/contracts/public-api-v1.md', import.meta.url), 'utf8'),
    readFile(new URL('../../docs/public-api-curl.md', import.meta.url), 'utf8'),
  ])
  const operation = PUBLIC_OPENAPI_DOCUMENT.paths['/acquisitions/{requestId}'].get

  assert.match(operation.description, /previously delivered/u)
  assert.match(operation.description, /never dispatches or re-runs/u)
  assert.match(operation.description, /Only the same API key/u)
  assert.match(operation.description, /Admin Token is the recovery path/u)
  assert.equal(
    operation.responses[200].content['application/json'].schema.$ref,
    '#/components/schemas/AcquisitionHistoryEnvelope',
  )
  assert.match(yaml, /\/acquisitions\/\{requestId\}:/u)
  assert.match(yaml, /mx-insight-hub\.acquisition-query-run\.v1/u)
  for (const source of [contract, curlGuide]) {
    assert.match(source, /GET \/api\/v1\/acquisitions\/\{requestId\}/u)
    assert.match(source, /delivered\.responseBody/u)
    assert.match(source, /responseHash/u)
    assert.match(source, /sha256-canonical-json-v1/u)
    assert.match(source, /customerCharge/u)
    assert.match(source, /canonical\s+lineage/u)
    assert.match(source, /same active Hub Public API key|同一把.*Live Hub API Key/u)
    assert.match(source, /no usage|不创建 usage/u)
    assert.match(source, /upstream dispatch|上游 dispatch/u)
  }
  assert.match(curlGuide, /curl -sS[\s\S]*\/api\/v1\/acquisitions\/\$HUB_REQUEST_ID/u)
})
