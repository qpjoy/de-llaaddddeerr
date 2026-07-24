const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
  buildWireGuardTunnelCommand,
  parseDarwinDefaultRoutes,
  renderDarwinEndpointBypassRouteStateFunctionLines,
  renderWireGuardInterface,
  selectDarwinWireGuardRouteProbeTarget,
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
assert.deepEqual(selectDarwinPhysicalDefaultRoute(ethernetDefault), {
  gateway: '10.20.30.1',
  flags: 'UGScIg',
  interfaceName: 'en3',
  raw: 'default            10.20.30.1         UGScIg                en3'
}, 'Without a third-party tunnel, endpoint bypass must use the physical default');

const externalWireGuardDefault = `
Destination        Gateway            Flags               Netif Expire
default            10.200.0.1         UGScg               utun7
default            192.168.50.1       UGScIg                en0
`;
assert.deepEqual(selectDarwinPhysicalDefaultRoute(externalWireGuardDefault), {
  gateway: '192.168.50.1',
  flags: 'UGScIg',
  interfaceName: 'en0',
  raw: 'default            192.168.50.1       UGScIg                en0'
}, 'An external WireGuard global default must not capture the relay endpoint bypass');

const tunnelOnly = `
Destination        Gateway            Flags               Netif Expire
default            198.18.0.1         UGScg               utun5
`;
assert.equal(selectDarwinPhysicalDefaultRoute(tunnelOnly), null);

assert.equal(
  selectDarwinWireGuardRouteProbeTarget('10.89.0.0/20', ['10.89.0.1/32']),
  '10.89.0.2',
  'Darwin route readiness must not probe the local WireGuard address, which correctly routes through lo0'
);
assert.equal(
  selectDarwinWireGuardRouteProbeTarget('10.89.0.0/20', ['10.89.0.2/32', '10.89.0.1/32']),
  '10.89.0.3',
  'Darwin route readiness must skip every configured interface address'
);
assert.equal(
  selectDarwinWireGuardRouteProbeTarget('10.89.0.0/31', ['10.89.0.0/32']),
  '10.89.0.1',
  'Darwin /31 route readiness must use the other address when one endpoint is local'
);
assert.equal(
  selectDarwinWireGuardRouteProbeTarget('10.89.0.1/32', ['10.89.0.1/32']),
  '10.89.0.1',
  'A /32 has no alternate probe target and must remain deterministic'
);

const endpointBypassRouteStateFunction =
  renderDarwinEndpointBypassRouteStateFunctionLines().join('\n');
assert.doesNotMatch(
  endpointBypassRouteStateFunction,
  /\?\s*[^,\n]+\s*:/,
  'The generated endpoint-bypass watcher must not use BSD awk-incompatible ternary printf arguments'
);
const endpointBypassAwkMatch = endpointBypassRouteStateFunction.match(
  /route -vn get "\$1" 2>\/dev\/null \| awk '\n([\s\S]+)\n  '\n}/
);
assert.ok(endpointBypassAwkMatch, 'The generated endpoint-bypass watcher must contain an awk program');
if (process.platform === 'darwin') {
  const parsed = spawnSync('/usr/bin/awk', [endpointBypassAwkMatch[1]], {
    input: [
      '   destination: 116.62.51.154',
      '       gateway: 192.168.50.1',
      '     interface: en0',
      '      sockaddrs: <DST,GATEWAY,IFP,IFA>',
      ' 116.62.51.154 192.168.50.1 en0 192.168.50.23',
      ''
    ].join('\n'),
    encoding: 'utf8'
  });
  assert.equal(
    parsed.status,
    0,
    `The generated endpoint-bypass watcher awk must parse with macOS /usr/bin/awk: ${parsed.stderr}`
  );
  assert.equal(
    parsed.stdout,
    '116.62.51.154 192.168.50.1 en0 192.168.50.23',
    'The generated endpoint-bypass watcher must preserve its route-state output contract'
  );
}

const generatedRoot = mkdtempSync(join(tmpdir(), 'mx-h2i-darwin-route-'));
try {
  const configPath = join(generatedRoot, 'mx-h2i.conf');
  writeFileSync(configPath, renderWireGuardInterface({
    privateKey: 'private-key',
    addresses: ['10.89.0.1/32'],
    hdoRoutePriorityCidrs: ['10.88.88.88/32'],
    peers: [{
      publicKey: 'public-key',
      allowedIps: ['10.89.0.0/16', '10.88.88.88/32'],
      endpoint: '116.62.51.154:51820'
    }]
  }));
  buildWireGuardTunnelCommand({
    runtime: {
      target: 'darwin-arm64',
      platform: 'darwin',
      available: true,
      method: 'darwin-userspace',
      wg: {
        target: 'darwin-arm64',
        available: true,
        source: 'bundled',
        command: '/opt/mx-h2i/wg',
        bundledPath: '/opt/mx-h2i/wg',
        installedPath: null,
        systemPath: null,
        error: null
      },
      wgQuick: null,
      wireGuardGo: {
        target: 'darwin-arm64',
        name: 'wireguard-go',
        available: true,
        source: 'bundled',
        command: '/opt/mx-h2i/wireguard-go',
        bundledPath: '/opt/mx-h2i/wireguard-go',
        installedPath: null,
        systemPath: null,
        error: null
      },
      bash: null,
      windowsWireGuard: null,
      warnings: [],
      error: null
    },
    configPath,
    action: 'restart'
  });
  const generated = readFileSync(join(generatedRoot, 'mx-h2i.restart.sh'), 'utf8');
  assert.match(
    generated,
    /route -q -n add -net '10\.89\.0\.0\/20' -interface "\$REAL_INTERFACE"/,
    'The first longest-prefix /20 overlay route must remain in the Darwin plan'
  );
  assert.match(
    generated,
    /route -q -n add -net '10\.89\.240\.0\/20' -interface "\$REAL_INTERFACE"/,
    'The last longest-prefix /20 overlay route must remain in the Darwin plan'
  );
  assert.match(
    generated,
    /route -q -n add -net '10\.88\.88\.88\/32' -interface "\$REAL_INTERFACE"/,
    'The explicit control-plane /32 route must remain in the Darwin plan'
  );
  assert.ok(
    generated.includes('$2 !~ /^198\\.(18|19)\\./ && $4 !~ /^(utun|lo)[0-9]*$/'),
    'Generated endpoint bypass must still reject Clash fake-IP and all utun defaults'
  );
} finally {
  rmSync(generatedRoot, { recursive: true, force: true });
}

console.log('darwin physical default route smoke: ok');
