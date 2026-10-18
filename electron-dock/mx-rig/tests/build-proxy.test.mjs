import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const manageScript = fileURLToPath(new URL('../scripts/manage.sh', import.meta.url));
const proxy = 'http://127.0.0.1:7788';
const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy'];
const imageId = 'a'.repeat(64);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mx-rig-build-proxy-'));
  mkdirSync(join(dir, 'bin'));
  // The fakes are CommonJS. npm test keeps temp files inside this
  // "type": "module" package, where Node would load them as ES modules.
  writeFileSync(join(dir, 'bin', 'package.json'), '{"type":"commonjs"}\n');
  mkdirSync(join(dir, 'tmp'));
  const log = join(dir, 'calls.jsonl');
  const fake = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const tool = path.basename(process.argv[1]), args = process.argv.slice(2), e = process.env;
const keys = ${JSON.stringify(proxyKeys)};
fs.appendFileSync(e.MX_TEST_LOG, JSON.stringify({tool,args,env:Object.fromEntries(keys.map(k=>[k,e[k]??null]))})+'\\n');
const base = e.MX_TEST_DIR, die = () => process.exit(31);
if (tool === 'uname') { console.log(args[0] === '-m' ? 'x86_64' : 'Linux'); process.exit(); }
if (tool === 'id') { console.log(e.MX_TEST_UID || '0'); process.exit(); }
if (tool === 'node') die();
if (tool === 'sudo') {
  const index = args.indexOf('ctr');
  if (index < 0) die();
  const result = require('node:child_process').spawnSync(process.execPath, [path.join(base,'bin','ctr'), ...args.slice(index+1)], {stdio:'inherit'});
  process.exit(result.status ?? 31);
}
if (tool === 'hostname') { console.log('192.168.1.10'); process.exit(); }
if (tool === 'kubectl') {
  const s = args.join(' ');
  if (s.includes('current-context')) console.log('mx-internal');
  else if (s.includes('containerRuntimeVersion')) console.log('containerd://2.0.0');
  else if (s.includes('InternalIP')) console.log('192.168.1.10');
  else if (s.includes('get nodes')) console.log('node/mx-internal');
  else die();
  process.exit();
}
if (tool === 'ctr') {
  if (args.includes('--help')) { console.log(e.MX_TEST_CTR2 === '1' ? '--local' : '1.x flags'); process.exit(); }
  if (args.includes('list') || args.includes('ls')) {
    console.log(e.MX_TEST_PG_CACHED === '1' ? 'docker.io/library/postgres:17-alpine' : '');
    if (fs.existsSync(path.join(base,'imported'))) console.log('mx-rig.local/mx-rig-server:local-sha256-${imageId}');
    process.exit();
  }
  if (e.MX_TEST_PULL_FAIL === '1' && args.includes('pull')) die();
  if (args.includes('export')) fs.writeFileSync(args.at(-2), JSON.stringify({image:args.at(-1)}));
  if (args.includes('import')) fs.writeFileSync(path.join(base,'imported'), '1');
  process.exit();
}
const action = args.slice(0,2).join(' ');
if (action === 'context inspect') console.log(e.MX_TEST_DOCKER_ENDPOINT || 'unix:///var/run/docker.sock');
else if (args[0] === 'version') console.log('linux/amd64');
else if (action === 'buildx version') console.log('buildx test');
else if (action === 'buildx inspect') {
  if (!fs.existsSync(path.join(base,args[2]))) process.exit(1);
  if (args.includes('--bootstrap') && e.MX_TEST_BOOT_FAIL === '1') die();
  const builder = JSON.parse(fs.readFileSync(path.join(base,args[2])));
  console.log('Driver: '+builder.driver); console.log('Endpoint: '+builder.endpoint);
} else if (action === 'buildx create') {
  fs.writeFileSync(path.join(base,args[args.indexOf('--name')+1]), JSON.stringify({driver:args[args.indexOf('--driver')+1],endpoint:args.at(-1)}));
} else if (action === 'container inspect') {
  const file = path.join(base,'container-'+args[2]);
  if (!fs.existsSync(file)) process.exit(1);
  const container = JSON.parse(fs.readFileSync(file));
  console.log(args.at(-1).includes('.State.Running') ? String(container.running) : container.identity);
} else if (args[0] === 'create') {
  if (!args.includes('--pull=never')) die();
  const name = args[args.indexOf('--name')+1], image = args[args.indexOf('--allow-insecure-entitlement')-1];
  fs.writeFileSync(path.join(base,'container-'+name), JSON.stringify({running:false,identity:name+'|'+image+'|host|true'}));
} else if (args[0] === 'start') {
  if (e.MX_TEST_START_FAIL === '1') die();
  const file = path.join(base,'container-'+args[1]), container = JSON.parse(fs.readFileSync(file));
  container.running = true; fs.writeFileSync(file,JSON.stringify(container));
} else if (action === 'image inspect') {
  if (args.at(-1).includes('.Id')) { console.log('sha256:${imageId}'); process.exit(); }
  const canonical = s => s.replace(/^docker\\.io\\//,'').replace(/^library\\//,'');
  const missing = JSON.parse(e.MX_TEST_MISSING_IMAGES || '[]').map(canonical);
  const loadedFile = path.join(base,'loaded.json');
  const loaded = fs.existsSync(loadedFile) ? JSON.parse(fs.readFileSync(loadedFile)) : [];
  if (missing.includes(canonical(args[2])) && !loaded.includes(canonical(args[2]))) process.exit(1);
} else if (args[0] === 'load') {
  const image = JSON.parse(fs.readFileSync(args[args.indexOf('--input')+1])).image.replace(/^docker\\.io\\//,'').replace(/^library\\//,'');
  fs.writeFileSync(path.join(base,'loaded.json'),JSON.stringify([image]));
} else if (action === 'image save') fs.writeFileSync(args[args.indexOf('-o')+1], 'test archive');
else if (['pull','system','volume','restart','stop','rm'].includes(args[0])) die();
`;
  for (const tool of ['docker', 'ctr', 'kubectl', 'uname', 'id', 'hostname', 'node', 'sudo']) {
    writeFileSync(join(dir, 'bin', tool), fake);
    chmodSync(join(dir, 'bin', tool), 0o755);
  }
  return {
    dir,
    run(body = 'load_env\nbuild_local_image host\ndocker test-after', env = {}) {
      const inherited = { ...process.env };
      for (const name of ['PROXY', 'MX_RIG_BUILD_PROXY', 'MX_RIG_BUILD_NO_PROXY', 'MX_RIG_BUILDKIT_IMAGE', 'MX_RIG_IMAGE']) delete inherited[name];
      return spawnSync('bash', ['-c', `set -Eeuo pipefail
source "$MX_MANAGE_SCRIPT"
cd "$MX_TEST_DIR"
${body}`], { encoding: 'utf8', timeout: 15000, env: {
        ...inherited, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, TMPDIR: join(dir, 'tmp'),
        MX_TEST_DIR: dir, MX_TEST_LOG: log, MX_MANAGE_SCRIPT: manageScript,
        MX_RIG_MANAGE_SOURCE_ONLY: '1', MX_RIG_ENV_FILE: join(dir, '.env'),
        HTTP_PROXY: 'http://old.proxy:1000', HTTPS_PROXY: 'http://old.proxy:1000', ALL_PROXY: 'socks5://old.proxy:2000',
        http_proxy: 'http://old.proxy:3000', https_proxy: 'http://old.proxy:3000', all_proxy: 'socks5://old.proxy:4000',
        NO_PROXY: '*', no_proxy: '*', DOCKER_HOST: '', DOCKER_CONTEXT: '', ...env
      } });
    },
    calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [],
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

function checkProxy(call, expected = proxy) {
  assert.ok(call);
  for (const key of proxyKeys.filter(key => !/no_proxy/i.test(key))) assert.equal(call.env[key], expected, `${call.tool}: ${key}`);
  for (const entry of ['127.0.0.1', '10.0.0.0/8', '.svc', '.cluster.local']) assert.ok(call.env.NO_PROXY.includes(entry), entry);
  assert.equal(call.env.NO_PROXY, call.env.no_proxy);
  assert.notEqual(call.env.NO_PROXY, '*', 'an inherited wildcard must not disable the selected proxy');
}

test('no proxy preserves docker build, content-addressed tagging and containerd import', () => {
  const f = fixture();
  try {
    const result = f.run('load_env\nresolve_image\ndocker test-after');
    assert.equal(result.status, 0, result.stderr);
    const calls = f.calls(), build = calls.find(c => c.tool === 'docker' && c.args[0] === 'build');
    assert.ok(build.args.includes('--network') && build.args.includes('host'));
    assert.ok(build.args.at(-1).endsWith('/electron-dock'));
    assert.equal(calls.find(c => c.args[0] === 'tag').args.at(-1), `mx-rig.local/mx-rig-server:local-sha256-${imageId}`);
    const imported = calls.find(c => c.tool === 'ctr' && c.args.includes('import'));
    assert.ok(imported.args.includes('k8s.io'));
    assert.ok(!calls.some(c => c.args[0] === 'buildx' || c.args[0] === 'create'));
    assert.ok(calls.every(c => c.env.HTTP_PROXY === 'http://old.proxy:1000'));
    assert.deepEqual(readdirSync(join(f.dir, 'tmp')), []);
  } finally { f.cleanup(); }
});

test('PROXY alias reaches the registry daemon, build client and RUN while preserving caller environment', () => {
  const f = fixture();
  try {
    const result = f.run(undefined, { PROXY: proxy });
    assert.equal(result.status, 0, result.stderr);
    const calls = f.calls(), container = calls.find(c => c.args[0] === 'create');
    checkProxy(container);
    const name = container.args[container.args.indexOf('--name') + 1];
    assert.match(name, /^mx-rig-proxy-/);
    assert.equal(container.args[container.args.indexOf('--network') + 1], 'host');
    for (const flag of ['--pull=never', '--privileged', '--volume']) assert.ok(container.args.includes(flag), flag);
    assert.ok(!container.args.includes('-p') && !container.args.includes('--publish'));
    for (const key of proxyKeys) assert.ok(container.args.some((arg, i) => arg === '--env' && container.args[i + 1] === key), key);
    const builder = calls.find(c => c.args[0] === 'buildx' && c.args[1] === 'create');
    assert.equal(builder.args[builder.args.indexOf('--driver') + 1], 'remote');
    assert.equal(builder.args.at(-1), `docker-container://${name}`);
    assert.ok(!builder.args.includes('--use'));
    const build = calls.find(c => c.args[0] === 'buildx' && c.args[1] === 'build');
    checkProxy(build);
    for (const flag of ['--load', '--builder', '--allow', 'network.host']) assert.ok(build.args.includes(flag), flag);
    assert.equal(build.args[build.args.indexOf('--network') + 1], 'host');
    for (const key of proxyKeys) assert.ok(build.args.some((arg, i) => arg === '--build-arg' && build.args[i + 1] === key), key);
    assert.ok(!calls.some(c => c.args.some(arg => arg.includes(proxy) || arg.includes('host-gateway'))));
    assert.ok(!calls.some(c => c.tool === 'ctr' || c.tool === 'node'), 'cached BuildKit needs neither containerd bootstrap nor Node');
    assert.equal(calls.at(-1).env.HTTP_PROXY, 'http://old.proxy:1000');
    assert.equal(calls.at(-1).env.NO_PROXY, '*');
    assert.doesNotMatch(readFileSync(new URL('../deploy/Dockerfile', import.meta.url), 'utf8'), /^(?:ENV|ARG)\s+(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)\b/im);
  } finally { f.cleanup(); }
});

