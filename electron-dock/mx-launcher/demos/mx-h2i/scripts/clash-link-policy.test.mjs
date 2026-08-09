#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decideClashLinkAction, resolveEffectiveProxyNode } = require('../src/clash-link-policy.cjs');

const now = Date.parse('2026-08-09T12:00:00.000Z');
const future = '2026-10-09T12:00:00.000Z';
const past = '2026-07-09T12:00:00.000Z';

assert.equal(
  decideClashLinkAction({ local: null, remote: null, now }),
  'issue',
  'nothing anywhere means it is safe to issue the first link'
);

assert.equal(
  decideClashLinkAction({ local: { url: 'https://h2i.example/x.yaml', expiresAt: future }, remote: null, now }),
  'reuse',
  'a live local copy is used as-is'
);

assert.equal(
  decideClashLinkAction({ local: { url: 'https://h2i.example/x.yaml' }, remote: null, now }),
  'reuse',
  'no expiry recorded is treated as long-lived, not as a reason to rotate'
);

// This is the case that matters: issuing revokes the previous link, so a user who
// already pasted it into Clash would silently stop updating. Another machine
// holding the plaintext is not a reason to take it away from them.
assert.equal(
  decideClashLinkAction({ local: null, remote: { issuedAt: past, expiresAt: future }, now }),
  'remote-only',
  'an active server-side link is never silently rotated'
);
assert.equal(
  decideClashLinkAction({ local: { url: null, issuedAt: past, expiresAt: future }, remote: { issuedAt: past, expiresAt: future }, now }),
  'remote-only',
  'a metadata-only local record still must not trigger a rotation'
);

assert.equal(
  decideClashLinkAction({ local: { url: 'https://h2i.example/x.yaml', expiresAt: past }, remote: null, now }),
  'issue',
  'an expired local copy is replaced'
);
assert.equal(
  decideClashLinkAction({ local: null, remote: { issuedAt: past, expiresAt: past }, now }),
  'issue',
  'an expired server-side link no longer blocks issuing a fresh one'
);

assert.equal(
  decideClashLinkAction({ local: { url: 'https://h2i.example/x.yaml', expiresAt: past }, remote: { issuedAt: past, expiresAt: future }, now }),
  'remote-only',
  'an expired local copy does not authorise rotating a still-active server link'
);

for (const junk of [undefined, null, {}, { url: '' }, 'nope', 42]) {
  assert.equal(
    decideClashLinkAction({ local: junk, remote: junk, now }),
    'issue',
    `malformed input ${JSON.stringify(junk)} falls back to issuing rather than throwing`
  );
}

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
