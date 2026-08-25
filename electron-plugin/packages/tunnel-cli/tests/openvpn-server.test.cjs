const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { after, test } = require('node:test');

const packageRoot = resolve(__dirname, '..');
const repoRoot = resolve(packageRoot, '../../..');
const sourceScript = resolve(repoRoot, 'scripts/openvpn-server.sh');
const packagedScript = resolve(packageRoot, 'resources/openvpn-server.sh');

const testRoot = mkdtempSync(join(tmpdir(), 'qp-open-server-test-'));
const libraryScript = join(testRoot, 'openvpn-server-library.sh');

const scriptContent = readFileSync(packagedScript, 'utf8');
assert.match(scriptContent, /\nmain "\$@"\s*$/);
writeFileSync(libraryScript, scriptContent.replace(/\nmain "\$@"\s*$/, '\n'));
chmodSync(libraryScript, 0o755);

after(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

// The environment `load_env` would have produced after a real install.
const installedEnv = [
  "QP_OPEN_SUBNET=100.127.0.0/24",
  "QP_OPEN_NETMASK=255.255.255.0",
  "QP_OPEN_NETWORK=100.127.0.0",
  "QP_OPEN_PORT=1194",
  "QP_OPEN_PROTO=udp",
  "QP_OPEN_HOST=203.0.113.10",
  "QP_OPEN_PORT_RANGE=",
  "QP_OPEN_RUNTIME=host",
  "QP_OPEN_EGRESS_NAT=true",
  "QP_OPEN_CLIENT_TO_CLIENT=false",
  "QP_OPEN_WAN_IF=eth0",
].join('\n');

function runLibrary(args, body, options = {}) {
  return spawnSync(
    'bash',
    ['-c', `source "$QP_OPENS_TEST_LIBRARY"\n${body}`, 'qp-open-server-test-shell', ...args],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        QP_OPENS_TEST_LIBRARY: libraryScript,
        QP_OPENS_INSTANCE: options.instance || 'mx',
        PATH: options.path || process.env.PATH,
      },
    },
  );
}

function assertOk(result) {
  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  return result.stdout;
}

test('packaged server script is synchronized with its repository source', () => {
  assert.equal(readFileSync(packagedScript, 'utf8'), readFileSync(sourceScript, 'utf8'));
});

test('instance name determines interface, unit, chain and state paths', () => {
  const out = assertOk(
    runLibrary(
      ['status'],
      'echo "$QP_OPENS_DEV|$QP_OPENS_UNIT|$QP_OPENS_CHAIN|$QP_OPENS_HOME"',
      { instance: 'jp01' },
    ),
  );
  assert.equal(
    out.trim(),
    'ovpns-jp01|qp-openvpn-server@jp01.service|QP-OPEN-jp01|/etc/qp-openvpn-server/jp01',
  );
});

test('server interface name fits IFNAMSIZ at the maximum instance length', () => {
  const out = assertOk(
    runLibrary(['status'], 'echo -n "$QP_OPENS_DEV" | wc -c', { instance: 'abcdefghi' }),
  );
  assert.equal(Number(out.trim()), 15);
});

test('cidr_network and the server gateway address are derived from the subnet', () => {
  const out = assertOk(
    runLibrary(
      ['status'],
      String.raw`
        cidr_network 100.127.0.0/24
        cidr_network 100.127.0.37/24
        cidr_network 10.100.5.9/16
        QP_OPEN_SUBNET=100.127.0.0/24
        QP_OPEN_NETWORK=100.127.0.0
        server_gateway_ip
      `,
    ),
  );
  assert.deepEqual(out.trim().split('\n'), [
    '100.127.0.0',
    '100.127.0.0',
    '10.100.0.0',
    '100.127.0.1',
  ]);
});

