import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { canConfirmSearchReindex } from '../../src/search-reindex-confirmation.js'

test('HanLP search reindex needs only the exact REINDEX confirmation', () => {
  assert.equal(canConfirmSearchReindex({
    confirmation: 'REINDEX',
    requiresBackendAcknowledgement: false,
    backendAcknowledged: false,
  }), true)
  assert.equal(canConfirmSearchReindex({
    confirmation: 'reindex',
    requiresBackendAcknowledgement: false,
    backendAcknowledged: false,
  }), false)
})

test('non-HanLP search reindex still needs explicit backend acknowledgement', () => {
  assert.equal(canConfirmSearchReindex({
    confirmation: 'REINDEX',
    requiresBackendAcknowledgement: true,
    backendAcknowledged: false,
  }), false)
  assert.equal(canConfirmSearchReindex({
    confirmation: 'REINDEX',
    requiresBackendAcknowledgement: true,
    backendAcknowledged: true,
  }), true)
})

test('the reindex modal resets backend acknowledgement when closed and opened', async () => {
  const page = await readFile(
    fileURLToPath(new URL('../../src/pages-catalog.jsx', import.meta.url)),
    'utf8',
  )
  assert.match(page, /const closeConfirmation = \(\) => \{[\s\S]*?setBackendAcknowledged\(false\)[\s\S]*?setSubmitError\(null\)\n  \}/)
  assert.match(page, /onClick=\{\(\) => \{\n\s+setConfirmation\(''\)\n\s+setBackendAcknowledged\(false\)\n\s+setSubmitError\(null\)\n\s+setConfirmationOpen\(true\)/)
  assert.doesNotMatch(page, /\|\| !backendAcknowledged/)
})
