import test from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { interactionRecovery } from './interaction-recovery.js';
import { identityErrorPage } from './error-page.js';

test('recovery hints are signed, issuer/interaction-bound, expiring and support key rotation', t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const recovery = interactionRecovery(['old'], 'https://auth.test/identity');
  const req = new IncomingMessage(new Socket()), res = new ServerResponse(req);
  res.setHeader('Set-Cookie', 'existing=value');
  recovery.write(res, 'interaction-a', 'hub');
  const cookies = res.getHeader('Set-Cookie') as string[];
  assert.equal(cookies[0], 'existing=value');
  assert.match(cookies[1], /Secure; HttpOnly; SameSite=Lax; Max-Age=1800/);
  req.headers.cookie = cookies[1].split(';')[0];
  assert.equal(recovery.read(req, 'interaction-a'), 'hub');
  assert.equal(recovery.read(req, 'interaction-b'), undefined);
  assert.equal(interactionRecovery(['new', 'old'], 'https://auth.test/identity').read(req, 'interaction-a'), 'hub');
  assert.equal(interactionRecovery(['new'], 'https://auth.test/identity').read(req, 'interaction-a'), undefined);
  assert.equal(interactionRecovery(['old'], 'https://other.test/identity').read(req, 'interaction-a'), undefined);
  const original = req.headers.cookie;
  req.headers.cookie += 'forged';
  assert.equal(recovery.read(req, 'interaction-a'), undefined);
  req.headers.cookie = original; now += 1800001;
  assert.equal(recovery.read(req, 'interaction-a'), undefined);
});

test('error page escapes account text and offers explicit application recovery without automatic navigation', () => {
  const app = { name: 'MX Launcher', url: 'https://launcher.test/admin/', loginUrl: 'https://launcher.test/auth/admin/login?select=1' };
  const page = identityErrorPage({ application: app, applications: [app], account: { name: '<script>bad</script>', login: 'account"' } });
  assert.match(page, /href="https:\/\/launcher.test\/auth\/admin\/login\?select=1"/);
  assert.match(page, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.ok(!page.includes('<script>') && !page.includes('http-equiv="refresh"'));
});