test('addresses are allocated from .10 upwards and skip the ones already taken', () => {
  const ccd = join(testRoot, 'ccd-alloc');
  mkdirSync(ccd, { recursive: true });
  writeFileSync(join(ccd, 'internal-01'), 'ifconfig-push 100.127.0.10 255.255.255.0\n');
  writeFileSync(join(ccd, 'internal-02'), 'ifconfig-push 100.127.0.11 255.255.255.0\n');

  const out = assertOk(
    runLibrary(
      ['status'],
      String.raw`
        QP_OPEN_SUBNET=100.127.0.0/24
        QP_OPENS_CCD="${ccd}"
        next_free_client_ip
      `,
    ),
  );
  assert.equal(out.trim(), '100.127.0.12');
});

test('the first allocation leaves the low addresses free for fixtures', () => {
  const ccd = join(testRoot, 'ccd-empty');
  mkdirSync(ccd, { recursive: true });
  const out = assertOk(
    runLibrary(
      ['status'],
      String.raw`
        QP_OPEN_SUBNET=100.127.0.0/24
        QP_OPENS_CCD="${ccd}"
        next_free_client_ip
      `,
    ),
  );
  assert.equal(out.trim(), '100.127.0.10');
});

test('a profile carries one remote when no port range is configured', () => {
  const out = assertOk(
    runLibrary(['status'], `${installedEnv}\nrender_remotes`),
  );
  assert.deepEqual(out.trim().split('\n'), ['remote 203.0.113.10 1194 udp']);
});

test('a port range produces extra remotes so a spoke can fail over unaided', () => {
  const out = assertOk(
    runLibrary(
      ['status'],
      `${installedEnv}\nQP_OPEN_PORT_RANGE=20000-20100\nrender_remotes`,
    ),
  );
  const lines = out.trim().split('\n');
  assert.equal(lines[0], 'remote 203.0.113.10 1194 udp');
  assert.ok(lines.length > 1, 'expected fallback remotes');
  for (const line of lines.slice(1)) {
    const port = Number(line.split(' ')[2]);
    assert.ok(port >= 20000 && port <= 20100, `${port} is outside the configured range`);
  }
  assert.equal(new Set(lines).size, lines.length, 'remotes must be distinct');
});

test('the server configuration pushes nothing to spokes', () => {
  const home = join(testRoot, 'srv-config');
  mkdirSync(join(home, 'pki'), { recursive: true });
  const generated = assertOk(
    runLibrary(
      ['status'],
      String.raw`
        ${installedEnv}
        QP_OPENS_HOME="${home}"
        QP_OPENS_PKI="$QP_OPENS_HOME/pki"
        QP_OPENS_CCD="$QP_OPENS_HOME/ccd"
        QP_OPENS_CONFIG="$QP_OPENS_HOME/server.conf"
        QP_OPENS_STATUS_FILE="$QP_OPENS_HOME/openvpn-status.log"
        write_server_config >/dev/null
        cat "$QP_OPENS_CONFIG"
      `,
    ),
  );

  assert.match(generated, /^server 100\.127\.0\.0 255\.255\.255\.0$/m);
  assert.match(generated, /^topology subnet$/m);
  assert.match(generated, /^dev ovpns-mx$/m);
  assert.match(generated, /^client-config-dir /m);
  assert.match(generated, /^dh none$/m);

  // A pushed route, gateway or resolver is exactly what the spokes are not
  // allowed to receive; a spoke enables egress locally instead.
  assert.doesNotMatch(generated, /^push /m);
  assert.doesNotMatch(generated, /redirect-gateway/);
  assert.doesNotMatch(generated, /dhcp-option/);

  // client-to-client is opt-in.
  assert.doesNotMatch(generated, /^client-to-client$/m);
});

