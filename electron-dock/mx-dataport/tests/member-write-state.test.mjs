import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from '../apps/web/api.ts';
import { memberUpdateUnconfirmedMessage } from '../apps/web/member-write-state.ts';

async function failureFrom(fetcher) {
  const previous = globalThis.fetch;
  globalThis.fetch = fetcher;
  let captured;
  try {
    await request('/test/member', { method: 'POST', body: '{"roleId":"history-only"}' });
  } catch (error) {
    captured = error;
  } finally {
    globalThis.fetch = previous;
  }
  assert.ok(captured, 'expected a request error');
  return captured;
}

test('a committed member update with a lost response is unconfirmed and never replayed', async () => {
  let writes = 0, role = 'analyst';
  const error = await failureFrom(async () => {
    writes++;
    role = 'history-only';
    throw new TypeError('connection lost');
  });
  assert.equal(writes, 1);
  assert.equal(role, 'history-only');
  assert.match(memberUpdateUnconfirmedMessage(error), /可能已生效.*核对.*勿直接重复保存/);
});

test('5xx and malformed successful replies require verification, while explicit denials retain their error', async () => {
  for (const response of [
    new Response('{"message":"service unavailable"}', { status: 503 }),
    new Response('<html>gateway interruption</html>', { status: 200 }),
  ]) {
    const error = await failureFrom(async () => response);
    assert.match(memberUpdateUnconfirmedMessage(error), /尚未确认/);
  }
  for (const status of [400, 401, 403, 409, 429]) {
    const error = await failureFrom(async () => new Response('{"message":"explicit rejection"}', { status }));
    assert.equal(memberUpdateUnconfirmedMessage(error), null);
    assert.equal(error.message, 'explicit rejection');
  }
});

test('unconfirmed write diagnostics expose only a bounded request identifier', () => {
  const requestId = '8cffc327-cc7a-4e9f-9e2c-8a04efbdde0b';
  assert.match(memberUpdateUnconfirmedMessage({ status: 408, requestId }), new RegExp(requestId));
  const warning = memberUpdateUnconfirmedMessage({ status: 503, message: 'DO_NOT_DISPLAY_UPSTREAM_BODY', requestId: 'unexpected-secret-like-value' });
  assert.doesNotMatch(warning, /DO_NOT_DISPLAY|unexpected-secret/);
});
