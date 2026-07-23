import assert from 'node:assert/strict';
import { diagnoseLauncherHostResolution } from '../dist/network-diagnostics.js';

const base = {
  host: 'h2i.mxinfo-inc.cn',
  phase: 'connected',
  expectedInternalTargets: ['10.88.88.88'],
  internalCidrs: ['10.88.0.0/16']
};

const internal = await diagnoseLauncherHostResolution({
  ...base,
  lookup: async () => [{ address: '10.88.88.88', family: 4 }]
});
assert.equal(internal.ok, true);
assert.equal(internal.state, 'expected-internal');

const publicDns = await diagnoseLauncherHostResolution({
  ...base,
  lookup: async () => [{ address: '116.62.51.154', family: 4 }]
});
assert.equal(publicDns.ok, false);
assert.equal(publicDns.severity, 'error');
assert.equal(publicDns.state, 'public');

const fakeIp = await diagnoseLauncherHostResolution({
  ...base,
  lookup: async () => [{ address: '198.18.0.8', family: 4 }]
});
assert.equal(fakeIp.ok, false);
assert.equal(fakeIp.state, 'proxy-fake-ip');

console.log('launcher connected host-resolution smoke passed');
