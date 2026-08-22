import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { loadConfig } from '../../config.js';
import {
  planLauncherProductUserAccessBackfill
} from '../../store/domain.js';
import { MemoryStore } from '../../store/memory.js';
import type { AuditEvent, UserCenterUser } from '../../types.js';

const config = loadConfig();
const now = '2026-08-23T12:00:00.000Z';

test('trusted legacy blocked and allowed events produce independent access markers', () => {
  const store = new MemoryStore(config);
  const blockedUser = createUser(store, 'usr_backfill_blocked', ['mx-h2i']);
  const allowedUser = createUser(store, 'usr_backfill_allowed', []);
  const blocked = audit(store, {
    eventType: 'launcher_network.product_user_access.blocked',
    productId: 'mx-h2i',
    userId: blockedUser.userId,
    requestId: 'legacy-blocked',
    metadata: { reason: 'legacy operator ban' }
  }, '2026-08-20T10:00:00.000Z');
  const allowed = audit(store, {
    eventType: 'launcher_network.product_user_access.allowed',
    productId: 'mx-h2i',
    userId: allowedUser.userId,
    requestId: 'legacy-allowed'
  }, '2026-08-20T11:00:00.000Z');

  const planned = buildPlan(store, [blocked, allowed]);

  assert.equal(planned.accesses.length, 2);
  assert.equal(planned.accesses.find((row) => row.userId === blockedUser.userId)?.blocked, true);
  assert.equal(planned.accesses.find((row) => row.userId === blockedUser.userId)?.reason, 'legacy operator ban');
  const allowedMarker = planned.accesses.find((row) => row.userId === allowedUser.userId);
  assert.equal(allowedMarker?.blocked, false, 'an explicit allowed audit must create a false marker');
  assert.equal(allowedMarker?.createdBy, 'launcher-product-user-access-backfill');
  assert.equal(planned.counts.migratedBlocked, 1);
  assert.equal(planned.counts.migratedAllowed, 1);
  assert.equal(planned.counts.conflicts, 0);
});

test('deniedAppIds alone and untrusted or inexact audits never become migration candidates', () => {
  const store = new MemoryStore(config);
  const user = createUser(store, 'usr_backfill_untrusted', ['mx-h2i']);
  const client = audit(store, {
    provenance: 'client',
    eventType: 'launcher_network.product_user_access.blocked',
    productId: 'mx-h2i',
    userId: user.userId
  }, '2026-08-20T10:00:00.000Z');
  const legacyWithoutProvenance = {
    ...audit(store, {
      eventType: 'launcher_network.product_user_access.blocked',
      productId: 'mx-h2i',
      userId: user.userId
    }, '2026-08-20T11:00:00.000Z'),
    provenance: undefined
  } as unknown as AuditEvent;
  const nearName = audit(store, {
    eventType: 'launcher_network.product_user_access.blocklisted',
    productId: 'mx-h2i',
    userId: user.userId
  }, '2026-08-20T12:00:00.000Z');
  const metadataOnly = audit(store, {
    eventType: 'launcher_network.product_user_access.blocked',
    metadata: { productId: 'mx-h2i', userId: user.userId }
  }, '2026-08-20T13:00:00.000Z');

  const planWithoutAudit = buildPlan(store, []);
  const ignoredPlan = buildPlan(store, [client, legacyWithoutProvenance, nearName, metadataOnly]);

  assert.equal(planWithoutAudit.accesses.length, 0, 'membership is consistency evidence, never a candidate source');
  assert.equal(ignoredPlan.accesses.length, 0);
  assert.equal(ignoredPlan.counts.auditEventsScanned, 4);
  assert.equal(ignoredPlan.counts.trustedStateEvents, 0);
  assert.equal(ignoredPlan.counts.candidatePairs, 0);
});

test('audit conflicts preserve both blocked and allowed legacy admission instead of changing behavior', () => {
  const store = new MemoryStore(config);
  const blockedUser = createUser(store, 'usr_backfill_conflict_blocked', ['mx-h2i']);
  const allowedUser = createUser(store, 'usr_backfill_conflict_allowed', []);
  const olderBlocked = audit(store, {
    eventType: 'launcher_network.product_user_access.blocked',
    productId: 'mx-h2i',
    userId: blockedUser.userId
  }, '2026-08-20T10:00:00.000Z');
  const latestAllowed = audit(store, {
    eventType: 'launcher_network.product_user_access.allowed',
    productId: 'mx-h2i',
    userId: blockedUser.userId
  }, '2026-08-20T11:00:00.000Z');
  const latestBlockedAgainstAllowedMembership = audit(store, {
    eventType: 'launcher_network.product_user_access.blocked',
    productId: 'mx-h2i',
    userId: allowedUser.userId
  }, '2026-08-20T12:00:00.000Z');

  const planned = buildPlan(store, [latestAllowed, olderBlocked, latestBlockedAgainstAllowedMembership]);

  assert.equal(planned.accesses.length, 2);
  assert.equal(planned.accesses.find((row) => row.userId === blockedUser.userId)?.blocked, true);
  assert.equal(planned.accesses.find((row) => row.userId === allowedUser.userId)?.blocked, false);
  assert.match(
    planned.accesses.find((row) => row.userId === blockedUser.userId)?.reason ?? '',
    /preserved deniedAppIds membership=blocked/
  );
  assert.match(
    planned.accesses.find((row) => row.userId === allowedUser.userId)?.reason ?? '',
    /preserved deniedAppIds membership=allowed/
  );
  assert.equal(planned.counts.trustedStateEvents, 3);
  assert.equal(planned.counts.candidatePairs, 2);
  assert.equal(planned.counts.conflicts, 2);
  assert.equal(planned.counts.migratedBlocked, 1);
  assert.equal(planned.counts.migratedAllowed, 1);
});