test('shell proxy settings override .env and an explicitly empty shell setting disables the proxy', () => {
  const cases = [
    ['PROXY=http://file-alias:1000\n', {}, 'http://file-alias:1000'],
    ['PROXY=http://file-alias:1000\nMX_RIG_BUILD_PROXY=http://file-rig:1000\n', {}, 'http://file-rig:1000'],
    ['MX_RIG_BUILD_PROXY=http://file-rig:1000\n', { PROXY: proxy }, proxy],
    ['MX_RIG_BUILD_PROXY=http://file-rig:1000\n', { PROXY: proxy, MX_RIG_BUILD_PROXY: 'http://shell-rig:1000' }, 'http://shell-rig:1000'],
    ['MX_RIG_BUILD_PROXY=http://file-rig:1000\n', { PROXY: '' }, ''],
    ['PROXY=http://file-alias:1000\n', { PROXY: proxy, MX_RIG_BUILD_PROXY: '' }, '']
  ];
  for (const [contents, env, expected] of cases) {
    const f = fixture();
    try {
      writeFileSync(join(f.dir, '.env'), contents);
      const result = f.run('load_env\nprintf "%s" "$MX_RIG_BUILD_PROXY"', env);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, expected);
      assert.deepEqual(f.calls(), []);
    } finally { f.cleanup(); }
  }
});

