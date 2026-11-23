const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { after, test } = require('node:test');

const packageRoot = resolve(__dirname, '..');
const cli = resolve(packageRoot, 'dist/index.js');
const edgeDir = resolve(packageRoot, 'resources/edge');
const remoteScript = join(edgeDir, 'remote.sh');
const osLib = join(edgeDir, 'lib/edge-os.sh');
const testRoot = mkdtempSync(join(tmpdir(), 'qp-edge-test-'));

after(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

// A stand-in for ssh: logs its argv, then either runs the remote command
// locally (FAKE_SSH_EXEC=1) or swallows stdin and exits with FAKE_SSH_STATUS.
const fakeSsh = join(testRoot, 'fake-ssh');
writeFileSync(fakeSsh, `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(args) + '\\n');
const withValue = new Set(['-p', '-o', '-i', '-W', '-J', '-l']);
let index = 0;
while (index < args.length && args[index].startsWith('-')) index += withValue.has(args[index]) ? 2 : 1;
let command = args.slice(index + 1).join(' ');
// FAKE_SSH_ROOTS={"user@host": dir} with FAKE_SSH_ROOT_FROM=<--root>: each host gets its own /opt/mx.
if (process.env.FAKE_SSH_ROOTS) {
  const dir = JSON.parse(process.env.FAKE_SSH_ROOTS)[args[index]];
  if (dir) command = command.split(process.env.FAKE_SSH_ROOT_FROM).join(dir);
}
if (process.env.FAKE_SSH_EXEC === '1') {
  const result = spawnSync('sh', ['-c', command], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
let input = Buffer.alloc(0);
try { input = readFileSync(0); } catch {}
// FAKE_SSH_CAPTURE=<dir> keeps what each upload sent, to inspect bundles.
if (process.env.FAKE_SSH_CAPTURE && command.includes('cat >')) {
  writeFileSync(process.env.FAKE_SSH_CAPTURE + '/upload-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.tgz', input);
}
process.exit(Number(process.env.FAKE_SSH_STATUS || 0));
`);
chmodSync(fakeSsh, 0o755);

let caseCounter = 0;
function newCase() {
  caseCounter += 1;
  const dir = join(testRoot, `case-${caseCounter}`);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    hostsFile: join(dir, 'hosts.json'),
    home: join(dir, 'edge-home'),
    log: join(dir, 'ssh.log'),
    root: join(dir, 'opt-mx'),
  };
}

function run(c, args, extraEnv = {}, input) {
  return spawnSync(process.execPath, [cli, 'edge', ...args], {
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      QP_EDGE_HOSTS_FILE: c.hostsFile,
      QP_EDGE_HOME: c.home,
      QP_EDGE_ORIGIN: 'internal-a',
      QP_EDGE_SSH_BIN: fakeSsh,
      FAKE_SSH_LOG: c.log,
      ...extraEnv,
    },
  });
}

function ok(result) {
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result.stdout;
}

function sshCalls(c) {
  if (!existsSync(c.log)) return [];
  return readFileSync(c.log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function makeBundle(dir, { failDeploy = false } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'compose.yml'), 'services: {}\n');
  writeFileSync(join(dir, 'deploy.sh'), failDeploy
    ? 'echo deploy-broken >&2; exit 3\n'
    : 'printf "%s\\n" "$MX_REVISION" > "$MX_STATE_DIR/deployed"\nprintf "%s\\n" "$MX_PREVIOUS_RELEASE" > "$MX_STATE_DIR/previous"\n');
  writeFileSync(join(dir, 'health.sh'), 'test -f "$MX_STATE_DIR/deployed"\n');
  return dir;
}

function shellFiles(dir) {
  const { readdirSync } = require('node:fs');
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'vendor' ? [] : shellFiles(path);
    return entry.name.endsWith('.sh') ? [path] : [];
  });
}

