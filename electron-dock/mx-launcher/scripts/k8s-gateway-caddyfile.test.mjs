import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { patchGatewayCaddyfile } from './k8s-gateway-caddyfile.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));
const manifest = readFileSync(join(scripts, '../deploy/k8s/internal-shadow/45-internal-gateway.yaml'), 'utf8');
const baseline = manifest.split('  Caddyfile: |\n')[1].split('  mx-gateway-routes.json: |\n')[0].replace(/^    /gm, '');
const old = 'mx-launcher-internal.mx-internal-shadow.svc.cluster.local:18090';
const next = '192.168.241.51:18090';

test('current manifest updates both API proxies while retaining all headers, blocks and listener ports', () => {
  assert.equal(baseline.split(old).length - 1, 2);
  const patched = patchGatewayCaddyfile(baseline, next);
  assert.equal(patched, baseline.replaceAll(old, next));
  assert.equal(patchGatewayCaddyfile(patched, next), patched);
  assert.match(patched, /header_up X-Forwarded-For \{http\.request\.header\.X-Forwarded-For\}/);
  assert.match(patched, /header_up X-Forwarded-For \{remote_host\}/);
  assert.match(patched, /header_up -X-MX-Forwarded-By/);
});

test('app routes and other site blocks targeting the same port are preserved', () => {
  const apps = `:80 {\n  handle {\n    reverse_proxy ${old} {\n      header_up X-App test\n    }\n  }\n}\n:8008 {\n  reverse_proxy 192.168.1.4:18090\n}\n`;
  const config = baseline.slice(0, baseline.indexOf('# mx-gateway-optional-port-80:start')) + apps;
  const patched = patchGatewayCaddyfile(config, next);
  assert.ok(patched.endsWith(apps));
  assert.equal(patched.split(next).length - 1, 2);
});

test('legacy one-line proxy, comments, CRLF and indented generated blocks are supported', () => {
  const legacy = `:18090 {\n  reverse_proxy ${old} # API only\n}\n`;
  assert.equal(patchGatewayCaddyfile(legacy, next), legacy.replace(old, next));
  const crlf = baseline.replaceAll('\n', '\r\n');
  assert.equal(patchGatewayCaddyfile(crlf, next), crlf.replaceAll(old, next));
  const indented = baseline.replace(/^/gm, '  ');
  assert.equal(patchGatewayCaddyfile(indented, next), indented.replaceAll(old, next));
  const comment = baseline.replaceAll(`${old} {`, `${old} { # preserve block comment`);
  assert.equal(patchGatewayCaddyfile(comment, next), comment.replaceAll(old, next));
});

test('ambiguous or partially recognizable API routes fail instead of applying a partial rewrite', () => {
  for (const config of ['', ':8008 {\n  reverse_proxy old:18090\n}\n', baseline + baseline,
    baseline.replace(`reverse_proxy ${old} {`, `reverse_proxy ${old} other:18090 {`),
    baseline.replace(`reverse_proxy ${old} {`, 'reverse_proxy unknown:8080 {')]) {
    assert.throws(() => patchGatewayCaddyfile(config, next));
  }
  for (const upstream of ['bad\nvalue:18090', '192.168.1.2:80', 'http://host:18090', 'host:18090 {']) {
    assert.throws(() => patchGatewayCaddyfile(baseline, upstream), /host:18090/);
  }
});

