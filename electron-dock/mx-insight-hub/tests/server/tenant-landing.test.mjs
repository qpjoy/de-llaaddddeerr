// Where a session lands, and who is offered the "my access" page.
//
// This is the first thing anyone sees after signing in, and getting it wrong is
// not subtle: an operator sent to a page about their own (empty) access, or a
// newly invited member sent to an operator page that answers them with a 403.

import assert from 'node:assert/strict'
import test from 'node:test'
import { landingPathFor, showsOwnAccess } from '../../src/tenant-scope.js'

const tenantUser = {
  kind: 'launcher-user',
  platformAdmin: false,
  memberships: [{ tenantId: 't1', role: 'admin' }],
}
const newcomer = { kind: 'launcher-user', platformAdmin: false, memberships: [] }
const adminToken = { kind: 'admin-token', platformAdmin: true, memberships: [] }
const launcherPlatformAdmin = { kind: 'launcher-user', platformAdmin: true, memberships: [] }
const platformAdminWhoIsAlsoATenant = {
  kind: 'launcher-user',
  platformAdmin: true,
  memberships: [{ tenantId: 't1', role: 'owner' }],
}

test('a tenant lands on their own access', () => {
  assert.equal(showsOwnAccess(tenantUser), true)
  assert.equal(landingPathFor(tenantUser), '/my')
})

test('a newly invited member lands on the page that explains their situation', () => {
  // Not the operator dashboard, which would answer them with a 403.
  assert.equal(showsOwnAccess(newcomer), true)
  assert.equal(landingPathFor(newcomer), '/my')
})

test('the break-glass admin token is never offered a page about its own access', () => {
  // It belongs to no tenant by design, so the page would always be empty.
  assert.equal(showsOwnAccess(adminToken), false)
  assert.equal(landingPathFor(adminToken), '/dashboard')
})

test('platform admins keep the operator dashboard', () => {
  assert.equal(landingPathFor(launcherPlatformAdmin), '/dashboard')
  assert.equal(landingPathFor(platformAdminWhoIsAlsoATenant), '/dashboard')
})

test('a platform admin who is also a tenant member may still open the page', () => {
  // Landing is about what they came for; visibility is about what they may see.
  assert.equal(showsOwnAccess(platformAdminWhoIsAlsoATenant), true)
  assert.equal(showsOwnAccess(launcherPlatformAdmin), false)
})

test('an unknown session never lands on a tenant page', () => {
  // Unreachable today -- the session is stored before sign-in completes -- but
  // the unknown case must not default towards a page that depends on knowing
  // who signed in.
  assert.equal(showsOwnAccess(null), false)
  assert.equal(landingPathFor(null), '/dashboard')
  assert.equal(showsOwnAccess(undefined), false)
})