test('every edge shell file parses with bash', () => {
  const files = shellFiles(edgeDir);
  assert.ok(files.includes(remoteScript) && files.includes(osLib));
  assert.ok(files.length >= 9, files.join('\n'));
  for (const file of files) {
    const result = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}\n${result.stderr}`);
  }
});

test('os-release maps to the debian or rhel family', () => {
  const cases = [
    ['ID=ubuntu\nID_LIKE=debian\nVERSION_ID="26.04"\nPRETTY_NAME="Ubuntu 26.04 LTS"\n', 'debian 26 Ubuntu 26.04 LTS'],
    ['ID=debian\nVERSION_ID="12"\n', 'debian 12'],
    ['ID="centos"\nID_LIKE="rhel fedora"\nVERSION_ID="7"\n', 'rhel 7'],
    ['NAME="CentOS Stream"\nID="centos"\nID_LIKE="rhel fedora"\nVERSION_ID="9"', 'rhel 9'],
    ['ID="rocky"\nID_LIKE="rhel centos fedora"\nVERSION_ID="9.4"\n', 'rhel 9'],
    ['ID=alpine\nVERSION_ID=3.20.0\n', 'unknown 3'],
  ];
  for (const [content, expected] of cases) {
    const file = join(testRoot, `os-release-${Math.random().toString(16).slice(2)}`);
    writeFileSync(file, content);
    const result = spawnSync('bash', ['-c', `. "${osLib}"; edge_os_detect; printf '%s %s' "$EDGE_OS_FAMILY" "$EDGE_OS_MAJOR"; case "$EDGE_OS_PRETTY" in Ubuntu*) printf ' %s' "$EDGE_OS_PRETTY";; esac`], {
      encoding: 'utf8',
      env: { ...process.env, EDGE_OS_RELEASE_FILE: file },
    });
    assert.equal(result.stdout, expected, content);
  }
});

test('hosts file: add, update, list, json, remove, private permissions', () => {
  const c = newCase();
  ok(run(c, ['add', 'bastion', '--host', '198.51.100.5', '--role', 'jump']));
  ok(run(c, ['add', 'domestic-1', '--host', '203.0.113.10', '--port', '2222', '--jump', 'bastion', '--role', 'domestic', '--note', 'main relay']));
  ok(run(c, ['add', 'domestic-1', '--user', 'ops']));

  const saved = JSON.parse(readFileSync(c.hostsFile, 'utf8'));
  assert.deepEqual(saved.hosts['domestic-1'], {
    host: '203.0.113.10', user: 'ops', port: 2222, jump: 'bastion', role: 'domestic', note: 'main relay', source: 'manual',
  });
  if (process.platform !== 'win32') assert.equal(statSync(c.hostsFile).mode & 0o777, 0o600);

  const table = ok(run(c, ['hosts']));
  assert.match(table, /domestic-1\s+domestic\s+ops@203\.0\.113\.10:2222\s+via bastion/);
  assert.deepEqual(Object.keys(JSON.parse(ok(run(c, ['hosts', '--role', 'domestic', '--json'])))), ['domestic-1']);

  const refused = run(c, ['remove', 'bastion']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /jump host of domestic-1/);
  ok(run(c, ['remove', 'domestic-1']));
  ok(run(c, ['remove', 'bastion']));
  assert.deepEqual(JSON.parse(readFileSync(c.hostsFile, 'utf8')).hosts, {});
});

test('rejects names that could escape the layout', () => {
  const c = newCase();
  const result = run(c, ['add', '../etc', '--host', '203.0.113.10']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /invalid name/);
});

test('ssh arguments route through a saved jump host with its own key', () => {
  const c = newCase();
  ok(run(c, ['add', 'bastion', '--host', '198.51.100.5', '--user', 'jump', '--key', '/keys/bastion key']));
  ok(run(c, ['add', 'domestic-1', '--host', '203.0.113.10', '--key', '/keys/domestic', '--jump', 'bastion']));
  ok(run(c, ['ssh', 'domestic-1', '--', 'uptime && wg show'], { FAKE_SSH_STATUS: '0' }));

  const [args] = sshCalls(c);
  assert.equal(args.at(-2), 'root@203.0.113.10');
  assert.equal(args.at(-1), 'uptime && wg show', 'the command reaches the remote shell as typed, like ssh');
  assert.ok(args.includes('BatchMode=yes'));
  const proxy = args.find((arg) => arg.startsWith('ProxyCommand='));
  assert.match(proxy, /^ProxyCommand=ssh /);
  assert.match(proxy, /-i '\/keys\/bastion key'/);
  assert.match(proxy, /-W %h:%p jump@198\.51\.100\.5$/);

  // The ProxyCommand must survive /bin/sh word splitting the way ssh runs it.
  const words = spawnSync('sh', ['-c', `set -- ${proxy.slice('ProxyCommand='.length)}; for w; do printf '%s\\n' "$w"; done`], { encoding: 'utf8' });
  assert.ok(words.stdout.split('\n').includes('/keys/bastion key'));
});

test('a jump host loop is refused', () => {
  const c = newCase();
  ok(run(c, ['add', 'a', '--host', '198.51.100.1']));
  ok(run(c, ['add', 'b', '--host', '198.51.100.2', '--jump', 'a']));
  ok(run(c, ['add', 'a', '--jump', 'b']));
  const result = run(c, ['ssh-args', 'a']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /jump host loop/);
});

test('without a host name and without a terminal, lists the saved hosts', () => {
  const c = newCase();
  ok(run(c, ['add', 'domestic-1', '--host', '203.0.113.10']));
  const result = run(c, ['check']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no host given\. Saved hosts: domestic-1/);
  assert.equal(sshCalls(c).length, 0);
});

test('known hosts file is passed to the host and to its jump host', () => {
  const c = newCase();
  ok(run(c, ['add', 'bastion', '--host', '198.51.100.5', '--known-hosts', '/kh/edge']));
  ok(run(c, ['add', 'domestic-1', '--host', '203.0.113.10', '--known-hosts', '/kh/edge', '--jump', 'bastion']));
  const line = ok(run(c, ['ssh-args', 'domestic-1']));
  assert.equal((line.match(/UserKnownHostsFile=\/kh\/edge/g) || []).length, 2);
});

test('exit 255 from a user command is not called unreachable', () => {
  const c = newCase();
  ok(run(c, ['add', 'domestic-1', '--host', '203.0.113.10']));
  const result = run(c, ['ssh', 'domestic-1', '--', 'false'], { FAKE_SSH_STATUS: '255' });
  assert.equal(result.status, 255);
  assert.match(result.stderr, /or the command itself returned 255/);
});

test('unreachable host is reported as UNREACHABLE', () => {
  const c = newCase();
  ok(run(c, ['add', 'domestic-1', '--host', '203.0.113.10']));
  const result = run(c, ['check', 'domestic-1'], { FAKE_SSH_STATUS: '255' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /UNREACHABLE/);
});

test('check runs the read-only report on the host', () => {
  const c = newCase();
  ok(run(c, ['add', 'domestic-1', '--host', '203.0.113.10']));
  const out = ok(run(c, ['check', 'domestic-1', '--root', c.root], { FAKE_SSH_EXEC: '1' }));
  assert.match(out, /== host/);
  assert.match(out, /cpus=/);
  assert.match(out, /== wireguard/);
  assert.ok(!existsSync(c.root), 'check must not create anything on the host');
  const [args] = sshCalls(c);
  assert.ok(!args.at(-1).startsWith('sudo'), 'check does not ask for sudo up front');
});

test('push dry run prints the plan and connects nowhere', () => {
  const c = newCase();
  ok(run(c, ['add', 'domestic-1', '--host', '203.0.113.10', '--user', 'ops']));
  const bundle = makeBundle(join(c.dir, 'domestic'));
  const out = ok(run(c, ['push', 'domestic-1', '--bundle', bundle, '--revision', 'r1', '--dry-run']));
  assert.match(out, /component\s+domestic/);
  assert.match(out, /hooks\s+deploy\.sh, then health\.sh/);
  assert.match(out, /sudo -n sh -c/);
  assert.match(out, /Dry run: nothing was uploaded/);
  assert.equal(sshCalls(c).length, 0);
});

test('push needs --yes outside a terminal', () => {
  const c = newCase();
  ok(run(c, ['add', 'domestic-1', '--host', '203.0.113.10']));
  const result = run(c, ['push', 'domestic-1', '--bundle', makeBundle(join(c.dir, 'domestic'))]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /pass --yes/);
  assert.equal(sshCalls(c).length, 0);
});

test('push, push again, refuse a reused revision, roll back', () => {
  const c = newCase();
  ok(run(c, ['add', 'domestic-1', '--host', '203.0.113.10']));
  const bundle = makeBundle(join(c.dir, 'domestic'));
  const env = { FAKE_SSH_EXEC: '1' };
  const current = join(c.root, 'current/domestic');
  const state = join(c.root, 'state/domestic');

  const first = ok(run(c, ['push', 'domestic-1', '--bundle', bundle, '--revision', 'r1', '--root', c.root, '--yes'], env));
  assert.match(first, /activated domestic r1/);
  assert.equal(readlinkSync(current), join(c.root, 'releases/domestic/r1'));
  assert.equal(readFileSync(join(state, 'deployed'), 'utf8').trim(), 'r1');
  assert.equal(readlinkSync(join(c.root, 'releases/domestic/r1/state')), state);
  assert.ok(existsSync(join(c.root, 'releases/domestic/r1/compose.yml')));
  assert.ok(!existsSync(join(c.root, 'incoming/domestic-r1.tar.gz')), 'upload is removed after extraction');

  ok(run(c, ['push', 'domestic-1', '--bundle', bundle, '--revision', 'r2', '--root', c.root, '--yes'], env));
  assert.equal(readlinkSync(current), join(c.root, 'releases/domestic/r2'));
  assert.equal(readFileSync(join(state, 'previous'), 'utf8').trim(), join(c.root, 'releases/domestic/r1'));

  const reused = run(c, ['push', 'domestic-1', '--bundle', bundle, '--revision', 'r1', '--root', c.root, '--yes'], env);
  assert.equal(reused.status, 1);
  assert.match(reused.stderr, /already exists/);
  assert.equal(readlinkSync(current), join(c.root, 'releases/domestic/r2'));

  const back = ok(run(c, ['rollback', 'domestic-1', '--component', 'domestic', '--root', c.root, '--yes'], env));
  assert.match(back, /rolled back domestic to r1/);
  assert.equal(readlinkSync(current), join(c.root, 'releases/domestic/r1'));
  assert.equal(readFileSync(join(state, 'deployed'), 'utf8').trim(), 'r1');
  assert.ok(existsSync(join(c.root, 'releases/domestic/r2')), 'rollback keeps the newer release');

  const listing = ok(run(c, ['releases', 'domestic-1', '--root', c.root], env));
  assert.match(listing, /\* r1/);
  assert.match(listing, /^ {4}r2$/m);
});

test('a failing deploy.sh stops the run before the next host', () => {
  const c = newCase();
  ok(run(c, ['add', 'domestic-1', '--host', '203.0.113.10']));
  ok(run(c, ['add', 'domestic-2', '--host', '203.0.113.11']));
  const bundle = makeBundle(join(c.dir, 'domestic'), { failDeploy: true });
  const result = run(c, ['push', 'domestic-1,domestic-2', '--bundle', bundle, '--revision', 'r1', '--root', c.root, '--yes'], { FAKE_SSH_EXEC: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /deploy\.sh failed; current already points at r1\. roll back with/);
  assert.match(result.stderr, /domestic-1: activation failed; hosts after it were not touched/);
  assert.ok(sshCalls(c).every((args) => !args.includes('root@203.0.113.11')));
});

test('import copies Launcher SSH profiles with one GET and keeps local keys', async () => {
  const c = newCase();
  ok(run(c, ['add', 'domestic-main', '--host', '203.0.113.10', '--key', '/keys/domestic']));
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, token: req.headers['x-mx-ops-token'] });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      profiles: [
        { profileId: 'sshprof_domestic-main', siteId: 'domestic-main', kind: 'domestic', host: '203.0.113.20', sshUser: 'root', sshPort: 22, identityFile: '/app/artifacts/ssh/domestic-main', status: 'active' },
        { profileId: 'sshprof_mx-oversea-us01', siteId: 'mx-oversea-us01', kind: 'oversea', host: '34.218.136.162', sshUser: 'ubuntu', sshPort: 22, identityFile: '/app/artifacts/ssh/us01', status: 'paused' },
        { profileId: 'sshprof_empty', siteId: 'empty', kind: 'domestic', host: null },
      ],
    }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  try {
    const result = await new Promise((done) => {
      const child = require('node:child_process').spawn(process.execPath, [cli, 'edge', 'import', '--launcher-url', `http://127.0.0.1:${port}/`, '--token', 'ops-secret'], {
        env: { ...process.env, QP_EDGE_HOSTS_FILE: c.hostsFile },
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('close', (status) => done({ status, stdout }));
    });
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /Imported 2 of 3/);
    assert.match(result.stdout, /skip sshprof_empty/);
  } finally {
    server.close();
  }
  assert.deepEqual(seen, [{ method: 'GET', url: '/internal/v1/config-center/site-slot-ssh-profiles', token: 'ops-secret' }]);
  const hosts = JSON.parse(readFileSync(c.hostsFile, 'utf8')).hosts;
  assert.equal(hosts['domestic-main'].host, '203.0.113.20');
  assert.equal(hosts['domestic-main'].key, '/keys/domestic', 'a local key survives the import');
  assert.equal(hosts['mx-oversea-us01'].user, 'ubuntu');
  assert.equal(hosts['mx-oversea-us01'].role, 'oversea');
  assert.equal(hosts['mx-oversea-us01'].note, 'paused in Launcher');
  assert.equal(hosts['mx-oversea-us01'].launcherIdentityFile, '/app/artifacts/ssh/us01');
});

// ---------- stacks, preflight, state, status ----------

const ubuntuRelease = 'ID=ubuntu\nID_LIKE=debian\nVERSION_ID="26.04"\nPRETTY_NAME="Ubuntu 26.04 LTS"\n';

function osRelease(c, content) {
  const file = join(c.dir, 'os-release');
  writeFileSync(file, content);
  return file;
}

// A bundle with a manifest but no systemd requirement, so it can run on the test machine.
function makeStackBundle(dir, { os = 'debian rhel', required = 'app.env' } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stack.env'), `STACK_NAME=demo\nSTACK_OS="${os}"\nSTACK_STATE_REQUIRED="${required}"\n`);
  writeFileSync(join(dir, 'deploy.sh'), '. ./lib/edge-os.sh\nedge_os_detect\nprintf "%s %s\\n" "$EDGE_OS_FAMILY" "$(cat "$MX_STATE_DIR/app.env")" > "$MX_STATE_DIR/deployed"\n');
  return dir;
}

test('stacks: list, details, state template that never overwrites', () => {
  const c = newCase();
  const list = ok(run(c, ['stacks']));
  for (const name of ['hy2-mihomo', 'open-nginx', 'wg-nginx']) assert.match(list, new RegExp(`^${name}\\s+debian rhel`, 'm'));
  const detail = ok(run(c, ['stacks', 'hy2-mihomo']));
  assert.match(detail, /docker\/hysteria2-mihomo-stack\/manage\.sh/);
  assert.doesNotMatch(detail, /MISSING/);

  const dir = join(c.dir, 'hy2-state');
  assert.match(ok(run(c, ['stacks', 'hy2-mihomo', '--init', dir])), /written\s+hy2\.env/);
  assert.match(readFileSync(join(dir, 'hy2.env'), 'utf8'), /HY2_EXPORT_PASSWORD_HASH=REPLACE_WITH_CADDY_HASH/);
  assert.equal(statSync(join(dir, 'hy2.env')).mode & 0o777, 0o600);
  writeFileSync(join(dir, 'hy2.env'), 'edited\n');
  assert.match(ok(run(c, ['stacks', 'hy2-mihomo', '--init', dir])), /kept\s+hy2\.env/);
  assert.equal(readFileSync(join(dir, 'hy2.env'), 'utf8'), 'edited\n');

  const wg = join(c.dir, 'wg-state');
  ok(run(c, ['stacks', 'wg-nginx', '--init', wg]));
  assert.ok(existsSync(join(wg, 'edge.env')));
  assert.ok(existsSync(join(wg, 'nginx/app.example.com.conf.example')), 'the example site is not *.conf, so it is never applied by accident');
});

