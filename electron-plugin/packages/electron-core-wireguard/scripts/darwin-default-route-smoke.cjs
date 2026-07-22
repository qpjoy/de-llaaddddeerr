const assert = require('node:assert/strict');
const {
  parseDarwinDefaultRoutes,
  selectDarwinPhysicalDefaultRoute
} = require('../dist/index.js');

const clashFakeGateway = `
Destination        Gateway            Flags               Netif Expire
default            198.18.0.1         UGScg               utun5
default            192.168.0.1        UGScIg                en0
`;
assert.equal(parseDarwinDefaultRoutes(clashFakeGateway).length, 2);
assert.deepEqual(selectDarwinPhysicalDefaultRoute(clashFakeGateway), {
  gateway: '192.168.0.1',
  flags: 'UGScIg',
  interfaceName: 'en0',
  raw: 'default            192.168.0.1        UGScIg                en0'
});

const clashLinkDefault = `
Destination        Gateway            Flags               Netif Expire
default            link#32            UCSg                utun6
default            192.168.1.1        UGScIg                en0
`;
assert.equal(selectDarwinPhysicalDefaultRoute(clashLinkDefault)?.gateway, '192.168.1.1');
assert.equal(selectDarwinPhysicalDefaultRoute(clashLinkDefault)?.interfaceName, 'en0');

const ethernetDefault = `
Destination        Gateway            Flags               Netif Expire
default            10.20.30.1         UGScIg                en3
`;
assert.equal(selectDarwinPhysicalDefaultRoute(ethernetDefault)?.interfaceName, 'en3');

const tunnelOnly = `
Destination        Gateway            Flags               Netif Expire
default            198.18.0.1         UGScg               utun5
`;
assert.equal(selectDarwinPhysicalDefaultRoute(tunnelOnly), null);

console.log('darwin physical default route smoke: ok');
