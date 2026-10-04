import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const proxyScript = fileURLToPath(new URL('../scripts/build-proxy.sh', import.meta.url));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mx-pay-build-proxy-'));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'tmp'));
  const log = join(dir, 'calls.jsonl');
  const fake = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const tool = path.basename(process.argv[1]), args = process.argv.slice(2), e = process.env;
const keys = ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','NO_PROXY','no_proxy'];
fs.appendFileSync(e.MX_TEST_LOG, JSON.stringify({tool,args,env:Object.fromEntries(keys.map(k=>[k,e[k]??null]))})+'\\n');
const base = e.MX_TEST_DIR;
const die = () => process.exit(31);
if (tool === 'uname') { console.log(args[0] === '-m' ? 'x86_64' : 'Linux'); process.exit(); }
if (tool === 'ctr') {
  if (args.includes('list')) { console.log(e.MX_TEST_PG_CACHED === '1' ? 'docker.io/library/postgres:16-bookworm' : ''); process.exit(); }
  if (args.includes('--help')) { console.log(e.MX_TEST_CTR2 === '1' ? '--local' : '1.x flags'); process.exit(); }
  if (e.MX_TEST_PULL_FAIL === '1' && args.includes('pull')) die();
  if (args.includes('export')) fs.writeFileSync(args[args.indexOf('export')+3], JSON.stringify({image:args.at(-1)}));
  process.exit();
}
const action = args.slice(0,2).join(' ');
if (action === 'buildx build' && args.some(arg => arg.includes('host-gateway'))) {
  console.error('host-gateway is not supported by the docker-container driver');
  process.exit(32);
}
if (action === 'context inspect') console.log(e.MX_TEST_DOCKER_ENDPOINT || 'unix:///var/run/docker.sock');
else if (args[0] === 'version') console.log('linux/amd64');
else if (action === 'buildx version') console.log('buildx test');
else if (action === 'buildx inspect') {
  if (!fs.existsSync(path.join(base,args[2]))) process.exit(1);
  if (args.includes('--bootstrap') && e.MX_TEST_BOOT_FAIL === '1') die();
  const builder = JSON.parse(fs.readFileSync(path.join(base,args[2])));
  console.log('Driver: '+(e.MX_TEST_BUILDER_DRIVER || builder.driver));
  console.log('Endpoint: '+(e.MX_TEST_BUILDER_ENDPOINT || builder.endpoint));
} else if (action === 'buildx create') fs.writeFileSync(path.join(base,args[args.indexOf('--name')+1]), JSON.stringify({driver:args[args.indexOf('--driver')+1],endpoint:args.at(-1)}));
else if (action === 'container inspect') {
  if (e.MX_TEST_CONTAINER_CONFLICT === '1') { console.log('unowned|wrong-image|bridge|false'); process.exit(); }
  const file = path.join(base,'container-'+args[2]);
  if (!fs.existsSync(file)) process.exit(1);
  const container = JSON.parse(fs.readFileSync(file));
  console.log(args.at(-1).includes('.State.Running') ? String(container.running) : container.identity);
} else if (args[0] === 'create') {
  if (!args.includes('--pull=never')) die();
  const name = args[args.indexOf('--name')+1];
  const image = args[args.indexOf('--allow-insecure-entitlement')-1];
  fs.writeFileSync(path.join(base,'container-'+name), JSON.stringify({running:false,identity:name+'|'+image+'|host|true'}));
} else if (args[0] === 'start') {
  if (e.MX_TEST_START_FAIL === '1') die();
  const file = path.join(base,'container-'+args[1]), container = JSON.parse(fs.readFileSync(file));
  container.running = true; fs.writeFileSync(file,JSON.stringify(container));
}
else if (action === 'image inspect') {
  const canonical = s => s.replace(/^docker\\.io\\//,'').replace(/^library\\//,'');
  const missing = JSON.parse(e.MX_TEST_MISSING_IMAGES || '[]').map(canonical);
  const loadedFile = path.join(base,'loaded.json');
  const loaded = fs.existsSync(loadedFile) ? JSON.parse(fs.readFileSync(loadedFile)) : [];
  if (missing.includes(canonical(args[2])) && !loaded.includes(canonical(args[2]))) process.exit(1);
} else if (args[0] === 'load') {
  const image = JSON.parse(fs.readFileSync(args[args.indexOf('--input')+1])).image.replace(/^docker\\.io\\//,'').replace(/^library\\//,'');
  fs.writeFileSync(path.join(base,'loaded.json'),JSON.stringify([image]));
}
else if (['pull','system','volume','restart','stop','rm'].includes(args[0])) die();
`;
  for (const tool of ['docker', 'ctr', 'uname']) {
    writeFileSync(join(dir, 'bin', tool), fake);
    chmodSync(join(dir, 'bin', tool), 0o755);
  }
  return {
    dir,
    run(body = 'pay_buildx --load --tag mx-pay:test .\ndocker test-after', env = {}) {
      return spawnSync('bash', ['-c', `set -Eeuo pipefail
say() { printf '%s\\n' "$*"; }
die() { printf '%s\\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null; }
source "$MX_PROXY_SCRIPT"
cd "$ROOT"
${body}`], { encoding: 'utf8', timeout: 15000, env: {
        ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, ROOT: dir,
        TMPDIR: join(dir, 'tmp'), MX_TEST_DIR: dir, MX_TEST_LOG: log, MX_PROXY_SCRIPT: proxyScript,
        HTTP_PROXY: 'http://old.proxy:1000', HTTPS_PROXY: 'http://old.proxy:1000', ALL_PROXY: 'socks5://old.proxy:2000',
        http_proxy: 'http://old.proxy:3000', https_proxy: 'http://old.proxy:3000', all_proxy: 'socks5://old.proxy:4000',
        NO_PROXY: '*', no_proxy: '*', npm_config_proxy: 'http://old.proxy:5000',
        MX_PAY_BUILD_PROXY: '', MX_PAY_BUILD_NO_PROXY: '', DOCKER_HOST: '', DOCKER_CONTEXT: '',
        ...env
      } });
    },
    calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [],
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}
const proxy = 'http://127.0.0.1:7789';
function checkProxy(call) {
  for (const name of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']) {
    assert.equal(call.env[name], proxy, `${call.tool}: ${name}`);
  }
  assert.match(call.env.NO_PROXY, /127\.0\.0\.1/);
  assert.match(call.env.NO_PROXY, /\.svc/);
  assert.equal(call.env.NO_PROXY, call.env.no_proxy);
  assert.notEqual(call.env.NO_PROXY, '*', 'an inherited wildcard must not disable the selected proxy');
}

test('no proxy preserves the original build and environment', () => {
  const f = fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.calls()[0].args, ['buildx', 'build', '--load', '--tag', 'mx-pay:test', '.']);
    assert.equal(f.calls().length, 2);
    assert.ok(f.calls().every(c => c.env.HTTP_PROXY === 'http://old.proxy:1000'));
  } finally { f.cleanup(); }
});

test('loopback proxy reaches the build client, registry pulls and RUN without leaking into the caller', () => {
  const f = fixture();
  try {
    const result = f.run(undefined, { MX_PAY_BUILD_PROXY: proxy });
    assert.equal(result.status, 0, result.stderr);
    const calls = f.calls(), container = calls.find(c => c.args[0] === 'create');
    checkProxy(container);
    assert.equal(container.args[container.args.indexOf('--network')+1], 'host');
    assert.ok(container.args.includes('--pull=never'));
    assert.ok(!container.args.includes('-p') && !container.args.includes('--publish'));
    const create = calls.find(c => c.args[0] === 'buildx' && c.args[1] === 'create');
    assert.equal(create.args[create.args.indexOf('--driver')+1], 'remote');
    assert.equal(create.args.at(-1), 'docker-container://'+container.args[container.args.indexOf('--name')+1]);
    assert.ok(!create.args.includes('--use'));
    const build = calls.find(c => c.args[0] === 'buildx' && c.args[1] === 'build');
    checkProxy(build);
    for (const flag of ['--load','--builder','--network','--allow','network.host','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY']) assert.ok(build.args.includes(flag), flag);
    assert.equal(build.args[build.args.indexOf('--network')+1], 'host');
    assert.ok(!calls.some(c => c.args.some(a => a.includes(proxy) || a.includes('host-gateway'))));
    assert.equal(calls.at(-1).env.HTTP_PROXY, 'http://old.proxy:1000');
    assert.equal(calls.at(-1).env.NO_PROXY, '*');
    const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
    assert.doesNotMatch(dockerfile, /^(?:ENV|ARG)\s+(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)\b/im);
  } finally { f.cleanup(); }
});

test('single-node PostgreSQL preload checks the host, uses the proxy and skips cached images', () => {
  for (const cached of ['0','1']) {
    const f = fixture();
    try {
      const result = f.run(`node() { if [ "$2" = local-single-node ]; then docker test-verify-host; elif [ "$2" = postgres-image ]; then printf 'postgres:16-bookworm'; else command node "$@"; fi; }
pay_with_build_proxy pay_proxy_postgres_image
docker test-after`, { MX_PAY_BUILD_PROXY: proxy, MX_TEST_PG_CACHED: cached, MX_TEST_CTR2: '1' });
      assert.equal(result.status, 0, result.stderr);
      const calls = f.calls(), pulls = calls.filter(c => c.tool === 'ctr' && c.args.includes('pull') && !c.args.includes('--help'));
      assert.equal(calls[0].args[0], 'test-verify-host');
      assert.equal(pulls.length, cached === '1' ? 0 : 1);
      if (pulls.length) {
        checkProxy(pulls[0]);
        for (const arg of ['k8s.io','--local','linux/amd64','docker.io/library/postgres:16-bookworm']) assert.ok(pulls[0].args.includes(arg));
      }
      assert.equal(calls.at(-1).env.HTTP_PROXY, 'http://old.proxy:1000');
    } finally { f.cleanup(); }
  }
});

test('builder is reused for identical settings and a changed proxy selects a different builder', () => {
  const f = fixture();
  try {
    const result = f.run(`pay_buildx --load .
pay_buildx --load .
MX_PAY_BUILD_PROXY=http://127.0.0.1:8899 pay_buildx --load .`, { MX_PAY_BUILD_PROXY: proxy });
    assert.equal(result.status, 0, result.stderr);
    const creates = f.calls().filter(c => c.args[0] === 'buildx' && c.args[1] === 'create');
    assert.equal(creates.length, 2);
    assert.notEqual(creates[0].args[3], creates[1].args[3]);
    const containers = f.calls().filter(c => c.args[0] === 'create');
    assert.equal(containers.length, 2);
    assert.equal(containers[1].env.HTTP_PROXY, 'http://127.0.0.1:8899');
    assert.equal(f.calls().filter(c => c.args[0] === 'start').length, 2, 'a running builder must not restart');
  } finally { f.cleanup(); }
});