test('push --stack dry run shows OS, ports, state and images, and connects nowhere', () => {
  const c = newCase();
  ok(run(c, ['add', 'domestic-2', '--host', '203.0.113.20', '--user', 'ops']));
  const state = join(c.dir, 'wg-state');
  mkdirSync(join(state, 'nginx'), { recursive: true });
  writeFileSync(join(state, 'edge.env'), 'EDGE_HEALTH_URL=\n');
  writeFileSync(join(state, 'nginx/site.conf'), 'server {}\n');
  const out = ok(run(c, ['push', 'domestic-2', '--stack', 'wg-nginx', '--state-dir', state, '--revision', 'r1', '--dry-run']));
  assert.match(out, /source\s+stack wg-nginx/);
  assert.match(out, /component\s+wg-nginx/);
  assert.match(out, /os\s+debian rhel, systemd \(checked on the host before the switch\)/);
  assert.match(out, /ports\s+51820\/udp 80\/tcp 443\/tcp/);
  assert.match(out, /state\s+2 file\(s\) from .*: edge\.env, nginx\/site\.conf/);
  assert.match(out, /needs wg\/relay\.conf, wg\/relay\.env in state\/wg-nginx/);
  assert.match(out, /edge link init domestic-2 \(asks for the subnet/, 'the plan says where the tunnel files come from');
  assert.match(out, /sudo -n sh -c .*state\.tar\.gz/);
  assert.equal(sshCalls(c).length, 0);

  const hy2 = ok(run(c, ['push', 'domestic-2', '--stack', 'hy2-mihomo', '--dry-run']));
  assert.match(hy2, /needs hy2\.env in state\/hy2-mihomo on the host already/);
  assert.match(hy2, /the host pulls tobyxdd\/hysteria:v2\.14\.0 caddy:2\.11\.9-alpine itself/);
  assert.match(hy2, /origin\s+internal-a/);
  assert.equal(sshCalls(c).length, 0);
  assert.ok(!existsSync(c.home), 'a dry run creates no edge home');
});

test('a stack bundle carries its vendored files and the edge library, not its state template', () => {
  const c = newCase();
  ok(run(c, ['add', 'domestic-2', '--host', '203.0.113.20']));
  const capture = join(c.dir, 'capture');
  mkdirSync(capture);
  ok(run(c, ['push', 'domestic-2', '--stack', 'hy2-mihomo', '--revision', 'r1', '--root', c.root, '--yes'], { FAKE_SSH_CAPTURE: capture }));
  const uploads = require('node:fs').readdirSync(capture);
  assert.equal(uploads.length, 1);
  const files = spawnSync('tar', ['-tzf', join(capture, uploads[0])], { encoding: 'utf8' }).stdout.split('\n');
  for (const file of ['./deploy.sh', './health.sh', './stack.env', './lib/edge-os.sh', './lib/edge-nginx.sh',
    './vendor/docker/hysteria2-mihomo-stack/manage.sh', './vendor/docker/hysteria2-mihomo-stack/docker-compose.yml',
    './vendor/docker/hysteria2-mihomo-stack/Caddyfile', './vendor/scripts/export-hysteria2-mihomo-stack.sh',
    './vendor/scripts/export-hysteria2-mihomo.sh']) {
    assert.ok(files.includes(file), `${file} missing from\n${files.join('\n')}`);
  }
  assert.ok(!files.some((file) => file.includes('state.example')));
  assert.ok(!files.some((file) => /hysteria2-mihomo-stack\/(\.env$|data\/|config\/)/.test(file)), 'no .env, data or certificates travel in the bundle');
});

test('preflight refuses a host of the wrong OS family before switching anything', () => {
  const c = newCase();
  ok(run(c, ['add', 'domestic-2', '--host', '203.0.113.20']));
  const bundle = makeStackBundle(join(c.dir, 'demo'), { os: 'rhel' });
  const state = join(c.dir, 'state');
  mkdirSync(state);
  writeFileSync(join(state, 'app.env'), 'one\n');
  const env = { FAKE_SSH_EXEC: '1', EDGE_OS_RELEASE_FILE: osRelease(c, ubuntuRelease) };
  const args = ['push', 'domestic-2', '--bundle', bundle, '--state-dir', state, '--root', c.root, '--yes'];

  const refused = run(c, [...args, '--revision', 'r1'], env);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /stack demo supports OS families: rhel\. This host: Ubuntu 26\.04 LTS \(family=debian/);
  assert.match(refused.stderr, /preflight failed; nothing was written and current\/demo was not switched/);
  assert.ok(!existsSync(join(c.root, 'current/demo')));
  assert.ok(!existsSync(join(c.root, 'releases/demo/r1')));
  assert.ok(!existsSync(join(c.root, 'incoming/demo-r1.d')), 'the unpacked bundle is not left behind');
  assert.ok(!existsSync(join(c.root, 'state/demo/app.env')), 'a failed preflight writes no state');

  const forced = ok(run(c, [...args, '--revision', 'r2', '--force-os'], env));
  assert.match(forced, /continuing because of --force-os/);
  assert.equal(readFileSync(join(c.root, 'state/demo/deployed'), 'utf8').trim(), 'debian one');
  assert.ok(existsSync(join(c.root, 'releases/demo/r2/lib/edge-os.sh')), 'custom bundles get the edge library too');
});

test('missing state stops the push; pushed state is applied, replaced files are kept, rollback restores it', () => {
  const c = newCase();
  ok(run(c, ['add', 'domestic-2', '--host', '203.0.113.20']));
  const bundle = makeStackBundle(join(c.dir, 'demo'));
  const env = { FAKE_SSH_EXEC: '1', EDGE_OS_RELEASE_FILE: osRelease(c, ubuntuRelease) };
  const args = ['push', 'domestic-2', '--bundle', bundle, '--root', c.root, '--yes'];

  const refused = run(c, [...args, '--revision', 'r1'], env);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /state\/demo is missing: app\.env/);
  assert.ok(!existsSync(join(c.root, 'current/demo')));

  const state = join(c.dir, 'state');
  mkdirSync(join(state, 'certs'), { recursive: true });
  writeFileSync(join(state, 'app.env'), 'one\n');
  writeFileSync(join(state, 'certs/site.key'), 'k1\n');
  assert.match(ok(run(c, [...args, '--revision', 'r2', '--state-dir', state], env)), /state demo: 2 file\(s\) written/);
  const deployed = join(c.root, 'state/demo/deployed');
  assert.equal(readFileSync(deployed, 'utf8').trim(), 'debian one');
  assert.equal(statSync(join(c.root, 'state/demo/certs/site.key')).mode & 0o777, 0o600);

  writeFileSync(join(state, 'app.env'), 'two\n');
  assert.match(ok(run(c, [...args, '--revision', 'r3', '--state-dir', state], env)), /1 file\(s\) written, 1 replaced/);
  assert.equal(readFileSync(join(c.root, 'state/demo/.edge-replaced/r3/app.env'), 'utf8'), 'one\n');
  assert.equal(readFileSync(deployed, 'utf8').trim(), 'debian two');
  assert.equal(readFileSync(join(c.root, 'releases/demo/r3/.edge-state/app.env'), 'utf8'), 'two\n', 'the release keeps what it was pushed with');

  const back = ok(run(c, ['rollback', 'domestic-2', '--component', 'demo', '--root', c.root, '--yes'], env));
  assert.match(back, /state demo: 1 file\(s\) written, 1 replaced \(old copies in .*rollback-\d{8}T\d{6}Z-to-r2\)/);
  assert.equal(readFileSync(join(c.root, 'state/demo/app.env'), 'utf8'), 'one\n');
  assert.equal(readFileSync(deployed, 'utf8').trim(), 'debian one');
});

test('a component the edge tool did not create is left alone unless --take-over', () => {
  const c = newCase();
  ok(run(c, ['add', 'domestic-main', '--host', '203.0.113.10']));
  // What a v1 Launcher push leaves behind: a release and current/domestic, no edge history.
  const launcherRelease = join(c.root, 'releases/domestic/launcher-1');
  mkdirSync(launcherRelease, { recursive: true });
  mkdirSync(join(c.root, 'current'), { recursive: true });
  require('node:fs').symlinkSync(launcherRelease, join(c.root, 'current/domestic'));
  const bundle = makeBundle(join(c.dir, 'domestic'));
  const env = { FAKE_SSH_EXEC: '1' };

  const refused = run(c, ['push', 'domestic-main', '--bundle', bundle, '--revision', 'r1', '--root', c.root, '--yes'], env);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /was not deployed by qp-tunnel-cli edge/);
  assert.equal(readlinkSync(join(c.root, 'current/domestic')), launcherRelease);
  assert.ok(!existsSync(join(c.root, 'releases/domestic/r1')));

  const view = ok(run(c, ['status', 'domestic-main', '--root', c.root], env));
  assert.match(view, /domestic-main\s+edge\s+domestic\s+launcher-1\s+live\s+stack=- pushed-by=other since=-/);

  // A new component on that host is refused too: the host as a whole belongs to another tool.
  const beside = run(c, ['push', 'domestic-main', '--bundle', makeBundle(join(c.dir, 'wg-nginx')), '--revision', 'r1', '--root', c.root, '--yes'], env);
  assert.equal(beside.status, 1);
  assert.match(beside.stderr, /this host also runs domestic, deployed by something other than qp-tunnel-cli edge .* Pass --shared-host to push anyway/);
  assert.ok(!existsSync(join(c.root, 'current/wg-nginx')));
  assert.ok(!existsSync(join(c.root, 'incoming/wg-nginx-r1.tar.gz')));
  ok(run(c, ['push', 'domestic-main', '--bundle', makeBundle(join(c.dir, 'wg-nginx')), '--revision', 'r1', '--root', c.root, '--yes', '--shared-host'], env));
  assert.ok(existsSync(join(c.root, 'current/wg-nginx')));

  ok(run(c, ['push', 'domestic-main', '--bundle', bundle, '--revision', 'r1', '--root', c.root, '--yes', '--take-over'], env));
  assert.equal(readlinkSync(join(c.root, 'current/domestic')), join(c.root, 'releases/domestic/r1'));
  assert.ok(existsSync(launcherRelease), 'the old release stays');
});