test('uncached BuildKit uses scoped ctr pulls for containerd 1.x and 2.x before docker load', () => {
  for (const version of ['0', '1']) {
    const f = fixture();
    try {
      const result = f.run(undefined, { PROXY: proxy, MX_TEST_CTR2: version, MX_TEST_MISSING_IMAGES: '["moby/buildkit:buildx-stable-1"]' });
      assert.equal(result.status, 0, result.stderr);
      const calls = f.calls(), pull = calls.find(c => c.tool === 'ctr' && c.args.includes('pull') && !c.args.includes('--help'));
      checkProxy(pull);
      assert.equal(pull.args.includes('--local'), version === '1');
      for (const arg of ['mx-rig-build-proxy', 'linux/amd64', 'docker.io/moby/buildkit:buildx-stable-1']) assert.ok(pull.args.includes(arg), arg);
      assert.ok(!pull.args.includes('k8s.io'));
      const load = calls.findIndex(c => c.args[0] === 'load'), create = calls.findIndex(c => c.args[0] === 'create');
      assert.ok(load >= 0 && create > load);
      assert.ok(!calls.some(c => c.tool === 'docker' && c.args[0] === 'pull'));
      assert.deepEqual(readdirSync(join(f.dir, 'tmp')), []);
    } finally { f.cleanup(); }
  }
});