function runGateway(content, existing = true) {
  const dir = mkdtempSync(join(tmpdir(), 'mx-gateway-caddy-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'Caddyfile'), content);
  const routes = '{"routes":[{"id":"keep-existing-app-route"}]}\n';
  writeFileSync(join(dir, 'routes.json'), routes);
  const fake = join(dir, 'bin/kubectl');
  writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), dir = process.env.MX_GATEWAY_TEST_DIR;
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(args)+'\\n');
if (args.includes('get')) {
  if (args.some(a => a.includes('Caddyfile'))) process.stdout.write(fs.readFileSync(path.join(dir,'Caddyfile')));
  else if (args.some(a => a.includes('mx-gateway-routes.json'))) process.stdout.write(fs.readFileSync(path.join(dir,'routes.json')));
  else process.exit(process.env.MX_GATEWAY_TEST_EXISTS === '1' ? 0 : 1);
} else if (args.includes('create')) {
  for (const key of ['Caddyfile','mx-gateway-routes.json']) {
    const flag = args.find(a => a.startsWith('--from-file='+key+'='));
    fs.copyFileSync(flag.slice(('--from-file='+key+'=').length), path.join(dir,key+'.patched'));
  }
  process.stdout.write('apiVersion: v1\\nkind: ConfigMap\\n');
} else if (args.includes('apply') && args.at(-1) === '-') fs.readFileSync(0);
`);
  chmodSync(fake, 0o755);
  const source = readFileSync(join(scripts, 'manage.sh'), 'utf8');
  const body = source.match(/^k8s_apply_internal_gateway\(\) \{\n[\s\S]*?^\}/m)[0];
  try {
    const result = spawnSync('bash', ['-c', `set -Eeuo pipefail
say() { printf '%s\\n' "$*"; }
die() { printf '%s\\n' "$*" >&2; exit 1; }
k8s_namespace() { echo mx-internal-shadow; }
k8s_manifest_dir() { echo "$MX_GATEWAY_MANIFEST_DIR"; }
k8s_select_internal_api_gateway_upstream() { K8S_SELECTED_INTERNAL_API_UPSTREAM=192.168.241.51:18090; }
${body}
k8s_apply_internal_gateway internal-shadow`], { encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, SCRIPT_DIR: scripts,
        MX_GATEWAY_TEST_DIR: dir, MX_GATEWAY_TEST_EXISTS: existing ? '1' : '0', TMPDIR: dir,
        MX_GATEWAY_MANIFEST_DIR: join(scripts, '../deploy/k8s/internal-shadow') } });
    return { result, routes,
      patched: existsSync(join(dir, 'Caddyfile.patched')) ? readFileSync(join(dir, 'Caddyfile.patched'), 'utf8') : null,
      patchedRoutes: existsSync(join(dir, 'mx-gateway-routes.json.patched')) ? readFileSync(join(dir, 'mx-gateway-routes.json.patched'), 'utf8') : null,
      calls: readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('deploy gateway path handles both a newly created ConfigMap and an existing routed gateway', () => {
  for (const existing of [false, true]) {
    const { result, patched, patchedRoutes, routes } = runGateway(baseline, existing);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(patched, baseline.replaceAll(old, next));
    assert.equal(patchedRoutes, routes);
  }
});

test('unsupported gateway configuration stops before ConfigMap update or forced restart', () => {
  const { result, calls, patched } = runGateway(':8008 {\n  reverse_proxy app:18090\n}\n');
  assert.notEqual(result.status, 0);
  assert.equal(patched, null);
  assert.ok(!calls.some(c => c.includes('create') || c.includes('restart')));
});

test('stable rollout version avoids repeat restarts and resumes a ConfigMap write interrupted before rollout', () => {
  const expected = createHash('sha256').update(baseline.replaceAll(old, next)).digest('hex');
  for (const content of [baseline, baseline.replaceAll(old, next)]) {
    const { result, calls, patched } = runGateway(content);
    assert.equal(result.status, 0, result.stderr);
    const patch = calls.find(c => c.includes('patch') && c.includes('daemonset'));
    assert.ok(patch, 'even unchanged config must reconcile the rollout version after an interruption');
    assert.equal(JSON.parse(patch[patch.indexOf('-p') + 1]).spec.template.metadata.annotations['mx.qpjoy.com/gateway-caddyfile-sha256'], expected);
    assert.ok(!calls.some(c => c.includes('restart')));
    if (content.includes(next)) {
      assert.equal(patched, null);
      assert.ok(!calls.some(c => c.includes('create')));
    }
  }
});
