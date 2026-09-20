import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scripts = dirname(fileURLToPath(import.meta.url));
const manage = readFileSync(join(scripts, 'manage.sh'), 'utf8');
const proxyScript = join(scripts, 'launcher-build-proxy.sh');
const functions = ['shadow_image_build', 'shadow_image_build_impl', 'shadow_image_cleanup',
  'containerd_image_ref_aliases', 'k8s_preload_runtime_images'].map(name => {
  const body = manage.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, 'm'))?.[0];
  assert.ok(body, name);
  return body;
}).join('\n');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mx-launcher-build-proxy-'));
  mkdirSync(join(dir, 'server'));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'tmp'));
  const log = join(dir, 'calls.jsonl');
  const fake = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const tool = path.basename(process.argv[1]), args = process.argv.slice(2), e = process.env;
const keys = ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','NO_PROXY','no_proxy',
  'npm_config_proxy','npm_config_https_proxy','NPM_CONFIG_PROXY','NPM_CONFIG_HTTPS_PROXY','MX_SHADOW_NPM_REGISTRY'];
fs.appendFileSync(e.MX_TEST_LOG, JSON.stringify({tool,args,env:Object.fromEntries(keys.map(k=>[k,e[k]??null]))})+'\\n');
const base = e.MX_TEST_DIR;
const die = () => process.exit(31);
if (tool === 'uname') { console.log('Linux'); process.exit(); }
if (tool === 'ctr') {
  if (args.includes('--help')) { console.log(e.MX_TEST_CTR2 === '1' ? '--local' : '1.x flags'); process.exit(); }
  if (e.MX_TEST_PULL_FAIL === '1' && args.includes('pull')) die();
  if (args.includes('export')) fs.writeFileSync(args[args.indexOf('export')+3], JSON.stringify({image:args.at(-1)}));
  process.exit();
}
const action = args.slice(0,2).join(' ');
if (action === 'context inspect') console.log(e.MX_TEST_DOCKER_ENDPOINT || 'unix:///var/run/docker.sock');
else if (args[0] === 'version') console.log('linux/amd64');
else if (action === 'buildx version') console.log('buildx test');
else if (action === 'buildx inspect') {
  if (!fs.existsSync(path.join(base,args[2]))) process.exit(1);
  console.log('Driver: docker-container');
} else if (action === 'buildx create') fs.writeFileSync(path.join(base,args[args.indexOf('--name')+1]), 'builder');
else if (action === 'image inspect') {
  const canonical = s => s.replace(/^docker\\.io\\//,'').replace(/^library\\//,'');
  const missing = JSON.parse(e.MX_TEST_MISSING_IMAGES || '[]').map(canonical);
  const loadedFile = path.join(base,'loaded.json');
  const loaded = fs.existsSync(loadedFile) ? JSON.parse(fs.readFileSync(loadedFile)) : [];
  if (missing.includes(canonical(args[2])) && !loaded.includes(canonical(args[2]))) process.exit(1);
} else if (args[0] === 'load') {
  const image = JSON.parse(fs.readFileSync(args[args.indexOf('--input')+1])).image.replace(/^docker\\.io\\//,'').replace(/^library\\//,'');
  fs.writeFileSync(path.join(base,'loaded.json'),JSON.stringify([image]));
} else if (args[0] === 'compose' && args.includes('config')) {
  console.log(JSON.stringify({services:{internal:{build:{args:{MX_SHADOW_NPM_REGISTRY:'https://registry.example.test'}}}}}));
} else if (action === 'buildx prune' && args.includes('--help')) console.log('--max-used-space');
else if (['pull','system','volume','restart','stop','rm'].includes(args[0])) die();
`;
  for (const tool of ['docker', 'ctr', 'uname']) {
    writeFileSync(join(dir, 'bin', tool), fake);
    chmodSync(join(dir, 'bin', tool), 0o755);
  }
  return {
    dir,
    run(body = 'shadow_image_build\ndocker test-after', env = {}) {
      return spawnSync('bash', ['-c', `set -Eeuo pipefail
say() { printf '%s\\n' "$*"; }
die() { printf '%s\\n' "$*" >&2; exit 1; }
source "$MX_PROXY_SCRIPT"
${functions}
shadow_image_artifacts() { docker test-artifacts; }
shadow_image_admin_assets() { :; }
containerd_import_docker_image() { docker test-import "$1"; }
cd "$ROOT"
${body}`], { encoding: 'utf8', timeout: 15000, env: {
        ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, ROOT: dir,
        TMPDIR: join(dir, 'tmp'), MX_TEST_DIR: dir, MX_TEST_LOG: log, MX_PROXY_SCRIPT: proxyScript,
        HTTP_PROXY: 'http://old.proxy:1000', HTTPS_PROXY: 'http://old.proxy:1000', ALL_PROXY: 'socks5://old.proxy:2000',
        http_proxy: 'http://old.proxy:3000', https_proxy: 'http://old.proxy:3000', all_proxy: 'socks5://old.proxy:4000',
        NO_PROXY: '*', no_proxy: '*', npm_config_proxy: 'http://old.proxy:5000',
        MX_LAUNCHER_BUILD_PROXY: '', MX_LAUNCHER_BUILD_NO_PROXY: '', MX_LAUNCHER_PROXY_BUILDER: '',
        MX_SHADOW_IMAGE_CLEANUP: '0', MX_K8S_PRELOAD_RUNTIME_IMAGES: '1', DOCKER_HOST: '', DOCKER_CONTEXT: '',
        ...env
      } });
    },
    calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [],
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}
const proxy = 'http://127.0.0.1:7788';
function checkProxy(call) {
  for (const name of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','npm_config_proxy','npm_config_https_proxy']) {
    assert.equal(call.env[name], proxy, `${call.tool}: ${name}`);
  }
  assert.match(call.env.NO_PROXY, /127\.0\.0\.1/);
  assert.match(call.env.NO_PROXY, /\.svc/);
  assert.equal(call.env.NO_PROXY, call.env.no_proxy);
  assert.notEqual(call.env.NO_PROXY, '*', 'an inherited wildcard must not disable the selected proxy');
}

test('without the opt-in proxy, the original Compose build and environment are preserved', () => {
  const f = fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const calls = f.calls();
    assert.ok(calls.some(c => c.args.join(' ') === 'compose -f docker-compose.shadow.yml build internal'));
    assert.ok(!calls.some(c => c.args[0] === 'buildx' || c.tool === 'ctr'));
    assert.ok(calls.every(c => c.env.HTTP_PROXY === 'http://old.proxy:1000'));
  } finally { f.cleanup(); }
});

test('custom proxy covers artifacts, registry-token client, buildkitd and RUN; parent environment stays intact', () => {
  const f = fixture();
  try {
    const result = f.run(undefined, { MX_LAUNCHER_BUILD_PROXY: proxy });
    assert.equal(result.status, 0, result.stderr);
    const calls = f.calls();
    for (const call of calls.filter(c => ['test-artifacts','buildx','compose'].includes(c.args[0]))) checkProxy(call);
    const create = calls.find(c => c.args[0] === 'buildx' && c.args[1] === 'create');
    assert.ok(create.args.includes('network=host'));
    assert.ok(create.args.includes(`env.HTTP_PROXY=${proxy}`));
    assert.ok(create.args.includes(`env.https_proxy=${proxy}`));
    assert.ok(create.args.some(a => a.startsWith('"env.NO_PROXY=localhost,') && a.endsWith('"')));
    assert.ok(create.args.includes('--allow-insecure-entitlement network.host'));
    assert.ok(!create.args.includes('--use'));
    const build = calls.find(c => c.args[0] === 'buildx' && c.args[1] === 'build');
    for (const flag of ['--load','--builder','--network','--allow','network.host','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY']) assert.ok(build.args.includes(flag), flag);
    assert.equal(build.env.MX_SHADOW_NPM_REGISTRY, 'https://registry.example.test');
    assert.ok(build.args.includes('qpjoy/mx-launcher-server:shadow'));
    assert.equal(calls.at(-1).args[0], 'test-after');
    assert.equal(calls.at(-1).env.HTTP_PROXY, 'http://old.proxy:1000');
    assert.equal(calls.at(-1).env.NO_PROXY, '*');
  } finally { f.cleanup(); }
});

test('builder is reused for identical settings and a changed proxy selects a different builder', () => {
  const f = fixture();
  try {
    const result = f.run(`shadow_image_build
shadow_image_build
MX_LAUNCHER_BUILD_PROXY=http://127.0.0.1:8899 shadow_image_build`, { MX_LAUNCHER_BUILD_PROXY: proxy });
    assert.equal(result.status, 0, result.stderr);
    const creates = f.calls().filter(c => c.args[0] === 'buildx' && c.args[1] === 'create');
    assert.equal(creates.length, 2);
    assert.notEqual(creates[0].args[3], creates[1].args[3]);
    assert.ok(creates[1].args.includes('env.HTTP_PROXY=http://127.0.0.1:8899'));
  } finally { f.cleanup(); }
});

