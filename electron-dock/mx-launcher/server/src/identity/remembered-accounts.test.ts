import test from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { rememberedAccounts } from './remembered-accounts.js';

test('browser account hints are encrypted, issuer-bound, bounded and expire independently', () => {
  const hints = rememberedAccounts(['old-key'], 'https://auth.test/identity');
  const req = new IncomingMessage(new Socket()), res = new ServerResponse(req);
  const now = Date.now() / 1000;
  res.setHeader('Set-Cookie', 'unrelated=value');
  hints.write(res, [{ id: 'expired', seen: now - 2592001 }, { id: 'current', seen: now }, { id: 'future', seen: now + 3600 }]);
  const cookies = res.getHeader('Set-Cookie') as string[];
  assert.equal(cookies[0], 'unrelated=value');
  assert.match(cookies[1], /Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000/);
  assert.ok(!cookies[1].includes('current'));
  req.headers.cookie = cookies[1].split(';')[0];
  assert.deepEqual(hints.read(req), [{ id: 'current', seen: now }]);
  assert.deepEqual(rememberedAccounts(['new-key', 'old-key'], 'https://auth.test/identity').read(req), hints.read(req));
  assert.deepEqual(rememberedAccounts(['new-key'], 'https://auth.test/identity').read(req), []);
  assert.deepEqual(rememberedAccounts(['old-key'], 'https://other.test/identity').read(req), []);
  req.headers.cookie += 'tampered';
  assert.deepEqual(hints.read(req), []);
  hints.write(res, Array.from({ length: 20 }, (_, i) => ({ id: String(i), seen: now })));
  req.headers.cookie = (res.getHeader('Set-Cookie') as string[]).at(-1)!.split(';')[0];
  assert.equal(hints.read(req).length, 8);
  hints.write(res, []);
  assert.match((res.getHeader('Set-Cookie') as string[]).at(-1)!, /Max-Age=0/);
});