test('client-to-client only appears when it was explicitly requested', () => {
  const home = join(testRoot, 'srv-c2c');
  mkdirSync(join(home, 'pki'), { recursive: true });
  const generated = assertOk(
    runLibrary(
      ['status'],
      String.raw`
        ${installedEnv}
        QP_OPEN_CLIENT_TO_CLIENT=true
        QP_OPENS_HOME="${home}"
        QP_OPENS_PKI="$QP_OPENS_HOME/pki"
        QP_OPENS_CCD="$QP_OPENS_HOME/ccd"
        QP_OPENS_CONFIG="$QP_OPENS_HOME/server.conf"
        QP_OPENS_STATUS_FILE="$QP_OPENS_HOME/openvpn-status.log"
        write_server_config >/dev/null
        cat "$QP_OPENS_CONFIG"
      `,
    ),
  );
  assert.match(generated, /^client-to-client$/m);
});

test('the compose file uses host networking so spokes are reachable off-container', () => {
  const home = join(testRoot, 'srv-compose');
  mkdirSync(home, { recursive: true });
  const generated = assertOk(
    runLibrary(
      ['status'],
      String.raw`
        ${installedEnv}
        QP_OPEN_RUNTIME=docker
        QP_OPENS_HOME="${home}"
        QP_OPENS_CONFIG="$QP_OPENS_HOME/server.conf"
        QP_OPENS_COMPOSE="$QP_OPENS_HOME/docker-compose.yml"
        write_compose_file >/dev/null
        cat "$QP_OPENS_COMPOSE"
      `,
    ),
  );

  assert.match(generated, /^\s*network_mode: host$/m);
  assert.match(generated, /\/dev\/net\/tun:\/dev\/net\/tun/);
  assert.match(generated, /^\s*- NET_ADMIN$/m);
  // A bridge network would hide the tun device inside the container namespace.
  assert.doesNotMatch(generated, /^networks:/m);
  assert.doesNotMatch(generated, /^\s*ports:$/m);
});

test('the runtime follows the hysteria2 stack when one is already managed here', () => {
  const binDir = join(testRoot, 'fakebin-docker');
  mkdirSync(binDir, { recursive: true });
  const docker = join(binDir, 'docker');
  writeFileSync(docker, '#!/bin/bash\necho mx-oversea-hysteria2\necho some-other-container\n');
  chmodSync(docker, 0o755);

  const out = assertOk(
    runLibrary(['status'], 'detect_runtime', { path: `${binDir}:${process.env.PATH}` }),
  );
  assert.equal(out.trim(), 'docker');
});

test('the runtime falls back to the host when no hysteria2 stack is present', () => {
  const binDir = join(testRoot, 'fakebin-nohy2');
  mkdirSync(binDir, { recursive: true });
  const docker = join(binDir, 'docker');
  writeFileSync(docker, '#!/bin/bash\necho unrelated-container\n');
  chmodSync(docker, 0o755);

  const out = assertOk(
    runLibrary(['status'], 'detect_runtime', { path: `${binDir}:${process.env.PATH}` }),
  );
  assert.equal(out.trim(), 'host');
});

test('the PKI is generated with openssl and issues a usable client certificate', (t) => {
  const home = join(testRoot, 'srv-pki');
  const out = runLibrary(
    ['status'],
    String.raw`
      ${installedEnv}
      QP_OPENS_HOME="${home}"
      QP_OPENS_PKI="$QP_OPENS_HOME/pki"
      mkdir -p "$QP_OPENS_PKI"
      # tls-crypt needs the openvpn binary, which is not a prerequisite for
      # exercising certificate issuance.
      generate_tls_crypt_key() { printf 'fake-tls-crypt\n' > "$QP_OPENS_PKI/tls-crypt.key"; }
      build_pki >/dev/null
      generate_key "$QP_OPENS_PKI/issued-t1.key"
      openssl req -new -key "$QP_OPENS_PKI/issued-t1.key" -out "$QP_OPENS_PKI/issued-t1.csr" -subj "/CN=t1"
      openssl ca -config "$QP_OPENS_PKI/openssl.cnf" -batch -notext \
        -extensions client_ext -in "$QP_OPENS_PKI/issued-t1.csr" -out "$QP_OPENS_PKI/issued-t1.crt" 2>/dev/null
      openssl verify -CAfile "$QP_OPENS_PKI/ca.crt" "$QP_OPENS_PKI/issued-t1.crt"
      openssl x509 -in "$QP_OPENS_PKI/server.crt" -noout -ext extendedKeyUsage
      openssl x509 -in "$QP_OPENS_PKI/issued-t1.crt" -noout -ext extendedKeyUsage
    `,
  );

  if (out.status !== 0 && /unknown option|Usage|unrecognized/i.test(out.stderr)) {
    // LibreSSL, which macOS ships as /usr/bin/openssl, does not implement every
    // `openssl ca` flag. The target hosts are Linux with real OpenSSL. Skipping
    // is reported rather than silent so a green run is never mistaken for
    // coverage that did not happen.
    t.diagnostic(`skipped: openssl ca unsupported here (${out.stderr.trim().split('\n')[0]})`);
    return;
  }

  assertOk(out);
  assert.match(out.stdout, /issued-t1\.crt: OK/);
  // remote-cert-tls server on the spoke requires the serverAuth EKU, and the
  // server requires clientAuth on the spoke certificate.
  assert.match(out.stdout, /TLS Web Server Authentication/);
  assert.match(out.stdout, /TLS Web Client Authentication/);
});