test('identical proxy settings reuse the builder and changed proxy or BuildKit image gets a separate cache', () => {
  const f = fixture();
  try {
    const result = f.run(`load_env
build_local_image host
build_local_image host
MX_RIG_BUILD_PROXY=http://127.0.0.1:8899 build_local_image host
MX_RIG_BUILDKIT_IMAGE=registry.example/buildkit:pinned build_local_image host`, { PROXY: proxy });
    assert.equal(result.status, 0, result.stderr);
    const calls = f.calls(), containers = calls.filter(c => c.args[0] === 'create');
    assert.equal(containers.length, 3);
    assert.equal(new Set(containers.map(c => c.args[c.args.indexOf('--name') + 1])).size, 3);
    assert.equal(new Set(containers.map(c => c.args[c.args.indexOf('--volume') + 1])).size, 3);
    assert.equal(calls.filter(c => c.args[0] === 'start').length, 3, 'a running builder must not restart');
    assert.equal(calls.filter(c => c.args[0] === 'buildx' && c.args[1] === 'create').length, 3);
    assert.equal(containers[1].env.HTTP_PROXY, 'http://127.0.0.1:8899');
    assert.ok(containers[2].args.includes('registry.example/buildkit:pinned'));
    assert.ok(!calls.some(c => c.tool === 'docker' && ['stop', 'restart', 'rm', 'system', 'volume'].includes(c.args[0])));
  } finally { f.cleanup(); }
});

test('failed bootstrap, start or readiness stops the build, cleans temporary files and leaves caller environment intact', () => {
  for (const env of [
    { MX_TEST_PULL_FAIL: '1', MX_TEST_MISSING_IMAGES: '["moby/buildkit:buildx-stable-1"]' },
    { MX_TEST_START_FAIL: '1' }, { MX_TEST_BOOT_FAIL: '1' }
  ]) {
    const f = fixture();
    try {
      const result = f.run(`set +e
(set -e; load_env; build_local_image host)
status=$?
docker test-after
exit "$status"`, { PROXY: proxy, ...env });
      assert.notEqual(result.status, 0);
      const calls = f.calls();
      assert.ok(!calls.some(c => c.args[0] === 'build' || c.args[1] === 'build' || c.args[0] === 'tag'));
      assert.equal(calls.at(-1).env.HTTP_PROXY, 'http://old.proxy:1000');
      assert.equal(calls.at(-1).env.NO_PROXY, '*');
      assert.deepEqual(readdirSync(join(f.dir, 'tmp')), []);
    } finally { f.cleanup(); }
  }
});

