#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const mainSource = readFileSync(
  fileURLToPath(new URL('../src/main.cjs', import.meta.url)),
  'utf8'
);

function functionSource(source, name) {
  const candidates = [`async function ${name}(`, `function ${name}(`];
  const start = candidates
    .map((prefix) => source.indexOf(prefix))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  assert.ok(Number.isInteger(start), `${name} must exist`);
  const parametersStart = source.indexOf('(', start);
  let parametersDepth = 0;
  let parametersEnd = -1;
  for (let index = parametersStart; index < source.length; index += 1) {
    if (source[index] === '(') parametersDepth += 1;
    if (source[index] === ')') parametersDepth -= 1;
    if (parametersDepth === 0) {
      parametersEnd = index;
      break;
    }
  }
  const bodyStart = source.indexOf('{', parametersEnd);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} is not balanced`);
}

assert.match(mainSource, /const DEFAULT_BOOTSTRAP_HOST = 'h2i\.minsight-ai\.com';/);
assert.match(mainSource, /const LEGACY_DEFAULT_BOOTSTRAP_HOST = 'h2i\.mxinfo-inc\.cn';/);
assert.match(mainSource, /const DEFAULT_DOMESTIC_RELAY_HOST = '116\.62\.51\.154';/);

const splitDnsDomains = mainSource.match(
  /const DEFAULT_SPLIT_DNS_DOMAINS = '([^']+)';/
)?.[1]?.split(/\s+/);
assert.ok(splitDnsDomains?.includes('mxinfo-inc.cn'), 'the Internal split-DNS suffix must retain mxinfo-inc.cn');
assert.ok(!splitDnsDomains?.includes('minsight-ai.com'), 'the public bootstrap suffix must not enter Internal split DNS');

const normalizeBaseUrl = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().replace(/\/+$/, '');
};
const isLegacyDefaultBootstrapApiBaseUrl = Function(
  'normalizeBaseUrl',
  'LEGACY_DEFAULT_BOOTSTRAP_HOST',
  `${functionSource(mainSource, 'isLegacyDefaultBootstrapApiBaseUrl')}; return isLegacyDefaultBootstrapApiBaseUrl;`
)(normalizeBaseUrl, 'h2i.mxinfo-inc.cn');

for (const legacyDefault of [
  'https://h2i.mxinfo-inc.cn',
  'https://h2i.mxinfo-inc.cn/',
  'https://h2i.mxinfo-inc.cn:443',
  'http://h2i.mxinfo-inc.cn:18090',
  'http://api.mxinfo-inc.cn:18090'
]) {
  assert.equal(isLegacyDefaultBootstrapApiBaseUrl(legacyDefault), true, legacyDefault);
}
for (const customBootstrap of [
  'https://h2i.mxinfo-inc.cn:8443',
  'https://h2i.mxinfo-inc.cn/custom',
  'https://h2i.mxinfo-inc.cn?tenant=custom',
  'https://custom.example',
  'http://h2i.mxinfo-inc.cn:18091'
]) {
  assert.equal(isLegacyDefaultBootstrapApiBaseUrl(customBootstrap), false, customBootstrap);
}

function evaluateDefaultBootstrapApiBaseUrl(env, production = false) {
  const defaultBootstrapApiBaseUrl = Function(
    'process',
    'normalizeBaseUrl',
    'nullableString',
    'stringValue',
    'isLegacyDefaultBootstrapApiBaseUrl',
    'productionBootstrapCanonicalRequired',
    'isBarePublicIpBootstrapBaseUrl',
    'DEFAULT_BOOTSTRAP_HOST',
    `${functionSource(mainSource, 'defaultBootstrapApiBaseUrl')}; return defaultBootstrapApiBaseUrl;`
  )(
    { env },
    normalizeBaseUrl,
    (value) => typeof value === 'string' && value.trim() ? value.trim() : null,
    (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
    isLegacyDefaultBootstrapApiBaseUrl,
    () => production,
    (value) => new URL(value).hostname === '116.62.51.154',
    'h2i.minsight-ai.com'
  );
  return defaultBootstrapApiBaseUrl();
}

assert.equal(evaluateDefaultBootstrapApiBaseUrl({}), 'https://h2i.minsight-ai.com');
assert.equal(
  evaluateDefaultBootstrapApiBaseUrl({ MX_H2I_BOOTSTRAP_BASE_URL: 'https://h2i.mxinfo-inc.cn' }),
  'https://h2i.minsight-ai.com'
);
assert.equal(
  evaluateDefaultBootstrapApiBaseUrl({ MX_H2I_BOOTSTRAP_BASE_URL: 'https://h2i.mxinfo-inc.cn/custom' }),
  'https://h2i.mxinfo-inc.cn/custom',
  'a custom URL on the former hostname must remain untouched'
);
assert.equal(
  evaluateDefaultBootstrapApiBaseUrl({ MX_H2I_BOOTSTRAP_BASE_URL: 'https://116.62.51.154' }, true),
  'https://h2i.minsight-ai.com',
  'production must keep a named canonical HTTPS origin'
);
assert.equal(
  evaluateDefaultBootstrapApiBaseUrl({ MX_H2I_BOOTSTRAP_BASE_URL: 'https://116.62.51.154' }, false),
  'https://116.62.51.154',
  'development diagnostics may still exercise an explicit IP transport'
);

const isLegacyDefaultSdkGatewayBaseUrl = Function(
  'normalizeBaseUrl',
  'LEGACY_DEFAULT_BOOTSTRAP_HOST',
  `${functionSource(mainSource, 'isLegacyDefaultSdkGatewayBaseUrl')}; return isLegacyDefaultSdkGatewayBaseUrl;`
)(normalizeBaseUrl, 'h2i.mxinfo-inc.cn');
for (const legacyDefault of [
  'https://h2i.mxinfo-inc.cn/internal/v1/sdk',
  'https://h2i.mxinfo-inc.cn:443/internal/v1/sdk/',
  'http://h2i.mxinfo-inc.cn:18090/internal/v1/sdk',
  'http://api.mxinfo-inc.cn:18090/internal/v1/sdk'
]) {
  assert.equal(isLegacyDefaultSdkGatewayBaseUrl(legacyDefault), true, legacyDefault);
}
for (const customGateway of [
  'https://h2i.mxinfo-inc.cn:8443/internal/v1/sdk',
  'https://h2i.mxinfo-inc.cn/internal/v1/sdk/custom',
  'https://h2i.mxinfo-inc.cn/internal/v1/sdk?tenant=custom'
]) {
  assert.equal(isLegacyDefaultSdkGatewayBaseUrl(customGateway), false, customGateway);
}

const productionDefaultConfig = {
  bootstrapApiBaseUrl: 'https://h2i.minsight-ai.com',
  internalApiBaseUrl: 'http://10.88.88.88:18090',
  sdkGatewayBaseUrl: ''
};
const normalizeBootstrapApiBaseUrlConfig = Function(
  'normalizeBaseUrl',
  'DEFAULT_CONFIG',
  'isLegacyDefaultBootstrapApiBaseUrl',
  'productionBootstrapCanonicalRequired',
  'isBarePublicIpBootstrapBaseUrl',
  `${functionSource(mainSource, 'normalizeBootstrapApiBaseUrlConfig')}; return normalizeBootstrapApiBaseUrlConfig;`
)(
  normalizeBaseUrl,
  productionDefaultConfig,
  isLegacyDefaultBootstrapApiBaseUrl,
  () => true,
  () => false
);
assert.equal(
  normalizeBootstrapApiBaseUrlConfig(
    'http://10.88.88.88:18090',
    'http://10.88.88.88:18090'
  ),
  'https://h2i.minsight-ai.com',
  'the known persisted Internal fallback must migrate to public HTTPS'
);
assert.equal(
  normalizeBootstrapApiBaseUrlConfig(
    'http://10.77.0.1:19090',
    'http://10.77.0.1:19090'
  ),
  'http://10.77.0.1:19090',
  'a custom Internal-only deployment must not be rewritten'
);

const sdkGatewayBaseUrl = (baseUrl) => `${normalizeBaseUrl(baseUrl)}/internal/v1/sdk`;
const normalizeSdkGatewayBaseUrlConfig = Function(
  'normalizeBaseUrl',
  'DEFAULT_CONFIG',
  'sdkGatewayBaseUrl',
  'isLegacyDefaultSdkGatewayBaseUrl',
  'productionBootstrapCanonicalRequired',
  `${functionSource(mainSource, 'normalizeSdkGatewayBaseUrlConfig')}; return normalizeSdkGatewayBaseUrlConfig;`
)(
  normalizeBaseUrl,
  productionDefaultConfig,
  sdkGatewayBaseUrl,
  isLegacyDefaultSdkGatewayBaseUrl,
  () => true
);
assert.equal(
  normalizeSdkGatewayBaseUrlConfig(
    'http://10.88.88.88:18090/internal/v1/sdk',
    'https://h2i.minsight-ai.com',
    'http://10.88.88.88:18090'
  ),
  'https://h2i.minsight-ai.com/internal/v1/sdk',
  'the SDK gateway must follow the migrated canonical bootstrap'
);

const parseHostResolveTarget = (value) => {
  const text = String(value || '').trim();
  const bracketed = text.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) return { host: bracketed[1], port: bracketed[2] || null };
  const hostAndPort = text.match(/^([^:]+):(\d+)$/);
  if (hostAndPort) return { host: hostAndPort[1], port: hostAndPort[2] };
  return text ? { host: text, port: null } : null;
};
const migrateKnownLegacyDefaultHostResolve = Function(
  'nullableString',
  'parseHostResolveTarget',
  'uniqueValues',
  'LEGACY_DEFAULT_BOOTSTRAP_HOST',
  'DEFAULT_DOMESTIC_RELAY_HOST',
  'DEFAULT_BOOTSTRAP_HOST',
  `${functionSource(mainSource, 'migrateKnownLegacyDefaultHostResolve')}; return migrateKnownLegacyDefaultHostResolve;`
)(
  (value) => typeof value === 'string' && value.trim() ? value.trim() : null,
  parseHostResolveTarget,
  (values) => [...new Set(values.filter(Boolean))],
  'h2i.mxinfo-inc.cn',
  '116.62.51.154',
  'h2i.minsight-ai.com'
);
assert.equal(
  migrateKnownLegacyDefaultHostResolve('h2i.mxinfo-inc.cn=116.62.51.154'),
  'h2i.minsight-ai.com=116.62.51.154'
);
assert.equal(
  migrateKnownLegacyDefaultHostResolve('h2i.mxinfo-inc.cn=203.0.113.10'),
  'h2i.mxinfo-inc.cn=203.0.113.10',
  'a custom legacy-host target must remain untouched'
);
assert.equal(
  migrateKnownLegacyDefaultHostResolve('h2i.mxinfo-inc.cn=116.62.51.154:8443'),
  'h2i.mxinfo-inc.cn=116.62.51.154:8443',
  'a custom legacy-host port must remain untouched'
);
assert.equal(
  migrateKnownLegacyDefaultHostResolve(
    'internal.mx=10.88.88.88,h2i.mxinfo-inc.cn=116.62.51.154,h2i.minsight-ai.com=116.62.51.154'
  ),
  'internal.mx=10.88.88.88,h2i.minsight-ai.com=116.62.51.154',
  'migration must preserve unrelated mappings and deduplicate the new default'
);

function evaluateDefaultHostResolve(env) {
  const defaultHostResolve = Function(
    'process',
    'explicitDefaultHostResolve',
    'hostnameFromUrl',
    'defaultBootstrapApiBaseUrl',
    'DEFAULT_BOOTSTRAP_HOST',
    'shouldAutoBootstrapHostResolve',
    'migrateKnownLegacyDefaultHostResolve',
    'nullableString',
    'defaultDomesticRelayHost',
    `${functionSource(mainSource, 'defaultHostResolve')}; return defaultHostResolve;`
  )(
    { env },
    () => env.MX_H2I_HOST_RESOLVE || env.MX_H2I_BOOTSTRAP_HOST_RESOLVE || null,
    (value) => new URL(value).hostname,
    () => 'https://h2i.minsight-ai.com',
    'h2i.minsight-ai.com',
    (host) => host === 'h2i.minsight-ai.com',
    migrateKnownLegacyDefaultHostResolve,
    (value) => typeof value === 'string' && value.trim() ? value.trim() : null,
    () => '116.62.51.154'
  );
  return defaultHostResolve();
}
assert.equal(evaluateDefaultHostResolve({}), 'h2i.minsight-ai.com=116.62.51.154');
assert.equal(
  evaluateDefaultHostResolve({ MX_H2I_HOST_RESOLVE: 'h2i.mxinfo-inc.cn=116.62.51.154' }),
  'h2i.minsight-ai.com=116.62.51.154'
);
assert.equal(
  evaluateDefaultHostResolve({ MX_H2I_HOST_RESOLVE: 'h2i.mxinfo-inc.cn=203.0.113.10' }),
  'h2i.mxinfo-inc.cn=203.0.113.10',
  'a custom Host Resolve target must not be rewritten'
);

assert.match(
  functionSource(mainSource, 'defaultBootstrapApiBaseUrl'),
  /isLegacyDefaultBootstrapApiBaseUrl\(candidate\)[\s\S]*https:\/\/\$\{DEFAULT_BOOTSTRAP_HOST\}/,
  'fresh and environment-provided known defaults must converge on the new canonical hostname'
);
assert.match(
  functionSource(mainSource, 'normalizeBootstrapApiBaseUrlConfig'),
  /productionBootstrapCanonicalRequired\(\)[\s\S]*isBarePublicIpBootstrapBaseUrl\(normalized\)[\s\S]*DEFAULT_CONFIG\.bootstrapApiBaseUrl/,
  'a packaged or production runtime must not persist a bare public IP as its canonical bootstrap URL'
);
assert.match(
  functionSource(mainSource, 'normalizeBootstrapApiBaseUrlConfig'),
  /normalized === normalizeBaseUrl\(DEFAULT_CONFIG\.internalApiBaseUrl\)[\s\S]*normalized === normalizeBaseUrl\(internalApiBaseUrl\)[\s\S]*DEFAULT_CONFIG\.bootstrapApiBaseUrl/,
  'a packaged runtime must migrate the known Internal HTTP fallback back to the public HTTPS bootstrap'
);
assert.match(
  functionSource(mainSource, 'normalizeSdkGatewayBaseUrlConfig'),
  /normalized === sdkGatewayBaseUrl\(DEFAULT_CONFIG\.internalApiBaseUrl\)[\s\S]*return fallback/,
  'the SDK gateway must migrate with the known stale Internal bootstrap'
);
assert.match(
  functionSource(mainSource, 'shouldPreserveConfiguredBootstrapBaseUrl'),
  /retainedOverlayBaseUrl[\s\S]*normalizeBaseUrl\(candidate\) === normalizeBaseUrl\(retainedOverlayBaseUrl\)[\s\S]*return true/,
  'a temporary retained-overlay endpoint must not replace the canonical bootstrap URL'
);
assert.match(
  functionSource(mainSource, 'defaultHostResolve'),
  /hostnameFromUrl\(defaultBootstrapApiBaseUrl\(\)\)[\s\S]*migrateKnownLegacyDefaultHostResolve\(explicit\)[\s\S]*\$\{host\}=\$\{defaultDomesticRelayHost\(\)\}/,
  'the default Host Resolve mapping must follow the normalized canonical hostname'
);
assert.match(
  functionSource(mainSource, 'directPublicBootstrapOverride'),
  /useTlsIdentity[\s\S]*hostHeader: useTlsIdentity \? original\.host : parsed\.host[\s\S]*servername: useTlsIdentity \? original\.hostname : undefined/,
  'direct-IP HTTPS transport must retain the canonical Host and TLS SNI'
);
assert.match(
  functionSource(mainSource, 'bootstrapResolveAttempts'),
  /hasHostOverride \? \['env-only'\][\s\S]*'system-only'[\s\S]*'dns-only'/,
  'env-first mode must try the pinned endpoint before the Clash-compatible system path and DNS fallback'
);
assert.match(
  functionSource(mainSource, 'networkDiagnosticHost'),
  /connectedInternalFallback[\s\S]*LEGACY_DEFAULT_BOOTSTRAP_HOST[\s\S]*routeHost,[\s\S]*connectedInternalFallback,[\s\S]*runtime\?\.config\?\.bootstrapApiBaseUrl/,
  'connected diagnostics must test an Internal split-DNS name instead of requiring the public bootstrap name to resolve into the overlay'
);

console.log('bootstrap domain safety tests passed');
