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
    name: 'platform kernel smoke',
    path: '/internal/v1/platform-kernel/smoke',
    assert: (body) => body && body.ok === true && body.gate?.verdict === 'passed' && body.h2oUpdate?.canSkip === true
  }
];

for (const check of checks) {
  const url = `${baseUrl}${check.path}`;
  const response = await fetch(url);
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
