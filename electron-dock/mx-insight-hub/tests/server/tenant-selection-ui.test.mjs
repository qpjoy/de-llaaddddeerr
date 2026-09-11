import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

async function page() {
  return readFile(new URL('../../src/pages.jsx', import.meta.url), 'utf8')
}

test('a selection is not reverted by data that predates it', async () => {
  const source = await page()

  // The refetch a new selection triggers is still queued on the render where
  // the revert effect first runs, so `state.loading` alone cannot tell an
  // in-flight switch from a rejected one. Both pages must compare the context
  // the data answers against the selection currently in the URL.
  const guards = source.match(
    /if \(state\.data\.requestedContext !== selectionContext\(requestedTenantId, requestedConsumerId\)\) return/gu,
  ) || []
  assert.equal(guards.length, 2, 'both the platforms and plans pages need this guard')

  // Every revert is preceded by that guard, never standing on its own.
  const reverts = source.match(/const tenantMismatch = requestedTenantId/gu) || []
  assert.equal(reverts.length, guards.length, 'no revert may run without the context guard')
})

test('the loader states which selection its result answers', async () => {
  const source = await page()

  assert.match(source, /function selectionContext\(tenantId, consumerId\)/u)
  assert.match(source, /requestedContext: selectionContext\(requestedTenantId, requestedConsumerId\)/u)
})

test('switching a tenant clears the consumer so a stale pair is never requested', async () => {
  const source = await page()

  // A consumer belongs to one tenant, so carrying it across would ask for a
  // pair that cannot exist.
  assert.match(source, /setQuery\(\{ tenantId: value \|\| null, consumerId: null \}\)/u)
})
