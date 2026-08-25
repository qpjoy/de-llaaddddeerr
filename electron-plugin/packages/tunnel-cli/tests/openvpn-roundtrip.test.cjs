const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  chmodSync,
  existsSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { after, test } = require('node:test');

/**
 * The server issues a .ovpn file and the spoke consumes it. Nothing enforces
 * that contract at runtime, so this exercises both halves against each other:
 * a real PKI, a real profile, and the spoke configuration derived from it.
 */

const packageRoot = resolve(__dirname, '..');
const testRoot = mkdtempSync(join(tmpdir(), 'qp-open-roundtrip-test-'));

function asLibrary(name) {
  const content = readFileSync(resolve(packageRoot, `resources/${name}`), 'utf8');
  assert.match(content, /\nmain "\$@"\s*$/);
  const target = join(testRoot, `${name}.lib`);
  writeFileSync(target, content.replace(/\nmain "\$@"\s*$/, '\n'));
  return target;
}

const serverLibrary = asLibrary('openvpn-server.sh');
const clientLibrary = asLibrary('openvpn-client.sh');

const serverHome = join(testRoot, 'server');
const clientHome = join(testRoot, 'client');
const profilePath = join(testRoot, 'internal-01.ovpn');

after(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

function bash(body, args = ['status']) {
  return spawnSync('bash', ['-c', body, 'qp-open-roundtrip-shell', ...args], {
    encoding: 'utf8',
    env: { ...process.env, QP_OPENS_INSTANCE: 'mx', QP_OPEN_INSTANCE: 'mx' },
  });
}

// --- server side: install-equivalent state, then issue a real profile --------

mkdirSync(join(serverHome, 'pki'), { recursive: true });
mkdirSync(join(serverHome, 'ccd'), { recursive: true });
mkdirSync(join(serverHome, 'clients'), { recursive: true });
writeFileSync(
  join(serverHome, 'server.env'),
  [
    "QP_OPEN_SUBNET='100.127.0.0/24'",
    "QP_OPEN_NETMASK='255.255.255.0'",
    "QP_OPEN_NETWORK='100.127.0.0'",
    "QP_OPEN_PORT='1194'",
    "QP_OPEN_PROTO='udp'",
    "QP_OPEN_HOST='203.0.113.10'",
    "QP_OPEN_PORT_RANGE='20000-20100'",
    "QP_OPEN_RUNTIME='host'",
    "QP_OPEN_EGRESS_NAT='true'",
    "QP_OPEN_CLIENT_TO_CLIENT='false'",
    "QP_OPEN_WAN_IF='eth0'",
    '',
  ].join('\n'),
);

const issue = bash(`
  source "${serverLibrary}"
  QP_OPENS_HOME="${serverHome}"
  QP_OPENS_PKI="$QP_OPENS_HOME/pki"
  QP_OPENS_CCD="$QP_OPENS_HOME/ccd"
  QP_OPENS_CLIENTS="$QP_OPENS_HOME/clients"
  QP_OPENS_ENV="$QP_OPENS_HOME/server.env"
  # Root is only needed to write into /etc; the temporary tree stands in for it.
  require_root() { :; }
  # tls-crypt needs the openvpn binary, which is not a prerequisite for
  # exercising the issuance and parsing contract.
  generate_tls_crypt_key() {
    printf -- '-----BEGIN OpenVPN Static key V1-----\\nc0ffee\\n-----END OpenVPN Static key V1-----\\n' \\
      > "$QP_OPENS_PKI/tls-crypt.key"
  }
  build_pki >/dev/null
  create_client internal-01 --ip 100.127.0.10 --out "${profilePath}" >/dev/null
`);

const opensslUnsupported =
  issue.status !== 0 && /unknown option|Usage:|unrecognized/i.test(issue.stderr);

test('the server issues a profile the spoke can consume end to end', (t) => {
  if (opensslUnsupported) {
    t.diagnostic(`skipped: openssl ca unsupported here (${issue.stderr.trim().split('\n')[0]})`);
    return;
  }
  assert.equal(issue.status, 0, `stderr:\n${issue.stderr}\nstdout:\n${issue.stdout}`);

  const profile = readFileSync(profilePath, 'utf8');

  // The client-config-dir entry is what pins the address across reconnects.
  const ccd = readFileSync(join(serverHome, 'ccd', 'internal-01'), 'utf8');
  assert.match(ccd, /^ifconfig-push 100\.127\.0\.10 255\.255\.255\.0$/m);

  // create_client issues both generations at once, so nobody has to hand-edit
  // a profile to get it into OpenVPN Connect.
  const connectPath = profilePath.replace(/\.ovpn$/, '.connect.ovpn');
  assert.ok(existsSync(connectPath), `expected a Connect profile at ${connectPath}`);
  const connectProfile = readFileSync(connectPath, 'utf8');
  assert.match(connectProfile, /^# qp-open-variant: openvpn3$/m);
  assert.match(connectProfile, /^# qp-open-client-ip: 100\.127\.0\.10$/m);
  assert.doesNotMatch(connectProfile, /^topology /m);
  assert.doesNotMatch(connectProfile, /^pull-filter /m);
  assert.doesNotMatch(connectProfile, /^script-security /m);
  assert.match(connectProfile, /^route-nopull$/m);
  // Both variants carry the same identity.
  assert.ok(
    connectProfile.includes(readFileSync(join(serverHome, 'pki', 'ca.crt'), 'utf8').trim()),
    'the Connect profile carries a different CA',
  );

  // Headers the spoke reads before it connects.
  assert.match(profile, /^# qp-open-subnet: 100\.127\.0\.0\/24$/m);
  assert.match(profile, /^# qp-open-client-ip: 100\.127\.0\.10$/m);

  // A real certificate chain, not a placeholder.
  assert.match(profile, /<ca>\n-----BEGIN CERTIFICATE-----/);
  assert.match(profile, /<cert>\n-----BEGIN CERTIFICATE-----/);
  assert.match(profile, /<key>\n-----BEGIN (EC )?PRIVATE KEY-----/);
  assert.match(profile, /<tls-crypt>\n-----BEGIN OpenVPN Static key V1-----/);

  // The port range became several remotes, so the spoke can fail over alone.
  const remotes = profile.split('\n').filter((line) => line.startsWith('remote '));
  assert.ok(remotes.length > 1, `expected fallback remotes, got ${remotes.length}`);

  // --- spoke side: consume that exact file -------------------------------
  mkdirSync(clientHome, { recursive: true });
  const consume = bash(`
    source "${clientLibrary}"
    QP_OPEN_HOME="${clientHome}"
    QP_OPEN_CONFIG="$QP_OPEN_HOME/client.conf"
    QP_OPEN_PROFILE="$QP_OPEN_HOME/profile.ovpn"
    QP_OPEN_EGRESS_CONF="$QP_OPEN_HOME/egress.conf"
    assert_profile_readable "${profilePath}"
    cp "${profilePath}" "$QP_OPEN_PROFILE"
    echo "meta-subnet=$(profile_meta "$QP_OPEN_PROFILE" subnet)"
    echo "meta-ip=$(profile_meta "$QP_OPEN_PROFILE" client-ip)"
    echo "meta-host=$(profile_meta "$QP_OPEN_PROFILE" server-host)"
    write_client_config 203.0.113.10 >/dev/null
  `);
  assert.equal(consume.status, 0, `stderr:\n${consume.stderr}\nstdout:\n${consume.stdout}`);

  assert.match(consume.stdout, /meta-subnet=100\.127\.0\.0\/24/);
  assert.match(consume.stdout, /meta-ip=100\.127\.0\.10/);
  assert.match(consume.stdout, /meta-host=203\.0\.113\.10/);

  const clientConfig = readFileSync(join(clientHome, 'client.conf'), 'utf8');

  // Every PKI block survived the extraction intact.
  for (const block of ['ca', 'cert', 'key', 'tls-crypt']) {
    const opens = clientConfig.split(`<${block}>`).length - 1;
    const closes = clientConfig.split(`</${block}>`).length - 1;
    assert.equal(opens, 1, `expected exactly one <${block}> block`);
    assert.equal(closes, 1, `expected exactly one </${block}> block`);
  }

  // The certificate bodies match what the server issued, byte for byte.
  const caFromServer = readFileSync(join(serverHome, 'pki', 'ca.crt'), 'utf8').trim();
  assert.ok(
    clientConfig.includes(caFromServer),
    'the CA in the spoke config differs from the one the server issued',
  );

  // Containment survives the round trip.
  assert.match(clientConfig, /^route-nopull$/m);
  assert.match(clientConfig, /^topology subnet$/m);
  assert.match(clientConfig, /^script-security 1$/m);
  assert.match(clientConfig, /^dev ovpn-mx$/m);
  assert.doesNotMatch(clientConfig, /^redirect-gateway/m);
  assert.doesNotMatch(clientConfig, /^push /m);

  // Cipher directives come from the local openvpn, not from the profile, so a
  // 2.4 spoke never inherits the 2.5-only data-ciphers spelling.
  assert.match(clientConfig, /^(data-ciphers|cipher) /m);
  assert.doesNotMatch(clientConfig, /^ignore-unknown-option /m);

  // Every remote made it across.
  const clientRemotes = clientConfig.split('\n').filter((line) => line.startsWith('remote '));
  assert.deepEqual(clientRemotes, remotes);
});

test('a second client cannot be issued the address the first one holds', (t) => {
  if (opensslUnsupported) {
    t.diagnostic('skipped: openssl ca unsupported here');
    return;
  }

  const collision = bash(`
    source "${serverLibrary}"
    QP_OPENS_HOME="${serverHome}"
    QP_OPENS_PKI="$QP_OPENS_HOME/pki"
    QP_OPENS_CCD="$QP_OPENS_HOME/ccd"
    QP_OPENS_CLIENTS="$QP_OPENS_HOME/clients"
    QP_OPENS_ENV="$QP_OPENS_HOME/server.env"
    require_root() { :; }
    create_client internal-02 --ip 100.127.0.10
  `);
  assert.notEqual(collision.status, 0);
  assert.match(collision.stderr, /already assigned to internal-01/);
});

test('re-issuing an existing client name is refused rather than silently rotated', (t) => {
  if (opensslUnsupported) {
    t.diagnostic('skipped: openssl ca unsupported here');
    return;
  }

  const duplicate = bash(`
    source "${serverLibrary}"
    QP_OPENS_HOME="${serverHome}"
    QP_OPENS_PKI="$QP_OPENS_HOME/pki"
    QP_OPENS_CCD="$QP_OPENS_HOME/ccd"
    QP_OPENS_CLIENTS="$QP_OPENS_HOME/clients"
    QP_OPENS_ENV="$QP_OPENS_HOME/server.env"
    require_root() { :; }
    create_client internal-01
  `);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /already exists/);
});

test('the next allocation skips the address already handed out', (t) => {
  if (opensslUnsupported) {
    t.diagnostic('skipped: openssl ca unsupported here');
    return;
  }

  const allocated = bash(`
    source "${serverLibrary}"
    QP_OPENS_HOME="${serverHome}"
    QP_OPENS_CCD="$QP_OPENS_HOME/ccd"
    QP_OPEN_SUBNET=100.127.0.0/24
    next_free_client_ip
  `);
  assert.equal(allocated.status, 0, allocated.stderr);
  assert.equal(allocated.stdout.trim(), '100.127.0.11');
});

test('an address outside the tunnel subnet is refused', (t) => {
  if (opensslUnsupported) {
    t.diagnostic('skipped: openssl ca unsupported here');
    return;
  }

  const outside = bash(`
    source "${serverLibrary}"
    QP_OPENS_HOME="${serverHome}"
    QP_OPENS_PKI="$QP_OPENS_HOME/pki"
    QP_OPENS_CCD="$QP_OPENS_HOME/ccd"
    QP_OPENS_CLIENTS="$QP_OPENS_HOME/clients"
    QP_OPENS_ENV="$QP_OPENS_HOME/server.env"
    require_root() { :; }
    create_client stray --ip 10.88.0.5
  `);
  assert.notEqual(outside.status, 0);
  assert.match(outside.stderr, /outside the tunnel subnet/);
});

test('revoke releases the name and the address so they can be reused', (t) => {
  if (opensslUnsupported) {
    t.diagnostic('skipped: openssl ca unsupported here');
    return;
  }

  const revoked = bash(`
    source "${serverLibrary}"
    QP_OPENS_HOME="${serverHome}"
    QP_OPENS_PKI="$QP_OPENS_HOME/pki"
    QP_OPENS_CCD="$QP_OPENS_HOME/ccd"
    QP_OPENS_CLIENTS="$QP_OPENS_HOME/clients"
    QP_OPENS_ENV="$QP_OPENS_HOME/server.env"
    require_root() { :; }
    revoke_client internal-01
  `);
  assert.equal(revoked.status, 0, revoked.stderr);

  // Leaving these behind is what made revoke a dead end: create refused the
  // name because the certificate was still on disk, and the address because
  // the ccd entry still claimed it.
  assert.ok(
    !existsSync(join(serverHome, 'pki', 'issued-internal-01.crt')),
    'the issued certificate is still in place after revoke',
  );
  assert.ok(
    !existsSync(join(serverHome, 'ccd', 'internal-01')),
    'the address reservation survived revoke',
  );

  // Archived rather than deleted, so a revocation stays auditable.
  const archived = readdirSync(join(serverHome, 'pki', 'revoked'));
  assert.ok(
    archived.some((f) => f.startsWith('internal-01-') && f.endsWith('.crt')),
    `expected an archived certificate, got ${archived.join(', ')}`,
  );

  // The whole point: the same name and address are usable again.
  const recreated = bash(`
    source "${serverLibrary}"
    QP_OPENS_HOME="${serverHome}"
    QP_OPENS_PKI="$QP_OPENS_HOME/pki"
    QP_OPENS_CCD="$QP_OPENS_HOME/ccd"
    QP_OPENS_CLIENTS="$QP_OPENS_HOME/clients"
    QP_OPENS_ENV="$QP_OPENS_HOME/server.env"
    require_root() { :; }
    create_client internal-01 --ip 100.127.0.10 >/dev/null
  `);
  assert.equal(recreated.status, 0, `re-create after revoke failed:\n${recreated.stderr}`);
});

test('reissue rebuilds both profiles against a changed endpoint', (t) => {
  if (opensslUnsupported) {
    t.diagnostic('skipped: openssl ca unsupported here');
    return;
  }

  // Simulate the endpoint moving, which is what leaves issued profiles stale.
  writeFileSync(
    join(serverHome, 'server.env'),
    readFileSync(join(serverHome, 'server.env'), 'utf8')
      .replace("QP_OPEN_PORT='1194'", "QP_OPEN_PORT='334'"),
  );

  const out = bash(`
    source "${serverLibrary}"
    QP_OPENS_HOME="${serverHome}"
    QP_OPENS_PKI="$QP_OPENS_HOME/pki"
    QP_OPENS_CCD="$QP_OPENS_HOME/ccd"
    QP_OPENS_CLIENTS="$QP_OPENS_HOME/clients"
    QP_OPENS_ENV="$QP_OPENS_HOME/server.env"
    require_root() { :; }
    reissue_client internal-01
  `);
  assert.equal(out.status, 0, out.stderr);

  for (const file of ['internal-01.ovpn', 'internal-01.connect.ovpn']) {
    const rendered = readFileSync(join(serverHome, 'clients', file), 'utf8');
    assert.match(rendered, /^remote \S+ 334 udp$/m, `${file} still names the old port`);
    // The identity must survive: same address, same certificate.
    assert.match(rendered, /^# qp-open-client-ip: 100\.127\.0\.10$/m);
  }
});