test('status lists this machine and every saved host; an unreachable host is UNKNOWN and fails the run', () => {
  const c = newCase();
  ok(run(c, ['add', 'domestic-2', '--host', '203.0.113.20']));
  ok(run(c, ['push', 'domestic-2', '--bundle', makeBundle(join(c.dir, 'site')), '--revision', 'r1', '--root', c.root, '--yes'], { FAKE_SSH_EXEC: '1' }));

  const out = ok(run(c, ['status', '--root', c.root], { FAKE_SSH_EXEC: '1' }));
  assert.match(out, /^HOST\s+TARGET\s+OS\s+ACCESS/m);
  assert.match(out, /^local\s+this machine/m);
  assert.match(out, /^domestic-2\s+root@203\.0\.113\.20:22/m);
  assert.match(out, /^domestic-2\s+edge\s+site\s+r1\s+live\s+stack=- pushed-by=internal-a since=20\d\d-/m);
  assert.match(out, /^local\s+this machine \(origin internal-a\)/m);
  assert.match(out, /Release health is not checked/);

  const json = JSON.parse(ok(run(c, ['status', 'domestic-2', '--root', c.root, '--json'], { FAKE_SSH_EXEC: '1' })));
  assert.equal(json.hosts.length, 1);
  assert.equal(json.hosts[0].reachable, true);
  const edgeRow = json.hosts[0].rows.find((row) => row.kind === 'edge');
  assert.equal(edgeRow.name, 'site');
  assert.equal(edgeRow.version, 'r1');

  const health = ok(run(c, ['status', 'domestic-2', '--root', c.root, '--health'], { FAKE_SSH_EXEC: '1' }));
  if (process.getuid && process.getuid() !== 0) assert.match(health, /live \(health needs root\)/);

  const down = run(c, ['status', '--root', c.root], { FAKE_SSH_STATUS: '255' });
  assert.equal(down.status, 1);
  assert.match(down.stdout, /^domestic-2\s+-\s+-\s+-\s+UNKNOWN\s+UNREACHABLE/m);
  assert.match(down.stdout, /^local\s+this machine/m);
});

// ---------- several origins, relations, state directories, pinned images ----------

// /etc/os-release of s1, as the user pasted it on 2026-11-21.
const centos8Release = `NAME="CentOS Linux"
VERSION="8"
ID="centos"
ID_LIKE="rhel fedora"
VERSION_ID="8"
PLATFORM_ID="platform:el8"
PRETTY_NAME="CentOS Linux 8"
ANSI_COLOR="0;31"
CPE_NAME="cpe:/o:centos:centos:8"
`;

test('CentOS Linux 8 is rhel 8 and flagged end of life; CentOS Stream 9 is not', () => {
  const c = newCase();
  const probe = (content) => spawnSync('bash', ['-c', `. "${osLib}"; edge_os_detect; printf '%s|%s|%s|%s' "$EDGE_OS_FAMILY" "$EDGE_OS_MAJOR" "$EDGE_OS_NAME" "$(edge_os_eol_hint)"`], {
    encoding: 'utf8',
    env: { ...process.env, EDGE_OS_RELEASE_FILE: osRelease(c, content) },
  }).stdout.split('|');
  const [family, major, name, hint] = probe(centos8Release);
  assert.deepEqual([family, major, name], ['rhel', '8', 'CentOS Linux']);
  assert.match(hint, /CentOS Linux 8 reached end of life on 2021-12-31; its mirrors moved to vault\.centos\.org/);
  assert.equal(probe('NAME="CentOS Stream"\nID="centos"\nID_LIKE="rhel fedora"\nVERSION_ID="9"\n')[3], '');
  assert.match(probe('NAME="CentOS Stream"\nID="centos"\nVERSION_ID="8"\n')[3], /CentOS Stream 8 reached end of life/);

  // status says so on the host line, and a push still goes through preflight (with a warning).
  ok(run(c, ['add', 's1', '--host', '192.0.2.2']));
  const env = { FAKE_SSH_EXEC: '1', EDGE_OS_RELEASE_FILE: join(c.dir, 'os-release') };
  writeFileSync(join(c.dir, 'os-release'), centos8Release);
  const view = ok(run(c, ['status', 's1', '--root', c.root], env));
  assert.match(view, /^s1\s+\S+\s+CentOS Linux 8 \(family=rhel init=\S+ eol=yes\)/m);
  const state = join(c.dir, 'state');
  mkdirSync(state);
  writeFileSync(join(state, 'app.env'), 'one\n');
  const pushed = ok(run(c, ['push', 's1', '--bundle', makeStackBundle(join(c.dir, 'demo')), '--state-dir', state, '--revision', 'r1', '--root', c.root, '--yes'], env));
  assert.match(pushed, /preflight: warning: CentOS Linux 8 reached end of life/);
  assert.equal(readFileSync(join(c.root, 'state/demo/deployed'), 'utf8').trim(), 'rhel one');
});

test('hy2-mihomo pins the same image versions in stack.env and in its compose override', () => {
  const dir = join(edgeDir, 'stacks/hy2-mihomo');
  const manifest = readFileSync(join(dir, 'stack.env'), 'utf8');
  const listed = /^STACK_IMAGES="([^"]*)"/m.exec(manifest)[1].split(/\s+/).filter(Boolean);
  const override = readFileSync(join(dir, 'docker-compose.override.yml'), 'utf8');
  const used = [...override.matchAll(/^\s+image:\s*(\S+)\s*$/gm)].map((match) => match[1]);
  assert.deepEqual(used, listed);
  for (const image of used) assert.doesNotMatch(image, /:(latest|\d+(-alpine)?)$/, `${image} is not a fixed version`);
  assert.match(override, /^  hysteria:\n    image: tobyxdd\/hysteria:/m);
  assert.match(override, /^  subscriptions:\n    image: caddy:/m);
  assert.match(readFileSync(join(dir, 'deploy.sh'), 'utf8'), /docker-compose\.override\.yml/);
});

test('origin: hostname by default, set once, rename needs a yes, reserved names are refused', () => {
  const c = newCase();
  const noEnv = { QP_EDGE_ORIGIN: '' };
  const short = require('node:os').hostname().split('.')[0];
  const shown = ok(run(c, ['origin'], noEnv));
  if (short && !/^localhost$/i.test(short)) assert.match(shown, new RegExp(`^origin\\s+${short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(from hostname\\)`, 'm'));
  assert.match(shown, /does not exist yet/);
  assert.ok(!existsSync(c.home), 'showing the origin creates nothing');

  const reserved = run(c, ['origin', 'set', 'other'], noEnv);
  assert.equal(reserved.status, 2);
  assert.match(reserved.stderr, /reserved/);
  assert.match(ok(run(c, ['origin', 'set', 'internal02'], noEnv)), /This origin is internal02/);
  assert.equal(readFileSync(join(c.home, 'origin'), 'utf8'), 'internal02\n');
  assert.equal(statSync(c.home).mode & 0o777, 0o700);
  assert.match(ok(run(c, ['origin'], noEnv)), /^origin\s+internal02 \(from .*origin\)/m);

  const rename = run(c, ['origin', 'set', 'internal03'], noEnv);
  assert.notEqual(rename.status, 0);
  assert.match(rename.stderr, /refuse pushes\s+from internal03 until each component is pushed once with --take-over/);
  assert.equal(readFileSync(join(c.home, 'origin'), 'utf8'), 'internal02\n');
  ok(run(c, ['origin', 'set', 'internal03', '--yes'], noEnv));
  assert.equal(JSON.parse(ok(run(c, ['origin', '--json'], noEnv))).origin, 'internal03');
  assert.equal(JSON.parse(ok(run(c, ['origin', '--json']))).origin, 'internal-a', 'QP_EDGE_ORIGIN wins over the file');
});

