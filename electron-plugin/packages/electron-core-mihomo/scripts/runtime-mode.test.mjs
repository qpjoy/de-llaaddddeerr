import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  renderRuntimeConfig,
  isTunRuntimeMode,
  isGlobalRuntimeMode,
  normalizeRuntimeMode,
  normalizeDnsMode,
  normalizeTunStack,
  proxyNodes,
  proxyPolicyGroupName
} = require('../dist/index.js');
const { parse } = require('yaml');

const BASE_YAML = `
proxies:
  - name: oversea-1
    type: hysteria2
    server: 203.0.113.10
    port: 443
    password: secret
`;

function render(mode, overrides = {}) {
  const { settings: settingsOverride, ...rest } = overrides;
  const rendered = renderRuntimeConfig({
    baseYaml: BASE_YAML,
    settings: {
      mode,
      ports: { admin: 23456, controller: 23457, mixed: 23458, dns: 1053 },
      controllerSecret: 'secret',
      tunInstalled: true,
      ...settingsOverride
    },
    rules: [
      { kind: 'allow', domain: 'google.com', enabled: true },
      { kind: 'block', domain: 'blocked.example', enabled: true }
    ],
    useGeoRules: false,
    ...rest
  });
  return parse(rendered.yaml);
}

test('mode predicates classify the three H2O modes', () => {
  assert.deepEqual(
    ['app-rule', 'app-global', 'system-tun'].map(isTunRuntimeMode),
    [false, false, true]
  );
  assert.deepEqual(
    ['app-rule', 'app-global', 'system-tun'].map(isGlobalRuntimeMode),
    [false, true, true]
  );
});

test('the retired system-fakeip mode folds into system-tun', () => {
  // It briefly shipped as a fourth mode; stored runtime state must still load.
  assert.equal(normalizeRuntimeMode('system-fakeip'), 'system-tun');
  assert.equal(normalizeRuntimeMode('tun'), 'system-tun');
  assert.equal(normalizeRuntimeMode('global'), 'app-global');
  assert.equal(normalizeRuntimeMode('nonsense'), 'app-global', 'unknown input falls back to the default mode');
});

test('dns mode is independent of proxy mode', () => {
  assert.equal(normalizeDnsMode('redir-host'), 'redir-host');
  assert.equal(normalizeDnsMode(undefined), 'fake-ip', 'fake-ip is the default, like Clash');
  for (const mode of ['app-rule', 'app-global', 'system-tun']) {
    assert.equal(render(mode, { settings: { dnsMode: 'redir-host' } }).dns['enhanced-mode'], 'redir-host');
    assert.equal(render(mode, { settings: { dnsMode: 'fake-ip' } }).dns['enhanced-mode'], 'fake-ip');
  }
});

test('cn-direct off sends domestic traffic through the proxy but keeps guards direct', () => {
  const on = render('app-global', { settings: { cnDirect: true } });
  const off = render('app-global', {
    settings: { cnDirect: false },
    directDomains: ['h2i.minsight-ai.com'],
    directIps: ['116.62.51.154']
  });
  assert.ok(on.rules.includes('DOMAIN-SUFFIX,cn,DIRECT'), 'cn-direct on keeps the CN bootstrap rules');
  assert.ok(!off.rules.includes('DOMAIN-SUFFIX,cn,DIRECT'), 'cn-direct off drops them');
  assert.ok(
    off.rules.includes('IP-CIDR,116.62.51.154/32,DIRECT,no-resolve'),
    'the control plane stays direct even with cn-direct off, or the client cannot reach Domestic'
  );
  assert.equal(off.rules.at(-1), 'MATCH,PROXY');
});

test('app-rule only proxies the allowlist and rejects everything else', () => {
  const config = render('app-rule');
  assert.equal(config.tun.enable, false);
  assert.ok(config.rules.includes('DOMAIN-SUFFIX,google.com,PROXY'));
  assert.equal(config.rules.at(-1), 'MATCH,REJECT');
});

test('app-global proxies everything outside the blocklist without a virtual NIC', () => {
  const config = render('app-global');
  assert.equal(config.tun.enable, false);
  assert.ok(config.rules.includes('DOMAIN-SUFFIX,blocked.example,REJECT'));
  assert.equal(config.rules.at(-1), 'MATCH,PROXY');
});

test('system-tun defaults to the system stack with fake-ip DNS hijack', () => {
  const config = render('system-tun', { platform: 'darwin' });
  assert.equal(config.tun.enable, true);
  assert.equal(config.tun.stack, 'system');
  assert.deepEqual(config.tun['dns-hijack'], ['any:53', 'tcp://any:53']);
  assert.equal(config.dns['enhanced-mode'], 'fake-ip');
  assert.equal(config.dns['fake-ip-range'], '198.18.0.1/16');
  assert.equal(config.dns.listen, '0.0.0.0:1053');
  assert.ok(config.dns['fake-ip-filter'].includes('*.local'));
});

test('the tun stack escalates system -> mixed -> gvisor', () => {
  assert.equal(normalizeTunStack(undefined), 'system', 'system is the baseline default');
  assert.equal(normalizeTunStack('mixed'), 'mixed');
  assert.equal(normalizeTunStack('gvisor'), 'gvisor');
  assert.equal(normalizeTunStack('nonsense'), 'system');
  for (const stack of ['system', 'mixed', 'gvisor']) {
    assert.equal(render('system-tun', { settings: { tunStack: stack } }).tun.stack, stack);
  }
});