test('existing access is never overwritten and missing product or user candidates are skipped', () => {
  const store = new MemoryStore(config);
  const existingUser = createUser(store, 'usr_backfill_existing', ['mx-h2i']);
  const missingProductUser = createUser(store, 'usr_backfill_missing_product', ['retired-product']);
  store.setLauncherProductUserAccess({
    productId: 'mx-h2i',
    userId: existingUser.userId,
    blocked: false,
    requestedBy: 'current-admin',
    requestId: 'current-access'
  });
  const existing = audit(store, {
    eventType: 'launcher_network.product_user_access.blocked',
    productId: 'mx-h2i',
    userId: existingUser.userId
  }, '2026-08-20T10:00:00.000Z');
  const missingProduct = audit(store, {
    eventType: 'launcher_network.product_user_access.blocked',
    productId: 'retired-product',
    userId: missingProductUser.userId
  }, '2026-08-20T11:00:00.000Z');
  const missingUser = audit(store, {
    eventType: 'launcher_network.product_user_access.blocked',
    productId: 'mx-h2i',
    userId: 'usr_backfill_missing_user'
  }, '2026-08-20T12:00:00.000Z');

  const planned = buildPlan(store, [existing, missingProduct, missingUser]);

  assert.equal(planned.accesses.length, 0);
  assert.equal(planned.counts.skippedExisting, 1);
  assert.equal(planned.counts.skippedMissingProduct, 1);
  assert.equal(planned.counts.skippedMissingUser, 1);
  assert.equal(
    store.getLauncherProductUserAccess('mx-h2i', existingUser.userId)?.blocked,
    false,
    'the independent current record remains authoritative'
  );
});

test('Postgres startup backfill is one locked transaction with an in-transaction completion audit', () => {
  const source = readFileSync(new URL('../../store/postgres.ts', import.meta.url), 'utf8');
  const create = sourceSection(source, 'static async create(config:', 'async overview()');
  const backfill = sourceSection(
    source,
    'private async backfillLegacyLauncherProductUserAccess()',
    'async setLauncherProductUserAccess('
  );

  assert.ok(create.indexOf('registerBuiltinProductNetworks()') < create.indexOf('backfillLegacyLauncherProductUserAccess()'));
  assert.ok(create.indexOf('bootstrapUserCenter()') < create.indexOf('backfillLegacyLauncherProductUserAccess()'));
  assert.equal((backfill.match(/this\.dataSource\.transaction/g) ?? []).length, 1);
  assert.match(backfill, /pg_advisory_xact_lock/);
  assert.match(backfill, /legacy-audit-backfill-v1/);
  assert.match(backfill, /record\.data ->> 'provenance' = :provenance/);
  assert.match(backfill, /record\.data ->> 'eventType' IN/);
  assert.match(backfill, /NULLIF\(BTRIM\(record\.data ->> 'productId'\)/);
  assert.match(backfill, /NULLIF\(BTRIM\(record\.data ->> 'userId'\)/);
  assert.doesNotMatch(backfill, /listRecordsFrom<AuditEvent>\(records, 'audit-event'\)/);
  assert.match(backfill, /planLauncherProductUserAccessBackfill/);
  assert.match(backfill, /saveRecordTo[\s\S]*'launcher-product-user-access'/);
  assert.match(backfill, /recordAuditTo\(records/);
  assert.match(backfill, /launcher_network\.product_user_access_backfill\.completed/);
  assert.match(backfill, /'launcher-product-user-access-backfill'/);
  assert.match(backfill, /metadata: \{ \.\.\.plan\.counts, migrationId \}/);
  assert.match(backfill, /if \(completed\) return/);
  assert.match(backfill, /if \(plan\.counts\.candidatePairs > 0\)/);
  assert.match(backfill, /lockLauncherProductNetwork\(manager, pair\.productId\)[\s\S]*lockLauncherProductUserAccess/);
  assert.match(backfill, /FOR UPDATE/);
  assert.doesNotMatch(backfill, /setLauncherProductUserAccess\(/);
  assert.doesNotMatch(backfill, /releaseLauncherNetworkLease/);
  assert.doesNotMatch(
    backfill,
    /saveRecordTo\([\s\S]{0,120}records,[\s\S]{0,120}'iam-user'/,
    'the backfill must not rewrite user appAccess'
  );
});

function createUser(store: MemoryStore, userId: string, deniedAppIds: string[]): UserCenterUser {
  return store.createUserCenterUser({
    userId,
    account: userId,
    password: `${userId}-password`,
    deniedAppIds
  });
}

function audit(
  store: MemoryStore,
  input: Parameters<MemoryStore['recordAudit']>[0],
  createdAt: string
): AuditEvent {
  const event = store.recordAudit(input);
  event.createdAt = createdAt;
  return event;
}

function buildPlan(store: MemoryStore, auditEvents: AuditEvent[]) {
  return planLauncherProductUserAccessBackfill({
    environment: config.environment,
    auditEvents,
    users: store.listUserCenterUsers(),
    products: store.listLauncherProductNetworks(),
    existingAccess: store.listLauncherProductUserAccess(),
    now
  });
}

function sourceSection(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `expected source section ${start}`);
  return source.slice(from, to);
}
