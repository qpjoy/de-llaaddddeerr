import test from 'node:test';
import assert from 'node:assert/strict';
import { renderInternalIngress } from './identity-ingress.mjs';

const entry = {
  origin: 'https://auth.example.test',
  adminOrigin: 'https://launcher.example.test',
  transportOrigin: 'http://10.88.88.88:18444',
  ingressToken: 'test-only-gateway-token'
};

test('only the exact release upload endpoint allows large bodies and extended proxy timeouts', () => {
  const ingress = renderInternalIngress(entry);
  const upload = ingress.match(/    location = \/admin-api\/internal\/v1\/release-artifacts \{\n[\s\S]*?\n    \}/)?.[0];
  assert.ok(upload, 'the upload needs an exact location, not a broad admin API exception');
  assert.match(upload, /client_max_body_size 2g;/);
  assert.match(upload, /proxy_read_timeout 15m;/);
  assert.match(upload, /proxy_send_timeout 15m;/);
  assert.match(upload, /proxy_request_buffering on;/, 'buffer before forwarding to the existing identity listener');
  assert.match(upload, /proxy_pass http:\/\/10\.88\.88\.88:18444;/);
  assert.match(upload, /proxy_set_header Host \$host;/);
  assert.match(upload, /proxy_set_header X-MX-Identity-Gateway "test-only-gateway-token";/);
  assert.match(upload, /proxy_set_header X-MX-Client-IP \$http_x_real_ip;/);
  assert.equal(ingress.split('client_max_body_size 2g;').length - 1, 1);
  assert.ok(ingress.indexOf(upload) > ingress.indexOf('server_name launcher.example.test;'));
  const withoutUpload = ingress.replace(`${upload}\n`, '');
  assert.doesNotMatch(withoutUpload, /15m|2g|proxy_request_buffering/);
});

test('ordinary admin and identity routes retain their limits and gateway trust boundary', () => {
  const ingress = renderInternalIngress(entry);
  assert.equal(ingress.split('client_max_body_size 10m;').length - 1, 2);
  assert.equal(ingress.split('allow 10.88.0.1;\n    deny all;').length - 1, 2);
  for (const path of ['/identity/', '/admin/', '/auth/admin/', '/admin-api/']) {
    const block = ingress.slice(ingress.indexOf(`    location ^~ ${path} {`)).split('\n    }')[0];
    assert.match(block, /proxy_read_timeout 60s;/);
    assert.match(block, /proxy_connect_timeout 5s;/);
    assert.match(block, /proxy_set_header X-Forwarded-Proto https;/);
    assert.match(block, /proxy_set_header X-MX-Identity-Gateway "test-only-gateway-token";/);
    assert.match(block, /proxy_set_header X-MX-Client-IP \$http_x_real_ip;/);
    assert.doesNotMatch(block, /client_max_body_size|proxy_send_timeout|15m|2g/);
  }
  assert.equal(ingress.split('location / { return 404; }').length - 1, 2);
  assert.doesNotMatch(ingress, /location (?:= |\^~ )?\/internal\//, 'the raw Internal API remains private');
});
