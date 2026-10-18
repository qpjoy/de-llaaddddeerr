import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.js';
import { createPlatformDataSource } from '../db/data-source.js';
import { RegistrationRepository, type RegistrationSource } from './repository.js';
import { IdentityRepository } from '../identity/repository.js';
const databaseUrl = process.env.MX_SSO_TEST_DATABASE_URL;

test('dedicated DataPort invitations admit MX owners atomically without changing their credentials or other applications', { skip: !databaseUrl }, async () => {
  const url = new URL(databaseUrl!); assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname.includes('sso_test'));
  const environment = `harbor-admission-${randomUUID()}`, db = createPlatformDataSource({ ...loadConfig(), databaseUrl: databaseUrl!, environment, storeDriver: 'postgres' });
  await db.initialize(); await db.runMigrations();
  const repo = new RegistrationRepository(databaseUrl!, environment, 'launcher', 'test'), identity = new IdentityRepository(databaseUrl!, environment, environment, 'fixture');
  await identity.initialize();
  const hub: RegistrationSource = { issuer: 'https://auth.example.test/identity', clientId: 'hub', appId: 'mx-insight-hub', appOrigin: 'https://hub.example.test' };
  const harbor = { ...hub, clientId: 'harbor', appId: 'mx-harbor', appOrigin: 'https://harbor.example.test' };
  try {
    assert.equal((await repo.policy(harbor)).mode, 'closed');
    let policy = await repo.updatePolicy({ mode: 'invite_code', hubMode: 'open', applicationModes: { 'mx-harbor': 'invite_code' }, version: 0 });
    assert.equal((await repo.policy(harbor)).mode, 'invite_code'); assert.equal((await repo.policy(hub)).mode, 'open');
    const register = (account: string, source = hub, inviteCode = '', transactionId = randomUUID()) => repo.register({ clientId: 'launcher', transactionId, account, password: 'FixturePassword123!', policyVersion: policy.version, source, inviteCode });
    const user = await register('ExistingOwner'), other = await register('OtherOwner'), before = (await identity.account(user.userId))!;
    const credential = () => db.query("SELECT data FROM mx_platform_records WHERE environment=$1 AND kind='iam-user-credential' AND id=$2", [environment, user.userId]);
    const savedCredential = await credential();
    const invite = (label: string) => repo.createInvitation({ label, days: 1, maxUses: 1, admissionAppId: 'mx-harbor' });
    const uses = async (id: string) => (await repo.invitations()).find(i => i.id === id)!.uses;
    const admit = (userId: string, inviteCode: string) => repo.redeemAdmission({ userId, source: harbor, inviteCode });
    const ordinary = await repo.createInvitation({ label: 'Ordinary MX', days: 1, maxUses: 1 }), code = await invite('Existing owner');
    await assert.rejects(admit(user.userId, ''), { code: 'invitation_unavailable' });
    await assert.rejects(admit(user.userId, ordinary.code), { code: 'invitation_unavailable' });
    await assert.rejects(repo.redeemAdmission({ userId: user.userId, source: hub, inviteCode: code.code }), { code: 'invalid_registration_source' });
    assert.deepEqual(await identity.account(user.userId), before);
    assert.deepEqual(await admit(user.userId, code.code), user); await admit(user.userId, code.code);
    assert.equal(await uses(code.invitation.id), 1); await assert.rejects(admit(other.userId, code.code), { code: 'invitation_unavailable' });
    const after = (await identity.account(user.userId))!;
    assert.deepEqual({ ...after, updatedAt: before.updatedAt, appAccess: before.appAccess }, before);
    assert.deepEqual(after.appAccess, { ...before.appAccess, allowedAppIds: [...before.appAccess.allowedAppIds, 'mx-harbor'] });
    assert.deepEqual(await credential(), savedCredential); assert.equal((await identity.authenticate('ExistingOwner', 'FixturePassword123!'))?.userId, user.userId);

    const signup = await invite('New owner'), tx = randomUUID();
    await assert.rejects(register('MissingCode', harbor), { code: 'invitation_unavailable' });
    await assert.rejects(register('WrongCode', harbor, ordinary.code), { code: 'invitation_unavailable' });
    const created = await register('InvitedOwner', harbor, signup.code, tx); assert.deepEqual(await register('InvitedOwner', harbor, signup.code, tx), created);
    const owner = (await identity.account(created.userId))!;
    assert.deepEqual(owner.appAccess.allowedAppIds, ['mx-harbor']); assert.deepEqual(owner.appAccess.deniedAppIds, ['mx-h2i', 'luopan']); assert.deepEqual(owner.roleIds, ['mx-user']);
    assert.equal(await uses(signup.invitation.id), 1);
    await assert.rejects(repo.register({ transactionId: randomUUID(), clientId: 'launcher', source: harbor, account: 'WrongProof', password: 'FixturePassword123!', policyVersion: policy.version, inviteCode: signup.code, verifiedFeishuSubject: 'fixture:subject' }), { code: 'invalid_registration_source' });
    const revoked = await invite('Revoked'); await repo.revokeInvitation(revoked.invitation.id); await assert.rejects(admit(other.userId, revoked.code), { code: 'invitation_unavailable' });
    const expired = await invite('Expired');
    await db.query("UPDATE mx_platform_records SET data=jsonb_set(data,'{expiresAt}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) WHERE environment=$1 AND kind='registration-invite' AND id=$2", [environment, expired.invitation.id]);
    await assert.rejects(admit(other.userId, expired.code), { code: 'invitation_unavailable' });
    const denied = await register('DeniedOwner'), unused = await invite('Denied account cannot consume');
    await db.query("UPDATE mx_platform_records SET data=jsonb_set(data,'{appAccess,deniedAppIds}','[\"mx-h2i\",\"luopan\",\"mx-harbor\"]'::jsonb) WHERE environment=$1 AND kind='iam-user' AND id=$2", [environment, denied.userId]);
    await assert.rejects(admit(denied.userId, unused.code), { code: 'admission_denied' }); assert.equal(await uses(unused.invitation.id), 0);
    const raceUser = await register('RaceOwner'), lastSeat = await invite('Last seat');
    const race = await Promise.allSettled([admit(other.userId, lastSeat.code), admit(raceUser.userId, lastSeat.code)]);
    assert.equal(race.filter(r => r.status === 'fulfilled').length, 1); assert.equal(await uses(lastSeat.invitation.id), 1);
    policy = await repo.updatePolicy({ ...policy, applicationModes: { 'mx-harbor': 'closed' } });
    const fresh = await register('ClosedOwner'); await assert.rejects(admit(fresh.userId, unused.code), { code: 'registration_closed' });
    await assert.rejects(register('ClosedSignup', harbor, unused.code), { code: 'registration_closed' }); assert.equal((await repo.policy(hub)).mode, 'open');
  } finally {
    await repo.close(); await identity.close(); await db.query('DELETE FROM mx_platform_records WHERE environment=$1', [environment]);
    await db.query('DELETE FROM mx_identity_records WHERE scope=$1', [environment]); await db.destroy();
  }
});
