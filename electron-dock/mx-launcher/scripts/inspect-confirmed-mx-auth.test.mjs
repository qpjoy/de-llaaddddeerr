import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { AUTH_KEYS, decodeRange, decodeSecret, extractFromWorkingCopy, fields, isolatedContainerArgs, secretSummary } from './inspect-confirmed-mx-auth.mjs';

const NS = 'mx-internal-shadow', NAME = 'mx-internal-ops';
const b64 = value => Buffer.from(value).toString('base64');
const integer = value => {
  const bytes = []; let n = BigInt(value);
  do { const byte = Number(n & 127n); n >>= 7n; bytes.push(byte | (n ? 128 : 0)); } while (n);
  return Buffer.from(bytes);
};
const bytes = (number, value) => {
  const buffer = Buffer.from(value);
  return Buffer.concat([integer(number * 8 + 2), integer(buffer.length), buffer]);
};
function secret(name = NAME, data = { token: b64('fixture-original-token') }) {
  return { apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: NS }, type: 'Opaque', data };
}
// Field numbers follow upstream generated.proto, including immutable=5 (4 is stringData).
function protobuf(object, additions = []) {
  const payload = Buffer.concat([
    bytes(1, Buffer.concat([bytes(1, object.metadata.name), bytes(3, object.metadata.namespace), bytes(5, 'old-object-uid')])),
    ...Object.entries(object.data).map(([key, value]) => bytes(2, Buffer.concat([bytes(1, key), bytes(2, Buffer.from(value, 'base64'))]))),
    bytes(3, object.type), Buffer.from([40, object.immutable ? 1 : 0]), ...additions
  ]);
  return Buffer.concat([Buffer.from('k8s\0'), bytes(1, Buffer.concat([bytes(1, object.apiVersion), bytes(2, object.kind)])),
    bytes(2, payload), bytes(3, ''), bytes(4, '')]);
}
function range(object, binary = true) {
  return { header: { revision: 1234 }, count: 1, kvs: [{ key: b64(`/registry/secrets/${NS}/${object.metadata.name}`),
    value: (binary ? protobuf(object) : Buffer.from(JSON.stringify(object))).toString('base64') }] };
}

test('Kubernetes protobuf and JSON preserve original bytes but discard old object identity', () => {
  const original = secret('mx-feishu-oauth', { 'app-id': b64('cli_fixture'), 'app-secret': b64('fixture-sensitive-secret'), 'tenant-keys': b64('tenant-a,tenant-b') });
  original.immutable = true;
  const expected = { ...original, data: { ...original.data } };
  for (const binary of [false, true]) {
    const decoded = decodeRange(range(original, binary), 'mx-feishu-oauth');
    assert.deepEqual(JSON.parse(JSON.stringify(decoded)), expected);
    assert.equal(decoded.metadata.uid, undefined);
  }
  const multiByte = secret(NAME, { token: b64('long-fixture'.repeat(50)), binary: Buffer.from([0, 255, 128, 10]).toString('base64') });
  assert.deepEqual({ ...decodeSecret(protobuf(multiByte), NAME).data }, multiByte.data);
});

test('only exact keys, namespace and Secret kind may be extracted', () => {
  for (const mutate of [
    s => { s.kind = 'ConfigMap'; }, s => { s.apiVersion = 'apps/v1'; },
    s => { s.metadata.namespace = 'kube-system'; }, s => { s.metadata.name = 'other'; },
    s => { s.type = 'kubernetes.io/service-account-token'; }
  ]) {
    const object = secret(); mutate(object);
    for (const encoded of [protobuf(object), Buffer.from(JSON.stringify(object))]) assert.throws(() => decodeSecret(encoded, NAME));
  }
  assert.throws(() => decodeSecret(protobuf(secret()), 'mx-insight-hub-admin'), /提取名单/);
  const wrongKey = range(secret()); wrongKey.kvs[0].key = b64('/registry/secrets/other/mx-internal-ops');
  assert.throws(() => decodeRange(wrongKey, NAME), /其它资源/);
  assert.equal(decodeRange({ header: { revision: 4 } }, NAME), null);
  assert.throws(() => decodeRange({ error: 'not available' }, NAME), /结构异常/);
  const wrongCount = range(secret()); wrongCount.count = 0;
  assert.throws(() => decodeRange(wrongCount, NAME), /结构异常/);
});

test('reject encryption, malformed/truncated protobuf, duplicate entries and stale deletion metadata', () => {
  assert.throws(() => decodeSecret(Buffer.from('k8s:enc:aescbc:v1:private-payload'), NAME), /EncryptionConfiguration/);
  const fixture = protobuf(secret());
  const tokenOffset = fixture.indexOf(Buffer.from('fixture-original-token'));
  assert.ok(tokenOffset > 0);
  for (const length of [4, tokenOffset, tokenOffset + 5, fixture.length - 1]) {
    assert.throws(() => decodeSecret(fixture.subarray(0, length), NAME), error => {
      assert.doesNotMatch(error.message, /fixture-original-token/);
      return true;
    });
  }
  for (const malformed of [[10, 255], [10, 20, 1], [0], [15], Array(11).fill(255)]) {
    assert.throws(() => fields(Buffer.from(malformed)));
  }
  const duplicate = bytes(2, Buffer.concat([bytes(1, 'token'), bytes(2, 'duplicate')]));
  assert.throws(() => decodeSecret(protobuf(secret(), [duplicate]), NAME), /重复/);
  assert.throws(() => decodeSecret(protobuf(secret(), [bytes(4, '')]), NAME), /stringData/);
  const deleting = secret(); deleting.metadata.deletionTimestamp = '2026-09-20T00:00:00Z';
  assert.throws(() => decodeSecret(Buffer.from(JSON.stringify(deleting)), NAME));
  const invalid = secret(); invalid.data.token = 'not canonical base64!?';
  assert.throws(() => decodeSecret(Buffer.from(JSON.stringify(invalid)), NAME), /base64/);
});

