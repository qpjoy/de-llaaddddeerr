const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  chmodSync,
  mkdirSync,
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
const sourceScript = resolve(repoRoot, 'scripts/openvpn-client.sh');
const packagedScript = resolve(packageRoot, 'resources/openvpn-client.sh');

const testRoot = mkdtempSync(join(tmpdir(), 'qp-open-client-test-'));
const libraryScript = join(testRoot, 'openvpn-client-library.sh');

const scriptContent = readFileSync(packagedScript, 'utf8');
assert.match(scriptContent, /\nmain "\$@"\s*$/);
writeFileSync(libraryScript, scriptContent.replace(/\nmain "\$@"\s*$/, '\n'));
chmodSync(libraryScript, 0o755);

after(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

// A minimal but structurally complete profile: the metadata header the spoke
// reads before connecting, one remote, and inline PKI blocks.
const fixtureProfile = join(testRoot, 'internal-01.ovpn');
writeFileSync(
  fixtureProfile,
  [
    '# qp-open-profile-version: 1',
    '# qp-open-instance: mx',
    '# qp-open-server-host: 203.0.113.10',
    '# qp-open-subnet: 100.127.0.0/24',
    '# qp-open-client-ip: 100.127.0.10',
    '# qp-open-client-name: internal-01',
    '# qp-open-egress: allowed',
    '',
    'client',
    'dev tun',
    'proto udp',
    'remote 203.0.113.10 1194 udp',
    'remote 203.0.113.10 20000 udp',
    'connect-retry 3 30',
    'auth SHA512',
    'data-ciphers AES-256-GCM:AES-128-GCM',
    '<ca>',
    '-----BEGIN CERTIFICATE-----',
    'FAKECA',
    '-----END CERTIFICATE-----',
    '</ca>',
    '<cert>',
    '-----BEGIN CERTIFICATE-----',
    'FAKECERT',
    '-----END CERTIFICATE-----',
    '</cert>',
    '<key>',
    '-----BEGIN PRIVATE KEY-----',
    'FAKEKEY',
    '-----END PRIVATE KEY-----',
    '</key>',
    '<tls-crypt>',
    '-----BEGIN OpenVPN Static key V1-----',
    'deadbeef',
    '-----END OpenVPN Static key V1-----',
    '</tls-crypt>',
    '',
  ].join('\n'),
);

function runLibrary(args, body, options = {}) {
  return spawnSync(
    'bash',
    ['-c', `source "$QP_OPEN_TEST_LIBRARY"\n${body}`, 'qp-open-test-shell', ...args],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: options.path || process.env.PATH,
        QP_OPEN_TEST_LIBRARY: libraryScript,
        QP_OPEN_INSTANCE: options.instance || 'mx',
      },
    },
  );
}

function assertOk(result) {
  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  return result.stdout;
}

test('packaged spoke client is synchronized with its repository source', () => {
  assert.equal(readFileSync(packagedScript, 'utf8'), readFileSync(sourceScript, 'utf8'));
});

test('instance name determines interface, unit and state paths', () => {
  const out = assertOk(
    runLibrary(['status'], 'echo "$QP_OPEN_DEV|$QP_OPEN_UNIT|$QP_OPEN_HOME"', { instance: 'jp01' }),
  );
  assert.equal(
    out.trim(),
    'ovpn-jp01|qp-openvpn-client@jp01.service|/etc/qp-openvpn/jp01',
  );
});

test('interface name always fits IFNAMSIZ', () => {
  // ovpn- plus the 10-character maximum is exactly the 15 usable characters.
  const out = assertOk(runLibrary(['status'], 'echo -n "$QP_OPEN_DEV" | wc -c', { instance: 'abcdefghij' }));
  assert.equal(Number(out.trim()), 15);
});