test('uncached BuildKit bootstraps through the ctr client for both containerd 1.x and 2.x', () => {
  for (const version of ['0', '1']) {
    const f = fixture();
    try {
      const result = f.run(undefined, { MX_PAY_BUILD_PROXY: proxy, MX_TEST_CTR2: version,
        MX_TEST_MISSING_IMAGES: '["moby/buildkit:buildx-stable-1"]' });
      assert.equal(result.status, 0, result.stderr);
      const calls = f.calls();
      const pull = calls.find(c => c.tool === 'ctr' && c.args.includes('pull') && !c.args.includes('--help'));
      assert.ok(pull, result.stderr);
      checkProxy(pull);
      assert.equal(pull.args.includes('--local'), version === '1');
      assert.ok(pull.args.includes('mx-pay-build-proxy'));
      assert.ok(!pull.args.includes('k8s.io'));
      assert.ok(pull.args.includes('linux/amd64'));
      const load = calls.findIndex(c => c.args[0] === 'load');
      const create = calls.findIndex(c => c.args[0] === 'create');
      assert.ok(load >= 0 && create > load);
      assert.ok(!calls.some(c => c.tool === 'docker' && c.args[0] === 'pull'));
      assert.deepEqual(readdirSync(join(f.dir, 'tmp')), []);
    } finally { f.cleanup(); }
  }
});