test('credential summaries reveal presence and equality, never values or hashes', () => {
  const original = secret();
  const result = secretSummary(original, secret(NAME, { token: b64('fixture-current-token') }), NAME);
  assert.equal(result.current, 'differs_from_original');
  assert.equal(result.required_fields_complete, true);
  assert.doesNotMatch(JSON.stringify(result), /fixture-|Zml4dHVyZQ|sha256|hash/);
  assert.equal(secretSummary(original, original, NAME).current, 'matches_original');
  assert.equal(secretSummary(original, null, NAME).current, 'missing');
  assert.equal(secretSummary(null, null, NAME).original_found, false);
  assert.equal(secretSummary(secret(NAME, { token: b64(' ') }), null, NAME).required_fields_complete, false);
});

test('isolated etcd mounts only the scratch tree, with no network, port publishing or Docker socket', () => {
  const data = '/data/mx-recovery/confirmed-cutover.abc/auth-inspect.def/etcd-working';
  const args = isolatedContainerArgs({ name: 'mx-auth-fixture', data, image: 'sha256:fixture' });
  assert.ok(args.includes('--network=none'));
  assert.ok(args.includes('--pull=never'));
  assert.ok(args.includes('--force-new-cluster'));
  assert.equal(args.filter(v => v === '--mount').length, 1);
  assert.equal(args[args.indexOf('--mount') + 1], `type=bind,src=${data},dst=/recovery`);
  assert.doesNotMatch(args.join(' '), /--privileged|--network=host|--publish|docker\.sock|\/var\/lib\/etcd|src=.*\/latest-etcd,/);
});

test('extractor reads only allowlisted keys and cleans up its own temporary container on success and failure', async () => {
  for (const scenario of ['success', 'missing', 'start-fails', 'timeout', 'decode-fails']) {
    const calls = [], saved = new Map(), logs = [], id = 'a'.repeat(64);
    let clock = 0;
    const command = (exe, args) => {
      assert.equal(exe, 'docker'); calls.push(args);
      switch (args[0]) {
        case 'create': return { stdout: id + '\n', status: 0 };
        case 'start': if (scenario === 'start-fails') throw new Error('start failed'); break;
        case 'exec': {
          assert.equal(args[1], id);
          if (args.includes('health')) return { status: scenario === 'timeout' ? 1 : 0 };
          assert.ok(args.includes('get')); assert.ok(!args.includes('put'));
          const name = args[args.indexOf('get') + 1].split('/').at(-1);
          assert.ok(Object.hasOwn(AUTH_KEYS, name));
          if (scenario === 'decode-fails') return { status: 0, stdout: '{invalid' };
          return { status: 0, stdout: JSON.stringify(scenario === 'missing' ? { header: { revision: 5 } } :
            range(secret(name, Object.fromEntries(AUTH_KEYS[name].map(key => [key, b64('fixture-original-value')]))))) };
        }
        case 'logs': return { status: 0, stdout: 'private stdout', stderr: 'private stderr' };
      }
      return { status: 0, stdout: '' };
    };
    const promise = extractFromWorkingCopy({ data: '/scratch', image: 'fixture', command,
      save: (file, value) => saved.set(file, value), log: value => logs.push(value),
      now: () => clock, sleep: async ms => { clock += ms; } });
    if (['success', 'missing'].includes(scenario)) {
      const result = await promise;
      assert.equal(Object.keys(result).length, scenario === 'success' ? 4 : 0);
    } else await assert.rejects(promise);
    assert.deepEqual(calls.slice(-2), [['stop', '--time=10', id], ['rm', id]]);
    assert.equal(saved.get('etcd.private.log'), 'private stdoutprivate stderr');
    assert.doesNotMatch(logs.join('\n'), /fixture-original-value|private stdout|private stderr/);
  }
});

test('wrapper passes syntax checking and inspection cannot mutate production via kubectl/systemctl', () => {
  const shell = readFileSync(new URL('./inspect-confirmed-mx-auth.sh', import.meta.url), 'utf8');
  const result = spawnSync('bash', ['-n'], { input: shell, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const source = readFileSync(new URL('./inspect-confirmed-mx-auth.mjs', import.meta.url), 'utf8');
  assert.equal([...source.matchAll(/command\('kubectl'/g)].length, 1);
  assert.match(source, /command\('kubectl', \['--request-timeout=15s', '-n', NS, 'get', 'secret'/);
  assert.equal([...source.matchAll(/command\('systemctl'/g)].length, 1);
  assert.match(source, /command\('systemctl', \['show'/);
  assert.match(source, /source = join\(work, 'latest-etcd'\)/);
  assert.match(source, /hashTree\(source\) !== expected/);
});
