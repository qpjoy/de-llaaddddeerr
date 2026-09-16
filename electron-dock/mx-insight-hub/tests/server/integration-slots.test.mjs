import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { integrationSlotManifest } from '../../server/contracts/integration-slot.mjs'
import { collectorRunView, processAdapterOutcome, slotProfile } from '../../shared/integration-slots.mjs'

const manifest = JSON.parse(await readFile(new URL('../../integrations/market-195/manifest.json', import.meta.url), 'utf8'))
test('candidate metadata cannot claim deployment or an unreviewed data binding', () => {
  assert(integrationSlotManifest.safeParse(manifest).success)
  assert.equal(integrationSlotManifest.safeParse({ ...manifest, adapter: { ...manifest.adapter, deploymentRef: 'production' } }).success, false)
  assert.equal(integrationSlotManifest.safeParse({ ...manifest, dataContract: { ...manifest.dataContract, ingestion: 'separate_plan' } }).success, false)
  assert.equal(integrationSlotManifest.safeParse({ ...manifest, capabilities: [...manifest.capabilities, ...manifest.capabilities] }).success, false)
  assert.equal(integrationSlotManifest.safeParse({ ...manifest, limits: { ...manifest.limits, autoRetryAmbiguous: true } }).success, false)
})
test('execution success never implies full collection or completed Hub ingestion', () => {
  const view = collectorRunView({ id: 2, status: 'succeeded', metrics: { collection: { complete: false }, records: { saved: 3 } } })
  assert.equal(view.state, 'succeeded'); assert.equal(view.completeness, 'partial'); assert.equal(view.hubIngestion, 'unknown')
  assert.equal(view.terminal, true)
  assert.equal(collectorRunView({ status: 'succeeded' }).completeness, 'unknown')
  assert.equal(collectorRunView({ status: 'running' }).terminal, false)
  assert.equal(collectorRunView({ status: 'orphaned' }).terminal, true)
  assert.equal(collectorRunView({ status: 'new-upstream-state' }).state, 'unknown')
  assert.equal(processAdapterOutcome({ status: 'no_data' }).dataStatus, 'no_data')
  assert.equal(processAdapterOutcome({ status: 'stopped' }).state, 'stopped')
  assert.equal(processAdapterOutcome({ status: 'success' }).hubIngestion, 'unknown')
  assert.deepEqual(slotProfile('night-all-a').modes, ['async_job', 'database_pull'])
  assert.equal(slotProfile('not-reviewed'), null)
})