test('strict-route is independent of the stack and off by default', () => {
  // Coupling them was wrong: strict-route is a leak guard every stack supports,
  // and leaving it on is what fights other VPNs for the routing table.
  for (const stack of ['system', 'mixed', 'gvisor']) {
    assert.equal(render('system-tun', { settings: { tunStack: stack } }).tun['strict-route'], false);
    assert.equal(
      render('system-tun', { settings: { tunStack: stack, strictRoute: true } }).tun['strict-route'],
      true
    );
  }
});

test('auto-redirect follows the platform, not the stack', () => {
  // mihomo only implements auto-redirect on Linux (nftables/iptables).
  for (const stack of ['system', 'mixed', 'gvisor']) {
    assert.equal(render('system-tun', { settings: { tunStack: stack }, platform: 'linux' }).tun['auto-redirect'], true);
    assert.equal(render('system-tun', { settings: { tunStack: stack }, platform: 'darwin' }).tun['auto-redirect'], false);
    assert.equal(render('system-tun', { settings: { tunStack: stack }, platform: 'win32' }).tun['auto-redirect'], false);
  }
});

test('redir-host drops the fake-ip pool entirely', () => {
  const config = render('system-tun', { settings: { dnsMode: 'redir-host' } });
  assert.equal(config.dns['enhanced-mode'], 'redir-host');
  assert.equal(config.dns['fake-ip-range'], undefined);
  assert.equal(config.dns['fake-ip-filter'], undefined);
});

test('control-plane guards stay DIRECT ahead of block, allow and MATCH rules', () => {
  for (const mode of ['app-rule', 'app-global', 'system-tun']) {
    const config = render(mode, {
      directDomains: ['h2i.minsight-ai.com'],
      directIps: ['116.62.51.154', '10.88.88.88']
    });
    const guardIndex = config.rules.indexOf('DOMAIN-SUFFIX,h2i.minsight-ai.com,DIRECT');
    const blockIndex = config.rules.indexOf('DOMAIN-SUFFIX,blocked.example,REJECT');
    assert.ok(guardIndex >= 0, `${mode} keeps the guard domain direct`);
    assert.ok(config.rules.includes('IP-CIDR,116.62.51.154/32,DIRECT,no-resolve'), `${mode} keeps the relay IP direct`);
    assert.ok(guardIndex < blockIndex, `${mode} evaluates the guard before user rules`);
    assert.ok(
      guardIndex < config.rules.length - 1,
      `${mode} evaluates the guard before MATCH`
    );
  }
});

test('guarded domains are excluded from fake-ip and resolved by plain DNS', () => {
  const config = render('system-tun', {
    directDomains: ['h2i.minsight-ai.com'],
    directIps: ['116.62.51.154']
  });
  assert.ok(config.dns['fake-ip-filter'].includes('h2i.minsight-ai.com'));
  // Resolving the bootstrap host over DoH would need the tunnel that is not up yet.
  assert.deepEqual(
    config.dns['nameserver-policy']['+.h2i.minsight-ai.com'],
    ['223.5.5.5', '119.29.29.29', '1.1.1.1']
  );
});

test('rules target a select group so switching nodes never rewrites a rule', () => {
  const multiNode = `
proxies:
  - {name: hk, type: hysteria2, server: 1.1.1.1, port: 443, password: x}
  - {name: sg, type: hysteria2, server: 2.2.2.2, port: 443, password: x}
`;
  const build = (selectedNode) => parse(renderRuntimeConfig({
    baseYaml: multiNode,
    settings: {
      mode: 'app-global',
      ports: { admin: 23456, controller: 23457, mixed: 23458, dns: 1053 },
      controllerSecret: 'secret',
      tunInstalled: false
    },
    rules: [],
    useGeoRules: false,
    selectedNode
  }).yaml);

  const first = build(null);
  assert.deepEqual(first['proxy-groups'][0], { name: 'PROXY', type: 'select', proxies: ['hk', 'sg'] });
  assert.equal(first.rules.at(-1), 'MATCH,PROXY');

  // mihomo's `select` falls back to the first member, so ordering persists the choice.
  const second = build('sg');
  assert.deepEqual(second['proxy-groups'][0].proxies, ['sg', 'hk']);
  assert.deepEqual(second.rules, first.rules, 'switching a node leaves every rule untouched');

  assert.deepEqual(
    build('not-a-node')['proxy-groups'][0].proxies,
    ['hk', 'sg'],
    'a node that is not in the subscription is ignored rather than emptying the group'
  );
});

test('a subscription that ships its own proxy-groups keeps them', () => {
  const withGroups = `
proxies:
  - {name: hk, type: hysteria2, server: 1.1.1.1, port: 443, password: x}
proxy-groups:
  - {name: "选择节点", type: select, proxies: [hk, DIRECT]}
`;
  const config = parse(renderRuntimeConfig({
    baseYaml: withGroups,
    settings: {
      mode: 'app-global',
      ports: { admin: 23456, controller: 23457, mixed: 23458, dns: 1053 },
      controllerSecret: 'secret',
      tunInstalled: false
    },
    rules: [],
    useGeoRules: false
  }).yaml);
  assert.equal(config['proxy-groups'].length, 1, 'no synthetic PROXY group is added');
  assert.equal(config.rules.at(-1), 'MATCH,选择节点');
});

test('proxyNodes lists nodes only, never policy groups', () => {
  const yaml = `
proxies:
  - {name: hk, type: hysteria2, server: 1.1.1.1, port: 443, password: x}
proxy-groups:
  - {name: "选择节点", type: select, proxies: [hk]}
`;
  assert.deepEqual(
    proxyNodes(yaml),
    [{ name: 'hk', type: 'hysteria2', server: '1.1.1.1', port: 443 }]
  );
  assert.equal(proxyPolicyGroupName(yaml), '选择节点');
  assert.deepEqual(proxyNodes('rules: []'), [], 'a subscription with no proxies lists nothing');
});