test('proxy validation rejects invalid URLs and keeps credentials out of logs and process arguments', () => {
  for (const invalid of ['socks5://user:PRIVATE@127.0.0.1:7788', 'http://user:PRIVATE,raw@127.0.0.1:7788', 'http://127.0.0.1:7788/PRIVATE', 'not-a-url-PRIVATE']) {
    const f = fixture();
    try {
      const result = f.run(undefined, { PROXY: invalid });
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE/);
      assert.ok(!f.calls().some(c => c.tool === 'docker' || c.tool === 'ctr'));
    } finally { f.cleanup(); }
  }
  const f = fixture();
  try {
    const result = f.run(undefined, { PROXY: 'http://user:PRIVATE@127.0.0.1:7788' });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE/);
    assert.ok(!f.calls().some(c => c.args.some(arg => arg.includes('PRIVATE'))));
    assert.ok(f.calls().some(c => c.args[1] === 'build'));
  } finally { f.cleanup(); }
});

test('remote Docker endpoints are rejected and an explicit bypass list is confined to the local build', () => {
  const remote = fixture(), local = fixture();
  try {
    const rejected = remote.run(undefined, { PROXY: proxy, MX_TEST_DOCKER_ENDPOINT: 'ssh://other-host' });
    assert.notEqual(rejected.status, 0);
    assert.ok(!remote.calls().some(c => c.args[0] === 'buildx' || c.args[0] === 'create' || c.tool === 'ctr'));
    const bypass = 'localhost,127.0.0.1,.corp.example';
    const result = local.run(undefined, { PROXY: proxy, MX_RIG_BUILD_NO_PROXY: bypass });
    assert.equal(result.status, 0, result.stderr);
    for (const call of local.calls().filter(c => c.args[0] === 'create' || c.args[1] === 'build')) {
      assert.equal(call.env.NO_PROXY, bypass);
      assert.equal(call.env.no_proxy, bypass);
    }
    assert.equal(local.calls().at(-1).env.NO_PROXY, '*');
  } finally { remote.cleanup(); local.cleanup(); }
});

test('PostgreSQL preload uses the manifest image and skips a cached image without changing namespaces', () => {
  for (const cached of ['0', '1']) {
    const f = fixture();
    try {
      const result = f.run('load_env\nrig_with_build_proxy rig_proxy_postgres_image\ndocker test-after', {
        PROXY: proxy, MX_TEST_PG_CACHED: cached, MX_TEST_CTR2: '1'
      });
      assert.equal(result.status, 0, result.stderr);
      const calls = f.calls(), pulls = calls.filter(c => c.tool === 'ctr' && c.args.includes('pull') && !c.args.includes('--help'));
      assert.equal(pulls.length, cached === '1' ? 0 : 1);
      if (pulls.length) {
        checkProxy(pulls[0]);
        for (const arg of ['k8s.io', '--local', 'linux/amd64', 'docker.io/library/postgres:17-alpine']) assert.ok(pulls[0].args.includes(arg), arg);
      }
      assert.ok(calls.filter(c => c.tool === 'ctr').every(c => c.args.includes('k8s.io')));
      assert.ok(!calls.some(c => c.args[0] === 'buildx' || c.args[0] === 'create'));
      assert.equal(calls.at(-1).env.HTTP_PROXY, 'http://old.proxy:1000');
    } finally { f.cleanup(); }
  }
});

test('non-root ctr calls preserve the scoped proxy through noninteractive sudo', () => {
  const f = fixture();
  try {
    const result = f.run('load_env\nrig_with_build_proxy rig_proxy_postgres_image\ndocker test-after', {
      PROXY: proxy, MX_TEST_UID: '1000', MX_TEST_CTR2: '1'
    });
    assert.equal(result.status, 0, result.stderr);
    const calls = f.calls(), sudoCalls = calls.filter(c => c.tool === 'sudo');
    assert.ok(sudoCalls.length > 0);
    for (const call of sudoCalls) {
      checkProxy(call);
      assert.equal(call.args[0], '-n');
      const names = call.args.find(arg => arg.startsWith('--preserve-env=')).slice('--preserve-env='.length).split(',');
      assert.deepEqual([...names].sort(), [...proxyKeys].sort());
      assert.ok(call.args.includes('ctr'));
    }
    checkProxy(calls.find(c => c.tool === 'ctr' && c.args.includes('pull') && !c.args.includes('--help')));
    assert.equal(calls.at(-1).env.HTTP_PROXY, 'http://old.proxy:1000');
  } finally { f.cleanup(); }
});
