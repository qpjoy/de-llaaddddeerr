import assert from 'node:assert/strict';
import test from 'node:test';

import { assertHttpBearerTransport } from '../src-electron/http-transport-policy.mjs';

test('Bearer transport accepts explicit HTTP and HTTPS endpoints', () => {
  for (const baseUrl of [
    'http://10.88.88.88:30880',
    'http://10.88.100.5:18090',
    'http://mx-auto.internal:8790',
    'https://mx-auto.example'
  ]) {
    assert.doesNotThrow(() => assertHttpBearerTransport(baseUrl), baseUrl);
  }
});

test('Bearer transport still rejects non-HTTP protocols', () => {
  for (const baseUrl of ['file:///tmp/token', 'ws://mx-auto.internal']) {
    assert.throws(
      () => assertHttpBearerTransport(baseUrl),
      /Bearer transport must use HTTP\(S\)/,
      baseUrl
    );
  }
});
