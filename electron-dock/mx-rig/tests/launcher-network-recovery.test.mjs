import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LauncherApiError } from '@qpjoy/mx-launcher-core'
import { LauncherNetwork, PRODUCT_ID, SERVICE_IDENTITY } from '../apps/desktop/launcher-network.mjs'

const VIP = '10.88.100.21'
const CAPABILITY = `mxlc1.${'A'.repeat(43)}`
const missingProof = 'A valid launcher lease capability is required'
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`),
  decryptString: (buffer) => Buffer.from(buffer.toString().slice(7), 'base64').toString()
}
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

async function fixture(t, { connectedOnce = true, rejection = missingProof, status = 401, stopOk = true, extraPending = {}, credentials = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rig-identity-recovery-'))
  t.after(async () => { await chmod(dir, 0o700); await rm(dir, { recursive: true, force: true }) })
  const file = join(dir, 'mx-rig-launcher.json')
  const original = {
    version: 1, installId: 'original-install', deviceId: 'original-device', connectedOnce,
    vault: safeStorage.encryptString(JSON.stringify({
      keyPair: { privateKey: 'original-private-key', publicKey: 'original-public-key' },
      leaseCredentials: credentials, pendingCapabilities: { anonymous: CAPABILITY, ...extraPending },
      activeSession: null, pendingHandover: null
    })).toString('base64')
  }
  await writeFile(file, JSON.stringify(original), { mode: 0o600 })
  const calls = { enroll: [], stop: [], keys: 0, events: [] }
  const sdk = {
    resolveElectronLauncherBootstrap: async () => ({ ok: true, baseUrl: 'https://bootstrap.example.test' }),
    createLauncherWireGuardKeyPair: () => {
      calls.keys += 1
      calls.events.push('key')
      return { privateKey: 'replacement-private-key', publicKey: 'replacement-public-key' }
    },
    createElectronLauncher: (client) => ({
      getProduct: async () => ({ productId: PRODUCT_ID, mode: 'standalone', networkScope: 'owner', enabled: true, serviceVip: VIP }),
      connectNetwork: async (input) => {
        calls.enroll.push({ ...input, installId: client.installId, deviceId: client.deviceId })
        calls.events.push('enroll')
        if (client.installId === original.installId) throw new LauncherApiError('MX Launcher request failed', status, { message: rejection })
        return {
          lease: { leaseId: 'replacement-lease', productId: PRODUCT_ID, installId: client.installId, deviceId: client.deviceId,
            capability: input.newLeaseCapability, publicKey: input.publicKey, identityKind: 'anonymous', leaseIp: '10.94.200.9', generation: 1 },
          routePlan: { productId: PRODUCT_ID, serviceVip: VIP, leaseIp: '10.94.200.9', leaseCidr: '10.94.0.0/16' }
        }
      }
    }),
    applyElectronLauncherStandaloneDataPlane: async () => ({ ok: true, state: 'network-ready', message: 'ok' }),
    stopElectronLauncherStandaloneDataPlane: async (input) => {
      calls.stop.push(input)
      calls.events.push('stop')
      return { ok: stopOk, message: stopOk ? 'stopped' : 'fixture stop failed' }
    }
  }
  const fetchImpl = async (url) => url.endsWith('/domestic-peer/sync')
    ? json({ domesticPeerSync: { status: 'passed', execution: 'executed' } })
    : json({ status: 'ready' })
  const network = await LauncherNetwork.open({ dir, sdk, safeStorage, fetchImpl })
  return { network, calls, dir, file, original }
}

const saved = async (f) => JSON.parse(await readFile(f.file, 'utf8'))
const vaultOf = (state) => JSON.parse(safeStorage.decryptString(Buffer.from(state.vault, 'base64')))

test('a missing old proof never silently rotates identity; explicit recovery backs up and registers only Rig', async (t) => {
  const f = await fixture(t)
  const failed = await f.network.connect()
  assert.equal(failed.status, 'error')
  assert.equal(failed.recoveryAvailable, true)
  assert.equal(f.calls.keys, 0)
  assert.equal(f.calls.stop.length, 0)
  const before = await saved(f)
  assert.equal(before.installId, f.original.installId)
  const result = await f.network.recoverIdentity()
  assert.equal(result.status, 'ready')
  assert.equal(result.recoveryAvailable, false)
  assert.equal(result.identity.kind, 'anonymous')
  assert.equal(f.calls.stop.length, 1)
  assert.equal(f.calls.stop[0].ownerId, `${PRODUCT_ID}:${f.original.installId}`)
  assert.equal(f.calls.stop[0].profileName, 'mx-rig.conf')
  assert.deepEqual(f.calls.stop[0].darwinServiceIdentity, SERVICE_IDENTITY)
  assert.ok(f.calls.events.indexOf('stop') < f.calls.events.indexOf('key'))
  const after = await saved(f)
  assert.notEqual(after.installId, before.installId)
  assert.notEqual(after.deviceId, before.deviceId)
  assert.notEqual(vaultOf(after).keyPair.publicKey, vaultOf(before).keyPair.publicKey)
  assert.equal(f.calls.enroll.length, 2)
  assert.equal(f.calls.enroll[1].identityKind, 'anonymous')
  assert.equal(f.calls.enroll[1].accessToken, undefined)
  const backups = (await readdir(f.dir)).filter((name) => name !== 'mx-rig-launcher.json')
  assert.equal(backups.length, 1)
  const backupFile = join(f.dir, backups[0])
  const backup = await readFile(backupFile, 'utf8')
  assert.deepEqual(JSON.parse(backup), before)
  assert.doesNotMatch(backup, /original-private-key|replacement-private-key|mxlc1\./)
  if (process.platform !== 'win32') assert.equal((await stat(backupFile)).mode & 0o777, 0o600)
  const repeated = await f.network.recoverIdentity()
  assert.equal(repeated.status, 'ready')
  assert.equal(f.calls.stop.length, 1)
  assert.equal(f.calls.keys, 1)
  assert.equal((await saved(f)).installId, after.installId)
})

test('generic denial, policy denial, first enrollment and surviving proofs never offer identity reset', async (t) => {
  for (const [name, options] of Object.entries({
    generic401: { rejection: 'Unauthorized' },
    policy403: { rejection: missingProof, status: 403 },
    firstEnrollment: { connectedOnce: false },
    interruptedUserEnrollment: { extraPending: { 'user:fixture': `mxlc1.${'B'.repeat(43)}` } },
    heldProof: { credentials: { prior: { capability: CAPABILITY, productId: PRODUCT_ID, installId: 'original-install', publicKey: 'original-public-key', identityKind: 'anonymous' } } }
  })) await t.test(name, async (t) => {
    const f = await fixture(t, options)
    const result = await f.network.connect()
    assert.equal(result.recoveryAvailable, false)
    const blocked = await f.network.recoverIdentity()
    assert.equal(blocked.status, 'error')
    assert.equal(f.calls.stop.length, 0)
    assert.equal(f.calls.keys, 0)
    assert.equal((await saved(f)).installId, f.original.installId)
  })
})

test('a stop failure leaves the original network identity intact', async (t) => {
  const f = await fixture(t, { stopOk: false })
  await f.network.connect()
  const failed = await f.network.recoverIdentity()
  assert.equal(failed.status, 'error')
  assert.equal(f.calls.keys, 0)
  assert.equal(f.calls.enroll.length, 1)
  const state = await saved(f)
  assert.equal(state.installId, f.original.installId)
  assert.equal(vaultOf(state).keyPair.publicKey, 'original-public-key')
})

test('a failed backup cannot replace the identity or attempt a new enrollment', {
  skip: process.platform === 'win32' || process.getuid?.() === 0
}, async (t) => {
  const f = await fixture(t)
  await f.network.connect()
  await chmod(f.dir, 0o500)
  const failed = await f.network.recoverIdentity()
  await chmod(f.dir, 0o700)
  assert.equal(failed.status, 'error')
  assert.equal(f.calls.stop.length, 1)
  assert.equal(f.calls.keys, 0)
  assert.equal(f.calls.enroll.length, 1)
  assert.equal((await saved(f)).installId, f.original.installId)
})