test('an over-long instance is rejected rather than silently truncated', () => {
  const result = runLibrary(['status'], 'echo unreachable', { instance: 'abcdefghijk' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Instance must match/);
});

test('the distribution openvpn unit names are never referenced in code', () => {
  // openvpn-server@server.service is live on at least one target host and
  // belongs to an unrelated deployment, so the spoke must own its own units.
  // Comments may name those units to explain why; executable lines may not.
  const codeLines = scriptContent
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'));

  for (const line of codeLines) {
    assert.doesNotMatch(line, /(^|[^-])openvpn-client@/);
    assert.doesNotMatch(line, /(^|[^-])openvpn-server@/);
  }
  assert.match(scriptContent, /qp-openvpn-client@/);
});

test('cidrs_overlap detects containment, partial overlap and disjoint ranges', () => {
  const out = assertOk(
    runLibrary(
      ['status'],
      String.raw`
        check() { cidrs_overlap "$1" "$2" && echo "$1 $2 yes" || echo "$1 $2 no"; }
        check 100.127.0.0/24 100.127.0.0/16
        check 100.127.0.0/24 100.127.0.128/25
        check 100.127.0.0/24 100.127.1.0/24
        check 172.16.0.0/24 172.17.0.0/16
        check 192.168.224.0/24 192.168.224.1/32
      `,
    ),
  );
  assert.deepEqual(out.trim().split('\n'), [
    '100.127.0.0/24 100.127.0.0/16 yes',
    '100.127.0.0/24 100.127.0.128/25 yes',
    '100.127.0.0/24 100.127.1.0/24 no',
    '172.16.0.0/24 172.17.0.0/16 no',
    '192.168.224.0/24 192.168.224.1/32 yes',
  ]);
});

test('cidr_to_netmask renders the masks OpenVPN route lines need', () => {
  const out = assertOk(
    runLibrary(['status'], 'for p in 8 12 16 20 24 25 32; do cidr_to_netmask "$p"; done'),
  );
  assert.deepEqual(out.trim().split('\n'), [
    '255.0.0.0',
    '255.240.0.0',
    '255.255.0.0',
    '255.255.240.0',
    '255.255.255.0',
    '255.255.255.128',
    '255.255.255.255',
  ]);
});

test('profile metadata is read from the issued header', () => {
  const out = assertOk(
    runLibrary(
      ['status'],
      String.raw`
        profile_meta "${fixtureProfile}" subnet
        profile_meta "${fixtureProfile}" client-ip
        profile_meta "${fixtureProfile}" server-host
        profile_meta "${fixtureProfile}" egress
      `,
    ),
  );
  assert.deepEqual(out.trim().split('\n'), [
    '100.127.0.0/24',
    '100.127.0.10',
    '203.0.113.10',
    'allowed',
  ]);
});

test('a profile without inline key material is rejected', () => {
  const broken = join(testRoot, 'broken.ovpn');
  writeFileSync(broken, 'client\nremote 203.0.113.10 1194 udp\n');
  const result = runLibrary(['status'], `assert_profile_readable "${broken}"`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no inline <ca> block/);
});

test('the generated client config contains route-nopull and no resolver changes', () => {
  const home = join(testRoot, 'etc-mx');
  const generated = assertOk(
    runLibrary(
      ['status'],
      String.raw`
        QP_OPEN_HOME="${home}"
        QP_OPEN_CONFIG="$QP_OPEN_HOME/client.conf"
        QP_OPEN_PROFILE="$QP_OPEN_HOME/profile.ovpn"
        QP_OPEN_EGRESS_CONF="$QP_OPEN_HOME/egress.conf"
        mkdir -p "$QP_OPEN_HOME"
        cp "${fixtureProfile}" "$QP_OPEN_PROFILE"
        write_client_config 203.0.113.10 >/dev/null
        cat "$QP_OPEN_CONFIG"
      `,
    ),
  );

  assert.match(generated, /^route-nopull$/m);
  assert.match(generated, /^topology subnet$/m);
  // Level 1, not 0: it still forbids user-defined scripts, but RHEL's
  // iproute2 build needs to execute /sbin/ip to bring the interface up.
  assert.match(generated, /^script-security 1$/m);
  assert.doesNotMatch(generated, /^script-security 0$/m);
  assert.match(generated, /^pull-filter ignore "redirect-gateway"$/m);
  assert.match(generated, /^pull-filter ignore "dhcp-option"$/m);
  assert.match(generated, /^dev ovpn-mx$/m);
  assert.match(generated, /^dev-type tun$/m);

  // The PKI and remotes are carried over verbatim.
  assert.match(generated, /^remote 203\.0\.113\.10 1194 udp$/m);
  assert.match(generated, /^remote 203\.0\.113\.10 20000 udp$/m);
  assert.match(generated, /<ca>[\s\S]*FAKECA[\s\S]*<\/ca>/);
  assert.match(generated, /<key>[\s\S]*FAKEKEY[\s\S]*<\/key>/);
  assert.match(generated, /<tls-crypt>[\s\S]*deadbeef[\s\S]*<\/tls-crypt>/);

  // Cipher directives are generated for the local openvpn, never copied from
  // the profile, so a spoke is not at the mercy of the issuing server's version.
  assert.match(generated, /^(data-ciphers|cipher) /m);

  // Nothing that could take over routing or DNS may appear in spoke mode.
  assert.doesNotMatch(generated, /^redirect-gateway/m);
  assert.doesNotMatch(generated, /^dhcp-option/m);
  assert.doesNotMatch(generated, /update-resolv-conf/);
  assert.doesNotMatch(generated, /^up /m);
  assert.doesNotMatch(generated, /^down /m);
});

test('a 2.4 host never receives the 2.5-only cipher spelling', () => {
  // RHEL ships OpenVPN 2.4, where data-ciphers is a fatal "Unrecognized
  // option" and the tunnel never starts. The spoke must spell this for the
  // openvpn installed on it, not for whatever issued the profile.
  const binDir = join(testRoot, 'fakebin-24');
  mkdirSync(binDir, { recursive: true });
  const fake = join(binDir, 'openvpn');
  writeFileSync(fake, '#!/bin/bash\necho "OpenVPN 2.4.12 x86_64-redhat-linux-gnu"\n');
  chmodSync(fake, 0o755);

  const home = join(testRoot, 'etc-24');
  const generated = assertOk(
    runLibrary(
      ['status'],
      String.raw`
        QP_OPEN_HOME="${home}"
        QP_OPEN_CONFIG="$QP_OPEN_HOME/client.conf"
        QP_OPEN_PROFILE="$QP_OPEN_HOME/profile.ovpn"
        QP_OPEN_EGRESS_CONF="$QP_OPEN_HOME/egress.conf"
        mkdir -p "$QP_OPEN_HOME"
        cp "${fixtureProfile}" "$QP_OPEN_PROFILE"
        write_client_config 203.0.113.10 >/dev/null
        cat "$QP_OPEN_CONFIG"
      `,
      { path: `${binDir}:${process.env.PATH}` },
    ),
  );

  assert.match(generated, /^cipher AES-256-GCM$/m);
  assert.match(generated, /^ncp-ciphers AES-256-GCM:AES-128-GCM$/m);
  assert.doesNotMatch(generated, /^data-ciphers/m);

  // The fixture profile carries data-ciphers; copying it through is exactly the
  // failure this guards against.
  assert.match(readFileSync(fixtureProfile, 'utf8'), /^data-ciphers /m);
});

test('a 2.5+ host receives the modern cipher spelling', () => {
  const binDir = join(testRoot, 'fakebin-26');
  mkdirSync(binDir, { recursive: true });
  const fake = join(binDir, 'openvpn');
  writeFileSync(fake, '#!/bin/bash\necho "OpenVPN 2.6.9 x86_64-pc-linux-gnu"\n');
  chmodSync(fake, 0o755);

  const home = join(testRoot, 'etc-26');
  const generated = assertOk(
    runLibrary(
      ['status'],
      String.raw`
        QP_OPEN_HOME="${home}"
        QP_OPEN_CONFIG="$QP_OPEN_HOME/client.conf"
        QP_OPEN_PROFILE="$QP_OPEN_HOME/profile.ovpn"
        QP_OPEN_EGRESS_CONF="$QP_OPEN_HOME/egress.conf"
        mkdir -p "$QP_OPEN_HOME"
        cp "${fixtureProfile}" "$QP_OPEN_PROFILE"
        write_client_config 203.0.113.10 >/dev/null
        cat "$QP_OPEN_CONFIG"
      `,
      { path: `${binDir}:${process.env.PATH}` },
    ),
  );

  assert.match(generated, /^data-ciphers AES-256-GCM:AES-128-GCM$/m);
  assert.doesNotMatch(generated, /^ncp-ciphers/m);
});

test('the client config refuses to be written without a remote', () => {
  const home = join(testRoot, 'etc-noremote');
  const result = runLibrary(
    ['status'],
    String.raw`
      QP_OPEN_HOME="${home}"
      QP_OPEN_CONFIG="$QP_OPEN_HOME/client.conf"
      QP_OPEN_PROFILE="$QP_OPEN_HOME/profile.ovpn"
      QP_OPEN_EGRESS_CONF="$QP_OPEN_HOME/egress.conf"
      mkdir -p "$QP_OPEN_HOME"
      printf 'client\n<ca>\nx\n</ca>\n<key>\ny\n</key>\n' > "$QP_OPEN_PROFILE"
      write_client_config 203.0.113.10
    `,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /contains no 'remote' line/);
});

test('egress route generation keeps every local network on the physical gateway', () => {
  const out = assertOk(
    runLibrary(
      ['status'],
      String.raw`
        # Stand in for the live routing table with the shape of the real
        # internal server: LAN, the unrelated OpenVPN server on tun0, the
        # WireGuard overlay, a Docker bridge and the CNI.
        local_direct_cidrs() {
          printf '%s\n' \
            192.168.1.0/24 \
            10.8.0.0/24 \
            10.88.0.0/16 \
            172.17.0.0/16 \
            192.168.224.0/24
        }
        emit_local_direct_routes
      `,
    ),
  );

  assert.deepEqual(out.trim().split('\n'), [
    'route 192.168.1.0 255.255.255.0 net_gateway',
    'route 10.8.0.0 255.255.255.0 net_gateway',
    'route 10.88.0.0 255.255.0.0 net_gateway',
    'route 172.17.0.0 255.255.0.0 net_gateway',
    'route 192.168.224.0 255.255.255.0 net_gateway',
  ]);
});

test('the shipped China prefix list renders valid OpenVPN route lines', () => {
  const out = assertOk(
    runLibrary(
      ['status'],
      // No `head` in the pipeline: pipefail turns the resulting SIGPIPE into a
      // failure that has nothing to do with what is being tested.
      String.raw`emit_cn_routes "${resolve(packageRoot, 'resources/china-ipv4-coarse.txt')}"`,
    ),
  );
  const lines = out.trim().split('\n');
  assert.ok(lines.length > 10, `expected a populated China route list, got ${lines.length}`);
  for (const line of lines) {
    assert.match(line, /^route ([0-9]{1,3}\.){3}[0-9]{1,3} ([0-9]{1,3}\.){3}[0-9]{1,3} net_gateway$/);
  }
});

test('state fields round-trip through the JSON state file', () => {
  const home = join(testRoot, 'etc-state');
  const out = assertOk(
    runLibrary(
      ['status'],
      String.raw`
        QP_OPEN_HOME="${home}"
        QP_OPEN_STATE="$QP_OPEN_HOME/state.json"
        mkdir -p "$QP_OPEN_HOME"
        write_state 203.0.113.10 100.127.0.0/24 100.127.0.10 '203.0.113.10/32|192.168.1.1|eno2'
        state_field serverHost
        state_field subnet
        state_field clientIp
        state_field pinnedRoute
      `,
    ),
  );
  assert.deepEqual(out.trim().split('\n'), [
    '203.0.113.10',
    '100.127.0.0/24',
    '100.127.0.10',
    '203.0.113.10/32|192.168.1.1|eno2',
  ]);
});

test('egress reports off until an egress config exists', () => {
  const home = join(testRoot, 'etc-egress');
  const out = assertOk(
    runLibrary(
      ['status'],
      String.raw`
        QP_OPEN_HOME="${home}"
        QP_OPEN_EGRESS_CONF="$QP_OPEN_HOME/egress.conf"
        mkdir -p "$QP_OPEN_HOME"
        egress_mode
        printf '# qp-open-egress-mode: cn-direct\n' > "$QP_OPEN_EGRESS_CONF"
        egress_mode
      `,
    ),
  );
  assert.deepEqual(out.trim().split('\n'), ['off', 'cn-direct']);
});

test('preflight rejects a subnet that overlaps an existing local network', () => {
  const result = runLibrary(
    ['status'],
    String.raw`
      local_claimed_cidrs() { printf '%s\n' 192.168.1.0/24 100.127.0.0/16 172.17.0.0/16; }
      preflight --subnet 100.127.0.0/24
    `,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /CONFLICT/);
  assert.match(result.stdout, /100\.127\.0\.0\/16/);
});

test('preflight accepts a subnet that is free on this host', () => {
  const out = assertOk(
    runLibrary(
      ['status'],
      String.raw`
        local_claimed_cidrs() { printf '%s\n' 192.168.1.0/24 10.88.0.0/16 172.17.0.0/16; }
        preflight --subnet 100.127.0.0/24
      `,
    ),
  );
  assert.match(out, /OK: 100\.127\.0\.0\/24 does not overlap/);
});

test('preflight suggests only genuinely free candidates', () => {
  const out = assertOk(
    runLibrary(
      ['status'],
      String.raw`
        local_claimed_cidrs() { printf '%s\n' 100.127.0.0/24 100.127.1.0/24; }
        preflight --subnet 100.127.0.0/24 || true
      `,
    ),
  );
  // Only the suggestion block matters here; the conflict block above it lists
  // the taken subnets on purpose.
  const suggestions = out.slice(out.indexOf('Free /24 candidates'));
  assert.ok(suggestions.length > 0, 'expected a suggestion block');
  assert.doesNotMatch(suggestions, /- 100\.127\.0\.0\/24/);
  assert.doesNotMatch(suggestions, /- 100\.127\.1\.0\/24/);
  assert.match(suggestions, /- 100\.127\.2\.0\/24/);
});