test('a second origin is refused until --take-over; history, status and both ledgers say who did what', () => {
  const c = newCase();
  ok(run(c, ['add', 'domestic-2', '--host', '203.0.113.20']));
  const bundle = makeBundle(join(c.dir, 'site'));
  const homeB = join(c.dir, 'home-b');
  const asA = { FAKE_SSH_EXEC: '1' };
  const asB = { FAKE_SSH_EXEC: '1', QP_EDGE_ORIGIN: 'internal-b', QP_EDGE_HOME: homeB };
  const args = (rev) => ['push', 'domestic-2', '--bundle', bundle, '--revision', rev, '--root', c.root, '--yes'];
  const current = join(c.root, 'current/site');

  assert.match(ok(run(c, args('r1'), asA)), /managed from internal-a/);
  assert.equal(readFileSync(join(c.root, 'state/site/.edge-origin'), 'utf8'), 'internal-a\n');
  ok(run(c, args('r2'), asA));

  const refused = run(c, args('r3'), asB);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /site on this host is managed from internal-a \(state\/site\/\.edge-origin\); this request comes from internal-b/);
  assert.match(refused.stderr, /Nothing was changed\. Pass --take-over to move site to internal-b/);
  assert.equal(readlinkSync(current), join(c.root, 'releases/site/r2'));
  assert.ok(!existsSync(join(c.root, 'releases/site/r3')));
  assert.ok(!existsSync(join(c.root, 'incoming/site-r3.tar.gz')), 'a refused push leaves no upload behind');

  const rollbackB = run(c, ['rollback', 'domestic-2', '--component', 'site', '--root', c.root, '--yes'], asB);
  assert.equal(rollbackB.status, 1);
  assert.equal(readlinkSync(current), join(c.root, 'releases/site/r2'));

  assert.match(ok(run(c, [...args('r3'), '--take-over'], asB)), /take-over: site moves from origin internal-a to internal-b/);
  assert.equal(readFileSync(join(c.root, 'state/site/.edge-origin'), 'utf8'), 'internal-b\n');
  const refusedA = run(c, args('r4'), asA);
  assert.equal(refusedA.status, 1);
  assert.match(refusedA.stderr, /managed from internal-b/);

  ok(run(c, ['rollback', 'domestic-2', '--component', 'site', '--root', c.root, '--yes'], asB));
  assert.equal(readlinkSync(current), join(c.root, 'releases/site/r2'));
  const history = readFileSync(join(c.root, 'state/site/.edge-history'), 'utf8').trim().split('\n').map((line) => line.split(' ').slice(1));
  assert.deepEqual(history, [['r1', 'internal-a', 'push'], ['r2', 'internal-a', 'push'], ['r3', 'internal-b', 'push'], ['r2', 'internal-b', 'rollback']]);

  assert.match(ok(run(c, ['status', 'domestic-2', '--root', c.root], asA)), /site\s+r2\s+live\s+stack=- pushed-by=internal-b since=/);
  const ledgerA = readFileSync(join(c.home, 'ledger.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(ledgerA.map((entry) => [entry.action, entry.revision, entry.result]), [['push', 'r1', 'ok'], ['push', 'r2', 'ok'], ['push', 'r4', 'failed']]);
  assert.equal(ledgerA[0].target, 'root@203.0.113.20:22');
  const ledgerB = readFileSync(join(homeB, 'ledger.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(ledgerB.map((entry) => [entry.origin, entry.action, entry.result]), [
    ['internal-b', 'push', 'failed'], ['internal-b', 'rollback', 'failed'], ['internal-b', 'push', 'ok'], ['internal-b', 'rollback', 'ok']]);
});

test('relations: origin -> host -> component from the hosts, checked against the ledger; --offline and --json', () => {
  const c = newCase();
  ok(run(c, ['add', 'domestic-1', '--host', '203.0.113.10', '--role', 'domestic']));
  ok(run(c, ['add', 'domestic-2', '--host', '203.0.113.20', '--role', 'domestic']));
  ok(run(c, ['add', 'internal-3', '--host', '192.0.2.3', '--role', 'internal']));
  const roots = { 'root@203.0.113.10': join(c.dir, 'mx-d1'), 'root@203.0.113.20': join(c.dir, 'mx-d2'), 'root@192.0.2.3': join(c.dir, 'mx-i3') };
  const base = { FAKE_SSH_EXEC: '1', FAKE_SSH_ROOTS: JSON.stringify(roots), FAKE_SSH_ROOT_FROM: c.root };
  const asB = { ...base, QP_EDGE_ORIGIN: 'internal-b', QP_EDGE_HOME: join(c.dir, 'home-b') };
  const bundle = makeBundle(join(c.dir, 'site'));
  const push = (host, rev, env, extra = []) => ok(run(c, ['push', host, '--bundle', bundle, '--revision', rev, '--root', c.root, '--yes', ...extra], env));
  push('domestic-1', 'r1', base);
  push('domestic-2', 'r1', base);
  push('domestic-2', 'r2', asB, ['--take-over']);
  push('internal-3', 'r1', asB);
  // A v1 Launcher component on domestic-1.
  mkdirSync(join(roots['root@203.0.113.10'], 'releases/domestic/launcher-1'), { recursive: true });
  require('node:fs').symlinkSync(join(roots['root@203.0.113.10'], 'releases/domestic/launcher-1'), join(roots['root@203.0.113.10'], 'current/domestic'));

  const out = ok(run(c, ['relations', '--root', c.root], base));
  assert.match(out, /^This origin: internal-a \(from QP_EDGE_ORIGIN\)/m);
  assert.match(out, /^internal-a \*\s+domestic-1\s+site\s+-\s+r1\s+20\d\d-\S+\s+live\s*$/m);
  assert.match(out, /^internal-b\s+domestic-2\s+site\s+-\s+r2\s+\S+\s+live\s+this origin pushed r1 at \S+; internal-b took it over since$/m);
  assert.match(out, /^internal-b\s+internal-3\s+site\s+-\s+r1\s+\S+\s+live\s*$/m);
  assert.match(out, /^other\s+domestic-1\s+domestic\s+-\s+launcher-1\s+-\s+live\s+not pushed by the edge tool/m);
  const order = ['internal-a *', 'internal-b ', 'internal-b ', 'other'].map((prefix) => out.indexOf(`\n${prefix}`));
  assert.deepEqual([...order].sort((x, y) => x - y), order, 'this origin first, other origins next, other last');
  assert.match(out, /Nothing pushed on: internal-a \(this machine\)/);
  assert.match(out, /internal-a \(this origin\): 1 host\(s\), internal-b: 2 host\(s\), other: 1 host\(s\)/);

  const json = JSON.parse(ok(run(c, ['relations', '--role', 'internal', '--root', c.root, '--json'], base)));
  assert.equal(json.origin, 'internal-a');
  assert.deepEqual(json.relations.map((row) => [row.origin, row.host, row.revision]), [['internal-b', 'internal-3', 'r1']]);

  const fromB = ok(run(c, ['relations', 'domestic-2', '--root', c.root], asB));
  assert.match(fromB, /^internal-b \*\s+domestic-2\s+site\s+-\s+r2/m);

  const down = run(c, ['relations', '--root', c.root], { ...base, FAKE_SSH_EXEC: '0', FAKE_SSH_STATUS: '255' });
  assert.equal(down.status, 1);
  assert.match(down.stdout, /^internal-a \*\s+domestic-1\s+site\s+-\s+r1\s+\S+\s+UNKNOWN\s+unreachable \(UNREACHABLE\); last push from here per the ledger/m);

  const offline = ok(run(c, ['relations', '--offline'], { ...base, FAKE_SSH_STATUS: '255' }));
  assert.match(offline, /^internal-a \*\s+domestic-1\s+site\s+-\s+r1\s+\S+\s+-\s+from the ledger/m);
  assert.match(offline, /^internal-a \*\s+domestic-2\s+site\s+-\s+r1\s+\S+\s+-\s+from the ledger/m);
  assert.equal(sshCalls(c).filter((call) => call.join(' ').includes('status')).length > 0, true);
});

test('state init and push use the origin\'s state directory; state pull copies pushed files back and never overwrites', () => {
  const c = newCase();
  ok(run(c, ['add', 'domestic-2', '--host', '203.0.113.20']));
  ok(run(c, ['add', 'domestic-3', '--host', '203.0.113.30']));
  const roots = { 'root@203.0.113.20': join(c.dir, 'mx-d2'), 'root@203.0.113.30': join(c.dir, 'mx-d3') };
  const env = { FAKE_SSH_EXEC: '1', FAKE_SSH_ROOTS: JSON.stringify(roots), FAKE_SSH_ROOT_FROM: c.root, EDGE_OS_RELEASE_FILE: osRelease(c, ubuntuRelease) };

  const init = ok(run(c, ['state', 'init', 'domestic-2', '--stack', 'hy2-mihomo']));
  const hy2 = join(c.home, 'state/domestic-2/hy2-mihomo/hy2.env');
  assert.match(init, /written\s+hy2\.env/);
  assert.match(init, /edge push domestic-2 --stack hy2-mihomo --dry-run/);
  assert.equal(statSync(hy2).mode & 0o777, 0o600);
  writeFileSync(hy2, 'edited\n');
  assert.match(ok(run(c, ['state', 'init', 'domestic-2', '--stack', 'hy2-mihomo'])), /kept\s+hy2\.env/);
  assert.equal(readFileSync(hy2, 'utf8'), 'edited\n');
  assert.equal(run(c, ['state', 'init', 'nowhere', '--stack', 'hy2-mihomo']).status, 1, 'only saved hosts');

  // Each host's own state directory is picked up without --state-dir.
  const bundle = makeStackBundle(join(c.dir, 'demo'));
  for (const [host, value] of [['domestic-2', 'two'], ['domestic-3', 'three']]) {
    mkdirSync(join(c.home, 'state', host, 'demo', 'certs'), { recursive: true });
    writeFileSync(join(c.home, 'state', host, 'demo', 'app.env'), `${value}\n`);
    writeFileSync(join(c.home, 'state', host, 'demo', 'certs', 'site.key'), `key-${value}\n`);
  }
  const plan = ok(run(c, ['push', 'domestic-2,domestic-3', '--bundle', bundle, '--revision', 'r1', '--root', c.root, '--dry-run'], env));
  assert.match(plan, /state\s+\[domestic-2\] 2 file\(s\) from .*edge-home\/state\/domestic-2\/demo/);
  assert.match(plan, /state\s+\[domestic-3\] 2 file\(s\) from .*edge-home\/state\/domestic-3\/demo/);
  ok(run(c, ['push', 'domestic-2,domestic-3', '--bundle', bundle, '--revision', 'r1', '--root', c.root, '--yes'], env));
  assert.equal(readFileSync(join(roots['root@203.0.113.20'], 'state/demo/deployed'), 'utf8').trim(), 'debian two');
  assert.equal(readFileSync(join(roots['root@203.0.113.30'], 'state/demo/deployed'), 'utf8').trim(), 'debian three');

  const listed = ok(run(c, ['state']));
  assert.match(listed, /^domestic-2\s+demo\s+2\s+/m);
  assert.match(listed, /^domestic-2\s+hy2-mihomo\s+2\s+/m); // hy2.env and README.txt
  assert.match(listed, /^domestic-3\s+demo\s+2\s+/m);

  // The origin's copy already has files, so pull writes next to it.
  const pulled = ok(run(c, ['state', 'pull', 'domestic-2', '--component', 'demo', '--root', c.root], env));
  assert.match(pulled, /2 file\(s\) from domestic-2 state\/demo -> .*demo\.pulled-\d{8}T\d{6}Z/);
  assert.match(pulled, /already had files, so nothing there was changed/);
  const copy = /-> (\S+)/.exec(pulled)[1];
  assert.equal(readFileSync(join(copy, 'app.env'), 'utf8'), 'two\n');
  assert.equal(readFileSync(join(copy, 'certs/site.key'), 'utf8'), 'key-two\n');
  assert.ok(!existsSync(join(copy, 'deployed')), 'what deploy.sh wrote on the host stays there');
  assert.ok(!existsSync(join(copy, '.edge-history')) && !existsSync(join(copy, '.edge-origin')));
  assert.equal(readFileSync(join(c.home, 'state/domestic-2/demo/app.env'), 'utf8'), 'two\n');

  // Into an empty directory (a new origin taking over, or a lost one), pull fills the default place.
  const homeB = join(c.dir, 'home-b');
  const intoB = ok(run(c, ['state', 'pull', 'domestic-3', '--component', 'demo', '--root', c.root], { ...env, QP_EDGE_HOME: homeB, QP_EDGE_ORIGIN: 'internal-b' }));
  assert.match(intoB, /-> .*home-b\/state\/domestic-3\/demo\n/);
  assert.equal(readFileSync(join(homeB, 'state/domestic-3/demo/app.env'), 'utf8'), 'three\n');
  assert.equal(statSync(join(homeB, 'state/domestic-3/demo/app.env')).mode & 0o777, 0o600);
  assert.equal(statSync(join(homeB, 'state/domestic-3/demo/certs')).mode & 0o777, 0o700);

  const none = run(c, ['state', 'pull', 'domestic-3', '--component', 'nothing', '--root', c.root], env);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /nothing has no edge history on this host/);
});