test('uncached BuildKit bootstraps through the ctr client for both containerd 1.x and 2.x', () => {
  for (const version of ['0', '1']) {
    const f = fixture();
    try {
      const result = f.run(undefined, { MX_LAUNCHER_BUILD_PROXY: proxy, MX_TEST_CTR2: version,
        MX_TEST_MISSING_IMAGES: '["moby/buildkit:buildx-stable-1"]' });
      assert.equal(result.status, 0, result.stderr);
      const calls = f.calls();
      const pull = calls.find(c => c.tool === 'ctr' && c.args.includes('pull') && !c.args.includes('--help'));
      assert.ok(pull, result.stderr);
      checkProxy(pull);
      assert.equal(pull.args.includes('--local'), version === '1');
      assert.ok(pull.args.includes('mx-launcher-build-proxy'));
      assert.ok(!pull.args.includes('k8s.io'));
      assert.ok(pull.args.includes('linux/amd64'));
      const load = calls.findIndex(c => c.args[0] === 'load');
      const create = calls.findIndex(c => c.args[1] === 'create');
      assert.ok(load >= 0 && create > load);
      assert.ok(!calls.some(c => c.tool === 'docker' && c.args[0] === 'pull'));
      assert.deepEqual(readdirSync(join(f.dir, 'tmp')), []);
    } finally { f.cleanup(); }
  }
});

