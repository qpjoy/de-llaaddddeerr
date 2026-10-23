import test from 'node:test';
import assert from 'node:assert/strict';
import { upstreamMetadata, collectIpChannelDiagnostics } from '../scripts/ip-channel-diagnostics.mjs';

const row = payload => ({ status: 200, outcome: 'rejected', diagnostic_body: Buffer.from(JSON.stringify(payload)) });

test('IP diagnostic exposes a bounded upstream rejection explanation without assuming what 601 means', () => {
  const result = upstreamMetadata(row({ ret_data: { code: 601, msg: 'Request rejected by provider', data: { private: 'DO_NOT_EXPORT' } } }));
  assert.equal(result.businessCode, 601);
  assert.deepEqual(result.businessMessages, ['Request rejected by provider']);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_EXPORT|diagnostic_body|ret_data/);
});

test('IP rejection messages redact credential echoes, IPs, URLs and long opaque values', () => {
  const result = upstreamMetadata(row({ ret_data: { code: '601', message: 'token=DO_NOT_EXPORT password:DO_NOT_EXPORT api_key=DO_NOT_EXPORT 192.0.2.1 https://example.test/private Bearer DO_NOT_EXPORT abcdefghijklmnopqrstuvwxyz123456' } }));
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_EXPORT|192\.0\.2\.1|https:|abcdefghijklmnopqrstuvwxyz/);
  assert.match(result.businessMessages[0], /omitted|redacted/);
  assert.equal(result.businessCode, 601);
});

test('success payloads, malformed bodies and arbitrary error objects cannot leak full upstream data', () => {
  const success = upstreamMetadata({ ...row({ ret_data: { code: 200, msg: 'DO_NOT_EXPORT', data: 'DO_NOT_EXPORT' } }), outcome: 'succeeded' });
  assert.equal(success.businessMessages, undefined);
  assert.doesNotMatch(JSON.stringify(success), /DO_NOT_EXPORT/);
  assert.equal(upstreamMetadata({ diagnostic_body: Buffer.from('not JSON') }).bodyNotJson, true);
  const long = upstreamMetadata(row({ ret_data: { code: 601, msg: 'x '.repeat(2000), message: { token: 'DO_NOT_EXPORT' } } }));
  assert.ok(long.businessMessages[0].length <= 280);
  assert.doesNotMatch(JSON.stringify(long), /DO_NOT_EXPORT/);
});

test('invalid diagnostic targets are rejected before connecting to or reading a database', async () => {
  const client = { query: () => assert.fail('invalid input must not reach a database') };
  await assert.rejects(collectIpChannelDiagnostics(client, [['invalid', 'invalid']]), { code: 'invalid_diagnostic_target' });
});