// ---------- edge link ----------

/** The public key WireGuard derives from a base64 private key, via node:crypto. */
function wgPublicKey(privateKey) {
  const { createPrivateKey, createPublicKey } = require('node:crypto');
  const der = Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(privateKey, 'base64')]);
  const jwk = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' });
  return Buffer.from(jwk.x, 'base64url').toString('base64');
}

function kv(file) {
  return Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter((line) => /^[A-Z_]+=/.test(line)).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1).replace(/^"(.*)"$/, '$1')];
  }));
}

test('edge-os.sh: CIDR overlap and routes that clash with a subnet', () => {
  const script = `. "${osLib}"
ip() { printf '%s\\n' 'default via 192.168.1.1 dev eth0' '10.87.0.0/16 dev br-x scope link' '10.87.2.0/24 dev qpe-relay proto kernel scope link src 10.87.2.1' 'local 10.87.2.1 dev qpe-relay table local' 'unreachable 10.87.2.128/25 table 7'; }
edge_have() { return 0; }
for pair in "10.87.2.0/24 10.87.0.0/16" "10.87.2.0/24 10.87.3.0/24" "10.87.2.0/24 10.87.2.89" "10.87.2.0/24 10.96.0.0/12"; do
  set -- $pair; if edge_cidr_overlap "$1" "$2"; then echo "$1 $2 yes"; else echo "$1 $2 no"; fi
done
echo "parse $(edge_cidr_parse 10.87.2.7/24)"
edge_cidr_parse 256.1.1.1/8 || echo "parse bad"
edge_cidr_parse 10.87.2.0/33 || echo "parse bad"
echo "own [$(edge_route_overlaps 10.87.2.0/24 qpe-relay)]"
echo "new [$(edge_route_overlaps 10.87.9.0/24 qpe-relay)]"
echo "far [$(edge_route_overlaps 172.31.9.0/24)]"`;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [
    '10.87.2.0/24 10.87.0.0/16 yes',
    '10.87.2.0/24 10.87.3.0/24 no',
    '10.87.2.0/24 10.87.2.89 yes',
    '10.87.2.0/24 10.96.0.0/12 no',
    'parse 173474304 24',
    'parse bad',
    'parse bad',
    'own [10.87.0.0/16 dev br-x scope link; unreachable 10.87.2.128/25 table 7; ]',
    'new [10.87.0.0/16 dev br-x scope link; ]',
    'far []',
    '',
  ].join('\n'));
});