test('an issued profile is a spoke profile with machine-readable headers', () => {
  const home = join(testRoot, 'srv-profile');
  const pki = join(home, 'pki');
  mkdirSync(pki, { recursive: true });
  writeFileSync(join(pki, 'ca.crt'), '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----');
  writeFileSync(join(pki, 'tls-crypt.key'), '-----BEGIN OpenVPN Static key V1-----\nabc\n-----END OpenVPN Static key V1-----');
  writeFileSync(join(pki, 'issued-internal-01.key'), '-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----');
  writeFileSync(join(pki, 'issued-internal-01.crt'), '-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----');

  const generated = assertOk(
    runLibrary(
      ['status'],
      String.raw`
        ${installedEnv}
        QP_OPENS_HOME="${home}"
        QP_OPENS_PKI="$QP_OPENS_HOME/pki"
        # The fixture certificate is not real DER, so stand in for the single
        # openssl call render_profile makes to normalize it.
        openssl() { cat "$QP_OPENS_PKI/issued-internal-01.crt"; }
        render_profile internal-01 100.127.0.10 allowed
      `,
    ),
  );

  assert.match(generated, /^# qp-open-subnet: 100\.127\.0\.0\/24$/m);
  assert.match(generated, /^# qp-open-client-ip: 100\.127\.0\.10$/m);
  assert.match(generated, /^# qp-open-client-name: internal-01$/m);
  assert.match(generated, /^# qp-open-egress: allowed$/m);
  assert.match(generated, /^# qp-open-server-host: 203\.0\.113\.10$/m);

  // Spoke containment travels with the profile, so a plain `openvpn --config`
  // outside this tooling is equally unable to rearrange the host.
  assert.match(generated, /^route-nopull$/m);
  assert.match(generated, /^topology subnet$/m);
  assert.match(generated, /^script-security 0$/m);
  assert.match(generated, /^pull-filter ignore "redirect-gateway"$/m);
  assert.match(generated, /^remote-cert-tls server$/m);
  assert.match(generated, /^remote 203\.0\.113\.10 1194 udp$/m);
  assert.match(generated, /<ca>\n[\s\S]*CA[\s\S]*<\/ca>/);
  assert.match(generated, /<tls-crypt>\n[\s\S]*abc[\s\S]*<\/tls-crypt>/);
});

test('rendering a profile executes nothing and leaves no shell artifacts', () => {
  const home = join(testRoot, 'srv-clean');
  const pki = join(home, 'pki');
  mkdirSync(pki, { recursive: true });
  for (const f of ['ca.crt', 'tls-crypt.key', 'issued-c2.key', 'issued-c2.crt']) {
    writeFileSync(join(pki, f), 'x');
  }

  const result = runLibrary(
    ['status'],
    String.raw`
      ${installedEnv}
      QP_OPENS_HOME="${home}"
      QP_OPENS_PKI="$QP_OPENS_HOME/pki"
      openssl() { cat "$QP_OPENS_PKI/issued-c2.crt"; }
      render_profile c2 100.127.0.10 denied
    `,
  );

  // The heredoc is unquoted so that the certificate blocks interpolate, which
  // also means a stray backtick in a comment would be executed while the
  // profile is written.
  assert.equal(result.stderr.trim(), '', `rendering wrote to stderr:\n${result.stderr}`);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /command not found/);
  assert.doesNotMatch(result.stdout, /\x60/);
  assert.ok(!result.stdout.includes('`'), 'a backtick reached the rendered profile');
});

test('an issued profile stays importable by a stock OpenVPN 2.4 client', () => {
  const home = join(testRoot, 'srv-comp');
  const pki = join(home, 'pki');
  mkdirSync(pki, { recursive: true });
  for (const f of ['ca.crt', 'tls-crypt.key', 'issued-c1.key', 'issued-c1.crt']) {
    writeFileSync(join(pki, f), 'x');
  }

  const generated = assertOk(
    runLibrary(
      ['status'],
      String.raw`
        ${installedEnv}
        QP_OPENS_HOME="${home}"
        QP_OPENS_PKI="$QP_OPENS_HOME/pki"
        openssl() { cat "$QP_OPENS_PKI/issued-c1.crt"; }
        render_profile c1 100.127.0.10 denied
      `,
    ),
  );

  const lines = generated.split('\n').map((line) => line.trim());
  const ignoreAt = lines.findIndex((line) => line.startsWith('ignore-unknown-option'));
  const dataCiphersAt = lines.findIndex((line) => line.startsWith('data-ciphers '));
  const cipherAt = lines.findIndex((line) => line === 'cipher AES-256-GCM');

  assert.notEqual(ignoreAt, -1, 'expected an ignore-unknown-option line');
  assert.notEqual(dataCiphersAt, -1, 'expected a data-ciphers line');
  assert.notEqual(cipherAt, -1, 'expected a legacy cipher line for 2.4 clients');

  // OpenVPN parses sequentially: the escape hatch is useless after the option
  // it is meant to cover.
  assert.ok(
    ignoreAt < dataCiphersAt,
    `ignore-unknown-option (line ${ignoreAt}) must precede data-ciphers (line ${dataCiphersAt})`,
  );
  assert.match(generated, /^ignore-unknown-option .*data-ciphers/m);

  // A direct import must be contained by the file itself, not by our tooling.
  assert.match(generated, /^dev tun$/m);
  assert.doesNotMatch(generated, /^dev ovpn-/m);
});

test('the openvpn3 variant omits every option OpenVPN Connect rejects', () => {
  const home = join(testRoot, 'srv-ov3');
  const pki = join(home, 'pki');
  mkdirSync(pki, { recursive: true });
  for (const f of ['ca.crt', 'tls-crypt.key', 'issued-c3.key', 'issued-c3.crt']) {
    writeFileSync(join(pki, f), 'x');
  }

  const generated = assertOk(
    runLibrary(
      ['status'],
      String.raw`
        ${installedEnv}
        QP_OPENS_HOME="${home}"
        QP_OPENS_PKI="$QP_OPENS_HOME/pki"
        openssl() { cat "$QP_OPENS_PKI/issued-c3.crt"; }
        render_profile c3 100.127.0.10 denied openvpn3
      `,
    ),
  );

  // A real OpenVPN Connect log named `topology` under UNKNOWN/UNSUPPORTED
  // OPTIONS and refused the whole profile. OpenVPN 3 has no topology
  // directive, no pull-filter and no script-security.
  const directives = generated
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('<') && !line.startsWith('-----'))
    .map((line) => line.split(/\s+/)[0]);

  for (const rejected of ['topology', 'pull-filter', 'script-security', 'ignore-unknown-option']) {
    assert.ok(!directives.includes(rejected), `openvpn3 profile still carries ${rejected}`);
  }

  // The same log shows these parsing cleanly, so containment is not lost.
  assert.match(generated, /^route-nopull$/m);
  assert.match(generated, /^data-ciphers AES-256-GCM:AES-128-GCM$/m);
  assert.match(generated, /^remote-cert-tls server$/m);
  assert.match(generated, /^# qp-open-variant: openvpn3$/m);

  // The PKI still travels with it.
  for (const block of ['ca', 'cert', 'key', 'tls-crypt']) {
    assert.ok(generated.includes(`<${block}>`), `missing <${block}> in the openvpn3 profile`);
  }
});

test('the openvpn2 variant keeps the strict options the 2.x path relies on', () => {
  const home = join(testRoot, 'srv-ov2');
  const pki = join(home, 'pki');
  mkdirSync(pki, { recursive: true });
  for (const f of ['ca.crt', 'tls-crypt.key', 'issued-c4.key', 'issued-c4.crt']) {
    writeFileSync(join(pki, f), 'x');
  }

  const generated = assertOk(
    runLibrary(
      ['status'],
      String.raw`
        ${installedEnv}
        QP_OPENS_HOME="${home}"
        QP_OPENS_PKI="$QP_OPENS_HOME/pki"
        openssl() { cat "$QP_OPENS_PKI/issued-c4.crt"; }
        render_profile c4 100.127.0.10 denied
      `,
    ),
  );

  // Defaulting to openvpn2 keeps `open enroll` and Tunnelblick unchanged.
  assert.match(generated, /^# qp-open-variant: openvpn2$/m);
  assert.match(generated, /^topology subnet$/m);
  assert.match(generated, /^script-security 0$/m);
  assert.match(generated, /^pull-filter ignore "redirect-gateway"$/m);
  assert.match(generated, /^ignore-unknown-option .*data-ciphers/m);
});

test('the instance directory stays traversable for the unprivileged openvpn user', () => {
  // openvpn drops to `user nobody` and then reads a client-config-dir entry on
  // every connection. A 0700 parent makes that lookup fail silently and the
  // client receives a pool address instead of its pinned one, which looks like
  // the ccd entry was never written.
  const codeLines = scriptContent.split('\n').filter((line) => !line.trim().startsWith('#'));
  const chmods = codeLines.filter((line) => line.includes('chmod 0'));

  const home = chmods.find((line) => line.includes('$QP_OPENS_HOME'));
  assert.ok(home, 'expected a chmod covering the instance directory');
  assert.match(home, /chmod 0755 .*QP_OPENS_HOME/, `instance directory must be traversable: ${home}`);
  assert.ok(home.includes('$QP_OPENS_CCD'), 'ccd must be traversable alongside it');

  // The material that actually needs protecting keeps it.
  const secrets = chmods.find((line) => line.includes('$QP_OPENS_PKI'));
  assert.ok(secrets, 'expected a chmod covering the PKI directory');
  assert.match(secrets, /chmod 0700 /, `PKI must stay private: ${secrets}`);
  assert.ok(secrets.includes('$QP_OPENS_CLIENTS'), 'issued profiles hold private keys and must stay private');
});

test('firewall rules live in an instance-scoped chain so teardown is exact', () => {
  // Every mutation must be additive and reversible: nothing may be appended
  // directly to PREROUTING or POSTROUTING except the jump to our own chain.
  const codeLines = scriptContent.split('\n').filter((line) => !line.trim().startsWith('#'));
  const iptablesLines = codeLines.filter((line) => line.includes('iptables '));
  assert.ok(iptablesLines.length > 0);

  for (const line of iptablesLines) {
    if (/-[AI] (PREROUTING|POSTROUTING)/.test(line)) {
      assert.match(
        line,
        /-j "\$\{?QP_OPENS_CHAIN\}?(-NAT)?"/,
        `built-in chain modified with something other than a jump to our chain: ${line}`,
      );
    }
  }
});
