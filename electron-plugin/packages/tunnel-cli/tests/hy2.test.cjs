const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { X509Certificate } = require('node:crypto');
const dgram = require('node:dgram');
const {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { gunzipSync } = require('node:zlib');
const { after, test } = require('node:test');

const packageRoot = resolve(__dirname, '..');
const cli = resolve(packageRoot, 'dist/index.js');
const edgeDir = resolve(packageRoot, 'resources/edge');
const hy2Stack = join(edgeDir, 'stacks/hy2');
const testRoot = mkdtempSync(join(tmpdir(), 'qp-hy2-test-'));
const groups = [];

after(() => {
  for (const pid of groups) {
    try { process.kill(-pid, 'SIGTERM'); } catch {}
  }
  rmSync(testRoot, { recursive: true, force: true });
});

// The engines a source checkout carries (electron-plugin/packages/tunnel-engines).
function workspaceEngine(target) {
  const file = resolve(packageRoot, '..', 'tunnel-engines', target, 'resources/engine', target, 'mihomo.gz');
  return existsSync(file) ? file : undefined;
}
const hereEngine = ['darwin', 'linux'].includes(process.platform) ? workspaceEngine(`${process.platform}-${process.arch}`) : undefined;
const linuxX64Engine = workspaceEngine('linux-x64');
const { networkInterfaces } = require('node:os');
const ipv4 = (filter) => Object.entries(networkInterfaces()).filter(([name]) => filter(name))
  .flatMap(([, list]) => (list || []).filter((entry) => entry.family === 'IPv4' || entry.family === 4).map((entry) => entry.address));
const lanAddress = ipv4(() => true).find((address) => !address.startsWith('127.'));
// As the CLI looks them up: on Linux `ip` also lists links Node skips (docker0 with no container).
const hy2Module = require(resolve(packageRoot, 'dist/hy2.js'));
const ipAddr = process.platform === 'linux' ? spawnSync('ip', ['-4', '-o', 'addr', 'show'], { encoding: 'utf8' }) : undefined;
const dockerAddresses = ipAddr && ipAddr.status === 0 && hy2Module.parseIpAddr(ipAddr.stdout).length > 0
  ? [...new Set(hy2Module.parseIpAddr(ipAddr.stdout).filter(({ name }) => name === 'docker0' || name.startsWith('br-')).map(({ address }) => address))]
  : ipv4((name) => name === 'docker0' || name.startsWith('br-'));
let hereMihomoPath;
function hereMihomo() {
  if (!hereMihomoPath) {
    hereMihomoPath = join(testRoot, 'mihomo');
    writeFileSync(hereMihomoPath, gunzipSync(readFileSync(hereEngine)), { mode: 0o755 });
  }
  return hereMihomoPath;
}

// A stand-in for ssh: logs argv; answers the hy2 probe with FAKE_PROBE; keeps uploads in FAKE_SSH_CAPTURE.
const fakeSsh = join(testRoot, 'fake-ssh');
writeFileSync(fakeSsh, `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(args) + '\\n');
const withValue = new Set(['-p', '-o', '-i', '-W', '-J', '-l']);
let index = 0;
while (index < args.length && args[index].startsWith('-')) index += withValue.has(args[index]) ? 2 : 1;
const command = args.slice(index + 1).join(' ');
let input = Buffer.alloc(0);
try { input = readFileSync(0); } catch {}
if (input.includes('qp-hy2-probe')) { process.stdout.write(process.env.FAKE_PROBE || ''); process.exit(0); }
if (command.includes('qp-hy2-diagnose')) { process.stdout.write(process.env.FAKE_DIAG || ''); process.exit(Number(process.env.FAKE_SSH_STATUS || 0)); }
if (process.env.FAKE_SSH_CAPTURE && command.includes('cat >')) {
  const kind = command.includes('.state.tar.gz') ? 'state' : 'bundle';
  writeFileSync(process.env.FAKE_SSH_CAPTURE + '/' + kind + '-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.tgz', input);
}
process.exit(Number(process.env.FAKE_SSH_STATUS || 0));
`);
chmodSync(fakeSsh, 0o755);

let caseCounter = 0;
function newCase() {
  caseCounter += 1;
  const dir = join(testRoot, `case-${caseCounter}`);
  mkdirSync(join(dir, 'capture'), { recursive: true });
  return { dir, home: join(dir, 'home'), hostsFile: join(dir, 'hosts.json'), log: join(dir, 'ssh.log'), capture: join(dir, 'capture') };
}

function env(c, extra = {}) {
  return {
    ...process.env,
    QP_EDGE_HOME: c.home,
    QP_EDGE_HOSTS_FILE: c.hostsFile,
    QP_EDGE_ORIGIN: 'internal-a',
    QP_EDGE_SSH_BIN: fakeSsh,
    FAKE_SSH_LOG: c.log,
    FAKE_SSH_CAPTURE: c.capture,
    ...extra,
  };
}

function run(c, args, extra = {}) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: env(c, extra), timeout: 180000 });
}

