import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const renderer = readFileSync(new URL('../renderer.js', import.meta.url), 'utf8');
const start = renderer.indexOf('async function uploadReleaseArtifactFile(');
const end = renderer.indexOf('\nfunction releasePlanBodyFromUpload(', start);
assert.ok(start >= 0 && end > start);

const input = {
  releaseId: 'upload-test', productId: 'mx-h2i', channel: 'stable', artifactKind: 'app-installer',
  version: '3.0.1', componentId: 'mx-h2i', fileName: 'MinCave-3.0.0-mac-universal.dmg',
  storage: 'oss', platform: 'darwin', arch: 'universal', contentType: 'application/octet-stream'
};
const artifact = { artifactId: 'artifact-test', url: '/internal/v1/release-artifacts/artifact-test/download', digest: 'sha256:test', sizeBytes: 1024 };

function fixture(response, personal = false) {
  const requests = [], rejections = [];
  const upload = Function('fetch', 'adminSession', 'requireManagementLogin', 'normalizedServerBase',
    'opsTokenForRequest', 'hasAdminOpsToken', `${renderer.slice(start, end)}\nreturn uploadReleaseArtifactFile;`)(
    async (url, options) => { requests.push({ url, options }); return response; },
    {
      async prepare(url, headers) {
        if (personal) {
          url.pathname = `/admin-api${url.pathname}`;
          delete headers['x-mx-ops-token'];
          headers['x-mx-admin-csrf'] = 'fixture-csrf';
        }
        return personal;
      },
      async rejected(payload) { rejections.push(payload); }
    },
    () => {}, () => 'https://launcher.example', () => 'fixture-token', () => true
  );
  return { upload: () => upload(input, new Blob(['test'])), requests, rejections };
}

test('HTML 413 preserves HTTP status and explains the upload size limit', async () => {
  const f = fixture(new Response('<html><h1>413 Request Entity Too Large</h1></html>', {
    status: 413, headers: { 'content-type': 'text/html' }
  }));
  await assert.rejects(f.upload(), error => {
    assert.equal(error.status, 413);
    assert.match(error.message, /HTTP 413/);
    assert.match(error.message, /text\/html/);
    assert.match(error.message, /大小限制|size limit/);
    assert.doesNotMatch(error.message, /<html>/);
    return true;
  });
  assert.equal(f.requests.length, 1, 'failed uploads are never replayed automatically');
});

test('plain-text and empty gateway errors retain status and useful timeout guidance', async () => {
  for (const [status, body] of [[502, '管理服务暂不可用，请稍后重试。'], [504, ''], [408, '']]) {
    const f = fixture(new Response(body, { status }));
    await assert.rejects(f.upload(), error => {
      assert.equal(error.status, status);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.match(error.message, /超时|timeout/);
      return true;
    });
  }
});

test('JSON rejection keeps server details and personal-session rejection handling', async () => {
  const payload = { message: '请重新登录', code: 'session_required' };
  const f = fixture(Response.json(payload, { status: 401 }), true);
  await assert.rejects(f.upload(), error => {
    assert.equal(error.status, 401);
    assert.equal(error.code, 'session_required');
    assert.match(error.message, /请重新登录/);
    return true;
  });
  assert.deepEqual(f.rejections, [payload]);
});

test('successful HTTP responses must contain artifact metadata before a plan can be created', async () => {
  for (const body of ['', '<html>Login</html>', '{}', 'null', '{"artifact":null}']) {
    const f = fixture(new Response(body, { status: 200, headers: { 'content-type': 'text/html' } }));
    await assert.rejects(f.upload(), /HTTP 200.*artifact|HTTP 200.*JSON/);
  }
});

test('valid uploads preserve the file, product query, ops token and redirect restriction', async () => {
  const f = fixture(Response.json({ artifact }, { status: 201 }));
  assert.deepEqual(await f.upload(), { artifact });
  const { url, options } = f.requests[0];
  assert.equal(new URL(url).pathname, '/internal/v1/release-artifacts');
  assert.equal(new URL(url).searchParams.get('productId'), 'mx-h2i');
  assert.equal(options.headers['x-mx-ops-token'], 'fixture-token');
  assert.equal(options.headers['content-type'], input.contentType);
  assert.equal(options.redirect, 'error');
  assert.equal(await options.body.text(), 'test');
});

test('valid personal-session uploads preserve the admin-api path and CSRF protection', async () => {
  const f = fixture(Response.json({ artifact }), true);
  assert.deepEqual(await f.upload(), { artifact });
  const { url, options } = f.requests[0];
  assert.equal(new URL(url).pathname, '/admin-api/internal/v1/release-artifacts');
  assert.equal(options.headers['x-mx-admin-csrf'], 'fixture-csrf');
  assert.equal(options.headers['x-mx-ops-token'], undefined);
  assert.equal(options.redirect, 'error');
  assert.deepEqual(f.rejections, []);
});
