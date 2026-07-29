import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rendererSource = readFileSync(
  fileURLToPath(new URL('../renderer.js', import.meta.url)),
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

const canonicalHostMatch = rendererSource.match(
  /const MX_DEFAULT_PUBLIC_BOOTSTRAP_HOST = '([^']+)';/
);
assert.ok(canonicalHostMatch, 'canonical public bootstrap host must be declared');
const canonicalHost = canonicalHostMatch[1];
assert.equal(canonicalHost, 'h2i.minsight-ai.com');

const runtimeHelpers = Function(
  `
const MX_DEFAULT_PUBLIC_BOOTSTRAP_HOST = ${JSON.stringify(canonicalHost)};
function positiveNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
${functionSource(rendererSource, 'domesticRuntimeDefaultConfig')}
${functionSource(rendererSource, 'domesticRuntimeBootstrapParts')}
${functionSource(rendererSource, 'domesticRuntimePublicUrl')}
${functionSource(rendererSource, 'domesticRuntimeBootstrapSummaryLabel')}
return {
  domesticRuntimeDefaultConfig,
  domesticRuntimeBootstrapParts,
  domesticRuntimePublicUrl,
  domesticRuntimeBootstrapSummaryLabel
};
`
)();

const draft = runtimeHelpers.domesticRuntimeDefaultConfig('domestic-main');
assert.equal(draft.edge.publicBaseUrl, 'https://h2i.minsight-ai.com');
assert.equal(draft.edge.bind, '127.0.0.1', 'a new config must not expose the legacy listener by default');
assert.equal(draft.edge.port, 18090, 'legacy edge port remains independently configurable');

assert.deepEqual(
  runtimeHelpers.domesticRuntimeBootstrapParts(draft),
  {
    protocol: 'https',
    host: 'h2i.minsight-ai.com',
    port: 443
  }
);
assert.deepEqual(
  runtimeHelpers.domesticRuntimeBootstrapParts({
    edge: {
      bind: '0.0.0.0',
      port: 18090,
      publicBaseUrl: 'http://legacy.example:18090'
    }
  }),
  {
    protocol: 'http',
    host: 'legacy.example',
    port: 18090
  },
  'an existing saved legacy URL is rendered honestly instead of silently rewritten'
);
assert.deepEqual(
  runtimeHelpers.domesticRuntimeBootstrapParts({ edge: { bind: '0.0.0.0', port: 18090 } }),
  {
    protocol: 'https',
    host: 'h2i.minsight-ai.com',
    port: 443
  },
  'a missing public URL falls back to the canonical HTTPS identity, not the SSH host'
);

assert.equal(
  runtimeHelpers.domesticRuntimePublicUrl({
    protocol: 'https',
    host: canonicalHost,
    port: 443
  }),
  'https://h2i.minsight-ai.com'
);
assert.match(
  runtimeHelpers.domesticRuntimeBootstrapSummaryLabel({
    protocol: 'http',
    host: canonicalHost,
    port: 18090
  }),
  /Non-canonical bootstrap draft/
);

assert.doesNotMatch(
  rendererSource,
  /function domesticRuntimeDefaultBootstrapHost\(/,
  'the TLS bootstrap identity must not be inferred from a Domestic SSH profile or plan'
);
assert.match(rendererSource, /Legacy \/ Diagnostic Edge Bind/);
assert.match(rendererSource, /Legacy \/ Diagnostic Edge Port/);
assert.match(
  rendererSource,
  /data-domestic-runtime-public-summary-label/,
  'the public summary must distinguish the current form draft'
);
assert.match(
  functionSource(rendererSource, 'bindDomesticRuntimeControls'),
  /refreshDomesticRuntimeDraftSummary\(root\)/,
  'editing a runtime field must refresh the visible draft summary'
);

console.log('domestic runtime config UI contract: ok');