test('stopped or missing managed BuildKit resumes without pulling through dockerd or replacing its cache', () => {
  const f = fixture();
  try {
    assert.equal(f.run(undefined, { MX_PAY_BUILD_PROXY: proxy }).status, 0);
    const create = f.calls().find(c => c.args[0] === 'create');
    const name = create.args[create.args.indexOf('--name')+1];
    const file = join(f.dir, 'container-'+name);
    const container = JSON.parse(readFileSync(file));
    container.running = false; writeFileSync(file, JSON.stringify(container));
    assert.equal(f.run(undefined, { MX_PAY_BUILD_PROXY: proxy }).status, 0);
    assert.equal(f.calls().filter(c => c.args[0] === 'create').length, 1);
    assert.equal(f.calls().filter(c => c.args[0] === 'start').length, 2);
    rmSync(file);
    assert.equal(f.run(undefined, { MX_PAY_BUILD_PROXY: proxy }).status, 0);
    const creates = f.calls().filter(c => c.args[0] === 'create');
    assert.equal(creates.length, 2);
    assert.deepEqual(creates[0].args, creates[1].args, 'recreation reattaches the same dedicated volume');
    assert.equal(f.calls().filter(c => c.args[0] === 'buildx' && c.args[1] === 'create').length, 1);
    assert.ok(!f.calls().some(c => ['pull','stop','restart','rm','volume','system'].includes(c.args[0]) || c.tool === 'ctr'));
  } finally { f.cleanup(); }
});

