import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rendererSource = readFileSync(
  fileURLToPath(new URL('../renderer.js', import.meta.url)),
  'utf8'
);
const htmlSource = readFileSync(
  fileURLToPath(new URL('../index.html', import.meta.url)),
  'utf8'
);

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
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

const serverInput = { value: 'https://internal.example:443' };
const opsTokenInput = { value: 'session-secret' };
const security = Function(
  'serverInput',
  'opsTokenInput',
  `
const LOCAL_SERVER_BASE_URL = 'http://127.0.0.1:18090';
${functionSource(rendererSource, 'isLocalStaticAdminBaseUrl')}
${functionSource(rendererSource, 'normalizeServerBaseValue')}
function defaultServerBaseUrl() { return LOCAL_SERVER_BASE_URL; }
let opsTokenBinding = null;
${functionSource(rendererSource, 'isOpsProtectedInternalRequest')}
${functionSource(rendererSource, 'normalizedInternalServerEndpoint')}
${functionSource(rendererSource, 'clearOpsToken')}
${functionSource(rendererSource, 'bindOpsTokenToCurrentServer')}
${functionSource(rendererSource, 'clearOpsTokenIfServerBaseChanged')}
${functionSource(rendererSource, 'opsTokenForRequest')}
return {
  bindOpsTokenToCurrentServer,
  clearOpsTokenIfServerBaseChanged,
  isOpsProtectedInternalRequest,
  opsTokenForRequest,
  binding: () => opsTokenBinding
};
`
)(serverInput, opsTokenInput);

security.bindOpsTokenToCurrentServer();
assert.deepEqual(security.binding(), {
  token: 'session-secret',
  serverBase: 'https://internal.example:443',
  origin: 'https://internal.example'
});
assert.equal(
  security.opsTokenForRequest(
    new URL('https://internal.example/internal/v1/user-center/users'),
    'GET'
  ),
  'session-secret',
  'a protected request on the bound normalized origin receives the token'
);
assert.equal(
  security.opsTokenForRequest(
    new URL('https://internal.example/internal/v1/admin/dashboard'),
    'GET'
  ),
  '',
  'an unprotected Internal request does not receive the token'
);
assert.equal(
  security.opsTokenForRequest(
    new URL('https://attacker.example/internal/v1/user-center/users'),
    'GET'
  ),
  '',
  'a protected-looking path on another origin never receives the token'
);

for (const [method, path] of [
  ['GET', '/internal/v1/user-center/roles'],
  ['GET', '/internal/v1/user-center/system-subscriptions'],
  ['POST', '/internal/v1/user-center/bootstrap'],
  ['POST', '/internal/v1/user-center/system-subscriptions/ensure'],
  ['POST', '/internal/v1/user-center/system-subscriptions/sites/mx-oversea-hk01/reveal'],
  ['GET', '/internal/v1/site-slots/mx-oversea-hk01/access-accounts'],
  ['GET', '/internal/v1/site-slots/plans/slotplan_oversea'],
  ['GET', '/internal/v1/admin/oversea'],
  ['GET', '/internal/v1/admin/site-slots/pipelines/slotplan_oversea'],
  ['POST', '/internal/v1/site-slots/plans'],
  ['POST', '/internal/v1/site-slots/mx-oversea-hk01/access-accounts'],
  ['POST', '/internal/v1/config-center/site-slot-ssh-profiles'],
  ['POST', '/internal/v1/config-center/site-slot-ssh-profiles/bootstrap'],
  ['POST', '/internal/v1/config-center/site-slot-ssh-profiles/profile_oversea/readiness-probe'],
  ['POST', '/internal/v1/admin/actions/execute'],
  ['POST', '/internal/v1/admin/oversea/mx-oversea-hk01/shadow-setup'],
  ['POST', '/internal/v1/admin/oversea/mx-oversea-hk01/ensure'],
  ['POST', '/internal/v1/admin/oversea/mx-oversea-hk01/terminal'],
  ['DELETE', '/internal/v1/user-center/users/usr_test'],
  ['GET', '/internal/v1/sdk/service-accounts'],
  ['GET', '/internal/v1/launcher-network/leases'],
  ['POST', '/internal/v1/launcher-network/products/mx-h2i'],
  ['POST', '/internal/v1/launcher-network/leases/lease_1/release']
]) {
  assert.equal(
    security.isOpsProtectedInternalRequest(`https://internal.example${path}`, method),
    true,
    `${method} ${path} must be recognized as ops protected`
  );
}
for (const [method, path] of [
  ['GET', '/internal/v1/user-center/capabilities'],
  ['POST', '/internal/v1/user-center/token/introspect'],
  ['GET', '/internal/v1/sdk/oauth/feishu/config'],
  ['GET', '/internal/v1/launcher-network/products'],
  ['POST', '/internal/v1/launcher-network/enrollments'],
  ['GET', '/internal/v1/admin/dashboard']
]) {
  assert.equal(
    security.isOpsProtectedInternalRequest(`https://internal.example${path}`, method),
    false,
    `${method} ${path} must not receive the ops token`
  );
}

serverInput.value = 'https://other-internal.example';
assert.equal(
  security.clearOpsTokenIfServerBaseChanged(),
  true,
  'changing the normalized server base clears the token immediately'
);
assert.equal(opsTokenInput.value, '');
assert.equal(security.binding(), null);

serverInput.value = 'https://internal.example';
opsTokenInput.value = 'next-secret';
security.bindOpsTokenToCurrentServer();
serverInput.value = 'https://internal.example/control-plane';
assert.equal(
  security.opsTokenForRequest(
    new URL('https://internal.example/internal/v1/user-center/users'),
    'GET'
  ),
  '',
  'a programmatic base URL change is caught before sending a request'
);
assert.equal(opsTokenInput.value, '');

const sanitizeHeaders = Function(
  `${functionSource(rendererSource, 'requestHeadersWithoutOpsToken')}; return requestHeadersWithoutOpsToken;`
)();
assert.deepEqual(
  sanitizeHeaders({
    accept: 'application/json',
    'X-MX-OPS-TOKEN': 'attacker-supplied',
    'x-mx-ops-token': 'second-value'
  }),
  { accept: 'application/json' },
  'callers cannot bypass origin binding by supplying the ops header themselves'
);

const fetchJsonSource = functionSource(rendererSource, 'fetchJson');
assert.match(fetchJsonSource, /new URL\(String\(path \|\| ''\), `\$\{normalizedServerBase\(\)\}\/`\)/);
assert.match(fetchJsonSource, /requestHeadersWithoutOpsToken\(options\.headers\)/);
assert.match(fetchJsonSource, /opsTokenForRequest\(requestUrl, method\)/);
assert.match(
  fetchJsonSource,
  /redirect: opsToken \? 'error' : 'follow'/,
  'a token-bearing request must not follow a redirect to another origin'
);
assert.match(
  rendererSource,
  /serverInput\.addEventListener\('input', \(\) => \{\s*clearOpsTokenIfServerBaseChanged\(\);/,
  'base URL edits must clear a stale binding on input, not only on blur'
);
assert.match(
  rendererSource,
  /opsTokenInput\.addEventListener\('input', \(\) => \{\s*bindOpsTokenToCurrentServer\(\);/,
  'token entry must bind to the current normalized Internal origin'
);
assert.match(htmlSource, /id="ops-token-input"[^>]*type="password"[^>]*autocomplete="off"/);
assert.match(htmlSource, /Bound to the current MX Server origin; changing MX Server clears it\./);

console.log('OK Internal ops token stays bound to one protected Internal origin');