test('link init: one shared edge subnet, fixed addresses, refusals; both sides private with valid keys; --replace moves the old link aside', () => {
  const c = newCase();
  ok(run(c, ['add', 'domestic-2', '--host', '203.0.113.20', '--user', 'ops']));
  ok(run(c, ['add', 'behind-jump', '--host', '10.0.0.9', '--jump', 'domestic-2']));
  const refused = [
    [['--subnet', '10.89.0.0/16', '--ip', '10.89.88.89'], /overlaps 10\.0\.0\.0\/8, Launcher applications.*--plan launcher/],
    [['--subnet', '10.88.0.0/24', '--ip', '10.88.0.89'], /overlaps 10\.0\.0\.0\/8/],
    [['--subnet', '100.89.0.0/24', '--ip', '100.89.0.89'], /HDO V1 overlays/],
    [['--subnet', '100.127.0.0/24', '--ip', '100.127.0.89'], /the OpenVPN mesh/],
    [['--subnet', '192.168.240.0/24', '--ip', '192.168.240.89'], /Kubernetes pods 192\.168\.224\.0\/20 and services 192\.168\.240\.0\/20/],
    [['--subnet', '100.127.200.5/24', '--ip', '100.127.200.89'], /has host bits set; the block is 100\.127\.200\.0\/24/],
    [['--subnet', '100.127.200.0/24', '--ip', '100.127.203.89'], /not a host address in 100\.127\.200\.0\/24/],
    [['--subnet', '100.127.200.0/24', '--ip', '100.127.200.255'], /not a host address/],
    [['--subnet', '100.127.200.0/24', '--ip', '100.127.200.2'], /both 100\.127\.200\.2/],
    [['--subnet', '100.127.0.0/12', '--ip', '100.127.200.89'], /between \/16 and \/30/],
    [[], /usage: edge link init[\s\S]*asks for what is missing/],
    [['--plan', 'mesh'], /--plan mesh: use launcher/],
  ];
  for (const [args, pattern] of refused) {
    const result = run(c, ['link', 'init', 'domestic-2', ...args]);
    assert.equal(result.status, 2, `${args.join(' ')}\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, pattern);
  }
  const jump = run(c, ['link', 'init', 'behind-jump', '--subnet', '100.127.200.0/24', '--ip', '100.127.200.89']);
  assert.match(jump.stderr, /Pass --endpoint <public address>:51820/);
  assert.ok(!existsSync(c.home), 'refusals create no edge home');

  const out = ok(run(c, ['link', 'init', 'domestic-2', '--subnet', '100.127.200.0/24', '--ip', '100.127.200.89']));
  assert.match(out, /domestic-2 +100\.127\.200\.2 on qpjoy-relay, listens on udp 51820; reached at 203\.0\.113\.20:51820/, 'domestic-2 takes .2');
  assert.match(out, /100\.127\.200\.89 on qpjoy-d2, dials out, keepalive 25s; only 100\.127\.200\.2\/32 goes into it/);
  const linkDir = join(c.home, 'links/domestic-2');
  const wgDir = join(c.home, 'state/domestic-2/wg-nginx/wg');
  for (const file of [join(linkDir, 'link.env'), join(linkDir, 'qpjoy-d2.conf'), join(wgDir, 'relay.conf'), join(wgDir, 'relay.env')]) {
    assert.equal(statSync(file).mode & 0o777, 0o600, file);
  }
  const link = kv(join(linkDir, 'link.env'));
  assert.equal(link.LINK_SUBNET, '100.127.200.0/24');
  assert.equal(link.LINK_RELAY_IP, '100.127.200.2');
  assert.equal(link.LINK_PLAN, 'isolated');
  assert.doesNotMatch(readFileSync(join(linkDir, 'link.env'), 'utf8'), /PrivateKey/);
  const relay = readFileSync(join(wgDir, 'relay.conf'), 'utf8');
  const local = readFileSync(join(linkDir, 'qpjoy-d2.conf'), 'utf8');
  for (const conf of [relay, local]) {
    assert.match(conf, /^Table = off$/m);
    assert.doesNotMatch(conf, /^DNS/m);
    assert.doesNotMatch(conf, /0\.0\.0\.0\/0/);
  }
  assert.match(relay, /^Address = 100\.127\.200\.2\/32$/m, 'the relay holds only its own address');
  assert.match(relay, /^PostUp = ip route replace 100\.127\.200\.89\/32 dev %i$/m, 'and routes only the Internal machine');
  assert.match(relay, /^AllowedIPs = 100\.127\.200\.89\/32$/m);
  assert.match(local, /^Address = 100\.127\.200\.89\/32$/m);
  assert.match(local, /^AllowedIPs = 100\.127\.200\.2\/32$/m, 'this side only routes the edge host itself');
  assert.match(local, /^PostUp = ip route replace 100\.127\.200\.2\/32 dev %i$/m);
  assert.doesNotMatch(local, /100\.127\.200\.0\/24 dev/, 'no route for the whole block: edge hosts never reach each other through here');
  const privateOf = (conf) => /^PrivateKey = ([A-Za-z0-9+/]{43}=)$/m.exec(conf)[1];
  const peerOf = (conf) => /^PublicKey = ([A-Za-z0-9+/]{43}=)$/m.exec(conf)[1];
  assert.equal(wgPublicKey(privateOf(relay)), link.LINK_RELAY_PUBLIC_KEY);
  assert.equal(wgPublicKey(privateOf(local)), link.LINK_LOCAL_PUBLIC_KEY);
  assert.equal(peerOf(relay), link.LINK_LOCAL_PUBLIC_KEY);
  assert.equal(peerOf(local), link.LINK_RELAY_PUBLIC_KEY);
  assert.deepEqual(kv(join(wgDir, 'relay.env')), {
    EDGE_LINK_HOST: 'domestic-2', EDGE_LINK_ORIGIN: 'internal-a', EDGE_WG_INTERFACE: 'qpjoy-relay', EDGE_WG_PORT: '51820',
    EDGE_WG_ADDRESS: '100.127.200.2/32', EDGE_WG_SUBNET: '100.127.200.0/24', EDGE_WG_PEERS: 'internal-a=100.127.200.89',
  });

  const again = run(c, ['link', 'init', 'domestic-2', '--subnet', '100.127.200.0/24', '--ip', '100.127.200.89']);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already has a link from this origin[\s\S]*init never overwrites keys[\s\S]*--replace/);
  assert.equal(readFileSync(join(wgDir, 'relay.conf'), 'utf8'), relay);

  // A second edge host in the same block: its own address, this machine keeps .89, another interface name.
  ok(run(c, ['add', 'domestic-x2', '--host', '203.0.113.22']));
  const otherBlock = run(c, ['link', 'init', 'domestic-x2', '--subnet', '100.127.200.0/25', '--ip', '100.127.200.89']);
  assert.match(otherBlock.stderr, /overlaps 100\.127\.200\.0\/24, the link to domestic-2; links share one block/);
  const sameRelay = run(c, ['link', 'init', 'domestic-x2', '--subnet', '100.127.200.0/24', '--ip', '100.127.200.89', '--relay-ip', '100.127.200.2', '--interface', 'qpjoy-dx2']);
  assert.match(sameRelay.stderr, /--relay-ip 100\.127\.200\.2 is already domestic-2's address/);
  const sameName = run(c, ['link', 'init', 'domestic-x2', '--subnet', '100.127.200.0/24', '--ip', '100.127.200.89']);
  assert.match(sameName.stderr, /--interface qpjoy-d2 is already the link to domestic-2/);
  const second = ok(run(c, ['link', 'init', 'domestic-x2', '--subnet', '100.127.200.0/24', '--ip', '100.127.200.89', '--interface', 'qpjoy-dx2']));
  assert.match(second, /domestic-x2 +100\.127\.200\.1 on qpjoy-relay/, '.2 is taken, so the first free address');
  const list = ok(run(c, ['link']));
  assert.match(list, /domestic-2\s+100\.127\.200\.0\/24\s+100\.127\.200\.89\s+100\.127\.200\.2 \(qpjoy-relay\)\s+203\.0\.113\.20:51820\s+qpjoy-d2/);
  assert.match(list, /domestic-x2\s+100\.127\.200\.0\/24\s+100\.127\.200\.89\s+100\.127\.200\.1 \(qpjoy-relay\)/);

  // --replace that fails a check moves nothing.
  const badReplace = run(c, ['link', 'init', 'domestic-2', '--replace', '--subnet', '10.95.0.0/24', '--ip', '10.95.0.89']);
  assert.equal(badReplace.status, 2);
  assert.ok(existsSync(join(linkDir, 'link.env')) && !existsSync(join(c.home, 'replaced')), 'a refused --replace leaves the link where it was');
  // --replace: the old files move to <edge home>/replaced/, the new link has new keys.
  const replaced = ok(run(c, ['link', 'init', 'domestic-2', '--replace', '--subnet', '100.127.200.0/24', '--ip', '100.127.200.89']));
  assert.match(replaced, /was moved to .*replaced\/\d{8}T\d{6}Z-domestic-2; nothing was deleted/);
  const { readdirSync } = require('node:fs');
  const [aside] = readdirSync(join(c.home, 'replaced'));
  assert.equal(readFileSync(join(c.home, 'replaced', aside, 'wg/relay.conf'), 'utf8'), relay);
  assert.ok(existsSync(join(c.home, 'replaced', aside, 'link/qpjoy-d2.conf')));
  assert.notEqual(kv(join(linkDir, 'link.env')).LINK_RELAY_PUBLIC_KEY, link.LINK_RELAY_PUBLIC_KEY);
  assert.equal(sshCalls(c).length, 0);
});

test('setup needs a terminal and says which commands to run instead', () => {
  const c = newCase();
  const result = run(c, ['setup']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /needs a terminal[\s\S]*edge link init/);
  assert.match(ok(run(c, ['help'])), /qp-tunnel-cli edge setup/);
});

test('push --stack wg-nginx carries the relay side of a link and never this side\'s key', () => {
  const c = newCase();
  ok(run(c, ['add', 'domestic-2', '--host', '203.0.113.20', '--user', 'ops']));
  ok(run(c, ['link', 'init', 'domestic-2', '--subnet', '100.127.202.0/24', '--ip', '100.127.202.89']));
  const plan = ok(run(c, ['push', 'domestic-2', '--stack', 'wg-nginx', '--revision', 'r1', '--dry-run']));
  assert.match(plan, /state\s+2 file\(s\) from .*state\/domestic-2\/wg-nginx .*: wg\/relay\.conf, wg\/relay\.env/);
  assert.doesNotMatch(plan, /needs wg/);

  const capture = join(c.dir, 'capture');
  mkdirSync(capture);
  ok(run(c, ['push', 'domestic-2', '--stack', 'wg-nginx', '--revision', 'r1', '--yes'], { FAKE_SSH_CAPTURE: capture }));
  const { readdirSync } = require('node:fs');
  const contents = readdirSync(capture).map((file) => spawnSync('tar', ['-xzOf', join(capture, file)], { encoding: 'latin1', maxBuffer: 64 * 1024 * 1024 }).stdout).join('\n');
  const local = readFileSync(join(c.home, 'links/domestic-2/qpjoy-d2.conf'), 'utf8');
  const relay = readFileSync(join(c.home, 'state/domestic-2/wg-nginx/wg/relay.conf'), 'utf8');
  const privateOf = (conf) => /^PrivateKey = (\S+)$/m.exec(conf)[1];
  assert.ok(contents.includes(privateOf(relay)), 'the relay key travels with the state');
  assert.ok(!contents.includes(privateOf(local)), 'this side\'s key stays on this machine');
  assert.ok(!contents.includes('vendor/scripts/wireguard.sh'), 'the stack no longer ships wireguard.sh');
});

test('link up installs missing wireguard-tools (asks, or --yes), installs this side, is idempotent, refuses a foreign config or a clashing route', () => {
  const c = newCase();
  const bin = join(c.dir, 'bin');
  const net = join(c.dir, 'net');
  const wg = join(c.dir, 'etc-wireguard');
  mkdirSync(bin);
  mkdirSync(net);
  const script = (dir, name, body) => { writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`); chmodSync(join(dir, name), 0o755); };
  script(bin, 'ip', `n="$FAKE_NET"
case "$*" in
  "link show "*) [ -f "$n/up-$3" ] ;;
  "-4 route show table all") cat "$n/routes" 2>/dev/null; for f in "$n"/up-*; do [ -f "$f" ] && echo "100.127.202.0/24 dev \${f##*/up-} scope link"; done; exit 0 ;;
  "-4 route get "*) for f in "$n"/up-*; do if [ -f "$f" ]; then case "$4" in 100.127.202.*) echo "$4 dev \${f##*/up-} src 100.127.202.89"; exit 0 ;; esac; fi; done
                    echo "$4 via 192.168.1.1 dev eth0 src 192.168.1.4" ;;
esac`);
  script(bin, 'wg-quick', 'i="$(basename "$2" .conf)"; echo "$1 $2" >> "$FAKE_NET/wg-quick.log"; if [ "$1" = up ]; then touch "$FAKE_NET/up-$i"; else rm -f "$FAKE_NET/up-$i"; fi');
  script(net, 'wg.ready', 'printf "%s\\t%s\\n" relaykey "$(date +%s)"');
  script(bin, 'apt-get', 'echo "$*" >> "$FAKE_NET/apt.log"; case "$*" in *install*wireguard-tools*) cp "$FAKE_NET/wg.ready" "$FAKE_BIN/wg" ;; esac');
  script(bin, 'ping', 'echo "rtt min/avg/max/mdev = 1.0/1.0/1.0/0.0 ms"');
  script(bin, 'systemctl', 'exit 1');
  // The edge host's half of the check: a fake ssh that prints what remote side would report.
  script(bin, 'fake-remote-ssh', 'printf "%s\\n" "$FAKE_REMOTE"');
  const osRelease = join(c.dir, 'os-release');
  writeFileSync(osRelease, 'ID=ubuntu\nID_LIKE=debian\nVERSION_ID="26.04"\nPRETTY_NAME="Ubuntu 26.04 LTS"\n');
  const env = {
    PATH: `${bin}:${process.env.PATH}`, FAKE_NET: net, FAKE_BIN: bin, QP_EDGE_IP_BIN: join(bin, 'ip'), QP_EDGE_SUDO: '', QP_EDGE_WG_DIR: wg,
    QP_EDGE_OS_RELEASE: osRelease, PROXY: '', HTTPS_PROXY: '', https_proxy: '', HTTP_PROXY: '', http_proxy: '',
  };
  ok(run(c, ['add', 'domestic-2', '--host', '203.0.113.20', '--user', 'ops']));
  ok(run(c, ['link', 'init', 'domestic-2', '--subnet', '100.127.202.0/24', '--ip', '100.127.202.89'], env));
  const keys = kv(join(c.home, 'links/domestic-2/link.env'));
  const now = Math.floor(Date.now() / 1000);
  env.QP_EDGE_SSH_BIN = join(bin, 'fake-remote-ssh');
  env.FAKE_REMOTE = [`unit=active`, `hs=${keys.LINK_LOCAL_PUBLIC_KEY} ${now}`, `tr=${keys.LINK_LOCAL_PUBLIC_KEY} 900 700`,
    `pub=${keys.LINK_RELAY_PUBLIC_KEY}`, 'port=51820', 'fw=none', 'ping=ok'].join('\n');
  const source = join(c.home, 'links/domestic-2/qpjoy-d2.conf');
  const target = join(wg, 'qpjoy-d2.conf');

  const asked = run(c, ['link', 'up', 'domestic-2'], env);
  assert.equal(asked.status, 1, 'not a terminal and no --yes: nothing is installed');
  assert.match(asked.stdout, /Missing on this machine \(Ubuntu 26\.04 LTS\): wg/);
  assert.match(asked.stdout, /by hand: +sudo apt-get update && sudo apt-get install -y wireguard-tools/);
  assert.match(asked.stderr, /pass --yes to install them/);
  assert.ok(!existsSync(join(net, 'apt.log')));
  assert.ok(!existsSync(target));

  const up = ok(run(c, ['link', 'up', 'domestic-2', '--yes'], env));
  assert.match(readFileSync(join(net, 'apt.log'), 'utf8'), /^update -q\ninstall -y -q wireguard-tools\n$/);
  assert.match(up, /Installed wireguard-tools\./);
  assert.match(up, /\[link\] .*qpjoy-d2\.conf written/);
  assert.match(up, /ok +handshake with domestic-2/);
  assert.match(up, /ok +100\.127\.202\.2 is routed into qpjoy-d2/);
  assert.match(up, /ok +other traffic stays off the tunnel/);
  assert.match(up, /ok +handshake with this side \d+s ago/);
  assert.match(up, /Up on both ends\./);
  assert.equal(readFileSync(target, 'utf8'), readFileSync(source, 'utf8'));
  assert.equal(statSync(target).mode & 0o777, 0o600);
  const again = ok(run(c, ['link', 'up', 'domestic-2'], env));
  assert.match(again, /unchanged/);
  assert.doesNotMatch(again, /Missing on this machine/, 'tools are found now');
  assert.match(ok(run(c, ['link'], env)), /qpjoy-d2\s+up/);

  assert.match(ok(run(c, ['link', 'down', 'domestic-2'], env)), /qpjoy-d2 down; .* kept/);
  assert.ok(existsSync(target));
  assert.match(ok(run(c, ['link'], env)), /qpjoy-d2\s+down/);

  writeFileSync(join(net, 'routes'), '100.127.202.0/25 dev eth0 scope link\n');
  const clash = run(c, ['link', 'up', 'domestic-2'], env);
  assert.equal(clash.status, 1);
  assert.match(clash.stderr, /overlaps routes on this machine now:\n  100\.127\.202\.0\/25 dev eth0/);
  writeFileSync(join(net, 'routes'), '');

  writeFileSync(target, '[Interface]\nPrivateKey = someone-else\n');
  const foreign = run(c, ['link', 'up', 'domestic-2'], env);
  assert.equal(foreign.status, 3);
  assert.match(foreign.stderr, /exists and was not written by qp-tunnel-cli edge link; nothing was changed/);
  assert.equal(readFileSync(target, 'utf8'), '[Interface]\nPrivateKey = someone-else\n');
});

