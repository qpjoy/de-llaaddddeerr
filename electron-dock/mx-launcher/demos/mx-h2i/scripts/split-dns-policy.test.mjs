#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  darwinSplitDnsStatusReady,
  invalidatePersistedDarwinSplitDnsProof,
  resolverRootCoversDomain,
  resolverRootsCoverDomains
} = require('../src/split-dns-policy.cjs');

assert.equal(
  resolverRootsCoverDomains(
    ['api.mxinfo-inc.cn', 'h2i.mxinfo-inc.cn'],
    ['mxinfo-inc.cn']
  ),
  true,
  'one resolver parent root must cover all expected child domains'
);
assert.equal(
  resolverRootsCoverDomains(['mxinfo-inc.cn'], ['mxinfo-inc.cn']),
  true,
  'an exact resolver root must cover the expected domain'
);
assert.equal(
  resolverRootCoversDomain('evilmxinfo-inc.cn', 'mxinfo-inc.cn'),
  false,
  'a textual suffix without a DNS label boundary must not be treated as a child domain'
);
assert.equal(
  resolverRootsCoverDomains(
    ['api.mxinfo-inc.cn', 'internal.mx'],
    ['mxinfo-inc.cn']
  ),
  false,
  'coverage must fail when any expected domain has no resolver root'
);
assert.equal(
  darwinSplitDnsStatusReady({
    applied: true,
    verified: true,
    resolverApplied: true,
    systemResolverMode: 'dynamic',
    resolverDomains: ['mxinfo-inc.cn', 'internal.mx']
  }, ['h2i.mxinfo-inc.cn', 'internal.mx']),
  true,
  'macOS split DNS is ready only after the live resolver and local relay are verified'
);
assert.equal(
  darwinSplitDnsStatusReady({
    applied: true,
    verified: false,
    resolverApplied: false,
    systemResolverMode: 'dynamic',
    resolverDomains: ['mxinfo-inc.cn']
  }, ['h2i.mxinfo-inc.cn']),
  false,
  'persisted desired resolver state must not be reported as live macOS split DNS'
);
const persistedDarwinProof = {
  applied: true,
  verified: true,
  resolverApplied: true,
  resolverDomains: ['mxinfo-inc.cn']
};
const invalidatedDarwinProof = invalidatePersistedDarwinSplitDnsProof(
  persistedDarwinProof,
  'darwin'
);
assert.notEqual(invalidatedDarwinProof, persistedDarwinProof);
assert.equal(invalidatedDarwinProof.applied, true, 'desired state remains available for repair');
assert.equal(invalidatedDarwinProof.verified, false, 'a prior process cannot prove its replacement listeners');
assert.equal(
  invalidatePersistedDarwinSplitDnsProof(persistedDarwinProof, 'win32'),
  persistedDarwinProof,
  'Darwin proof invalidation must not change the Windows runtime path'
);

console.log('split DNS policy tests passed');
