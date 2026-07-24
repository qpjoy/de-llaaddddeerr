#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
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

console.log('split DNS policy tests passed');
