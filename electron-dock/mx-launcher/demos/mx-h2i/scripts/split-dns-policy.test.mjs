#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  darwinSplitDnsStatusReady,
  darwinSystemResolutionExpectedTargets,
  darwinSystemResolutionResultReady,
  invalidatePersistedDarwinSplitDnsProof,
  macBackgroundSystemDomainProxyRepairEnabled,
  firstResolverCoveredHost,
  resolverRootCoversDomain,
  resolverRootsCoverDomains,
  systemDomainProxyDomains
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
  firstResolverCoveredHost(
    ['mxinfo-inc.cn', 'api.mxinfo-inc.cn'],
    ['h2i.i.minsight-ai.com', 'h2i.mxinfo-inc.cn', 'mxinfo-inc.cn']
  ),
  'h2i.mxinfo-inc.cn',
  'a public Clash/bootstrap diagnostic host must be skipped in favor of an Internal child zone'
);
assert.equal(
  firstResolverCoveredHost(['mxinfo-inc.cn'], ['h2i.i.minsight-ai.com']),
  null,
  'an unrelated public diagnostic host must never become split-DNS proof'
);
assert.equal(
  firstResolverCoveredHost(
    ['mxinfo-inc.cn', 'api.mxinfo-inc.cn'],
    ['api.mxinfo-inc.cn', 'h2i.mxinfo-inc.cn']
  ),
  'h2i.mxinfo-inc.cn',
  'an exact child must outrank an equal V1 resolver root even when the root is configured first'
);
assert.deepEqual(
  systemDomainProxyDomains(
    ['mxinfo-inc.cn', 'api.mxinfo-inc.cn'],
    firstResolverCoveredHost(
      ['mxinfo-inc.cn', 'api.mxinfo-inc.cn'],
      ['h2i.i.minsight-ai.com', 'h2i.mxinfo-inc.cn']
    ),
    []
  ),
  ['mxinfo-inc.cn', 'api.mxinfo-inc.cn', 'h2i.mxinfo-inc.cn'],
  'a public Clash diagnostic override must still install the exact Internal child resolver'
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
    resolverDomains: ['mxinfo-inc.cn', 'internal.mx'],
    systemResolution: {
      ready: true,
      proof: 'system-dns-lookup',
      state: 'expected-internal',
      ok: true,
      expectedInternalTargets: ['10.88.88.88'],
      addresses: [
        { address: '10.88.88.88', classification: 'expected-internal-target' }
      ]
    }
  }, ['h2i.mxinfo-inc.cn', 'internal.mx']),
  true,
  'macOS split DNS is ready only after metadata and the real system resolver are verified'
);
assert.equal(
  darwinSystemResolutionResultReady({
    ok: true,
    expectedInternalTargets: ['10.88.88.88'],
    addresses: [
      { address: '10.88.88.88', classification: 'expected-internal-target' },
      { address: '198.18.0.39', classification: 'proxy-fake-ip' }
    ]
  }),
  false,
  'a mixed Internal and Clash fake-IP answer must not count as macOS system DNS ready'
);
assert.equal(
  darwinSystemResolutionResultReady({
    ok: true,
    expectedInternalTargets: ['10.88.88.88'],
    addresses: [
      { address: '10.88.100.3', classification: 'internal-overlay' }
    ]
  }),
  false,
  'a Luopan or unrelated V2 overlay target must not count as MX-H2I ready'
);
assert.equal(
  darwinSystemResolutionResultReady({
    ok: true,
    expectedInternalTargets: [],
    addresses: [
      { address: '10.88.88.88', classification: 'expected-internal-target' }
    ]
  }),
  false,
  'an empty product target contract must fail closed'
);
assert.deepEqual(
  darwinSystemResolutionExpectedTargets('h2i.mxinfo-inc.cn', [
    { host: 'h2i.mxinfo-inc.cn', dnsTarget: '10.88.88.88', enabled: true },
    { host: 'luopan.mxinfo-inc.cn', dnsTarget: '10.88.100.3', enabled: true }
  ], '10.88.88.88'),
  ['10.88.88.88'],
  'the exact host route must match the MX-H2I ProductNetwork target'
);
assert.deepEqual(
  darwinSystemResolutionExpectedTargets('h2i.mxinfo-inc.cn', [
    { host: 'h2i.mxinfo-inc.cn', dnsTarget: '10.88.100.3', enabled: true }
  ], '10.88.88.88'),
  [],
  'an exact H2I route misdirected to the Luopan VIP must fail closed'
);
assert.deepEqual(
  darwinSystemResolutionExpectedTargets('h2i.mxinfo-inc.cn', [
    { host: 'h2i.mxinfo-inc.cn', dnsTarget: '10.88.88.88', enabled: true }
  ], '10.88.100.1'),
  [],
  'a stale legacy route must not override an explicit future MX-H2I target'
);
assert.deepEqual(
  darwinSystemResolutionExpectedTargets('h2i.mxinfo-inc.cn', [], '10.88.88.88'),
  ['10.88.88.88'],
  'the current MX-H2I fallback target is used only when no exact route exists'
);
assert.equal(
  darwinSplitDnsStatusReady({
    applied: true,
    verified: true,
    resolverApplied: true,
    systemResolverMode: 'dynamic',
    resolverDomains: ['mxinfo-inc.cn'],
    systemResolution: {
      ready: false,
      proof: 'system-dns-lookup',
      state: 'proxy-fake-ip'
    }
  }, ['h2i.mxinfo-inc.cn']),
  false,
  'Clash fake-IP from the system resolver must keep macOS in tunnel-only'
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
assert.equal(
  macBackgroundSystemDomainProxyRepairEnabled(undefined),
  false,
  'macOS background refresh must be read-only unless privileged repair is explicitly enabled'
);
assert.equal(macBackgroundSystemDomainProxyRepairEnabled('0'), false);
assert.equal(macBackgroundSystemDomainProxyRepairEnabled('false'), false);
assert.equal(macBackgroundSystemDomainProxyRepairEnabled('1'), true);
assert.equal(macBackgroundSystemDomainProxyRepairEnabled(' TRUE '), true);
assert.deepEqual(
  systemDomainProxyDomains(
    ['mxinfo-inc.cn', 'internal.mx'],
    'h2i.mxinfo-inc.cn',
    ['night-all.mxinfo-inc.cn']
  ),
  [
    'mxinfo-inc.cn',
    'internal.mx',
    'h2i.mxinfo-inc.cn',
    'night-all.mxinfo-inc.cn'
  ],
  'the exact V2 diagnostic host must coexist with a parent V1 HDO resolver zone'
);
assert.deepEqual(
  systemDomainProxyDomains(['mxinfo-inc.cn'], 'public.example.com', []),
  ['mxinfo-inc.cn'],
  'an unrelated diagnostic host must not be added to the system PAC or resolver'
);

const repairScript = readFileSync(
  fileURLToPath(new URL('./repair-macos-dns.sh', import.meta.url)),
  'utf8'
);
assert.match(
  repairScript,
  /test_host_covered[\s\S]*DOMAINS="\$DOMAINS \$TEST_HOST"/,
  'the manual repair path must add a covered exact H2I host without removing a V1 parent resolver'
);
assert.match(
  repairScript,
  /MX_H2I_DNS_EXPECTED_TARGETS:-10\.88\.88\.88[\s\S]*addresses_match_expected_targets[\s\S]*dscacheutil -q host -a name "\$TEST_HOST"/,
  'the manual repair path must verify the real macOS system resolver, not only dig the local relay'
);
assert.match(
  repairScript,
  /relay_ipv4=[\s\S]*addresses_match_expected_targets "\$relay_ipv4"/,
  'the direct relay must return the exact MX-H2I product target before repair is accepted'
);
assert.doesNotMatch(
  repairScript,
  /\$0 !~ \/\^10\\\.\//,
  'the manual repair path must not accept every 10/8 product or client address'
);

console.log('split DNS policy tests passed');
