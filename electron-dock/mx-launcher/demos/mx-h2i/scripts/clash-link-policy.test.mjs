#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { decideClashLinkAction, resolveEffectiveProxyNode } = require('../src/clash-link-policy.cjs');

const now = Date.parse('2026-08-09T12:00:00.000Z');
const future = '2026-10-09T12:00:00.000Z';
const past = '2026-07-09T12:00:00.000Z';

const userId = 'usr_feishu_test';
const local = { userId, url: 'https://h2i.example/x.yaml', issuedAt: past, expiresAt: future };
const remote = { issuedAt: past, expiresAt: future };
const cases = [
  [{ local: null, remote: null }, 'issue', 'confirmed absence allows first issuance'],
  [{ local, remote }, 'reuse', 'same owner and server expiry allow reuse'],
  [{ local }, 'defer', 'unknown server state never permits local-only reuse or issuance'],
  [{ local, remote: {} }, 'defer', 'malformed metadata never authorises rotation'],
  [{ local, remote: null }, 'missing', 'revocation requires an explicit user action'],
  [{ local: { ...local, expiresAt: past }, remote: null }, 'missing', 'expired history is not silently replaced'],
  [{ local: { ...local, userId: 'usr_other' }, remote }, 'remote-only', 'switching users cannot copy another user link'],
  [{ local: { ...local, userId: null }, remote }, 'remote-only', 'legacy unbound cache must not be trusted'],
  [{ local: { ...local, expiresAt: '2027-01-01T00:00:00Z' }, remote }, 'remote-only', 'Admin rotation invalidates an unexpired local cache'],
  [{ local: null, remote }, 'remote-only', 'existing server link is never silently rotated'],
  [{ local: { ...local, url: null }, remote }, 'remote-only', 'metadata is not a recoverable URL'],
  [{ local: { ...local, expiresAt: past }, remote }, 'remote-only', 'expired cache cannot revoke an active server link'],
];
for (const [input, expected, reason] of cases) {
  assert.equal(decideClashLinkAction({ ...input, userId, now }), expected, reason);
}

// Exercise the production hydrate orchestration without booting Electron or
// accessing real user accounts. A metadata failure must never reach issuance.
const runtimeSource = readFileSync(new URL('../src/main-runtime.cjs', import.meta.url), 'utf8');
const rendererSource = readFileSync(new URL('../src/renderer.js', import.meta.url), 'utf8');
function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
async function hydrate({ cache = local, metadata = remote, fail = false, switchUser = false } = {}) {
  let issues = 0;
  let lookups = 0;
  const context = vm.createContext({
    runtime: { connection: { internalBaseUrl: 'https://internal.example' }, apps: { h2o: { runtime: { clashLink: cache } } } },
    h2oPluginRuntime: value => ({ ...value }),
    normalizeBaseUrl: value => value || null,
    nullableString: value => value || null,
    h2oCurrentUserId: async () => switchUser && lookups++ > 0 ? 'usr_other' : userId,
    h2oRequestInternalJson: async () => {
      if (fail) throw new Error('offline');
      return { payload: { link: metadata } };
    },
    appCenterCatalogHeaders: () => ({}),
    decideClashLinkAction: input => decideClashLinkAction({ ...input, now }),
    issueH2oClashSubscriptionLink: async () => { issues++; return local; },
    pushAppLog: () => {}, errorMessage: error => error.message,
    state: { auth: { user: { userId } } }
  });
  vm.runInContext(`async ${functionSource(runtimeSource, 'ensureH2oClashSubscriptionLink')}`, context);
  vm.runInContext(functionSource(rendererSource, 'normalizeH2oClashLinkUi'), context);
  await context.ensureH2oClashSubscriptionLink();
  const cached = context.runtime.apps.h2o.runtime.clashLink;
  return { issues, cached, display: context.normalizeH2oClashLinkUi(cached) };
}
let result = await hydrate();
assert.equal(result.issues, 0);
assert.equal(result.display.url, local.url);
result = await hydrate({ fail: true });
assert.equal(result.issues, 0, 'network failure must not rotate a public URL');
assert.equal(result.cached.url, local.url, 'private cache survives a transient failure');
assert.equal(result.display.url, null, 'unverified cache cannot be copied');
result = await hydrate({ metadata: { ...remote, expiresAt: '2036-10-09T12:00:00.000Z' } });
assert.equal(result.issues, 0);
assert.equal(result.cached.status, 'remote-only');
assert.equal(result.display.url, null, 'Admin rotation hides the obsolete cached URL');
result = await hydrate({ cache: { ...local, userId: 'usr_other' } });
assert.equal(result.issues, 0);
assert.equal(result.display.url, null, 'cached URLs never cross accounts');
result = await hydrate({ metadata: null });
assert.equal(result.issues, 0);
assert.equal(result.cached.status, 'missing', 'revoked links require explicit regeneration');
result = await hydrate({ cache: null, metadata: null });
assert.equal(result.issues, 1, 'first issuance remains available after confirmed absence');
assert.equal(result.display.url, local.url);
result = await hydrate({ switchUser: true, metadata: null });
assert.equal(result.issues, 0, 'changing accounts during lookup cancels automatic issuance');
assert.equal(result.display.url, null);

// --- resolveEffectiveProxyNode ---

const hk01 = 'mx-oversea-hk01-hysteria2';
const main = 'oversea-main-hysteria2';
const twoHop = {
  Oversea: { now: 'Oversea-Auto' },
  'Oversea-Auto': { now: hk01 },
  [hk01]: {},
  [main]: {}
};

assert.equal(
  resolveEffectiveProxyNode(twoHop, 'Oversea'),
  hk01,
  'select -> fallback -> node resolves to the node actually carrying traffic'
);

// 这是这个函数存在的理由：用户选的仍是 Oversea-Auto，但 fallback 已经顺延到第二个节点。
assert.equal(
  resolveEffectiveProxyNode({ ...twoHop, 'Oversea-Auto': { now: main } }, 'Oversea'),
  main,
  'a failed-over group reports the node it moved to, not the first one listed'
);

assert.equal(
  resolveEffectiveProxyNode({ Oversea: { now: hk01 }, [hk01]: {} }, 'Oversea'),
  hk01,
  'a directly pinned node needs no extra hop'
);
assert.equal(
  resolveEffectiveProxyNode({ Oversea: {} }, 'Oversea'),
  'Oversea',
  'a group with no current selection resolves to itself'
);
assert.equal(
  resolveEffectiveProxyNode({ Oversea: { now: 'Oversea' } }, 'Oversea'),
  'Oversea',
  'a self-referencing group terminates instead of looping'
);
assert.equal(
  resolveEffectiveProxyNode({ A: { now: 'B' }, B: { now: 'A' } }, 'A', 4),
  'A',
  'a cycle terminates at the hop limit rather than hanging the refresh'
);
assert.equal(
  resolveEffectiveProxyNode({ Oversea: { now: 'ghost' } }, 'Oversea'),
  null,
  'a dangling reference reports nothing instead of a bogus node name'
);
for (const junk of [null, undefined, 'nope', 42]) {
  assert.equal(
    resolveEffectiveProxyNode(junk, 'Oversea'),
    null,
    `malformed proxies payload ${JSON.stringify(junk)} is handled`
  );
}

console.log('clash-link-policy tests passed');
