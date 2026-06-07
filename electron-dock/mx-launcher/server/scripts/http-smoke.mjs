const cliBaseUrl = process.argv.slice(2).find((arg) => arg !== '--');
const baseUrl = (cliBaseUrl || process.env.MX_SMOKE_BASE_URL || 'http://127.0.0.1:18090').replace(/\/+$/, '');

const checks = [
  {
    name: 'healthz',
    path: '/healthz',
    assert: (body) => body && body.ok === true && body.service === 'mx-launcher-server'
  },
  {
    name: 'app-center apps',
    path: '/internal/v1/app-center/apps',
    assert: (body) => Array.isArray(body?.apps) && body.apps.some((app) => app.appId === 'h2o')
  },
  {
    name: 'sdk gateway manifest',
    path: '/internal/v1/sdk/gateway/manifest',
    assert: (body) => Array.isArray(body?.gateway?.routes)
      && body.gateway.routes.some((route) => route.routeId === 'sdk.identity.introspect')
      && body.gateway.authAuthority === 'user-center'
  },
  {
    name: 'sdk identity introspect',
    path: '/internal/v1/sdk/identity/introspect',
    method: 'POST',
    body: {
      token: 'mx-shadow-service:sdk-gateway',
      audience: 'mx-sdk',
      requestId: 'http-smoke-sdk-introspect'
    },
    assert: (body) => body?.introspection?.active === true
      && body?.introspection?.principal?.kind === 'service-account'
  },
  {
    name: 'dns policies',
    path: '/internal/v1/dns/policies',
    assert: (body) => Array.isArray(body?.policies)
      && body.policies.some((policy) => policy.policyId === 'dns_default_internal_split')
  },
  {
    name: 'sdk dns evaluate',
    path: '/internal/v1/sdk/dns/evaluate',
    method: 'POST',
    body: { domain: 'gateway.internal.mx', requestId: 'http-smoke-dns' },
    assert: (body) => body?.decision?.route === 'internal-dns'
      && body?.decision?.resolver === 'internal-coredns'
      && body?.decision?.reverseProxyRoute?.host === 'gateway.internal.mx'
  },
  {
    name: 'platform kernel smoke',
    path: '/internal/v1/platform-kernel/smoke',
    assert: (body) => body
      && body.ok === true
      && body.gate?.verdict === 'passed'
      && body.h2oUpdate?.canSkip === true
      && body.sdkIntrospection?.active === true
      && body.sdkGateway?.authAuthority === 'user-center'
      && body.dnsDecision?.route === 'internal-dns'
  }
];

for (const check of checks) {
  const url = `${baseUrl}${check.path}`;
  const response = await fetch(url, {
    method: check.method ?? 'GET',
    headers: check.body ? { 'content-type': 'application/json' } : undefined,
    body: check.body ? JSON.stringify(check.body) : undefined
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${check.name} failed: HTTP ${response.status} ${text}`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${check.name} returned non-JSON response: ${text}`);
  }
  if (!check.assert(body)) {
    throw new Error(`${check.name} returned unexpected payload: ${text}`);
  }
  console.log(`OK ${check.name}`);
}

console.log(JSON.stringify({ ok: true, baseUrl }, null, 2));
