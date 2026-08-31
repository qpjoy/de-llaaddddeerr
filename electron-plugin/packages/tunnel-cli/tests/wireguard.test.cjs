const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { after, test } = require('node:test');

const packageRoot = resolve(__dirname, '..');
const repoRoot = resolve(packageRoot, '../../..');
const sourceScript = resolve(repoRoot, 'scripts/wireguard.sh');
const packagedScript = resolve(packageRoot, 'resources/wireguard.sh');
const testRoot = mkdtempSync(join(tmpdir(), 'qp-wg-test-'));
const libraryScript = join(testRoot, 'wireguard-library.sh');
const bashCommand = process.platform === 'win32'
  ? resolve(process.env.ProgramFiles || 'C:\\Program Files', 'Git/bin/bash.exe')
  : 'bash';

const scriptContent = readFileSync(packagedScript, 'utf8');
const libraryEnd = scriptContent.indexOf('\nif [[ "${QP_WG_LIBRARY_ONLY:-0}" == 1 ]]');
assert.ok(libraryEnd > 0, 'managed WireGuard library guard is missing');
writeFileSync(libraryScript, `${scriptContent.slice(0, libraryEnd)}\n`);
chmodSync(libraryScript, 0o755);

after(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

function runLibrary(body, args = []) {
  return spawnSync(
    bashCommand,
    ['-c', `source "$QP_WG_TEST_LIBRARY"\n${body}`, 'qp-wg-test-shell', ...args],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        QP_WG_TEST_LIBRARY: libraryScript,
      },
    },
  );
}

function assertOk(result) {
  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  return result.stdout;
}

test('packaged WireGuard script is synchronized with its repository source', () => {
  assert.equal(scriptContent, readFileSync(sourceScript, 'utf8'));
});

test('managed instances use isolated interface and state names', () => {
  const out = assertOk(
    runLibrary(
      'QP_WG_INSTANCE=jp01; qp_wg_set_paths; echo "$QP_WG_SERVER_DEV|$QP_WG_CLIENT_DEV|$QP_WG_SERVER_HOME"',
    ),
  );
  assert.equal(out.trim(), 'qpwgs-jp01|qpwgc-jp01|/etc/qp-wireguard/server/jp01');
});

test('subnet validation accepts planned RFC 6598 blocks and rejects 100.128 public space', () => {
  const out = assertOk(
    runLibrary(String.raw`
      qp_wg_validate_subnet 100.127.50.0/24; echo planned:$?
      qp_wg_validate_subnet 100.127.100.0/24; echo alternate:$?
      qp_wg_validate_subnet 100.128.0.0/16; echo public:$?
      qp_wg_validate_subnet 100.127.50.1/24; echo noncanonical:$?
    `),
  );
  assert.deepEqual(out.trim().split('\n'), [
    'planned:0',
    'alternate:0',
    'public:2',
    'noncanonical:1',
  ]);
});

test('endpoint validation accepts an AWS EIP or hostname but not an invalid numeric IP', () => {
  const out = assertOk(
    runLibrary(String.raw`
      qp_wg_validate_endpoint 203.0.113.10; echo eip:$?
      qp_wg_validate_endpoint wg.example.com; echo hostname:$?
      qp_wg_validate_endpoint 999.999.999.999; echo invalid:$?
    `),
  );
  assert.deepEqual(out.trim().split('\n'), ['eip:0', 'hostname:0', 'invalid:1']);
});

test('CIDR overlap catches broader VPCs and leaves adjacent tunnel blocks free', () => {
  const out = assertOk(
    runLibrary(String.raw`
      qp_wg_cidrs_overlap 100.127.50.0/24 100.127.0.0/16; echo broad:$?
      qp_wg_cidrs_overlap 100.127.50.0/24 100.127.51.0/24; echo adjacent:$?
      qp_wg_cidrs_overlap 172.31.20.0/24 172.31.0.0/16; echo aws:$?
    `),
  );
  assert.deepEqual(out.trim().split('\n'), ['broad:0', 'adjacent:1', 'aws:0']);
});

test('issued profiles route all IPv4 traffic while retaining the existing DNS resolver', () => {
  const managedSection = scriptContent.slice(0, libraryEnd);
  assert.match(managedSection, /^AllowedIPs = 0\.0\.0\.0\/0$/m);
  assert.doesNotMatch(managedSection, /^DNS = /m);
  assert.match(managedSection, /net\.ipv4\.ip_forward=1/);
  assert.match(managedSection, /-j MASQUERADE/);
});

test('rotation increments the UDP port by one when no range is configured', () => {
  const out = assertOk(runLibrary('qp_wg_next_port 20000 ""'));
  assert.equal(out.trim(), '20001');
});

test('port replacement updates listeners, firewall hooks and issued endpoints', () => {
  const fixture = join(testRoot, 'port.conf');
  writeFileSync(
    fixture,
    [
      'PrivateKey = client-private-key',
      'PublicKey = server-public-key',
      'ListenPort = 20000',
      'PostUp = firewall-cmd --add-port=20000/udp',
      'PostDown = iptables -D INPUT -p udp --dport 20000 -j ACCEPT',
      'Endpoint = 203.0.113.10:20000',
      '',
    ].join('\n'),
  );
  const out = assertOk(
    runLibrary('qp_wg_replace_port_in_file "$1" 20000 20001; cat "$1"', [fixture]),
  );
  assert.match(out, /^ListenPort = 20001$/m);
  assert.match(out, /--add-port=20001\/udp/);
  assert.match(out, /--dport 20001 /);
  assert.match(out, /^Endpoint = 203\.0\.113\.10:20001$/m);
  assert.match(out, /^PrivateKey = client-private-key$/m);
  assert.match(out, /^PublicKey = server-public-key$/m);
  assert.doesNotMatch(out, /20000/);
});

test('the managed command dispatcher runs before the legacy interactive installer', () => {
  const dispatcher = scriptContent.indexOf('qp_wg_cli_main "$@"');
  const legacyInstaller = scriptContent.indexOf('mkdir -p /etc/wireguard/');
  assert.ok(dispatcher > 0 && dispatcher < legacyInstaller);
});