test('edge key: nothing before first use; install needs a terminal because ssh asks for the password itself', () => {
  const c = newCase();
  assert.match(ok(run(c, ['key'])), /No SSH key for edge hosts yet \(.*ssh\/id_ed25519\)/);
  ok(run(c, ['add', 'domestic-2', '--host', '203.0.113.20']));
  const install = run(c, ['key', 'install', 'domestic-2']);
  assert.equal(install.status, 1);
  assert.match(install.stderr, /typed into ssh's own prompt, so this needs a terminal/);
  assert.equal(sshCalls(c).length, 0, 'nothing connects without a terminal');
  assert.match(ok(run(c, ['help'])), /edge key install <name>/);
});

test('link check explains a missing handshake: security group, host firewall, wrong relay key', () => {
  const c = newCase();
  const bin = join(c.dir, 'bin');
  const net = join(c.dir, 'net');
  mkdirSync(bin);
  mkdirSync(net);
  const script = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  script('ip', `case "$*" in "link show "*) exit 0 ;; "-4 route get "*) case "$4" in 100.127.200.*) echo "$4 dev qpjoy-d2" ;; *) echo "$4 via 192.168.1.1 dev eth0" ;; esac ;; esac`);
  script('wg', 'case "$3" in transfer) echo "$RELAY_PUB 0 4440" ;; *) echo "$RELAY_PUB 0" ;; esac');
  script('ping', 'exit 1');
  script('fake-remote-ssh', 'printf "%s\\n" "$FAKE_REMOTE"');
  ok(run(c, ['add', 'domestic-2', '--host', '203.0.113.20']));
  ok(run(c, ['link', 'init', 'domestic-2', '--subnet', '100.127.200.0/24', '--ip', '100.127.200.89']));
  const keys = kv(join(c.home, 'links/domestic-2/link.env'));
  const remote = (...lines) => ['unit=active', `hs=${keys.LINK_LOCAL_PUBLIC_KEY} 0`, `tr=${keys.LINK_LOCAL_PUBLIC_KEY} 0 0`, 'port=51820', 'ping=fail', ...lines].join('\n');
  const check = (fakeRemote) => run(c, ['link', 'check', 'domestic-2'], {
    PATH: `${bin}:${process.env.PATH}`, QP_EDGE_IP_BIN: join(bin, 'ip'), QP_EDGE_SUDO: '', QP_EDGE_SSH_BIN: join(bin, 'fake-remote-ssh'),
    RELAY_PUB: keys.LINK_RELAY_PUBLIC_KEY, FAKE_REMOTE: fakeRemote,
  });

  const blocked = check(remote(`pub=${keys.LINK_RELAY_PUBLIC_KEY}`, 'fw=none', 'cap=none'));
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /no handshake with domestic-2 at 203\.0\.113\.20:51820 \(sent 4440 bytes, received 0\)/);
  assert.match(blocked.stdout, /why\n  - nothing from this machine arrives at domestic-2 on udp 51820 \(watched 7 s with tcpdump/);
  assert.match(blocked.stdout, /security group of domestic-2 must allow udp 51820 inbound \(Aliyun console: 安全组 → 入方向/);

  const ufw = check(remote(`pub=${keys.LINK_RELAY_PUBLIC_KEY}`, 'fw=ufw-closed', 'cap=seen 18:00:00 IP 198.51.100.7.43210 > 172.16.0.5.51820: UDP, length 148'));
  assert.match(ufw.stdout, /packets arrive at domestic-2 \(.*198\.51\.100\.7.*\) but are not accepted/);
  assert.match(ufw.stdout, /domestic-2's ufw does not allow udp 51820: sudo ufw allow 51820\/udp/);

  const rekeyed = check(remote('pub=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', 'fw=none', 'cap=seen x'));
  assert.match(rekeyed.stdout, /the relay on domestic-2 has another key than this link expects/);
});

test('link init --plan launcher: the Launcher numbering in 10.88 (internal02 10.88.88.89, domestic02 10.88.0.2), its own addresses refused, its routes left alone', () => {
  const c = newCase();
  const bin = join(c.dir, 'bin');
  mkdirSync(bin);
  // This machine already runs the Launcher's service peer: 10.88.0.0/16 and 10.88.0.1/32 on mx-internal-svc.
  writeFileSync(join(bin, 'ip'), `#!/bin/sh
case "$*" in
  "-4 route show table all") printf '%s\\n' "default via 192.168.1.1 dev eth0" "10.88.0.0/16 dev mx-internal-svc scope link" "10.88.0.1 dev mx-internal-svc scope link" "10.88.0.7 dev somebody-else scope link" "local 10.88.88.88 dev mx-internal-svc table local proto kernel scope host src 10.88.88.88" ;;
esac
exit 0
`);
  chmodSync(join(bin, 'ip'), 0o755);
  const env = { QP_EDGE_ORIGIN: 'internal02', QP_EDGE_IP_BIN: join(bin, 'ip') };
  ok(run(c, ['add', 'domestic02', '--host', '203.0.113.20'], env));
  ok(run(c, ['add', 'domestic01', '--host', '203.0.113.21'], env));
  ok(run(c, ['add', 'domestic07', '--host', '203.0.113.27'], env));

  const out = ok(run(c, ['link', 'init', 'domestic02', '--plan', 'launcher'], env));
  assert.match(out, /plan +launcher: 10\.88\.0\.0\/16/);
  assert.match(out, /domestic02 10\.88\.0\.2 on qpjoy-relay/);
  assert.match(out, /this side +10\.88\.88\.89 on qpjoy-d02/, 'internal02 -> 10.88.88.89, the address s2 has in the Launcher network too');
  assert.match(out, /10\.88\.0\.2\/32 goes into qpjoy-d02; it is more specific than: 10\.88\.0\.0\/16 dev mx-internal-svc/);
  const relay = readFileSync(join(c.home, 'state/domestic02/wg-nginx/wg/relay.conf'), 'utf8');
  const local = readFileSync(join(c.home, 'links/domestic02/qpjoy-d02.conf'), 'utf8');
  assert.match(relay, /^Address = 10\.88\.0\.2\/32$/m);
  assert.match(relay, /^PostUp = ip route replace 10\.88\.88\.89\/32 dev %i$/m);
  assert.doesNotMatch(relay, /10\.88\.0\.0\/16/, 'the relay never claims the Launcher block');
  assert.match(local, /^Address = 10\.88\.88\.89\/32$/m);
  assert.match(local, /^AllowedIPs = 10\.88\.0\.2\/32$/m);
  assert.equal(kv(join(c.home, 'links/domestic02/link.env')).LINK_PLAN, 'launcher');

  const relayOfLauncher = run(c, ['link', 'init', 'domestic01', '--plan', 'launcher', '--relay-ip', '10.88.0.1'], env);
  assert.match(relayOfLauncher.stderr, /10\.88\.0\.1 is the Launcher's relay on the current Domestic/);
  const vip = run(c, ['link', 'init', 'domestic01', '--plan', 'launcher', '--relay-ip', '10.88.100.3'], env);
  assert.match(vip.stderr, /10\.88\.100\.3 is the Launcher's product service VIPs/);
  const routed = run(c, ['link', 'init', 'domestic07', '--plan', 'launcher'], env);
  assert.match(routed.stderr, /10\.88\.0\.7 is already routed or assigned on this machine \(10\.88\.0\.7 dev somebody-else/);
  const first = ok(run(c, ['link', 'init', 'domestic01', '--plan', 'launcher', '--interface', 'qpjoy-d01'], env));
  assert.match(first, /domestic01 10\.88\.0\.3 on qpjoy-relay/, '.1 stays the Launcher relay and .2 is domestic02, so the next free one');
  const mixed = run(c, ['link', 'init', 'domestic07', '--plan', 'launcher', '--subnet', '100.127.200.0/24'], env);
  assert.match(mixed.stderr, /--plan launcher is 10\.88\.0\.0\/16/);
});

test('link init --plan launcher: 10.88.88.88 is the Launcher Internal role address, so internal01 (s1) takes .87', () => {
  const c = newCase();
  const bin = join(c.dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'ip'), `#!/bin/sh
case "$*" in
  "-4 route show table all") printf '%s\\n' "default via 192.168.1.1 dev eth0" ;;
esac
exit 0
`);
  chmodSync(join(bin, 'ip'), 0o755);
  const env = { QP_EDGE_ORIGIN: 'internal01', QP_EDGE_IP_BIN: join(bin, 'ip') };
  ok(run(c, ['add', 'domestic02', '--host', '203.0.113.20'], env));
  ok(run(c, ['add', 'domestic03', '--host', '203.0.113.23'], env));

  const asked = run(c, ['link', 'init', 'domestic02', '--plan', 'launcher', '--ip', '10.88.88.88'], env);
  assert.notEqual(asked.status, 0);
  assert.match(asked.stderr, /10\.88\.88\.88 is the Launcher's Internal service peer \(mx-internal-svc\), a role address/);
  const relay = run(c, ['link', 'init', 'domestic02', '--plan', 'launcher', '--relay-ip', '10.88.88.88'], env);
  assert.match(relay.stderr, /10\.88\.88\.88 is the Launcher's Internal service peer/);

  const out = ok(run(c, ['link', 'init', 'domestic02', '--plan', 'launcher'], env));
  assert.match(out, /this side +10\.88\.88\.87 on qpjoy-d02/, 'internal01 would be .88 by the formula; .88 is reserved, so .87');
  assert.match(readFileSync(join(c.home, 'links/domestic02/qpjoy-d02.conf'), 'utf8'), /^Address = 10\.88\.88\.87\/32$/m);
  const second = ok(run(c, ['link', 'init', 'domestic03', '--plan', 'launcher'], env));
  assert.match(second, /this side +10\.88\.88\.87 on qpjoy-d03/, 'the same origin keeps one address for all its links');

  const isolated = ok(run(c, ['link', 'init', 'domestic03', '--replace', '--plan', 'isolated'], env));
  assert.match(isolated, /this side +100\.127\.200\.88 on qpjoy-d03/, 'the isolated plan has no Launcher roles, internal01 stays .88 there');
});