test('failed bootstrap removes only its temporary archive and stops before artifacts or build', () => {
  const f = fixture();
  try {
    const result = f.run(undefined, { MX_LAUNCHER_BUILD_PROXY: proxy, MX_TEST_PULL_FAIL: '1',
      MX_TEST_MISSING_IMAGES: '["moby/buildkit:buildx-stable-1"]' });
    assert.equal(result.status, 31, result.stderr);
    assert.ok(!f.calls().some(c => c.args[0] === 'test-artifacts' || c.args[1] === 'create' || c.args[1] === 'build'));
    assert.deepEqual(readdirSync(join(f.dir, 'tmp')), [], result.stderr);
  } finally { f.cleanup(); }
});

test('missing runtime images use the selected proxy; existing images are imported without download', () => {
  const f = fixture();
  try {
    const result = f.run('k8s_preload_runtime_images', { MX_LAUNCHER_BUILD_PROXY: proxy,
      MX_K8S_RUNTIME_IMAGES: 'postgres:16-alpine caddy:2.8.4-alpine', MX_TEST_MISSING_IMAGES: '["caddy:2.8.4-alpine"]' });
    assert.equal(result.status, 0, result.stderr);
    const pulls = f.calls().filter(c => c.tool === 'ctr' && c.args.includes('pull') && !c.args.includes('--help'));
    assert.equal(pulls.length, 1);
    assert.equal(pulls[0].args.at(-1), 'docker.io/library/caddy:2.8.4-alpine');
    checkProxy(pulls[0]);
    assert.equal(f.calls().filter(c => c.args[0] === 'test-import').length, 2);
  } finally { f.cleanup(); }
});

