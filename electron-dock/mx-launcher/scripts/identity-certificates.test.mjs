import assert from 'node:assert/strict';
import test from 'node:test';
import { X509Certificate, createPrivateKey, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeProfile, readProfile, diagnoseProfile, savePrivate } from './identity-profile.mjs';
import { prepareIdentity } from './identity-on.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mx-identity-cert-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, 'profile.json'), backup: join(dir, 'profile.before-ca-repair.json') };
}

// Test-only DER transformation: recreate OpenSSL 1.1.1's duplicate extension
// output even on developers' OpenSSL 3 machines. Re-sign with this disposable
// fixture's own CA key so signature/key checks pass just as on the affected host.
function duplicateBasicConstraints(p) {
  const tlv = (tag, body) => {
    let hex = body.length.toString(16); if (hex.length % 2) hex = '0' + hex;
    const bytes = Buffer.from(hex, 'hex');
    return Buffer.concat([Buffer.from([tag]), body.length < 128 ? Buffer.from([body.length]) : Buffer.concat([Buffer.from([0x80 | bytes.length]), bytes]), body]);
  };
  const children = value => {
    const result = []; let offset = 0;
    while (offset < value.length) {
      const start = offset; const tag = value[offset++]; let length = value[offset++];
      if (length & 0x80) { const count = length & 0x7f; length = value.readUIntBE(offset, count); offset += count; }
      const body = value.subarray(offset, offset + length); offset += length;
      result.push({ tag, body, raw: value.subarray(start, offset) });
    }
    return result;
  };
  const cert = children(children(new X509Certificate(p.caCert).raw)[0].body);
  const tbs = children(cert[0].body);
  const extIndex = tbs.findIndex(item => item.tag === 0xa3);
  const extensions = children(children(tbs[extIndex].body)[0].body);
  const basic = extensions.find(item => children(item.body)[0].raw.equals(Buffer.from('0603551d13', 'hex')));
  assert.ok(basic);
  const modified = tlv(0xa3, tlv(0x30, Buffer.concat([...extensions.map(item => item.raw), basic.raw])));
  const data = tlv(0x30, Buffer.concat(tbs.map((item, i) => i === extIndex ? modified : item.raw)));
  const signature = sign('sha256', data, createPrivateKey(p.caKey));
  const der = tlv(0x30, Buffer.concat([data, cert[1].raw, tlv(3, Buffer.concat([Buffer.from([0]), signature]))]));
  return { ...p, caCert: `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n` };
}

function options(f, extra = {}) {
  return { file: f.file, interfaces: { eth0: [{ family: 'IPv4', address: '10.88.88.88' }] }, probe: async () => {}, log() {},
    execute: args => {
      assert.ok(args.includes('get'), 'repair must not mutate running cluster resources');
      if (args[0] === 'get' && args[1] === 'nodes') return JSON.stringify({ items: [{ metadata: { name: 'internal' }, status: { addresses: [{ type: 'InternalIP', address: '10.88.88.88' }] } }] });
      return '';
    }, ...extra };
}

test('certificate generation ignores host req extensions and validates before saving (OpenSSL 1.1.1 and 3)', t => {
  const f = fixture(t); const old = process.env.OPENSSL_CONF;
  t.after(() => { if (old === undefined) delete process.env.OPENSSL_CONF; else process.env.OPENSSL_CONF = old; });
  const config = join(f.dir, 'host-openssl.cnf');
  writeFileSync(config, '[req]\ndistinguished_name = dn\nx509_extensions = v3_ca\n[dn]\nCN = unexpected\n[v3_ca]\nbasicConstraints = critical,CA:true\nsubjectAltName = IP:192.168.99.99\n');
  process.env.OPENSSL_CONF = config;
  const p = initializeProfile('https://10.88.88.88:18443', f.file);
  assert.deepEqual(readProfile(f.file), p);
  const ca = new X509Certificate(p.caCert);
  assert.equal(ca.ca, true);
  assert.equal(ca.subjectAltName, undefined, 'must not inherit the host CA extensions');
  assert.equal(new X509Certificate(p.tlsCert).checkIP('10.88.88.88'), '10.88.88.88');
});

test('a failed initial deploy repairs duplicate CA extensions once, preserving every key and the TLS leaf', async t => {
  const f = fixture(t);
  const broken = duplicateBasicConstraints(initializeProfile('https://10.88.88.88:18443', f.file));
  savePrivate(f.file, broken);
  const before = readFileSync(f.file, 'utf8');
  const diagnostics = diagnoseProfile(f.file);
  assert.equal(diagnostics.caValid, false);
  for (const key of ['signedByCa', 'ipMatches', 'tlsKeyMatches', 'caKeyMatches']) assert.equal(diagnostics[key], true);
  assert.equal(readFileSync(f.file, 'utf8'), before, 'doctor is read-only');
  assert.ok(!JSON.stringify(diagnostics).includes(broken.clientSecret));
  assert.throws(() => readProfile(f.file), /CA 扩展无效/);
  const logs = [];
  const fixed = await prepareIdentity(options(f, { log: line => logs.push(line) }));
  assert.notEqual(fixed.caCert, broken.caCert);
  assert.deepEqual({ ...fixed, caCert: broken.caCert }, broken);
  assert.equal(new X509Certificate(fixed.caCert).serialNumber, new X509Certificate(broken.caCert).serialNumber);
  assert.equal(new X509Certificate(fixed.caCert).ca, true);
  assert.deepEqual(readProfile(f.file), fixed);
  assert.deepEqual(JSON.parse(readFileSync(f.backup, 'utf8')), broken);
  assert.equal(statSync(f.backup).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(f.dir, 'ca.crt'), 'utf8'), fixed.caCert);
  assert.match(logs.join('\n'), /指纹已改变/);
  const after = readFileSync(f.file, 'utf8');
  assert.deepEqual(await prepareIdentity(options(f)), fixed);
  assert.equal(readFileSync(f.file, 'utf8'), after, 'retry must not reissue any certificate');
});

test('repair refuses already published SSO and any real key mismatch without overwriting or backing up', async t => {
  const f = fixture(t);
  const broken = duplicateBasicConstraints(initializeProfile('https://10.88.88.88:18443', f.file));
  savePrivate(f.file, broken);
  const bytes = readFileSync(f.file, 'utf8');
  for (const resource of ['mx-identity-runtime', 'mx-identity', 'mx-identity-ca', 'mx-launcher-admin-sso']) {
    await assert.rejects(prepareIdentity(options(f, { execute: args => args.includes(resource) ? JSON.stringify({ metadata: { name: resource } }) : '' })), /无法确认 SSO 尚未发布/);
    assert.equal(readFileSync(f.file, 'utf8'), bytes);
    assert.equal(existsSync(f.backup), false);
  }
  const mismatched = { ...broken, tlsKey: broken.caKey };
  savePrivate(f.file, mismatched);
  await assert.rejects(prepareIdentity(options(f)), /服务证书与私钥不匹配/);
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), mismatched);
  assert.equal(existsSync(f.backup), false);
});

test('repair cannot overwrite an unrelated existing backup', async t => {
  const f = fixture(t);
  const broken = duplicateBasicConstraints(initializeProfile('https://10.88.88.88:18443', f.file));
  savePrivate(f.file, broken);
  const previous = { ...broken, installationId: 'another-installation' };
  savePrivate(f.backup, previous, true);
  await assert.rejects(prepareIdentity(options(f)), /已有不同的 CA 修复备份/);
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), broken);
  assert.deepEqual(JSON.parse(readFileSync(f.backup, 'utf8')), previous);
});