test('unexpected container or builder identity is preserved and blocks the build', () => {
  for (const env of [{ MX_TEST_CONTAINER_CONFLICT: '1' }, { MX_TEST_BUILDER_DRIVER: 'docker-container' }, { MX_TEST_BUILDER_ENDPOINT: 'tcp://other-host:1234' }]) {
    const f = fixture();
    try {
      assert.equal(f.run(undefined, { MX_PAY_BUILD_PROXY: proxy }).status, 0);
      const previous = f.calls().length;
      const result = f.run(undefined, { MX_PAY_BUILD_PROXY: proxy, ...env });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /differs/);
      const calls = f.calls().slice(previous);
      assert.ok(!calls.some(c => ['create','start','stop','restart','rm','test-artifacts'].includes(c.args[0]) || c.args[1] === 'build'));
    } finally { f.cleanup(); }
  }
});

test('start/readiness failures stop before artifact generation and application build', () => {
  for (const env of [{ MX_TEST_START_FAIL: '1' }, { MX_TEST_BOOT_FAIL: '1' }]) {
    const f = fixture();
    try {
      const result = f.run(undefined, { MX_PAY_BUILD_PROXY: proxy, ...env });
      assert.notEqual(result.status, 0);
      assert.ok(!f.calls().some(c => c.args[0] === 'test-artifacts' || c.args[1] === 'build'));
    } finally { f.cleanup(); }
  }
});

test('failed bootstrap removes only its temporary archive and stops before artifacts or build', () => {
  const f = fixture();
  try {
    const result = f.run(undefined, { MX_PAY_BUILD_PROXY: proxy, MX_TEST_PULL_FAIL: '1',
      MX_TEST_MISSING_IMAGES: '["moby/buildkit:buildx-stable-1"]' });
    assert.equal(result.status, 31, result.stderr);
    assert.ok(!f.calls().some(c => c.args[0] === 'test-artifacts' || c.args[1] === 'create' || c.args[1] === 'build'));
    assert.deepEqual(readdirSync(join(f.dir, 'tmp')), [], result.stderr);
  } finally { f.cleanup(); }
});

test('invalid proxy URLs fail before commands and do not echo credentials', () => {
  for (const proxy of ['socks5://user:PRIVATE@127.0.0.1:7788', 'http://user:PRIVATE,raw@127.0.0.1:7788', 'not-a-url-PRIVATE']) {
    const f = fixture();
    try {
      const result = f.run(undefined, { MX_PAY_BUILD_PROXY: proxy });
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
    const result = f.run(undefined, { MX_PAY_BUILD_PROXY: proxy, MX_TEST_DOCKER_ENDPOINT: 'ssh://other-host' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /local Docker Unix socket/);
    assert.ok(!f.calls().some(c => c.args[0] === 'buildx' || c.tool === 'ctr'));
  } finally { f.cleanup(); }
});

test('an explicit bypass list reaches both buildkitd and the build client unchanged', () => {
  const f = fixture();
  try {
    const bypass = 'localhost,127.0.0.1,.corp.example';
    const result = f.run(undefined, { MX_PAY_BUILD_PROXY: proxy, MX_PAY_BUILD_NO_PROXY: bypass });
    assert.equal(result.status, 0, result.stderr);
    const create = f.calls().find(c => c.args[0] === 'create');
    assert.ok(create.args.includes('NO_PROXY'));
    assert.equal(create.env.NO_PROXY, bypass);
    const build = f.calls().find(c => c.args[0] === 'buildx' && c.args[1] === 'build');
    assert.equal(build.env.NO_PROXY, bypass);
    assert.equal(f.calls().at(-1).env.NO_PROXY, '*');
  } finally { f.cleanup(); }
});