test('cache cleanup targets only the selected proxy builder and honors existing limits', () => {
  const f = fixture();
  try {
    const result = f.run(undefined, { MX_LAUNCHER_BUILD_PROXY: proxy, MX_SHADOW_IMAGE_CLEANUP: '1',
      MX_SHADOW_BUILDKIT_PRUNE: '1', MX_SHADOW_BUILDKIT_KEEP_STORAGE: '2GB', MX_SHADOW_BUILDKIT_PRUNE_UNTIL: '24h' });
    assert.equal(result.status, 0, result.stderr);
    const calls = f.calls();
    assert.ok(!calls.some(c => c.args[0] === 'builder'));
    const prune = calls.find(c => c.args[0] === 'buildx' && c.args[1] === 'prune' && !c.args.includes('--help'));
    assert.ok(prune.args.includes('--builder'));
    assert.ok(prune.args.includes('until=24h'));
    assert.ok(prune.args.includes('2GB'));
  } finally { f.cleanup(); }
});

test('invalid proxy URLs fail before commands and do not echo credentials', () => {
  for (const proxy of ['socks5://user:PRIVATE@127.0.0.1:7788', 'http://user:PRIVATE,raw@127.0.0.1:7788', 'not-a-url-PRIVATE']) {
    const f = fixture();
    try {
      const result = f.run(undefined, { MX_LAUNCHER_BUILD_PROXY: proxy });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /must be an HTTP\(S\) proxy URL/);
      assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE/);
      assert.deepEqual(f.calls(), []);
    } finally { f.cleanup(); }
  }
});

test('remote Docker context is rejected before starting a host-network builder', () => {
  const f = fixture();
  try {
    const result = f.run(undefined, { MX_LAUNCHER_BUILD_PROXY: proxy, MX_TEST_DOCKER_ENDPOINT: 'ssh://other-host' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /local Docker Unix socket/);
    assert.ok(!f.calls().some(c => c.args[0] === 'buildx' || c.tool === 'ctr'));
  } finally { f.cleanup(); }
});

test('DOCKER_CONTEXT overrides DOCKER_HOST when checking that the engine is local', () => {
  const f = fixture();
  try {
    const result = f.run(undefined, { MX_LAUNCHER_BUILD_PROXY: proxy,
      DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CONTEXT: 'remote', MX_TEST_DOCKER_ENDPOINT: 'ssh://other-host' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /local Docker Unix socket/);
    assert.deepEqual(f.calls()[0].args, ['context', 'inspect', 'remote', '--format', '{{(index .Endpoints "docker").Host}}']);
    assert.ok(!f.calls().some(c => c.args[0] === 'buildx' || c.tool === 'ctr'));
  } finally { f.cleanup(); }
});

test('an explicit bypass list reaches both buildkitd and the build client unchanged', () => {
  const f = fixture();
  try {
    const bypass = 'localhost,127.0.0.1,.corp.example';
    const result = f.run(undefined, { MX_LAUNCHER_BUILD_PROXY: proxy, MX_LAUNCHER_BUILD_NO_PROXY: bypass });
    assert.equal(result.status, 0, result.stderr);
    const create = f.calls().find(c => c.args[0] === 'buildx' && c.args[1] === 'create');
    assert.ok(create.args.includes(`"env.NO_PROXY=${bypass}"`));
    const build = f.calls().find(c => c.args[0] === 'buildx' && c.args[1] === 'build');
    assert.equal(build.env.NO_PROXY, bypass);
    assert.equal(f.calls().at(-1).env.NO_PROXY, '*');
  } finally { f.cleanup(); }
});

test('proxy build args remain predefined and are not persisted as Dockerfile ENV/ARG', () => {
  const dockerfile = readFileSync(join(scripts, '../server/Dockerfile'), 'utf8');
  assert.doesNotMatch(dockerfile, /^(?:ENV|ARG)\s+(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy)\b/m);
});
