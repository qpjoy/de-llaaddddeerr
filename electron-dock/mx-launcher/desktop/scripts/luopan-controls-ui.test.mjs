import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../renderer.js', import.meta.url), 'utf8');
const functions = ['applyUserLuopanControls', 'syncUserLuopanLoginDraft', 'loadUserLuopanControls', 'saveUserLuopanControls']
  .map(name => {
    const fn = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^\\}`, 'm'))?.[0];
    assert.ok(fn, name); return fn;
  }).join('\n');
const payload = (id = 'user-a', overrides = {}) => ({
  policy: { appId: 'luopan', userId: id, updatesBlocked: false, reason: '', revision: 0, ...overrides },
  loginBlocked: false, coverage: { status: 'unconfirmed', installCount: 0 }
});
function fixture(request) {
  const user = { userId: 'user-a', appAccess: { deniedAppIds: ['other-app'] } };
  const drawer = { mode: 'edit', userId: 'user-a', draft: { deniedAppIds: 'other-app', displayName: 'Unsaved name' } };
  const state = { userCenter: { drawer, busy: false } };
  const api = Function('state', 'fetchJson', 'userCenterUserById', `
    const asArray = value => Array.isArray(value) ? value : [];
    const stringListFromText = value => String(value || '').split(',').map(v => v.trim()).filter(Boolean);
    const textFromStringList = value => asArray(value).join(', ');
    function renderUserEditorDrawer() {}
    ${functions}
    return { loadUserLuopanControls, saveUserLuopanControls };
  `)(state, request, () => user);
  return { state, drawer, user, ...api };
}

test('update-only save keeps login unchanged and preserves unsaved profile and other denied apps', async () => {
  const calls = [];
  const f = fixture(async (url, options) => {
    calls.push({ url, options });
    return payload('user-a', options ? { updatesBlocked: true, revision: 1 } : {});
  });
  await f.loadUserLuopanControls();
  assert.equal(f.drawer.luopanControls.updatesBlocked, false);
  assert.equal(f.drawer.luopanControls.loginBlocked, false);
  f.drawer.luopanControls.updatesBlocked = true;
  f.drawer.luopanControls.reason = '  support  ';
  await f.saveUserLuopanControls();
  assert.deepEqual(calls[1].options.body, { updatesBlocked: true, reason: 'support', expectedRevision: 0 });
  assert.equal(f.drawer.draft.displayName, 'Unsaved name');
  assert.equal(f.drawer.draft.deniedAppIds, 'other-app');
  assert.deepEqual(f.user.appAccess.deniedAppIds, ['other-app']);
  assert.equal(f.drawer.luopanControls.policy.revision, 1);
});

test('login is sent only when explicitly changed and updates the generic denied-app view after success', async () => {
  const calls = [];
  const f = fixture(async (_url, options) => {
    calls.push(options);
    return options ? { ...payload('user-a', { revision: 1 }), loginBlocked: true } : payload();
  });
  await f.loadUserLuopanControls();
  f.drawer.luopanControls.loginBlocked = true;
  await f.saveUserLuopanControls();
  assert.equal(calls[1].body.loginBlocked, true);
  assert.equal(f.drawer.draft.deniedAppIds, 'other-app, luopan');
  await f.saveUserLuopanControls();
  assert.equal(Object.hasOwn(calls[2].body, 'loginBlocked'), false);
});

test('failed or malformed GET cannot submit default false settings', async () => {
  for (const result of [new Error('offline'), {}, payload('another-user')]) {
    let writes = 0;
    const f = fixture(async (_url, options) => {
      if (options) writes++;
      if (result instanceof Error) throw result;
      return result;
    });
    await f.loadUserLuopanControls();
    await f.saveUserLuopanControls();
    assert.equal(f.drawer.luopanControls.loaded, false);
    assert.ok(f.drawer.luopanControls.error);
    assert.equal(writes, 0);
  }
});

test('late read and save results do not change another user or a closed drawer', async () => {
  for (const action of ['read', 'save']) {
    for (const closed of [false, true]) {
    let release;
    const f = fixture((_url, options) => action === 'save' && !options
      ? Promise.resolve(payload()) : new Promise(resolve => { release = resolve; }));
    if (action === 'save') await f.loadUserLuopanControls();
    const pending = action === 'read' ? f.loadUserLuopanControls() : f.saveUserLuopanControls();
    const next = closed ? null : { mode: 'edit', userId: 'user-b', draft: { deniedAppIds: 'keep-me' } };
    f.state.userCenter.drawer = next;
    release({ ...payload('user-a', { revision: 1 }), loginBlocked: true });
    await pending;
    assert.equal(f.state.userCenter.drawer, next);
    if (next) assert.deepEqual(next.draft, { deniedAppIds: 'keep-me' });
    assert.deepEqual(f.user.appAccess.deniedAppIds, ['other-app']);
    }
  }
});

test('conflicts stop writes until an explicit reload restores the latest revision', async () => {
  let writes = 0;
  const f = fixture(async (_url, options) => {
    if (options) { writes++; throw Object.assign(new Error('conflict'), { status: 409 }); }
    return payload('user-a', { revision: writes ? 2 : 0, updatesBlocked: writes > 0 });
  });
  await f.loadUserLuopanControls(); await f.saveUserLuopanControls(); await f.saveUserLuopanControls();
  assert.equal(writes, 1);
  assert.match(f.drawer.luopanControls.error, /其他管理员/);
  await f.loadUserLuopanControls();
  assert.equal(f.drawer.luopanControls.policy.revision, 2);
  assert.equal(f.drawer.luopanControls.updatesBlocked, true);
  assert.equal(f.drawer.luopanControls.error, null);
});

test('generic user save preserves server-side Luopan login access and never posts update policy', () => {
  const save = source.match(/^async function saveUserCenterUserFromEditor\([^]*?^\}/m)?.[0];
  assert.match(save, /!createMode \? \{ preserveLuopanLoginAccess: true \}/);
  assert.doesNotMatch(save, /updatesBlocked:|\/luopan-controls/);
  assert.match(source, /userAppOptions\(draft\.deniedAppIds, editing\)/);
});
