import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createAppAccount } from './app-account.js';
import { RegistrationClientError } from '../registration/backchannel.js';

// Exercise the real native account handler without a listener or production credentials.
function fixture({ admitted = false, closed = false, appId = 'mx-harbor' } = {}) {
  const flow = 'f'.repeat(43), uid = 'interaction', clientId = 'fixture-client', secret = 's'.repeat(43);
  const user: any = { userId: 'authenticated-user', account: 'FixtureOwner', status: 'active',
    appAccess: { allowedAppIds: admitted ? ['mx-harbor'] : [], deniedAppIds: [] } };
  const rows = new Map<string, any>([
    [`app-flow:${flow}`, { uid, clientId }], [`app-active:${uid}`, { handle: flow }], [`app-completion-lock:${flow}`, {}],
  ]);
  const calls: any[] = [];
  const accounts: any = {
    webState: {
      put: async (kind: string, id: string, value: any) => { rows.set(`${kind}:${id}`, value); },
      read: async (kind: string, id: string, consume = false) => { const value = rows.get(`${kind}:${id}`); if (consume) rows.delete(`${kind}:${id}`); return value; },
      remove: async (kind: string, id: string) => { rows.delete(`${kind}:${id}`); },
    },
    account: async (id: string) => id === user.userId ? user : undefined,
    hasLogin: async (login: string) => login === user.account,
    authenticate: async (login: string, password: string) => login === user.account && password === 'FixturePassword123!' ? user : undefined,
    allowAttempt: async () => true, allowRegistrationAttempt: async () => true,
  };
  const policy = { mode: closed ? 'closed' as const : 'invite_code' as const, version: 3 };
  const registration: any = {
    policy: async () => policy, feishu: async () => ({ enabled: true }),
    redeemAdmission: async (input: any) => {
      calls.push({ action: 'admit', input });
      if (closed) throw new RegistrationClientError(403, 'DataPort 暂未开放邀请。');
      if (input.inviteCode !== 'synthetic-dataport-invite') throw new RegistrationClientError(400, '专用邀请码无效。');
      user.appAccess.allowedAppIds.push('mx-harbor'); return { userId: user.userId };
    },
    register: async (input: any) => {
      calls.push({ action: 'register', input });
      if (input.inviteCode !== 'synthetic-dataport-invite') throw new RegistrationClientError(400, '专用邀请码无效。');
      user.appAccess.allowedAppIds.push('mx-harbor'); return { userId: user.userId };
    },
  };
  const handler = createAppAccount({ Interaction: { find: async () => ({ params: { client_id: clientId, mx_surface: 'application' } }) } } as any,
    { issuer: 'https://auth.example.test/identity', origin: 'https://auth.example.test', applications: [
      { clientId, clientSecret: secret, appId, origin: 'https://dataport.example.test', audience: appId },
    ] } as any, accounts, registration);
  async function call(action: string, input: any = {}, headers: any = {}) {
    const req: any = Readable.from([JSON.stringify({ action, input: { flow, ...input } })]);
    req.method = 'POST'; req.headers = { authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`, 'content-type': 'application/json', ...headers };
    let status = 0, payload: any;
    const res: any = { writeHead(code: number) { status = code; return this; }, end(body: string) { payload = JSON.parse(body); } };
    await handler.handle(req, res); return { status, payload };
  }
  return { call, calls, rows, flow, user, accounts };
}
const login = { login: 'FixtureOwner', password: 'FixturePassword123!' };

test('DataPort routing is client-authenticated, private and does not authenticate or redeem invitations', async () => {
  const f = fixture();
  assert.deepEqual((await f.call('resolve-login',{login:login.login})).payload,{exists:true});
  assert.deepEqual((await f.call('resolve-login',{login:'unknown'})).payload,{exists:false});
  assert.equal((await f.call('resolve-login',{login:login.login},{origin:'https://dataport.example.test'})).status,403);
  assert.equal((await f.call('resolve-login',{login:login.login},{authorization:'Basic invalid'})).status,401);
  assert.equal((await fixture({appId:'mx-insight-hub'}).call('resolve-login',{login:login.login})).status,403);
  assert.equal(f.calls.length,0); assert.ok(!f.rows.has(`app-result:${f.flow}`));
  const limited = fixture(); limited.accounts.allowAttempt = async () => false;
  assert.equal((await limited.call('resolve-login',{login:login.login})).status,429);
});

test('DataPort advertises invitation admission and keeps Feishu disabled; other app options stay unchanged', async () => {
  const f = fixture(); const options = await f.call('options');
  assert.equal(options.payload.admissionRequired, true); assert.equal(options.payload.policy.mode, 'invite_code'); assert.equal(options.payload.feishu, false);
  assert.equal((await f.call('feishu')).status, 403); assert.equal(f.calls.length, 0);
  const hub = await fixture({ appId: 'mx-insight-hub' }).call('options');
  assert.equal(hub.payload.admissionRequired, false); assert.equal(hub.payload.feishu, true);
});

test('only verified MX identity can redeem an invite; failed admission retains a retryable flow and success submits once', async () => {
  const f = fixture();
  assert.equal((await f.call('login', { ...login, password: 'wrong', inviteCode: 'synthetic-dataport-invite' })).status, 401);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.call('login', login)).status, 400); assert.ok(!f.rows.has(`app-result:${f.flow}`));
  const accepted = await f.call('login', { ...login, userId: 'not-the-authenticated-user', inviteCode: 'synthetic-dataport-invite' });
  assert.equal(accepted.status, 200); assert.equal(f.calls.at(-1).input.userId, f.user.userId);
  assert.equal(f.calls.at(-1).input.source.appId, 'mx-harbor');
  assert.equal(f.rows.get(`app-result:${f.flow}`).userId, f.user.userId);
  const count = f.calls.length; assert.equal((await f.call('login', login)).status, 409); assert.equal(f.calls.length, count);
});

test('already admitted MX accounts log in without redeeming another invite', async () => {
  const f = fixture({ admitted: true });
  assert.equal((await f.call('login', { ...login, inviteCode: 'unused' })).status, 200); assert.equal(f.calls.length, 0);
});

test('closed admission, invalid client, browser-origin calls and stale flows cannot finish authentication', async () => {
  const closed = fixture({ closed: true });
  assert.equal((await closed.call('login', { ...login, inviteCode: 'synthetic-dataport-invite' })).status, 403);
  assert.ok(!closed.rows.has(`app-result:${closed.flow}`));
  const f = fixture();
  assert.equal((await f.call('login', login, { authorization: 'Basic invalid' })).status, 401);
  assert.equal((await f.call('login', login, { origin: 'https://untrusted.example.test' })).status, 403);
  assert.equal((await f.call('login', { ...login, flow: 'x'.repeat(43) })).status, 410);
  assert.equal(f.calls.length, 0);
});

test('invited superadmin registration validates confirmation and forwards the dedicated invite and registered source', async () => {
  const f = fixture();
  assert.equal((await f.call('register', { ...login, passwordConfirm: 'different' })).status, 400); assert.equal(f.calls.length, 0);
  assert.equal((await f.call('register', { ...login, passwordConfirm: login.password })).status, 400);
  assert.ok(!f.rows.has(`app-result:${f.flow}`));
  assert.equal((await f.call('register', { ...login, passwordConfirm: login.password, inviteCode: 'synthetic-dataport-invite', policyVersion: 3 })).status, 200);
  assert.equal(f.calls.at(-1).input.source.appId, 'mx-harbor'); assert.equal(f.calls.at(-1).input.inviteCode, 'synthetic-dataport-invite');
  assert.equal(f.calls.at(-1).input.enterpriseInvitation, undefined);
});