function ok(result) {
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result.stdout;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function mode(file) {
  return statSync(file).mode & 0o777;
}

function tarList(file) {
  const listed = spawnSync('tar', ['-tzf', file], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout.split('\n').map((entry) => entry.replace(/^\.\//, '')).filter(Boolean);
}

function tarRead(file, entry) {
  const read = spawnSync('tar', ['-xzOf', file, `./${entry}`], { encoding: 'utf8' });
  assert.equal(read.status, 0, read.stderr);
  return read.stdout;
}

function captured(c, kind) {
  return readdirSync(c.capture).filter((file) => file.startsWith(`${kind}-`)).sort().map((file) => join(c.capture, file));
}

function freeTcpPort() {
  return new Promise((resolvePort) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

function freeUdpPort() {
  return new Promise((resolvePort) => {
    const socket = dgram.createSocket('udp4');
    socket.bind(0, '127.0.0.1', () => {
      const { port } = socket.address();
      socket.close(() => resolvePort(port));
    });
  });
}

async function waitForPort(port, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const open = await new Promise((resolveOpen) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.on('connect', () => { socket.destroy(); resolveOpen(true); });
      socket.on('error', () => resolveOpen(false));
    });
    if (open) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`nothing listens on ${port}`);
}

function background(command, args, options) {
  const child = spawn(command, args, { ...options, detached: true, stdio: 'ignore' });
  groups.push(child.pid);
  return child;
}

function stop(child) {
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
}

test('every hy2 shell file parses with bash', () => {
  for (const file of ['deploy.sh', 'health.sh']) {
    const result = spawnSync('bash', ['-n', join(hy2Stack, file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});

test('init: private state, both configurations, a pinned certificate; secrets stay unless rotated', () => {
  const c = newCase();
  ok(run(c, ['edge', 'add', 'box', '--host', '203.0.113.10']));
  const out = ok(run(c, ['hy2', 'init', 'box', '--local-port', '17991']));
  assert.match(out, /203\.0\.113\.10:443\/udp on box \(component hy2, unit qp-edge-hy2\.service\)/);
  assert.match(out, /127\.0\.0\.1:17991 \(HTTP \+ SOCKS5\), mihomo-client instance hy2-box/);

  const state = join(c.home, 'state/box/hy2');
  const own = join(c.home, 'hy2/box');
  for (const file of ['server.yaml', 'hy2.env', 'tls/server.crt', 'tls/server.key']) assert.equal(mode(join(state, file)), 0o600, file);
  for (const file of ['hy2.json', 'client.yaml']) assert.equal(mode(join(own, file)), 0o600, file);
  for (const dir of [state, join(state, 'tls'), own]) assert.equal(mode(dir), 0o700, dir);
  assert.deepEqual(readdirSync(state).sort(), ['hy2.env', 'server.yaml', 'tls'], 'what is pushed holds no client file');

  const cfg = readJson(join(own, 'hy2.json'));
  const cert = new X509Certificate(readFileSync(join(state, 'tls/server.crt')));
  assert.equal(cfg.fingerprint, cert.fingerprint256);
  assert.match(cert.subjectAltName, /IP Address:203\.0\.113\.10/);
  assert.ok(cfg.password.length >= 32);
  assert.equal(cfg.user, 'internal-a');

  const server = readFileSync(join(state, 'server.yaml'), 'utf8');
  assert.match(server, /^# qp-tunnel-cli hy2 server for box/);
  assert.match(server, /type: hysteria2\n {4}listen: 0\.0\.0\.0\n {4}port: 443\n/);
  assert.ok(server.includes(`"internal-a": ${JSON.stringify(cfg.password)}`));
  assert.match(server, /rules:\n {2}- MATCH,DIRECT\n$/);
  assert.equal(readFileSync(join(state, 'hy2.env'), 'utf8').split('\n')[1], 'HY2_PORT=443');

  const client = readFileSync(join(own, 'client.yaml'), 'utf8');
  assert.match(client, /^mixed-port: 17991$/m);
  assert.match(client, /^allow-lan: false$/m);
  assert.ok(client.includes(`fingerprint: ${JSON.stringify(cert.fingerprint256)}`));
  assert.ok(!client.includes('sni:'), 'an IP address gets no server name');
  assert.match(client, /- MATCH,hy2-box\n$/);

  ok(run(c, ['hy2', 'init', 'box']));
  const again = readJson(join(own, 'hy2.json'));
  assert.equal(again.password, cfg.password);
  assert.equal(again.fingerprint, cfg.fingerprint);
  assert.equal(again.localPort, 17991);

  assert.match(ok(run(c, ['hy2', 'init', 'box', '--rotate-password'])), /new password; clients exported earlier need the new configuration/);
  const rotated = readJson(join(own, 'hy2.json'));
  assert.notEqual(rotated.password, cfg.password);
  assert.equal(rotated.fingerprint, cfg.fingerprint);

  assert.match(ok(run(c, ['hy2', 'init', 'box', '--server', 'hy2.example.net'])), /new certificate \(the old one does not name hy2\.example\.net\)/);
  const renamed = readJson(join(own, 'hy2.json'));
  assert.notEqual(renamed.fingerprint, cfg.fingerprint);
  assert.equal(renamed.sni, 'hy2.example.net');
  assert.match(new X509Certificate(readFileSync(join(state, 'tls/server.crt'))).subjectAltName, /DNS:hy2\.example\.net/);
  assert.match(readFileSync(join(own, 'client.yaml'), 'utf8'), /sni: "hy2\.example\.net"/);

  ok(run(c, ['hy2', 'init', 'box', '--new-cert']));
  assert.notEqual(readJson(join(own, 'hy2.json')).fingerprint, renamed.fingerprint);
});

test('the default and subscriptions mihomo-client instances are never taken: their ports and names are refused', () => {
  const c = newCase();
  ok(run(c, ['edge', 'add', 'box', '--host', '203.0.113.10']));
  for (const port of ['7788', '7890']) {
    const refused = run(c, ['hy2', 'init', 'box', '--local-port', port]);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, new RegExp(`local port ${port} belongs to the (default mihomo-client instance|mihomo-client subscriptions instance)`));
  }
  for (const instance of ['default', 'subscriptions', 'Hy2']) {
    const refused = run(c, ['hy2', 'init', 'box', '--instance', instance]);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /--instance/);
  }
  assert.ok(!existsSync(join(c.home, 'hy2/box/hy2.json')), 'a refused init writes nothing');

  ok(run(c, ['hy2', 'init', 'box', '--local-port', '17995']));
  ok(run(c, ['edge', 'add', 'Box_2', '--host', '203.0.113.11']));
  const taken = run(c, ['hy2', 'init', 'Box_2', '--local-port', '17995']);
  assert.equal(taken.status, 2);
  assert.match(taken.stderr, /already the hy2 port of box/);
  ok(run(c, ['hy2', 'init', 'Box_2']));
  const second = readJson(join(c.home, 'hy2/Box_2/hy2.json'));
  assert.notEqual(second.localPort, 17995);
  assert.equal(second.instance, 'hy2-box-2');
});

test('export: the client configuration, or a hysteria2:// link pinned to the certificate', () => {
  const c = newCase();
  ok(run(c, ['edge', 'add', 'box', '--host', '203.0.113.10']));
  ok(run(c, ['hy2', 'init', 'box', '--obfs']));
  const cfg = readJson(join(c.home, 'hy2/box/hy2.json'));
  const yaml = run(c, ['hy2', 'export', 'box']);
  assert.equal(yaml.stdout, readFileSync(join(c.home, 'hy2/box/client.yaml'), 'utf8'));
  assert.match(yaml.stderr, /carries box's password/);
  const uri = new URL(ok(run(c, ['hy2', 'export', 'box', '--format', 'uri'])).trim());
  assert.equal(uri.protocol, 'hysteria2:');
  assert.equal(decodeURIComponent(uri.username), cfg.password);
  assert.equal(uri.hostname, '203.0.113.10');
  assert.equal(uri.port, '443');
  assert.equal(uri.searchParams.get('insecure'), '1');
  assert.equal(uri.searchParams.get('pinSHA256'), cfg.fingerprint.replace(/:/g, '').toLowerCase());
  assert.equal(uri.searchParams.get('obfs'), 'salamander');
  assert.equal(uri.searchParams.get('obfs-password'), cfg.obfsPassword);
  assert.equal(uri.hash, '#hy2-box');
});

test('the generated configurations load in the real engine', { skip: !hereEngine && 'no engine for this platform in the workspace' }, () => {
  const c = newCase();
  ok(run(c, ['edge', 'add', 'box', '--host', '203.0.113.10']));
  ok(run(c, ['hy2', 'init', 'box', '--obfs', '--up', '50', '--down', '200', '--server', 'hy2.example.net', '--bind', '0.0.0.0']));
  const state = join(c.home, 'state/box/hy2');
  const own = join(c.home, 'hy2/box');
  const client = readFileSync(join(own, 'client.yaml'), 'utf8');
  assert.match(client, /bind-address: "\*"/);
  assert.match(client, /lan-allowed-ips:\n {2}- 127\.0\.0\.0\/8/);
  assert.match(client, / {4}up: 50\n {4}down: 200\n/);
  for (const [dir, file] of [[state, 'server.yaml'], [own, 'client.yaml']]) {
    const checked = spawnSync(hereMihomo(), ['-t', '-d', dir, '-f', join(dir, file)], { encoding: 'utf8' });
    assert.equal(checked.status, 0, `${file}:\n${checked.stdout}${checked.stderr}`);
    assert.match(checked.stdout, /test is successful/);
  }
});

test('end to end on this machine: the generated server, hy2 run, and hy2 test through it', { skip: !hereEngine && 'no engine for this platform in the workspace', timeout: 120000 }, async () => {
  const c = newCase();
  // The far end, as the server sees it: an sshd banner and a page that answers with an address.
  const sshd = net.createServer((socket) => socket.end('SSH-2.0-FakeForHy2\r\n'));
  // /text answers as myip.ipip.net does: the address inside a sentence.
  const web = http.createServer((request, response) => response.end(request.url.startsWith('/text') ? '当前 IP：203.0.113.98  来自于：测试\n' : '203.0.113.99\n'));
  await new Promise((r) => sshd.listen(0, '127.0.0.1', r));
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const udp = await freeUdpPort();
  const local = await freeTcpPort();
  try {
    ok(run(c, ['edge', 'add', 'box', '--host', '127.0.0.1']));
    // Also on a non-loopback address of this machine, as --bind docker does with the Docker bridges.
    ok(run(c, ['hy2', 'init', 'box', '--port', String(udp), '--local-port', String(local), ...(lanAddress ? ['--bind', lanAddress] : [])]));
    const state = join(c.home, 'state/box/hy2');
    const server = background(hereMihomo(), ['-d', state, '-f', join(state, 'server.yaml')], {});
    const client = background(process.execPath, [cli, 'hy2', 'run', 'box'], { env: env(c, { QP_HY2_MIHOMO: hereMihomo() }) });
    await waitForPort(local);
    const args = ['hy2', 'test', 'box', '--ssh-port', String(sshd.address().port), '--ip-url', `http://127.0.0.1:${web.address().port}/`];
    const passed = await new Promise((r) => {
      const child = spawn(process.execPath, [cli, ...args], { env: env(c) });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('close', (status) => r({ status, stdout }));
    });
    assert.equal(passed.status, 0, passed.stdout);
    assert.match(passed.stdout, /ok {4}box's own sshd answered through the tunnel \(SSH-2\.0-FakeForHy2\)/);
    assert.match(passed.stdout, /ok {4}exit address 203\.0\.113\.99/);
    if (lanAddress) assert.ok(passed.stdout.includes(`ok    the local port also answers on ${lanAddress}:${local}`), passed.stdout);
    if (lanAddress) {
      const viaLan = await new Promise((resolveGet, rejectGet) => {
        http.get({ host: lanAddress, port: local, path: `http://127.0.0.1:${web.address().port}/`, headers: { Host: `127.0.0.1:${web.address().port}` } }, (response) => {
          let body = '';
          response.on('data', (chunk) => { body += chunk; });
          response.on('end', () => resolveGet(body.trim()));
        }).on('error', rejectGet);
      });
      assert.equal(viaLan, '203.0.113.99', `the port also answers on ${lanAddress}`);
    }

    // A site the host cannot reach is passed over for the next one; an address inside text is picked out.
    const dead = await freeTcpPort();
    const fallback = await new Promise((r) => {
      const child = spawn(process.execPath, [cli, 'hy2', 'test', 'box', '--ssh-port', String(sshd.address().port), '--ip-url', `http://127.0.0.1:${dead}/,http://127.0.0.1:${web.address().port}/text`], { env: env(c) });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('close', (status) => r({ status, stdout }));
    });
    assert.equal(fallback.status, 0, fallback.stdout);
    assert.ok(fallback.stdout.includes(`ok    exit address 203.0.113.98 (http://127.0.0.1:${web.address().port}/text; http://127.0.0.1:${dead}/ gave HTTP 502)`), fallback.stdout);

    stop(server);
    const failed = await new Promise((r) => {
      const child = spawn(process.execPath, [cli, ...args, '--timeout', '2', '--no-diagnose'], { env: env(c) });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('close', (status) => r({ status, stdout }));
    });
    assert.equal(failed.status, 1, failed.stdout);
    assert.match(failed.stdout, /FAIL {2}no answer through the tunnel/);
    assert.match(failed.stdout, new RegExp(`udp ${udp} is not allowed by box's cloud security group`));
    stop(client);
  } finally {
    sshd.close();
    web.close();
  }
});

test('push: the probe moves off a busy udp port; the bundle carries the linux engine, the state only the server side; an unchanged server is not pushed again', { skip: !linuxX64Engine && 'no linux-x64 engine in the workspace', timeout: 180000 }, () => {
  const c = newCase();
  ok(run(c, ['edge', 'add', 'box', '--host', '203.0.113.10']));
  const probe = 'arch=x86_64\nunit=inactive\ncurrent=\nss=1\nudp=0.0.0.0:443\nudp=127.0.0.53%lo:53\n';
  const out = ok(run(c, ['hy2', 'push', 'box', '--yes'], { FAKE_PROBE: probe }));
  assert.match(out, /x86_64 \(linux-x64\), unit qp-edge-hy2\.service inactive, 2 udp listener\(s\)/);
  assert.match(out, /udp 443 is in use on box; using 8443/);
  assert.match(out, /engine {5}workspace tunnel-engines\/linux-x64 \(linux-x64\)/);
  assert.match(out, /adds {7}engine\/mihomo\.gz \(\d+ KiB\), engine\/target/);
  assert.match(out, /Done: hy2 \S+ is current on box, managed from internal-a/);

  const cfg = readJson(join(c.home, 'hy2/box/hy2.json'));
  assert.equal(cfg.port, 8443);
  assert.equal(cfg.pushed.target, 'linux-x64');
  assert.match(cfg.pushed.revision, /^\d{8}-\d{6}$/);

  const [bundle] = captured(c, 'bundle');
  const files = tarList(bundle);
  for (const file of ['engine/mihomo.gz', 'engine/target', 'engine/source', 'deploy.sh', 'health.sh', 'stack.env', 'lib/edge-os.sh']) {
    assert.ok(files.includes(file), `bundle has ${file}: ${files.join(', ')}`);
  }
  assert.equal(tarRead(bundle, 'engine/target').trim(), 'linux-x64');
  assert.ok(!files.some((file) => /client\.yaml|hy2\.json|server\.key/.test(file)), 'no secrets in the bundle');
  const [stateTar] = captured(c, 'state');
  assert.deepEqual(tarList(stateTar).filter((file) => !file.endsWith('/')).sort(), ['hy2.env', 'server.yaml', 'tls/server.crt', 'tls/server.key']);
  assert.equal(tarRead(stateTar, 'hy2.env').split('\n')[1], 'HY2_PORT=8443');

  const calls = readFileSync(c.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls[0].at(-1), 'sh -s', 'the probe runs first, read-only');
  assert.ok(calls.some((args) => args.at(-1).includes(`activate hy2 ${cfg.pushed.revision} /opt/mx/incoming/hy2-${cfg.pushed.revision}.tar.gz`)));
  const ledger = readFileSync(join(c.home, 'ledger.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(ledger.map((entry) => [entry.action, entry.stack, entry.result]), [['push', 'hy2', 'ok']]);

  // The host now runs it: up leaves it alone.
  const running = `arch=x86_64\nunit=active\ncurrent=/opt/mx/releases/hy2/${cfg.pushed.revision}\nss=1\nudp=0.0.0.0:443\nudp=0.0.0.0:8443\n`;
  const same = ok(run(c, ['hy2', 'up', 'box', '--no-connect', '--yes'], { FAKE_PROBE: running }));
  assert.match(same, new RegExp(`already runs this server \\(revision ${cfg.pushed.revision}, unit active\\); not pushed again`));
  assert.equal(captured(c, 'bundle').length, 1);
  assert.equal(readJson(join(c.home, 'hy2/box/hy2.json')).port, 8443, 'its own port is not a clash');

  // A changed setting is pushed.
  const moved = ok(run(c, ['hy2', 'up', 'box', '--no-connect', '--yes', '--port', '9443', '--revision', 'r2'], { FAKE_PROBE: running }));
  assert.match(moved, /server port 8443 -> 9443\/udp/);
  assert.equal(captured(c, 'bundle').length, 2);
  assert.equal(readJson(join(c.home, 'hy2/box/hy2.json')).pushed.revision, 'r2');

  // An explicit port another program holds is refused before anything is pushed.
  const busy = run(c, ['hy2', 'push', 'box', '--yes', '--port', '443'], { FAKE_PROBE: running });
  assert.equal(busy.status, 1);
  assert.match(busy.stderr, /udp 443 is already in use on box/);
  assert.equal(captured(c, 'bundle').length, 2);
});

test('push: an architecture without an engine stops after the read-only probe', () => {
  const c = newCase();
  ok(run(c, ['edge', 'add', 'box', '--host', '203.0.113.10']));
  const refused = run(c, ['hy2', 'push', 'box', '--yes'], { FAKE_PROBE: 'arch=mips\nunit=inactive\ncurrent=\nss=0\n' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /box is mips; engines exist for x86_64 and aarch64/);
  assert.equal(captured(c, 'bundle').length, 0);
});

test('a plain edge push of the hy2 stack stops before connecting: only hy2 push adds the engine', () => {
  const c = newCase();
  ok(run(c, ['edge', 'add', 'box', '--host', '203.0.113.10']));
  ok(run(c, ['hy2', 'init', 'box']));
  const refused = run(c, ['edge', 'push', 'box', '--stack', 'hy2', '--yes']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /the bundle for stack hy2 lacks engine\/mihomo\.gz, engine\/target\. push this stack with qp-tunnel-cli hy2 push <host>/);
  assert.ok(!existsSync(c.log), 'nothing connected');
  assert.match(ok(run(c, ['edge', 'push', 'box', '--stack', 'hy2', '--dry-run'])), /lacks {6}engine\/mihomo\.gz, engine\/target/);
});

test('remote preflight refuses a bundle without the files its stack requires, before anything is written', () => {
  const c = newCase();
  const root = join(c.dir, 'opt-mx');
  const bundle = join(c.dir, 'bundle');
  mkdirSync(join(root, 'incoming'), { recursive: true });
  mkdirSync(bundle);
  writeFileSync(join(bundle, 'stack.env'), 'STACK_NAME=demo\nSTACK_BUNDLE_REQUIRED="engine/mihomo.gz"\nSTACK_BUNDLE_HINT="push it with the tool that adds the engine"\n');
  writeFileSync(join(bundle, 'deploy.sh'), 'touch "$MX_STATE_DIR/ran"\n');
  const tarball = join(root, 'incoming/demo-r1.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', tarball, '-C', bundle, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } }).status, 0);
  const script = Buffer.concat([readFileSync(join(edgeDir, 'lib/edge-os.sh')), Buffer.from('\n'), readFileSync(join(edgeDir, 'remote.sh'))]);
  const result = spawnSync('bash', ['-s', '--', 'activate', 'demo', 'r1', tarball], {
    input: script,
    encoding: 'utf8',
    env: { ...process.env, MX_ROOT: root, EDGE_ORIGIN: 'internal-a' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /the bundle for stack demo lacks: engine\/mihomo\.gz/);
  assert.match(result.stderr, /push it with the tool that adds the engine/);
  assert.ok(!existsSync(join(root, 'current/demo')));
  assert.ok(!existsSync(join(root, 'releases/demo/r1')));
});

test('deploy.sh: unpacks and checks the engine, writes its own unit, restarts only on change, refuses a foreign unit, a busy port or a wrong engine', { skip: !hereEngine && 'no engine for this platform in the workspace', timeout: 120000 }, () => {
  const c = newCase();
  ok(run(c, ['edge', 'add', 'box', '--host', '203.0.113.10']));
  ok(run(c, ['hy2', 'init', 'box', '--port', '18443']));
  const release = join(c.dir, 'releases/hy2/r1');
  const stateDir = join(c.dir, 'state/hy2');
  const units = join(c.dir, 'units');
  const sysctlDir = join(c.dir, 'sysctl.d');
  const bin = join(c.dir, 'bin');
  for (const dir of [units, sysctlDir, bin]) mkdirSync(dir, { recursive: true });
  cpSync(hy2Stack, release, { recursive: true });
  mkdirSync(join(release, 'lib'));
  copyFileSync(join(edgeDir, 'lib/edge-nginx.sh'), join(release, 'lib/edge-nginx.sh'));
  // This machine has no systemd: the stand-ins below play it, so the systemd requirement is lifted for the test only.
  writeFileSync(join(release, 'lib/edge-os.sh'), `${readFileSync(join(edgeDir, 'lib/edge-os.sh'), 'utf8')}\nedge_require_systemd() { :; }\n`);
  const machine = spawnSync('uname', ['-m'], { encoding: 'utf8' }).stdout.trim();
  const want = ['x86_64', 'amd64'].includes(machine) ? 'linux-x64' : 'linux-arm64';
  mkdirSync(join(release, 'engine'));
  copyFileSync(hereEngine, join(release, 'engine/mihomo.gz'));
  writeFileSync(join(release, 'engine/target'), `${want}\n`);
  writeFileSync(join(release, 'engine/source'), 'workspace (test)\n');
  const syncState = () => cpSync(join(c.home, 'state/box/hy2'), stateDir, { recursive: true });
  syncState();

  const log = join(c.dir, 'systemctl.log');
  const unitState = join(c.dir, 'unit-state');
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh
echo "$*" >> "$FAKE_LOG"
case "$1" in
  is-active) s="$(cat "$FAKE_UNIT_STATE" 2>/dev/null || echo inactive)"; echo "$s"; [ "$s" = active ] ;;
  show) echo "MainPID=\${FAKE_MAINPID:-0}" ;;
  restart) echo active > "$FAKE_UNIT_STATE" ;;
  *) exit 0 ;;
esac
`);
  writeFileSync(join(bin, 'ss'), `#!/bin/sh
printf 'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\\n'
[ -z "$FAKE_SS_LINE" ] || printf '%s\\n' "$FAKE_SS_LINE"
`);
  writeFileSync(join(bin, 'sysctl'), '#!/bin/sh\ncase "$1" in -n) echo 212992 ;; esac\nexit 0\n');
  writeFileSync(join(bin, 'journalctl'), '#!/bin/sh\nexit 0\n');
  if (spawnSync('sh', ['-c', 'command -v sha256sum'], { stdio: 'ignore' }).status !== 0) {
    writeFileSync(join(bin, 'sha256sum'), '#!/bin/sh\nexec shasum -a 256 "$@"\n');
  }
  for (const file of readdirSync(bin)) chmodSync(join(bin, file), 0o755);

  const deploy = (extra = {}, hook = 'deploy.sh') => spawnSync('bash', [`./${hook}`], {
    cwd: release,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MX_COMPONENT: 'hy2', MX_REVISION: 'r1', MX_RELEASE_DIR: release, MX_STATE_DIR: stateDir, MX_ROOT: c.dir, MX_PREVIOUS_RELEASE: '',
      EDGE_SYSTEMD_DIR: units, EDGE_SYSCTL_DIR: sysctlDir, FAKE_LOG: log, FAKE_UNIT_STATE: unitState,
      ...extra,
    },
  });
  const restarts = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((line) => line === 'restart qp-edge-hy2.service').length : 0);

  const first = deploy();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.ok(statSync(join(release, 'bin/mihomo')).mode & 0o100, 'the engine is unpacked and executable');
  assert.match(first.stdout, /engine: Mihomo Meta v\S+ .*\(workspace \(test\)\)/);
  const unit = readFileSync(join(units, 'qp-edge-hy2.service'), 'utf8');
  assert.match(unit, /^# qp-tunnel-cli hy2 \(edge component hy2\)/);
  assert.ok(unit.includes(`ExecStart=${c.dir}/current/hy2/bin/mihomo -d ${stateDir} -f ${stateDir}/server.yaml`));
  assert.match(unit, /Restart=always/);
  assert.match(readFileSync(log, 'utf8'), /^daemon-reload$/m);
  assert.match(readFileSync(log, 'utf8'), /^enable qp-edge-hy2\.service$/m);
  assert.equal(restarts(), 1);
  assert.match(first.stdout, /qp-edge-hy2\.service \(re\)started on udp 18443/);
  assert.match(readFileSync(join(sysctlDir, '90-qp-hy2.conf'), 'utf8'), /net\.core\.rmem_max = 16777216/);

  const unchanged = deploy();
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.match(unchanged.stdout, /unchanged and qp-edge-hy2\.service running; left it running \(no client drop\)/);
  assert.equal(restarts(), 1);

  ok(run(c, ['hy2', 'init', 'box', '--rotate-password']));
  syncState();
  assert.equal(deploy().status, 0);
  assert.equal(restarts(), 2, 'a changed server.yaml restarts it');

  const other = 'UNCONN 0 0 0.0.0.0:18443 0.0.0.0:* users:(("other",pid=999,fd=3))';
  const busy = deploy({ FAKE_SS_LINE: other, FAKE_MAINPID: '1234' });
  assert.equal(busy.status, 1);
  assert.match(busy.stderr, /udp port 18443 is already in use on this host/);
  assert.equal(deploy({ FAKE_SS_LINE: other.replace('pid=999', 'pid=1234'), FAKE_MAINPID: '1234' }).status, 0, 'its own process is no clash');

  const health = deploy({ FAKE_SS_LINE: other.replace('pid=999', 'pid=1234'), FAKE_MAINPID: '1234' }, 'health.sh');
  assert.equal(health.status, 0, health.stderr);
  assert.match(health.stdout, /qp-edge-hy2\.service active, (udp 18443 is listening|listening on udp 18443)/);

  const config = readFileSync(join(stateDir, 'server.yaml'), 'utf8');
  writeFileSync(join(stateDir, 'server.yaml'), config.replace('type: hysteria2', 'type: no-such-listener'));
  const rejected = deploy();
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /the engine rejects server\.yaml; nothing was restarted/);
  assert.equal(restarts(), 2);
  writeFileSync(join(stateDir, 'server.yaml'), config);

  writeFileSync(join(release, 'engine/target'), 'linux-mips\n');
  const wrongEngine = deploy();
  assert.equal(wrongEngine.status, 1);
  assert.match(wrongEngine.stderr, new RegExp(`the bundle carries the linux-mips engine; this host needs ${want}`));
  writeFileSync(join(release, 'engine/target'), `${want}\n`);

  writeFileSync(join(units, 'qp-edge-hy2.service'), '[Unit]\nDescription=someone else\n');
  const foreign = deploy();
  assert.equal(foreign.status, 1);
  assert.match(foreign.stderr, /qp-edge-hy2\.service exists and was not written by qp-tunnel-cli hy2; nothing was changed/);
  assert.equal(readFileSync(join(units, 'qp-edge-hy2.service'), 'utf8'), '[Unit]\nDescription=someone else\n');
});

test('status and show list what this machine set up, without secrets', () => {
  const c = newCase();
  assert.match(ok(run(c, ['hy2', 'status'])), /No hy2 set up from this machine yet/);
  ok(run(c, ['edge', 'add', 'box', '--host', '203.0.113.10']));
  ok(run(c, ['hy2', 'init', 'box', '--local-port', '17993']));
  const cfg = readJson(join(c.home, 'hy2/box/hy2.json'));
  const status = ok(run(c, ['hy2', 'status']));
  assert.match(status, /box\s+203\.0\.113\.10:443\/udp\s+127\.0\.0\.1:17993\s+hy2-box\s+\S+, not listening\s+never/);
  const json = JSON.parse(ok(run(c, ['hy2', 'status', '--json'])));
  assert.equal(json[0].local, '127.0.0.1:17993');
  const show = ok(run(c, ['hy2', 'show', 'box']));
  assert.ok(!show.includes(cfg.password) && !status.includes(cfg.password) && !JSON.stringify(json).includes(cfg.password));
  const missing = run(c, ['hy2', 'show', 'other']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no hy2 set up for other on this machine/);
});

test('test waits for a local port that starts listening a moment after the unit was started', { timeout: 60000 }, async () => {
  const c = newCase();
  const local = await freeTcpPort();
  ok(run(c, ['edge', 'add', 'box', '--host', '203.0.113.10']));
  ok(run(c, ['hy2', 'init', 'box', '--local-port', String(local)]));
  const child = spawn(process.execPath, [cli, 'hy2', 'test', 'box', '--no-ip', '--timeout', '5'], { env: env(c) });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const done = new Promise((r) => child.on('close', (status) => r(status)));
  // A SOCKS5 port that comes up 1.5 s late and answers CONNECT with an sshd banner, as mihomo would.
  await new Promise((r) => setTimeout(r, 1500));
  const socks = net.createServer((socket) => {
    let stage = 0;
    socket.on('data', () => {
      if (stage === 0) { socket.write(Buffer.from([5, 0])); stage = 1; return; }
      if (stage === 1) { socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); socket.end('SSH-2.0-Late\r\n'); stage = 2; }
    });
    socket.on('error', () => {});
  });
  await new Promise((r) => socks.listen(local, '127.0.0.1', r));
  try {
    const status = await done;
    assert.equal(status, 0, stdout);
    assert.match(stdout, /ok {4}box's own sshd answered through the tunnel \(SSH-2\.0-Late\)/);
  } finally {
    socks.close();
  }
});

test('--bind: loopback always stays; docker, addresses of this machine, or every interface for private sources', { skip: !lanAddress && 'no non-loopback IPv4 address here' }, () => {
  const c = newCase();
  ok(run(c, ['edge', 'add', 'box', '--host', '203.0.113.10']));
  ok(run(c, ['hy2', 'init', 'box', '--local-port', '17996']));
  const client = () => readFileSync(join(c.home, 'hy2/box/client.yaml'), 'utf8');
  assert.match(client(), /^allow-lan: false$/m);
  assert.ok(!client().includes('listeners:'));

  const out = ok(run(c, ['hy2', 'init', 'box', '--bind', lanAddress]));
  assert.match(out, new RegExp(`local {6}127\\.0\\.0\\.1:17996 and ${lanAddress.replace(/\./g, '\\.')}:17996`));
  assert.match(out, /it has no password, so whoever reaches it there can use it/);
  assert.equal(readJson(join(c.home, 'hy2/box/hy2.json')).bind, `127.0.0.1,${lanAddress}`);
  assert.match(client(), /^allow-lan: false$/m);
  assert.ok(client().includes(`listeners:\n  - name: "local-${lanAddress}"\n    type: mixed\n    listen: ${lanAddress}\n    port: 17996\n`));

  const absent = run(c, ['hy2', 'init', 'box', '--bind', '198.51.100.250']);
  assert.equal(absent.status, 2);
  assert.match(absent.stderr, /--bind 198\.51\.100\.250 is not an address of this machine/);
  const junk = run(c, ['hy2', 'init', 'box', '--bind', 'eth0']);
  assert.equal(junk.status, 2);
  assert.match(junk.stderr, /--bind takes 127\.0\.0\.1, 0\.0\.0\.0, docker, or IPv4 addresses/);

  const docker = run(c, ['hy2', 'init', 'box', '--bind', 'docker']);
  if (dockerAddresses.length === 0) {
    assert.equal(docker.status, 2);
    assert.match(docker.stderr, /--bind docker: this machine has no Docker bridge \(docker0, br-\*\) right now/);
  } else {
    ok(docker);
    for (const address of dockerAddresses) assert.ok(client().includes(`    listen: ${address}\n`), address);
  }

  ok(run(c, ['hy2', 'init', 'box', '--bind', `0.0.0.0,${lanAddress}`]));
  assert.equal(readJson(join(c.home, 'hy2/box/hy2.json')).bind, '0.0.0.0');
  assert.match(client(), /^allow-lan: true\nbind-address: "\*"\nlan-allowed-ips:\n {2}- 127\.0\.0\.0\/8\n(.*\n)*? {2}- 172\.16\.0\.0\/12\n/m);
  assert.ok(!client().includes('listeners:'));

  // Exported for another machine: 127.0.0.1 there unless asked; this machine's Docker bridges never.
  assert.match(ok(run(c, ['hy2', 'export', 'box'])), /^allow-lan: false$/m);
  assert.match(ok(run(c, ['hy2', 'export', 'box', '--bind', '0.0.0.0'])), /^bind-address: "\*"$/m);
  const exportDocker = run(c, ['hy2', 'export', 'box', '--bind', 'docker']);
  assert.equal(exportDocker.status, 2);
  assert.match(exportDocker.stderr, /names this machine's Docker bridges/);
});

test('a configuration with extra listeners loads in the real engine', { skip: (!hereEngine || !lanAddress) && 'no engine or no non-loopback address here' }, () => {
  const c = newCase();
  ok(run(c, ['edge', 'add', 'box', '--host', '203.0.113.10']));
  ok(run(c, ['hy2', 'init', 'box', '--bind', lanAddress]));
  const own = join(c.home, 'hy2/box');
  const checked = spawnSync(hereMihomo(), ['-t', '-d', own, '-f', join(own, 'client.yaml')], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
});

test('docker0 with no container still counts: `ip` lists links that Node leaves out', () => {
  const sample = [
    '1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever',
    '2: eth0    inet 10.0.0.5/24 brd 10.0.0.255 scope global eth0\\       valid_lft forever preferred_lft forever',
    '3: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\\       valid_lft forever preferred_lft forever',
    '5: br-1a2b3c4d5e6f    inet 172.18.0.1/16 brd 172.18.255.255 scope global br-1a2b3c4d5e6f\\       valid_lft forever preferred_lft forever',
    '9: wg0@NONE    inet 10.253.0.1/24 scope global wg0\\       valid_lft forever preferred_lft forever',
    '',
  ].join('\n');
  assert.deepEqual(hy2Module.parseIpAddr(sample), [
    { name: 'lo', address: '127.0.0.1' },
    { name: 'eth0', address: '10.0.0.5' },
    { name: 'docker0', address: '172.17.0.1' },
    { name: 'br-1a2b3c4d5e6f', address: '172.18.0.1' },
    { name: 'wg0', address: '10.253.0.1' },
  ]);
});

test('a failed local install leaves hy2 status honest: "not applied" until an install succeeds', () => {
  const c = newCase();
  const clientLog = join(c.dir, 'client.log');
  const fakeClient = join(c.dir, 'fake-mihomo-client.sh');
  writeFileSync(fakeClient, `#!/bin/sh
echo "$*" >> "${clientLog}"
if [ -n "$FAKE_CLIENT_FAIL" ]; then echo "cp: cannot create regular file '/usr/local/bin/mihomo-hy2-box': Text file busy" >&2; exit 1; fi
echo "Mihomo client installed and started."
`, { mode: 0o755 });
  const fakeSystemctl = join(c.dir, 'fake-systemctl');
  writeFileSync(fakeSystemctl, '#!/bin/sh\necho active\n', { mode: 0o755 });
  const fakeMihomo = join(c.dir, 'mihomo');
  writeFileSync(fakeMihomo, '#!/bin/sh\n', { mode: 0o755 });
  const here = { QP_HY2_ASSUME_SYSTEMD: '1', QP_EDGE_SUDO: '', QP_HY2_SYSTEMCTL: fakeSystemctl, QP_HY2_CLIENT_SCRIPT: fakeClient, QP_HY2_MIHOMO: fakeMihomo };
  const statusJson = () => JSON.parse(ok(run(c, ['hy2', 'status', '--json'], here)))[0];
  ok(run(c, ['edge', 'add', 'box', '--host', '203.0.113.10']));
  ok(run(c, ['hy2', 'init', 'box', '--local-port', '17995']));
  assert.equal(statusJson().applied, 'unknown');

  ok(run(c, ['hy2', 'connect', 'box', '--no-test'], here));
  const first = readJson(join(c.home, 'hy2/box/hy2.json')).applied;
  assert.match(first.digest, /^[0-9a-f]{64}$/);
  assert.equal(statusJson().applied, 'applied');
  assert.match(readFileSync(clientLog, 'utf8'), /^install --instance hy2-box --mixed-port 17995 --file \S+client\.yaml --binary-path \S+mihomo$/m);

  const failed = run(c, ['hy2', 'connect', 'box', '--bind', '0.0.0.0', '--no-test'], { ...here, FAKE_CLIENT_FAIL: '1' });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /Local port 127\.0\.0\.1:17995 -> 0\.0\.0\.0:17995/);
  assert.match(failed.stderr, /Text file busy/);
  assert.match(failed.stderr, /install --instance hy2-box failed \(exit 1\)\. The local port keeps what it had before; hy2 status shows "not applied"/);
  assert.match(failed.stderr, /try again {2}qp-tunnel-cli hy2 connect box/);
  const kept = readJson(join(c.home, 'hy2/box/hy2.json'));
  assert.equal(kept.bind, '0.0.0.0');
  assert.deepEqual(kept.applied, first);
  assert.equal(statusJson().applied, 'not applied');
  const table = ok(run(c, ['hy2', 'status'], here));
  assert.match(table, /0\.0\.0\.0:17995 +hy2-box +active, not listening, not applied/);
  assert.match(table, /box: the local instance does not run these settings \(LOCAL 0\.0\.0\.0:17995 .*\)\. Apply: qp-tunnel-cli hy2 connect box/);
  assert.match(ok(run(c, ['hy2', 'show', 'box'], here)), /this side {2}active, not running these settings \(qp-tunnel-cli hy2 connect box\)/);

  // Retrying applies what hy2.json already says.
  ok(run(c, ['hy2', 'connect', 'box', '--no-test'], here));
  assert.equal(statusJson().applied, 'applied');
  assert.doesNotMatch(ok(run(c, ['hy2', 'status'], here)), /not applied/);
});

test('--bind 0.0.0.0 also lets this machine in through its own public address (Docker masquerades it there); export leaves it out', () => {
  const c = newCase();
  const fakeIp = join(c.dir, 'fake-ip');
  writeFileSync(fakeIp, `#!/bin/sh
cat <<'OUT'
1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever
2: eth0    inet 203.0.113.7/24 brd 203.0.113.255 scope global eth0\\       valid_lft forever preferred_lft forever
3: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\\       valid_lft forever preferred_lft forever
5: br-1a2b3c4d5e6f    inet 172.18.0.1/16 brd 172.18.255.255 scope global br-1a2b3c4d5e6f\\       valid_lft forever preferred_lft forever
OUT
`, { mode: 0o755 });
  const here = { QP_HY2_IP: fakeIp };
  ok(run(c, ['edge', 'add', 'box', '--host', '198.51.100.20'], here));
  ok(run(c, ['hy2', 'init', 'box', '--local-port', '17994', '--bind', '0.0.0.0'], here));
  const own = join(c.home, 'hy2/box');
  const client = readFileSync(join(own, 'client.yaml'), 'utf8');
  assert.match(client, /lan-allowed-ips:\n(  - .*\n)*  - fc00::\/7\n  - 203\.0\.113\.7\/32\nmode: rule\n/);
  assert.ok(!client.includes('172.17.0.1/32'), 'private addresses are covered already');
  if (hereEngine) {
    const checked = spawnSync(hereMihomo(), ['-t', '-d', own, '-f', join(own, 'client.yaml')], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  }
  assert.ok(!ok(run(c, ['hy2', 'export', 'box', '--bind', '0.0.0.0'], here)).includes('203.0.113.7'));

  // docker0 counts although Node would leave it out with no container attached.
  ok(run(c, ['hy2', 'init', 'box', '--bind', 'docker'], here));
  const docker = readFileSync(join(own, 'client.yaml'), 'utf8');
  for (const address of ['172.17.0.1', '172.18.0.1']) assert.ok(docker.includes(`    listen: ${address}\n`), address);
  assert.ok(!docker.includes('203.0.113.7'));
  ok(run(c, ['hy2', 'init', 'box', '--bind', '203.0.113.7'], here));
});

test('hy2 test checks the other addresses too: a port that closes at once there is named', { skip: !lanAddress && 'no non-loopback IPv4 address here', timeout: 60000 }, async () => {
  const c = newCase();
  const local = await freeTcpPort();
  ok(run(c, ['edge', 'add', 'box', '--host', '203.0.113.10']));
  ok(run(c, ['hy2', 'init', 'box', '--local-port', String(local), '--bind', lanAddress]));
  // 127.0.0.1: a SOCKS5 port whose tunnel is dead. The LAN address: refused sources, as mihomo does.
  const loopback = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', () => {
      socket.write(Buffer.from([5, 0]));
      socket.once('data', () => socket.destroy());
    });
  });
  const lan = net.createServer((socket) => { socket.on('error', () => {}); socket.destroy(); });
  await new Promise((r) => loopback.listen(local, '127.0.0.1', r));
  await new Promise((r) => lan.listen(local, lanAddress, r));
  try {
    const result = await new Promise((r) => {
      const child = spawn(process.execPath, [cli, 'hy2', 'test', 'box', '--no-ip', '--timeout', '2', '--no-diagnose'], { env: env(c) });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('close', (status) => r({ status, stdout }));
    });
    assert.equal(result.status, 1);
    assert.ok(result.stdout.includes(`FAIL  ${lanAddress}:${local}: closed the connection at once: mihomo refused the source address this machine used`), result.stdout);
    assert.match(result.stdout, /from a container: docker exec -e http_proxy=http:\/\/<its gateway>:\d+ <container> wget -qO- http:\/\/api\.ipify\.org\//);
  } finally {
    loopback.close();
    lan.close();
  }
});

// A local port that accepts SOCKS5 and then drops every connection: mihomo when the server cannot be reached.
async function withDeadProxy(c, args, diag, extra = {}) {
  const local = await freeTcpPort();
  ok(run(c, ['edge', 'add', 'box', '--host', '203.0.113.10']));
  ok(run(c, ['hy2', 'init', 'box', '--local-port', String(local)]));
  const stub = net.createServer((socket) => {
    socket.once('data', () => {
      socket.write(Buffer.from([5, 0]));
      socket.once('data', () => socket.destroy());
    });
    socket.on('error', () => {});
  });
  await new Promise((r) => stub.listen(local, '127.0.0.1', r));
  try {
    return await new Promise((r) => {
      const child = spawn(process.execPath, [cli, 'hy2', 'test', 'box', '--no-ip', '--timeout', '2', ...args], { env: env(c, { FAKE_DIAG: diag, ...extra }) });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('close', (status) => r({ status, stdout }));
    });
  } finally {
    stub.close();
  }
}

const serving = 'unit=active\npid=1234\nholder=UNCONN 0 0 0.0.0.0:443 0.0.0.0:* users:(("mihomo",pid=1234,fd=7))\n';
const packetIn = 'pkt=12:00:00.100000 eth0  In  IP 198.51.100.7.53211 > 172.16.0.10.443: UDP, length 1252\n';
const packetOut = 'pkt=12:00:00.200000 eth0  Out IP 172.16.0.10.443 > 198.51.100.7.53211: UDP, length 1200\n';

test('diagnosis: nothing arrives at the host -> the security group (and udp 443 filtering)', { timeout: 60000 }, async () => {
  const c = newCase();
  const result = await withDeadProxy(c, [], `${serving}fw=none\ncapture=start\ncapture=done\n`);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /FAIL {2}no answer through the tunnel/);
  assert.match(result.stdout, /Looking at both ends \(read-only; tcpdump on box watches udp 443 for 9 s while this side sends\)/);
  assert.match(result.stdout, /box {10}qp-edge-hy2\.service active; udp 443: held by the server \(pid 1234\)/);
  assert.match(result.stdout, /tcpdump on udp 443 for 9 s: 0 packet\(s\) in, 0 out/);
  assert.match(result.stdout, /why\n {2}- nothing from this machine reached box on udp 443/);
  assert.match(result.stdout, /box's cloud security group must allow udp 443 inbound; Aliyun: 安全组 → 入方向 → UDP 443\/443/);
  assert.match(result.stdout, /a high port avoids that: allow udp 20443 there, then qp-tunnel-cli hy2 push box --port 20443 --yes/);
  const call = readFileSync(c.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).find((args) => args.at(-1).includes('qp-hy2-diagnose'));
  assert.ok(call, 'the host was asked');
  assert.match(call.at(-1), /^sh -c /, 'as root (the saved user is root)');
  assert.match(call.at(-1), /timeout 9 tcpdump -lnqi any -c 80 "udp port \$port"/);
});

test('diagnosis: packets arrive but get no answer -> the host firewall, with the command to open it', { timeout: 60000 }, async () => {
  const c = newCase();
  const result = await withDeadProxy(c, [], `${serving}fw=ufw-closed\ncapture=start\n${packetIn}${packetIn}capture=done\n`);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /2 packet\(s\) in from 198\.51\.100\.7, 0 out/);
  assert.match(result.stdout, /packets arrive at box \(2, from 198\.51\.100\.7\) but the server does not answer them/);
  assert.match(result.stdout, /box's ufw does not allow udp 443: qp-tunnel-cli edge ssh box -- 'ufw allow 443\/udp'/);
});

test('diagnosis: the server answers but nothing works here -> replies lost on the way back, or settings out of sync', { timeout: 60000 }, async () => {
  const c = newCase();
  const result = await withDeadProxy(c, [], `${serving}fw=none\ncapture=start\n${packetIn}${packetOut}capture=done\n`);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /the server answers \(1 packets back\), yet nothing works here/);
  assert.match(result.stdout, /qp-tunnel-cli hy2 push box --yes refreshes both/);
});

test('diagnosis: a stopped server, a port held by someone else, no tcpdump, an unreachable host', { timeout: 120000 }, async () => {
  const stopped = await withDeadProxy(newCase(), [], 'unit=failed\npid=0\nholder=\nfw=none\nlog=listen udp :443: bind: address already in use\ncapture=start\ncapture=done\n');
  assert.match(stopped.stdout, /qp-edge-hy2\.service failed; nothing listens on udp 443/);
  assert.match(stopped.stdout, /server log: listen udp :443: bind: address already in use/);
  assert.match(stopped.stdout, /qp-edge-hy2\.service is failed on box: the server is not running \(its log is above\)\. Push again: qp-tunnel-cli hy2 push box --yes/);

  const taken = await withDeadProxy(newCase(), [], 'unit=active\npid=1234\nholder=UNCONN 0 0 0.0.0.0:443 0.0.0.0:* users:(("caddy",pid=999,fd=9))\nfw=none\ncapture=start\ncapture=done\n');
  assert.match(taken.stdout, /udp 443 on box is held by another process \(UNCONN .*"caddy",pid=999.*\), not by the server/);

  const blind = await withDeadProxy(newCase(), [], `${serving}fw=firewalld-closed\ncapture=no-tcpdump\n`);
  assert.match(blind.stdout, /tcpdump is not installed there/);
  assert.match(blind.stdout, /tcpdump is not installed on box, so it is unknown whether packets arrive/);
  assert.match(blind.stdout, /box's firewalld does not allow udp 443/);

  const unreachable = await withDeadProxy(newCase(), [], '', { FAKE_SSH_STATUS: '255' });
  assert.match(unreachable.stdout, /box {10}UNKNOWN: ssh exited 255/);
  assert.match(unreachable.stdout, /box could not be asked over ssh \(ssh exited 255\), so only this side is known/);

  const skipped = await withDeadProxy(newCase(), ['--no-diagnose'], serving);
  assert.ok(!skipped.stdout.includes('Looking at both ends'));
  assert.match(skipped.stdout, /The usual causes, most likely first:/);
});
